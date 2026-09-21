-- =============================================================================
-- Migración 09 — Número de recibo y promesas que habilitan el servicio
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 08.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_pagos`, `v_promesas_pago` y
-- `v_promesas_a_cortar` se redefinió en la 24 y la 19, con más columnas.
-- Reemplazar esa versión por la de acá dejaría a las pantallas sin lo que hoy
-- usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Dos cosas:
--
-- 1. El recibo que se le entrega al abonado necesita un número corto y propio.
--    El UUID del pago sirve para la base, no para que alguien lo mencione por
--    teléfono cuando reclama.
-- 2. Una promesa de pago puede reactivar el servicio hasta la fecha acordada.
--    Hay que saber cuáles lo hicieron, para poder volver a cortar a quien no
--    cumplió.
-- =============================================================================

-- BIGSERIAL numera también las filas que ya existan, en el orden en que están.
ALTER TABLE pagos
    ADD COLUMN IF NOT EXISTS numero BIGSERIAL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_numero ON pagos (numero);

COMMENT ON COLUMN pagos.numero IS
    'Número corto del recibo, para que el abonado pueda citarlo. No tiene valor tributario: eso es la factura.';

ALTER TABLE promesas_pago
    ADD COLUMN IF NOT EXISTS activo_servicio BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN promesas_pago.activo_servicio IS
    'La promesa reactivó el servicio hasta fecha_promesa. Si vence sin pago, corresponde volver a cortar.';


-- =============================================================================
-- Vistas
-- =============================================================================
-- Hay que recrearlas: `SELECT p.*` se expande a la lista de columnas del
-- momento en que la vista se creó, así que una columna nueva no aparece sola.
-- Se borran y se vuelven a crear porque CREATE OR REPLACE no admite cambios en
-- el orden de las columnas.
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
    p.monto - p.comision AS neto
FROM pagos p
LEFT JOIN clientes c              ON c.id  = p.client_id
LEFT JOIN cuentas_pago cu         ON cu.id = p.cuenta_id
LEFT JOIN electronic_documents d  ON d.id  = p.document_id
$vista$;
END $guarda$;


DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `factura_id`, la cadena siguió y esta versión quedó
     * atrás: la 19 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_promesas_pago'
           AND column_name = 'factura_id'
    ) THEN
        RAISE NOTICE 'v_promesas_pago ya está en su versión de la 19: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_promesas_pago';
    EXECUTE $vista$
CREATE VIEW v_promesas_pago WITH (security_invoker = true) AS
SELECT
    pr.*,
    c.nombre AS cliente,
    c.identificacion,
    c.ip,
    c.estado AS estado_cliente,
    c.router_id,
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante,
    (pr.estado = 'activa' AND pr.fecha_promesa < CURRENT_DATE) AS vencida,
    pr.fecha_promesa - CURRENT_DATE AS dias_restantes
FROM promesas_pago pr
LEFT JOIN clientes c             ON c.id = pr.client_id
LEFT JOIN electronic_documents d ON d.id = pr.document_id
$vista$;
END $guarda$;


-- =============================================================================
-- A quién corresponde volver a cortar
-- =============================================================================
-- Una promesa vencida que había habilitado el servicio deja al abonado
-- conectado sin haber pagado. Esta vista es la lista de trabajo de quien corta:
-- sin ella, reactivar por una promesa sería una fuga silenciosa.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `factura_id`, la cadena siguió y esta versión quedó
     * atrás: la 19 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_promesas_a_cortar'
           AND column_name = 'factura_id'
    ) THEN
        RAISE NOTICE 'v_promesas_a_cortar ya está en su versión de la 19: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_promesas_a_cortar';
    EXECUTE $vista$
CREATE VIEW v_promesas_a_cortar WITH (security_invoker = true) AS
SELECT *
FROM v_promesas_pago
WHERE vencida AND activo_servicio AND estado_cliente = 'activo'
$vista$;
END $guarda$;

COMMENT ON VIEW v_promesas_a_cortar IS
    'Promesas vencidas que habían reactivado el servicio y el cliente sigue activo.';
