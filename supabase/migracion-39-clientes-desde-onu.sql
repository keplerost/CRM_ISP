-- =============================================================================
-- Migración 39 · Abonados que vienen de una ONU
-- =============================================================================
-- El enlace abonado↔ONT ya existía (`clientes.onu_id`), pero no había forma de
-- distinguir una ficha creada a partir del inventario de la OLT de una cargada
-- a mano. Esa distinción es la que permite deshacer una importación equivocada
-- sin llevarse puestas las fichas buenas.
--
-- Idempotente.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Un origen más
-- -----------------------------------------------------------------------------
ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_origen_check;
ALTER TABLE clientes
    ADD CONSTRAINT clientes_origen_check
    CHECK (origen IN ('manual', 'ppp-secret', 'simple-queue', 'dhcp-lease', 'address-list', 'onu'));

COMMENT ON COLUMN clientes.origen IS
    'De dónde salió la ficha. "onu" = se creó desde el inventario de la OLT, con lo que el equipo tenía anotado en la descripción de la ONT. Sirve para revisar esas fichas aparte y para poder deshacer una importación.';


-- -----------------------------------------------------------------------------
-- 2. Una ONT es de un solo abonado
-- -----------------------------------------------------------------------------
-- Sin esto, dos importaciones seguidas o un enlace hecho a mano pueden dejar dos
-- fichas apuntando a la misma ONT. Cuando eso pasa, cortarle el servicio a uno
-- se lo corta al otro, y la lectura óptica aparece en dos abonados distintos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_onu
    ON clientes (onu_id)
    WHERE onu_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 3. Qué ONT es de quién
-- -----------------------------------------------------------------------------
-- Contesta las dos preguntas que hoy hay que cruzar a mano: de qué abonado es
-- esta señal baja, y qué ONTs están sirviendo a alguien que no está en el
-- sistema.
DROP VIEW IF EXISTS v_onus_clientes;
CREATE VIEW v_onus_clientes WITH (security_invoker = true) AS
SELECT
    u.id                AS onu_id,
    u.olt_id,
    o.nombre            AS olt,
    u.sn,
    u.frame,
    u.slot,
    u.puerto,
    u.onu_index,
    u.estado            AS onu_estado,
    u.rx_power_dbm,
    u.tx_power_dbm,
    u.distancia_m,
    u.ultima_lectura,
    -- El nombre que tiene anotado la OLT en la descripción de la ONT.
    u.nombre_cliente    AS nombre_en_la_olt,

    c.id                AS client_id,
    c.nombre            AS cliente,
    c.identificacion,
    c.estado            AS cliente_estado,
    c.origen            AS cliente_origen,
    c.plan_id,
    p.nombre            AS plan,

    -- Una ONT que sirve a alguien que no está en el sistema: hay servicio dado
    -- y nadie a quien facturarle.
    (c.id IS NULL)      AS sin_abonado,

    -- Señal por debajo del umbral del taller. Se calcula acá para que la regla
    -- viva en un solo lugar y no en cada pantalla que quiera preguntarla.
    (u.rx_power_dbm IS NOT NULL AND u.rx_power_dbm < -27) AS senal_baja
FROM onus u
LEFT JOIN olts o              ON o.id = u.olt_id
LEFT JOIN clientes c          ON c.onu_id = u.id
LEFT JOIN planes_velocidad p  ON p.id = c.plan_id;
