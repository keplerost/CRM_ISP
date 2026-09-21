-- =============================================================================
-- Migración 77 — Comisión del vendedor
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- El tablero muestra "Comisión generada", y hasta ahora ese número no existía en
-- ningún lado. Antes que inventarlo en la pantalla —que sería mostrarle al
-- vendedor una plata que nadie le prometió— se guarda el porcentaje y se calcula.
--
-- ── Por qué un porcentaje y no una tabla de reglas ──
--
-- Se evaluó un esquema de comisiones por plan, por rango y por antigüedad. Se
-- descartó por ahora: no sabemos cómo comisiona este ISP, y adivinar un modelo
-- complejo produce una pantalla llena de campos que nadie llena. Un porcentaje
-- sobre la primera mensualidad es el caso más común y se entiende sin explicar.
--
-- Cuando haga falta más, la columna se reemplaza por la tabla y la vista cambia
-- en un solo lugar.
-- =============================================================================

ALTER TABLE config_cartera
    ADD COLUMN IF NOT EXISTS comision_porcentaje NUMERIC(5, 2) NOT NULL DEFAULT 0
        CHECK (comision_porcentaje >= 0 AND comision_porcentaje <= 100);

COMMENT ON COLUMN config_cartera.comision_porcentaje IS
    'Porcentaje sobre la primera mensualidad de cada alta. 0 = no se muestra comisión en el tablero.';

-- Se recrea la vista del equipo para que traiga la comisión ya calculada. Va
-- acá y no en el navegador para que el número sea el mismo en la pantalla del
-- vendedor, en la del supervisor y en cualquier reporte.
DROP VIEW IF EXISTS v_comercial_vendedor;
CREATE VIEW v_comercial_vendedor WITH (security_invoker = true) AS
SELECT
    u.id                                  AS vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', u.apellido)) AS vendedor,
    u.nombre                              AS nombre_pila,
    m.meta_altas,
    m.meta_monto,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS altas_mes,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ), 0) AS monto_mes,

    -- La comisión sale de lo vendido este mes. Si el porcentaje está en cero, da
    -- cero y la tarjeta se apaga sola en vez de mostrar un número inventado.
    ROUND(
        COALESCE(SUM(p.valor_mensual) FILTER (
            WHERE p.estado = 'ganado'
              AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
        ), 0) * (SELECT comision_porcentaje FROM config_cartera WHERE id = 1) / 100,
        2
    ) AS comision_mes,

    COUNT(p.id) FILTER (WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')
    ), 0) AS monto_en_juego,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'perdido'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS perdidos_mes,

    -- El mes pasado, para poder decir "+20% respecto del mes pasado". Sin esto
    -- la comparación de la tarjeta sería un número decorativo.
    COUNT(p.id) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW() - INTERVAL '1 month')
    ) AS altas_mes_pasado,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW() - INTERVAL '1 month')
    ), 0) AS monto_mes_pasado
FROM usuarios_sistema u
LEFT JOIN v_prospectos p ON p.vendedor_id = u.id
LEFT JOIN metas_venta  m ON m.vendedor_id = u.id
                        AND m.anio = EXTRACT(YEAR  FROM NOW())::SMALLINT
                        AND m.mes  = EXTRACT(MONTH FROM NOW())::SMALLINT
WHERE u.rol IN ('vendedor', 'supervisor_ventas', 'admin', 'super_admin')
GROUP BY u.id, u.nombre, u.apellido, m.meta_altas, m.meta_monto;


-- =============================================================================
-- La racha de días con venta
-- =============================================================================
-- El tablero muestra "llevás N días seguidos vendiendo". Se calcula acá porque
-- en el navegador exigiría traer todas las ventas del año para contar hacia
-- atrás.
CREATE OR REPLACE FUNCTION racha_de_ventas(p_vendedor UUID)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH dias AS (
        SELECT DISTINCT DATE(actualizado_en) AS dia
          FROM prospectos
         WHERE vendedor_id = p_vendedor AND estado = 'ganado'
           AND actualizado_en > NOW() - INTERVAL '60 days'
    ),
    -- El truco de siempre para rachas: a una serie de días consecutivos, restarle
    -- su número de orden da la misma fecha para todos. Agrupando por eso salen
    -- los tramos.
    tramos AS (
        SELECT dia, dia - (ROW_NUMBER() OVER (ORDER BY dia))::INT AS grupo FROM dias
    )
    SELECT COALESCE(
        (SELECT COUNT(*)::INT FROM tramos
          WHERE grupo = (SELECT grupo FROM tramos ORDER BY dia DESC LIMIT 1)
            -- Solo cuenta si el tramo llega hasta hoy o ayer: una racha que
            -- terminó la semana pasada no es una racha, es historia.
            AND (SELECT MAX(dia) FROM tramos) >= CURRENT_DATE - 1),
        0)
$$;
