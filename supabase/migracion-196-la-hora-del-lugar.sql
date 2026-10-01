-- =============================================================================
-- Migración 196 — La hora del lugar donde está el ISP
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Las tareas programadas comparan contra la hora de la máquina. En la PC de
-- desarrollo eso era la hora de Ecuador; en el VPS es UTC, cinco horas
-- adelante. La facturación de la 01:00 del 01/10 corrió a las 20:00 del 30/09,
-- y la franja de avisos de 08:00 a 20:00 quedó, en la práctica, de 03:00 a
-- 15:00.
--
-- ── Lo que se agrega ──
--
-- La zona horaria, elegible en Ajustes → Sistema. El middleware la lee al
-- arrancar y fija con ella la hora de todo el proceso.
--
-- NULL significa "no se eligió": se usa la variable TZ del servidor si alguien
-- la puso, y si no America/Guayaquil. No se pone un DEFAULT a propósito: así
-- se distingue una instalación que eligió su zona de una que nunca la tocó.
-- =============================================================================

ALTER TABLE config_general
    ADD COLUMN IF NOT EXISTS zona_horaria TEXT;

COMMENT ON COLUMN config_general.zona_horaria IS
    'Zona IANA (America/Guayaquil, America/Lima…) con la que corren las tareas programadas. NULL = la del servidor, o Ecuador.';

-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT zona_horaria FROM config_general;
