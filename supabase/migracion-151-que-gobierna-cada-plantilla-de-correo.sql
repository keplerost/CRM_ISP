-- =============================================================================
-- Migración 151 — Qué gobierna cada plantilla de correo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que cambió y por qué hay que decirlo ──
--
-- Los correos de factura y de aviso de pago ahora salen como una tarjeta: logo,
-- tabla de datos, cuentas para depositar, botón de WhatsApp y el PDF adjunto.
--
-- Esa estructura la arma el sistema. Lo que sigue escribiendo el ISP es el
-- TEXTO, y eso es lo que hay que dejar claro en el editor: si alguien abre una
-- de estas plantillas esperando controlar el diseño, va a escribir HTML que el
-- sistema descarta.
--
-- ── Qué NO se toca acá ──
--
-- El cuerpo de ninguna plantilla. Es la regla de siempre: una migración que se
-- reejecuta no puede devolverle el texto de fábrica a quien redactó el suyo.
-- =============================================================================

/**
 * Los cuatro correos que ahora salen con formato.
 *
 * El mismo texto sirve para los cuatro porque el asunto es el mismo: qué manda
 * la plantilla y qué pone el sistema.
 */
UPDATE plantillas_mensaje SET
    descripcion = descripcion
        || E'\n\nEl correo sale como una tarjeta con el logo, los datos de la factura, '
        || 'las cuentas para depositar, el botón de WhatsApp y el PDF adjunto — todo eso lo pone '
        || 'el sistema con lo que hay cargado en Ajustes. Acá se escribe el TEXTO del mensaje: '
        || 'un párrafo por línea. Lo que quede vacío sale con el texto de fábrica.'
WHERE clave IN (
        'mail_factura_generada',
        'mail_aviso_pago_1',
        'mail_aviso_pago_2',
        'mail_aviso_pago_3'
      )
  AND del_sistema
  -- Solo una vez: reejecutar no puede seguir pegando el mismo párrafo.
  AND descripcion NOT LIKE '%sale como una tarjeta%';


/**
 * Y las cortas, que son las que de verdad mandan su formato.
 *
 * En SMS, WhatsApp y Telegram el texto ES el mensaje: no hay tarjeta que valga.
 * Decirlo evita que alguien escriba ahí un párrafo de correo y le llegue al
 * abonado partido en tres mensajes cobrados por separado.
 */
UPDATE plantillas_mensaje SET
    descripcion = descripcion
        || E'\n\nAcá el texto es todo el mensaje: no hay logo ni botones. '
        || 'Conviene que entre en 160 caracteres — más largo, la operadora lo parte en varios '
        || 'SMS y cobra cada uno.'
WHERE clave IN (
        'sms_factura_generada',
        'sms_aviso_pago_1',
        'sms_aviso_pago_2',
        'sms_aviso_pago_3'
      )
  AND del_sistema
  AND descripcion NOT LIKE '%el texto es todo el mensaje%';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, LEFT(descripcion, 120) FROM plantillas_mensaje
--    WHERE clave LIKE 'mail_aviso_pago%' OR clave LIKE '%factura_generada'
--    ORDER BY clave;
