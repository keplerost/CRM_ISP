-- =============================================================================
-- Migración 156 — El acuse de pago, con formato y con su factura
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que estaba mal ──
--
-- El correo de "Recibimos su pago" salía como TEXTO PLANO con las etiquetas HTML
-- a la vista: el abonado leía literalmente "<p>Estimado/a Juan:</p>". Los avisos
-- de factura ya salen como tarjeta —logo, tabla de datos, botón, PDF adjunto— y
-- este se había quedado atrás.
--
-- ── Qué hace falta para armarlo ──
--
-- La tarjeta necesita dos datos que la cola no traía: el NÚMERO DE FACTURA que se
-- pagó y el CÓDIGO del abonado, que es su número de cuenta. Sin ellos el resumen
-- del pago no puede decir a qué factura corresponde, que es justamente lo que el
-- abonado quiere ver.
--
-- Se agregan AL FINAL para no mover de lugar nada de lo que ya está.
-- =============================================================================

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
    c.plan_id,
    pl.nombre       AS plan,
    c.dia_facturacion AS dia_pago,
    t.numero        AS ticket,
    t.tipo_incidencia AS motivo,
    tec.nombre      AS tecnico,
    t.fecha_visita,
    ev.nota         AS respuesta,
    /**
     * Lo de esta migración, al final.
     *
     * `codigo` es el número de cuenta del abonado: el que dice por teléfono, el
     * que pone en la transferencia. En el acuse va porque es como se reconoce.
     *
     * La factura viene del pago. Un pago puede saldar varias —la base reparte de
     * la más vieja a la más nueva— y acá va la que el cobro tenía en la mano, que
     * es la que el abonado preguntó. El PDF que se adjunta es el de esa.
     */
    c.codigo,
    p.factura_id,
    f.numero        AS factura_numero
FROM avisos_pendientes a
JOIN clientes c ON c.id = a.cliente_id
LEFT JOIN pagos p ON p.id = a.referencia_id AND NOT p.anulado
LEFT JOIN facturas f ON f.id = p.factura_id
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
ORDER BY a.creado_en;

COMMENT ON VIEW v_avisos_a_enviar IS
    'Cola de avisos por mandar, con todo lo que la plantilla y la tarjeta necesitan: el pago, la factura que saldó, el ticket y el número de cuenta del abonado.';


-- =============================================================================
-- El texto del acuse
-- =============================================================================
/**
 * Solo si nadie lo editó.
 *
 * `actualizado_en` es NULL mientras la plantilla siga como salió de fábrica. Si
 * el ISP la cambió desde el editor, esta migración no le pisa el trabajo — que es
 * exactamente lo que uno espera de un sistema que promete que los textos son
 * suyos.
 *
 * El cuerpo es el que se edita en Ajustes → Editor de plantillas → Correos. La
 * tarjeta que lo rodea —logo, resumen del pago, pie con teléfono y web— la arma
 * el sistema: no es texto que alguien deba mantener a mano.
 */
UPDATE plantillas_mensaje
   SET asunto = 'Confirmación de pago recibido — Su servicio está al día',
       cuerpo = E'<p>Esperamos que se encuentre muy bien.</p>\n'
                || E'<p>Confirmamos que hemos procesado exitosamente el pago correspondiente a su factura de servicio de internet.</p>\n'
                || E'<p>Adjunto a este correo encontrará su comprobante en formato PDF.</p>\n'
                || E'<p>Queremos aprovechar esta oportunidad para agradecerle sinceramente por su preferencia y confianza en nuestros servicios. Trabajamos día a día para brindarle la mejor conexión y velocidad que merece.</p>\n'
                || E'<p>Si tiene alguna consulta sobre su plan o requiere asistencia técnica, puede responder a este correo o contactarnos por nuestros canales habituales.</p>',
       variables = ARRAY['nombre','monto','fecha','saldo','factura','codigo','plan','empresa','telefono']
 WHERE clave = 'mail_pago_confirmado'
   AND actualizado_en IS NULL;

COMMENT ON COLUMN plantillas_mensaje.cuerpo IS
    'El texto que escribe el ISP. En los correos con tarjeta —factura, avisos de pago, acuse— es el cuerpo del mensaje: el logo, la tabla de datos y el pie los arma el sistema.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- La cola ya trae la factura y el número de cuenta:
--   SELECT tipo, nombre, codigo, factura_numero, monto FROM v_avisos_a_enviar;
--
--   -- Y el texto quedó puesto (o intacto, si ya lo habías editado):
--   SELECT asunto, actualizado_en FROM plantillas_mensaje WHERE clave = 'mail_pago_confirmado';
