-- =============================================================================
-- Migración 06 — Código de facturación del plan
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente.
--
-- El detalle de la factura lleva un "código principal" que identifica lo que se
-- vendió. Hasta ahora salía "INTERNET" para todos los planes, que no distingue
-- nada: si el abonado reclama o el SRI pide el detalle de un ítem, ese código
-- tiene que apuntar a un plan concreto.
--
-- Es texto y no un número: el SRI acepta hasta 25 caracteres y hay quien usa
-- códigos tipo "HOME-150". Quien prefiera numerarlos —1016, 1017— también puede.
-- =============================================================================

ALTER TABLE planes_velocidad
    ADD COLUMN IF NOT EXISTS codigo_facturacion VARCHAR(25);

COMMENT ON COLUMN planes_velocidad.codigo_facturacion IS
    'Código principal del detalle de la factura (SRI, máximo 25 caracteres). Si está vacío se factura como INTERNET.';

-- Dos planes con el mismo código harían imposible saber cuál se facturó.
-- El índice es parcial porque los planes viejos pueden quedar sin código.
CREATE UNIQUE INDEX IF NOT EXISTS idx_planes_codigo_facturacion
    ON planes_velocidad (codigo_facturacion)
    WHERE codigo_facturacion IS NOT NULL;
