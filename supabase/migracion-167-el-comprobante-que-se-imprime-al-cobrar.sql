-- =============================================================================
-- Migración 167 — El comprobante que se imprime al cobrar
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué cambia ──
--
-- Al cobrar se imprime la FACTURA SALDADA —la misma hoja que se manda por
-- correo, con la banda verde que dice PAGADO arriba— en vez del recibo de cobro.
--
-- El motivo es del negocio, no técnico: el recibo dice "recibimos su plata" y la
-- factura saldada dice "su factura está cancelada". Lo segundo es lo que el
-- cliente quiere ver y con lo que se va tranquilo.
--
-- ── El problema que esto también arregla ──
--
-- La plantilla "Recibo" del editor generaba un PDF que NINGUNA pantalla usaba. Se
-- podía entrar, reescribirla, guardarla, mirar la vista previa — y el papel que
-- recibía el cliente no cambiaba nunca, porque el que se imprimía era otro.
--
-- Un editor que no edita nada es peor que no tener editor: hace perder el tiempo
-- y hace desconfiar del resto.
--
-- Ahora esa plantilla es el MENSAJE que va impreso en el comprobante, arriba del
-- pie legal. Lo único de ese papel que se redacta: el resto —la banda de estado,
-- el detalle, los cobros, el saldo— son datos, y dejarlos escribir a mano sería
-- permitir que digan algo distinto de lo que la base tiene.
--
-- Y va en los DOS lados, el impreso y el del correo: son el mismo documento, y
-- que dijeran cosas distintas según por dónde salieron es justamente lo que el
-- editor viene a evitar.
-- =============================================================================

/**
 * El texto de arranque, solo si nadie lo editó.
 *
 * `actualizado_en` es NULL mientras la plantilla siga como salió de fábrica. Si
 * el ISP ya la cambió, esta migración no le pisa el trabajo.
 */
UPDATE plantillas_mensaje
   SET nombre = 'Comprobante de pago',
       descripcion = 'El mensaje impreso en el comprobante que se entrega al cliente al cobrar, '
                     || 'y en el PDF que se adjunta al correo. El resto de la hoja son datos: '
                     || 'el estado, el detalle y el saldo salen de la factura.',
       cuerpo = 'Gracias por su pago. Este documento certifica que su factura fue cancelada.',
       variables = ARRAY[]::TEXT[]
 WHERE clave = 'doc_recibo'
   AND actualizado_en IS NULL;

COMMENT ON COLUMN plantillas_mensaje.clave IS
    'Identificador estable de la plantilla. `doc_recibo` es el mensaje del comprobante que se imprime al cobrar y que se adjunta al correo de la factura.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El texto que va a salir impreso:
--   SELECT nombre, cuerpo, actualizado_en FROM plantillas_mensaje WHERE clave = 'doc_recibo';
--
--   -- Se edita en Ajustes → Editor de plantillas → Documentos → Comprobante de pago,
--   -- y el cambio se ve en el próximo cobro y en el próximo correo.
