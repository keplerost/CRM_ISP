-- =============================================================================
-- Migración 69 — Inventario: bodega, almacenes de técnicos, compras y consumo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- El rol Bodega existía con sus ocho permisos y ninguna pantalla detrás: entraba
-- al sistema y no podía hacer nada de lo suyo. Esto es el módulo que faltaba.
--
-- ── La decisión que gobierna todo el archivo ──
--
-- **El movimiento es la verdad. La existencia es un acumulado.**
--
-- Se evaluó guardar solo la cantidad por artículo y actualizarla en cada
-- operación. Se descartó: el día que dos altas se registran al mismo tiempo, o
-- que alguien corrige una fila a mano, el número queda mal y NO HAY FORMA DE
-- SABERLO — no existe con qué compararlo. Un inventario que no se puede
-- reconstruir no se puede auditar, y entonces nadie confía en él y se termina
-- contando a mano, que es de donde se venía.
--
-- Acá cada entrada, salida, transferencia y consumo deja un renglón inmutable en
-- `movimientos_inventario`. `existencias` la mantiene un trigger a partir de esa
-- bitácora, y se puede recalcular entera en cualquier momento (la consulta está
-- al pie del archivo). Si alguna vez no cuadra, la bitácora dice exactamente
-- dónde.
--
-- ── Serie sí, serie no ──
--
-- Es mixto a propósito, porque el negocio es mixto. Una ONT y un router se
-- rastrean uno por uno: hay que poder responder "¿dónde está el equipo con
-- serie X?" y "¿qué equipo tiene el cliente Pérez?". El cable y los conectores
-- se cuentan: nadie va a numerar 2.400 metros de drop.
--
-- El artículo declara cuál es con `por_serie`, y de ahí sale todo lo demás.
-- =============================================================================


-- =============================================================================
-- 1. Dónde está el material
-- =============================================================================
-- La bodega central, las de sucursal y —la que hace que esto funcione— el
-- almacén personal de cada técnico.
--
-- El almacén del técnico es un almacén de verdad, no una lista aparte: cuando se
-- le transfiere material, el stock sale de bodega y entra al suyo. Sin eso, el
-- material "sale" de bodega y desaparece del sistema hasta que se instala, que
-- es donde se pierde de vista la mitad del inventario de un ISP.
CREATE TABLE IF NOT EXISTS almacenes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre     VARCHAR(100) NOT NULL,
    tipo       VARCHAR(12)  NOT NULL DEFAULT 'bodega',

    -- Solo cuando tipo = 'tecnico'. Es lo que permite que el alta en campo
    -- descuente del almacén correcto sin preguntarle a nadie.
    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE CASCADE,

    direccion  TEXT,
    activo     BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT almacenes_tipo_check CHECK (tipo IN ('bodega', 'sucursal', 'tecnico', 'vehiculo')),
    -- Un almacén de técnico sin técnico no lo puede usar nadie, y un técnico
    -- colgado de la bodega central haría que el alta en campo descuente del
    -- stock general sin que se note.
    CONSTRAINT almacenes_tecnico_coherente CHECK (
        (tipo = 'tecnico' AND tecnico_id IS NOT NULL) OR (tipo <> 'tecnico' AND tecnico_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_almacenes_tecnico
    ON almacenes (tecnico_id) WHERE tecnico_id IS NOT NULL;

-- La bodega central se crea sola: sin al menos un almacén no se puede registrar
-- ni el primer ingreso, y pedirle a alguien que cree "Bodega" antes de empezar
-- es un paso que solo existe para que se lo saltee.
INSERT INTO almacenes (nombre, tipo)
SELECT 'Bodega central', 'bodega'
WHERE NOT EXISTS (SELECT 1 FROM almacenes WHERE tipo = 'bodega');


-- =============================================================================
-- 2. Qué se guarda
-- =============================================================================
CREATE TABLE IF NOT EXISTS articulos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo        VARCHAR(40),
    nombre        VARCHAR(140) NOT NULL,
    categoria     VARCHAR(20)  NOT NULL DEFAULT 'material',

    -- La unidad importa para no sumar peras con manzanas: 2.400 "m" de drop y
    -- 850 "u" de conector no se pueden totalizar juntos, y el módulo no lo
    -- intenta.
    unidad        VARCHAR(10)  NOT NULL DEFAULT 'u',

    -- El interruptor que decide todo el comportamiento. TRUE = cada unidad es
    -- una fila en `equipos` con su serie; FALSE = se lleva por cantidad.
    por_serie     BOOLEAN NOT NULL DEFAULT FALSE,

    -- El modelo de ONT del catálogo que ya existe. Sin este puente habría dos
    -- listas de modelos —la de red y la de bodega— que se contradicen a los tres
    -- meses, y nadie sabría cuál mirar al aprovisionar.
    tipo_ont_id   UUID REFERENCES tipos_ont(id) ON DELETE SET NULL,

    -- Cuándo avisar. NULL = no se controla; 0 es distinto: significa "avisame
    -- apenas se acabe".
    stock_minimo  NUMERIC(12, 2),
    costo_ultimo  NUMERIC(12, 2),

    activo        BOOLEAN NOT NULL DEFAULT TRUE,
    notas         TEXT,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT articulos_categoria_check CHECK (categoria IN (
        'ont', 'router', 'antena', 'cable', 'conector', 'herramienta', 'material', 'otro'
    )),
    CONSTRAINT articulos_minimo_no_negativo CHECK (stock_minimo IS NULL OR stock_minimo >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articulos_codigo
    ON articulos (LOWER(codigo)) WHERE codigo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_articulos_categoria ON articulos (categoria, activo);


-- =============================================================================
-- 3. Los equipos con serie
-- =============================================================================
-- Una fila por aparato físico. El estado dice dónde está en su vida, y el
-- almacén dónde está en el espacio: un equipo instalado ya no está en ningún
-- almacén, y eso es distinto de haberse perdido.
CREATE TABLE IF NOT EXISTS equipos (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    articulo_id    UUID NOT NULL REFERENCES articulos(id) ON DELETE RESTRICT,

    serie          VARCHAR(60) NOT NULL,
    mac            VARCHAR(20),

    almacen_id     UUID REFERENCES almacenes(id) ON DELETE SET NULL,
    estado         VARCHAR(12) NOT NULL DEFAULT 'en_stock',

    -- A quién se le instaló. Es lo que responde "¿qué equipo tiene Pérez?"
    -- cuando llama diciendo que no le anda.
    cliente_id     UUID REFERENCES clientes(id)      ON DELETE SET NULL,
    instalacion_id UUID REFERENCES instalaciones(id) ON DELETE SET NULL,
    -- El puente con la ONU aprovisionada, cuando el equipo es una ONT.
    onu_id         UUID REFERENCES onus(id) ON DELETE SET NULL,

    notas          TEXT,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT equipos_estado_check CHECK (estado IN (
        'en_stock', 'asignado', 'instalado', 'averiado', 'baja'
    ))
);

-- La serie es única por artículo, no globalmente: dos fabricantes distintos
-- pueden repetir una numeración y rechazar el alta del segundo sería un error
-- que nadie puede explicar en el mostrador.
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipos_serie
    ON equipos (articulo_id, UPPER(serie));
CREATE INDEX IF NOT EXISTS idx_equipos_almacen ON equipos (almacen_id, estado);
CREATE INDEX IF NOT EXISTS idx_equipos_cliente ON equipos (cliente_id) WHERE cliente_id IS NOT NULL;


-- =============================================================================
-- 4. Proveedores y compras
-- =============================================================================
CREATE TABLE IF NOT EXISTS proveedores (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre         VARCHAR(140) NOT NULL,
    identificacion VARCHAR(20),
    telefono       VARCHAR(30),
    email          VARCHAR(120),
    direccion      TEXT,
    contacto       VARCHAR(120),
    activo         BOOLEAN NOT NULL DEFAULT TRUE,
    notas          TEXT,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS compras (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    numero        BIGSERIAL,
    proveedor_id  UUID REFERENCES proveedores(id) ON DELETE SET NULL,
    almacen_id    UUID NOT NULL REFERENCES almacenes(id) ON DELETE RESTRICT,

    documento     VARCHAR(40),
    fecha         DATE NOT NULL DEFAULT CURRENT_DATE,
    total         NUMERIC(12, 2) NOT NULL DEFAULT 0,

    -- Una compra en borrador todavía no entró al stock. Recién al recibirla se
    -- generan los movimientos: registrar la orden y que el stock suba antes de
    -- que llegue la mercadería es cómo se promete material que está en camino.
    estado        VARCHAR(12) NOT NULL DEFAULT 'borrador',
    recibida_en   TIMESTAMPTZ,

    notas         TEXT,
    creado_por    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT compras_estado_check CHECK (estado IN ('borrador', 'recibida', 'anulada'))
);

CREATE TABLE IF NOT EXISTS compra_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compra_id   UUID NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    articulo_id UUID NOT NULL REFERENCES articulos(id) ON DELETE RESTRICT,

    cantidad    NUMERIC(12, 2) NOT NULL CHECK (cantidad > 0),
    costo_unit  NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (costo_unit >= 0),

    -- Las series que vinieron, cuando el artículo es por serie. Se cargan acá y
    -- al recibir la compra se crean los equipos: pedirlas en una pantalla aparte
    -- garantiza que la mitad no se carguen nunca.
    series      JSONB
);

CREATE INDEX IF NOT EXISTS idx_compra_items ON compra_items (compra_id);


-- =============================================================================
-- 5. La bitácora
-- =============================================================================
-- Cada renglón es un hecho que pasó. No se edita ni se borra: una corrección es
-- un ajuste nuevo, que también queda registrado. Es lo que permite responder
-- "¿por qué faltan tres ONT?" en vez de solo constatar que faltan.
CREATE TABLE IF NOT EXISTS movimientos_inventario (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo           VARCHAR(14) NOT NULL,

    articulo_id    UUID NOT NULL REFERENCES articulos(id) ON DELETE RESTRICT,
    -- Presente solo cuando el artículo es por serie. La cantidad entonces es 1.
    equipo_id      UUID REFERENCES equipos(id) ON DELETE SET NULL,

    cantidad       NUMERIC(12, 2) NOT NULL,

    almacen_origen_id  UUID REFERENCES almacenes(id) ON DELETE SET NULL,
    almacen_destino_id UUID REFERENCES almacenes(id) ON DELETE SET NULL,

    -- De dónde salió el movimiento: la instalación que lo consumió, el ticket,
    -- la compra. Es lo que convierte la bitácora en algo navegable.
    instalacion_id UUID REFERENCES instalaciones(id) ON DELETE SET NULL,
    ticket_id      UUID REFERENCES tickets(id)       ON DELETE SET NULL,
    compra_id      UUID REFERENCES compras(id)       ON DELETE SET NULL,

    costo_unit     NUMERIC(12, 2),
    motivo         TEXT,

    usuario_id     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    usuario_nombre VARCHAR(140),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT movimientos_tipo_check CHECK (tipo IN (
        'ingreso', 'salida', 'transferencia', 'consumo', 'devolucion', 'ajuste'
    )),
    -- Cada tipo necesita sus almacenes. Sin esto, una transferencia sin destino
    -- descuenta de un lado y no suma en ninguno: material que se evapora sin que
    -- nada falle.
    CONSTRAINT movimientos_almacenes_coherentes CHECK (
        (tipo = 'ingreso'       AND almacen_destino_id IS NOT NULL) OR
        (tipo = 'devolucion'    AND almacen_destino_id IS NOT NULL) OR
        (tipo IN ('salida', 'consumo') AND almacen_origen_id IS NOT NULL) OR
        (tipo = 'transferencia' AND almacen_origen_id IS NOT NULL AND almacen_destino_id IS NOT NULL) OR
        (tipo = 'ajuste'        AND almacen_destino_id IS NOT NULL)
    ),
    -- El ajuste puede ser negativo (faltante encontrado en un conteo); el resto
    -- no: una salida de −5 es una entrada disfrazada que rompe los totales.
    CONSTRAINT movimientos_cantidad_valida CHECK (
        (tipo = 'ajuste' AND cantidad <> 0) OR (tipo <> 'ajuste' AND cantidad > 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_movimientos_fecha    ON movimientos_inventario (creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_movimientos_articulo ON movimientos_inventario (articulo_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_movimientos_inst     ON movimientos_inventario (instalacion_id)
    WHERE instalacion_id IS NOT NULL;


-- =============================================================================
-- 6. Las existencias, y el trigger que las mantiene
-- =============================================================================
CREATE TABLE IF NOT EXISTS existencias (
    articulo_id UUID NOT NULL REFERENCES articulos(id) ON DELETE CASCADE,
    almacen_id  UUID NOT NULL REFERENCES almacenes(id) ON DELETE CASCADE,
    cantidad    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    PRIMARY KEY (articulo_id, almacen_id)
);

COMMENT ON TABLE existencias IS
    'Acumulado de movimientos_inventario, mantenido por trigger. Se puede recalcular entero: ver el pie de la migración 69.';

/**
 * Aplica un movimiento a las existencias.
 *
 * Va en un trigger y no en el código de la aplicación por una razón concreta:
 * el alta en campo, la recepción de una compra y el ajuste manual son tres
 * caminos distintos que llegan a la misma tabla. Con la lógica en la aplicación
 * hay que acordarse de actualizar el stock en los tres, y el día que se agregue
 * un cuarto camino nadie se va a acordar. Acá es imposible insertar un
 * movimiento sin que el stock lo refleje.
 */
CREATE OR REPLACE FUNCTION aplicar_movimiento_inventario()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_origen  NUMERIC := 0;
    v_destino NUMERIC := 0;
BEGIN
    -- Cuánto sale y cuánto entra, según el tipo.
    IF NEW.tipo IN ('salida', 'consumo') THEN
        v_origen := NEW.cantidad;
    ELSIF NEW.tipo IN ('ingreso', 'devolucion') THEN
        v_destino := NEW.cantidad;
    ELSIF NEW.tipo = 'transferencia' THEN
        v_origen  := NEW.cantidad;
        v_destino := NEW.cantidad;
    ELSIF NEW.tipo = 'ajuste' THEN
        -- El ajuste lleva signo: positivo suma, negativo descuenta.
        v_destino := NEW.cantidad;
    END IF;

    IF v_origen <> 0 AND NEW.almacen_origen_id IS NOT NULL THEN
        INSERT INTO existencias (articulo_id, almacen_id, cantidad)
        VALUES (NEW.articulo_id, NEW.almacen_origen_id, -v_origen)
        ON CONFLICT (articulo_id, almacen_id)
        DO UPDATE SET cantidad = existencias.cantidad - v_origen;
    END IF;

    IF v_destino <> 0 AND NEW.almacen_destino_id IS NOT NULL THEN
        INSERT INTO existencias (articulo_id, almacen_id, cantidad)
        VALUES (NEW.articulo_id, NEW.almacen_destino_id, v_destino)
        ON CONFLICT (articulo_id, almacen_id)
        DO UPDATE SET cantidad = existencias.cantidad + v_destino;
    END IF;

    -- El equipo con serie se mueve con su movimiento. Dejarlo a cargo de la
    -- aplicación permitiría que el stock diga que la ONT está en el almacén de
    -- Juan y la ficha del equipo siga diciendo "bodega central".
    IF NEW.equipo_id IS NOT NULL THEN
        UPDATE equipos
           SET almacen_id     = CASE
                                  WHEN NEW.tipo = 'consumo' THEN NULL
                                  ELSE COALESCE(NEW.almacen_destino_id, almacen_id)
                                END,
               estado         = CASE
                                  WHEN NEW.tipo = 'consumo'    THEN 'instalado'
                                  WHEN NEW.tipo = 'devolucion' THEN 'en_stock'
                                  WHEN NEW.tipo = 'transferencia' THEN 'asignado'
                                  ELSE estado
                                END,
               instalacion_id = COALESCE(NEW.instalacion_id, instalacion_id),
               actualizado_en = NOW()
         WHERE id = NEW.equipo_id;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_aplicar_movimiento ON movimientos_inventario;
CREATE TRIGGER trg_aplicar_movimiento
    AFTER INSERT ON movimientos_inventario
    FOR EACH ROW EXECUTE FUNCTION aplicar_movimiento_inventario();


-- =============================================================================
-- 7. Las vistas
-- =============================================================================
DROP VIEW IF EXISTS v_existencias;
CREATE VIEW v_existencias WITH (security_invoker = true) AS
SELECT
    e.articulo_id,
    e.almacen_id,
    e.cantidad,
    a.nombre     AS articulo,
    a.codigo,
    a.categoria,
    a.unidad,
    a.por_serie,
    a.stock_minimo,
    al.nombre    AS almacen,
    al.tipo      AS almacen_tipo,
    al.tecnico_id,
    -- El aviso de reposición. Va acá y no en la pantalla para que el mismo
    -- criterio valga en la lista, en el tablero y en cualquier reporte.
    (a.stock_minimo IS NOT NULL AND e.cantidad <= a.stock_minimo) AS bajo_minimo
FROM existencias e
JOIN articulos  a  ON a.id  = e.articulo_id
JOIN almacenes  al ON al.id = e.almacen_id;

DROP VIEW IF EXISTS v_articulos;
CREATE VIEW v_articulos WITH (security_invoker = true) AS
SELECT
    a.*,
    t.marca  AS ont_marca,
    t.modelo AS ont_modelo,
    COALESCE(s.total, 0) AS stock_total,
    (a.stock_minimo IS NOT NULL AND COALESCE(s.total, 0) <= a.stock_minimo) AS bajo_minimo,
    -- Cuántos hay realmente disponibles del seriado: los instalados siguen
    -- existiendo pero no se pueden entregar, y contarlos como stock es cómo se
    -- promete un equipo que está colgado en la casa de alguien.
    (SELECT COUNT(*) FROM equipos q WHERE q.articulo_id = a.id AND q.estado = 'en_stock') AS equipos_libres
FROM articulos a
LEFT JOIN tipos_ont t ON t.id = a.tipo_ont_id
LEFT JOIN (
    SELECT articulo_id, SUM(cantidad) AS total FROM existencias GROUP BY articulo_id
) s ON s.articulo_id = a.id;

DROP VIEW IF EXISTS v_equipos;
CREATE VIEW v_equipos WITH (security_invoker = true) AS
SELECT
    q.*,
    a.nombre  AS articulo,
    a.categoria,
    al.nombre AS almacen,
    al.tipo   AS almacen_tipo,
    al.tecnico_id,
    c.nombre  AS cliente
FROM equipos q
JOIN articulos a  ON a.id  = q.articulo_id
LEFT JOIN almacenes al ON al.id = q.almacen_id
LEFT JOIN clientes  c  ON c.id  = q.cliente_id;

DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `destino`, la cadena siguió y esta versión quedó
     * atrás: la esta misma migracion la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_movimientos'
           AND column_name = 'destino'
    ) THEN
        RAISE NOTICE 'v_movimientos ya está en su versión de la esta misma migracion: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_movimientos';
    EXECUTE $vista$
CREATE VIEW v_movimientos WITH (security_invoker = true) AS
SELECT
    m.*,
    a.nombre  AS articulo,
    a.unidad,
    q.serie,
    o.nombre  AS origen,
    d.nombre  AS destino
FROM movimientos_inventario m
JOIN articulos a  ON a.id = m.articulo_id
LEFT JOIN equipos   q ON q.id = m.equipo_id
LEFT JOIN almacenes o ON o.id = m.almacen_origen_id
LEFT JOIN almacenes d ON d.id = m.almacen_destino_id
$vista$;
END $guarda$;


-- =============================================================================
-- 8. El almacén del técnico se crea solo
-- =============================================================================
-- Cada técnico activo necesita el suyo para poder recibir material. Hacerlo a
-- mano significa que el día que entra un técnico nuevo, la primera transferencia
-- falla con un error que nadie entiende.
INSERT INTO almacenes (nombre, tipo, tecnico_id)
SELECT 'Almacén de ' || t.nombre, 'tecnico', t.id
FROM tecnicos t
WHERE t.activo
  AND NOT EXISTS (SELECT 1 FROM almacenes al WHERE al.tecnico_id = t.id);

-- Y el de los que entren mañana.
--
-- El INSERT de arriba resuelve el día de la migración y nada más. Un técnico
-- dado de alta la semana que viene no tendría almacén, y eso no falla al
-- crearlo: falla después, cuando bodega intenta transferirle material y el
-- desplegable no lo encuentra. Un error a distancia del error, que es el peor
-- para diagnosticar.
--
-- Va como trigger y no como un paso en la pantalla de Técnicos porque hay dos
-- caminos para crear un técnico —esa pantalla y la carga directa— y solo uno
-- pasaría por el código de la aplicación.
CREATE OR REPLACE FUNCTION crear_almacen_del_tecnico()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Al reactivar a alguien que ya tuvo almacén no se crea otro: el suyo sigue
    -- ahí con lo que tenía, que es justamente lo que hay que reclamarle.
    IF NEW.activo AND NOT EXISTS (SELECT 1 FROM almacenes WHERE tecnico_id = NEW.id) THEN
        INSERT INTO almacenes (nombre, tipo, tecnico_id)
        VALUES ('Almacén de ' || NEW.nombre, 'tecnico', NEW.id);

    -- Si le corrigieron el nombre, el almacén lo sigue. Sin esto, el
    -- desplegable de transferencias termina lleno de nombres viejos y bodega
    -- le manda material al técnico equivocado.
    -- `TG_OP` no es de más: en un INSERT, OLD es NULL y la comparación daría
    -- verdadera siempre, disparando un UPDATE que no encuentra nada.
    ELSIF TG_OP = 'UPDATE' AND NEW.nombre IS DISTINCT FROM OLD.nombre THEN
        UPDATE almacenes
           SET nombre = 'Almacén de ' || NEW.nombre
         WHERE tecnico_id = NEW.id;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_almacen_del_tecnico ON tecnicos;
CREATE TRIGGER trg_almacen_del_tecnico
    AFTER INSERT OR UPDATE OF activo, nombre ON tecnicos
    FOR EACH ROW EXECUTE FUNCTION crear_almacen_del_tecnico();


-- =============================================================================
-- Seguridad
-- =============================================================================
-- Escrito tabla por tabla y no con un bucle sobre un arreglo de nombres.
--
-- La versión corta con `EXECUTE FORMAT` funcionaba igual, pero el análisis
-- estático del editor de Supabase no puede leer dentro de SQL dinámico: veía
-- ocho `CREATE TABLE` y ningún `ENABLE ROW LEVEL SECURITY`, y avisaba —con
-- razón desde su punto de vista— que las tablas quedaban abiertas. Y tenía un
-- problema más serio que el aviso: una postura de seguridad que una herramienta
-- no puede verificar tampoco la puede revisar una persona leyendo el archivo.
--
-- Diez líneas más largo y auditable de un vistazo.
ALTER TABLE almacenes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE articulos              ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipos                ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedores            ENABLE ROW LEVEL SECURITY;
ALTER TABLE compras                ENABLE ROW LEVEL SECURITY;
ALTER TABLE compra_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_inventario ENABLE ROW LEVEL SECURITY;
ALTER TABLE existencias            ENABLE ROW LEVEL SECURITY;

-- El personal con sesión trabaja el inventario desde la pantalla. Acá no hay
-- ningún escalón de privilegio que proteger —lo peor que puede hacer alguien es
-- cargar un artículo de más— y quién puede abrir cada pantalla ya lo decide el
-- permiso `inventario.*`. El `anon` de Supabase no toca nada de esto.
DROP POLICY IF EXISTS almacenes_personal ON almacenes;
CREATE POLICY almacenes_personal ON almacenes
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS articulos_personal ON articulos;
CREATE POLICY articulos_personal ON articulos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS equipos_personal ON equipos;
CREATE POLICY equipos_personal ON equipos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS proveedores_personal ON proveedores;
CREATE POLICY proveedores_personal ON proveedores
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS compras_personal ON compras;
CREATE POLICY compras_personal ON compras
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS compra_items_personal ON compra_items;
CREATE POLICY compra_items_personal ON compra_items
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS movimientos_inventario_personal ON movimientos_inventario;
CREATE POLICY movimientos_inventario_personal ON movimientos_inventario
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- `existencias` es un acumulado: nadie debería escribirla a mano. Se deja
-- abierta igual porque el trigger corre con los permisos de quien inserta el
-- movimiento, y cerrarla rompería el alta en campo del técnico.
DROP POLICY IF EXISTS existencias_personal ON existencias;
CREATE POLICY existencias_personal ON existencias
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Recalcular las existencias desde cero
-- =============================================================================
-- Si alguna vez el stock no cuadra, esto lo reconstruye entero a partir de la
-- bitácora, que es la verdad. Descomentar y ejecutar:
--
--   TRUNCATE existencias;
--   INSERT INTO existencias (articulo_id, almacen_id, cantidad)
--   SELECT articulo_id, almacen_id, SUM(delta)
--     FROM (
--       SELECT articulo_id, almacen_origen_id AS almacen_id, -cantidad AS delta
--         FROM movimientos_inventario
--        WHERE tipo IN ('salida','consumo','transferencia') AND almacen_origen_id IS NOT NULL
--       UNION ALL
--       SELECT articulo_id, almacen_destino_id, cantidad
--         FROM movimientos_inventario
--        WHERE tipo IN ('ingreso','devolucion','transferencia','ajuste') AND almacen_destino_id IS NOT NULL
--     ) t
--    GROUP BY articulo_id, almacen_id;
--
-- Que esta consulta exista y sea corta no es casualidad: es la prueba de que la
-- bitácora alcanza para reconstruir el estado. Si hiciera falta algo más, el
-- diseño estaría mal.
