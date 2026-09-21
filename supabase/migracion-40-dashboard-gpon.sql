-- =============================================================================
-- Migración 40 · Tablero de OLT/GPON
-- =============================================================================
-- Las cuentas del tablero se resuelven en la base y no en el navegador. Con
-- ochenta ONUs daría igual, pero con mil el navegador tendría que traérselas
-- todas para contar cuántas están caídas.
--
-- Idempotente.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Cuándo se autorizó de verdad cada ONT
-- -----------------------------------------------------------------------------
-- `created_at` dice cuándo la importó ESTE sistema, que no es lo mismo: al
-- importar un equipo con años de servicio, todas quedan con la fecha de hoy y
-- cualquier gráfico de altas por día muestra una sola barra.
--
-- La fecha real viene en la descripción que dejó el sistema anterior
-- ("..._authd_20251013"), así que se guarda aparte.
ALTER TABLE onus
    ADD COLUMN IF NOT EXISTS autorizada_at DATE,
    ADD COLUMN IF NOT EXISTS zona VARCHAR(60);

COMMENT ON COLUMN onus.autorizada_at IS
    'Fecha en que la ONT se autorizó en la OLT, leída de la descripción del equipo. Distinta de created_at, que es cuándo la importó este sistema.';


-- -----------------------------------------------------------------------------
-- 2. Resumen por OLT
-- -----------------------------------------------------------------------------
-- Los umbrales ópticos viven acá y no en cada pantalla: si mañana se decide que
-- la alerta es a -26, se cambia en un solo lugar.
--
--   por encima de -24  → bien
--   entre -24 y -27    → hay que mirarla antes de que corte
--   por debajo de -27  → pérdida de paquetes y cortes
DROP VIEW IF EXISTS v_olt_resumen;
CREATE VIEW v_olt_resumen WITH (security_invoker = true) AS
SELECT
    o.id                AS olt_id,
    o.numero,
    o.nombre,
    o.marca,
    o.ip_host,
    o.activo,
    o.estado            AS olt_estado,
    o.estado_at,
    o.estado_latencia_ms,
    o.hw_version,
    o.sw_version,

    COUNT(u.id)                                                   AS onus,
    COUNT(*) FILTER (WHERE u.estado = 'online')                   AS online,
    COUNT(*) FILTER (WHERE u.estado <> 'online')                  AS caidas,
    COUNT(*) FILTER (WHERE u.estado = 'los')                      AS los,
    COUNT(*) FILTER (WHERE u.estado = 'power_off')                AS power_off,
    -- Caída sin causa conocida. Se cuenta aparte a propósito: "no sé por qué se
    -- cayó" es un diagnóstico distinto de "se quedó sin luz", y mezclarlos hace
    -- creer que se sabe más de lo que se sabe.
    COUNT(*) FILTER (WHERE u.estado IN ('offline', 'unknown'))    AS sin_causa,

    COUNT(*) FILTER (WHERE u.rx_power_dbm IS NULL)                AS sin_lectura,
    COUNT(*) FILTER (WHERE u.rx_power_dbm < -27)                  AS senal_critica,
    COUNT(*) FILTER (WHERE u.rx_power_dbm >= -27 AND u.rx_power_dbm < -24) AS senal_aviso,
    ROUND(AVG(u.rx_power_dbm), 2)                                 AS rx_promedio,
    MIN(u.rx_power_dbm)                                           AS rx_peor,

    COUNT(*) FILTER (WHERE c.id IS NULL AND u.id IS NOT NULL)     AS sin_abonado,
    MAX(u.ultima_lectura)                                         AS ultima_lectura
FROM olts o
LEFT JOIN onus u     ON u.olt_id = o.id
LEFT JOIN clientes c ON c.onu_id = u.id
GROUP BY o.id, o.numero, o.nombre, o.marca, o.ip_host, o.activo,
         o.estado, o.estado_at, o.estado_latencia_ms, o.hw_version, o.sw_version;


-- -----------------------------------------------------------------------------
-- 3. Estado de cada puerto PON
-- -----------------------------------------------------------------------------
-- Sirve para una pregunta puntual: ¿esto es un abonado o es el puerto?
--
-- Cuando se corta un tramo de fibra o muere un módulo óptico, caen TODOS los
-- abonados de ese puerto a la vez. Desde la ficha de cada uno parece un problema
-- distinto, y se despachan quince visitas para una sola causa.
DROP VIEW IF EXISTS v_pon_puertos;
CREATE VIEW v_pon_puertos WITH (security_invoker = true) AS
SELECT
    u.olt_id,
    o.nombre                                        AS olt,
    u.slot,
    u.puerto,
    COUNT(*)                                        AS onus,
    COUNT(*) FILTER (WHERE u.estado = 'online')     AS online,
    COUNT(*) FILTER (WHERE u.estado <> 'online')    AS caidas,
    COUNT(*) FILTER (WHERE u.rx_power_dbm < -27)    AS senal_critica,
    ROUND(AVG(u.rx_power_dbm), 2)                   AS rx_promedio,
    MIN(u.rx_power_dbm)                             AS rx_peor,

    -- Todo el puerto abajo: la causa es del lado de la red, no de los abonados.
    -- Con una sola ONT no significa nada —puede ser el equipo del cliente— así
    -- que se exige un mínimo de dos.
    (COUNT(*) > 1 AND COUNT(*) FILTER (WHERE u.estado = 'online') = 0) AS puerto_caido,

    -- Más de la mitad caídas pero no todas: se está degradando.
    (COUNT(*) > 3
     AND COUNT(*) FILTER (WHERE u.estado <> 'online') * 2 > COUNT(*)
     AND COUNT(*) FILTER (WHERE u.estado = 'online') > 0) AS puerto_degradado
FROM onus u
LEFT JOIN olts o ON o.id = u.olt_id
GROUP BY u.olt_id, o.nombre, u.slot, u.puerto;


-- -----------------------------------------------------------------------------
-- 4. Autorizaciones por día
-- -----------------------------------------------------------------------------
-- Con la fecha real del equipo, no con la de importación. Las que no la tengan
-- quedan fuera en vez de amontonarse todas en el día de la importación y
-- dibujar un pico que nunca ocurrió.
DROP VIEW IF EXISTS v_onus_por_dia;
CREATE VIEW v_onus_por_dia WITH (security_invoker = true) AS
SELECT
    u.olt_id,
    u.autorizada_at AS dia,
    COUNT(*)        AS altas
FROM onus u
WHERE u.autorizada_at IS NOT NULL
GROUP BY u.olt_id, u.autorizada_at;
