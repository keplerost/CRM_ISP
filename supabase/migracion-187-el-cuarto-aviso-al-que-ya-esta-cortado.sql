-- =============================================================================
-- Migración 187 — El cuarto aviso: al que ya está cortado y sigue sin pagar
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── El agujero ──
--
-- Los tres avisos de la 127 terminan en el corte: el 1 antes del vencimiento,
-- el 2 apenas vencida, el 3 justo antes de suspender. Después de eso el sistema
-- se calla.
--
-- Y ahí es donde se pierde la plata. El abonado cortado que no vuelve a pagar
-- deja dos cosas atrás: una factura que nadie va a cobrar y un equipo en su
-- casa. Sin un aviso posterior al corte, el caso queda esperando a que la
-- persona aparezca sola — y el que se dejó cortar ya demostró que no va a
-- aparecer sola.
--
-- ── Por qué el cuarto es distinto de los otros tres ──
--
-- Los tres primeros son una CUENTA DE FECHAS contra el vencimiento de la
-- factura. Este no: pregunta por el ESTADO del abonado.
--
--   Sale solo si el sistema lo tiene como `cortado`.
--
-- Esa diferencia importa. Un abonado con quince días de gracia puede estar a
-- veinte días del vencimiento y todavía no estar cortado; escribirle "su
-- servicio está suspendido" cuando todavía tiene internet es el tipo de error
-- que hace que el próximo aviso no se lea. Preguntando por el estado, el
-- mensaje dice la verdad para todos sin que haya que calcular la gracia de cada
-- uno.
--
-- ── Por qué se repite y los otros no ──
--
-- Porque su trabajo es distinto. Los tres primeros avisan de algo que va a
-- pasar: se dicen una vez porque después pasa. El cuarto persigue algo que ya
-- pasó, y una sola insistencia a alguien que dejó de contestar es lo mismo que
-- ninguna.
--
-- Se repite cada `repetir_cada_4` días mientras siga cortado y siga debiendo.
-- Se corta solo cuando paga (la factura sale de `v_facturas_por_cobrar`),
-- cuando se lo reactiva (deja de estar `cortado`) o cuando se lo da de baja.
--
-- ── Desde cuándo se cuenta ──
--
-- Desde el día en que el sistema lo marcó cortado, que es el dato exacto y no
-- una estimación. Para eso se agrega `clientes.cortado_en`, que `corteMora`
-- escribe al suspender y la reactivación borra.
--
-- Los que YA estaban cortados antes de esta migración no tienen esa fecha. Para
-- ellos se usa `fecha_de_corte()` —vencimiento más gracia—, que es cuándo les
-- CORRESPONDÍA el corte y no cuándo se ejecutó. Puede diferir en algunos días
-- si la tarea estuvo apagada. Es una estimación y está dicho acá para que nadie
-- la lea como un dato medido; a partir de ahora, los cortes nuevos traen la
-- fecha real.
-- =============================================================================


-- ── 1. Cuándo se lo cortó ────────────────────────────────────────────────────

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS cortado_en DATE;

COMMENT ON COLUMN clientes.cortado_en IS
    'El día en que el sistema lo marcó cortado. Lo escribe corteMora al suspender y lo borra la reactivación. NULL en quien no está cortado.';

/**
 * El día del cuarto aviso para ESTE abonado.
 *
 * Igual que `aviso_dias_1..3`: NULL usa el general, un número lo pisa. Sirve
 * para el caso que siempre aparece —el abonado grande al que se le da más
 * plazo, o el que ya está en manos de un cobrador y no hay que escribirle.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS aviso_dias_4 INT;

COMMENT ON COLUMN clientes.aviso_dias_4 IS
    'Días después de su corte para el cuarto aviso. NULL usa el valor general de config_avisos_pago.';


-- ── 2. La regla general ──────────────────────────────────────────────────────

ALTER TABLE config_avisos_pago
    ADD COLUMN IF NOT EXISTS dias_aviso_4 INT NOT NULL DEFAULT 10;

ALTER TABLE config_avisos_pago
    ADD COLUMN IF NOT EXISTS repetir_cada_4 INT NOT NULL DEFAULT 15;

COMMENT ON COLUMN config_avisos_pago.dias_aviso_4 IS
    'Días DESPUÉS del corte para el primer aviso al cortado. Se cuenta desde clientes.cortado_en.';

COMMENT ON COLUMN config_avisos_pago.repetir_cada_4 IS
    'Cada cuántos días se repite el cuarto aviso mientras siga cortado y debiendo. 0 lo manda una sola vez.';

/**
 * Un tope, no una barrera.
 *
 * `repetir_cada_4` en 1 sería un mensaje por día al mismo abonado. Nadie lo
 * pondría a propósito, pero un cero de más en el formulario sí pasa, y el que
 * lo sufre es el abonado — que además deja de leer todo lo que le llegue
 * después. Siete días es lo más seguido que tiene sentido insistir.
 */
ALTER TABLE config_avisos_pago
    DROP CONSTRAINT IF EXISTS repetir_cada_4_check;

ALTER TABLE config_avisos_pago
    ADD CONSTRAINT repetir_cada_4_check
    CHECK (repetir_cada_4 = 0 OR repetir_cada_4 >= 7);


-- ── 3. La fecha de los que ya estaban cortados ───────────────────────────────

/**
 * Se rellena UNA sola vez, y solo donde está vacía.
 *
 * `WHERE cortado_en IS NULL` no es una formalidad de idempotencia: es lo que
 * evita que una segunda corrida de esta migración pise con una estimación la
 * fecha real que `corteMora` ya haya escrito en el medio.
 */
UPDATE clientes
   SET cortado_en = fecha_de_corte(id)
 WHERE estado = 'cortado'
   AND cortado_en IS NULL
   AND fecha_de_corte(id) IS NOT NULL;


-- ── 4. Los textos ────────────────────────────────────────────────────────────

/**
 * Dos plantillas, como los otros niveles: una larga para correo y una corta
 * para WhatsApp, Telegram y SMS.
 *
 * El tono es el que corresponde a esta altura: ya no se avisa, se pide que
 * resuelva, y se nombra el equipo. Nombrarlo no es una amenaza: es la única
 * forma de que el abonado se entere de que ese aparato es nuestro y de que hay
 * algo que devolver. La mayoría de los que no contestan creen que quedó suyo.
 *
 * `ON CONFLICT DO NOTHING`: si el ISP ya escribió las suyas, no se las pisamos.
 */
INSERT INTO plantillas_mensaje
    (clave, categoria, canal, formato, del_sistema, nombre, descripcion, asunto, cuerpo, variables)
VALUES

('mail_aviso_pago_4', 'correo', 'email', 'html', TRUE,
 'Aviso de pago 4 — ya cortado',
 'Para el que ya está suspendido y sigue sin pagar. Se repite cada tantos días hasta que regularice o se cierre el caso. Nombra el equipo: es lo que abre la conversación de la devolución.',
 'Su servicio sigue suspendido — saldo pendiente {{saldo}}',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Su servicio está suspendido desde el {{fecha_corte}} y figura un saldo pendiente de {{saldo}} correspondiente a {{periodo}}.</p>\n<p>Puede reactivarlo regularizando ese saldo. Si decidió no continuar, necesitamos coordinar el retiro del equipo instalado, que es propiedad de {{empresa}}.</p>\n<p>En cualquiera de los dos casos, le pedimos que se comunique con nosotros.</p>',
 ARRAY['nombre','saldo','fecha_corte','periodo','empresa']),

('sms_aviso_pago_4', 'sms', 'sms', 'texto', TRUE,
 'Aviso de pago 4 SMS — ya cortado',
 'La versión corta del cuarto aviso, para WhatsApp, Telegram y SMS.',
 NULL,
 '{{empresa}}: su servicio sigue suspendido y adeuda {{saldo}}. Para reactivarlo o coordinar el retiro del equipo, comuníquese con nosotros.',
 ARRAY['empresa','saldo'])

ON CONFLICT (clave) WHERE clave IS NOT NULL DO NOTHING;


-- ── 5. La vista, con el cuarto nivel ─────────────────────────────────────────

/**
 * Qué cambia respecto de la 129:
 *
 *   · `reglas` trae también los dos campos nuevos.
 *   · `candidatas` calcula el nivel 4 ANTES que los otros tres, porque gana:
 *     alguien cortado a los veinte días cumple también la condición del 3, y lo
 *     que hay que mandarle es el que habla de su servicio suspendido.
 *   · El anti-duplicado se parte en dos, porque los niveles 1-3 y el 4 tienen
 *     reglas distintas: aquellos van una vez por factura, este cada tantos días.
 *
 * Lo que NO cambia: quién queda afuera. El que pidió que no lo molesten
 * (`avisos_activos`), el dado de baja, y el que no tiene ninguna plantilla
 * activa para su nivel siguen sin entrar.
 */
CREATE OR REPLACE VIEW v_avisos_pago_pendientes WITH (security_invoker = true) AS
WITH reglas AS (
    SELECT dias_aviso_1, dias_aviso_2, dias_aviso_3, dias_aviso_4, repetir_cada_4
      FROM config_avisos_pago
     WHERE id = 1
),
candidatas AS (
    SELECT
        f.id                                        AS factura_id,
        f.client_id,
        f.numero,
        f.fecha_vencimiento,
        f.saldo,
        f.importe_total,
        f.concepto,
        (CURRENT_DATE - f.fecha_vencimiento)        AS dias,
        r.repetir_cada_4,
        /**
         * El día de cada aviso: el del abonado si lo tiene, si no el general.
         *
         * La cuenta se hace por abonado y no una vez para todos, que es de
         * donde sale poder decirle a uno "avisame un día antes" sin tocarle
         * nada al resto.
         *
         * El 4 va primero en el CASE porque gana sobre los otros: quien está
         * cortado hace días cumple también la condición del 3, y el texto que
         * corresponde es el que habla de un servicio ya suspendido.
         *
         * Se cuenta desde `cortado_en`, y si está vacío —corte anterior a la
         * migración 187— desde la fecha que le correspondía. Ver el encabezado
         * de esa migración: lo segundo es una estimación.
         */
        CASE
            WHEN cl.estado = 'cortado'
             AND COALESCE(cl.cortado_en, fecha_de_corte(cl.id)) IS NOT NULL
             AND (CURRENT_DATE - COALESCE(cl.cortado_en, fecha_de_corte(cl.id)))
                 >= COALESCE(cl.aviso_dias_4, r.dias_aviso_4)          THEN 4
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= COALESCE(cl.aviso_dias_3, r.dias_aviso_3) THEN 3
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= COALESCE(cl.aviso_dias_2, r.dias_aviso_2) THEN 2
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= COALESCE(cl.aviso_dias_1, r.dias_aviso_1) THEN 1
        END                                         AS nivel
    FROM v_facturas_por_cobrar f
    JOIN clientes cl ON cl.id = f.client_id
    CROSS JOIN reglas r
    WHERE f.fecha_vencimiento IS NOT NULL
      -- El que pidió que no lo molesten no entra ni al cálculo.
      AND cl.avisos_activos
)
SELECT DISTINCT ON (c.id)
    c.id            AS cliente_id,
    c.nombre,
    c.estado,
    c.canal_preferido,
    c.email,
    c.telefono_movil,
    c.telefono,
    c.telegram_chat_id,
    can.nivel,
    can.factura_id,
    can.numero      AS factura_numero,
    can.fecha_vencimiento,
    can.dias,
    can.saldo,
    can.importe_total,
    can.concepto,
    largo.id        AS plantilla_email_id,
    corto.id        AS plantilla_corta_id,
    COALESCE(largo.id, corto.id) AS plantilla_id,
    can.nivel       AS plantilla_nivel,
    c.avisos_canales,
    -- Lo nuevo de la 187, al final para no mover nada de lugar.
    c.cortado_en,
    (CURRENT_DATE - COALESCE(c.cortado_en, fecha_de_corte(c.id))) AS dias_cortado
FROM candidatas can
JOIN clientes c ON c.id = can.client_id
LEFT JOIN plantillas_mensaje largo
       ON largo.clave = 'mail_aviso_pago_' || can.nivel AND largo.activa
LEFT JOIN plantillas_mensaje corto
       ON corto.clave = 'sms_aviso_pago_'  || can.nivel AND corto.activa
WHERE can.nivel IS NOT NULL
  AND (largo.id IS NOT NULL OR corto.id IS NOT NULL)
  AND c.estado <> 'baja'
  AND (
      /**
       * Niveles 1 a 3: una sola vez por factura, para siempre.
       *
       * Un `fallido` no cuenta como enviado: si el correo rebotó, el aviso
       * todavía no llegó y tiene que volver a intentarse.
       */
      (can.nivel < 4 AND NOT EXISTS (
          SELECT 1
            FROM comunicaciones m
            JOIN plantillas_mensaje pm ON pm.id = m.plantilla_id
           WHERE m.factura_id = can.factura_id
             AND m.estado <> 'fallido'
             AND pm.clave IN ('mail_aviso_pago_' || can.nivel, 'sms_aviso_pago_' || can.nivel)
      ))
      OR
      /**
       * Nivel 4: no si ya se le escribió hace menos de `repetir_cada_4` días.
       *
       * Con `repetir_cada_4 = 0` la ventana se vuelve infinita y el aviso sale
       * una sola vez, igual que los otros. Es la forma de apagar la repetición
       * sin apagar el aviso.
       *
       * La ventana se mide contra el ÚLTIMO envío y no contra el primero: si
       * alguien cambia el intervalo de 15 a 30 días, el próximo se corre; los
       * que ya salieron no se recalculan.
       */
      (can.nivel = 4 AND NOT EXISTS (
          SELECT 1
            FROM comunicaciones m
            JOIN plantillas_mensaje pm ON pm.id = m.plantilla_id
           WHERE m.factura_id = can.factura_id
             AND m.estado <> 'fallido'
             AND pm.clave IN ('mail_aviso_pago_4', 'sms_aviso_pago_4')
             AND (
                  can.repetir_cada_4 = 0
                  OR m.created_at > NOW() - (can.repetir_cada_4 || ' days')::INTERVAL
             )
      ))
  )
ORDER BY c.id, can.nivel DESC, can.fecha_vencimiento;

COMMENT ON VIEW v_avisos_pago_pendientes IS
    'A quién le toca un aviso de pago hoy y de qué nivel. Los niveles 1 a 3 se cuentan contra el vencimiento y salen una vez por factura; el 4 se cuenta contra la fecha de corte, pide que el abonado esté cortado, y se repite cada repetir_cada_4 días.';


-- ── 6. Índice ────────────────────────────────────────────────────────────────

/**
 * La vista filtra por `estado = 'cortado'` en cada corrida. Con el padrón
 * chico da igual; con varios miles, es la diferencia entre leer los cortados y
 * recorrer la tabla entera todos los días.
 */
CREATE INDEX IF NOT EXISTS clientes_cortados_idx
    ON clientes (cortado_en)
    WHERE estado = 'cortado';
