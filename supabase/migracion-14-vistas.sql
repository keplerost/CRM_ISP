-- =============================================================================
-- Migración 14 — Refrescar las vistas con las columnas nuevas
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 13.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_clientes_ficha` y `v_pagos`
-- se redefinió en la 37 y la 24, con más columnas. Reemplazar esa versión por
-- la de acá dejaría a las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- `SELECT c.*` no es dinámico: Postgres lo expande a la lista de columnas que
-- existen en el momento de crear la vista y la deja congelada. Una columna
-- agregada después no aparece sola, así que cada vez que una migración agrega
-- campos hay que recrear las vistas que los muestran.
--
-- Acá se recrean las dos que quedaron atrás:
--   * v_clientes_ficha  → le falta `factura_electronica` (migración 13)
--   * v_pagos           → le falta `facturar` (migración 13)
--
-- Van con DROP y no con CREATE OR REPLACE porque el reemplazo no admite
-- cambios en el orden ni en la cantidad de columnas.
-- =============================================================================

DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `plan_tipo_impuesto`, la cadena siguió y esta versión quedó
     * atrás: la 37 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya está en su versión de la 37: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_clientes_ficha';
    EXECUTE $vista$
CREATE VIEW v_clientes_ficha WITH (security_invoker = true) AS
SELECT
    c.*,
    p.nombre  AS plan,
    p.precio  AS plan_precio,
    p.bajada_kbps,
    p.subida_kbps,
    r.nombre  AS router,
    o.sn      AS onu_serial,
    o.estado  AS onu_estado,
    o.rx_power_dbm,
    nap.nombre AS nap,
    ap.nombre  AS conectado_a,
    COALESCE(s.saldo, 0)               AS saldo,
    COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
    s.ultimo_pago,
    ct.id     AS contrato_id,
    ct.numero AS contrato_numero,
    ct.precio_mensual AS contrato_precio
FROM clientes c
LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
LEFT JOIN routers_mikrotik r   ON r.id = c.router_id
LEFT JOIN onus o               ON o.id = c.onu_id
LEFT JOIN puntos_red nap       ON nap.id = c.nap_id
LEFT JOIN puntos_red ap        ON ap.id = c.conectado_a_id
LEFT JOIN v_saldo_clientes s   ON s.client_id = c.id
LEFT JOIN contratos ct         ON ct.client_id = c.id AND ct.estado = 'vigente'
$vista$;
END $guarda$;


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
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante,
    d.importe_total AS total_comprobante,
    d.estado  AS estado_comprobante,
    p.monto - p.comision AS neto
FROM pagos p
LEFT JOIN clientes c              ON c.id  = p.client_id
LEFT JOIN cuentas_pago cu         ON cu.id = p.cuenta_id
LEFT JOIN electronic_documents d  ON d.id  = p.document_id
$vista$;
END $guarda$;
