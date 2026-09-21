-- =============================================================================
-- Migración 186 — La potencia de los dos lados del enlace
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué se está tirando ──
--
-- Cada lectura óptica de una ONT Huawei devuelve esto:
--
--     rxPowerDbm     -21.13   lo que RECIBE la ONT     ← lo único que se guarda
--     txPowerDbm       2.75   lo que TRANSMITE la ONT
--     olrRxPowerDbm  -26.20   lo que recibe la OLT DESDE la ONT
--     distanciaM       8465   cuánta fibra hay en el medio
--     temperaturaC       54
--
-- El middleware ya los lee y los normaliza —`normalizarOptica` en oltFicha.js
-- los traduce a nombres de columna—, pero solo `rx_power_dbm` tiene dónde
-- guardarse. `olt_rx_power_dbm` se arma en memoria y se pierde; `tx_power_dbm`
-- y `distancia_m` existen como columnas y nadie las escribe.
--
-- ── Por qué importan las dos direcciones ──
--
-- Un enlace óptico tiene dos sentidos y pueden fallar por separado. Con solo el
-- Rx de la ONT se ve la mitad:
--
--   · ONT recibe bien y la OLT recibe mal → problema en el sentido de subida:
--     el láser de la ONT flojo, un conector sucio del lado del abonado, o un
--     splitter mal balanceado. El abonado navega para abajo y se le corta al
--     subir.
--   · Los dos flojos por igual → atenuación en el tramo común.
--
-- Sin el valor de la OLT ese diagnóstico no se puede hacer desde la oficina, y
-- alguien viaja al domicilio a medir lo que el equipo ya sabía.
--
-- La distancia sirve para otra cosa: ubicar la rotura. Si la ONT reporta 8465 m
-- y el plano dice 2 km, el empalme está donde no se creía.
-- =============================================================================


ALTER TABLE onus
    /**
     * Cuánta potencia recibe la OLT desde esta ONT.
     *
     * Es el sentido de subida. Se llama así y no `tx_...` a propósito: lo que la
     * ONT transmite (`tx_power_dbm`) y lo que la OLT recibe NO son el mismo
     * número — entre los dos está toda la fibra, y esa diferencia es justamente
     * la atenuación del tramo.
     */
    ADD COLUMN IF NOT EXISTS olt_rx_power_dbm NUMERIC(6,2),

    -- Grados de la ONT. Una que trabaja a 70 °C se degrada aunque la señal esté
    -- bien, y es de lo que explica las caídas que "no tienen motivo".
    ADD COLUMN IF NOT EXISTS temperatura_c NUMERIC(5,1);

COMMENT ON COLUMN onus.olt_rx_power_dbm IS
    'Potencia que la OLT recibe DESDE esta ONT (sentido de subida). Con rx_power_dbm se ven los dos sentidos: si este esta mal y el otro bien, el problema es del lado del abonado.';

COMMENT ON COLUMN onus.temperatura_c IS
    'Temperatura de la ONT en grados. Sobre 70 se degrada aunque la senal este bien.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Las que tienen los dos sentidos medidos, y la atenuación de subida:
--   SELECT sn, rx_power_dbm AS onu_rx, olt_rx_power_dbm AS olt_rx,
--          distancia_m, temperatura_c
--     FROM onus
--    WHERE olt_rx_power_dbm IS NOT NULL
--    ORDER BY olt_rx_power_dbm;
--
--   -- Las sospechosas: la ONT recibe bien pero la OLT la escucha mal.
--   SELECT sn, rx_power_dbm, olt_rx_power_dbm
--     FROM onus
--    WHERE rx_power_dbm > -25 AND olt_rx_power_dbm < -27;
