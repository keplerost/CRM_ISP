-- =============================================================================
-- Migración 26b — El bucket donde van las fotos de los tickets
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 26. Es idempotente.
--
-- Va en un archivo aparte a propósito: el SQL Editor corre todo en una
-- transacción, y si tu proyecto no deja crear buckets por SQL, un error acá
-- tiraría abajo también las tablas de la 26.
--
-- Si esto falla, creá el bucket a mano en Storage → New bucket, nombre
-- `tickets`, privado. Es lo mismo.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'tickets', 'tickets', FALSE,
    -- 5 MB alcanza de sobra: la app achica la foto antes de subirla. El límite
    -- está para que una foto sin procesar no se coma los datos del técnico.
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
    SET file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Las fotos de un trabajo son internas: se ven con sesión, no por URL suelta.
DROP POLICY IF EXISTS "tickets_leer" ON storage.objects;
CREATE POLICY "tickets_leer" ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'tickets');

DROP POLICY IF EXISTS "tickets_subir" ON storage.objects;
CREATE POLICY "tickets_subir" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'tickets');

DROP POLICY IF EXISTS "tickets_borrar" ON storage.objects;
CREATE POLICY "tickets_borrar" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'tickets');
