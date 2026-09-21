-- =============================================================================
-- Migración 18 — Facturas del sistema, separadas de las del SRI
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 14.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: la cadena de vistas de
-- facturación y `v_clientes_ficha` se redefinió en la 25 y la 37, con más
-- columnas. Reemplazar esa versión por la de acá dejaría a las pantallas sin
-- lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Hasta ahora la deuda salía de los comprobantes autorizados por el SRI. Eso
-- deja afuera a los abonados que no quieren factura electrónica: se les cobra
-- igual, pero el sistema no tiene dónde anotar que deben el mes.
--
-- Son dos cosas distintas y conviene que vivan separadas:
--
--   * `facturas`              — lo que el negocio le cobra al abonado. Existe
--                               siempre, la quiera o no en papel.
--   * `electronic_documents`  — el comprobante fiscal. Existe solo para los que
--                               piden factura, y es la representación de una
--                               factura del sistema ante el SRI.
--
-- El vínculo entre las dos es `facturas.document_id`: el "N° fiscal".
-- =============================================================================


-- =============================================================================
-- Cómo se le factura a cada abonado
-- =============================================================================
ALTER TABLE clientes
    -- Prepago: se cobra el mes por adelantado. Postpago: se cobra al vencer.
    -- Cambia qué período cubre la factura que se emite hoy.
    ADD COLUMN IF NOT EXISTS modalidad_pago VARCHAR(10) NOT NULL DEFAULT 'prepago'
                             CHECK (modalidad_pago IN ('prepago', 'postpago')),

    -- Día en que el sistema crea la factura. Suele ser antes del día de pago,
    -- para que el abonado la reciba con tiempo.
    ADD COLUMN IF NOT EXISTS dia_generar_factura INT
                             CHECK (dia_generar_factura IS NULL OR dia_generar_factura BETWEEN 1 AND 28),

    -- Cómo se trata el precio cargado en el servicio:
    --   incluido → el precio YA tiene IVA y se desglosa hacia atrás
    --   mas      → al precio se le SUMA el IVA
    --   ninguno  → no lleva impuesto
    ADD COLUMN IF NOT EXISTS tipo_impuesto VARCHAR(10) NOT NULL DEFAULT 'incluido'
                             CHECK (tipo_impuesto IN ('incluido', 'mas', 'ninguno')),

    -- Días después del vencimiento antes de cortar.
    ADD COLUMN IF NOT EXISTS dias_gracia INT NOT NULL DEFAULT 0
                             CHECK (dias_gracia >= 0 AND dias_gracia <= 60),

    -- Si entra en los cortes por mora. Un enlace institucional puede quedar
    -- afuera sin depender de que alguien se acuerde de no cortarlo.
    ADD COLUMN IF NOT EXISTS aplicar_corte BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN clientes.tipo_impuesto IS
    'incluido = el precio del servicio ya trae IVA; mas = se le suma; ninguno = exento.';

COMMENT ON COLUMN clientes.dias_gracia IS
    'Días después del vencimiento antes de que corresponda cortar.';


-- =============================================================================
-- Facturas del sistema
-- =============================================================================
CREATE TABLE IF NOT EXISTS facturas (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Número corto y propio, el que ve el abonado en su estado de cuenta.
    numero        BIGSERIAL,

    client_id     UUID REFERENCES clientes(id) ON DELETE SET NULL,
    cliente_nombre VARCHAR(150),

    tipo          VARCHAR(15) NOT NULL DEFAULT 'servicios'
                  CHECK (tipo IN ('servicios', 'libre', 'instalacion', 'otro')),
    concepto      VARCHAR(300) NOT NULL DEFAULT 'Servicio de internet',

    -- Qué período cubre. Es lo que distingue la factura de julio de la de agosto.
    periodo_desde DATE,
    periodo_hasta DATE,

    fecha_emision DATE NOT NULL DEFAULT CURRENT_DATE,
    fecha_vencimiento DATE NOT NULL DEFAULT CURRENT_DATE,

    subtotal      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    impuesto      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (impuesto >= 0),
    total         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),

    -- El comprobante fiscal, cuando se emitió. Es el "N° fiscal" de la pantalla.
    document_id   UUID REFERENCES electronic_documents(id) ON DELETE SET NULL,

    anulada       BOOLEAN NOT NULL DEFAULT FALSE,
    motivo_anulacion TEXT,

    notas         TEXT,
    created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_numero ON facturas (numero);
CREATE INDEX IF NOT EXISTS idx_facturas_cliente ON facturas (client_id, fecha_emision DESC);
CREATE INDEX IF NOT EXISTS idx_facturas_doc ON facturas (document_id) WHERE document_id IS NOT NULL;

-- Una sola factura de servicio por abonado y período: es lo que evita que la
-- generación mensual duplique el cobro si se corre dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_facturas_periodo
    ON facturas (client_id, periodo_desde)
    WHERE tipo = 'servicios' AND NOT anulada AND periodo_desde IS NOT NULL;


-- Los pagos se aplican a una factura del sistema. `document_id` se conserva
-- para no perder el vínculo fiscal de lo ya cobrado.
ALTER TABLE pagos
    ADD COLUMN IF NOT EXISTS factura_id UUID REFERENCES facturas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pagos_factura ON pagos (factura_id) WHERE factura_id IS NOT NULL;


-- =============================================================================
-- Traer lo que ya existe
-- =============================================================================
-- Cada comprobante autorizado pasa a tener su factura del sistema, con el mismo
-- total y apuntando a él. Sin esto, la deuda vieja desaparecería de la pantalla.
INSERT INTO facturas (
    client_id, cliente_nombre, tipo, concepto, fecha_emision, fecha_vencimiento,
    subtotal, impuesto, total, document_id, created_at
)
SELECT
    d.client_id,
    d.razon_social_comprador,
    'servicios',
    'Servicio de internet',
    d.fecha_emision,
    d.fecha_emision,
    d.total_sin_impuestos,
    d.total_iva,
    d.importe_total,
    d.id,
    d.created_at
FROM electronic_documents d
WHERE d.estado = 'AUTORIZADO'
  AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.document_id = d.id);

-- Y los pagos que se habían aplicado a un comprobante pasan a apuntar a su
-- factura.
UPDATE pagos p
   SET factura_id = f.id
  FROM facturas f
 WHERE f.document_id = p.document_id
   AND p.document_id IS NOT NULL
   AND p.factura_id IS NULL;


-- =============================================================================
-- Vistas
-- =============================================================================
-- Se recrean en cadena: `v_saldo_clientes` lee de `v_facturas_por_cobrar`, y de
-- ella cuelgan la ficha del cliente y la lista de cortes. Postgres no deja
-- borrar una vista con dependientes, así que se sueltan en orden inverso y se
-- vuelven a crear todas.
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

-- El estado no se guarda: se deduce del saldo y de la fecha. Guardarlo obligaría
-- a un proceso diario para que "vencida" no mienta.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `descuento_motivo`, la cadena siguió y esta versión quedó
     * atrás: la 25 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_facturas'
           AND column_name = 'descuento_motivo'
    ) THEN
        RAISE NOTICE 'v_facturas ya está en su versión de la 25: no se toca.';
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


-- Lo que se cobra ahora sale de las facturas del sistema, no de los
-- comprobantes: así entra también el abonado que no quiere factura electrónica.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `tipo`, la cadena siguió y esta versión quedó
     * atrás: la 24 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_facturas_por_cobrar'
           AND column_name = 'tipo'
    ) THEN
        RAISE NOTICE 'v_facturas_por_cobrar ya está en su versión de la 24: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_facturas_por_cobrar';
    EXECUTE $vista$
CREATE VIEW v_facturas_por_cobrar WITH (security_invoker = true) AS
SELECT
    f.id,
    f.client_id,
    -- Se sigue llamando `numero` para no romper lo que ya lo usa; ahora es el
    -- número de la factura del sistema, con el fiscal al lado cuando existe.
    LPAD(f.numero::TEXT, 8, '0') AS numero,
    f.numero_fiscal,
    f.fecha_emision,
    f.fecha_vencimiento,
    f.cliente     AS razon_social_comprador,
    f.total       AS importe_total,
    f.pagado,
    f.saldo,
    f.concepto,
    f.estado
FROM v_facturas f
WHERE NOT f.anulada
  AND f.saldo > 0.005
$vista$;
END $guarda$;

COMMENT ON VIEW v_facturas_por_cobrar IS
    'Facturas del sistema con saldo. Es lo que se ofrece al cobrar y lo que define quién debe.';


-- El saldo de cada cliente sale ahora de sus facturas del sistema.
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


-- La ficha del cliente. Al recrearla toma también las columnas agregadas
-- después —`factura_electronica`, la configuración de facturación—, que
-- `SELECT c.*` no incorporaba solo.
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


-- A quién corresponde volver a cortar: prometió, se le habilitó el servicio y
-- venció sin pagar o pagó de menos. Una fila por cliente, la más reciente.
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
-- Las promesas también apuntan a la factura del sistema
-- =============================================================================
-- El disparador que cierra la promesa consulta v_facturas_por_cobrar por id.
-- Como ese id ahora es el de la factura del sistema, una promesa que siguiera
-- apuntando al comprobante fiscal no encontraría nada y se daría por cumplida
-- sin que el abonado pagara.
ALTER TABLE promesas_pago
    ADD COLUMN IF NOT EXISTS factura_id UUID REFERENCES facturas(id) ON DELETE SET NULL;

UPDATE promesas_pago pr
   SET factura_id = f.id
  FROM facturas f
 WHERE f.document_id = pr.document_id
   AND pr.document_id IS NOT NULL
   AND pr.factura_id IS NULL;

CREATE OR REPLACE FUNCTION pago_cierra_promesa()
RETURNS TRIGGER AS $$
DECLARE
    v_promesa promesas_pago%ROWTYPE;
    v_saldo   NUMERIC;
BEGIN
    IF NEW.anulado THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_promesa
      FROM promesas_pago
     WHERE client_id = NEW.client_id
       AND estado = 'activa'
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF v_promesa.factura_id IS NOT NULL THEN
        -- Prometió pagar una factura puntual: manda el saldo de esa factura.
        SELECT COALESCE(SUM(saldo), 0) INTO v_saldo
          FROM v_facturas_por_cobrar
         WHERE id = v_promesa.factura_id;
    ELSE
        SELECT COALESCE(SUM(saldo), 0) INTO v_saldo
          FROM v_facturas_por_cobrar
         WHERE client_id = NEW.client_id;
    END IF;

    UPDATE promesas_pago
       SET estado = CASE WHEN v_saldo <= 0.005 THEN 'cumplida' ELSE 'incumplida' END,
           pago_id = NEW.id
     WHERE id = v_promesa.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- Los pagos muestran a qué factura se aplicaron
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


-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE facturas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_facturas" ON facturas;
CREATE POLICY "auth_all_facturas" ON facturas
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_facturas_updated_at ON facturas;
CREATE TRIGGER trg_facturas_updated_at
    BEFORE UPDATE ON facturas
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();
