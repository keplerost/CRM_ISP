-- =============================================================================
-- Migración 31b — El bucket de las fotos de instalación
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 31. Es idempotente.
--
-- Aparte de la 31 por la misma razón que los buckets de tickets y documentos:
-- el SQL Editor corre todo en una transacción y, si el proyecto no deja crear
-- buckets por SQL, el error tiraría abajo también las tablas.
--
-- Si esto falla, se crea a mano en Storage → New bucket, nombre
-- `instalaciones`, privado. Es lo mismo.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'instalaciones', 'instalaciones', FALSE,
    -- 5 MB, igual que tickets: la app achica la foto antes de subirla y el
    -- límite está para que una imagen sin procesar no se coma los datos del
    -- técnico en la calle.
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
    SET file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Privado: en estas fotos salen la fachada de la casa del abonado y el número
-- de puerta. Un bucket público las deja al alcance de cualquiera que adivine
-- la ruta.
DROP POLICY IF EXISTS "instalaciones_leer" ON storage.objects;
CREATE POLICY "instalaciones_leer" ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'instalaciones');

DROP POLICY IF EXISTS "instalaciones_subir" ON storage.objects;
CREATE POLICY "instalaciones_subir" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'instalaciones');

DROP POLICY IF EXISTS "instalaciones_borrar" ON storage.objects;
CREATE POLICY "instalaciones_borrar" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'instalaciones');
