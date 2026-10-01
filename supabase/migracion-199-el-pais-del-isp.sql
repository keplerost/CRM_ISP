-- =============================================================================
-- Migración 199 — El país del ISP
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- El sistema se vende fuera de Ecuador. El país decide cómo se llaman las
-- cosas —el impuesto, el ente tributario, los documentos de identidad— y qué
-- módulos legales existen: el comprobante del SRI y lo de ARCOTEL son solo de
-- Ecuador. El perfil de cada país vive en el middleware (lib/paises.js); acá
-- se guarda solo cuál es.
--
-- Por defecto 'EC': una instalación que ya funcionaba sigue exactamente igual.
-- =============================================================================

ALTER TABLE config_general
    ADD COLUMN IF NOT EXISTS pais VARCHAR(2) NOT NULL DEFAULT 'EC';

COMMENT ON COLUMN config_general.pais IS
    'Código ISO del país del ISP (EC, CO, PE…; XX = otro). Decide nombres y módulos legales.';

-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT pais FROM config_general;
