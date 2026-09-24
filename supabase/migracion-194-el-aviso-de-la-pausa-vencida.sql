-- =============================================================================
-- Migración 194 — El aviso de la pausa vencida
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Un abonado pausado cuya fecha ya pasó es la única pérdida del sistema que no
-- genera ningún reclamo: quedó sin internet y sin factura, cree que sigue de
-- vacaciones, y el ISP no cobra. Nadie llama porque a nadie le molesta.
--
-- El panel ya lo muestra, pero el panel se mira al entrar. Esto lo lleva a la
-- campana, que es donde se mira lo que hay que hacer hoy: a quién llamar para
-- avisarle que su período terminó.
--
-- ── Por qué encendida de fábrica ──
--
-- Es una tarea que solo LEE y deja un aviso. No le escribe a ningún abonado, no
-- toca el router y no cambia ningún estado. El riesgo de que corra es cero, y
-- el de que no corra es un abonado sin servicio y sin facturar durante meses.
-- =============================================================================

ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS pausas_automatico BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS pausas_hora       TEXT    NOT NULL DEFAULT '08:00';

COMMENT ON COLUMN config_tareas.pausas_automatico IS
    'Avisar por la campana de las pausas de servicio cuya fecha ya venció.';
COMMENT ON COLUMN config_tareas.pausas_hora IS
    'A qué hora revisar las pausas vencidas. Temprano: es una lista de a quién llamar hoy.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT pausas_automatico, pausas_hora FROM config_tareas;
--
--   -- A quiénes va a nombrar el aviso:
--   SELECT nombre, suspendido_motivo, suspendido_hasta
--     FROM clientes
--    WHERE estado = 'suspendido' AND suspendido_hasta < CURRENT_DATE
--    ORDER BY suspendido_hasta;
