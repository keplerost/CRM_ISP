-- =============================================================================
-- Migración 01 — Modo de conexión al MikroTik
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
--
-- Solo hace falta si ya ejecutaste schema.sql antes de que existiera esta
-- columna. En una instalación nueva, schema.sql ya la incluye.
--
-- Por qué: la primera versión asumía la REST API sobre HTTP, porque en la red
-- del taller el puerto 8728 estaba bloqueado por firewall. Pero lo habitual en
-- un ISP es conectarse por IP pública al puerto de la API binaria. Ahora se
-- soportan las dos y se elige por router.
-- =============================================================================

ALTER TABLE routers_mikrotik
    ADD COLUMN IF NOT EXISTS modo_api VARCHAR(10) NOT NULL DEFAULT 'binaria';

-- El CHECK se agrega aparte para que la migración sea repetible.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'routers_mikrotik_modo_api_check'
    ) THEN
        ALTER TABLE routers_mikrotik
            ADD CONSTRAINT routers_mikrotik_modo_api_check
            CHECK (modo_api IN ('binaria', 'rest'));
    END IF;
END $$;

-- Los routers ya cargados con puerto 80/443 estaban usando REST: se respeta.
-- El resto pasa a la API binaria, que es el modo por defecto.
UPDATE routers_mikrotik
SET modo_api = 'rest'
WHERE puerto_api IN (80, 443);

COMMENT ON COLUMN routers_mikrotik.modo_api IS
    'binaria = API RouterOS (8728 / 8729-TLS), lo habitual en ISP. rest = REST API v7 sobre HTTP/HTTPS, alternativa si el 8728 está bloqueado.';
