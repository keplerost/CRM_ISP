-- =============================================================================
-- Migración 41 · Historial de potencia óptica
-- =============================================================================
-- Hasta acá se guardaba solo la última lectura de cada ONT. Alcanza para saber
-- si HOY está mal, pero no para lo que de verdad importa en una planta de
-- fibra: si viene empeorando.
--
-- Una señal que baja de a poco durante meses se arregla con una visita
-- programada. La misma señal descubierta el día que corta se arregla con una
-- urgencia, de noche y con el abonado enojado. La diferencia entre las dos
-- situaciones es tener esta tabla.
--
-- Idempotente.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La tabla
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onu_optica_historial (
    -- Entero y no UUID: es una tabla que crece por millones de filas y se
    -- consulta siempre por (onu_id, fecha). Un UUID acá pesa el cuádruple en el
    -- índice sin aportar nada.
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    onu_id         UUID NOT NULL REFERENCES onus(id) ON DELETE CASCADE,
    rx_dbm         NUMERIC(5,2),
    tx_dbm         NUMERIC(5,2),
    temperatura_c  INT,
    medida_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS onu_optica_historial_idx
    ON onu_optica_historial (onu_id, medida_at DESC);

COMMENT ON TABLE onu_optica_historial IS
    'Serie de potencia óptica por ONT. No se guarda cada lectura: solo cuando el valor se movió lo suficiente o cuando pasó demasiado tiempo desde el último registro. Con mil ONTs leídas cada quince minutos, guardar todo serían cien mil filas por día y ningún gráfico dibujable.';


-- -----------------------------------------------------------------------------
-- 2. Punto de partida
-- -----------------------------------------------------------------------------
-- Se siembra con la última lectura conocida de cada ONT, para que la serie
-- arranque con un punto en vez de esperar a la próxima medición. Sin esto, el
-- gráfico queda vacío hasta que alguien vuelva a leer la óptica.
INSERT INTO onu_optica_historial (onu_id, rx_dbm, tx_dbm, medida_at)
SELECT u.id, u.rx_power_dbm, u.tx_power_dbm, COALESCE(u.ultima_lectura, NOW())
FROM onus u
WHERE u.rx_power_dbm IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM onu_optica_historial h WHERE h.onu_id = u.id);


-- -----------------------------------------------------------------------------
-- 3. Cuándo se registró por última vez
-- -----------------------------------------------------------------------------
-- Lo usa el middleware para decidir si corresponde guardar una fila nueva. Vive
-- en `onus` y no se calcula con un MAX() sobre el historial: con mil ONTs, eso
-- sería mil subconsultas en cada lectura masiva.
ALTER TABLE onus
    ADD COLUMN IF NOT EXISTS optica_registrada_at TIMESTAMPTZ;

UPDATE onus u
SET optica_registrada_at = h.ultima
FROM (SELECT onu_id, MAX(medida_at) AS ultima FROM onu_optica_historial GROUP BY onu_id) h
WHERE h.onu_id = u.id AND u.optica_registrada_at IS NULL;


-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
ALTER TABLE onu_optica_historial ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_onu_optica_historial" ON onu_optica_historial;
CREATE POLICY "auth_all_onu_optica_historial" ON onu_optica_historial
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- -----------------------------------------------------------------------------
-- 5. Tendencia
-- -----------------------------------------------------------------------------
-- Contesta la pregunta que el número de hoy no contesta: ¿esto viene bajando?
--
-- Se compara la lectura más reciente contra la más vieja de los últimos 90 días.
-- Un delta negativo grande es una fibra degradándose, un conector sucio o un
-- empalme que se está soltando — y todos avisan antes de cortar, si alguien
-- mira.
DROP VIEW IF EXISTS v_onu_optica_tendencia;
CREATE VIEW v_onu_optica_tendencia WITH (security_invoker = true) AS
WITH ventana AS (
    SELECT onu_id, rx_dbm, medida_at,
           ROW_NUMBER() OVER (PARTITION BY onu_id ORDER BY medida_at DESC) AS reciente,
           ROW_NUMBER() OVER (PARTITION BY onu_id ORDER BY medida_at ASC)  AS antigua,
           COUNT(*)    OVER (PARTITION BY onu_id)                          AS muestras
    FROM onu_optica_historial
    WHERE medida_at > NOW() - INTERVAL '90 days'
      AND rx_dbm IS NOT NULL
)
SELECT
    a.onu_id,
    a.muestras,
    v.rx_dbm      AS rx_primera,
    v.medida_at   AS desde,
    a.rx_dbm      AS rx_ultima,
    a.medida_at   AS hasta,
    ROUND(a.rx_dbm - v.rx_dbm, 2) AS delta_db,
    -- Con una sola muestra no hay tendencia que calcular, y decir "estable"
    -- sería afirmar algo que no se midió.
    CASE
        WHEN a.muestras < 2                THEN 'sin_datos'
        WHEN a.rx_dbm - v.rx_dbm <= -3     THEN 'empeorando'
        WHEN a.rx_dbm - v.rx_dbm >=  3     THEN 'mejorando'
        ELSE 'estable'
    END AS tendencia
FROM ventana a
JOIN ventana v ON v.onu_id = a.onu_id AND v.antigua = 1
WHERE a.reciente = 1;
