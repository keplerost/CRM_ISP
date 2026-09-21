-- =============================================================================
-- Migración 19 — La vista de promesas toma la columna nueva
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 18. Es idempotente.
--
-- La 18 le agregó `factura_id` a `promesas_pago`, pero `v_promesas_pago` se
-- creó con `SELECT pr.*` y esa lista quedó congelada: la columna existe en la
-- tabla y no aparece en la vista.
--
-- `v_promesas_a_cortar` lee de ella, así que las dos se recrean juntas.
-- =============================================================================

DROP VIEW IF EXISTS v_promesas_a_cortar;
DROP VIEW IF EXISTS v_promesas_pago;

CREATE VIEW v_promesas_pago WITH (security_invoker = true) AS
SELECT
    pr.*,
    c.nombre AS cliente,
    c.identificacion,
    c.ip,
    c.estado AS estado_cliente,
    c.router_id,
    -- La factura que prometió pagar; el comprobante fiscal, si ya se emitió.
    LPAD(f.numero::TEXT, 8, '0') AS numero_factura,
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante,
    (pr.estado = 'activa' AND pr.fecha_promesa < CURRENT_DATE) AS vencida,
    pr.fecha_promesa - CURRENT_DATE AS dias_restantes
FROM promesas_pago pr
LEFT JOIN clientes c             ON c.id = pr.client_id
LEFT JOIN facturas f             ON f.id = pr.factura_id
LEFT JOIN electronic_documents d ON d.id = pr.document_id;

CREATE VIEW v_promesas_a_cortar WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.client_id) p.*
FROM v_promesas_pago p
LEFT JOIN v_saldo_clientes s ON s.client_id = p.client_id
WHERE p.activo_servicio
  AND p.estado_cliente = 'activo'
  AND COALESCE(s.saldo, 0) > 0
  AND ((p.estado = 'activa' AND p.vencida) OR p.estado = 'incumplida')
ORDER BY p.client_id, p.fecha_promesa DESC;

COMMENT ON VIEW v_promesas_a_cortar IS
    'Clientes habilitados por una promesa que vencieron sin pagar o pagaron de menos, siguen activos y deben.';
