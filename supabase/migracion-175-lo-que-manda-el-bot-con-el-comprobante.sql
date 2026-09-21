-- =============================================================================
-- Migración 175 — Lo que el bot manda junto con el comprobante
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué faltaba ──
--
-- La 173 dejó `pagos_reportados` pensada para un pago que alguien declara por
-- chat: monto, fecha, número de comprobante. Lo que el CRM manda de verdad es
-- bastante más, y todo lo demás se estaba descartando en silencio:
--
--   banco_origen        de qué banco salió la transferencia
--   depositante         a nombre de quién la hicieron
--   hash_qr             la huella del QR del comprobante
--   uuid_transaccion    el identificador que da el banco
--   metodo_verificacion cómo se comprobó: contra el banco, por OCR, o a mano
--   origen              qué canal lo reportó
--   factura_id          contra qué factura se está pagando
--
-- Perder los tres primeros no es un detalle de prolijidad: son exactamente lo
-- que mira quien verifica el pago contra el extracto. Un reporte que solo dice
-- "$20, comprobante 92947292" obliga a buscar a ciegas; uno que dice "Banco
-- Pichincha, depositante JOSE PEREZ" se cruza en diez segundos.
--
-- ── Y `hash_qr` es mejor idempotencia que la que teníamos ──
--
-- La 173 deduplica por `referencia_externa`, que es una clave que el CRM tiene
-- que acordarse de mandar. El hash del QR no hay que acordarse de nada: es la
-- huella de la imagen del comprobante, y dos reportes del mismo comprobante la
-- comparten aunque vengan de dos conversaciones distintas y de dos días
-- distintos. Es también lo que atrapa al abonado que reenvía el comprobante de
-- su vecino.
-- =============================================================================


-- =============================================================================
-- 1. La evidencia del comprobante
-- =============================================================================
ALTER TABLE pagos_reportados
    ADD COLUMN IF NOT EXISTS banco_origen     VARCHAR(80),
    ADD COLUMN IF NOT EXISTS depositante      VARCHAR(150),
    ADD COLUMN IF NOT EXISTS hash_qr          VARCHAR(128),
    ADD COLUMN IF NOT EXISTS uuid_transaccion VARCHAR(80),

    -- Contra qué factura se está pagando, si el bot lo supo. `aplicar_cobro` la
    -- salda primero y reparte el resto por antigüedad: es la misma regla de la
    -- ventanilla, donde el cobrador tiene una factura en pantalla.
    ADD COLUMN IF NOT EXISTS factura_id       UUID REFERENCES facturas(id) ON DELETE SET NULL,

    /**
     * Cómo se comprobó que la plata entró.
     *
     *   bank_api  lo confirmó el banco. Es un hecho.
     *   human     lo aprobó una persona del ISP mirando el extracto.
     *   ocr_only  se leyó la imagen del comprobante. NO es una confirmación:
     *             una captura se edita en treinta segundos.
     *
     * ── Por qué NO se llama `verificado_por`, que es como lo manda el CRM ──
     *
     * Porque esa columna ya existe desde la 173 y es un UUID: guarda QUIÉN lo
     * verificó, la persona. Esto es CÓMO se verificó, que es otra pregunta.
     * Reusar el nombre no solo confunde —hace fallar la migración con
     * "invalid input syntax for type uuid: bank_api", que es exactamente lo que
     * pasó la primera vez que se corrió esto—.
     *
     * El campo de la API sigue llamándose `verificado_por`: el contrato con el
     * CRM no cambia, la traducción se hace del lado del middleware.
     *
     * Esto NO le da permiso a nadie: la llave sigue fijando el techo de
     * confianza (`api_llaves.confirma_pagos`) y este campo solo puede BAJARLO.
     * Si pudiera subirlo, alcanzaría con que el sistema externo mandara
     * "human" para saltarse la verificación — y entonces la verificación no
     * existiría.
     */
    ADD COLUMN IF NOT EXISTS metodo_verificacion VARCHAR(20),

    -- Qué canal lo reportó: BOT_WHATSAPP, PANEL_CRM, WEBHOOK_PASARELA…
    ADD COLUMN IF NOT EXISTS origen           VARCHAR(30);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagos_reportados_metodo_check') THEN
        ALTER TABLE pagos_reportados ADD CONSTRAINT pagos_reportados_metodo_check
            CHECK (metodo_verificacion IS NULL
                   OR metodo_verificacion IN ('bank_api', 'ocr_only', 'human'));
    END IF;
END $$;

COMMENT ON COLUMN pagos_reportados.metodo_verificacion IS
    'COMO se comprobo el pago (bank_api, human, ocr_only). Distinto de verificado_por, que es QUIEN lo verifico. Solo puede BAJAR la confianza que da la llave, nunca subirla: ocr_only siempre queda pendiente aunque la llave acredite sola.';
COMMENT ON COLUMN pagos_reportados.hash_qr IS
    'Huella del QR del comprobante. Es la clave de deduplicacion mas fuerte que hay: la misma imagen la comparte aunque venga de dos conversaciones distintas.';


-- =============================================================================
-- 2. El mismo comprobante, una sola vez
-- =============================================================================
-- ── Por qué estos índices son globales y no por llave ──
--
-- `referencia_externa` se deduplica por llave (migración 173) porque es una
-- clave interna del CRM: dos sistemas distintos pueden usar el número "1024"
-- para cosas distintas.
--
-- El hash de un QR y el UUID que da el banco NO son eso: identifican a una
-- transferencia del mundo real. El mismo comprobante reportado por el bot y por
-- el panel del CRM es el mismo pago, y tiene que chocar.
--
-- Se excluyen los rechazados a propósito: si cobranza rechazó un comprobante
-- por ilegible y el abonado manda una foto mejor del mismo pago, el segundo
-- reporte tiene que poder entrar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_reportados_hash_qr
    ON pagos_reportados (hash_qr)
    WHERE hash_qr IS NOT NULL AND estado <> 'rechazado';

CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_reportados_uuid_tx
    ON pagos_reportados (uuid_transaccion)
    WHERE uuid_transaccion IS NOT NULL AND estado <> 'rechazado';


-- =============================================================================
-- 3. Confirmar, ahora respetando la factura que eligió el bot
-- =============================================================================
-- Es la misma función de la 173 con dos cambios:
--
--   * pasa `factura_id` a `aplicar_cobro`, para que salde primero la factura
--     contra la que el abonado dijo estar pagando;
--   * escribe en las notas del cobro de dónde salió y cómo se verificó, que es
--     lo que se lee seis meses después cuando alguien cuestiona el pago.
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

    SELECT COALESCE(p_cuenta_id, l.cuenta_id) INTO v_cuenta
      FROM api_llaves l WHERE l.id = v_r.llave_id;
    v_cuenta := COALESCE(v_cuenta, p_cuenta_id);

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
                                    WHEN 'bank_api' THEN 'confirmado por el banco'
                                    WHEN 'human'    THEN 'verificado a mano'
                                    WHEN 'ocr_only' THEN 'leído del comprobante'
                                    ELSE NULL
                                END,
                                NULLIF(v_r.notas, '')),
        p_comision        => 0,
        -- La factura que el abonado dijo estar pagando va primero; el resto se
        -- reparte por antigüedad. Sin esto, un abonado que paga expresamente la
        -- factura del mes ve saldarse la del mes pasado y vuelve a escribir.
        p_factura_id      => v_r.factura_id,
        p_facturar        => NULL,
        p_activo_servicio => FALSE,
        p_solo_servicio   => TRUE,
        p_created_by      => p_usuario
    );

    UPDATE pagos_reportados
       SET estado         = 'confirmado',
           pago_id        = (v_cobro->>'pago_id')::UUID,
           -- QUIÉN lo confirmó. Nulo cuando lo acreditó una llave sola.
           verificado_por = p_usuario,
           -- Y CÓMO. Si lo miró una persona desde el panel, eso es lo que pasó,
           -- sin importar cómo haya llegado el reporte.
           metodo_verificacion = COALESCE(
                                CASE WHEN p_usuario IS NOT NULL THEN 'human' END,
                                v_r.metodo_verificacion),
           verificado_at  = NOW()
     WHERE id = p_id;

    RETURN jsonb_build_object('reporte_id', p_id, 'cobro', v_cobro);
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- 4. La bandeja, con la evidencia a la vista
-- =============================================================================
-- Quien verifica necesita el banco y el depositante en la MISMA fila que el
-- monto: son las tres cosas que se cruzan contra el extracto. Tenerlas a un
-- clic de distancia hace que se verifique de a uno; tenerlas juntas hace que se
-- verifique la pantalla entera de una pasada.
DROP VIEW IF EXISTS v_pagos_reportados;
CREATE VIEW v_pagos_reportados WITH (security_invoker = true) AS
SELECT
    r.id,
    r.client_id,
    r.cliente_nombre,
    r.identificacion,
    r.llave_id,
    r.llave_nombre,
    r.monto,
    r.forma_pago,
    r.n_transaccion,
    r.fecha_pago,
    r.referencia_externa,
    r.comprobante_url,
    r.notas,
    r.estado,
    r.pago_id,
    r.verificado_por,
    r.metodo_verificacion,
    r.verificado_at,
    r.motivo_rechazo,
    r.created_at,
    r.banco_origen,
    r.depositante,
    r.hash_qr,
    r.uuid_transaccion,
    r.origen,
    r.factura_id,
    c.estado AS estado_servicio,
    c.telefono_movil,
    c.codigo_pago,
    c.zona,
    COALESCE(d.saldo, 0) AS deuda_actual
FROM pagos_reportados r
LEFT JOIN clientes c ON c.id = r.client_id
LEFT JOIN LATERAL (
    SELECT SUM(f.saldo) AS saldo
      FROM v_facturas_por_cobrar f
     WHERE f.client_id = r.client_id
) d ON TRUE;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Lo que hay para verificar, con la evidencia al lado:
--   SELECT cliente_nombre, monto, deuda_actual, banco_origen, depositante,
--          metodo_verificacion
--     FROM v_pagos_reportados WHERE estado = 'pendiente';
--
--   -- El mismo comprobante dos veces tiene que fallar:
--   INSERT INTO pagos_reportados (monto, hash_qr) VALUES (10, 'abc');
--   INSERT INTO pagos_reportados (monto, hash_qr) VALUES (10, 'abc');  -- 23505
