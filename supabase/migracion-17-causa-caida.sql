-- =============================================================================
-- Migración 17 — Por qué se cayó la ONU
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente.
--
-- Un corte de luz en la casa del abonado y una fibra cortada llegan a la OLT de
-- la misma forma: pérdida de señal. La diferencia está en la causa que anota la
-- OLT — cuando se va la luz, la ONU alcanza a mandar un último aviso, el
-- "dying gasp".
--
-- Sin ese dato el técnico sale a buscar un empalme roto que no existe. Con él,
-- la ficha dice "sin energía" y la visita se ahorra.
-- =============================================================================

-- El estado admite ahora "power_off". Los que ya existían no se tocan.
ALTER TABLE onus DROP CONSTRAINT IF EXISTS onus_estado_check;

ALTER TABLE onus
    ADD CONSTRAINT onus_estado_check
    CHECK (estado IN ('online', 'offline', 'los', 'power_off', 'unknown'));

ALTER TABLE onus
    -- Cómo lo dijo la OLT, tal cual: los nombres cambian entre versiones de VRP
    -- y conservarlo permite diagnosticar lo que el mapeo no cubra.
    ADD COLUMN IF NOT EXISTS causa_caida       VARCHAR(20),
    ADD COLUMN IF NOT EXISTS causa_caida_cruda VARCHAR(100),
    ADD COLUMN IF NOT EXISTS ultima_caida      VARCHAR(40);

COMMENT ON COLUMN onus.causa_caida IS
    'power_off (dying gasp: se fue la luz), los (fibra), desactivada, reinicio u otra. Sale de "Last down cause" de la OLT.';

COMMENT ON COLUMN onus.estado IS
    'online, offline, los (sin señal), power_off (sin energía en el domicilio) o unknown.';
