-- =============================================================================
-- Migración 11 — Datos del servicio: NAP, radioenlace y PPPoE
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 10.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_clientes_ficha` y
-- `v_puntos_red` se redefinió en la 37 y la 46, con más columnas. Reemplazar
-- esa versión por la de acá dejaría a las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Cuando un abonado se migra de nodo hay que cambiarle la IP, la caja NAP y, si
-- es radioenlace, a qué antena queda conectado. Hoy esos datos no tienen dónde
-- ir y terminan en el comentario o en un cuaderno.
-- =============================================================================


-- =============================================================================
-- Puntos de red: cajas NAP, antenas, torres
-- =============================================================================
-- Una sola tabla para los dos casos. Una caja NAP y un AP de radioenlace son lo
-- mismo desde la ficha del cliente: el punto del que cuelga. Separarlos en dos
-- tablas obligaría a duplicar el ABM y las consultas del mapa.
CREATE TABLE IF NOT EXISTS puntos_red (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre     VARCHAR(100) NOT NULL UNIQUE,
    tipo       VARCHAR(20) NOT NULL DEFAULT 'nap'
               CHECK (tipo IN ('nap', 'antena', 'torre', 'switch', 'otro')),

    -- Cuántos abonados entran. Sirve para saber cuándo una caja está llena.
    capacidad  INT CHECK (capacidad IS NULL OR capacidad > 0),

    direccion  VARCHAR(300),
    latitud    NUMERIC(10,7),
    longitud   NUMERIC(10,7),

    -- De qué OLT/puerto PON baja la caja, cuando aplica.
    olt_id     UUID REFERENCES olts(id) ON DELETE SET NULL,
    puerto_pon VARCHAR(20),

    activo     BOOLEAN NOT NULL DEFAULT TRUE,
    notas      TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_puntos_red_tipo ON puntos_red (tipo, activo);


-- =============================================================================
-- Servicio del abonado
-- =============================================================================
ALTER TABLE clientes
    -- De qué caja NAP cuelga y en qué puerto.
    ADD COLUMN IF NOT EXISTS nap_id       UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS puerto_nap   VARCHAR(20),

    -- Radioenlace: a qué antena apunta y con qué equipo.
    ADD COLUMN IF NOT EXISTS conectado_a_id UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS ip_administracion VARCHAR(45),
    ADD COLUMN IF NOT EXISTS tipo_antena  VARCHAR(50),

    -- Cómo se conecta este abonado. Lo elige quien carga el servicio: un mismo
    -- router puede tener unos por PPPoE y otros con IP fija, así que no se
    -- puede deducir del equipo.
    ADD COLUMN IF NOT EXISTS tipo_conexion VARCHAR(10) NOT NULL DEFAULT 'ip'
                                          CHECK (tipo_conexion IN ('ip', 'pppoe', 'hotspot')),

    -- Direccionamiento
    ADD COLUMN IF NOT EXISTS tipo_ip      VARCHAR(10) NOT NULL DEFAULT 'fija'
                                          CHECK (tipo_ip IN ('fija', 'dinamica')),
    ADD COLUMN IF NOT EXISTS red_ipv4     VARCHAR(50),
    ADD COLUMN IF NOT EXISTS ipv6         VARCHAR(45),
    ADD COLUMN IF NOT EXISTS ipv6_duid    VARCHAR(60),
    ADD COLUMN IF NOT EXISTS rutas        TEXT,

    -- Texto que se usa al facturar este servicio. Admite las mismas variables
    -- que la plantilla del comprobante.
    ADD COLUMN IF NOT EXISTS descripcion_servicio TEXT,

    -- Excluir del corte por mora: clientes institucionales, cámaras, enlaces.
    ADD COLUMN IF NOT EXISTS excluir_firewall BOOLEAN NOT NULL DEFAULT FALSE,

    ADD COLUMN IF NOT EXISTS fecha_instalacion DATE;

COMMENT ON COLUMN clientes.excluir_firewall IS
    'No se le aplica el corte automático por mora. Se usa para enlaces críticos que no pueden cortarse sin autorización.';

COMMENT ON COLUMN clientes.ip_administracion IS
    'IP de la antena o del equipo del cliente, para poder entrar a configurarlo.';

CREATE INDEX IF NOT EXISTS idx_clientes_nap ON clientes (nap_id) WHERE nap_id IS NOT NULL;

-- Dos abonados no pueden ocupar el mismo puerto de la misma caja.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_puerto_nap
    ON clientes (nap_id, puerto_nap)
    WHERE nap_id IS NOT NULL AND puerto_nap IS NOT NULL;


COMMENT ON COLUMN clientes.tipo_conexion IS
    'ip = direccionamiento fijo o por DHCP; pppoe = autentica con usuario y clave; hotspot = portal cautivo. Define qué campos pide la ficha del servicio.';

-- Los que ya tienen usuario PPPoE cargado se marcan como tales: es el dato que
-- prueba cómo se conectan hoy.
UPDATE clientes
   SET tipo_conexion = 'pppoe'
 WHERE usuario_ppp IS NOT NULL AND tipo_conexion = 'ip';


-- =============================================================================
-- Vistas
-- =============================================================================
-- v_clientes_ficha se recrea para que incluya las columnas nuevas: `c.*` se
-- expande cuando la vista se crea, así que una columna agregada después no
-- aparece sola.
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

/** Ocupación de cada caja NAP: cuántos puertos tiene y cuántos están usados. */
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `disponibles`, la cadena siguió y esta versión quedó
     * atrás: la 46 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_puntos_red'
           AND column_name = 'disponibles'
    ) THEN
        RAISE NOTICE 'v_puntos_red ya está en su versión de la 46: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_puntos_red';
    EXECUTE $vista$
CREATE VIEW v_puntos_red WITH (security_invoker = true) AS
SELECT
    pr.*,
    COALESCE(u.clientes, 0) AS clientes,
    CASE
        WHEN pr.capacidad IS NULL THEN NULL
        ELSE pr.capacidad - COALESCE(u.clientes, 0)
    END AS disponibles
FROM puntos_red pr
LEFT JOIN (
    SELECT nap_id, COUNT(*) AS clientes
    FROM clientes
    WHERE nap_id IS NOT NULL
    GROUP BY nap_id
) u ON u.nap_id = pr.id
$vista$;
END $guarda$;


-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE puntos_red ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_puntos_red" ON puntos_red;
CREATE POLICY "auth_all_puntos_red" ON puntos_red
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
