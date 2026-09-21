-- =============================================================================
-- Migración 25 — Descuentos: grupo prioritario y promociones por tiempo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 24.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_clientes_ficha` y la cadena
-- de facturación se redefinió en la 37, con más columnas. Reemplazar esa
-- versión por la de acá dejaría a las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Dos descuentos distintos, que no se parecen en nada salvo en que restan:
--
-- 1. El que manda la ley. Tercera edad y discapacidad tienen derecho al 50%
--    sobre el servicio básico, y no vence: mientras el abonado sea esa persona,
--    el descuento va. El porcentaje queda configurable porque la norma cambia y
--    porque en discapacidad puede escalonarse según el grado.
--
-- 2. La promoción comercial. Es una oferta con fecha de vencimiento: tantos
--    meses al tanto por ciento, y al terminar se vuelve al precio de lista sin
--    que nadie tenga que acordarse. Es para el abonado que no pertenece a
--    ningún grupo prioritario.
--
-- No se acumulan. Si el abonado tiene derecho por ley, ese manda: darle además
-- la promoción sería regalar dos veces lo mismo, y quitarle el de ley para
-- darle el comercial sería ilegal.
-- =============================================================================

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS descuento_tipo TEXT,
    ADD COLUMN IF NOT EXISTS descuento_porcentaje NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS descuento_documento TEXT,
    ADD COLUMN IF NOT EXISTS promo_porcentaje NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS promo_meses INTEGER,
    ADD COLUMN IF NOT EXISTS promo_desde DATE;

-- Un tipo que la generación mensual no conozca dejaría al abonado sin su
-- descuento sin que nadie se entere.
ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_descuento_tipo_check;
ALTER TABLE clientes
    ADD CONSTRAINT clientes_descuento_tipo_check
    CHECK (descuento_tipo IS NULL OR descuento_tipo IN ('tercera_edad', 'discapacidad'));

ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_descuento_pct_check;
ALTER TABLE clientes
    ADD CONSTRAINT clientes_descuento_pct_check
    CHECK (descuento_porcentaje IS NULL OR (descuento_porcentaje >= 0 AND descuento_porcentaje <= 100));

ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_promo_pct_check;
ALTER TABLE clientes
    ADD CONSTRAINT clientes_promo_pct_check
    CHECK (promo_porcentaje IS NULL OR (promo_porcentaje >= 0 AND promo_porcentaje <= 100));

COMMENT ON COLUMN clientes.descuento_tipo IS
    'Grupo prioritario que le da derecho al descuento de ley: tercera_edad o discapacidad. NULL = no aplica.';
COMMENT ON COLUMN clientes.descuento_porcentaje IS
    'Porcentaje del descuento de ley. Por norma es 50; queda configurable porque puede escalonarse.';
COMMENT ON COLUMN clientes.descuento_documento IS
    'Respaldo del descuento: carnet del CONADIS, cédula del adulto mayor. Es lo que se muestra si ARCOTEL lo pide.';
COMMENT ON COLUMN clientes.promo_porcentaje IS
    'Descuento comercial por tiempo limitado. No se acumula con el de ley.';
COMMENT ON COLUMN clientes.promo_meses IS
    'Cuántos meses dura la promoción desde promo_desde. Al vencer se factura el precio de lista solo.';


-- =============================================================================
-- La factura guarda cuánto se descontó y por qué
-- =============================================================================
-- Sin esto el descuento sería invisible: la factura diría $17.25 y no habría
-- forma de mostrarle al abonado —ni a ARCOTEL— que son $34.50 menos el 50% que
-- le corresponde.
--
-- `subtotal` pasa a ser la base COMPLETA, antes del descuento, para que la suma
-- del papel cierre: subtotal − descuento + impuesto = total. En las facturas
-- que ya existen el descuento es 0 y nada cambia.
ALTER TABLE facturas
    ADD COLUMN IF NOT EXISTS descuento NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS descuento_motivo TEXT;

COMMENT ON COLUMN facturas.descuento IS
    'Lo descontado sobre la base imponible. El motivo va al lado: es lo que justifica el descuento ante ARCOTEL.';


-- =============================================================================
-- Las vistas vuelven a armarse
-- =============================================================================
-- `v_facturas` y `v_clientes_ficha` se definen con `f.*` y `c.*`, y esa lista
-- queda congelada al crearlas: las columnas nuevas existen en las tablas y no
-- aparecerían en las vistas. Se sueltan en orden inverso al de dependencia —sin
-- CASCADE, que borraría en silencio lo que no se pensaba tocar— y se rehacen.
DO $sueltan$
BEGIN
    /**
     * Estas cinco se sueltan en orden inverso porque cuelgan una de otra, y
     * después se rehacen todas. Pero si `v_clientes_ficha` ya tiene `plan_tipo_impuesto`, la cadena
     * llegó hasta la 37 y toda esta sección quedó atrás: soltarlas ahora se
     * llevaría puestas las versiones buenas y las vistas que se apoyan en ellas.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_promesas_a_cortar';
    EXECUTE 'DROP VIEW IF EXISTS v_clientes_ficha';
    EXECUTE 'DROP VIEW IF EXISTS v_saldo_clientes';
    EXECUTE 'DROP VIEW IF EXISTS v_facturas_por_cobrar';
    EXECUTE 'DROP VIEW IF EXISTS v_facturas';
END $sueltan$;

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
         -- El marcador de esta sección vive en `v_clientes_ficha`: es la
         -- vista de la cadena que la 37 dejó con columnas nuevas.
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'v_facturas ya está en su versión de la 37: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_facturas';
    EXECUTE $vista$
CREATE VIEW v_facturas WITH (security_invoker = true) AS
SELECT
    f.*,
    COALESCE(c.nombre, f.cliente_nombre) AS cliente,
    c.identificacion,
    c.dias_gracia,
    COALESCE(pg.pagado, 0)               AS pagado,
    f.total - COALESCE(pg.pagado, 0)     AS saldo,
    pg.ultimo_pago,
    pg.formas_pago,
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_fiscal,
    d.estado    AS estado_sri,
    d.clave_acceso,
    CASE
        WHEN f.anulada THEN 'anulada'
        WHEN f.total - COALESCE(pg.pagado, 0) <= 0.005 THEN 'pagada'
        WHEN CURRENT_DATE > f.fecha_vencimiento + COALESCE(c.dias_gracia, 0) THEN 'vencida'
        ELSE 'pendiente'
    END AS estado
FROM facturas f
LEFT JOIN clientes c ON c.id = f.client_id
LEFT JOIN electronic_documents d ON d.id = f.document_id
LEFT JOIN (
    SELECT factura_id,
           SUM(monto)          AS pagado,
           MAX(fecha_pago)     AS ultimo_pago,
           STRING_AGG(DISTINCT forma_pago, ', ') AS formas_pago
    FROM pagos
    WHERE NOT anulado AND factura_id IS NOT NULL
    GROUP BY factura_id
) pg ON pg.factura_id = f.id
$vista$;
END $guarda$;

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
         -- El marcador de esta sección vive en `v_clientes_ficha`: es la
         -- vista de la cadena que la 37 dejó con columnas nuevas.
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'v_facturas_por_cobrar ya está en su versión de la 37: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_facturas_por_cobrar';
    EXECUTE $vista$
CREATE VIEW v_facturas_por_cobrar WITH (security_invoker = true) AS
SELECT
    f.id,
    f.client_id,
    LPAD(f.numero::TEXT, 8, '0') AS numero,
    f.numero_fiscal,
    f.fecha_emision,
    f.fecha_vencimiento,
    f.cliente     AS razon_social_comprador,
    f.total       AS importe_total,
    f.pagado,
    f.saldo,
    f.concepto,
    f.estado,
    f.tipo
FROM v_facturas f
WHERE NOT f.anulada
  AND f.saldo > 0.005
$vista$;
END $guarda$;

COMMENT ON VIEW v_facturas_por_cobrar IS
    'Facturas del sistema con saldo. Es lo que se ofrece al cobrar y lo que define quién debe.';

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
         -- El marcador de esta sección vive en `v_clientes_ficha`: es la
         -- vista de la cadena que la 37 dejó con columnas nuevas.
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'v_saldo_clientes ya está en su versión de la 37: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_saldo_clientes';
    EXECUTE $vista$
CREATE VIEW v_saldo_clientes WITH (security_invoker = true) AS
SELECT
    c.id                                  AS client_id,
    c.nombre,
    c.identificacion,
    c.estado,
    COALESCE(f.facturas, 0)               AS facturas_pendientes,
    COALESCE(f.saldo, 0)                  AS saldo,
    COALESCE(pg.total_pagado, 0)          AS total_pagado,
    pg.ultimo_pago
FROM clientes c
LEFT JOIN (
    SELECT client_id, COUNT(*) AS facturas, SUM(saldo) AS saldo
    FROM v_facturas_por_cobrar
    GROUP BY client_id
) f ON f.client_id = c.id
LEFT JOIN (
    SELECT client_id, SUM(monto) AS total_pagado, MAX(fecha_pago) AS ultimo_pago
    FROM pagos WHERE NOT anulado
    GROUP BY client_id
) pg ON pg.client_id = c.id
$vista$;
END $guarda$;

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
    o.causa_caida,
    nap.nombre AS nap,
    ap.nombre  AS conectado_a,
    COALESCE(s.saldo, 0)               AS saldo,
    COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
    s.ultimo_pago,
    ct.id     AS contrato_id,
    ct.numero AS contrato_numero,
    ct.precio_mensual AS contrato_precio,
    -- Hasta cuándo corre la promoción. Se calcula acá para que la pantalla no
    -- tenga que repetir la cuenta y para poder listar las que están por vencer.
    CASE
        WHEN c.promo_desde IS NOT NULL AND COALESCE(c.promo_meses, 0) > 0
        THEN (c.promo_desde + MAKE_INTERVAL(months => c.promo_meses))::DATE
    END AS promo_hasta
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
         -- El marcador de esta sección vive en `v_clientes_ficha`: es la
         -- vista de la cadena que la 37 dejó con columnas nuevas.
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'v_promesas_a_cortar ya está en su versión de la 37: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_promesas_a_cortar';
    EXECUTE $vista$
CREATE VIEW v_promesas_a_cortar WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.client_id) p.*
FROM v_promesas_pago p
LEFT JOIN v_saldo_clientes s ON s.client_id = p.client_id
WHERE p.activo_servicio
  AND p.estado_cliente = 'activo'
  AND COALESCE(s.saldo, 0) > 0
  AND ((p.estado = 'activa' AND p.vencida) OR p.estado = 'incumplida')
ORDER BY p.client_id, p.fecha_promesa DESC
$vista$;
END $guarda$;

COMMENT ON VIEW v_promesas_a_cortar IS
    'Clientes habilitados por una promesa que vencieron sin pagar o pagaron de menos, siguen activos y deben.';


-- =============================================================================
-- La cola del SRI lleva el descuento
-- =============================================================================
-- El comprobante tiene que mostrar el precio de lista y el descuento aparte. Si
-- solo mostrara el importe ya rebajado, el abonado con derecho no tendría cómo
-- probar que se lo aplicaron.
CREATE OR REPLACE VIEW v_pagos_por_facturar WITH (security_invoker = true) AS
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
    (c.identificacion IS NULL OR c.identificacion = '') AS falta_identificacion,
    p.factura_id,
    LPAD(f.numero::TEXT, 8, '0') AS numero_factura,
    f.concepto        AS concepto_factura,
    f.periodo_desde,
    f.periodo_hasta,
    COALESCE(f.total, p.monto) AS total_facturar,
    COALESCE(f.subtotal, 0)    AS subtotal_factura,
    COALESCE(f.descuento, 0)   AS descuento_factura,
    f.descuento_motivo
FROM pagos p
LEFT JOIN clientes c          ON c.id = p.client_id
LEFT JOIN planes_velocidad pl ON pl.id = c.plan_id
LEFT JOIN cuentas_pago cu     ON cu.id = p.cuenta_id
LEFT JOIN facturas f          ON f.id = p.factura_id
WHERE p.facturar
  AND p.document_id IS NULL
  AND NOT p.anulado;
