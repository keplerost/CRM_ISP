-- =============================================================================
-- Migración 13 — Cobrar hoy, facturar al cierre
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 12.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_pagos_por_facturar` se
-- redefinió en la 25, con más columnas. Reemplazar esa versión por la de acá
-- dejaría a las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Cobrar y facturar son dos momentos distintos:
--
--   * En el mostrador se registra la plata que entró. Ahí se tipea el número de
--     comprobante del banco y a veces sale mal.
--   * Al cierre de la jornada alguien revisa esa lista, corrige lo que esté
--     mal y recién entonces manda las facturas al SRI.
--
-- Entre los dos momentos hay una cola: los cobros que todavía no tienen
-- comprobante emitido. Y no todos van a esa cola — hay abonados que no quieren
-- factura y se llevan solo el recibo.
-- =============================================================================

-- A quién se le emite comprobante electrónico.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS factura_electronica BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN clientes.factura_electronica IS
    'Si sus cobros generan factura electrónica. En falso solo se le entrega el recibo.';

-- Sin identificación el SRI no acepta el comprobante: esos clientes arrancan
-- fuera de la cola hasta que alguien complete el dato.
UPDATE clientes SET factura_electronica = FALSE WHERE identificacion IS NULL;


-- Si este cobro concreto debe facturarse. Se copia del cliente al registrarlo,
-- pero se decide cobro por cobro: el mismo abonado puede pedir factura un mes y
-- no pedirla al siguiente.
ALTER TABLE pagos
    ADD COLUMN IF NOT EXISTS facturar BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN pagos.facturar IS
    'El cobro tiene que generar una factura electrónica. Sale de la cola cuando se le asigna document_id.';

CREATE INDEX IF NOT EXISTS idx_pagos_por_facturar
    ON pagos (fecha_pago) WHERE facturar AND document_id IS NULL AND NOT anulado;


-- =============================================================================
-- La cola: cobros que esperan comprobante
-- =============================================================================
-- Un cobro sale de la cola cuando se le asigna la factura que lo respalda. No
-- hace falta un estado aparte: `document_id IS NULL` ya lo dice, y un estado
-- duplicado sería una cosa más que puede quedar desincronizada.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `subtotal_factura`, la cadena siguió y esta versión quedó
     * atrás: la 25 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_pagos_por_facturar'
           AND column_name = 'subtotal_factura'
    ) THEN
        RAISE NOTICE 'v_pagos_por_facturar ya está en su versión de la 25: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_pagos_por_facturar';
    EXECUTE $vista$
CREATE VIEW v_pagos_por_facturar WITH (security_invoker = true) AS
SELECT
    p.id,
    p.numero,
    p.client_id,
    p.cliente_nombre,
    p.monto,
    p.comision,
    p.forma_pago,
    p.n_transaccion,
    p.cuenta_id,
    p.fecha_pago,
    p.notas,
    c.nombre          AS cliente,
    c.identificacion,
    c.tipo_identificacion,
    c.email,
    c.direccion,
    c.precio_mensual,
    c.descripcion_servicio,
    c.factura_electronica,
    pl.nombre         AS plan,
    pl.codigo_facturacion,
    cu.nombre         AS cuenta,
    -- Lo que impediría emitir: el SRI rechaza sin identificación del comprador.
    (c.identificacion IS NULL OR c.identificacion = '') AS falta_identificacion
FROM pagos p
LEFT JOIN clientes c          ON c.id = p.client_id
LEFT JOIN planes_velocidad pl ON pl.id = c.plan_id
LEFT JOIN cuentas_pago cu     ON cu.id = p.cuenta_id
WHERE p.facturar
  AND p.document_id IS NULL
  AND NOT p.anulado
$vista$;
END $guarda$;

COMMENT ON VIEW v_pagos_por_facturar IS
    'Cobros marcados para facturar que todavía no tienen comprobante. Es la bandeja del cierre de jornada.';
