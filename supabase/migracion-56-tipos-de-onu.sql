-- =============================================================================
-- Migración 56 — Tipos de ONU, completos
-- =============================================================================
-- `tipos_ont` nació con lo mínimo: marca, modelo y cuántos puertos. Alcanzaba
-- para proponer un service-profile al autorizar.
--
-- Ahora hace falta más, y por dos motivos concretos:
--
--   TR069  para provisionar una ONT hay que saber qué nodos de su árbol
--          DataModel existen. Los prefijos —eth_0/, wifi_0/, pots_0/— y si el
--          equipo hace routing o solo bridging son lo que decide qué se le
--          puede pedir. Sin eso el ACS pregunta por nodos que no existen y la
--          configuración falla sin decir por qué.
--
--   La ficha manual  cuando el modelo NO acepta TR069, el técnico tiene que
--          cargar todo a mano — y para eso hay que saber si el equipo tiene
--          WiFi, cuántos SSIDs y si tiene teléfono. Ofrecerle configurar el
--          WiFi de una ONT que no tiene es hacerle perder el viaje.
--
-- El campo `wifi` era booleano. Pasa a ser una cuenta de SSIDs: "tiene WiFi" no
-- distingue una ONT de una banda de una de dos, y esa diferencia es la que
-- decide cuántas redes hay que configurar.
-- =============================================================================

ALTER TABLE tipos_ont
    -- La tecnología. Una EPON y una GPON no se autorizan igual.
    ADD COLUMN IF NOT EXISTS pon_tipo VARCHAR(10) NOT NULL DEFAULT 'GPON'
        CHECK (pon_tipo IN ('GPON', 'EPON')),

    -- Qué canales soporta: GPON, XG-PON, XGS-PON. Se guarda como lista porque
    -- una ONT combo soporta varios y hay que saber cuál usar al autorizarla.
    ADD COLUMN IF NOT EXISTS canales TEXT[] NOT NULL DEFAULT ARRAY['GPON'],

    -- Cuántas redes WiFi configurables. Reemplaza al booleano `wifi`.
    ADD COLUMN IF NOT EXISTS wifi_ssids INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS catv INT NOT NULL DEFAULT 0,

    -- Si acepta perfiles de velocidad propios o solo los del equipo.
    ADD COLUMN IF NOT EXISTS perfiles_propios BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS perfil_default_id UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,

    -- Bridging = la ONT solo pasa tráfico y el PPPoE lo hace el router del
    -- abonado. Bridging/Routing = la ONT puede hacer el PPPoE ella misma, que
    -- es el caso en el que tiene sentido cargarle usuario y clave.
    ADD COLUMN IF NOT EXISTS capacidad VARCHAR(20) NOT NULL DEFAULT 'bridging_routing'
        CHECK (capacidad IN ('bridging', 'bridging_routing')),

    -- Los prefijos del árbol TR069. Sin ellos el ACS no sabe cómo se llaman los
    -- nodos de este modelo y pregunta por rutas que no existen.
    ADD COLUMN IF NOT EXISTS prefijo_eth  VARCHAR(30) DEFAULT 'eth_0/',
    ADD COLUMN IF NOT EXISTS prefijo_wifi VARCHAR(30) DEFAULT 'wifi_0/',
    ADD COLUMN IF NOT EXISTS prefijo_voip VARCHAR(30) DEFAULT 'pots_0/',

    -- Lo que el equipo dice de sí mismo por TR069. Sirve para reconocer el
    -- modelo cuando la ONT se anuncia sola.
    ADD COLUMN IF NOT EXISTS vendor_id    VARCHAR(20),
    ADD COLUMN IF NOT EXISTS version_spec VARCHAR(30),
    ADD COLUMN IF NOT EXISTS parametros   JSONB,

    ADD COLUMN IF NOT EXISTS imagen_url   TEXT,
    ADD COLUMN IF NOT EXISTS notas        TEXT,
    ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- El booleano viejo, convertido. Una ONT marcada "con WiFi" pasa a tener dos
-- SSIDs, que es lo habitual (2.4 y 5 GHz); las que no tenían quedan en cero.
-- Se hace una sola vez, y solo donde el valor nuevo todavía está sin tocar.
UPDATE tipos_ont SET wifi_ssids = 2 WHERE wifi IS TRUE AND wifi_ssids = 0;

COMMENT ON COLUMN tipos_ont.wifi_ssids IS
    'Cuántas redes WiFi configurables tiene. Reemplaza al booleano wifi: "tiene WiFi" no distingue una ONT de una banda de una de dos, y esa diferencia decide cuántas redes hay que configurar.';

COMMENT ON COLUMN tipos_ont.capacidad IS
    'bridging = solo pasa tráfico, el PPPoE lo hace el router del abonado · bridging_routing = la ONT puede hacer el PPPoE ella misma. Decide si tiene sentido cargarle usuario y clave.';

COMMENT ON COLUMN tipos_ont.prefijo_eth IS
    'Cómo se llaman los nodos de este modelo en el árbol TR069. Sin esto el ACS pregunta por rutas que no existen y la configuración falla sin decir por qué.';


-- -----------------------------------------------------------------------------
-- Cuántas ONUs usa cada tipo
-- -----------------------------------------------------------------------------
-- Es lo que decide si un tipo se puede borrar. Borrarlo con ONUs vinculadas las
-- deja sin modelo, y con eso se pierde la propuesta de service-profile al
-- autorizar y la ficha manual deja de saber si el equipo tiene WiFi.
--
-- Se cuentan por las dos vías: las que apuntan al tipo, y las que reportaron
-- ese modelo aunque nadie las haya enganchado. La segunda es la que importa en
-- una base recién migrada, donde el vínculo todavía no está hecho.
DROP VIEW IF EXISTS v_tipos_ont;
CREATE VIEW v_tipos_ont WITH (security_invoker = true) AS
SELECT
    t.*,
    COALESCE(v.enlazadas, 0) AS onus_enlazadas,
    COALESCE(m.por_modelo, 0) AS onus_por_modelo,
    COALESCE(v.enlazadas, 0) + COALESCE(m.por_modelo, 0) AS onus,
    p.nombre AS perfil_default
FROM tipos_ont t
LEFT JOIN planes_velocidad p ON p.id = t.perfil_default_id
LEFT JOIN (
    SELECT tipo_ont_id, COUNT(*) AS enlazadas
    FROM onus WHERE tipo_ont_id IS NOT NULL GROUP BY tipo_ont_id
) v ON v.tipo_ont_id = t.id
LEFT JOIN (
    SELECT modelo, COUNT(*) AS por_modelo
    FROM onus WHERE modelo IS NOT NULL AND tipo_ont_id IS NULL GROUP BY modelo
) m ON UPPER(m.modelo) = UPPER(t.modelo);

COMMENT ON VIEW v_tipos_ont IS
    'Tipos de ONU con cuántas los usan. Se cuenta por el vínculo y por el modelo reportado: en una base recién migrada el vínculo todavía no está hecho y solo el modelo dice la verdad.';
