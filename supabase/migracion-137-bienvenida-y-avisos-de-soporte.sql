-- =============================================================================
-- Migración 137 — La bienvenida y los avisos de soporte
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué se engancha ──
--
-- La bienvenida al abonado nuevo y los tres avisos de un reporte de soporte:
-- que se recibió, que se le asignó un técnico, y la respuesta.
--
-- Los tres de soporte comparten un porqué: el abonado que reporta una falla se
-- queda sin saber si alguien lo leyó. Esa incertidumbre es la que produce la
-- segunda llamada, y la tercera. Un mensaje con el número de reporte la corta.
--
-- ── La trampa de la bienvenida ──
--
-- Lo natural sería mandarla cuando el abonado pasa a activo. Pero al migrar un
-- padrón, quinientos abonados pasan a activo el mismo día — y quinientas
-- personas que llevan años con el servicio recibirían "bienvenido, tu servicio
-- ya está activo". Es la clase de error que se descubre por los mensajes de
-- vuelta.
--
-- Por eso el disparador deja afuera a los importados: `sistema_origen` dice de
-- dónde vino cada uno.
-- =============================================================================

-- =============================================================================
-- La bienvenida
-- =============================================================================
/**
 * Se dispara cuando se sella la activación, que es el momento real del alta.
 *
 * `activado_en` lo pone el disparador de la 70 la primera vez que el abonado
 * pasa a activo, y no se edita después. Es el instante exacto en que empezó a
 * tener servicio — mejor que `created_at`, que es cuando alguien cargó la ficha,
 * y mejor que el estado, que va y viene con los cortes.
 */
CREATE OR REPLACE FUNCTION avisar_bienvenida()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Solo cuando se sella por primera vez.
    IF NEW.activado_en IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.activado_en IS NOT NULL THEN RETURN NEW; END IF;

    /**
     * Al abonado migrado no se le da la bienvenida.
     *
     * Lleva años con el servicio: decirle "bienvenido" el día que cambiamos de
     * sistema lo confundiría, y a quinientos a la vez sería una avalancha de
     * respuestas preguntando qué pasó.
     */
    IF NEW.sistema_origen IS NOT NULL THEN RETURN NEW; END IF;

    INSERT INTO avisos_pendientes (cliente_id, tipo, referencia_id)
    VALUES (NEW.id, 'bienvenida', NEW.id)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_avisar_bienvenida ON clientes;
CREATE TRIGGER trg_avisar_bienvenida
    AFTER INSERT OR UPDATE OF activado_en ON clientes
    FOR EACH ROW EXECUTE FUNCTION avisar_bienvenida();


-- =============================================================================
-- Los tres de soporte
-- =============================================================================
/**
 * El reporte recibido, y el técnico asignado.
 *
 * Van en el mismo disparador porque son el mismo hecho visto dos veces: el
 * abonado quiere saber que lo leyeron y después que alguien va a ir. Separarlos
 * en dos funciones obligaría a repetir la comprobación de que el ticket tenga
 * abonado —los hay de gente que todavía no es cliente—.
 */
CREATE OR REPLACE FUNCTION avisar_del_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Un reporte de alguien que todavía no es abonado no tiene a dónde avisarle
    -- por los canales de la ficha.
    IF NEW.client_id IS NULL THEN RETURN NEW; END IF;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO avisos_pendientes (cliente_id, tipo, referencia_id)
        VALUES (NEW.client_id, 'ticket_abierto', NEW.id)
        ON CONFLICT DO NOTHING;
        RETURN NEW;
    END IF;

    -- Recién cuando se le pone técnico. Reasignarlo a otro también avisa: para
    -- el abonado cambió quién lo va a visitar.
    IF NEW.tecnico_id IS NOT NULL AND NEW.tecnico_id IS DISTINCT FROM OLD.tecnico_id THEN
        INSERT INTO avisos_pendientes (cliente_id, tipo, referencia_id)
        VALUES (NEW.client_id, 'ticket_asignado', NEW.id)
        -- La referencia es el ticket, así que reasignar dos veces avisa una.
        -- Es lo correcto: al abonado le importa que alguien vaya, no cuántas
        -- veces lo movimos de técnico.
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_avisar_ticket ON tickets;
CREATE TRIGGER trg_avisar_ticket
    AFTER INSERT OR UPDATE OF tecnico_id ON tickets
    FOR EACH ROW EXECUTE FUNCTION avisar_del_ticket();


/**
 * La respuesta al abonado.
 *
 * Sale de `ticket_eventos`, que es donde queda escrito lo que se hizo. Solo los
 * que tienen nota: un cambio de estado sin texto no es una respuesta, y mandarlo
 * como si lo fuera sería avisarle de un mensaje vacío.
 */
CREATE OR REPLACE FUNCTION avisar_respuesta_de_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cliente UUID;
BEGIN
    IF NEW.nota IS NULL OR TRIM(NEW.nota) = '' THEN RETURN NEW; END IF;

    /**
     * El evento de APERTURA no es una respuesta.
     *
     * Al crear un ticket, la base registra sola un evento con la nota "Ticket
     * creado" —el rastro lo deja la base y no la pantalla, para que un cambio
     * hecho desde un script también quede—. Ese evento tiene nota, así que sin
     * esta condición el abonado recibiría DOS mensajes por lo mismo: "recibimos
     * su reporte" y, un segundo después, "sobre su reporte: Ticket creado".
     *
     * Se reconoce porque es el único sin estado anterior.
     */
    IF NEW.estado_anterior IS NULL THEN RETURN NEW; END IF;

    SELECT client_id INTO v_cliente FROM tickets WHERE id = NEW.ticket_id;
    IF v_cliente IS NULL THEN RETURN NEW; END IF;

    -- La referencia es el EVENTO y no el ticket: cada respuesta es un mensaje
    -- distinto y el abonado quiere leerlas todas.
    INSERT INTO avisos_pendientes (cliente_id, tipo, referencia_id)
    VALUES (v_cliente, 'ticket_respuesta', NEW.id)
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_avisar_respuesta_ticket ON ticket_eventos;
CREATE TRIGGER trg_avisar_respuesta_ticket
    AFTER INSERT ON ticket_eventos
    FOR EACH ROW EXECUTE FUNCTION avisar_respuesta_de_ticket();


-- =============================================================================
-- Lo que el middleware necesita para armar cada mensaje
-- =============================================================================
/**
 * Se agregan columnas AL FINAL de `v_avisos_a_enviar`.
 *
 * Los datos del ticket no viven en la ficha del abonado ni en el pago: el número
 * de reporte, el motivo, el técnico asignado y la respuesta están en otras
 * tablas, y la plantilla los usa.
 *
 * ── La guarda ──
 *
 * La 156 le agrega la factura del pago y el número de cuenta del abonado, que es
 * lo que necesita la tarjeta del acuse. Reejecutar esto se los llevaría, y no
 * falla limpio: aborta con "cannot drop columns from view".
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_avisos_a_enviar'
           AND column_name = 'factura_numero'
    ) THEN
        RAISE NOTICE 'v_avisos_a_enviar ya tiene una version posterior a la 137: no se toca.';
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
    COALESCE(s.saldo, 0) AS saldo,
    -- Lo de esta migración, al final para no mover nada de lugar.
    c.plan_id,
    pl.nombre       AS plan,
    c.dia_facturacion AS dia_pago,
    t.numero        AS ticket,
    t.tipo_incidencia AS motivo,
    tec.nombre      AS tecnico,
    t.fecha_visita,
    ev.nota         AS respuesta
FROM avisos_pendientes a
JOIN clientes c ON c.id = a.cliente_id
LEFT JOIN pagos p ON p.id = a.referencia_id AND NOT p.anulado
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
LEFT JOIN planes_velocidad pl ON pl.id = c.plan_id
-- El ticket, por su id o por el del evento que lo respondió.
LEFT JOIN ticket_eventos ev ON ev.id = a.referencia_id AND a.tipo = 'ticket_respuesta'
LEFT JOIN tickets t
       ON t.id = COALESCE(ev.ticket_id, a.referencia_id)
      AND a.tipo IN ('ticket_abierto', 'ticket_asignado', 'ticket_respuesta')
LEFT JOIN tecnicos tec ON tec.id = t.tecnico_id
WHERE a.procesado_en IS NULL
  AND c.estado <> 'baja'
  AND (a.tipo <> 'pago_confirmado' OR p.id IS NOT NULL)
  -- Un aviso de ticket cuyo reporte se borró no tiene nada que decir.
  AND (a.tipo NOT IN ('ticket_abierto', 'ticket_asignado', 'ticket_respuesta') OR t.id IS NOT NULL)
ORDER BY a.creado_en
$vista$;
END $guarda$;


-- =============================================================================
-- Las plantillas cortas que faltaban
-- =============================================================================
-- Los tres de soporte solo tenían versión de correo. El abonado que reporta una
-- falla suele hacerlo desde el teléfono y espera la respuesta ahí.
INSERT INTO plantillas_mensaje
    (clave, categoria, canal, formato, del_sistema, nombre, descripcion, asunto, cuerpo, variables)
VALUES
('sms_ticket_abierto', 'sms', 'whatsapp', 'texto', TRUE,
 'Ticket de soporte',
 'Confirma que se recibió el reporte y le da al abonado un número para seguirlo.',
 NULL,
 '{{empresa}}: recibimos su reporte N° {{ticket}}. Le avisamos apenas tengamos novedades.',
 ARRAY['empresa','ticket','motivo']),

('sms_ticket_asignado', 'sms', 'whatsapp', 'texto', TRUE,
 'Ticket asignado',
 'Le avisa que su reporte ya tiene técnico y cuándo lo visitan.',
 NULL,
 '{{empresa}}: su reporte N° {{ticket}} fue asignado a {{tecnico}}. Visita: {{fecha_visita}}',
 ARRAY['empresa','ticket','tecnico','fecha_visita']),

('sms_ticket_respuesta', 'sms', 'whatsapp', 'texto', TRUE,
 'Respuesta a ticket de soporte',
 'La respuesta al abonado sobre un reporte abierto.',
 NULL,
 '{{empresa}} · reporte {{ticket}}: {{respuesta}}',
 ARRAY['empresa','ticket','respuesta'])

ON CONFLICT (clave) WHERE clave IS NOT NULL DO NOTHING;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Lo que hay por avisar, con el dato de cada uno:
--   SELECT tipo, nombre, ticket, tecnico, plan FROM v_avisos_a_enviar;
--
--   -- Y que un abonado migrado NO reciba la bienvenida:
--   SELECT COUNT(*) FROM avisos_pendientes a
--     JOIN clientes c ON c.id = a.cliente_id
--    WHERE a.tipo = 'bienvenida' AND c.sistema_origen IS NOT NULL;
--   -- tiene que dar 0
