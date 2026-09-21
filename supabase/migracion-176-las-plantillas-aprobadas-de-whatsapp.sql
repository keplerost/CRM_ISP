-- =============================================================================
-- Migración 176 — Las plantillas aprobadas de WhatsApp
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── El problema, y por qué no es opcional ──
--
-- La API oficial de WhatsApp solo acepta texto libre DENTRO de una ventana de
-- 24 horas contada desde el último mensaje que escribió el abonado. Fuera de esa
-- ventana solo pasan plantillas aprobadas de antemano por Meta.
--
-- Y todos nuestros avisos automáticos caen fuera de esa ventana, siempre: el
-- abonado no le escribe al ISP para que le avisen que se le venció la factura.
--
-- Hasta ahora el driver mandaba `type: "text"` en todos los casos. Con la Cloud
-- API eso devuelve el error 131047 y el mensaje NO SALE — el abonado no se
-- entera de que le van a cortar, y el sistema lo registra como enviado. Con las
-- vías no oficiales (Evolution, Baileys) sí sale, y ahí el riesgo es peor: un
-- número no oficial mandando avisos masivos es exactamente el patrón que hace
-- que WhatsApp lo bloquee.
--
-- ── Lo que se agrega ──
--
-- Una tabla que dice, para cada plantilla del sistema, cómo se llama su versión
-- aprobada en Meta, en qué orden van sus variables y si ya está aprobada. Sin
-- esa fila —o con la plantilla sin aprobar— el aviso automático NO se manda por
-- WhatsApp: se cae al canal siguiente y queda escrito por qué.
--
-- ── Por qué el texto de Meta no es el mismo que el nuestro ──
--
-- Tres reglas de Meta que el texto interno no cumple:
--
--   1. Las variables son POSICIONALES: `{{1}}`, `{{2}}`. Las nuestras tienen
--      nombre. Por eso `variables` guarda el orden.
--   2. El cuerpo NO puede empezar ni terminar con una variable. Casi todas las
--      nuestras empiezan con `{{empresa}}`.
--   3. Menos variables se aprueban más rápido y se rompen menos.
--
-- Y hay una cuarta razón, que es la que decide: `{{empresa}}` no hace falta.
-- WhatsApp ya muestra el nombre del negocio arriba del mensaje. Repetirlo gasta
-- una variable, empieza el cuerpo como Meta no acepta, y no le dice nada nuevo
-- a quien lo lee.
-- =============================================================================


-- =============================================================================
-- 1. El registro
-- =============================================================================
CREATE TABLE IF NOT EXISTS plantillas_whatsapp (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- De qué plantilla del sistema es la versión aprobada. Se cuelga del id y no
    -- de la clave porque los tres avisos de pago se eligen por id desde
    -- `config_avisos_pago`: el ISP puede apuntar el nivel 2 a una plantilla suya.
    plantilla_id UUID NOT NULL UNIQUE REFERENCES plantillas_mensaje(id) ON DELETE CASCADE,

    -- Cómo se llama en Meta. Minúsculas, números y guion bajo: es lo único que
    -- Meta acepta, y el nombre se manda en cada envío.
    nombre_meta  VARCHAR(64) NOT NULL,
    idioma       VARCHAR(10) NOT NULL DEFAULT 'es',

    /**
     * La categoría con la que se registra, y por qué importa tanto.
     *
     * UTILITY es para lo que se deriva de algo que el cliente ya tiene con la
     * empresa: su factura, su pago, su servicio. Se aprueba rápido, cuesta menos
     * y casi no genera bloqueos.
     *
     * MARKETING es promoción. Se aprueba más lento, cuesta más, y —esto es lo
     * que importa— cuando alguien la marca como spam, baja la calificación de
     * calidad del NÚMERO ENTERO. Con la calificación en rojo, Meta reduce el
     * límite de mensajes y termina pausando plantillas.
     *
     * Todo lo que hay acá es UTILITY, y ninguna debería registrarse de otra
     * forma: un aviso de corte no es publicidad.
     */
    categoria    VARCHAR(15) NOT NULL DEFAULT 'UTILITY'
                 CHECK (categoria IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),

    -- El cuerpo EXACTO que se registra en Meta, con `{{1}}`, `{{2}}`…
    cuerpo_meta  TEXT NOT NULL,

    /**
     * Qué variable nuestra va en cada posición.
     *
     * `ARRAY['periodo','total','fecha_vencimiento']` significa que `{{1}}` es el
     * período, `{{2}}` el total y `{{3}}` el vencimiento. Es lo único que
     * conecta nuestras variables con nombre y las de Meta con número, y por eso
     * el orden de este arreglo NO se puede cambiar sin volver a registrar la
     * plantilla: quedaría el saldo en el lugar de la fecha.
     */
    variables    TEXT[] NOT NULL DEFAULT '{}',

    -- Los valores de ejemplo que Meta pide para aprobar. Se guardan para poder
    -- volver a mandar la plantilla sin tener que inventarlos de nuevo.
    ejemplos     TEXT[] NOT NULL DEFAULT '{}',

    /**
     * En qué anda.
     *
     *   borrador   está escrita acá, todavía no se mandó a Meta
     *   enviada    se mandó y Meta la está revisando (suele tardar minutos)
     *   aprobada   se puede usar. Es el ÚNICO estado con el que se envía
     *   rechazada  Meta la rechazó; el motivo queda escrito
     *   pausada    Meta la pausó por mala calificación de calidad
     *
     * Que solo `aprobada` habilite el envío es deliberado: mandar contra una
     * plantilla no aprobada devuelve error y el aviso no llega, pero el sistema
     * lo registraría como intento fallido en vez de caer al SMS. Prefiere
     * saberlo antes y usar el otro canal.
     */
    estado       VARCHAR(12) NOT NULL DEFAULT 'borrador'
                 CHECK (estado IN ('borrador', 'enviada', 'aprobada', 'rechazada', 'pausada')),
    motivo_rechazo TEXT,

    -- El id que asigna Meta. Sirve para consultarla desde su API.
    meta_id      VARCHAR(40),

    /**
     * El equivalente en Twilio, para quien manda WhatsApp por ahí.
     *
     * Twilio no usa el nombre de la plantilla: usa un `ContentSid` propio que se
     * crea en su panel. Es el mismo texto aprobado por Meta, con otro
     * identificador. Vacío = por Twilio esta plantilla no se puede mandar.
     */
    sid_twilio   VARCHAR(40),

    notas        TEXT,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plantillas_wa_nombre
    ON plantillas_whatsapp (nombre_meta, idioma);

COMMENT ON TABLE plantillas_whatsapp IS
    'La version aprobada por Meta de cada plantilla del sistema. Sin una fila aprobada, el aviso automatico NO sale por WhatsApp: se cae al canal siguiente.';


-- =============================================================================
-- 2. Las plantillas del sistema
-- =============================================================================
-- Se siembran en `borrador`: existen, con su texto listo para copiar al
-- Administrador de WhatsApp de Meta, y no habilitan ningún envío hasta que
-- alguien las registre allá y las marque aprobadas acá.
--
-- ── Sobre los textos ──
--
-- Ninguno empieza ni termina con una variable, ninguno pone dos variables
-- pegadas, y ninguno incluye el nombre de la empresa: eso ya lo muestra
-- WhatsApp. Son las tres cosas por las que Meta rechaza una plantilla que por
-- lo demás está bien.
--
-- El tono es el de un aviso de cuenta, no el de una promoción. Un "¡APROVECHÁ!"
-- en un aviso de corte es lo que hace que alguien lo marque como spam, y una
-- marca de spam le baja la calificación al número entero.
INSERT INTO plantillas_whatsapp
    (plantilla_id, nombre_meta, idioma, categoria, cuerpo_meta, variables, ejemplos, notas)
SELECT p.id, v.nombre_meta, 'es', 'UTILITY', v.cuerpo, v.variables, v.ejemplos, v.notas
  FROM (VALUES
    -- --- La factura del mes ---------------------------------------------------
    ('sms_factura_generada', 'factura_generada',
     'Su factura de {{1}} por {{2}} ya está disponible. Vence el {{3}}. Puede consultarla o pagarla cuando guste.',
     ARRAY['periodo', 'total', 'fecha_vencimiento'],
     ARRAY['agosto 2026', '$20.00', '15/08/2026'],
     'Se manda al emitirse la factura del mes.'),

    -- --- Los tres avisos antes del corte --------------------------------------
    ('sms_aviso_pago_1', 'aviso_pago_recordatorio',
     'Le recordamos que su factura de {{1}} por {{2}} vence el {{3}}. Si ya realizó el pago, puede ignorar este mensaje.',
     ARRAY['periodo', 'total', 'fecha_vencimiento'],
     ARRAY['agosto 2026', '$20.00', '15/08/2026'],
     'Antes del vencimiento. La frase final evita que conteste quien ya pagó.'),

    ('sms_aviso_pago_2', 'aviso_pago_vencida',
     'Su factura de {{1}} se encuentra vencida. Saldo pendiente: {{2}}. Puede regularizarla hasta el {{3}} para mantener su servicio activo.',
     ARRAY['periodo', 'saldo', 'fecha_corte'],
     ARRAY['agosto 2026', '$20.00', '25/08/2026'],
     'Ya venció y todavía no se cortó.'),

    ('sms_aviso_pago_3', 'aviso_pago_ultimo',
     'Su servicio será suspendido el {{1}} por un saldo pendiente de {{2}}. Si ya realizó el pago, por favor comuníquese con nosotros para regularizarlo.',
     ARRAY['fecha_corte', 'saldo'],
     ARRAY['25/08/2026', '$20.00'],
     'El último antes del corte. Es el que más llamadas evita.'),

    -- --- El corte ------------------------------------------------------------
    ('sms_corte_servicio', 'servicio_suspendido',
     'Su servicio fue suspendido por un saldo pendiente de {{1}}. Al registrarse su pago se reactiva automáticamente. Para cualquier consulta puede comunicarse al {{2}}, con gusto lo atendemos.',
     ARRAY['saldo', 'telefono'],
     ARRAY['$20.00', '099 123 4567'],
     'En el momento del corte. Dice CÓMO reactivar, no solo que se cortó.'),

    -- --- El acuse del pago ---------------------------------------------------
    ('sms_pago_confirmado', 'pago_confirmado',
     'Recibimos su pago de {{1}}. Su saldo actual es {{2}}. Gracias por su preferencia.',
     ARRAY['monto', 'saldo'],
     ARRAY['$20.00', '$0.00'],
     'Evita la llamada de "¿les llegó mi pago?" y la de quien paga dos veces.'),

    -- --- Los cortes masivos (migración 174) ----------------------------------
    ('sms_incidencia_abierta', 'averia_en_su_sector',
     'Estamos atendiendo una avería que afecta el servicio en su sector: {{1}}. {{2}} No es necesario que reinicie su equipo; le avisaremos apenas quede restablecido.',
     ARRAY['titulo', 'estimado'],
     ARRAY['corte de fibra en la vía principal', 'Estimamos restablecerlo alrededor de las 21:30.'],
     'La que descarga el canal de soporte durante un corte masivo.'),

    ('sms_incidencia_resuelta', 'averia_solucionada',
     'Le informamos que la avería que afectaba el servicio en su sector quedó solucionada y su conexión está restablecida. Si continúa sin servicio, escríbanos.',
     ARRAY[]::TEXT[],
     ARRAY[]::TEXT[],
     'Sin variables a propósito: menos partes móviles, aprobación más rápida.'),

    ('sms_mantenimiento_programado', 'mantenimiento_programado',
     'Realizaremos un mantenimiento programado que puede interrumpir su servicio el {{1}}. Motivo: {{2}}. Disculpe las molestias que esto pueda ocasionar.',
     ARRAY['ventana', 'titulo'],
     ARRAY['20/08 de 02:00 a 05:00', 'mejora de la red en su sector'],
     'Se manda ANTES del corte. Un mantenimiento avisado no genera reclamos.'),

    -- --- El alta -------------------------------------------------------------
    ('sms_bienvenida', 'bienvenida_abonado',
     'Le damos la bienvenida. Su servicio de internet ya se encuentra activo. Ante cualquier consulta puede escribirnos por este mismo medio.',
     ARRAY[]::TEXT[],
     ARRAY[]::TEXT[],
     'Es además el mensaje que abre la ventana de 24 horas con el abonado nuevo.')
  ) AS v(clave, nombre_meta, cuerpo, variables, ejemplos, notas)
  JOIN plantillas_mensaje p ON p.clave = v.clave
ON CONFLICT (plantilla_id) DO NOTHING;


-- =============================================================================
-- 3. Lo que la pantalla necesita ver
-- =============================================================================
-- Junta las dos mitades: el texto interno que el ISP edita y la versión
-- aprobada en Meta. Tenerlas separadas en dos pantallas es cómo se llega a que
-- alguien edite el texto de acá y siga saliendo el de allá sin entender por qué.
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
    -- Lo único que decide si un aviso automático sale por WhatsApp.
    (w.estado = 'aprobada') AS se_puede_enviar
FROM plantillas_whatsapp w
JOIN plantillas_mensaje p ON p.id = w.plantilla_id;


-- =============================================================================
-- 4. RLS
-- =============================================================================
ALTER TABLE plantillas_whatsapp ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plantillas_wa_staff ON plantillas_whatsapp;
CREATE POLICY plantillas_wa_staff ON plantillas_whatsapp
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Lo que hay que registrar en Meta, con su texto listo para copiar:
--   SELECT nombre_meta, categoria, cuerpo_meta, variables, estado
--     FROM v_plantillas_whatsapp ORDER BY estado, nombre_meta;
--
--   -- Marcar una como aprobada, después de que Meta la apruebe:
--   UPDATE plantillas_whatsapp SET estado = 'aprobada', actualizado_en = NOW()
--    WHERE nombre_meta = 'servicio_suspendido';
--
--   -- Cuáles todavía no habilitan envío por WhatsApp:
--   SELECT clave, nombre_meta, estado FROM v_plantillas_whatsapp
--    WHERE NOT se_puede_enviar;
