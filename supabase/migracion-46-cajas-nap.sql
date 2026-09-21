-- =============================================================================
-- Migración 46 — De qué caja NAP cuelga cada abonado
-- =============================================================================
-- La OLT no puede saberlo: los splitters son pasivos, no le contestan a nadie.
-- Entre un puerto PON y la casa puede haber una caja o cinco, y el equipo ve
-- exactamente lo mismo en los dos casos.
--
-- Así que es un dato que ponen las personas. Lo que sí puede hacer el sistema es
-- proponer las cajas cruzando lo que ya sabe —puerto, dirección y distancia
-- medida— para que revisar sea más rápido que relevar.
--
-- La pregunta que esto contesta, y que hoy no se puede contestar: cuando entra
-- un cliente nuevo, ¿queda lugar en la caja de esa cuadra, o hay que ir con una
-- caja nueva en la camioneta?
-- =============================================================================

ALTER TABLE onus
    ADD COLUMN IF NOT EXISTS nap_id UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    -- Cómo se supo: "propuesta" es una agrupación que alguien aceptó sin
    -- verificar en el poste; "campo" es alguien que fue y lo vio.
    --
    -- No es burocracia: cuando una caja se llene y el sistema diga que hay lugar
    -- para uno más, importa saber si ese número salió de una deducción o de
    -- alguien que la abrió.
    ADD COLUMN IF NOT EXISTS nap_origen VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_onus_nap ON onus (nap_id);

COMMENT ON COLUMN onus.nap_id IS
    'Caja NAP de la que cuelga. La OLT no lo sabe —los splitters son pasivos—: lo carga una persona o se acepta una propuesta del sistema.';

COMMENT ON COLUMN onus.nap_origen IS
    '"propuesta" = agrupación aceptada sin ir al poste. "campo" = alguien lo verificó. Distinguirlos evita mandar una instalación a una caja que se creía con lugar.';


-- Las cajas también quieren saber de qué placa cuelgan, no solo de qué puerto.
ALTER TABLE puntos_red
    ADD COLUMN IF NOT EXISTS slot INT,
    -- Cuántas bocas tiene el splitter. Sin esto no se puede contestar si entra
    -- uno más, que es la única pregunta que se le hace a una caja.
    ADD COLUMN IF NOT EXISTS origen VARCHAR(20);

COMMENT ON COLUMN puntos_red.capacidad IS
    'Bocas del splitter. 8 y 16 son las habituales. Es lo que decide si entra un abonado más.';


-- -----------------------------------------------------------------------------
-- Ocupación de cada caja
-- -----------------------------------------------------------------------------
/**
 * Va con `CREATE OR REPLACE` y no con `DROP` + `CREATE`.
 *
 * De esta vista cuelgan otras que se crean DESPUÉS —la 84 y la 88—, así que un `DROP`
 * hace que volver a correr este archivo falle con "cannot drop view because
 * other objects depend on it". Y como el editor de Supabase corre el archivo
 * entero en una transacción, se cae la migración completa.
 *
 * `CREATE OR REPLACE` reemplaza la definición sin tocar a quien depende de ella.
 * Exige que las columnas sean las mismas, que es exactamente el caso cuando lo
 * que se reejecuta es este mismo archivo.
 */
CREATE OR REPLACE VIEW v_cajas_nap WITH (security_invoker = true) AS
SELECT
    n.id,
    n.nombre,
    n.tipo,
    n.capacidad,
    n.direccion,
    n.latitud,
    n.longitud,
    n.slot,
    n.puerto_pon,
    n.activo,
    n.notas,
    n.origen,
    n.created_at,
    o.id            AS olt_id,
    o.nombre        AS olt,
    o.numero        AS olt_numero,

    COUNT(u.id)                                    AS ocupadas,
    COUNT(u.id) FILTER (WHERE u.nap_origen = 'campo') AS verificadas,
    -- NULL cuando no se cargó la capacidad: "no sé cuántas quedan" no es
    -- "quedan cero", y tampoco es "hay lugar".
    CASE WHEN n.capacidad IS NULL THEN NULL
         ELSE GREATEST(0, n.capacidad - COUNT(u.id)) END AS libres,
    CASE WHEN n.capacidad IS NULL THEN NULL
         ELSE COUNT(u.id) >= n.capacidad END          AS llena,

    -- Con qué señal llegan sus abonados. Una caja entera con la señal caída
    -- apunta al splitter o al tramo que la alimenta, no a las casas.
    ROUND(AVG(u.rx_power_dbm)::NUMERIC, 2)         AS rx_promedio,
    MIN(u.rx_power_dbm)                            AS rx_peor,
    COUNT(u.id) FILTER (WHERE u.rx_power_dbm < -27) AS con_senal_baja,
    MIN(u.distancia_m)                             AS distancia_min,
    MAX(u.distancia_m)                             AS distancia_max
FROM puntos_red n
LEFT JOIN olts o ON o.id = n.olt_id
LEFT JOIN onus u ON u.nap_id = n.id
GROUP BY n.id, o.id, o.nombre, o.numero;


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
-- Explícito y fuera de bloques DO: el analizador de Supabase no lee adentro de
-- un EXECUTE y reporta las tablas como si quedaran sin RLS.

ALTER TABLE puntos_red ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_puntos_red" ON puntos_red;
CREATE POLICY "auth_all_puntos_red" ON puntos_red
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
