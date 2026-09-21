-- =============================================================================
-- Migración 135 — Avisar el corte, y avisar el pago
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Los dos huecos que cierra ──
--
-- EL CORTE ES EN SILENCIO. El corte por mora deja al abonado sin internet y no
-- le dice nada: se entera cuando abre el navegador, si es que la página lo
-- alcanza. La plantilla del aviso existe desde la 126 y no la manda nadie. Es el
-- mensaje que más llamadas evita, porque llega con la explicación y con el
-- número de cuenta.
--
-- EL PAGO TAMPOCO SE AVISA. Se cobra y el abonado no recibe nada. La llamada de
-- "¿les llegó mi pago?" es de las más frecuentes en cualquier ISP, y es
-- enteramente evitable con dos líneas de texto.
--
-- ── Por qué el aviso de pago necesita una cola y el de corte no ──
--
-- Porque el corte lo hace el middleware: sabe a quién cortó y puede avisarle en
-- el mismo momento.
--
-- El pago, en cambio, se registra desde el navegador directo contra la base. Es
-- el mismo problema que resolvió la 134 con la reconexión, y se resuelve igual:
-- un disparador encola y el middleware atiende. Pedirle a cada pantalla de cobro
-- que además mande el mensaje sería pedirle a alguna que se olvide.
-- =============================================================================

/**
 * La cola de avisos que dispara la base.
 *
 * ── Por qué es otra tabla y no `reconexiones_pendientes` ──
 *
 * Porque son cosas distintas con reglas distintas. La reconexión solo aplica a
 * quien está cortado y admite un pedido abierto por abonado; el aviso de pago va
 * a todos y admite uno por PAGO —dos pagos el mismo día son dos avisos, porque
 * son dos comprobantes que el abonado quiere ver reconocidos—.
 *
 * Meterlas juntas obligaría a que cada regla preguntara por el tipo antes de
 * hacer cualquier cosa.
 */
CREATE TABLE IF NOT EXISTS avisos_pendientes (
    id         BIGSERIAL PRIMARY KEY,
    cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    -- Qué avisar. La clave de la plantilla se deduce de esto.
    tipo       VARCHAR(30) NOT NULL,

    -- A qué se refiere: el pago, la factura. Sirve para armar el mensaje y para
    -- no mandar dos veces lo mismo.
    referencia_id UUID,

    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    procesado_en TIMESTAMPTZ,
    error        TEXT,
    intentos     INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_avisos_pendientes
    ON avisos_pendientes (creado_en) WHERE procesado_en IS NULL;

-- El mismo aviso sobre la misma cosa, una sola vez. Protege de un disparador
-- que se ejecute dos veces y del reintento que llega tarde.
CREATE UNIQUE INDEX IF NOT EXISTS idx_avisos_sin_repetir
    ON avisos_pendientes (tipo, referencia_id) WHERE referencia_id IS NOT NULL;

ALTER TABLE avisos_pendientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_avisos_pendientes" ON avisos_pendientes;
CREATE POLICY "auth_all_avisos_pendientes" ON avisos_pendientes
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


/**
 * Al registrar un pago, encolar su confirmación.
 *
 * ── Por qué se encola a TODOS y no solo al que estaba cortado ──
 *
 * Porque este aviso no tiene que ver con el corte: es el acuse de recibo del
 * dinero. El abonado al día que paga por transferencia y no recibe nada llama
 * igual —o peor, vuelve a pagar—.
 *
 * El que pidió no recibir avisos queda afuera, pero eso lo decide quien procesa
 * la cola, no este disparador: la ficha puede cambiar entre el pago y el envío,
 * y la decisión tiene que tomarse con lo que valga en el momento de mandar.
 */
CREATE OR REPLACE FUNCTION avisar_pago_recibido()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.anulado OR NEW.client_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO avisos_pendientes (cliente_id, tipo, referencia_id)
    VALUES (NEW.client_id, 'pago_confirmado', NEW.id)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_avisar_pago ON pagos;
CREATE TRIGGER trg_avisar_pago
    AFTER INSERT ON pagos
    FOR EACH ROW EXECUTE FUNCTION avisar_pago_recibido();


-- =============================================================================
-- Lo que el middleware atiende
-- =============================================================================
/**
 * Los avisos por mandar, con lo que hace falta para armarlos.
 *
 * El monto y la fecha del pago vienen acá porque la plantilla los usa y no viven
 * en la ficha del abonado: viven en el pago que acaba de ocurrir.
 */
DO $guarda$
BEGIN
    -- La 137 le agrega los datos del ticket y del plan. Reejecutar esto se los
    -- llevaria, y no falla limpio: aborta con "cannot drop columns from view".
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_avisos_a_enviar'
           AND column_name = 'ticket'
    ) THEN
        RAISE NOTICE 'v_avisos_a_enviar ya tiene una version posterior a la 135: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_avisos_a_enviar AS
SELECT
    a.id            AS aviso_id,
    a.tipo,
    a.creado_en,
    a.intentos,
    c.id            AS cliente_id,
    c.nombre,
    c.avisos_activos,
    c.avisos_canales,
    c.canal_preferido,
    c.email,
    c.telefono_movil,
    c.telefono,
    c.telegram_chat_id,
    p.id            AS pago_id,
    p.monto,
    p.fecha_pago,
    p.forma_pago,
    COALESCE(s.saldo, 0) AS saldo
FROM avisos_pendientes a
JOIN clientes c ON c.id = a.cliente_id
LEFT JOIN pagos p ON p.id = a.referencia_id AND NOT p.anulado
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE a.procesado_en IS NULL
  AND c.estado <> 'baja'
  -- Un pago anulado entre el disparo y el envío no se confirma: sería avisarle
  -- de plata que ya no está.
  AND (a.tipo <> 'pago_confirmado' OR p.id IS NOT NULL)
ORDER BY a.creado_en
    $vista$;
END $guarda$;

COMMENT ON VIEW v_avisos_a_enviar IS
    'Cola de avisos por mandar, con el monto y la fecha del pago que la plantilla necesita.';


-- =============================================================================
-- La plantilla del corte que faltaba
-- =============================================================================
-- Existía la corta para SMS y WhatsApp, no la de correo. Sin ella, al abonado
-- que solo tiene correo se le corta el servicio sin decirle nada.
INSERT INTO plantillas_mensaje
    (clave, categoria, canal, formato, del_sistema, nombre, descripcion, asunto, cuerpo, variables)
VALUES
('mail_corte_servicio', 'correo', 'email', 'html', TRUE,
 'Corte de servicio',
 'Se manda en el momento del corte. Tiene que decir cómo reactivar, no solo que se cortó: es el mensaje que más llamadas evita.',
 'Su servicio fue suspendido',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Su servicio de internet fue suspendido por un saldo pendiente de {{saldo}}.</p>\n<p>Apenas registremos su pago, el servicio se reactiva automáticamente en pocos minutos.</p>\n<p>Cualquier consulta, escríbanos al {{telefono}}.</p>',
 ARRAY['nombre','saldo','telefono','plan'])
ON CONFLICT (clave) WHERE clave IS NOT NULL DO NOTHING;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Registrar un pago y ver el aviso encolado:
--   SELECT tipo, nombre, monto, saldo FROM v_avisos_a_enviar;
--
--   -- Los que ya salieron:
--   SELECT tipo, COUNT(*) FROM avisos_pendientes
--    WHERE procesado_en IS NOT NULL GROUP BY tipo;
