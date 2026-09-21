-- =============================================================================
-- Migración 127 — Los tres avisos de pago
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Las plantillas de los tres avisos existen desde la 126 y no las manda nadie.
-- Esto decide QUIÉN recibe CUÁL y CUÁNDO, que es la parte que no se puede
-- escribir en una plantilla.
--
-- ── Las tres decisiones que importan ──
--
--   UN MENSAJE POR ABONADO POR DÍA, COMO MÁXIMO. Un abonado con tres facturas
--   vencidas recibiría tres mensajes el mismo día, y a partir del segundo deja
--   de leerlos. Se manda uno solo: el del nivel más urgente que le corresponda.
--
--   CADA AVISO SE MANDA UNA SOLA VEZ POR FACTURA. La tarea corre todos los días
--   y la condición "vence en 3 días" se cumple un solo día, pero la de "venció
--   hace 5 o más" se cumple para siempre. Sin esta regla, el aviso 3 se
--   repetiría cada mañana hasta que el abonado pague.
--
--   AL QUE YA NO ES ABONADO NO SE LE ESCRIBE. Alguien dado de baja con una
--   factura impaga sigue debiendo, pero mandarle un aviso automático de corte a
--   quien ya está cortado hace meses es ruido que solo genera llamadas.
-- =============================================================================

CREATE TABLE IF NOT EXISTS config_avisos_pago (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    activa BOOLEAN NOT NULL DEFAULT FALSE,

    /**
     * Cuándo se manda cada uno, en días respecto del VENCIMIENTO.
     *
     * Negativo es antes, positivo es después. Se cuenta contra el vencimiento y
     * no contra el día de corte porque el vencimiento está en la factura y el
     * corte depende de los días de gracia de cada abonado: contra el
     * vencimiento, la cuenta es la misma para todos y se puede explicar.
     */
    dias_aviso_1 INT NOT NULL DEFAULT -3,
    dias_aviso_2 INT NOT NULL DEFAULT 1,
    dias_aviso_3 INT NOT NULL DEFAULT 5,

    /**
     * Por dónde.
     *
     * 'preferido' usa el canal que el abonado eligió en su ficha y cae a los
     * otros si ese no está configurado. Es lo correcto: al que pidió WhatsApp
     * mandarle un correo es no haberle preguntado.
     */
    canal VARCHAR(15) NOT NULL DEFAULT 'preferido'
          CHECK (canal IN ('preferido', 'email', 'whatsapp', 'telegram', 'sms')),

    -- Cuántos mandar por corrida. Es un freno de mano: una configuración mal
    -- puesta con un padrón de mil abonados no puede mandar mil mensajes.
    limite INT NOT NULL DEFAULT 200 CHECK (limite > 0),

    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO config_avisos_pago (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE config_avisos_pago ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_config_avisos_pago" ON config_avisos_pago;
CREATE POLICY "auth_all_config_avisos_pago" ON config_avisos_pago
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Quién recibe cuál, hoy
-- =============================================================================
/**
 * Un renglón por abonado: el aviso que le toca y por qué factura.
 *
 * ── Cómo se elige el nivel ──
 *
 * Se calculan los días transcurridos desde el vencimiento de cada factura
 * impaga y se toma el aviso MÁS ALTO que corresponda. Un abonado que hace ocho
 * días que venció recibe el 3, no el 1 y el 2 y el 3.
 *
 * ── Por qué el aviso 3 no se repite ──
 *
 * Su condición —"venció hace 5 días o más"— se cumple todos los días desde
 * entonces. Lo que corta la repetición es el `NOT EXISTS` contra
 * `comunicaciones`: si ya se mandó ese aviso por esa factura, no vuelve a
 * aparecer. Los envíos fallidos NO cuentan, así que un mensaje que no salió se
 * reintenta mañana.
 */
/**
 * ── El guardián ──
 *
 * La 128 le agrega a esta vista las dos plantillas de cada nivel —la larga para
 * el correo y la corta para SMS— y le cambia las columnas de lugar. Volver a
 * correr este archivo se las llevaría, y no falla limpio: aborta con "cannot
 * drop columns from view" y deja la migración a medias.
 *
 * Por eso la pregunta es por el CONTENIDO de la vista y no por un número de
 * migración: este archivo no necesita saber nada del futuro, le alcanza con
 * mirar cómo está la vista hoy.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_avisos_pago_pendientes'
           AND column_name = 'plantilla_email_id'
    ) THEN
        RAISE NOTICE 'v_avisos_pago_pendientes ya tiene una versión posterior a la 127: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_avisos_pago_pendientes WITH (security_invoker = true) AS
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
    p.id            AS plantilla_id,
    p.clave         AS plantilla
FROM candidatas can
JOIN clientes c ON c.id = can.client_id
-- La plantilla del nivel que toca. Si el ISP la desactivó, ese aviso no sale:
-- desactivar una plantilla es una forma legítima de apagar ese escalón.
JOIN plantillas_mensaje p
  ON p.clave = 'mail_aviso_pago_' || can.nivel
 AND p.activa
WHERE can.nivel IS NOT NULL
  -- Al que ya no es abonado no se le escribe.
  AND c.estado <> 'baja'
  -- Y no dos veces lo mismo por la misma factura.
  AND NOT EXISTS (
      SELECT 1 FROM comunicaciones m
       WHERE m.factura_id = can.factura_id
         AND m.plantilla_id = p.id
         AND m.estado <> 'fallido'
  )
-- El más urgente primero: es el que se manda cuando el abonado tiene varias.
ORDER BY c.id, can.nivel DESC, can.fecha_vencimiento
    $vista$;
END $guarda$;

COMMENT ON VIEW v_avisos_pago_pendientes IS
    'Un renglón por abonado con el aviso de pago que le toca hoy. Ya excluye los enviados, las bajas y las plantillas desactivadas.';


-- =============================================================================
-- La tarea programada
-- =============================================================================
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS avisos_pago_automatico BOOLEAN DEFAULT FALSE;
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS avisos_pago_hora VARCHAR(5) DEFAULT '09:00';

COMMENT ON COLUMN config_tareas.avisos_pago_hora IS
    'A qué hora mandar los avisos de pago. A media mañana a propósito: un recordatorio de deuda a las 6 AM molesta y no se lee.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- A quién le tocaría hoy, sin mandar nada:
--   SELECT nombre, nivel, dias, saldo, factura_numero
--     FROM v_avisos_pago_pendientes ORDER BY nivel DESC, dias DESC;
--
--   -- Cuántos por nivel:
--   SELECT nivel, COUNT(*) FROM v_avisos_pago_pendientes GROUP BY nivel ORDER BY nivel;
--
--   -- Y correrla de verdad desde Ajustes → Tareas, o:
--   --   POST /api/tareas/correr  { "tarea": "avisos_pago" }
