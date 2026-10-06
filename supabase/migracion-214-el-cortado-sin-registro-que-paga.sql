-- =============================================================================
-- Migración 214 — El cortado sin registro que paga
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- La reconexión automática solo devolvía el servicio a quien cortó el propio
-- corte por mora: busca su registro en `firewall_bloqueos`. Un abonado que
-- figura "cortado" por otro camino —vino así del sistema anterior, o lo cortó
-- una promesa incumplida— no tiene ese registro. Pagaba, el pedido de
-- reconexión se cerraba con "Ya no correspondía", y quedaba cortado con la
-- factura saldada.
--
-- Esta vista los junta: cortados, sin ningún bloqueo activo registrado, con
-- router e IP, y que ya están en condiciones de volver con la MISMA regla que
-- el corte por mora (saldo cubierto, dentro de su fecha de corte, o con una
-- promesa vigente). El middleware los reactiva quitando su IP de la lista de
-- morosos del router.
-- =============================================================================

CREATE OR REPLACE VIEW v_cortados_sin_registro_a_reconectar AS
SELECT
    c.id     AS cliente_id,
    c.codigo,
    c.nombre,
    c.ip,
    c.router_id,
    COALESCE(s.saldo, 0) AS saldo
FROM clientes c
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.estado = 'cortado'
  AND c.router_id IS NOT NULL
  AND c.ip IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM firewall_bloqueos b WHERE b.cliente_id = c.id AND b.activo
  )
  AND (
      COALESCE(s.saldo, 0) <= 0
      OR dias_de_atraso(c.id) <= COALESCE(c.dias_gracia, 0)
      OR EXISTS (
          SELECT 1 FROM promesas_pago p
           WHERE p.client_id = c.id
             AND p.estado = 'activa'
             AND p.fecha_promesa >= CURRENT_DATE
      )
  );

COMMENT ON VIEW v_cortados_sin_registro_a_reconectar IS
    'Cortados que el corte por mora no registró (sistema anterior, promesa incumplida) y que ya pagaron: el middleware los reactiva.';

-- Solo la lee el middleware.
REVOKE ALL ON v_cortados_sin_registro_a_reconectar FROM anon, authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, ip, saldo FROM v_cortados_sin_registro_a_reconectar;
