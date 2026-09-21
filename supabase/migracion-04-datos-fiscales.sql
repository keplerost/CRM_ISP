-- =============================================================================
-- Migración 04 — Datos fiscales del cliente
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente.
--
-- Para emitir un comprobante, el SRI exige identificar al comprador. Los datos
-- que vienen del MikroTik (IP, usuario PPPoE, velocidad) no alcanzan: hace
-- falta la cédula o el RUC.
-- =============================================================================

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS tipo_identificacion VARCHAR(2) DEFAULT '05',
    ADD COLUMN IF NOT EXISTS identificacion      VARCHAR(20),
    ADD COLUMN IF NOT EXISTS email               VARCHAR(200),
    ADD COLUMN IF NOT EXISTS telefono            VARCHAR(30),
    ADD COLUMN IF NOT EXISTS direccion           VARCHAR(300),
    -- Precio mensual acordado. Puede diferir del precio de lista del plan.
    ADD COLUMN IF NOT EXISTS precio_mensual      NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS dia_facturacion     INT CHECK (dia_facturacion BETWEEN 1 AND 28);

-- Los códigos son los del SRI:
--   04 RUC · 05 Cédula · 06 Pasaporte · 07 Consumidor final · 08 Exterior
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'clientes_tipo_identificacion_check'
    ) THEN
        ALTER TABLE clientes
            ADD CONSTRAINT clientes_tipo_identificacion_check
            CHECK (tipo_identificacion IN ('04', '05', '06', '07', '08'));
    END IF;
END $$;

COMMENT ON COLUMN clientes.tipo_identificacion IS
    'Código SRI: 04 RUC, 05 Cédula, 06 Pasaporte, 07 Consumidor final, 08 Identificación del exterior';

COMMENT ON COLUMN clientes.dia_facturacion IS
    'Día del mes en que se le emite la factura. Se limita a 28 para que exista en todos los meses.';

-- Buscar por identificación es la consulta natural al facturar.
CREATE INDEX IF NOT EXISTS idx_clientes_identificacion
    ON clientes (identificacion) WHERE identificacion IS NOT NULL;
