-- =============================================================================
-- Migración 21 — Un número de transacción no se repite, y el saldo a favor se
--                arrastra al mes siguiente
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 20. Es idempotente.
--
-- Dos reglas del negocio que hasta ahora dependían de que nadie se equivocara:
--
-- 1. El número del comprobante del banco identifica una transferencia. Si se
--    registra dos veces, el mismo depósito queda cobrado a dos abonados —o dos
--    veces al mismo— y la conciliación bancaria no cierra nunca.
--
-- 2. Lo que el abonado pagó de más es plata suya. Si no se arrastra, el mes
--    siguiente se le cobra completo y hay que acordarse a mano de descontarlo.
-- =============================================================================

-- El efectivo no tiene número: esos quedan afuera del índice.
-- Un cobro anulado tampoco cuenta: si se anuló por un error de monto, hay que
-- poder volver a registrar la misma transferencia con el valor correcto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_transaccion_unica
    ON pagos (n_transaccion)
    WHERE n_transaccion IS NOT NULL AND n_transaccion <> '' AND NOT anulado;

COMMENT ON INDEX idx_pagos_transaccion_unica IS
    'Un comprobante del banco se registra una sola vez. No aplica a efectivo (sin número) ni a cobros anulados.';


-- =============================================================================
-- Excedentes: la plata que quedó a favor
-- =============================================================================
-- Un cobro que supera lo que la factura debía se parte: lo que cubre la factura
-- queda imputado, y el excedente queda como cobro sin factura. Así el saldo a
-- favor es siempre "lo que entró y todavía no se aplicó a nada", una sola
-- definición en vez de dos.
ALTER TABLE pagos
    ADD COLUMN IF NOT EXISTS es_excedente BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN pagos.es_excedente IS
    'Es el sobrante de otro cobro, no plata nueva. Se excluye de los totales de caja para no contarla dos veces.';


-- =============================================================================
-- Aplicar el saldo a favor a una factura
-- =============================================================================
-- Toma los cobros sin imputar del cliente, del más viejo al más nuevo, y los
-- aplica a la factura hasta cubrirla. Si un cobro entra completo se imputa tal
-- cual; si sobra, se parte: la parte que cabe queda en la factura y el resto
-- sigue disponible para la próxima.
CREATE OR REPLACE FUNCTION aplicar_saldo_a_favor(p_factura_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_factura   facturas%ROWTYPE;
    v_pendiente NUMERIC;
    v_aplicado  NUMERIC := 0;
    v_pago      pagos%ROWTYPE;
    v_usa       NUMERIC;
BEGIN
    SELECT * INTO v_factura FROM facturas WHERE id = p_factura_id;
    IF NOT FOUND OR v_factura.anulada THEN
        RETURN 0;
    END IF;

    v_pendiente := v_factura.total - COALESCE((
        SELECT SUM(monto) FROM pagos
         WHERE factura_id = p_factura_id AND NOT anulado
    ), 0);

    FOR v_pago IN
        SELECT * FROM pagos
         WHERE client_id = v_factura.client_id
           AND factura_id IS NULL
           AND NOT anulado
         ORDER BY fecha_pago, created_at
    LOOP
        EXIT WHEN v_pendiente <= 0.005;

        v_usa := LEAST(v_pago.monto, v_pendiente);

        IF v_usa >= v_pago.monto - 0.005 THEN
            -- El cobro entra entero: se imputa sin partirlo.
            UPDATE pagos SET factura_id = p_factura_id WHERE id = v_pago.id;
        ELSE
            -- Solo entra una parte: se parte en dos y el resto queda a favor.
            UPDATE pagos SET monto = v_usa, factura_id = p_factura_id WHERE id = v_pago.id;

            INSERT INTO pagos (
                client_id, cliente_nombre, cuenta_id, monto, comision, forma_pago,
                fecha_pago, notas, es_excedente
            )
            VALUES (
                v_pago.client_id, v_pago.cliente_nombre, v_pago.cuenta_id,
                v_pago.monto - v_usa, 0, v_pago.forma_pago, v_pago.fecha_pago,
                'Excedente del cobro N° ' || v_pago.numero || ': queda a favor del cliente',
                TRUE
            );
        END IF;

        v_aplicado  := v_aplicado + v_usa;
        v_pendiente := v_pendiente - v_usa;
    END LOOP;

    RETURN v_aplicado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION aplicar_saldo_a_favor IS
    'Imputa a la factura los cobros que el cliente tenía sin aplicar, del más viejo al más nuevo. Devuelve cuánto se aplicó.';
