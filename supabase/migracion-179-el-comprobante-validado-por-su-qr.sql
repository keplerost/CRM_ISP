-- =============================================================================
-- Migración 179 — Lo que el bot ya comprobó: el QR y la cuenta de destino
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué faltaba en el vocabulario ──
--
-- `metodo_verificacion` aceptaba tres valores: `bank_api` (lo confirmó el
-- banco), `human` (lo miró una persona) y `ocr_only` (se leyó la imagen).
--
-- Y el bot del CRM hace algo que no es ninguno de los tres. El comprobante del
-- Banco Pichincha trae un código QR con los datos de la transferencia; el bot lo
-- escanea y lo compara contra lo que dice el texto impreso. Si no coinciden, la
-- imagen fue editada — porque retocar el texto visible no cambia el QR.
--
-- Eso es bastante más que "leí la imagen", y bastante menos que "el banco me lo
-- confirmó". Meterlo en `ocr_only` subestima lo que se comprobó; meterlo en
-- `bank_api` afirma algo que no pasó. Seis meses después, cuando alguien
-- pregunte por qué se acreditó un cobro solo, la respuesta tiene que decir la
-- verdad de lo que se verificó.
--
-- ── Lo que `qr_validado` prueba, y lo que no ──
--
-- PRUEBA que el comprobante es auténtico y no fue retocado, y que el monto y la
-- fecha son los que el banco emitió.
--
-- NO prueba que esa plata haya entrado a la cuenta del ISP. Un comprobante
-- legítimo de una transferencia a otra persona valida su QR perfectamente. Por
-- eso el bot compara también la cuenta de destino, y por eso el `hash_qr` es
-- único en toda la base: el mismo comprobante no se puede usar dos veces, ni
-- por el mismo abonado ni por el vecino.
-- =============================================================================

DO $$
BEGIN
    ALTER TABLE pagos_reportados DROP CONSTRAINT IF EXISTS pagos_reportados_metodo_check;
    ALTER TABLE pagos_reportados ADD CONSTRAINT pagos_reportados_metodo_check
        CHECK (metodo_verificacion IS NULL
               OR metodo_verificacion IN ('bank_api', 'qr_validado', 'human', 'ocr_only'));
END $$;

COMMENT ON COLUMN pagos_reportados.metodo_verificacion IS
    'COMO se comprobo el pago. bank_api = lo confirmo el banco. qr_validado = el QR del comprobante coincide con su texto y con la cuenta destino. human = lo miro una persona. ocr_only = solo se leyo la imagen, NO alcanza para acreditar. Distinto de verificado_por, que es QUIEN lo verifico.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Con qué se verificó cada cobro que entró por el bot:
--   SELECT metodo_verificacion, estado, COUNT(*)
--     FROM pagos_reportados GROUP BY 1, 2 ORDER BY 1;


-- =============================================================================
-- 2. A qué cuenta dijo el bot que entró la plata
-- =============================================================================
-- ── Por qué no alcanza con fijarla en la llave ──
--
-- La 173 puso `cuenta_id` en `api_llaves`: una llave, una cuenta. Servía para un
-- webhook de pasarela, que siempre deposita en el mismo lado.
--
-- Con el bot no alcanza. El ISP tiene dos cuentas del Pichincha —corriente y
-- ahorros— y el abonado transfiere a cualquiera de las dos. El bot LEE del
-- comprobante a cuál fue; fijar una sola en la llave archivaría en corriente
-- todo lo que entró a ahorros, y la conciliación del mes siguiente no cerraría
-- por ninguno de los dos lados.
--
-- Así que la cuenta viaja con el pago. Se guarda ya resuelta —el middleware
-- traduce el número de cuenta del comprobante a la fila de `cuentas_pago`— para
-- que quien mire la bandeja vea el nombre y no un número suelto.
ALTER TABLE pagos_reportados
    ADD COLUMN IF NOT EXISTS cuenta_id UUID REFERENCES cuentas_pago(id) ON DELETE SET NULL;

COMMENT ON COLUMN pagos_reportados.cuenta_id IS
    'La cuenta a la que el bot leyo que entro la plata, ya resuelta. Manda sobre la cuenta fija de la llave: el abonado transfiere a la que quiere, no a la que la integracion supone.';


-- =============================================================================
-- 3. Confirmar, respetando la cuenta que informó el bot
-- =============================================================================
-- Tres niveles, y el orden importa:
--
--   1. La que elige quien confirma desde el panel. Está mirando el extracto y
--      puede haber descubierto que entró a otro lado.
--   2. La que informó el bot al registrarlo, leída del comprobante.
--   3. La fija de la llave, para las integraciones que siempre cobran igual.
CREATE OR REPLACE FUNCTION confirmar_pago_reportado(
    p_id         UUID,
    p_usuario    UUID DEFAULT NULL,
    p_cuenta_id  UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_r        pagos_reportados%ROWTYPE;
    v_cuenta   UUID;
    v_cobro    JSONB;
BEGIN
    SELECT * INTO v_r FROM pagos_reportados WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese pago reportado';
    END IF;

    IF v_r.estado = 'confirmado' THEN
        RAISE EXCEPTION 'Ese pago ya fue confirmado';
    END IF;
    IF v_r.estado = 'rechazado' THEN
        RAISE EXCEPTION 'Ese pago fue rechazado: %', COALESCE(v_r.motivo_rechazo, 'sin motivo');
    END IF;
    IF v_r.client_id IS NULL THEN
        RAISE EXCEPTION 'El reporte no tiene abonado asociado: no se puede aplicar';
    END IF;

    SELECT COALESCE(p_cuenta_id, v_r.cuenta_id, l.cuenta_id) INTO v_cuenta
      FROM api_llaves l WHERE l.id = v_r.llave_id;
    v_cuenta := COALESCE(v_cuenta, p_cuenta_id, v_r.cuenta_id);

    v_cobro := aplicar_cobro(
        p_client_id       => v_r.client_id,
        p_monto           => v_r.monto,
        p_forma_pago      => v_r.forma_pago,
        p_cuenta_id       => v_cuenta,
        p_n_transaccion   => v_r.n_transaccion,
        p_fecha_pago      => v_r.fecha_pago,
        p_notas           => CONCAT_WS(' · ',
                                'Reportado por ' || COALESCE(v_r.llave_nombre, 'sistema externo'),
                                NULLIF(v_r.banco_origen, ''),
                                NULLIF(v_r.depositante, ''),
                                CASE v_r.metodo_verificacion
                                    WHEN 'bank_api'    THEN 'confirmado por el banco'
                                    WHEN 'qr_validado' THEN 'QR del comprobante validado'
                                    WHEN 'human'       THEN 'verificado a mano'
                                    WHEN 'ocr_only'    THEN 'leído del comprobante'
                                    ELSE NULL
                                END,
                                NULLIF(v_r.notas, '')),
        p_comision        => 0,
        p_factura_id      => v_r.factura_id,
        p_facturar        => NULL,
        p_activo_servicio => FALSE,
        p_solo_servicio   => TRUE,
        p_created_by      => p_usuario
    );

    UPDATE pagos_reportados
       SET estado         = 'confirmado',
           pago_id        = (v_cobro->>'pago_id')::UUID,
           verificado_por = p_usuario,
           metodo_verificacion = COALESCE(
                                CASE WHEN p_usuario IS NOT NULL THEN 'human' END,
                                v_r.metodo_verificacion),
           verificado_at  = NOW()
     WHERE id = p_id;

    RETURN jsonb_build_object('reporte_id', p_id, 'cobro', v_cobro);
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- 4. La bandeja, mostrando a qué cuenta fue
-- =============================================================================
DROP VIEW IF EXISTS v_pagos_reportados;
CREATE VIEW v_pagos_reportados WITH (security_invoker = true) AS
SELECT
    r.id, r.client_id, r.cliente_nombre, r.identificacion,
    r.llave_id, r.llave_nombre,
    r.monto, r.forma_pago, r.n_transaccion, r.fecha_pago,
    r.referencia_externa, r.comprobante_url, r.notas, r.estado, r.pago_id,
    r.verificado_por, r.metodo_verificacion, r.verificado_at, r.motivo_rechazo,
    r.created_at, r.banco_origen, r.depositante, r.hash_qr, r.uuid_transaccion,
    r.origen, r.factura_id,
    r.cuenta_id,
    cu.nombre AS cuenta,
    c.estado AS estado_servicio,
    c.telefono_movil, c.codigo_pago, c.zona,
    COALESCE(d.saldo, 0) AS deuda_actual
FROM pagos_reportados r
LEFT JOIN clientes c      ON c.id = r.client_id
LEFT JOIN cuentas_pago cu ON cu.id = r.cuenta_id
LEFT JOIN LATERAL (
    SELECT SUM(f.saldo) AS saldo
      FROM v_facturas_por_cobrar f
     WHERE f.client_id = r.client_id
) d ON TRUE;
