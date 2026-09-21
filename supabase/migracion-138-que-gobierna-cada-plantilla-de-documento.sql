-- =============================================================================
-- Migración 138 — Qué gobierna de verdad cada plantilla de documento
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema que arregla ──
--
-- Las seis plantillas de documento se crearon en la 126 con una descripción
-- optimista: todas parecían gobernar su documento por completo. No es así, y la
-- diferencia importa mucho.
--
-- Tres de ellas SÍ mandan enteras: el contrato, la hoja de instalación y la
-- impresión de ticket. Son texto que el ISP redacta, y lo que escriba es
-- exactamente lo que sale impreso.
--
-- Las otras tres no. El recibo y la factura del sistema ya tienen un formato
-- armado —original y copia, monto en letras, detalle de excedentes, saldo
-- anterior— que se sigue usando por defecto; su plantilla es un formato
-- ALTERNATIVO para quien prefiera redactar el suyo.
--
-- Y el RIDE del SRI no se arma desde ninguna plantilla. Un RIDE que dijera algo
-- distinto del XML autorizado es un problema tributario, no una diferencia de
-- presentación. Lo editable ahí es la "información adicional", que ya vive en
-- `sri_config.plantilla_info_adicional`.
--
-- ── Por qué esto es una migración y no un comentario en el código ──
--
-- Porque el que edita las plantillas es el ISP desde la pantalla de Ajustes, y
-- lo único que lee ahí es la descripción. Una descripción que promete lo que el
-- sistema no hace termina en alguien editando media hora un texto que no va a
-- salir impreso en ninguna parte.
-- =============================================================================

/**
 * Solo se tocan la descripción y la lista de variables, nunca el CUERPO.
 *
 * El cuerpo es lo que el ISP escribió. Una migración que se reejecuta no puede
 * devolverle el texto de fábrica a quien se tomó el trabajo de redactar el suyo
 * — es la misma razón por la que la 126 las insertó con ON CONFLICT DO NOTHING.
 *
 * Y solo las `del_sistema`: si alguien creó una plantilla propia con una de
 * estas claves, es suya.
 */

-- ── Los tres que mandan enteros ────────────────────────────────────────────

UPDATE plantillas_mensaje SET
    descripcion = 'El contrato de servicio que firma el abonado al darse de alta. '
                  || 'Lo que escriba acá es exactamente lo que se imprime: el sistema '
                  || 'solo agrega el membrete, las dos firmas y el número de hoja.',
    variables = ARRAY['empresa','razon_social','ruc','telefono_empresa','direccion_empresa',
                      'nombre','identificacion','direccion','telefono','email',
                      'plan','velocidad','precio','permanencia',
                      'numero','fecha_instalacion','dia_pago','fecha']
WHERE clave = 'doc_contrato' AND del_sistema;

UPDATE plantillas_mensaje SET
    descripcion = 'La que firma el abonado cuando el técnico termina. Lo que escriba acá '
                  || 'es lo que se imprime, y debajo va la firma que se capturó en la '
                  || 'tablet.',
    variables = ARRAY['empresa','ruc','orden','fecha','hora','tipo',
                      'nombre','identificacion','direccion','telefono',
                      'plan','ip','usuario_ppp',
                      'equipo','serie','mac','metros_cable','nap','puerto_nap','potencia',
                      'tecnico','observaciones']
WHERE clave = 'doc_hoja_instalacion' AND del_sistema;

UPDATE plantillas_mensaje SET
    descripcion = 'El comprobante de un reporte de soporte, para dejarle algo en la mano '
                  || 'al abonado. Lo que escriba acá es lo que se imprime. La raya para '
                  || 'firmar sale solo si el reporte ya tiene solución o firma: un '
                  || 'reporte recién abierto no tiene nada que conformar.',
    variables = ARRAY['empresa','ruc','ticket','codigo','fecha','fecha_visita',
                      'estado','prioridad',
                      'nombre','identificacion','direccion','telefono',
                      'motivo','descripcion','solucion','material',
                      'tecnico','ip','potencia']
WHERE clave = 'doc_ticket' AND del_sistema;

-- ── Los dos que son un formato alternativo ─────────────────────────────────

UPDATE plantillas_mensaje SET
    descripcion = 'FORMATO ALTERNATIVO del recibo. El recibo que se imprime por defecto '
                  || 'trae original y copia en la misma hoja, el monto en letras, el '
                  || 'detalle de los excedentes y la marca de anulado. Este es para el '
                  || 'ISP que prefiere redactar el suyo.',
    variables = ARRAY['empresa','ruc','telefono_empresa',
                      'numero','fecha','nombre','identificacion',
                      'monto','entregado','excedente','concepto','forma_pago',
                      'transaccion','anulado']
WHERE clave = 'doc_recibo' AND del_sistema;

UPDATE plantillas_mensaje SET
    descripcion = 'El mismo recibo en formato tirilla, para la impresora térmica de 58 u '
                  || '80 mm. Se imprime como texto, sin diálogo de impresión: escriba una '
                  || 'línea por renglón y use guiones para las separadoras.',
    variables = ARRAY['empresa','ruc','telefono_empresa',
                      'numero','fecha','nombre','identificacion',
                      'monto','entregado','excedente','concepto','forma_pago',
                      'transaccion','anulado']
WHERE clave = 'doc_recibo_pos' AND del_sistema;

-- ── El que no se arma desde plantilla ──────────────────────────────────────

/**
 * El RIDE se deja documentado, no escondido.
 *
 * Se podría borrar la fila o desactivarla, pero entonces el ISP buscaría dónde
 * se edita la factura y no encontraría nada — y concluiría que falta, no que no
 * se toca. Es mejor que la encuentre, lea por qué no se arma desde acá y sepa a
 * dónde ir para lo que sí puede cambiar.
 */
UPDATE plantillas_mensaje SET
    descripcion = 'La representación impresa del comprobante electrónico. Su formato lo '
                  || 'exige el SRI y NO se arma desde acá: un RIDE que dijera algo '
                  || 'distinto del XML autorizado es un problema tributario. Lo que sí '
                  || 'puede escribir es la "información adicional", en Ajustes → '
                  || 'Facturación electrónica.'
WHERE clave = 'doc_factura_sri' AND del_sistema;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, activa, LEFT(descripcion, 60) AS dice, ARRAY_LENGTH(variables, 1) AS vars
--     FROM plantillas_mensaje
--    WHERE categoria = 'documento'
--    ORDER BY clave;
--
--   -- Y que ningún cuerpo se haya tocado: los seis siguen con el texto que
--   -- tenían antes de correr esto.
