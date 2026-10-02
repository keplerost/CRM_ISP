-- =============================================================================
-- Migración 201 — Cada cuánto vuelve a aparecer el aviso previo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- El abonado que está por vencer ve el aviso en su navegador mientras todavía
-- tiene servicio. Hasta ahora lo veía en CADA página HTTP, durante días.
--
-- Ahora la página trae un botón "Entendido, seguir navegando": el router lo
-- deja pasar unas horas y después el aviso vuelve a aparecer, hasta que paga o
-- se le corta. Cuántas horas es una decisión comercial, y se elige en
-- Ajustes → Página del cortado.
-- =============================================================================

ALTER TABLE config_corte
    ADD COLUMN IF NOT EXISTS aviso_pausa_horas INTEGER NOT NULL DEFAULT 6;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'config_corte_aviso_pausa_horas_rango'
    ) THEN
        ALTER TABLE config_corte
            ADD CONSTRAINT config_corte_aviso_pausa_horas_rango
            CHECK (aviso_pausa_horas BETWEEN 1 AND 72);
    END IF;
END $$;

COMMENT ON COLUMN config_corte.aviso_pausa_horas IS
    'Horas que el abonado deja de ver el aviso previo después de tocar "Entendido". Entre 1 y 72.';
