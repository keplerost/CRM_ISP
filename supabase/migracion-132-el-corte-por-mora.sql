-- =============================================================================
-- Migración 132 — El corte por mora, y la reconexión
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que faltaba ──
--
-- El único corte automático que existe es el de las promesas de pago
-- incumplidas. El abonado que simplemente deja de pagar no se corta nunca:
-- alguien tiene que acordarse de cortarlo a mano, y en un padrón de quinientos
-- eso no pasa.
--
-- ── Por qué esta migración trae DOS listas y no una ──
--
-- Porque cortar sin reconectar es peor que no cortar. Si el sistema corta solo y
-- la reconexión queda a mano, el abonado que paga a las nueve de la mañana sigue
-- sin internet hasta que alguien mire una pantalla — y ese alguien está
-- ocupado. La llamada que genera un pago no honrado es peor que la de un corte:
-- el abonado ya cumplió y el que quedó mal es el ISP.
--
-- Así que el corte automático se entrega junto con su reconexión automática, y
-- las dos corren en la misma tarea.
--
-- ── A quién NO se corta, aunque deba ──
--
--   Al que tiene una promesa de pago vigente. Se le dio un plazo y todavía está
--   dentro; cortarlo sería no haber cumplido nuestra parte.
--   Al excluido del firewall: enlaces críticos, cámaras, instituciones.
--   Al que tiene `cortar_tras_meses = 0`: el servicio gratis.
--   Al que no tiene IP: no hay qué cortar, y hay que saber que está así.
-- =============================================================================

/**
 * A quién le toca el corte hoy.
 *
 * Reemplaza a la de la 131, que no miraba las promesas ni las exclusiones —
 * servía para revisar la configuración, no para cortar gente.
 *
 * ── La guarda de abajo ──
 *
 * La 153 corrigió la medida del atraso y les agregó columnas a estas dos vistas.
 * Sin la guarda, volver a correr ESTA migración —cosa que alguien va a hacer el
 * día que no esté seguro de si ya corrió— falla con "cannot drop columns from
 * view", y si no fallara sería peor: devolvería el criterio viejo, donde un
 * abono de un dólar salva del corte por un mes entero.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'v_clientes_a_cortar_por_mora'
           AND column_name = 'meses_de_atraso'
    ) THEN
        RAISE NOTICE 'Las vistas del corte por mora ya están en su versión de la 153: no se tocan.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_clientes_a_cortar_por_mora AS
SELECT
    c.id            AS cliente_id,
    c.codigo,
    c.nombre,
    c.estado,
    c.ip,
    c.router_id,
    c.cortar_tras_meses,
    meses_sin_pago(c.id) AS meses_sin_pago,
    COALESCE(s.saldo, 0) AS saldo,
    s.ultimo_pago,
    -- Para poder decir en la pantalla por qué se lo va a cortar, sin que nadie
    -- tenga que ir a buscar la factura.
    (SELECT MIN(f.fecha_vencimiento)
       FROM v_facturas_por_cobrar f WHERE f.client_id = c.id) AS vence_desde
FROM clientes c
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.estado = 'activo'
  AND c.cortar_tras_meses > 0
  AND NOT c.excluir_firewall
  AND c.ip IS NOT NULL AND c.ip <> ''
  AND COALESCE(s.saldo, 0) > 0
  AND meses_sin_pago(c.id) >= c.cortar_tras_meses
  /**
   * Y que no tenga una promesa vigente.
   *
   * Se le dio un plazo y todavía está dentro. Cortarlo ahí es no haber cumplido
   * nuestra parte, y es la clase de cosa que un abonado no olvida.
   *
   * La promesa VENCIDA no protege: de esa se encarga el corte de promesas, que
   * es más específico y llega antes.
   */
  AND NOT EXISTS (
      SELECT 1 FROM promesas_pago p
       WHERE p.client_id = c.id
         AND p.estado = 'activa'
         AND p.fecha_promesa >= CURRENT_DATE
  )
$vista$;

    EXECUTE $comentario$
COMMENT ON VIEW v_clientes_a_cortar_por_mora IS
    'Abonados activos que pasaron su umbral de meses. Ya excluye promesas vigentes, exclusiones de firewall, servicio gratis y a los que no tienen IP.'
$comentario$;

/**
 * Los que están cortados y ya no deberían estarlo.
 *
 * ── Por qué solo se reconecta lo que este sistema cortó ──
 *
 * Porque un abonado puede estar cortado por otra razón: una suspensión pedida
 * por él, un corte por abuso, una decisión administrativa. Reconectar a ese
 * porque su saldo llegó a cero sería deshacer la decisión de una persona con un
 * automatismo, y nadie se enteraría.
 *
 * Se miran las entradas de `firewall_bloqueos` que dejó esta tarea, que llevan
 * su marca en el comentario.
 */
    EXECUTE $vista$
CREATE OR REPLACE VIEW v_clientes_a_reconectar AS
SELECT DISTINCT ON (c.id)
    c.id            AS cliente_id,
    c.codigo,
    c.nombre,
    c.ip,
    c.router_id,
    b.id            AS bloqueo_id,
    b.routeros_id,
    b.lista,
    COALESCE(s.saldo, 0) AS saldo,
    meses_sin_pago(c.id) AS meses_sin_pago,
    c.cortar_tras_meses
FROM clientes c
JOIN firewall_bloqueos b
  ON b.cliente_id = c.id
 AND b.activo
 AND b.comentario LIKE 'Corte por mora%'
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.estado <> 'baja'
  /**
   * Se reconecta cuando dejó de corresponder el corte.
   *
   * No alcanza con "saldo en cero": un abonado que paga cada tres meses puede
   * quedar debiendo un mes y aun así estar dentro de su acuerdo. La condición es
   * la misma que la del corte, al revés.
   */
  AND (
      COALESCE(s.saldo, 0) <= 0
      OR meses_sin_pago(c.id) < c.cortar_tras_meses
      -- O consiguió una promesa de pago vigente: eso lo devuelve al servicio.
      OR EXISTS (
          SELECT 1 FROM promesas_pago p
           WHERE p.client_id = c.id
             AND p.estado = 'activa'
             AND p.fecha_promesa >= CURRENT_DATE
      )
  )
ORDER BY c.id, b.created_at DESC
$vista$;

    EXECUTE $comentario$
COMMENT ON VIEW v_clientes_a_reconectar IS
    'Cortados por mora que ya no deberían estarlo: pagaron, volvieron a estar dentro de su umbral, o consiguieron una promesa. Solo los que cortó esta tarea.'
$comentario$;
END $guarda$;


-- =============================================================================
-- La tarea programada
-- =============================================================================
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS mora_automatico BOOLEAN DEFAULT FALSE;
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS mora_hora VARCHAR(5) DEFAULT '05:00';
ALTER TABLE config_tareas
    -- Cuántos cortar por corrida. Es un freno de mano: una configuración mal
    -- puesta con un padrón entero no puede dejar sin internet a quinientas casas
    -- en una madrugada.
    ADD COLUMN IF NOT EXISTS mora_limite INT DEFAULT 50;

COMMENT ON COLUMN config_tareas.mora_hora IS
    'A qué hora corta por mora. De madrugada a propósito: el corte se hace efectivo antes de que el abonado empiece el día, y le da la mañana para pagar.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- A quién le tocaría el corte hoy, sin cortar a nadie:
--   SELECT nombre, meses_sin_pago, cortar_tras_meses, saldo, vence_desde
--     FROM v_clientes_a_cortar_por_mora ORDER BY meses_sin_pago DESC;
--
--   -- Y a quién habría que devolverle el servicio:
--   SELECT nombre, saldo, meses_sin_pago FROM v_clientes_a_reconectar;
