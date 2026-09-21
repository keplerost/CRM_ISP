-- =============================================================================
-- Migración 149 — La tarea que vence las firmas olvidadas
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Por qué hace falta una tarea ──
--
-- La pantalla ya muestra en rojo el trámite que se pasó de plazo, así que para
-- quien lo está mirando alcanza. El problema es el que NADIE está mirando: un
-- contrato mandado a firmar hace un mes no aparece en ninguna lista de
-- pendientes mientras su estado diga "enviado", porque nadie lo abre.
--
-- Al marcarlo vencido pasa a ser algo sobre lo que el sistema ofrece la firma en
-- papel, que es la única manera de que ese contrato termine firmándose.
--
-- ── Por qué nace apagada ──
--
-- Como todas. Mientras no haya proveedor de firma contratado no hay trámites que
-- vencer, y una tarea encendida que no hace nada solo agrega ruido a la pantalla
-- de tareas.
-- =============================================================================

ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS firmas_automatico   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS firmas_cada_minutos INT NOT NULL DEFAULT 60
        CHECK (firmas_cada_minutos BETWEEN 5 AND 1440);

COMMENT ON COLUMN config_tareas.firmas_cada_minutos IS
    'Cada cuánto se vencen los trámites de firma. Los plazos se miden en horas: correrlo cada minuto seria consultar la base mil veces por dia para adelantar un aviso que nadie espera.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT firmas_automatico, firmas_cada_minutos FROM config_tareas;
