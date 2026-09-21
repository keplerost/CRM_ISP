-- =============================================================================
-- Migración 128 — Cada canal con su plantilla
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué cambia respecto de la 127 ──
--
-- La 127 mandaba el texto del CORREO por cualquier canal. Un correo bien escrito
-- —con su saludo, su párrafo de cortesía y su despedida— es un pésimo SMS: pasa
-- los 160 caracteres, se cobra doble y le llega al abonado partido en dos, con
-- el segundo pedazo sin contexto. Y si lleva HTML, el abonado recibe las
-- etiquetas.
--
-- Las plantillas cortas ya existen desde la 126 (`sms_aviso_pago_1..3`) y no las
-- usaba nadie. Ahora el canal elige cuál.
--
-- ── El problema que esto crea, y cómo se resuelve ──
--
-- La 127 evitaba mandar dos veces el mismo aviso preguntando si ya había una
-- comunicación para ESA factura con ESA plantilla. Con dos plantillas por nivel
-- eso deja de alcanzar: mandarle el SMS del nivel 2 no marcaría el correo del
-- nivel 2 como enviado, y al día siguiente le llegaría de nuevo por correo.
--
-- Así que la pregunta pasa a ser por el NIVEL: si ya se le avisó el nivel 2 por
-- cualquier plantilla, no se le vuelve a avisar el nivel 2.
-- =============================================================================

/**
 * Quién recibe cuál, hoy — ahora con las dos plantillas de cada nivel.
 *
 * Se devuelven las dos y elige el que envía, según por dónde le pueda escribir
 * a cada abonado. Elegir acá obligaría a esta vista a saber si el abonado tiene
 * correo, celular y Telegram, y a repetir la lógica de respaldo entre canales
 * que ya vive en un solo lugar.
 *
 * ── Cuándo un nivel está apagado ──
 *
 * Cuando sus DOS plantillas están desactivadas. Con una sola activa el nivel
 * sigue vivo y se manda por los canales que esa plantilla cubre: desactivar
 * `sms_aviso_pago_1` es una forma legítima de decir "el primer aviso solo por
 * correo".
 */
/**
 * Se SUELTA y se rehace, en vez de reemplazarla.
 *
 * `CREATE OR REPLACE VIEW` sabe agregar columnas al final pero no renombrar ni
 * reordenar las que ya están, y acá `plantilla_id` cambia de lugar. Soltar una
 * vista es peligroso cuando otras cuelgan de ella —se las lleva puestas—, pero
 * de esta no cuelga ninguna: nació en la 127 y solo la lee el middleware.
 */
DROP VIEW IF EXISTS v_avisos_pago_pendientes;

CREATE VIEW v_avisos_pago_pendientes WITH (security_invoker = true) AS
WITH reglas AS (
    SELECT dias_aviso_1, dias_aviso_2, dias_aviso_3 FROM config_avisos_pago WHERE id = 1
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
        CASE
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= r.dias_aviso_3 THEN 3
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= r.dias_aviso_2 THEN 2
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= r.dias_aviso_1 THEN 1
        END                                         AS nivel
    FROM v_facturas_por_cobrar f
    CROSS JOIN reglas r
    WHERE f.fecha_vencimiento IS NOT NULL
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

    -- La larga, para el correo. La corta, para SMS, WhatsApp y Telegram.
    largo.id        AS plantilla_email_id,
    corto.id        AS plantilla_corta_id,

    /**
     * `plantilla_id` se mantiene por compatibilidad.
     *
     * Cualquier consulta escrita contra la versión anterior de esta vista sigue
     * funcionando, y apunta a la del correo, que es la que usaba antes. Sacarla
     * rompería en silencio a quien la estuviera leyendo.
     */
    COALESCE(largo.id, corto.id) AS plantilla_id,
    can.nivel       AS plantilla_nivel
FROM candidatas can
JOIN clientes c ON c.id = can.client_id
LEFT JOIN plantillas_mensaje largo
       ON largo.clave = 'mail_aviso_pago_' || can.nivel AND largo.activa
LEFT JOIN plantillas_mensaje corto
       ON corto.clave = 'sms_aviso_pago_'  || can.nivel AND corto.activa
WHERE can.nivel IS NOT NULL
  -- Con las dos plantillas apagadas, ese escalón no existe.
  AND (largo.id IS NOT NULL OR corto.id IS NOT NULL)
  AND c.estado <> 'baja'
  /**
   * Y que no se le haya avisado YA ESE NIVEL por esa factura.
   *
   * La pregunta es por el nivel y no por la plantilla: mandarle el SMS del
   * nivel 2 tiene que impedir que mañana le llegue el correo del nivel 2. Antes
   * se preguntaba por la plantilla y con dos por nivel eso dejaba pasar el
   * duplicado.
   */
  AND NOT EXISTS (
      SELECT 1
        FROM comunicaciones m
        JOIN plantillas_mensaje pm ON pm.id = m.plantilla_id
       WHERE m.factura_id = can.factura_id
         AND m.estado <> 'fallido'
         AND pm.clave IN ('mail_aviso_pago_' || can.nivel, 'sms_aviso_pago_' || can.nivel)
  )
ORDER BY c.id, can.nivel DESC, can.fecha_vencimiento;

COMMENT ON VIEW v_avisos_pago_pendientes IS
    'Un renglón por abonado con el aviso que le toca hoy y las dos plantillas del nivel: la larga para correo y la corta para SMS/WhatsApp/Telegram. Ya excluye los avisados, las bajas y los niveles apagados.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, nivel, dias,
--          plantilla_email_id IS NOT NULL AS tiene_correo,
--          plantilla_corta_id IS NOT NULL AS tiene_corta
--     FROM v_avisos_pago_pendientes ORDER BY nivel DESC;
--
--   -- Dejar el primer aviso solo por correo:
--   UPDATE plantillas_mensaje SET activa = FALSE WHERE clave = 'sms_aviso_pago_1';
