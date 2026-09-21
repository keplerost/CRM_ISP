-- =============================================================================
-- Migración 111 — El equipo recuperado va al técnico, y vuelve con un acta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El problema ──
--
-- Cuando el técnico recuperaba un equipo, `cerrar_retiro_equipo` lo mandaba
-- directo al almacén que le pasaran —en la práctica, la bodega central—. Pero
-- el equipo no está en la bodega: está en la camioneta del técnico, y puede
-- quedarse ahí tres días.
--
-- Ese hueco tiene consecuencias reales: el inventario dice que hay una ONT en
-- bodega, alguien la promete para una instalación, y el día de la instalación
-- no está. Y del otro lado, si el equipo se pierde entre la casa del abonado y
-- la oficina, no hay ningún registro de en manos de quién estaba.
--
-- ── Cómo queda ──
--
--   1. El equipo recuperado entra al almacén DEL TÉCNICO. Es donde está.
--   2. Cuando lo lleva a la oficina arma un ACTA con lo que entrega.
--   3. Quien recibe la revisa y FIRMA en la pantalla.
--   4. Recién ahí el equipo pasa al almacén general y sale del técnico.
--
-- El paso 3 no es burocracia: es el momento en que la responsabilidad cambia de
-- manos, y es exactamente el que hoy no existía. Sin la firma, "yo lo entregué"
-- y "a mí no me llegó" no se pueden distinguir.
-- =============================================================================


-- =============================================================================
-- 1. Datos que la pantalla de campo necesita
-- =============================================================================
-- El técnico tiene que poder escribirle al abonado y llegar a la casa: hacen
-- falta el chat de Telegram y las coordenadas, que estaban en `clientes` y no
-- llegaban a la vista.
DROP VIEW IF EXISTS v_retiros_equipo;
CREATE VIEW v_retiros_equipo AS
SELECT
    re.id,
    re.cliente_id,
    re.vendedor_id,
    re.equipo_id,
    re.onu_id,
    re.serie,
    re.modelo,
    re.valor,
    re.fecha_instalacion,
    re.ultimo_pago,
    re.suspendido_en,
    re.meses_sin_pago,
    re.tecnico_id,
    re.responsable_id,
    re.intentos,
    re.estado,
    re.motivo,
    re.observaciones,
    re.evidencia_url,
    re.agendado_para,
    re.agenda_nota,
    re.recordado_en,
    re.creado_por,
    re.creado_en,
    re.asignado_en,
    re.cerrado_por,
    re.cerrado_en,
    c.nombre  AS cliente,
    COALESCE(c.telefono_movil, c.telefono) AS telefono,
    t.nombre  AS tecnico,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    (CURRENT_DATE - re.creado_en::DATE)::INT AS dias_abierta,
    (SELECT MAX(i.creado_en) FROM retiro_intentos i WHERE i.retiro_id = re.id) AS ultimo_intento,
    TRIM(CONCAT(ur.nombre, ' ', COALESCE(ur.apellido, ''))) AS responsable,
    c.direccion,
    c.zona,
    c.telegram_chat_id,
    c.latitud,
    c.longitud
FROM retiros_equipo re
LEFT JOIN clientes c          ON c.id = re.cliente_id
LEFT JOIN tecnicos t          ON t.id = re.tecnico_id
LEFT JOIN usuarios_sistema u  ON u.id = re.vendedor_id
LEFT JOIN usuarios_sistema ur ON ur.id = re.responsable_id
WHERE puede_gestionar_retiros()
   OR re.tecnico_id = mi_tecnico_id()
   OR re.responsable_id = mi_legajo_id()
   OR re.vendedor_id = mi_legajo_id();

GRANT SELECT ON v_retiros_equipo TO authenticated;


-- =============================================================================
-- 2. El acta de entrega
-- =============================================================================
CREATE TABLE IF NOT EXISTS entregas_inventario (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- El número con el que se habla del acta. Correlativo y propio, como el de
    -- las órdenes: "el acta 14" tiene que significar algo por teléfono.
    numero      INT,

    -- Quién entrega y desde qué almacén sale el material.
    entrega_id  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    almacen_origen UUID REFERENCES almacenes(id) ON DELETE SET NULL,

    -- Quién recibe y a dónde entra. Vacíos hasta que alguien firme.
    recibe_id   UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    almacen_destino UUID REFERENCES almacenes(id) ON DELETE SET NULL,

    estado      VARCHAR(12) NOT NULL DEFAULT 'pendiente'
                CHECK (estado IN ('pendiente', 'recibida', 'anulada')),

    /*
     * La firma de quien recibe, como imagen.
     *
     * Es el mismo mecanismo que la conformidad del abonado en el alta: un trazo
     * en la pantalla, guardado en base64. No es una firma electrónica
     * certificada y no pretende serlo — es la prueba de que una persona
     * concreta, identificada por su sesión, aceptó recibir estos equipos en
     * esta fecha. Para una entrega interna eso es lo que hace falta.
     */
    firma_b64   TEXT,
    firmado_en  TIMESTAMPTZ,

    notas       TEXT,
    motivo_anulacion TEXT,

    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS entregas_numero_seq;
SELECT setval('entregas_numero_seq', COALESCE((SELECT MAX(numero) FROM entregas_inventario), 0) + 1, false);
ALTER TABLE entregas_inventario ALTER COLUMN numero SET DEFAULT nextval('entregas_numero_seq');

CREATE UNIQUE INDEX IF NOT EXISTS idx_entregas_numero ON entregas_inventario (numero);
CREATE INDEX IF NOT EXISTS idx_entregas_pendientes ON entregas_inventario (estado, creado_en DESC);

COMMENT ON TABLE entregas_inventario IS
    'El acta con la que un técnico devuelve equipos a la oficina. Mientras está pendiente, el material sigue siendo suyo; al firmarse, pasa al almacén general.';


CREATE TABLE IF NOT EXISTS entrega_items (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entrega_id UUID NOT NULL REFERENCES entregas_inventario(id) ON DELETE CASCADE,

    equipo_id  UUID REFERENCES equipos(id) ON DELETE SET NULL,
    -- Se copian serie y modelo: el acta tiene que poder leerse dentro de un año
    -- aunque el equipo se haya dado de baja y borrado del inventario.
    serie      VARCHAR(100),
    modelo     VARCHAR(150),
    -- De qué retiro viene, cuando viene de uno. Es lo que cierra el círculo:
    -- del abonado que no pagó hasta el estante de la bodega.
    retiro_id  UUID REFERENCES retiros_equipo(id) ON DELETE SET NULL,

    estado_fisico VARCHAR(12) NOT NULL DEFAULT 'bueno'
                  CHECK (estado_fisico IN ('bueno', 'dañado', 'incompleto')),
    observacion TEXT,

    CONSTRAINT entrega_items_unico UNIQUE (entrega_id, equipo_id)
);

CREATE INDEX IF NOT EXISTS idx_entrega_items ON entrega_items (entrega_id);

ALTER TABLE entregas_inventario ENABLE ROW LEVEL SECURITY;
ALTER TABLE entrega_items       ENABLE ROW LEVEL SECURITY;

-- Leer: quien entrega ve las suyas; quien recibe material las ve todas.
DROP POLICY IF EXISTS entregas_lectura ON entregas_inventario;
CREATE POLICY entregas_lectura ON entregas_inventario
    FOR SELECT TO authenticated
    USING (puede_gestionar_retiros() OR entrega_id = mi_legajo_id() OR recibe_id = mi_legajo_id());

DROP POLICY IF EXISTS entrega_items_lectura ON entrega_items;
CREATE POLICY entrega_items_lectura ON entrega_items
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM entregas_inventario e
         WHERE e.id = entrega_items.entrega_id
           AND (puede_gestionar_retiros() OR e.entrega_id = mi_legajo_id() OR e.recibe_id = mi_legajo_id())
    ));

-- Escribir directo: nadie. Todo pasa por las funciones, que son las que mueven
-- el inventario. Un acta firmada a mano no movería nada y quedaría mintiendo.
DROP POLICY IF EXISTS entregas_escritura ON entregas_inventario;
CREATE POLICY entregas_escritura ON entregas_inventario
    FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS entrega_items_escritura ON entrega_items;
CREATE POLICY entrega_items_escritura ON entrega_items
    FOR ALL TO authenticated USING (false) WITH CHECK (false);


-- =============================================================================
-- 3. El equipo recuperado entra al almacén del técnico
-- =============================================================================
/**
 * Igual que en la 101, con un solo cambio: a dónde va el equipo.
 *
 * Antes, sin `p_almacen`, caía en la primera bodega que encontraba. Ahora el
 * orden es: el almacén que digan, si no el del técnico que cerró la orden, y
 * recién si no hay ninguno, la bodega. El equipo se anota donde está de verdad.
 */
CREATE OR REPLACE FUNCTION cerrar_retiro_equipo(
    p_retiro      UUID,
    p_recuperado  BOOLEAN,
    p_motivo      TEXT DEFAULT NULL,
    p_observacion TEXT DEFAULT NULL,
    p_serie       TEXT DEFAULT NULL,
    p_almacen     UUID DEFAULT NULL
)
RETURNS retiros_equipo
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fila    retiros_equipo%ROWTYPE;
    v_equipo  equipos%ROWTYPE;
    v_almacen UUID;
    v_legajo  UUID := mi_legajo_id();
BEGIN
    SELECT * INTO v_fila FROM retiros_equipo WHERE id = p_retiro;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa orden de retiro';
    END IF;

    IF NOT puede_gestionar_retiros()
       AND v_fila.tecnico_id IS DISTINCT FROM mi_tecnico_id()
       AND v_fila.responsable_id IS DISTINCT FROM v_legajo THEN
        RAISE EXCEPTION 'Esa orden de retiro no es tuya';
    END IF;

    IF v_fila.estado NOT IN ('pendiente', 'asignado') THEN
        RAISE EXCEPTION 'Esa orden ya está cerrada (%)', v_fila.estado;
    END IF;

    IF NOT p_recuperado AND COALESCE(BTRIM(p_motivo), '') = '' THEN
        RAISE EXCEPTION 'Hace falta el motivo: un equipo dado por perdido sin explicación no se puede analizar después';
    END IF;

    IF COALESCE(BTRIM(p_serie), '') <> '' THEN
        SELECT * INTO v_equipo FROM equipos
         WHERE UPPER(BTRIM(serie)) = UPPER(BTRIM(p_serie)) LIMIT 1;
    ELSIF v_fila.equipo_id IS NOT NULL THEN
        SELECT * INTO v_equipo FROM equipos WHERE id = v_fila.equipo_id;
    END IF;

    IF p_recuperado AND v_equipo.id IS NOT NULL THEN
        -- ── El cambio de esta migración ──
        -- El equipo entra al almacén de quien lo tiene en la mano.
        v_almacen := COALESCE(
            p_almacen,
            (SELECT a.id FROM almacenes a WHERE a.tecnico_id = v_fila.tecnico_id LIMIT 1),
            (SELECT a.id FROM almacenes a WHERE a.tipo = 'bodega' ORDER BY a.creado_en LIMIT 1)
        );

        UPDATE equipos
           SET estado = 'en_stock',
               cliente_id = NULL,
               instalacion_id = NULL,
               almacen_id = v_almacen
         WHERE id = v_equipo.id;

        INSERT INTO movimientos_inventario (
            tipo, articulo_id, equipo_id, cantidad, almacen_destino_id,
            costo_unit, motivo, usuario_id, usuario_nombre
        )
        SELECT 'devolucion', v_equipo.articulo_id, v_equipo.id, 1, v_almacen,
               NULLIF(v_fila.valor, 0),
               FORMAT('Retiro de equipo por falta de renovación (orden %s)', p_retiro),
               v_legajo,
               (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                  FROM usuarios_sistema u WHERE u.id = v_legajo);
    ELSIF NOT p_recuperado AND v_equipo.id IS NOT NULL THEN
        UPDATE equipos
           SET estado = 'baja', cliente_id = NULL, instalacion_id = NULL, almacen_id = NULL
         WHERE id = v_equipo.id;
    END IF;

    UPDATE retiros_equipo
       SET estado = CASE WHEN p_recuperado THEN 'recuperado' ELSE 'no_recuperado' END,
           motivo = COALESCE(NULLIF(BTRIM(p_motivo), ''), motivo),
           observaciones = COALESCE(NULLIF(BTRIM(p_observacion), ''), observaciones),
           cerrado_por = v_legajo,
           cerrado_en = NOW()
     WHERE id = p_retiro
    RETURNING * INTO v_fila;

    RETURN v_fila;
END $$;


-- =============================================================================
-- 4. Armar el acta, firmarla y mover el inventario
-- =============================================================================
/**
 * Crea el acta con los equipos que el técnico lleva a la oficina.
 *
 * Solo entran equipos que estén EN SU ALMACÉN. Es la comprobación que evita el
 * acta imaginaria: no se puede entregar lo que no se tiene, y sin este control
 * el sistema aceptaría una entrega de un equipo que está instalado en la casa
 * de otro abonado.
 */
/**
 * ── Este bloque se saltea si ya corrió la 120 ──
 *
 * La 120 le agregó la firma de quien entrega y borró esta versión de dos
 * parámetros. Volver a crearla acá NO la reemplaza: Postgres las trata como dos
 * funciones distintas, y desde ese momento cualquier llamada falla con
 * «function crear_entrega_inventario(...) is not unique». La pantalla del
 * técnico deja de poder armar un acta.
 *
 * Es la misma trampa que la 101 tenía con `cerrar_retiro_equipo`. La pregunta
 * es por el CONTENIDO: si la tabla ya tiene la columna de la firma de entrega,
 * la versión nueva está en la base.
 */
DO $guarda_entrega$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'entregas_inventario'
           AND column_name = 'firma_entrega_b64'
    ) THEN
        RAISE NOTICE 'crear_entrega_inventario ya está en su versión de la 120: no se toca.';
        RETURN;
    END IF;

    EXECUTE $cuerpo_entrega$
CREATE OR REPLACE FUNCTION crear_entrega_inventario(
    p_equipos UUID[],
    p_notas   TEXT DEFAULT NULL
)
RETURNS entregas_inventario
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fe$
DECLARE
    v_legajo  UUID := mi_legajo_id();
    v_tecnico UUID := mi_tecnico_id();
    v_almacen UUID;
    v_acta    entregas_inventario%ROWTYPE;
    v_eq      RECORD;
    v_n       INT := 0;
BEGIN
    IF v_legajo IS NULL THEN
        RAISE EXCEPTION 'No se sabe quién está entregando';
    END IF;

    SELECT id INTO v_almacen FROM almacenes WHERE tecnico_id = v_tecnico LIMIT 1;
    IF v_almacen IS NULL THEN
        RAISE EXCEPTION 'No tenés un almacén propio: no hay desde dónde entregar';
    END IF;

    INSERT INTO entregas_inventario (entrega_id, almacen_origen, notas)
    VALUES (v_legajo, v_almacen, NULLIF(BTRIM(p_notas), ''))
    RETURNING * INTO v_acta;

    FOR v_eq IN
        SELECT e.id, e.serie, a.nombre AS modelo,
               (SELECT r.id FROM retiros_equipo r
                 WHERE r.equipo_id = e.id AND r.estado = 'recuperado'
                 ORDER BY r.cerrado_en DESC LIMIT 1) AS retiro_id
          FROM equipos e
          LEFT JOIN articulos a ON a.id = e.articulo_id
         WHERE e.id = ANY(COALESCE(p_equipos, '{}'))
           AND e.almacen_id = v_almacen
           AND e.estado = 'en_stock'
    LOOP
        INSERT INTO entrega_items (entrega_id, equipo_id, serie, modelo, retiro_id)
        VALUES (v_acta.id, v_eq.id, v_eq.serie, v_eq.modelo, v_eq.retiro_id);
        v_n := v_n + 1;
    END LOOP;

    IF v_n = 0 THEN
        -- Se borra en vez de dejar un acta vacía: un acta sin equipos es papel
        -- que después alguien tiene que interpretar.
        DELETE FROM entregas_inventario WHERE id = v_acta.id;
        RAISE EXCEPTION 'Ninguno de esos equipos está en tu almacén';
    END IF;

    RETURN v_acta;
END $fe$;
$cuerpo_entrega$;
END $guarda_entrega$;



/**
 * Quien recibe firma, y ahí el material cambia de manos.
 *
 * ── Por qué el movimiento de inventario se hace acá y no al crear el acta ──
 *
 * Porque hasta que alguien firma, el equipo sigue en la camioneta. Moverlo al
 * armar el acta haría que el inventario general contara equipos que todavía
 * están en la calle, que es exactamente el problema que esta migración vino a
 * resolver.
 *
 * ── Por qué no puede firmar quien entrega ──
 *
 * Porque entonces no prueba nada. Toda la utilidad del acta está en que hay dos
 * personas distintas.
 */
CREATE OR REPLACE FUNCTION recibir_entrega_inventario(
    p_entrega  UUID,
    p_firma    TEXT,
    p_almacen  UUID DEFAULT NULL,
    p_notas    TEXT DEFAULT NULL
)
RETURNS entregas_inventario
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_acta    entregas_inventario%ROWTYPE;
    v_legajo  UUID := mi_legajo_id();
    v_destino UUID;
    v_item    RECORD;
BEGIN
    SELECT * INTO v_acta FROM entregas_inventario WHERE id = p_entrega;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa acta';
    END IF;

    IF v_acta.estado <> 'pendiente' THEN
        RAISE EXCEPTION 'Esa acta ya está %', v_acta.estado;
    END IF;

    IF NOT puede_gestionar_retiros() THEN
        RAISE EXCEPTION 'No tenés permiso para recibir material';
    END IF;

    IF v_legajo IS NOT NULL AND v_legajo = v_acta.entrega_id THEN
        RAISE EXCEPTION 'No podés recibir tu propia entrega: la firma tiene que ser de quien recibe';
    END IF;

    IF COALESCE(BTRIM(p_firma), '') = '' THEN
        RAISE EXCEPTION 'Falta la firma de quien recibe';
    END IF;

    v_destino := COALESCE(
        p_almacen,
        (SELECT a.id FROM almacenes a WHERE a.tipo = 'bodega' ORDER BY a.creado_en LIMIT 1)
    );

    IF v_destino IS NULL THEN
        RAISE EXCEPTION 'No hay un almacén general a dónde recibir';
    END IF;

    FOR v_item IN
        SELECT i.equipo_id, e.articulo_id
          FROM entrega_items i
          JOIN equipos e ON e.id = i.equipo_id
         WHERE i.entrega_id = p_entrega
    LOOP
        UPDATE equipos SET almacen_id = v_destino WHERE id = v_item.equipo_id;

        INSERT INTO movimientos_inventario (
            tipo, articulo_id, equipo_id, cantidad,
            almacen_origen_id, almacen_destino_id, motivo, usuario_id, usuario_nombre
        )
        SELECT 'transferencia', v_item.articulo_id, v_item.equipo_id, 1,
               v_acta.almacen_origen, v_destino,
               FORMAT('Entrega de equipos recuperados (acta %s)', v_acta.numero),
               v_legajo,
               (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                  FROM usuarios_sistema u WHERE u.id = v_legajo);
    END LOOP;

    UPDATE entregas_inventario
       SET estado = 'recibida',
           recibe_id = v_legajo,
           almacen_destino = v_destino,
           firma_b64 = p_firma,
           firmado_en = NOW(),
           notas = COALESCE(NULLIF(BTRIM(p_notas), ''), notas)
     WHERE id = p_entrega
    RETURNING * INTO v_acta;

    RETURN v_acta;
END $$;


-- =============================================================================
-- 5. Las vistas de la pantalla
-- =============================================================================
DROP VIEW IF EXISTS v_entregas_inventario;
CREATE VIEW v_entregas_inventario AS
SELECT
    e.id,
    e.numero,
    e.estado,
    e.creado_en,
    e.firmado_en,
    e.notas,
    e.firma_b64 IS NOT NULL AS firmada,
    TRIM(CONCAT(ue.nombre, ' ', COALESCE(ue.apellido, ''))) AS entrega,
    TRIM(CONCAT(ur.nombre, ' ', COALESCE(ur.apellido, ''))) AS recibe,
    ao.nombre AS almacen_origen,
    ad.nombre AS almacen_destino,
    (SELECT COUNT(*) FROM entrega_items i WHERE i.entrega_id = e.id)::INT AS equipos
FROM entregas_inventario e
LEFT JOIN usuarios_sistema ue ON ue.id = e.entrega_id
LEFT JOIN usuarios_sistema ur ON ur.id = e.recibe_id
LEFT JOIN almacenes ao ON ao.id = e.almacen_origen
LEFT JOIN almacenes ad ON ad.id = e.almacen_destino
WHERE puede_gestionar_retiros() OR e.entrega_id = mi_legajo_id() OR e.recibe_id = mi_legajo_id();

GRANT SELECT ON v_entregas_inventario TO authenticated;


/** Lo que hay en el almacén de quien pregunta, listo para entregar. */
DROP VIEW IF EXISTS v_mi_almacen_equipos;
CREATE VIEW v_mi_almacen_equipos AS
SELECT
    e.id,
    e.serie,
    e.estado,
    e.almacen_id,
    a.nombre  AS articulo,
    a.categoria,
    -- De qué retiro vino, si vino de uno.
    (SELECT r.cerrado_en FROM retiros_equipo r
      WHERE r.equipo_id = e.id AND r.estado = 'recuperado'
      ORDER BY r.cerrado_en DESC LIMIT 1) AS recuperado_en,
    (SELECT c.nombre FROM retiros_equipo r
       JOIN clientes c ON c.id = r.cliente_id
      WHERE r.equipo_id = e.id AND r.estado = 'recuperado'
      ORDER BY r.cerrado_en DESC LIMIT 1) AS recuperado_de,
    -- Si ya está en un acta pendiente, no se puede volver a entregar.
    EXISTS (
        SELECT 1 FROM entrega_items i
          JOIN entregas_inventario en ON en.id = i.entrega_id
         WHERE i.equipo_id = e.id AND en.estado = 'pendiente'
    ) AS en_acta
FROM equipos e
LEFT JOIN articulos a  ON a.id = e.articulo_id
JOIN almacenes al      ON al.id = e.almacen_id
WHERE e.estado = 'en_stock'
  AND al.tecnico_id IS NOT NULL
  AND (puede_gestionar_retiros() OR al.tecnico_id = mi_tecnico_id());

GRANT SELECT ON v_mi_almacen_equipos TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Lo que tiene el técnico en su almacén:
--   SELECT serie, articulo, recuperado_de, en_acta FROM v_mi_almacen_equipos;
--
--   -- Armar el acta y firmarla (con otro usuario):
--   SELECT numero FROM crear_entrega_inventario(ARRAY['<equipo>']::UUID[], 'Dos ONT recuperadas');
--   SELECT estado FROM recibir_entrega_inventario('<acta>', 'data:image/png;base64,...');
--
--   -- Y que el equipo se haya movido:
--   SELECT e.serie, a.nombre AS almacen FROM equipos e JOIN almacenes a ON a.id = e.almacen_id;
