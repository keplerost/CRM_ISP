-- =============================================================================
-- Migración 22 — La vista de pagos toma la columna del excedente
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 21. Es idempotente.
--
-- La 21 le agregó `es_excedente` a `pagos`, pero `v_pagos` se creó con
-- `SELECT p.*` y esa lista quedó congelada al momento de crearse. Resultado: la
-- columna existe en la tabla y no aparece en la vista, así que la pantalla de
-- transacciones no puede distinguir un cobro real de un excedente y los mostraba
-- todos igual.
--
-- Es la cuarta vez que pasa lo mismo. La regla, para la próxima: toda migración
-- que agregue una columna a una tabla tiene que recrear las vistas que la leen
-- con `*`.
-- =============================================================================

DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `es_reparto`, la cadena siguió y esta versión quedó
     * atrás: la 24 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_pagos'
           AND column_name = 'es_reparto'
    ) THEN
        RAISE NOTICE 'v_pagos ya está en su versión de la 24: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_pagos';
    EXECUTE $vista$
CREATE VIEW v_pagos WITH (security_invoker = true) AS
SELECT
    p.*,
    COALESCE(c.nombre, p.cliente_nombre) AS cliente,
    c.identificacion,
    c.ip,
    c.estado AS estado_cliente,
    cu.nombre AS cuenta,
    cu.tipo   AS cuenta_tipo,
    LPAD(f.numero::TEXT, 8, '0') AS numero_factura,
    f.concepto,
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante,
    d.importe_total AS total_comprobante,
    d.estado  AS estado_comprobante,
    p.monto - p.comision AS neto
FROM pagos p
LEFT JOIN clientes c              ON c.id  = p.client_id
LEFT JOIN cuentas_pago cu         ON cu.id = p.cuenta_id
LEFT JOIN facturas f              ON f.id  = p.factura_id
LEFT JOIN electronic_documents d  ON d.id  = p.document_id
$vista$;
END $guarda$;
