-- =============================================================================
-- Migración 206 — El panel de facturación
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- El panel de inicio no decía cuántas facturas se crearon hoy, cuántos cobros
-- hubo ni cuántas facturas quedan sin pagar. Y el "cobrado hoy" que sí mostraba
-- se sumaba en el navegador sobre los ÚLTIMOS DOCE cobros: un día con quince
-- cobros mostraba menos plata de la que entró.
--
-- Esta función hace las cuentas en la base, sobre todo lo que corresponde, y
-- devuelve una sola fila. Sin el tope de mil filas de la API y sin bajar las
-- facturas de todos para mostrar cuatro números.
--
-- ── Las mismas reglas que las pantallas a las que enlaza ──
--
--   Facturas de hoy   facturas no anuladas con fecha de emisión hoy.
--   Cobros de hoy     `v_transacciones` sin anulados: la misma vista y el mismo
--                     filtro que la pantalla de Transacciones. Quien no
--                     consolida ve solo lo suyo, igual que ahí.
--   Sin pagar         `v_facturas_por_cobrar`: lo que define quién debe.
--   Vencidas          de esas, las que pasaron su vencimiento — la misma regla
--                     que `clientesConVencido` en el navegador.
--
-- `security invoker`: cada uno ve los números de lo que puede ver.
-- =============================================================================

CREATE OR REPLACE FUNCTION panel_facturacion(p_hoy DATE DEFAULT NULL)
RETURNS TABLE (
    facturas_hoy     INT,
    facturado_hoy    NUMERIC,
    cobros_hoy       INT,
    cobrado_hoy      NUMERIC,
    sin_pagar        INT,
    sin_pagar_monto  NUMERIC,
    vencidas         INT,
    vencidas_monto   NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    WITH d AS (
        -- La fecha del ISP, no la de UTC: a las 20:00 de Ecuador en UTC ya es mañana.
        SELECT COALESCE(p_hoy, (NOW() AT TIME ZONE zona_horaria())::date) AS hoy
    ),
    hoy_f AS (
        SELECT COUNT(*)::int AS n, COALESCE(SUM(f.total), 0) AS monto
          FROM facturas f, d
         WHERE NOT f.anulada AND f.fecha_emision = d.hoy
    ),
    hoy_p AS (
        SELECT COUNT(*)::int AS n, COALESCE(SUM(t.cobrado), 0) AS monto
          FROM v_transacciones t, d
         WHERE NOT t.anulado AND t.fecha_pago = d.hoy
    ),
    pend AS (
        SELECT COUNT(*)::int                                                   AS n,
               COALESCE(SUM(c.saldo), 0)                                       AS monto,
               (COUNT(*) FILTER (WHERE c.fecha_vencimiento < d.hoy))::int      AS n_venc,
               COALESCE(SUM(c.saldo) FILTER (WHERE c.fecha_vencimiento < d.hoy), 0) AS monto_venc
          FROM v_facturas_por_cobrar c, d
         GROUP BY d.hoy
    )
    SELECT hoy_f.n, hoy_f.monto,
           hoy_p.n, hoy_p.monto,
           COALESCE(pend.n, 0), COALESCE(pend.monto, 0),
           COALESCE(pend.n_venc, 0), COALESCE(pend.monto_venc, 0)
      FROM hoy_f
     CROSS JOIN hoy_p
      LEFT JOIN pend ON true
$$;

COMMENT ON FUNCTION panel_facturacion IS
    'Los números de facturación del panel: facturas y cobros de hoy, facturas sin pagar y vencidas.';

REVOKE ALL ON FUNCTION panel_facturacion(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION panel_facturacion(DATE) TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT * FROM panel_facturacion();
