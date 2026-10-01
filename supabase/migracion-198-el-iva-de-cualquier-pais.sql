-- =============================================================================
-- Migración 198 — El IVA de cualquier país
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- La 197 limitó el IVA general a las tarifas del SRI de Ecuador. Pero el
-- sistema se vende también fuera, y en otros países el IVA es otro: 16, 18,
-- 19, 21 %. Ahora acepta cualquier valor entre 0 y 100.
--
-- Lo que sigue atado al SRI es la EMISIÓN: un comprobante ecuatoriano lleva un
-- código de porcentaje, y una tarifa sin código no se puede emitir. Eso lo
-- controla el middleware al emitir, con un mensaje claro, en vez de impedir
-- acá que un ISP de otro país cargue su impuesto.
-- =============================================================================

ALTER TABLE config_general
    DROP CONSTRAINT IF EXISTS config_general_iva_check;
ALTER TABLE config_general
    ADD CONSTRAINT config_general_iva_check
    CHECK (iva_porcentaje >= 0 AND iva_porcentaje <= 100);

-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'config_general_iva_check';
