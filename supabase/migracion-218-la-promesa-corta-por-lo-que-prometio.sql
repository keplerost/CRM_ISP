-- =============================================================================
-- Migración 218 — La promesa corta por lo que se prometió
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- `v_promesas_a_cortar` pedía que el abonado tuviera CUALQUIER saldo. Una
-- promesa incumplida queda así para siempre (pagar de menos la cierra como
-- incumplida y el resto del pago ya no la toca), así que en cuanto se emitía la
-- factura del mes siguiente —todavía sin vencer— el corte de promesas lo volvía
-- a cortar cada mañana, y la reconexión lo devolvía quince minutos después
-- porque no tenía nada vencido. Le pasó a tres abonados al día, desde el 01/11.
--
-- Ahora solo cuenta lo que sigue impago de lo prometido:
--
--   * Promesa con factura → el saldo de ESA factura.
--   * Promesa sin factura → lo emitido hasta el día en que se prometió.
--
-- El middleware aplica la misma regla por su cuenta (`saldoPrometido` en
-- cortesPromesas.js), así que el corte ya no se repite aunque esta migración
-- todavía no se haya corrido. Esta vista es la que muestra la simulación.
--
-- Las columnas no cambian: se reemplaza solo el filtro.
-- =============================================================================

CREATE OR REPLACE VIEW v_promesas_a_cortar WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.client_id) p.*
FROM v_promesas_pago p
WHERE p.activo_servicio
  AND p.estado_cliente = 'activo'
  AND ((p.estado = 'activa' AND p.vencida) OR p.estado = 'incumplida')
  AND (
      SELECT COALESCE(SUM(f.saldo), 0)
        FROM v_facturas_por_cobrar f
       WHERE CASE
               WHEN p.factura_id IS NOT NULL THEN f.id = p.factura_id
               ELSE f.client_id = p.client_id
                AND f.fecha_emision <= (p.created_at AT TIME ZONE zona_horaria())::date
             END
  ) > 0.005
ORDER BY p.client_id, p.fecha_promesa DESC;

COMMENT ON VIEW v_promesas_a_cortar IS
    'Clientes habilitados por una promesa vencida o incumplida, que siguen activos y deben TODAVÍA lo prometido (la factura de la promesa, o lo emitido hasta el día en que se prometió).';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT cliente, fecha_promesa, estado, numero_factura FROM v_promesas_a_cortar;
--   -- No deberían aparecer quienes ya pagaron la factura que habían prometido.
