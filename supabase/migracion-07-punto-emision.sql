-- =============================================================================
-- Migración 07 — Establecimiento y punto de emisión del emisor
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente.
--
-- Hasta ahora todo se emitía como 001-001 porque no había dónde configurarlo.
-- El establecimiento y el punto de emisión son los que el SRI tiene registrados
-- para el contribuyente: emitir con otros hace que rechace el comprobante.
--
-- OJO con el secuencial. Cada combinación (tipo, establecimiento, punto) lleva
-- su propia numeración y el SRI rechaza un número ya autorizado. Si el punto
-- que vas a usar ya venía facturando con otro sistema, hay que decirle desde
-- qué número seguir — se hace desde Facturación → Configuración, o con el
-- UPDATE de ejemplo que está al final de este archivo.
-- =============================================================================

ALTER TABLE sri_config
    ADD COLUMN IF NOT EXISTS establecimiento VARCHAR(3) NOT NULL DEFAULT '001',
    ADD COLUMN IF NOT EXISTS punto_emision   VARCHAR(3) NOT NULL DEFAULT '001';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sri_config_establecimiento_check') THEN
        ALTER TABLE sri_config
            ADD CONSTRAINT sri_config_establecimiento_check CHECK (establecimiento ~ '^[0-9]{3}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sri_config_punto_emision_check') THEN
        ALTER TABLE sri_config
            ADD CONSTRAINT sri_config_punto_emision_check CHECK (punto_emision ~ '^[0-9]{3}$');
    END IF;
END $$;

COMMENT ON COLUMN sri_config.punto_emision IS
    'Punto de emisión registrado en el SRI. Cada punto lleva su propia numeración: cambiarlo arranca una secuencia nueva.';


-- =============================================================================
-- Secuencial de un punto que ya venía facturando
-- =============================================================================
-- Descomentá y ajustá si el punto que vas a usar ya emitió comprobantes con
-- otro sistema. `ultimo_numero` es el ÚLTIMO usado: si la última factura fue la
-- 000000827, va 827 y la próxima sale 828.
--
-- INSERT INTO sri_sequences (tipo_doc, establecimiento, punto_emision, ultimo_numero)
-- VALUES ('01', '001', '002', 827)
-- ON CONFLICT (tipo_doc, establecimiento, punto_emision)
-- DO UPDATE SET ultimo_numero = EXCLUDED.ultimo_numero;
