-- =============================================================================
-- Migración 180 — El WhatsApp que sale por un CRM externo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Por qué existe esta vía ──
--
-- Hasta acá el sistema mandaba WhatsApp por su cuenta: Meta, Evolution, Baileys
-- o Twilio. Eso obliga al ISP a tener SU número, con su reputación y sus
-- plantillas aprobadas.
--
-- Pero muchos ISP ya tienen un CRM que le habla al cliente por WhatsApp — un bot
-- de atención, de cobranza, de ventas. Y ahí aparece el problema de fondo: si el
-- bot escribe desde un número y el aviso de corte desde otro, el abonado recibe
-- mensajes de dos números que dicen ser el mismo proveedor. Eso confunde, y lo
-- que la gente hace cuando se confunde es bloquear. Los bloqueos bajan la
-- calificación de calidad del número, y con la calificación en rojo Meta recorta
-- los envíos.
--
-- Con esta vía, el sistema sigue decidiendo QUÉ avisar y CUÁNDO —que es lo que
-- sabe— y le pasa el mensaje al CRM para que lo entregue por el número que ya
-- usa. Un solo número para el abonado.
--
-- ── Por qué es genérica y no "la integración con Fulano" ──
--
-- Porque este sistema se vende, y el ISP que lo compra puede tener otro CRM.
-- Atar la vía a un proveedor obligaría a escribir un driver nuevo por cada
-- cliente que llegue con el suyo.
--
-- Así que lo que se define acá es un CONTRATO —a dónde se manda, con qué llave y
-- con qué forma— y cada CRM se adapta. El formato está documentado en
-- `docs/salida-whatsapp-crm.md`.
-- =============================================================================


-- =============================================================================
-- 1. A dónde se le entregan los mensajes al CRM
-- =============================================================================
ALTER TABLE config_mensajeria
    -- Cómo se llama, para que la pantalla no diga "el CRM" a secas cuando algo
    -- falla. Es lo que se lee en el mensaje de error a las tres de la mañana.
    ADD COLUMN IF NOT EXISTS whatsapp_crm_nombre VARCHAR(60),

    -- El endpoint completo al que se hace POST.
    ADD COLUMN IF NOT EXISTS whatsapp_crm_url TEXT,

    /**
     * Con qué cabecera viaja la llave.
     *
     * Unos usan `X-API-Key`, otros `Authorization: Bearer`. Es la única
     * diferencia real entre proveedores en la parte de autenticación, y hacerla
     * configurable evita un driver por cada uno.
     */
    ADD COLUMN IF NOT EXISTS whatsapp_crm_header VARCHAR(40) DEFAULT 'X-API-Key',

    -- La llave que dio el CRM. Cifrada: quien la tenga puede mandar mensajes en
    -- nombre del ISP.
    ADD COLUMN IF NOT EXISTS whatsapp_crm_key_encrypted TEXT;

COMMENT ON COLUMN config_mensajeria.whatsapp_crm_url IS
    'Endpoint del CRM al que se le entregan los avisos para que los mande por WhatsApp. El formato del cuerpo esta en docs/salida-whatsapp-crm.md.';


-- =============================================================================
-- 1b. La vía nueva, admitida por la restricción
-- =============================================================================
-- ── Por qué esto va acá y no se olvida ──
--
-- `whatsapp_via` tiene un CHECK con la lista de vías válidas. La 61 puso tres,
-- la 112 la amplió a cinco. Agregar un driver sin tocar esta lista deja la vía
-- imposible de guardar: la pantalla la ofrece, el usuario la elige, y al guardar
-- salta "violates check constraint" — un error que no dice nada sobre lo que hay
-- que hacer.
--
-- Se rehace entera en vez de agregar: una restricción de lista no se "amplía",
-- se reemplaza, y tenerla completa en un solo lugar evita que la próxima vía se
-- agregue sobre una versión vieja.
ALTER TABLE config_mensajeria DROP CONSTRAINT IF EXISTS config_mensajeria_whatsapp_via_check;
ALTER TABLE config_mensajeria
    ADD CONSTRAINT config_mensajeria_whatsapp_via_check
    CHECK (whatsapp_via IN ('manual', 'meta', 'twilio', 'baileys', 'evolution', 'crm'));


-- =============================================================================
-- 2. Cómo se llama cada aviso del lado del CRM
-- =============================================================================
-- ── Por qué hace falta un identificador distinto del de Meta ──
--
-- Cuando el sistema manda por Meta, la plantilla se identifica por su
-- `nombre_meta` y las variables van por POSICIÓN: `{{1}}`, `{{2}}`.
--
-- Cuando manda por un CRM, el CRM tiene sus propias plantillas aprobadas con sus
-- propios nombres, y espera las variables por NOMBRE. Nuestro `sms_aviso_pago_3`
-- puede llamarse `dunning_suspension` allá.
--
-- Son dos vocabularios y los dos tienen que poder convivir: el mismo ISP puede
-- empezar mandando por su propio Meta y pasarse a un CRM el mes que viene, o al
-- revés, sin volver a configurar todo.
ALTER TABLE plantillas_whatsapp
    ADD COLUMN IF NOT EXISTS purpose_crm VARCHAR(60);

COMMENT ON COLUMN plantillas_whatsapp.purpose_crm IS
    'Como se llama este aviso del lado del CRM externo. Vacio = por esa via no se manda, y el aviso se cae al SMS o al correo.';


-- =============================================================================
-- 3. Los nombres que se usan casi siempre
-- =============================================================================
-- Se siembran los de cobranza, que son los que todos los CRM tienen resueltos
-- porque son el caso obvio. Los otros —factura del mes, avería, mantenimiento—
-- se dejan vacíos a propósito: hay que pedirle al proveedor que los dé de alta y
-- los apruebe, y un valor puesto por nosotros haría creer que ya existen.
UPDATE plantillas_whatsapp w
   SET purpose_crm = v.purpose
  FROM (VALUES
    ('sms_aviso_pago_1',   'dunning_reminder'),
    ('sms_aviso_pago_2',   'dunning_due'),
    ('sms_aviso_pago_3',   'dunning_suspension'),
    -- OJO: NO comparte `purpose` con el anterior, aunque los dos hablen del
    -- corte. El de arriba dice "su servicio SERÁ suspendido el {{fecha_corte}}";
    -- este dice "FUE suspendido, llame al {{telefono}}". Son dos textos con dos
    -- juegos de variables distintos, y un `purpose` apunta a UNA plantilla: si
    -- compartieran nombre, uno de los dos llegaría con las variables del otro y
    -- el CRM lo rechazaría por parámetros que no coinciden.
    ('sms_corte_servicio', 'service_suspended'),
    ('sms_pago_confirmado','payment_confirmed')
  ) AS v(clave, purpose)
  JOIN plantillas_mensaje p ON p.clave = v.clave
 WHERE w.plantilla_id = p.id
   AND w.purpose_crm IS NULL;


-- =============================================================================
-- 4. La vista, con las dos identidades a la vista
-- =============================================================================
DROP VIEW IF EXISTS v_plantillas_whatsapp;
CREATE VIEW v_plantillas_whatsapp WITH (security_invoker = true) AS
SELECT
    w.id,
    w.plantilla_id,
    p.clave,
    p.nombre        AS nombre_interno,
    p.descripcion,
    p.cuerpo        AS cuerpo_interno,
    p.activa        AS plantilla_activa,
    w.nombre_meta,
    w.purpose_crm,
    w.idioma,
    w.categoria,
    w.cuerpo_meta,
    w.variables,
    w.ejemplos,
    w.estado,
    w.motivo_rechazo,
    w.meta_id,
    w.sid_twilio,
    w.notas,
    w.actualizado_en,
    -- Por Meta hace falta la plantilla aprobada. Por un CRM alcanza con saber
    -- cómo se llama allá: la aprobación la maneja el proveedor.
    (w.estado = 'aprobada') AS se_puede_enviar,
    (w.purpose_crm IS NOT NULL) AS se_puede_enviar_por_crm
FROM plantillas_whatsapp w
JOIN plantillas_mensaje p ON p.id = w.plantilla_id;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, nombre_meta, purpose_crm, se_puede_enviar_por_crm
--     FROM v_plantillas_whatsapp ORDER BY clave;
--
--   -- Los que todavía no tienen nombre del lado del CRM:
--   SELECT clave, nombre_interno FROM v_plantillas_whatsapp
--    WHERE purpose_crm IS NULL;
