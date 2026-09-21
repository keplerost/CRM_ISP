-- =============================================================================
-- Migración 08 — Cobros: pagos, cuentas y promesas de pago
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_pagos`,
-- `v_facturas_por_cobrar` y `v_promesas_pago` se redefinió en la 24 y la 19,
-- con más columnas. Reemplazar esa versión por la de acá dejaría a las
-- pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Facturar y cobrar son cosas distintas. La factura la exige el SRI; el pago es
-- del negocio: quién pagó, cuánto, por qué medio, a qué cuenta entró y qué
-- factura queda saldada. Sin esto último no se puede saber quién debe, que es
-- justo lo que decide a quién se le corta el servicio.
-- =============================================================================


-- =============================================================================
-- Cuentas donde entra la plata
-- =============================================================================
-- La caja de la oficina es una cuenta más: así un arqueo de caja y una
-- conciliación bancaria se resuelven con la misma consulta.
CREATE TABLE IF NOT EXISTS cuentas_pago (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      VARCHAR(100) NOT NULL UNIQUE,
    tipo        VARCHAR(20) NOT NULL DEFAULT 'banco'
                CHECK (tipo IN ('efectivo', 'banco', 'billetera', 'otro')),
    banco       VARCHAR(100),
    numero      VARCHAR(50),
    titular     VARCHAR(150),
    activa      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO cuentas_pago (nombre, tipo, titular) VALUES
    ('Caja Oficina', 'efectivo', NULL)
ON CONFLICT (nombre) DO NOTHING;


-- =============================================================================
-- Pagos
-- =============================================================================
CREATE TABLE IF NOT EXISTS pagos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- El cliente se conserva aunque se borre su ficha: un cobro es un hecho
    -- contable y no puede desaparecer con el registro del abonado.
    client_id     UUID REFERENCES clientes(id) ON DELETE SET NULL,
    cliente_nombre VARCHAR(150),

    -- Contra qué factura se aplica. Puede ir vacío: un abono a cuenta o un
    -- cobro adelantado todavía no tiene comprobante.
    document_id   UUID REFERENCES electronic_documents(id) ON DELETE SET NULL,
    cuenta_id     UUID REFERENCES cuentas_pago(id) ON DELETE SET NULL,

    monto         NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    -- Lo que retiene el intermediario. Entra menos plata de la que paga el
    -- cliente, y la deuda se cancela igual: por eso va aparte del monto.
    comision      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (comision >= 0),

    forma_pago    VARCHAR(20) NOT NULL DEFAULT 'efectivo'
                  CHECK (forma_pago IN ('efectivo', 'transferencia', 'deposito', 'tarjeta', 'otro')),
    n_transaccion VARCHAR(60),

    fecha_pago    DATE NOT NULL DEFAULT CURRENT_DATE,
    notas         TEXT,

    -- Si el cobro reactivó el servicio. Queda registrado para poder revisar
    -- después por qué un cliente cortado aparece habilitado.
    activo_servicio BOOLEAN NOT NULL DEFAULT FALSE,

    -- Un pago no se borra: se anula y queda el rastro de quién y por qué.
    anulado       BOOLEAN NOT NULL DEFAULT FALSE,
    motivo_anulacion TEXT,
    anulado_at    TIMESTAMP WITH TIME ZONE,

    created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pagos_cliente ON pagos (client_id, fecha_pago DESC);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha   ON pagos (fecha_pago DESC);
CREATE INDEX IF NOT EXISTS idx_pagos_doc     ON pagos (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pagos_cuenta  ON pagos (cuenta_id, fecha_pago DESC);

COMMENT ON COLUMN pagos.comision IS
    'Retención del intermediario. El cliente cancela `monto`; a la cuenta entra monto - comision.';


-- =============================================================================
-- Promesas de pago
-- =============================================================================
-- "Pagame el viernes y no me cortes". Sin registrarla, esa conversación se
-- pierde y el cliente aparece cortado al día siguiente.
CREATE TABLE IF NOT EXISTS promesas_pago (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    document_id   UUID REFERENCES electronic_documents(id) ON DELETE SET NULL,

    monto         NUMERIC(12,2) CHECK (monto IS NULL OR monto > 0),
    fecha_promesa DATE NOT NULL,

    estado        VARCHAR(15) NOT NULL DEFAULT 'activa'
                  CHECK (estado IN ('activa', 'cumplida', 'incumplida', 'anulada')),
    -- Con qué pago se cumplió, si se cumplió.
    pago_id       UUID REFERENCES pagos(id) ON DELETE SET NULL,

    nota          TEXT,
    created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promesas_cliente ON promesas_pago (client_id, fecha_promesa DESC);
CREATE INDEX IF NOT EXISTS idx_promesas_estado  ON promesas_pago (estado, fecha_promesa);

-- Un cliente no puede tener dos promesas activas a la vez: si vuelve a pedir
-- plazo, se resuelve la anterior primero. Si no, nunca se sabe cuál vale.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promesas_una_activa
    ON promesas_pago (client_id) WHERE estado = 'activa';


-- =============================================================================
-- Lo que cada factura tiene pendiente
-- =============================================================================
-- Una factura puede cobrarse en partes, así que el saldo se calcula sumando
-- los pagos aplicados y no con una marca de "pagada".
--
-- `security_invoker` hace que la vista se ejecute con los permisos de quien
-- consulta y no con los de quien la creó. Sin eso una vista pasa por encima del
-- RLS de las tablas que lee, y los cobros de todos los abonados quedarían al
-- alcance de cualquiera con la clave anónima. (Requiere PostgreSQL 15+.)
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
    d.id,
    d.client_id,
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero,
    d.fecha_emision,
    d.razon_social_comprador,
    d.importe_total,
    COALESCE(p.pagado, 0)                    AS pagado,
    d.importe_total - COALESCE(p.pagado, 0)  AS saldo
FROM electronic_documents d
LEFT JOIN (
    SELECT document_id, SUM(monto) AS pagado
    FROM pagos
    WHERE NOT anulado AND document_id IS NOT NULL
    GROUP BY document_id
) p ON p.document_id = d.id
WHERE d.estado = 'AUTORIZADO'
  -- Medio centavo de tolerancia: el redondeo del IVA no puede dejar facturas
  -- "por cobrar" de $0.00 ensuciando la lista.
  AND d.importe_total - COALESCE(p.pagado, 0) > 0.005
$vista$;
END $guarda$;

COMMENT ON VIEW v_facturas_por_cobrar IS
    'Facturas autorizadas con saldo. Es la fuente del aviso "el cliente tiene N facturas por cobrar".';


-- =============================================================================
-- Pagos con los datos que se muestran en pantalla
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
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante,
    d.importe_total AS total_comprobante,
    p.monto - p.comision AS neto
FROM pagos p
LEFT JOIN clientes c              ON c.id  = p.client_id
LEFT JOIN cuentas_pago cu         ON cu.id = p.cuenta_id
LEFT JOIN electronic_documents d  ON d.id  = p.document_id
$vista$;
END $guarda$;


-- =============================================================================
-- Promesas con el estado real
-- =============================================================================
-- "Vencida" no se guarda: se deduce de la fecha. Guardarlo obligaría a un
-- proceso que corra todos los días para que el dato no mienta.
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
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante,
    (pr.estado = 'activa' AND pr.fecha_promesa < CURRENT_DATE) AS vencida,
    pr.fecha_promesa - CURRENT_DATE AS dias_restantes
FROM promesas_pago pr
LEFT JOIN clientes c             ON c.id = pr.client_id
LEFT JOIN electronic_documents d ON d.id = pr.document_id
$vista$;
END $guarda$;


-- =============================================================================
-- Saldo por cliente
-- =============================================================================
CREATE OR REPLACE VIEW v_saldo_clientes WITH (security_invoker = true) AS
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
) pg ON pg.client_id = c.id;


-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE cuentas_pago  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE promesas_pago ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['cuentas_pago', 'pagos', 'promesas_pago']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "auth_all_%1$s" ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY "auth_all_%1$s" ON %1$I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            t
        );
    END LOOP;
END $$;


-- =============================================================================
-- updated_at automático
-- =============================================================================
DROP TRIGGER IF EXISTS trg_pagos_updated_at ON pagos;
CREATE TRIGGER trg_pagos_updated_at
    BEFORE UPDATE ON pagos
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();

DROP TRIGGER IF EXISTS trg_promesas_updated_at ON promesas_pago;
CREATE TRIGGER trg_promesas_updated_at
    BEFORE UPDATE ON promesas_pago
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();
