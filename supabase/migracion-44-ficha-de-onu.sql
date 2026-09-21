-- =============================================================================
-- Migración 44 — Lo que falta para el listado y la ficha de cada ONU
-- =============================================================================
-- Hoy, para saber de qué modelo es una ONT o en qué VLAN está, hay que abrir una
-- sesión contra el equipo y preguntarle. Eso está bien para UNA; para un listado
-- de novecientas es imposible.
--
-- Estos datos ya los sabemos en el momento del alta o de la importación —el
-- equipo los dice— y no se estaban guardando. Guardarlos convierte un listado
-- que necesita mil sesiones SSH en una sola consulta.
--
-- Todo lo de acá es CACHÉ de lo que dice el equipo, no la verdad. La verdad
-- sigue estando en la OLT, y por eso cada fila guarda CUÁNDO se leyó: un dato
-- sin fecha se lee como si fuera de ahora, y el de una ONT que se reconfiguró
-- hace tres meses no lo es.
-- =============================================================================

ALTER TABLE onus
    -- El modelo que reporta la propia ONT ("GN256VH", "HG8145X6-13"). Es lo que
    -- decide qué perfil de servicio le corresponde y qué puertos tiene.
    ADD COLUMN IF NOT EXISTS modelo VARCHAR(60),

    -- La VLAN de servicio del abonado. Sale de su service-port.
    ADD COLUMN IF NOT EXISTS vlan INT,

    -- La descripción tal cual la tiene el equipo. Se guarda cruda a propósito:
    -- es de donde salen el nombre, la dirección y la fecha de alta, y si mañana
    -- cambia el formato conviene tener el original para volver a leerlo.
    ADD COLUMN IF NOT EXISTS descripcion_olt TEXT,

    -- Dirección o referencia de dónde está instalada. Distinta del domicilio de
    -- facturación del cliente: acá va dónde está el equipo.
    ADD COLUMN IF NOT EXISTS direccion TEXT,
    ADD COLUMN IF NOT EXISTS contacto VARCHAR(80),

    -- La caja de distribución de la que cuelga. Es lo primero que se pregunta
    -- cuando se caen varias juntas: si todas son de la misma caja, el problema
    -- está ahí y no en las casas.
    ADD COLUMN IF NOT EXISTS odb VARCHAR(60),

    -- Perfiles con los que quedó registrada en el equipo.
    ADD COLUMN IF NOT EXISTS line_profile_olt INT,
    ADD COLUMN IF NOT EXISTS srv_profile_olt INT,
    ADD COLUMN IF NOT EXISTS srv_profile_nombre VARCHAR(60),

    -- Cuándo se leyó del equipo lo de arriba. Sin esto, un modelo o una VLAN
    -- guardados hace meses se muestran igual que uno leído recién.
    ADD COLUMN IF NOT EXISTS ficha_leida_at TIMESTAMPTZ;

COMMENT ON COLUMN onus.vlan IS
    'VLAN de servicio del abonado, copiada de su service-port. Es caché: la verdad está en la OLT, y ficha_leida_at dice de cuándo es esta copia.';

COMMENT ON COLUMN onus.odb IS
    'Caja de distribución (splitter) de la que cuelga. Cuando se caen varias ONTs juntas, que compartan caja es lo que distingue un problema de la red de una coincidencia.';

COMMENT ON COLUMN onus.ficha_leida_at IS
    'Cuándo se leyeron del equipo el modelo, la VLAN y los perfiles. Un dato sin fecha se lee como si fuera de ahora.';

CREATE INDEX IF NOT EXISTS idx_onus_vlan  ON onus (vlan);
CREATE INDEX IF NOT EXISTS idx_onus_zona  ON onus (zona);
CREATE INDEX IF NOT EXISTS idx_onus_odb   ON onus (odb);


-- -----------------------------------------------------------------------------
-- El listado
-- -----------------------------------------------------------------------------
-- Se amplía la vista que ya existe en vez de crear otra: dos vistas que
-- contestan casi lo mismo terminan divergiendo, y la pantalla que quedó usando
-- la vieja muestra números distintos de la que usa la nueva sin que nadie
-- entienda por qué.
DROP VIEW IF EXISTS v_onus_clientes;
CREATE VIEW v_onus_clientes WITH (security_invoker = true) AS
SELECT
    u.id                AS onu_id,
    u.olt_id,
    o.nombre            AS olt,
    o.numero            AS olt_numero,
    u.sn,
    u.frame,
    u.slot,
    u.puerto,
    u.onu_index,
    u.estado            AS onu_estado,
    u.causa_caida,
    u.causa_caida_cruda,
    u.ultima_caida,
    u.rx_power_dbm,
    u.tx_power_dbm,
    u.distancia_m,
    u.ultima_lectura,
    u.autorizada_at,
    u.created_at,

    -- El nombre que tiene anotado la OLT en la descripción de la ONT.
    u.nombre_cliente    AS nombre_en_la_olt,
    u.descripcion_olt,
    u.direccion,
    u.contacto,
    u.zona,
    u.odb,
    u.modelo,
    u.vlan,
    u.line_profile_olt,
    u.srv_profile_olt,
    u.srv_profile_nombre,
    u.ficha_leida_at,

    u.plan_id           AS plan_id_onu,
    u.plan_velocidad,

    c.id                AS client_id,
    c.nombre            AS cliente,
    c.identificacion,
    c.estado            AS cliente_estado,
    c.origen            AS cliente_origen,
    c.plan_id,
    p.nombre            AS plan,
    p.bajada_kbps,
    p.subida_kbps,

    -- Una ONT que sirve a alguien que no está en el sistema: hay servicio dado
    -- y nadie a quien facturarle.
    (c.id IS NULL)      AS sin_abonado,

    -- Señal por debajo del umbral del taller. Se calcula acá para que la regla
    -- viva en un solo lugar y no en cada pantalla que quiera preguntarla.
    (u.rx_power_dbm IS NOT NULL AND u.rx_power_dbm < -27) AS senal_baja,

    -- Cómo se escribe su ubicación en el equipo: gpon-onu_0/6/9:17. Se arma acá
    -- para que todas las pantallas la muestren igual y para poder buscarla tal
    -- cual la escribe alguien que la copió de la CLI.
    'gpon-onu_' || u.frame || '/' || u.slot || '/' || u.puerto || ':' || u.onu_index AS ruta_onu
FROM onus u
LEFT JOIN olts o              ON o.id = u.olt_id
LEFT JOIN clientes c          ON c.onu_id = u.id
LEFT JOIN planes_velocidad p  ON p.id = COALESCE(c.plan_id, u.plan_id);


-- -----------------------------------------------------------------------------
-- Los valores que existen, para llenar los filtros
-- -----------------------------------------------------------------------------
-- Sin esto, cada filtro tendría que traerse las novecientas ONUs al navegador
-- para averiguar qué VLANs hay.
DROP VIEW IF EXISTS v_onus_filtros;
CREATE VIEW v_onus_filtros WITH (security_invoker = true) AS
SELECT 'vlan'   AS campo, vlan::TEXT   AS valor, COUNT(*) AS cuantas FROM onus WHERE vlan   IS NOT NULL GROUP BY vlan
UNION ALL
SELECT 'zona',            zona,                  COUNT(*) FROM onus WHERE zona   IS NOT NULL AND zona <> '' GROUP BY zona
UNION ALL
SELECT 'modelo',          modelo,                COUNT(*) FROM onus WHERE modelo IS NOT NULL AND modelo <> '' GROUP BY modelo
UNION ALL
SELECT 'odb',             odb,                   COUNT(*) FROM onus WHERE odb    IS NOT NULL AND odb <> '' GROUP BY odb
UNION ALL
SELECT 'slot',            slot::TEXT,            COUNT(*) FROM onus GROUP BY slot
UNION ALL
SELECT 'puerto',          puerto::TEXT,          COUNT(*) FROM onus GROUP BY puerto;
