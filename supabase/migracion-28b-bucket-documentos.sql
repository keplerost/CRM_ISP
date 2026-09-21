-- =============================================================================
-- Migración 28b — El bucket de documentos del abonado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 28. Es idempotente.
--
-- Aparte de la 28 por la misma razón que el bucket de tickets: si el proyecto
-- no deja crear buckets por SQL, el error tiraría abajo también las tablas.
-- Si falla, se crea a mano en Storage → New bucket, nombre `documentos`,
-- privado.
--
-- Privado sin excepción: acá van cédulas y contratos firmados. Un bucket
-- público expone esos archivos a cualquiera que adivine la ruta, y son datos
-- personales de terceros.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'documentos', 'documentos', FALSE,
    10485760,  -- 10 MB: un contrato escaneado entra cómodo
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
    SET file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "documentos_leer" ON storage.objects;
CREATE POLICY "documentos_leer" ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'documentos');

DROP POLICY IF EXISTS "documentos_subir" ON storage.objects;
CREATE POLICY "documentos_subir" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'documentos');

DROP POLICY IF EXISTS "documentos_borrar" ON storage.objects;
CREATE POLICY "documentos_borrar" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'documentos');
