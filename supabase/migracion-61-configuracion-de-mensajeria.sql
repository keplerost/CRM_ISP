-- =============================================================================
-- Migración 61 — Las credenciales de mensajería salen del archivo del servidor
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Hasta ahora, el token del bot de Telegram y las credenciales de WhatsApp y
-- Twilio vivían en middleware/.env. Eso tenía dos problemas:
--
--   Este sistema se vende. El ISP que lo compra tiene su propio bot y su propio
--   número, y no puede necesitar una sesión SSH para cargarlos.
--
--   Estaban en texto plano, mientras que las claves de las OLTs y los MikroTik
--   —que son menos peligrosas— se guardan cifradas. Un token de WhatsApp Business
--   filtrado deja escribirle a toda la base de abonados en nombre del ISP.
--
-- Los secretos van cifrados con la misma llave que el resto (CREDENTIALS_KEY).
-- Lo que no es secreto —el ID del teléfono, el remitente— va en claro: cifrar lo
-- que no hace falta solo estorba para diagnosticar.
-- =============================================================================

CREATE TABLE IF NOT EXISTS config_mensajeria (
    id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Telegram. El bot no puede iniciar la conversación: el abonado le tiene
    -- que escribir primero. El usuario del bot se guarda para poder mostrarle
    -- al abonado a quién escribirle.
    telegram_token_encrypted TEXT,
    telegram_bot_usuario     VARCHAR(64),

    /*
     * WhatsApp: dos caminos que hacen lo mismo por vías distintas.
     *
     *   meta    La API oficial de WhatsApp Business.
     *   twilio  Por Twilio, que revende la misma API.
     *   manual  Sin proveedor: se arma el enlace wa.me y lo manda una persona.
     *
     * Se guarda cuál se eligió en vez de deducirlo de qué campos están llenos.
     * Deducirlo hace que quien probó los dos y dejó datos viejos no entienda por
     * qué sale por donde sale.
     */
    whatsapp_via        VARCHAR(10) NOT NULL DEFAULT 'manual'
                        CHECK (whatsapp_via IN ('manual', 'meta', 'twilio')),
    whatsapp_token_encrypted TEXT,
    whatsapp_phone_id   VARCHAR(64),
    whatsapp_desde      VARCHAR(32),

    -- SMS por Twilio. El SID no es secreto; el token sí.
    twilio_sid          VARCHAR(64),
    twilio_token_encrypted TEXT,
    twilio_desde        VARCHAR(32),

    -- Por dónde y a quién avisar cuando se cae un nodo y no tiene técnico
    -- asignado. Es distinto de lo que se le manda a un abonado.
    nms_canal           VARCHAR(15) DEFAULT 'telegram'
                        CHECK (nms_canal IS NULL OR nms_canal IN ('email', 'whatsapp', 'telegram', 'sms')),
    nms_destino         VARCHAR(120),

    actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La fila existe desde el arranque: así la pantalla siempre tiene algo que
-- leer y no hay que distinguir "no configurado" de "no existe la fila".
INSERT INTO config_mensajeria (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Solo el middleware entra acá, con service_role, que no pasa por RLS. Sin
-- políticas de lectura: los tokens no tienen por qué llegar al navegador ni
-- siquiera cifrados. La pantalla los ve a través del middleware, enmascarados.
ALTER TABLE config_mensajeria ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE config_mensajeria IS
    'Credenciales de los canales de aviso. Una sola fila. Los secretos van cifrados con CREDENTIALS_KEY.';
COMMENT ON COLUMN config_mensajeria.whatsapp_via IS
    'Por dónde sale WhatsApp: manual (enlace wa.me), meta (API oficial) o twilio.';
COMMENT ON COLUMN config_mensajeria.nms_destino IS
    'A quién avisarle las caídas de red sin técnico asignado: correo, celular o chat_id según el canal.';
