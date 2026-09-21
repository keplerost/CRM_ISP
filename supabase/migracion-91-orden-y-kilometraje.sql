-- =============================================================================
-- Migración 91 — Número de orden y kilometraje
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Dos cosas que se pidieron juntas y no tienen nada que ver entre sí, salvo que
-- las dos son datos que hoy no existen y sin los cuales no se puede medir nada.
-- =============================================================================


-- =============================================================================
-- 1. El número de orden
-- =============================================================================
-- ── Por qué una secuencia y no el UUID ──
--
-- El id de una instalación es `a3f1c8e2-…`. Nadie lo dice por teléfono, nadie
-- lo escribe en un contrato, y nadie lo reconoce en una lista. Un número corto
-- y creciente es lo que permite que la orden exista como objeto en las
-- conversaciones: "la 2541 quedó pendiente".
--
-- Se pidió expresamente que ese número siga al abonado cuando la instalación se
-- convierte en cliente, y que se asocie al contrato. Por eso no se guarda en la
-- pantalla: se guarda en la fila, y el contrato y la ficha lo leen de ahí.

CREATE SEQUENCE IF NOT EXISTS instalaciones_numero_seq START 1000;

ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS numero INT;

-- Las que ya existen reciben su número por orden de creación: si se asignaran
-- al azar, la 2541 podría ser anterior a la 2540 y el número dejaría de decir
-- "cuál vino antes", que es la mitad de para qué sirve.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT id FROM instalaciones WHERE numero IS NULL ORDER BY created_at, id
    LOOP
        UPDATE instalaciones SET numero = nextval('instalaciones_numero_seq') WHERE id = r.id;
    END LOOP;
END $$;

ALTER TABLE instalaciones
    ALTER COLUMN numero SET DEFAULT nextval('instalaciones_numero_seq');

-- Único, y sin excepciones: dos órdenes con el mismo número convierten en
-- ambigua justamente la referencia que se quería tener.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instalaciones_numero
    ON instalaciones (numero) WHERE numero IS NOT NULL;

ALTER TABLE instalaciones ALTER COLUMN numero SET NOT NULL;

COMMENT ON COLUMN instalaciones.numero IS
    'El número con el que se habla de esta orden. Sigue al abonado cuando la instalación se cierra y se asocia al contrato.';


-- ── Que el abonado lo lleve consigo ──
--
-- Se guarda en `clientes` en vez de resolverlo con un JOIN cada vez. El motivo
-- es que la instalación puede borrarse o rehacerse, y el número que quedó
-- escrito en un contrato de papel tiene que seguir existiendo aunque la orden
-- que lo generó ya no esté.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS numero_orden INT;

COMMENT ON COLUMN clientes.numero_orden IS
    'El número de la orden que dio de alta a este abonado. Se copia, no se consulta: el contrato de papel lo lleva impreso y tiene que sobrevivir a que la orden se borre.';

UPDATE clientes c
   SET numero_orden = i.numero
  FROM instalaciones i
 WHERE i.client_id = c.id AND c.numero_orden IS NULL;

-- Y que se copie solo al cerrar el alta.
CREATE OR REPLACE FUNCTION copiar_numero_orden()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.client_id IS NOT NULL AND NEW.numero IS NOT NULL THEN
        UPDATE clientes
           SET numero_orden = COALESCE(numero_orden, NEW.numero)
         WHERE id = NEW.client_id;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_copiar_numero_orden ON instalaciones;
CREATE TRIGGER trg_copiar_numero_orden
    AFTER UPDATE OF client_id ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION copiar_numero_orden();


-- =============================================================================
-- 2. Kilometraje y combustible
-- =============================================================================
-- ── Por qué el odómetro y no el GPS ──
--
-- Se pidió saber los kilómetros recorridos y cada cuántos hay que cargar
-- combustible. La tentación es calcularlo sumando las distancias entre las
-- coordenadas de llegada de cada trabajo. No sirve, por dos razones:
--
--   · Esas distancias son líneas rectas. El camino real entre dos casas de
--     Selva Alegre no es una recta, y la diferencia no es del 5%.
--   · Ignora todo lo que no es una parada registrada: ir a bodega, volver al
--     taller, la vuelta a casa. Puede ser la mitad del día.
--
-- Un número que parece kilómetros y no lo es sirve para peor que nada, porque
-- se usa para decidir. Y para saber el consumo hace falta el odómetro igual:
-- el combustible es del vehículo, no de la ruta.
--
-- Así que se registra lo que de verdad se sabe: la lectura del tablero.

CREATE TABLE IF NOT EXISTS vehiculos (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre     VARCHAR(60) NOT NULL,
    placa      VARCHAR(20),
    -- A quién se le asignó habitualmente. No es dueño exclusivo: la jornada
    -- guarda con qué vehículo se salió ese día, porque se prestan.
    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    activo     BOOLEAN NOT NULL DEFAULT TRUE,
    notas      TEXT,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/**
 * La jornada: con qué salió, cuánto marcaba al salir y al volver.
 *
 * Dos lecturas por día. Es lo que un técnico puede cargar sin que se le vuelva
 * una tarea: mira el tablero y escribe el número.
 */
CREATE TABLE IF NOT EXISTS jornadas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tecnico_id  UUID NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
    fecha       DATE NOT NULL DEFAULT CURRENT_DATE,
    vehiculo_id UUID REFERENCES vehiculos(id) ON DELETE SET NULL,

    km_inicio   INT CHECK (km_inicio IS NULL OR km_inicio >= 0),
    km_fin      INT CHECK (km_fin    IS NULL OR km_fin    >= 0),
    inicio_at   TIMESTAMPTZ,
    fin_at      TIMESTAMPTZ,
    notas       TEXT,

    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Una jornada por técnico y día: dos filas del mismo día harían que los
    -- kilómetros se cuenten dos veces y el rendimiento del mes salga mal.
    CONSTRAINT jornadas_unica UNIQUE (tecnico_id, fecha),
    -- El odómetro no retrocede. Si el número de cierre es menor que el de
    -- apertura, es un error de tipeo, y aceptarlo daría kilómetros negativos.
    CONSTRAINT jornadas_km_coherente CHECK (km_fin IS NULL OR km_inicio IS NULL OR km_fin >= km_inicio)
);

CREATE INDEX IF NOT EXISTS idx_jornadas_tecnico ON jornadas (tecnico_id, fecha DESC);

CREATE TABLE IF NOT EXISTS cargas_combustible (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehiculo_id UUID NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
    tecnico_id  UUID REFERENCES tecnicos(id) ON DELETE SET NULL,

    fecha       DATE NOT NULL DEFAULT CURRENT_DATE,
    -- La lectura del tablero AL CARGAR. Es lo que permite decir "hicimos 340 km
    -- con el tanque anterior": sin ella solo se sabe cuánta plata se gastó.
    odometro    INT NOT NULL CHECK (odometro >= 0),
    litros      NUMERIC(8, 2) CHECK (litros IS NULL OR litros > 0),
    monto       NUMERIC(10, 2) CHECK (monto  IS NULL OR monto  >= 0),
    estacion    VARCHAR(80),
    notas       TEXT,

    creado_por  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cargas_vehiculo ON cargas_combustible (vehiculo_id, odometro DESC);


-- =============================================================================
-- 3. Las cuentas
-- =============================================================================
-- Kilómetros por jornada, y cuánto falta para la próxima carga.
DROP VIEW IF EXISTS v_jornadas;
CREATE VIEW v_jornadas WITH (security_invoker = true) AS
SELECT
    j.*,
    t.nombre  AS tecnico,
    v.nombre  AS vehiculo,
    v.placa,
    (j.km_fin - j.km_inicio) AS km_recorridos,
    CASE WHEN j.inicio_at IS NOT NULL AND j.fin_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (j.fin_at - j.inicio_at)) / 60)::INT END AS minutos_jornada
FROM jornadas j
LEFT JOIN tecnicos  t ON t.id = j.tecnico_id
LEFT JOIN vehiculos v ON v.id = j.vehiculo_id;

/**
 * Rendimiento por tanque.
 *
 * Cada carga se compara con la anterior del mismo vehículo: la diferencia de
 * odómetro son los kilómetros que se hicieron con lo cargado la vez pasada.
 *
 * La PRIMERA carga de cada vehículo no tiene con qué compararse y queda en
 * nulo. Es correcto: no se puede saber cuánto rindió un tanque del que no se
 * sabe dónde empezó. Rellenarlo con cero haría que el promedio del mes arranque
 * mintiendo.
 */
/**
 * Va con `CREATE OR REPLACE` y no con `DROP` + `CREATE`.
 *
 * De esta vista cuelgan otras que se crean DESPUÉS —v_vehiculos, más abajo en este mismo archivo—, así que un `DROP`
 * hace que volver a correr este archivo falle con "cannot drop view because
 * other objects depend on it". Y como el editor de Supabase corre el archivo
 * entero en una transacción, se cae la migración completa.
 *
 * `CREATE OR REPLACE` reemplaza la definición sin tocar a quien depende de ella.
 * Exige que las columnas sean las mismas, que es exactamente el caso cuando lo
 * que se reejecuta es este mismo archivo.
 */
CREATE OR REPLACE VIEW v_combustible WITH (security_invoker = true) AS
SELECT
    c.*,
    v.nombre AS vehiculo,
    v.placa,
    t.nombre AS tecnico,
    LAG(c.odometro) OVER (PARTITION BY c.vehiculo_id ORDER BY c.odometro) AS odometro_anterior,
    c.odometro - LAG(c.odometro) OVER (PARTITION BY c.vehiculo_id ORDER BY c.odometro) AS km_del_tanque,
    CASE WHEN c.litros > 0
         THEN ROUND(
              (c.odometro - LAG(c.odometro) OVER (PARTITION BY c.vehiculo_id ORDER BY c.odometro))
              / c.litros, 1)
    END AS km_por_litro
FROM cargas_combustible c
LEFT JOIN vehiculos v ON v.id = c.vehiculo_id
LEFT JOIN tecnicos  t ON t.id = c.tecnico_id;

/** Cuánto se anduvo desde la última carga de cada vehículo. */
DROP VIEW IF EXISTS v_vehiculos;
CREATE VIEW v_vehiculos WITH (security_invoker = true) AS
WITH ultima_carga AS (
    SELECT DISTINCT ON (vehiculo_id) vehiculo_id, odometro, fecha, litros
      FROM cargas_combustible ORDER BY vehiculo_id, odometro DESC
),
ultimo_km AS (
    SELECT vehiculo_id, MAX(GREATEST(COALESCE(km_fin, 0), COALESCE(km_inicio, 0))) AS km
      FROM jornadas WHERE vehiculo_id IS NOT NULL GROUP BY vehiculo_id
),
promedio AS (
    SELECT vehiculo_id, ROUND(AVG(km_del_tanque)) AS km_promedio_tanque
      FROM v_combustible WHERE km_del_tanque IS NOT NULL GROUP BY vehiculo_id
)
SELECT
    v.*,
    t.nombre AS tecnico,
    uc.odometro AS odometro_ultima_carga,
    uc.fecha    AS fecha_ultima_carga,
    uk.km       AS odometro_actual,
    (uk.km - uc.odometro) AS km_desde_la_carga,
    p.km_promedio_tanque,
    -- Lo que se pidió: cada cuánto hay que cargar. Sale del promedio real de
    -- este vehículo, no de un número fijo — una camioneta y una moto no cargan
    -- cada los mismos kilómetros.
    CASE WHEN p.km_promedio_tanque > 0
         THEN GREATEST(0, p.km_promedio_tanque - (uk.km - uc.odometro)) END AS km_para_cargar
FROM vehiculos v
LEFT JOIN tecnicos t      ON t.id = v.tecnico_id
LEFT JOIN ultima_carga uc ON uc.vehiculo_id = v.id
LEFT JOIN ultimo_km uk    ON uk.vehiculo_id = v.id
LEFT JOIN promedio p      ON p.vehiculo_id = v.id;


-- =============================================================================
-- 4. Seguridad
-- =============================================================================
ALTER TABLE vehiculos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE jornadas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cargas_combustible ENABLE ROW LEVEL SECURITY;

-- Los vehículos los ve todo el personal: el técnico tiene que poder elegir con
-- cuál sale. Darlos de alta es de administración.
DROP POLICY IF EXISTS vehiculos_lectura ON vehiculos;
CREATE POLICY vehiculos_lectura ON vehiculos
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS vehiculos_escritura ON vehiculos;
CREATE POLICY vehiculos_escritura ON vehiculos
    FOR ALL TO authenticated
    USING (cartera_completa()) WITH CHECK (cartera_completa());

-- La jornada y las cargas: cada técnico las suyas. Quien dirige, todas.
--
-- Un técnico que pudiera editar la jornada de otro podría cambiarle los
-- kilómetros, y esos kilómetros van a alimentar una comparación de rendimiento
-- entre técnicos. Eso convierte el dato en algo que no se puede usar.
DROP POLICY IF EXISTS jornadas_acceso ON jornadas;
CREATE POLICY jornadas_acceso ON jornadas
    FOR ALL TO authenticated
    USING (cartera_completa() OR ve_todo_el_equipo() OR tecnico_id = mi_tecnico_id())
    WITH CHECK (cartera_completa() OR ve_todo_el_equipo() OR tecnico_id = mi_tecnico_id());

DROP POLICY IF EXISTS cargas_combustible_acceso ON cargas_combustible;
CREATE POLICY cargas_combustible_acceso ON cargas_combustible
    FOR ALL TO authenticated
    USING (cartera_completa() OR ve_todo_el_equipo() OR tecnico_id = mi_tecnico_id())
    WITH CHECK (cartera_completa() OR ve_todo_el_equipo() OR tecnico_id = mi_tecnico_id());


-- =============================================================================
-- 5. Que el número se vea
-- =============================================================================
-- `v_instalaciones` tiene el `i.*` ya expandido, así que la columna nueva se
-- agrega envolviendo la vista — igual que en la 89.
--
-- El `WITH (security_invoker = true)` va escrito a mano. Omitirlo no lo
-- conserva: lo borra. Ese error abrió el agujero que arregló la 89 y no se
-- repite.
-- Y de paso el estado del expediente: si el contrato está firmado y si la
-- documentación está completa.
--
-- No se inventa la definición: `v_expedientes` ya calcula `ok_firma` y
-- `completo`, y son los mismos que valida `enviar_expediente_a_instalaciones`
-- antes de dejar pasar la venta a instalaciones. Si el técnico viera "documentos
-- completos" con un criterio distinto del que usó la oficina para aprobarla,
-- una de las dos pantallas estaría mintiendo.
DO $$
DECLARE v_def TEXT;
BEGIN
    -- Misma guarda que en la 89, y por lo mismo: envolver dos veces choca contra
    -- la columna que agregó la primera pasada y tira abajo toda la migración.
    -- Con esto, reejecutar el archivo no hace nada en vez de fallar.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'v_instalaciones' AND column_name = 'numero'
    ) THEN
        RAISE NOTICE 'v_instalaciones ya expone el número de orden: no se toca.';
        RETURN;
    END IF;

    SELECT pg_get_viewdef('v_instalaciones'::regclass, true) INTO v_def;
    EXECUTE 'CREATE OR REPLACE VIEW v_instalaciones WITH (security_invoker = true) AS '
         || 'SELECT v.*, i.numero, '
         || 'COALESCE(e.ok_firma, false)  AS contrato_firmado, '
         || 'COALESCE(e.completo, false)  AS documentos_completos '
         || 'FROM (' || rtrim(v_def, ';') || ') v '
         || 'JOIN instalaciones i ON i.id = v.id '
         || 'LEFT JOIN v_expedientes e ON e.instalacion_id = i.id';
    RAISE NOTICE 'v_instalaciones expone el número de orden y el estado del expediente.';
END $$;

DO $$
DECLARE v_inv TEXT;
BEGIN
    SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), 'off')
      INTO v_inv FROM pg_class c WHERE c.relname = 'v_instalaciones' AND c.relkind = 'v';
    IF v_inv = 'true' THEN
        RAISE NOTICE 'COMPROBADO: v_instalaciones sigue aplicando RLS.';
    ELSE
        RAISE WARNING 'PELIGRO: v_instalaciones NO aplica RLS. Corré: ALTER VIEW v_instalaciones SET (security_invoker = true);';
    END IF;
END $$;
