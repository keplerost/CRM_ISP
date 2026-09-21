-- =============================================================================
-- Migración 10 — Ficha del cliente: ubicación, instalaciones y contratos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_clientes_ficha`,
-- `v_instalaciones` y `v_contratos` se redefinió en la 37, la 91 y la 11, con
-- más columnas. Reemplazar esa versión por la de acá dejaría a las pantallas
-- sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- La ficha del abonado necesita más de lo que se importó del MikroTik. Tres
-- cosas nuevas:
--
--   * Datos de contacto que hoy no tienen dónde ir (celular, código de pago) y
--     la ubicación en el mapa.
--   * Las instalaciones: cuándo se fue a la casa, quién fue y qué se hizo.
--   * Los contratos: qué firmó, por cuánto y hasta cuándo.
-- =============================================================================

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS telefono_movil VARCHAR(30),
    -- Código con el que el abonado paga en ventanilla o botón de pago.
    ADD COLUMN IF NOT EXISTS codigo_pago    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS clave_ppp      VARCHAR(100),
    ADD COLUMN IF NOT EXISTS latitud        NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS longitud       NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS notas          TEXT;

COMMENT ON COLUMN clientes.clave_ppp IS
    'Clave del usuario PPPoE. Va en claro porque el RouterOS la guarda así y hay que poder dictarla al configurar el equipo del abonado.';

COMMENT ON COLUMN clientes.latitud IS
    'Ubicación del domicilio. Sin esto el cliente no aparece en el mapa.';

-- El mapa pide "todos los que tienen coordenadas": el índice parcial evita
-- recorrer la tabla entera cuando la mayoría todavía no está geolocalizada.
CREATE INDEX IF NOT EXISTS idx_clientes_ubicacion
    ON clientes (latitud, longitud) WHERE latitud IS NOT NULL AND longitud IS NOT NULL;


-- =============================================================================
-- Instalaciones
-- =============================================================================
-- Cada visita al domicilio: el alta, un traslado, una reparación. Es lo que
-- permite saber si a un cliente ya se le fue tres veces por el mismo problema.
CREATE TABLE IF NOT EXISTS instalaciones (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id    UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    tipo         VARCHAR(20) NOT NULL DEFAULT 'nueva'
                 CHECK (tipo IN ('nueva', 'traslado', 'reparacion', 'retiro', 'revision')),
    estado       VARCHAR(20) NOT NULL DEFAULT 'agendada'
                 CHECK (estado IN ('agendada', 'en_curso', 'hecha', 'cancelada')),

    fecha        DATE NOT NULL DEFAULT CURRENT_DATE,
    hora         TIME,
    tecnico      VARCHAR(150),

    -- Lo que se dejó puesto. El ONU vive en su propia tabla; acá queda el rastro
    -- de qué se instaló en esta visita, aunque después el equipo se cambie.
    onu_id       UUID REFERENCES onus(id) ON DELETE SET NULL,
    equipo       VARCHAR(150),
    metros_cable INT CHECK (metros_cable IS NULL OR metros_cable >= 0),
    costo        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (costo >= 0),

    direccion    VARCHAR(300),
    latitud      NUMERIC(10,7),
    longitud     NUMERIC(10,7),

    notas        TEXT,
    created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instalaciones_cliente ON instalaciones (client_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_instalaciones_agenda  ON instalaciones (estado, fecha);


-- =============================================================================
-- Contratos
-- =============================================================================
CREATE TABLE IF NOT EXISTS contratos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    numero        VARCHAR(30),
    plan_id       UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,

    fecha_inicio  DATE NOT NULL DEFAULT CURRENT_DATE,
    -- Vacío = sin plazo: sigue vigente hasta que alguien lo termine.
    fecha_fin     DATE,
    permanencia_meses INT CHECK (permanencia_meses IS NULL OR permanencia_meses >= 0),

    precio_mensual NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (precio_mensual >= 0),
    dia_pago      INT CHECK (dia_pago IS NULL OR dia_pago BETWEEN 1 AND 28),

    estado        VARCHAR(15) NOT NULL DEFAULT 'vigente'
                  CHECK (estado IN ('vigente', 'terminado', 'anulado', 'suspendido')),

    -- Dónde quedó el papel firmado (Drive, carpeta compartida, lo que usen).
    documento_url TEXT,
    notas         TEXT,

    created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contratos_cliente ON contratos (client_id, fecha_inicio DESC);

-- Un cliente no puede tener dos contratos vigentes: si se le cambia el plan, el
-- anterior se termina. Si no, no hay forma de saber cuál es el precio que rige.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contratos_uno_vigente
    ON contratos (client_id) WHERE estado = 'vigente';

CREATE UNIQUE INDEX IF NOT EXISTS idx_contratos_numero
    ON contratos (numero) WHERE numero IS NOT NULL;


-- =============================================================================
-- Vistas
-- =============================================================================
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `numero`, la cadena siguió y esta versión quedó
     * atrás: la 91 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_instalaciones'
           AND column_name = 'numero'
    ) THEN
        RAISE NOTICE 'v_instalaciones ya está en su versión de la 91: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_instalaciones';
    EXECUTE $vista$
CREATE VIEW v_instalaciones WITH (security_invoker = true) AS
SELECT
    i.*,
    c.nombre AS cliente,
    c.identificacion,
    c.ip,
    o.sn AS onu_serial
FROM instalaciones i
LEFT JOIN clientes c ON c.id = i.client_id
LEFT JOIN onus o     ON o.id = i.onu_id
$vista$;
END $guarda$;

DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `firma_estado`, la cadena siguió y esta versión quedó
     * atrás: la 11 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_contratos'
           AND column_name = 'vencido'
    ) THEN
        RAISE NOTICE 'v_contratos ya está en su versión de la 11: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_contratos';
    EXECUTE $vista$
CREATE VIEW v_contratos WITH (security_invoker = true) AS
SELECT
    ct.*,
    c.nombre AS cliente,
    c.identificacion,
    c.estado AS estado_cliente,
    p.nombre AS plan,
    p.bajada_kbps,
    p.subida_kbps,
    (ct.estado = 'vigente' AND ct.fecha_fin IS NOT NULL AND ct.fecha_fin < CURRENT_DATE) AS vencido
FROM contratos ct
LEFT JOIN clientes c          ON c.id = ct.client_id
LEFT JOIN planes_velocidad p  ON p.id = ct.plan_id
$vista$;
END $guarda$;

/**
 * Ficha del cliente con lo que se muestra alrededor: plan, router, ONU y deuda.
 * Se arma acá para que la pantalla no tenga que encadenar seis consultas.
 */
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
    o.sn AS onu_serial,
    o.estado  AS onu_estado,
    o.rx_power_dbm,
    COALESCE(s.saldo, 0)              AS saldo,
    COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
    s.ultimo_pago,
    ct.id     AS contrato_id,
    ct.numero AS contrato_numero,
    ct.precio_mensual AS contrato_precio
FROM clientes c
LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
LEFT JOIN routers_mikrotik r   ON r.id = c.router_id
LEFT JOIN onus o               ON o.id = c.onu_id
LEFT JOIN v_saldo_clientes s   ON s.client_id = c.id
LEFT JOIN contratos ct         ON ct.client_id = c.id AND ct.estado = 'vigente'
$vista$;
END $guarda$;


-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE instalaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE contratos     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['instalaciones', 'contratos']
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
DROP TRIGGER IF EXISTS trg_instalaciones_updated_at ON instalaciones;
CREATE TRIGGER trg_instalaciones_updated_at
    BEFORE UPDATE ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();

DROP TRIGGER IF EXISTS trg_contratos_updated_at ON contratos;
CREATE TRIGGER trg_contratos_updated_at
    BEFORE UPDATE ON contratos
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();
