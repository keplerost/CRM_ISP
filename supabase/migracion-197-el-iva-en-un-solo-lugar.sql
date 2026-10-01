-- =============================================================================
-- Migración 197 — El IVA en un solo lugar
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- El 15 % estaba escrito en una docena de sitios: el valor por defecto de cada
-- plan, la emisión al SRI, el RIDE, la edición de facturas. Bajarlo al 12 %
-- obligaba a encontrarlos todos.
--
-- Ahora es un número, editable en Facturación → Configuración. Al cambiarlo,
-- el middleware actualiza también los planes que tenían el anterior; los que
-- tienen otro porcentaje a propósito se respetan.
--
-- Va en `config_general` y no en `sri_config` porque esa exige RUC y razón
-- social, y un ISP que factura sin emitir al SRI también tiene IVA.
--
-- Las facturas ya emitidas NO cambian: llevan el impuesto con que se hicieron.
-- =============================================================================

ALTER TABLE config_general
    ADD COLUMN IF NOT EXISTS iva_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 15;

ALTER TABLE config_general
    DROP CONSTRAINT IF EXISTS config_general_iva_check;
-- Solo las tarifas que el SRI reconoce: cada una tiene su código de porcentaje,
-- y un número fuera de esta lista no se puede emitir.
ALTER TABLE config_general
    ADD CONSTRAINT config_general_iva_check
    CHECK (iva_porcentaje IN (15, 14, 13, 12, 8, 5));

COMMENT ON COLUMN config_general.iva_porcentaje IS
    'IVA general del ISP. Lo usan los planes nuevos, la facturación y la emisión al SRI.';

-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT iva_porcentaje FROM config_general;
--   SELECT iva_porcentaje, COUNT(*) FROM planes_velocidad GROUP BY 1;
