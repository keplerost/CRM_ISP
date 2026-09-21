-- =============================================================================
-- Migración 126 — El editor de plantillas
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Hoy los textos que el sistema le manda al abonado viven en tres lugares
-- distintos: algunos en `plantillas_mensaje` (la 28), otros escritos adentro del
-- código, y otros en columnas sueltas de configuración. Cambiar cómo se saluda a
-- un cliente nuevo puede exigir tocar código, y hay textos que directamente no
-- se pueden cambiar.
--
-- Esto los junta en un solo lugar editable, ordenados por dónde se usan:
-- documentos que se imprimen, correos, mensajes de SMS/Telegram, y las páginas
-- web que ve el abonado.
--
-- ── Por qué `clave` y no alcanza con el nombre ──
--
-- Porque el nombre lo edita una persona y el código busca la plantilla para
-- mandarla. Si el aviso de corte se buscara por "Aviso de corte" y alguien lo
-- renombrara a "Aviso de suspensión", el sistema dejaría de encontrarlo — y no
-- fallaría: mandaría el mensaje vacío, o no mandaría nada. Nadie se entera de un
-- aviso que no se envió.
--
-- La clave es interna y no se edita. El nombre es lo que se ve y se puede
-- cambiar cuantas veces se quiera.
--
-- ── Por qué las del sistema se editan pero no se borran ──
--
-- Porque borrar "aviso de pago 1" no rompe nada visible: la tarea que lo manda
-- sigue corriendo y no manda nada. El daño aparece un mes después, cuando nadie
-- recibió su aviso y la cartera creció sola.
-- =============================================================================

ALTER TABLE plantillas_mensaje
    -- Cómo la busca el código. Es interna: no se edita desde la pantalla.
    ADD COLUMN IF NOT EXISTS clave VARCHAR(60),

    -- Dónde se usa. Es el eje que ordena el editor.
    ADD COLUMN IF NOT EXISTS categoria VARCHAR(12) NOT NULL DEFAULT 'correo',

    -- Para qué sirve y cuándo se manda. Sin esto, una lista de treinta nombres
    -- obliga a abrir cada uno para saber cuál es el que se quería cambiar.
    ADD COLUMN IF NOT EXISTS descripcion TEXT,

    -- 'texto' para SMS y Telegram, 'html' para correos, documentos y páginas.
    ADD COLUMN IF NOT EXISTS formato VARCHAR(6) NOT NULL DEFAULT 'texto',

    -- Las que el código busca por clave. Se editan; no se borran.
    ADD COLUMN IF NOT EXISTS del_sistema BOOLEAN NOT NULL DEFAULT FALSE,

    ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS actualizado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plantillas_categoria_check') THEN
        ALTER TABLE plantillas_mensaje ADD CONSTRAINT plantillas_categoria_check
            CHECK (categoria IN ('documento', 'correo', 'sms', 'web'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plantillas_formato_check') THEN
        ALTER TABLE plantillas_mensaje ADD CONSTRAINT plantillas_formato_check
            CHECK (formato IN ('texto', 'html'));
    END IF;
END $$;

-- El canal tenía que ampliarse: un contrato no se manda por ningún canal, y una
-- página web tampoco. Decir que son 'cualquiera' sería mentir.
ALTER TABLE plantillas_mensaje DROP CONSTRAINT IF EXISTS plantillas_mensaje_canal_check;
ALTER TABLE plantillas_mensaje
    ADD CONSTRAINT plantillas_mensaje_canal_check
    CHECK (canal IN ('email', 'whatsapp', 'telegram', 'sms', 'cualquiera', 'documento', 'web'));

-- Dos plantillas con la misma clave harían que el código encuentre una u otra
-- según el humor del planificador de consultas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_plantillas_clave
    ON plantillas_mensaje (clave) WHERE clave IS NOT NULL;

/**
 * Borrar una plantilla del sistema queda prohibido en la base.
 *
 * No alcanza con esconder el botón: la pantalla es una de las formas de llegar a
 * esta tabla, no la única. Y el daño de borrarla no se ve el día que pasa.
 */
CREATE OR REPLACE FUNCTION proteger_plantillas_del_sistema()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.del_sistema THEN
        RAISE EXCEPTION
            'La plantilla "%" la usa el sistema y no se puede borrar. Se puede editar, o desactivar con activa = false.',
            OLD.nombre;
    END IF;
    RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_proteger_plantillas ON plantillas_mensaje;
CREATE TRIGGER trg_proteger_plantillas
    BEFORE DELETE ON plantillas_mensaje
    FOR EACH ROW EXECUTE FUNCTION proteger_plantillas_del_sistema();


-- =============================================================================
-- Las plantillas
-- =============================================================================
/**
 * ── Por qué se insertan por clave y no se pisan si ya están ──
 *
 * Porque el ISP las va a editar, y una migración que se reejecuta no puede
 * devolverle el texto de fábrica a alguien que se tomó el trabajo de escribir el
 * suyo. `ON CONFLICT DO NOTHING` sobre la clave: la primera vez se crean, las
 * siguientes no se tocan.
 */
INSERT INTO plantillas_mensaje
    (clave, categoria, canal, formato, del_sistema, nombre, descripcion, asunto, cuerpo, variables)
VALUES

-- ── Documentos ─────────────────────────────────────────────────────────────
('doc_factura_sri', 'documento', 'documento', 'html', TRUE,
 'Factura SRI',
 'El comprobante electrónico que se le entrega al abonado. El XML lo define el SRI; esto es lo que se imprime.',
 NULL,
 E'<h1>FACTURA</h1>\n<p>{{empresa}} · RUC {{ruc}}</p>\n<p>Cliente: {{nombre}} · {{identificacion}}</p>\n<p>Período: {{periodo}}</p>\n<p>Total: {{total}}</p>',
 ARRAY['empresa','ruc','nombre','identificacion','periodo','total','fecha']),

('doc_recibo', 'documento', 'documento', 'html', TRUE,
 'Recibo',
 'El comprobante de un pago cobrado. Se imprime o se manda cuando el abonado paga.',
 NULL,
 E'<h1>RECIBO N° {{numero}}</h1>\n<p>Recibimos de {{nombre}} la suma de {{monto}}</p>\n<p>Por concepto de: {{concepto}}</p>\n<p>Forma de pago: {{forma_pago}} · {{fecha}}</p>',
 ARRAY['numero','nombre','monto','concepto','forma_pago','fecha']),

('doc_recibo_pos', 'documento', 'documento', 'html', TRUE,
 'Recibo POS',
 'El mismo recibo en formato tirilla, para la impresora térmica de 58 u 80 mm.',
 NULL,
 E'{{empresa}}\nRECIBO {{numero}}\n{{fecha}}\n--------------------------\n{{nombre}}\n{{concepto}}\nTOTAL {{monto}}\n--------------------------\nGracias por su pago',
 ARRAY['empresa','numero','nombre','monto','concepto','fecha']),

('doc_hoja_instalacion', 'documento', 'documento', 'html', TRUE,
 'Hoja de instalación',
 'La que firma el abonado cuando el técnico termina: qué se instaló, con qué serie y en qué estado quedó.',
 NULL,
 E'<h1>HOJA DE INSTALACIÓN</h1>\n<p>Orden N° {{orden}} · {{fecha}}</p>\n<p>Cliente: {{nombre}} · {{direccion}}</p>\n<p>Plan: {{plan}} · IP: {{ip}}</p>\n<p>Equipo: {{equipo}} · Serie: {{serie}}</p>\n<p>Técnico: {{tecnico}}</p>',
 ARRAY['orden','fecha','nombre','direccion','plan','ip','equipo','serie','tecnico']),

('doc_ticket', 'documento', 'documento', 'html', TRUE,
 'Impresión de ticket',
 'El comprobante de un reporte de soporte, para dejarle algo en la mano al abonado.',
 NULL,
 E'<h1>TICKET N° {{ticket}}</h1>\n<p>{{fecha}}</p>\n<p>Cliente: {{nombre}}</p>\n<p>Motivo: {{motivo}}</p>\n<p>Atiende: {{tecnico}}</p>',
 ARRAY['ticket','fecha','nombre','motivo','tecnico']),

('doc_contrato', 'documento', 'documento', 'html', TRUE,
 'Contrato',
 'El contrato de servicio que firma el abonado al darse de alta.',
 NULL,
 E'<h1>CONTRATO DE SERVICIO DE INTERNET</h1>\n<p>Entre {{empresa}}, RUC {{ruc}}, y {{nombre}}, con documento {{identificacion}}, domiciliado en {{direccion}}.</p>\n<p>Plan contratado: {{plan}} por {{precio}} mensuales.</p>\n<p>Fecha de instalación: {{fecha_instalacion}}</p>\n<p>Día de pago: {{dia_pago}} de cada mes.</p>',
 ARRAY['empresa','ruc','nombre','identificacion','direccion','plan','precio','fecha_instalacion','dia_pago']),

-- ── Correos ────────────────────────────────────────────────────────────────
('mail_aviso_pago_1', 'correo', 'email', 'html', TRUE,
 'Aviso de pago 1',
 'El primer recordatorio, antes del vencimiento. Tono amable: todavía no debe nada.',
 'Su factura de {{periodo}} está por vencer',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Le recordamos que su factura de {{periodo}} por {{total}} vence el {{fecha_vencimiento}}.</p>\n<p>Gracias por su preferencia.</p>',
 ARRAY['nombre','periodo','total','fecha_vencimiento']),

('mail_aviso_pago_2', 'correo', 'email', 'html', TRUE,
 'Aviso de pago 2',
 'El segundo, ya vencido. Se le dice que hay saldo pendiente y hasta cuándo puede pagar sin corte.',
 'Su factura de {{periodo}} está vencida',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Su factura de {{periodo}} por {{total}} venció el {{fecha_vencimiento}} y figura pendiente.</p>\n<p>Puede regularizarla hasta el {{fecha_corte}} para evitar la suspensión del servicio.</p>',
 ARRAY['nombre','periodo','total','fecha_vencimiento','fecha_corte']),

('mail_aviso_pago_3', 'correo', 'email', 'html', TRUE,
 'Aviso de pago 3',
 'El último antes del corte. Tiene que decir la fecha exacta: es lo que evita el reclamo de "nunca me avisaron".',
 'Último aviso antes de la suspensión',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Su servicio será suspendido el {{fecha_corte}} por un saldo pendiente de {{saldo}}.</p>\n<p>Si ya realizó el pago, escríbanos para regularizar su cuenta.</p>',
 ARRAY['nombre','saldo','fecha_corte']),

('mail_pago_confirmado', 'correo', 'email', 'html', TRUE,
 'Confirmación de pago',
 'Se manda al registrar un pago. Es lo que evita la llamada de "¿les llegó?".',
 'Recibimos su pago',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Registramos su pago de {{monto}} el {{fecha}}. Su saldo pendiente ahora es {{saldo}}.</p>\n<p>Gracias.</p>',
 ARRAY['nombre','monto','fecha','saldo']),

('mail_factura_generada', 'correo', 'email', 'html', TRUE,
 'Factura generada',
 'Se manda cuando se emite la factura del mes, con el comprobante adjunto.',
 'Su factura de {{periodo}}',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Adjuntamos su factura de {{periodo}} por {{total}}, con vencimiento el {{fecha_vencimiento}}.</p>',
 ARRAY['nombre','periodo','total','fecha_vencimiento']),

('mail_bienvenida', 'correo', 'email', 'html', TRUE,
 'Bienvenida',
 'El primer correo del abonado nuevo, con sus datos de servicio y cómo pedir soporte.',
 'Bienvenido a {{empresa}}',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Su servicio ya está activo.</p>\n<p>Plan: {{plan}}<br>Día de pago: {{dia_pago}} de cada mes</p>\n<p>Para soporte escríbanos al {{telefono}}.</p>',
 ARRAY['nombre','empresa','plan','dia_pago','telefono']),

('mail_ticket_abierto', 'correo', 'email', 'html', TRUE,
 'Ticket de soporte',
 'Confirma que se recibió el reporte y le da al abonado un número para seguirlo.',
 'Recibimos su reporte N° {{ticket}}',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Registramos su reporte con el número {{ticket}}: {{motivo}}.</p>\n<p>Le avisaremos apenas tengamos novedades.</p>',
 ARRAY['nombre','ticket','motivo']),

('mail_ticket_respuesta', 'correo', 'email', 'html', TRUE,
 'Respuesta a ticket de soporte',
 'La respuesta al abonado sobre un reporte abierto.',
 'Sobre su reporte N° {{ticket}}',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>{{respuesta}}</p>\n<p>Reporte N° {{ticket}}</p>',
 ARRAY['nombre','ticket','respuesta']),

('mail_ticket_asignado', 'correo', 'email', 'html', TRUE,
 'Ticket asignado',
 'Le avisa al abonado que su reporte ya tiene técnico asignado y cuándo lo visitan.',
 'Su reporte N° {{ticket}} fue asignado',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Su reporte fue asignado a {{tecnico}}, que lo visitará el {{fecha_visita}}.</p>',
 ARRAY['nombre','ticket','tecnico','fecha_visita']),

('mail_router_caido', 'correo', 'email', 'html', TRUE,
 'Caída de router',
 'Aviso interno al equipo cuando un router deja de responder.',
 'Router {{equipo}} sin respuesta',
 E'<p>El router <b>{{equipo}}</b> ({{ip}}) dejó de responder el {{fecha}}.</p>\n<p>Abonados afectados: {{afectados}}</p>',
 ARRAY['equipo','ip','fecha','afectados']),

('mail_router_conectado', 'correo', 'email', 'html', TRUE,
 'Router conectado',
 'El aviso de que volvió. Cierra el que avisó la caída.',
 'Router {{equipo}} restablecido',
 E'<p>El router <b>{{equipo}}</b> ({{ip}}) volvió a responder el {{fecha}}.</p>\n<p>Estuvo caído {{duracion}}.</p>',
 ARRAY['equipo','ip','fecha','duracion']),

('mail_emisor_caido', 'correo', 'email', 'html', TRUE,
 'Caída de emisor',
 'Aviso interno cuando se cae una antena o caja NAP, con los abonados que cuelgan de ella.',
 'Emisor {{equipo}} sin respuesta',
 E'<p>El emisor <b>{{equipo}}</b> dejó de responder el {{fecha}}.</p>\n<p>Abonados afectados: {{afectados}}</p>',
 ARRAY['equipo','fecha','afectados','zona']),

('mail_emisor_conectado', 'correo', 'email', 'html', TRUE,
 'Emisor conectado',
 'El aviso de que la antena o la caja volvió.',
 'Emisor {{equipo}} restablecido',
 E'<p>El emisor <b>{{equipo}}</b> volvió a responder el {{fecha}}.</p>\n<p>Estuvo caído {{duracion}}.</p>',
 ARRAY['equipo','fecha','duracion','zona']),

('mail_personalizado', 'correo', 'email', 'html', FALSE,
 'Correo personalizado',
 'Para escribirle a un abonado sin plantilla fija. Se edita al momento de mandarlo.',
 '{{asunto}}',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>{{mensaje}}</p>',
 ARRAY['nombre','asunto','mensaje']),

-- ── SMS y Telegram ─────────────────────────────────────────────────────────
-- Cortos a propósito: un SMS se cobra por tramos de 160 caracteres y uno largo
-- llega partido en dos, con el segundo pedazo sin contexto.
('sms_aviso_pago_1', 'sms', 'sms', 'texto', TRUE,
 'Aviso de pago SMS 1',
 'Recordatorio antes del vencimiento.',
 NULL,
 '{{empresa}}: su factura de {{periodo}} por {{total}} vence el {{fecha_vencimiento}}.',
 ARRAY['empresa','periodo','total','fecha_vencimiento']),

('sms_aviso_pago_2', 'sms', 'sms', 'texto', TRUE,
 'Aviso de pago SMS 2',
 'Recordatorio con la factura ya vencida.',
 NULL,
 '{{empresa}}: su factura de {{periodo}} venció. Saldo pendiente {{saldo}}. Puede pagar hasta el {{fecha_corte}}.',
 ARRAY['empresa','periodo','saldo','fecha_corte']),

('sms_aviso_pago_3', 'sms', 'sms', 'texto', TRUE,
 'Aviso de pago SMS 3',
 'El último antes del corte, con la fecha exacta.',
 NULL,
 '{{empresa}}: su servicio se suspende el {{fecha_corte}} por {{saldo}} pendiente. Si ya pagó, avísenos.',
 ARRAY['empresa','saldo','fecha_corte']),

('sms_factura_generada', 'sms', 'sms', 'texto', TRUE,
 'Nueva factura generada',
 'Avisa que ya se emitió la factura del mes.',
 NULL,
 '{{empresa}}: su factura de {{periodo}} por {{total}} ya está disponible. Vence el {{fecha_vencimiento}}.',
 ARRAY['empresa','periodo','total','fecha_vencimiento']),

('sms_corte_servicio', 'sms', 'sms', 'texto', TRUE,
 'Corte de servicio',
 'Se manda en el momento del corte. Tiene que decir cómo reactivar, no solo que se cortó.',
 NULL,
 '{{empresa}}: su servicio fue suspendido por {{saldo}} pendiente. Al registrar su pago se reactiva. Consultas: {{telefono}}',
 ARRAY['empresa','saldo','telefono']),

('sms_bienvenida', 'sms', 'sms', 'texto', TRUE,
 'Bienvenida',
 'El primer mensaje del abonado nuevo.',
 NULL,
 'Bienvenido a {{empresa}}. Su servicio {{plan}} está activo. Paga el {{dia_pago}} de cada mes. Soporte: {{telefono}}',
 ARRAY['empresa','plan','dia_pago','telefono']),

('sms_pago_confirmado', 'sms', 'sms', 'texto', TRUE,
 'Confirmación de pago',
 'Evita la llamada de "¿les llegó mi pago?".',
 NULL,
 '{{empresa}}: recibimos su pago de {{monto}}. Saldo actual: {{saldo}}. Gracias.',
 ARRAY['empresa','monto','saldo']),

('sms_router_caido', 'sms', 'telegram', 'texto', TRUE,
 'Router caído',
 'Aviso interno al grupo del equipo.',
 NULL,
 'ROUTER CAÍDO: {{equipo}} ({{ip}}) no responde desde {{fecha}}. Afectados: {{afectados}}',
 ARRAY['equipo','ip','fecha','afectados']),

('sms_router_conectado', 'sms', 'telegram', 'texto', TRUE,
 'Router conectado',
 'El cierre del aviso anterior.',
 NULL,
 'ROUTER OK: {{equipo}} ({{ip}}) volvió. Estuvo caído {{duracion}}.',
 ARRAY['equipo','ip','duracion']),

('sms_emisor_caido', 'sms', 'telegram', 'texto', TRUE,
 'Emisor caído',
 'Aviso interno de antena o caja NAP caída.',
 NULL,
 'EMISOR CAÍDO: {{equipo}} en {{zona}} no responde desde {{fecha}}. Afectados: {{afectados}}',
 ARRAY['equipo','zona','fecha','afectados']),

('sms_emisor_conectado', 'sms', 'telegram', 'texto', TRUE,
 'Emisor conectado',
 'El cierre del aviso anterior.',
 NULL,
 'EMISOR OK: {{equipo}} en {{zona}} volvió. Estuvo caído {{duracion}}.',
 ARRAY['equipo','zona','duracion']),

-- ── Páginas web ────────────────────────────────────────────────────────────
('web_aviso_pago', 'web', 'web', 'html', TRUE,
 'Aviso de pago',
 'La página que ve el abonado que está por vencer, antes del corte. Se muestra desde la lista de aviso previo del router.',
 'Su factura está por vencer',
 E'<p>Su factura de {{periodo}} por {{total}} vence el {{fecha_vencimiento}}.</p>\n<p>Puede pagar en las cuentas que aparecen abajo y enviarnos el comprobante.</p>',
 ARRAY['nombre','periodo','total','fecha_vencimiento','saldo']),

('web_aviso_corte', 'web', 'web', 'html', TRUE,
 'Aviso de corte',
 'La página que ve el abonado suspendido al abrir el navegador. Es la que reemplaza a la del sistema anterior.',
 'Tu servicio está suspendido',
 'Tu servicio de internet fue suspendido por falta de pago. Apenas registremos tu pago se reactiva automáticamente.',
 ARRAY['nombre','saldo','plan','codigo'])

-- El `WHERE` repite el del índice: es parcial —solo cubre las que tienen
-- clave— y sin esa condición Postgres no puede saber cuál usar.
ON CONFLICT (clave) WHERE clave IS NOT NULL DO NOTHING;


-- =============================================================================
-- Las que ya estaban, de la 28
-- =============================================================================
-- Se les pone categoría para que aparezcan en el editor en vez de quedar
-- invisibles. No se les pone clave: son del ISP, no del sistema, y puede
-- borrarlas.
UPDATE plantillas_mensaje
   SET categoria = CASE WHEN canal = 'email' THEN 'correo' ELSE 'sms' END,
       formato   = CASE WHEN canal = 'email' THEN 'html' ELSE 'texto' END
 WHERE clave IS NULL AND categoria = 'correo' AND canal <> 'email';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT categoria, COUNT(*) FROM plantillas_mensaje GROUP BY 1 ORDER BY 1;
--
--   -- Y que una del sistema no se pueda borrar:
--   DELETE FROM plantillas_mensaje WHERE clave = 'web_aviso_corte';
--   -- ERROR: La plantilla "Aviso de corte" la usa el sistema y no se puede borrar.
