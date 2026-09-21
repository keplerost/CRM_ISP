-- =============================================================================
-- Migración 59 — Traer la base de abonados de otro sistema
-- =============================================================================
-- Un ISP que llega desde MikroWisp, SmartOLT o una planilla trae sus clientes
-- con un identificador propio —en MikroWisp es un número correlativo— y con un
-- saldo a favor o en contra.
--
-- Dos cosas hacen falta y no estaban:
--
-- 1. GUARDAR EL IDENTIFICADOR VIEJO. Sin él, importar dos veces crea todo
--    duplicado, y no hay forma de volver a cruzar contra el sistema anterior
--    cuando aparece una diferencia. Es el dato que permite que la migración se
--    corra de nuevo sin miedo.
--
-- 2. EL SALDO NO ES UN CAMPO. Poner "debe 45.20" en una columna del cliente
--    haría que el número exista sin que nada lo explique: no se sabe de qué
--    mes es, no aparece en el estado de cuenta, y el primer pago lo pisa sin
--    dejar rastro. Un saldo que viene de otro sistema es una DEUDA ANTERIOR, y
--    la forma de representarla es una factura de apertura — que se cobra, se
--    cancela y se ve como cualquier otra.
--
-- Por eso acá solo se agrega el identificador y de dónde vino. El saldo se
-- convierte en factura al importar.
-- =============================================================================

ALTER TABLE clientes
    -- El identificador que tenía en el sistema anterior. Puede ser un número
    -- —MikroWisp— o un código; se guarda como texto para no perder ceros a la
    -- izquierda ni prefijos.
    ADD COLUMN IF NOT EXISTS codigo_externo VARCHAR(50),

    -- De qué sistema vino. Dos ISPs fusionados pueden traer el mismo número, y
    -- sin esto el segundo pisaría al primero.
    ADD COLUMN IF NOT EXISTS sistema_origen VARCHAR(30),

    ADD COLUMN IF NOT EXISTS importado_at TIMESTAMPTZ;

-- Un identificador por sistema. Es lo que hace que reimportar actualice en vez
-- de duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_codigo_externo
    ON clientes (sistema_origen, codigo_externo)
    WHERE codigo_externo IS NOT NULL;

COMMENT ON COLUMN clientes.codigo_externo IS
    'El identificador que tenía en el sistema anterior. Permite reimportar sin duplicar y volver a cruzar contra el sistema viejo cuando aparece una diferencia.';


-- El mismo identificador en la factura de apertura, para poder reconocerla.
ALTER TABLE facturas
    ADD COLUMN IF NOT EXISTS origen VARCHAR(20) NOT NULL DEFAULT 'sistema'
        CHECK (origen IN ('sistema', 'migracion', 'manual'));

COMMENT ON COLUMN facturas.origen IS
    'migracion = es el saldo que el abonado traía de su sistema anterior, convertido en factura para que se pueda cobrar y aparezca en el estado de cuenta.';

CREATE INDEX IF NOT EXISTS idx_facturas_origen ON facturas (origen) WHERE origen <> 'sistema';
