-- =============================================================================
-- Migración 15 — La promesa se cierra sola cuando el abonado paga
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 13. Es idempotente.
--
-- Hasta ahora el cierre de la promesa vivía en el formulario de cobro. Eso deja
-- dos agujeros:
--
--   1. Un cobro registrado desde otro lado —una importación, un script, otra
--      pantalla que se agregue mañana— dejaba la promesa activa para siempre, y
--      el corte automático terminaba cortando a alguien que ya había pagado.
--
--   2. Cerraba con CUALQUIER pago. Si el abonado prometió $34.50 y trajo $10,
--      la promesa quedaba "cumplida" sin haberse cumplido.
--
-- La regla correcta es sobre la deuda, no sobre el hecho de pagar:
--
--   * Si la promesa es por una factura concreta, se cumple cuando ESA factura
--     queda en cero.
--   * Si no apunta a ninguna, se cumple cuando el cliente no debe nada.
-- =============================================================================

CREATE OR REPLACE FUNCTION pago_cierra_promesa()
RETURNS TRIGGER AS $$
DECLARE
    v_promesa promesas_pago%ROWTYPE;
    v_saldo   NUMERIC;
BEGIN
    -- Un cobro anulado no cancela nada.
    IF NEW.anulado THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_promesa
      FROM promesas_pago
     WHERE client_id = NEW.client_id
       AND estado = 'activa'
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF v_promesa.document_id IS NOT NULL THEN
        -- Prometió pagar una factura puntual: manda el saldo de esa factura.
        SELECT COALESCE(SUM(saldo), 0) INTO v_saldo
          FROM v_facturas_por_cobrar
         WHERE id = v_promesa.document_id;
    ELSE
        SELECT COALESCE(SUM(saldo), 0) INTO v_saldo
          FROM v_facturas_por_cobrar
         WHERE client_id = NEW.client_id;
    END IF;

    -- Medio centavo de tolerancia: el redondeo del IVA no puede dejar una
    -- promesa abierta por una diferencia que nadie va a cobrar.
    IF v_saldo <= 0.005 THEN
        UPDATE promesas_pago
           SET estado = 'cumplida',
               pago_id = NEW.id
         WHERE id = v_promesa.id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION pago_cierra_promesa IS
    'Cierra la promesa activa del cliente cuando el cobro deja en cero la deuda que prometió pagar.';

DROP TRIGGER IF EXISTS trg_pago_cierra_promesa ON pagos;
CREATE TRIGGER trg_pago_cierra_promesa
    AFTER INSERT OR UPDATE OF monto, anulado, document_id ON pagos
    FOR EACH ROW EXECUTE FUNCTION pago_cierra_promesa();


-- =============================================================================
-- Cerrar las que ya quedaron colgadas
-- =============================================================================
-- Promesas activas cuya deuda ya está saldada: se cierran con la misma regla.
UPDATE promesas_pago pr
   SET estado = 'cumplida'
 WHERE pr.estado = 'activa'
   AND COALESCE((
       SELECT SUM(f.saldo)
         FROM v_facturas_por_cobrar f
        WHERE (pr.document_id IS NOT NULL AND f.id = pr.document_id)
           OR (pr.document_id IS NULL AND f.client_id = pr.client_id)
   ), 0) <= 0.005;
