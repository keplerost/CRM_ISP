-- =============================================================================
-- Migración 79 — Reportes comerciales
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué lugar ocupa, al lado de las otras dos pantallas ──
--
--   El tablero comercial contesta "¿cómo voy HOY?".
--   Inteligencia comercial contesta "¿dónde conviene invertir?".
--   Esto contesta "¿qué pasó?" — la mirada histórica y comparativa.
--
-- Que sean tres y no una es a propósito: mezclar el mes en curso con la serie de
-- doce meses produce una pantalla donde nada se lee bien.
--
-- ── Cómo se valoriza una venta, y por qué importa que sea igual en todos lados ──
--
-- El monto de una venta NO es el precio de lista del plan: es lo que se le
-- cotizó al cliente, que puede tener descuento. `v_prospectos` ya lo resuelve
-- así —la última cotización manda sobre la lista— y estos reportes usan
-- exactamente la misma regla.
--
-- No es un detalle de prolijidad. Si el tablero dijera $17.39 y el reporte del
-- mismo mes dijera $15, nadie volvería a confiar en ninguno de los dos. Una
-- primera versión de este archivo usaba el precio de lista y habría producido
-- justamente eso.
-- =============================================================================


-- =============================================================================
-- 1. Cuándo se ganó, de verdad
-- =============================================================================
-- Para medir cuánto tarda en cerrarse una venta hace falta la fecha exacta en
-- que se ganó. Se venía usando `actualizado_en`, y eso está mal: esa columna se
-- mueve con cualquier edición posterior. Corregirle el teléfono a un cliente en
-- diciembre haría parecer que la venta de marzo se cerró en diciembre.
ALTER TABLE prospectos
    ADD COLUMN IF NOT EXISTS ganado_en TIMESTAMPTZ;

COMMENT ON COLUMN prospectos.ganado_en IS
    'Momento en que pasó a ganado. No se edita: es la base de los tiempos de cierre.';

CREATE OR REPLACE FUNCTION sellar_ganado()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'ganado' AND NEW.ganado_en IS NULL THEN
        NEW.ganado_en := NOW();
    -- Si vuelve atrás —pasa: se reabre una venta que se había dado por cerrada—
    -- la fecha se limpia. Dejarla haría que un prospecto abierto figure con
    -- fecha de cierre.
    ELSIF NEW.estado <> 'ganado' THEN
        NEW.ganado_en := NULL;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sellar_ganado ON prospectos;
CREATE TRIGGER trg_sellar_ganado
    BEFORE INSERT OR UPDATE OF estado ON prospectos
    FOR EACH ROW EXECUTE FUNCTION sellar_ganado();

-- Las que ya estaban ganadas se rellenan con `actualizado_en`, que es lo mejor
-- que hay para ellas. De ahí en adelante el dato es exacto; para estas es una
-- aproximación, y conviene tenerlo presente si algún tiempo de cierre histórico
-- se ve raro.
UPDATE prospectos
   SET ganado_en = actualizado_en
 WHERE estado = 'ganado' AND ganado_en IS NULL;


-- =============================================================================
-- 2. Cuánto vale cada venta
-- =============================================================================
-- Una sola definición, usada por los tres reportes de abajo. Es la misma que
-- aplica `v_prospectos`, y por eso los números coinciden con el tablero.
--
-- Va como función y no repetida en cada vista porque el día que cambie el
-- criterio —por ejemplo, si el contrato firmado pasa a mandar sobre la
-- cotización— hay un solo lugar que tocar.
CREATE OR REPLACE FUNCTION valor_del_prospecto(p_prospecto UUID, p_precio_lista NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT c.precio_mensual FROM cotizaciones c
          WHERE c.prospecto_id = p_prospecto
          ORDER BY c.creado_en DESC LIMIT 1),
        p_precio_lista,
        0
    )
$$;


-- =============================================================================
-- 3. La serie mensual
-- =============================================================================
-- Agrupa por el mes en que el prospecto ENTRÓ, no en el que se ganó: así se ve
-- la cosecha de cada mes —cuántos entraron y cuántos de esos terminaron
-- comprando— que es lo que dice si el trabajo de captación de marzo sirvió.
DROP VIEW IF EXISTS v_reporte_mensual;
CREATE VIEW v_reporte_mensual WITH (security_invoker = true) AS
SELECT
    DATE_TRUNC('month', p.creado_en)::DATE       AS mes,
    COUNT(*)                                      AS cargados,
    COUNT(*) FILTER (WHERE p.estado = 'ganado')   AS ganados,
    COUNT(*) FILTER (WHERE p.estado = 'perdido')  AS perdidos,
    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto
FROM prospectos p
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
GROUP BY 1
ORDER BY 1;


-- =============================================================================
-- 4. Comparación entre vendedores
-- =============================================================================
-- Sobre TODO el historial, no sobre el mes: el tablero ya muestra el mes en
-- curso, y una tabla que repite lo mismo con otro formato no agrega nada.
DROP VIEW IF EXISTS v_reporte_vendedores;
CREATE VIEW v_reporte_vendedores WITH (security_invoker = true) AS
SELECT
    u.id                                    AS vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', u.apellido)) AS vendedor,
    u.activo,

    COUNT(p.id)                                       AS cargados,
    COUNT(p.id) FILTER (WHERE p.estado = 'ganado')    AS ganados,
    COUNT(p.id) FILTER (WHERE p.estado = 'perdido')   AS perdidos,
    COUNT(p.id) FILTER (WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,

    -- Sobre los CERRADOS, no sobre el total: incluir los que todavía están en
    -- proceso castiga a quien trae prospectos nuevos y favorece a quien tiene el
    -- embudo vacío.
    CASE WHEN COUNT(p.id) FILTER (WHERE p.estado IN ('ganado','perdido')) = 0 THEN NULL
         ELSE ROUND(100.0 * COUNT(p.id) FILTER (WHERE p.estado = 'ganado')
              / COUNT(p.id) FILTER (WHERE p.estado IN ('ganado','perdido')), 1)
    END AS tasa_cierre,

    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto_total,

    -- Solo sobre las ganadas que tienen fecha de cierre: una venta sin fecha no
    -- aporta un tiempo, y contarla como cero bajaría el promedio de todos.
    ROUND(AVG(
        EXTRACT(EPOCH FROM (p.ganado_en - p.creado_en)) / 86400
    ) FILTER (WHERE p.ganado_en IS NOT NULL)::NUMERIC, 1) AS dias_cierre
FROM usuarios_sistema u
LEFT JOIN prospectos p        ON p.vendedor_id = u.id
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
WHERE u.rol IN ('vendedor', 'supervisor_ventas', 'admin', 'super_admin')
GROUP BY u.id, u.nombre, u.apellido, u.activo;


-- =============================================================================
-- 5. Qué se vende y dónde
-- =============================================================================
DROP VIEW IF EXISTS v_reporte_planes;
CREATE VIEW v_reporte_planes WITH (security_invoker = true) AS
SELECT
    COALESCE(pl.nombre, 'Sin plan definido')     AS plan,
    pl.precio,
    COUNT(*)                                      AS cotizados,
    COUNT(*) FILTER (WHERE p.estado = 'ganado')   AS ganados,
    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto
FROM prospectos p
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
GROUP BY pl.nombre, pl.precio
ORDER BY 5 DESC;

DROP VIEW IF EXISTS v_reporte_sectores;
CREATE VIEW v_reporte_sectores WITH (security_invoker = true) AS
SELECT
    COALESCE(NULLIF(BTRIM(p.sector), ''), 'Sin sector') AS sector,
    COUNT(*)                                             AS prospectos,
    COUNT(*) FILTER (WHERE p.estado = 'ganado')          AS ganados,
    COUNT(*) FILTER (WHERE p.estado = 'perdido')         AS perdidos,
    CASE WHEN COUNT(*) FILTER (WHERE p.estado IN ('ganado','perdido')) = 0 THEN NULL
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE p.estado = 'ganado')
              / COUNT(*) FILTER (WHERE p.estado IN ('ganado','perdido')), 1)
    END AS tasa_cierre,
    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto
FROM prospectos p
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
GROUP BY 1
ORDER BY 3 DESC;


-- Nota sobre lo que NO quedó en este archivo:
--
-- La primera versión traía además una vista `v_ventas_por_mes` desglosada por
-- vendedor. Se sacó porque ninguna pantalla la consultaba —quedó superada por
-- `v_reporte_mensual` y `v_reporte_vendedores`— y porque además estaba rota: le
-- pedía `valor_mensual` a la tabla `prospectos`, donde esa columna no existe.
-- Es una columna calculada de la vista `v_prospectos`.
