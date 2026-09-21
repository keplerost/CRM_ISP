-- =============================================================================
-- Migración 177 — El webhook de WhatsApp: la ventana de 24 h y los acuses
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Las tres cosas que llegan por el webhook ──
--
-- 1. **Los mensajes que escribe el abonado.** Son los que abren la ventana de
--    24 horas: mientras está abierta, WhatsApp acepta texto libre y no hace
--    falta plantilla. Sin webhook, el sistema no puede saber si está abierta y
--    tiene que asumir que no —que es lo seguro, pero deja de usar la ventana
--    justo cuando existe: cuando el abonado acaba de escribir pidiendo ayuda—.
--
-- 2. **Los acuses de entrega.** Todo el código dice "el acuse real llega
--    después por webhook" y hasta ahora no llegaba nadie: cada mensaje quedaba
--    en `enviado` para siempre, aunque Meta después dijera que no se entregó.
--    La diferencia importa en cobranza: "no le avisamos" y "le avisamos y el
--    número está mal" se resuelven distinto.
--
-- 3. **Las bajas.** Cuando alguien contesta "BAJA", eso es un pedido de que no
--    le escriban más. Atenderlo no es cortesía: quien pide la baja y sigue
--    recibiendo mensajes bloquea, y los bloqueos son lo que le baja a Meta la
--    calificación de calidad del NÚMERO. Con la calificación en rojo, Meta
--    recorta el límite de envíos y termina pausando plantillas — o sea que
--    ignorar una baja es lo que hace que después no salgan los avisos de corte.
-- =============================================================================


-- =============================================================================
-- 1. Las credenciales del webhook
-- =============================================================================
-- ── Por qué son dos y para qué sirve cada una ──
--
-- `verify_token` lo inventa el ISP y lo escribe en los dos lados. Meta lo manda
-- una sola vez, al dar de alta el webhook, para comprobar que la URL es de
-- quien dice. No es un secreto fuerte: es una contraseña de saludo.
--
-- `app_secret` sí lo es, y es el que importa: con él se verifica la FIRMA de
-- cada aviso que llega. Sin esa verificación, la URL del webhook es una puerta
-- abierta por la que cualquiera puede inventar mensajes entrantes —y abrir
-- ventanas de 24 horas para números que nunca escribieron—.
ALTER TABLE config_mensajeria
    ADD COLUMN IF NOT EXISTS whatsapp_verify_token VARCHAR(120),
    ADD COLUMN IF NOT EXISTS whatsapp_app_secret_encrypted TEXT;

COMMENT ON COLUMN config_mensajeria.whatsapp_app_secret_encrypted IS
    'App Secret de la app de Meta, cifrado. Con el se verifica la firma X-Hub-Signature-256 de cada webhook. Sin el, la URL acepta lo que le manden.';


-- =============================================================================
-- 2. La ventana de 24 horas
-- =============================================================================
-- Una fila por número, no un historial: lo único que se necesita saber es
-- CUÁNDO fue la última vez que escribió. Guardar cada mensaje entrante para
-- después preguntar por el máximo sería cargar una tabla que crece sin límite
-- para contestar una pregunta de una sola fila.
--
-- El texto sí se guarda, recortado: cuando alguien pregunta por qué se le
-- mandó texto libre a un abonado, la respuesta es "porque escribió esto".
CREATE TABLE IF NOT EXISTS ventanas_whatsapp (
    -- El número en formato internacional y sin símbolos: `593991234567`. Es
    -- como lo manda Meta y como lo arma `aInternacional`.
    telefono        VARCHAR(20) PRIMARY KEY,

    -- El abonado, cuando se lo pudo reconocer. Puede quedar nulo: escribe gente
    -- que todavía no es cliente, y la ventana vale igual para contestarle.
    client_id       UUID REFERENCES clientes(id) ON DELETE SET NULL,

    ultimo_entrante TIMESTAMPTZ NOT NULL,
    ultimo_texto    VARCHAR(300),
    mensajes        INT NOT NULL DEFAULT 1,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ventanas_wa_cliente
    ON ventanas_whatsapp (client_id) WHERE client_id IS NOT NULL;

COMMENT ON TABLE ventanas_whatsapp IS
    'Cuando escribio por ultima vez cada numero. Dentro de las 24 h siguientes, WhatsApp acepta texto libre y no hace falta plantilla aprobada.';


/**
 * Anota que este número escribió, y devuelve si la ventana quedó abierta.
 *
 * Va como función y no como un `upsert` desde el servidor porque el webhook
 * puede recibir varios mensajes del mismo número en el mismo lote —alguien que
 * manda tres seguidos— y cada uno tiene que sumar sin pisarse.
 */
CREATE OR REPLACE FUNCTION anotar_entrante_whatsapp(
    p_telefono  TEXT,
    p_texto     TEXT DEFAULT NULL,
    p_client_id UUID DEFAULT NULL,
    p_cuando    TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_cuando TIMESTAMPTZ;
BEGIN
    INSERT INTO ventanas_whatsapp (telefono, client_id, ultimo_entrante, ultimo_texto)
    VALUES (p_telefono, p_client_id, p_cuando, LEFT(COALESCE(p_texto, ''), 300))
    ON CONFLICT (telefono) DO UPDATE
       SET ultimo_entrante = GREATEST(ventanas_whatsapp.ultimo_entrante, EXCLUDED.ultimo_entrante),
           ultimo_texto    = COALESCE(EXCLUDED.ultimo_texto, ventanas_whatsapp.ultimo_texto),
           -- El abonado se completa si antes no se lo conocía, y no se borra si
           -- esta vez no se lo pudo resolver.
           client_id       = COALESCE(EXCLUDED.client_id, ventanas_whatsapp.client_id),
           mensajes        = ventanas_whatsapp.mensajes + 1
    RETURNING ultimo_entrante INTO v_cuando;

    RETURN v_cuando;
END;
$$;


-- =============================================================================
-- 3. Qué ventanas están abiertas ahora
-- =============================================================================
DROP VIEW IF EXISTS v_ventanas_whatsapp;
CREATE VIEW v_ventanas_whatsapp WITH (security_invoker = true) AS
SELECT
    v.telefono,
    v.client_id,
    c.nombre       AS cliente,
    c.identificacion,
    v.ultimo_entrante,
    v.ultimo_texto,
    v.mensajes,
    -- Las 24 horas de WhatsApp, contadas desde el último mensaje del abonado.
    (v.ultimo_entrante + INTERVAL '24 hours') AS abierta_hasta,
    (NOW() < v.ultimo_entrante + INTERVAL '24 hours') AS abierta,
    EXTRACT(EPOCH FROM (v.ultimo_entrante + INTERVAL '24 hours' - NOW())) / 60 AS minutos_restantes
FROM ventanas_whatsapp v
LEFT JOIN clientes c ON c.id = v.client_id;


-- =============================================================================
-- 4. Las bajas que llegan por chat
-- =============================================================================
-- `clientes.avisos_activos` ya existe desde la 129 y es lo que el sistema
-- respeta antes de mandar cualquier aviso. Lo que faltaba era una forma de que
-- el abonado la apague él mismo, desde donde ya está: contestando el mensaje.
--
-- Se guarda cuándo y con qué palabra, porque el día que alguien pregunte "¿por
-- qué este cliente no recibe los avisos?" la respuesta tiene que ser un hecho y
-- no una suposición.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS avisos_baja_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS avisos_baja_texto VARCHAR(200);

COMMENT ON COLUMN clientes.avisos_baja_at IS
    'Cuando el abonado pidio por WhatsApp que no le escriban mas. Apaga avisos_activos.';


-- =============================================================================
-- 5. Los acuses de entrega
-- =============================================================================
-- `comunicaciones.estado` ya tiene los estados; lo que faltaba era quien los
-- actualizara. El webhook trae el id del mensaje —el mismo que guardamos en
-- `proveedor_id`— y su estado nuevo.
CREATE INDEX IF NOT EXISTS idx_comunicaciones_proveedor
    ON comunicaciones (proveedor_id) WHERE proveedor_id IS NOT NULL;

DO $$
BEGIN
    -- 'leido' y 'fallido' pueden no estar en el CHECK original. Se amplía sin
    -- tocar los valores que ya existen: una fila vieja no puede volverse
    -- inválida por agregar estados nuevos.
    ALTER TABLE comunicaciones DROP CONSTRAINT IF EXISTS comunicaciones_estado_check;
    ALTER TABLE comunicaciones ADD CONSTRAINT comunicaciones_estado_check
        CHECK (estado IN ('pendiente', 'enviado', 'entregado', 'leido', 'fallido', 'recibido'));
END $$;


ALTER TABLE ventanas_whatsapp ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ventanas_wa_staff ON ventanas_whatsapp;
CREATE POLICY ventanas_wa_staff ON ventanas_whatsapp
    FOR SELECT TO authenticated USING (true);


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Con quién se puede hablar en texto libre ahora mismo:
--   SELECT cliente, telefono, ROUND(minutos_restantes) AS minutos
--     FROM v_ventanas_whatsapp WHERE abierta ORDER BY minutos_restantes;
--
--   -- Los que pidieron la baja:
--   SELECT nombre, avisos_baja_at, avisos_baja_texto
--     FROM clientes WHERE avisos_activos = FALSE AND avisos_baja_at IS NOT NULL;
--
--   -- Entregas de los últimos avisos:
--   SELECT estado, COUNT(*) FROM comunicaciones
--    WHERE canal = 'whatsapp' AND created_at > NOW() - INTERVAL '1 day'
--    GROUP BY estado;
