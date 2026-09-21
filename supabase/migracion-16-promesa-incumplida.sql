-- =============================================================================
-- Migración 16 — Pagar de menos es incumplir la promesa
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 15. Es idempotente.
--
-- La 15 dejaba la promesa activa cuando el abonado pagaba menos de lo
-- prometido. Eso trababa la operación real: el índice admite una sola promesa
-- activa por cliente, así que no se le podía registrar el plazo nuevo que
-- acababa de pedir.
--
-- La regla queda así, y es la que describe lo que pasa en el mostrador:
--
--   * Paga todo lo que prometió  → CUMPLIDA.
--   * Paga una parte             → INCUMPLIDA. No cumplió, y el lugar queda
--                                  libre para anotar el plazo nuevo.
--
-- La promesa nueva se cierra igual cuando termine de pagar, antes o después de
-- su fecha: es el mismo disparador.
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

    UPDATE promesas_pago
       SET -- Medio centavo de tolerancia: el redondeo del IVA no puede dejar
           -- una promesa abierta por una diferencia que nadie va a cobrar.
           estado = CASE WHEN v_saldo <= 0.005 THEN 'cumplida' ELSE 'incumplida' END,
           pago_id = NEW.id
     WHERE id = v_promesa.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION pago_cierra_promesa IS
    'Al cobrar, cierra la promesa activa: cumplida si la deuda prometida quedó en cero, incumplida si pagó una parte. Así el cliente puede recibir un plazo nuevo.';


-- =============================================================================
-- A quién corresponde volver a cortar
-- =============================================================================
-- Con la regla nueva aparece un caso que antes no existía: el abonado que fue
-- habilitado por una promesa, pagó una parte y nadie le anotó un plazo nuevo.
-- Su promesa quedó incumplida, así que ya no figura como "activa vencida" y se
-- quedaría conectado sin que nadie lo note.
--
-- Se muestra una sola fila por cliente —la promesa más reciente—: la lista es
-- para decidir a quién cortar, no un historial.
CREATE OR REPLACE VIEW v_promesas_a_cortar WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.client_id) p.*
FROM v_promesas_pago p
LEFT JOIN v_saldo_clientes s ON s.client_id = p.client_id
WHERE p.activo_servicio
  AND p.estado_cliente = 'activo'
  AND COALESCE(s.saldo, 0) > 0
  AND ((p.estado = 'activa' AND p.vencida) OR p.estado = 'incumplida')
ORDER BY p.client_id, p.fecha_promesa DESC;

COMMENT ON VIEW v_promesas_a_cortar IS
    'Clientes habilitados por una promesa que vencieron sin pagar o pagaron de menos, siguen activos y deben. Es la lista de trabajo del corte.';
