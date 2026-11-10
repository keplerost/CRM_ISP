-- =============================================================================
-- Migración 224 — Tres funciones corren como dueñas
-- =============================================================================
-- `anotar_entrante_whatsapp` (177), `abrir_incidencia` y `resolver_incidencia`
-- (174) escriben en tablas que un usuario con sesión no puede escribir
-- (`ventanas_whatsapp`, `incidencia_avisos`), y se habían declarado sin
-- SECURITY DEFINER.
--
-- Hoy no falla nada: las llama solo el middleware, con la llave de servicio,
-- que no pasa por RLS. Pero es el mismo error que en su momento dejó sin poder
-- cobrar (`audit_cambios`, ver la prueba "quien escribe en una tabla de solo
-- lectura corre como DEFINER"): el día que una pantalla las llame directo, la
-- escritura se rechaza y la operación entera se deshace.
--
-- Se las pasa a DEFINER con search_path fijo, y como son del middleware, se
-- les quita el permiso de ejecutar a los usuarios con sesión.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

ALTER FUNCTION anotar_entrante_whatsapp(TEXT, TEXT, UUID, TIMESTAMPTZ)
    SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION abrir_incidencia(UUID, UUID)
    SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION resolver_incidencia(UUID, UUID)
    SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION anotar_entrante_whatsapp(TEXT, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION abrir_incidencia(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION resolver_incidencia(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- El middleware las sigue pudiendo llamar: se dice explícito para no depender
-- de los permisos por defecto de Supabase.
GRANT EXECUTE ON FUNCTION anotar_entrante_whatsapp(TEXT, TEXT, UUID, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION abrir_incidencia(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION resolver_incidencia(UUID, UUID) TO service_role;
