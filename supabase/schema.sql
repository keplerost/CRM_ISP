-- =============================================================================
-- TALLER SMARTOLT — Esquema de base de datos (Supabase / PostgreSQL)
-- =============================================================================
-- Ejecutar completo en:  Supabase Dashboard → SQL Editor → New query → Run
--
-- Es idempotente: se puede volver a ejecutar sin romper nada (usa IF NOT EXISTS
-- y DROP POLICY IF EXISTS antes de recrear las policies).
--
-- Fase 1 del taller. Al terminar deberías poder marcar:
--   [x] Las 8 tablas existen en Supabase con RLS activado.
-- =============================================================================

-- pgcrypto da gen_random_uuid(). En Supabase suele venir activada, pero por si acaso:
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =============================================================================
-- 1. OLTs
-- =============================================================================
-- password_encrypted NO guarda la contraseña en claro: guarda el ciphertext que
-- devuelve el middleware en POST /api/crypto/encrypt (AES-256-GCM). El middleware
-- es el único que la desencripta, usando la service_role key para leer esta tabla.
CREATE TABLE IF NOT EXISTS olts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre             VARCHAR(100) NOT NULL,
    marca              VARCHAR(20) NOT NULL CHECK (marca IN ('Huawei', 'VSOL')),
    ip_host            VARCHAR(45) NOT NULL,
    puerto_ssh         INT DEFAULT 22,
    usuario            VARCHAR(50) NOT NULL,
    password_encrypted TEXT NOT NULL,
    -- Password del modo 'enable' de la CLI. Puede ser igual al de login.
    enable_password_encrypted TEXT,
    activo             BOOLEAN DEFAULT TRUE,
    created_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- =============================================================================
-- 2. Routers MikroTik
-- =============================================================================
-- modo_api define cómo se le habla al router:
--   'binaria' → API de RouterOS en 8728 (o 8729 con TLS). Es lo habitual en un
--               ISP: IP pública y puerto de API.
--   'rest'    → REST API v7 sobre HTTP (80) / HTTPS (443). Alternativa para
--               redes donde el 8728 está bloqueado por firewall, que fue el caso
--               de la red del taller (docs/comandos-referencia.md § 3).
CREATE TABLE IF NOT EXISTS routers_mikrotik (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre             VARCHAR(100) NOT NULL,
    ip_host            VARCHAR(45) NOT NULL,
    modo_api           VARCHAR(10) NOT NULL DEFAULT 'binaria' CHECK (modo_api IN ('binaria', 'rest')),
    puerto_api         INT DEFAULT 8728,
    usa_https          BOOLEAN DEFAULT FALSE,   -- api-ssl (8729) o https según el modo
    usuario            VARCHAR(50) NOT NULL,
    password_encrypted TEXT NOT NULL,
    activo             BOOLEAN DEFAULT TRUE,
    created_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- =============================================================================
-- 3. Tipos de ONT / Modelos de ONU
-- =============================================================================
CREATE TABLE IF NOT EXISTS tipos_ont (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    marca            VARCHAR(50) NOT NULL,   -- Huawei, V-SOL, ZTE...
    modelo           VARCHAR(50) NOT NULL,
    puertos_ethernet INT DEFAULT 1,
    puertos_fxs      INT DEFAULT 0,
    wifi             BOOLEAN DEFAULT FALSE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (marca, modelo)
);


-- =============================================================================
-- 4. Line Profiles (perfiles de línea de la OLT)
-- =============================================================================
-- Equivale a:  ont-lineprofile gpon profile-name "<nombre>" / vlan-map <gemport> <vlan>
CREATE TABLE IF NOT EXISTS line_profiles (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id         UUID REFERENCES olts(id) ON DELETE CASCADE,
    nombre         VARCHAR(100) NOT NULL,
    vlan_id        INT NOT NULL CHECK (vlan_id BETWEEN 1 AND 4094),
    gemport_id     INT DEFAULT 1,
    profile_id_olt INT NOT NULL,             -- ID numérico interno en la OLT
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (olt_id, nombre)
);


-- =============================================================================
-- 5. Planes de velocidad (ancho de banda / QoS)
-- =============================================================================
-- Equivale a:  traffic table ip index <idx> name "<nombre>" cir <sub> pir <baj> priority 6
CREATE TABLE IF NOT EXISTS planes_velocidad (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre       VARCHAR(100) NOT NULL UNIQUE,
    bajada_kbps  INT NOT NULL,               -- ej. 100000 = 100 Mbps
    subida_kbps  INT NOT NULL,               -- ej.  50000 =  50 Mbps
    burst_limit  VARCHAR(50),                -- opcional, para MikroTik (ej. "120M/60M")
    precio       NUMERIC(10,2) NOT NULL DEFAULT 0,
    -- index de la traffic table en la OLT Huawei (traffic table ip index N ...)
    traffic_table_index INT,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);


-- =============================================================================
-- 6. ONUs / ONTs
-- =============================================================================
CREATE TABLE IF NOT EXISTS onus (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id          UUID REFERENCES olts(id) ON DELETE CASCADE,
    sn              VARCHAR(50) NOT NULL,
    nombre_cliente  VARCHAR(150),
    frame           INT DEFAULT 0,
    slot            INT NOT NULL DEFAULT 0,
    puerto          INT NOT NULL,
    onu_index       INT NOT NULL,            -- ONT-ID / posición dentro del puerto PON
    -- Vínculos del formulario de aprovisionamiento: Cliente + ONT Type + LineProfile + Plan
    tipo_ont_id     UUID REFERENCES tipos_ont(id) ON DELETE SET NULL,
    line_profile_id UUID REFERENCES line_profiles(id) ON DELETE SET NULL,
    plan_id         UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,
    plan_velocidad  VARCHAR(50),             -- copia textual del plan al momento de dar de alta
    estado          VARCHAR(20) DEFAULT 'offline' CHECK (estado IN ('online', 'offline', 'los', 'unknown')),
    -- Últimas lecturas ópticas cacheadas (la lectura en vivo va por el middleware)
    rx_power_dbm    NUMERIC(5,2),
    tx_power_dbm    NUMERIC(5,2),
    distancia_m     INT,
    ultima_lectura  TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    -- El SN es único por OLT (el mismo SN no puede estar dos veces en la misma OLT)
    UNIQUE (olt_id, sn),
    -- No puede haber dos ONUs con el mismo ONT-ID en el mismo puerto PON
    UNIQUE (olt_id, frame, slot, puerto, onu_index)
);

CREATE INDEX IF NOT EXISTS idx_onus_olt    ON onus (olt_id);
CREATE INDEX IF NOT EXISTS idx_onus_estado ON onus (estado);
CREATE INDEX IF NOT EXISTS idx_onus_sn     ON onus (sn);


-- =============================================================================
-- 7. IP Addresses (pools y estáticas)
-- =============================================================================
CREATE TABLE IF NOT EXISTS ip_addresses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    router_id  UUID REFERENCES routers_mikrotik(id) ON DELETE CASCADE,
    onu_id     UUID REFERENCES onus(id) ON DELETE SET NULL,
    ip_address VARCHAR(45) NOT NULL,
    netmask    VARCHAR(15) DEFAULT '255.255.255.0',
    interfaz   VARCHAR(50) NOT NULL,
    estado     VARCHAR(20) DEFAULT 'libre' CHECK (estado IN ('libre', 'asignada', 'reservada')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (router_id, ip_address)
);


-- =============================================================================
-- 8. Reglas de firewall y bloqueos de servicio
-- =============================================================================
CREATE TABLE IF NOT EXISTS firewall_bloqueos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    router_id   UUID REFERENCES routers_mikrotik(id) ON DELETE CASCADE,
    onu_id      UUID REFERENCES onus(id) ON DELETE SET NULL,
    cliente_ip  VARCHAR(45) NOT NULL,
    mac_address VARCHAR(17),
    tipo_accion VARCHAR(20) NOT NULL CHECK (tipo_accion IN ('CORTAR_SERVICIO', 'REDIRECCION_PAGO', 'DROP_FORWARD')),
    comentario  TEXT,
    -- .id que devolvió RouterOS al crear la entrada en el address-list (*1, *2...).
    -- Necesario para poder borrarla después: DELETE /rest/ip/firewall/address-list/<id>
    routeros_id VARCHAR(30),
    activo      BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bloqueos_activos ON firewall_bloqueos (router_id, activo);


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- Modelo del taller: cualquier usuario autenticado ve y administra todo.
-- Un usuario NO autenticado (rol anon) no puede leer absolutamente nada — eso es
-- lo que valida el último punto del checkpoint de Fase 1.
--
-- El middleware usa la service_role key, que bypassea RLS por diseño.

ALTER TABLE olts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE routers_mikrotik  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tipos_ont         ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE planes_velocidad  ENABLE ROW LEVEL SECURITY;
ALTER TABLE onus              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_addresses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE firewall_bloqueos ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'olts', 'routers_mikrotik', 'tipos_ont', 'line_profiles',
        'planes_velocidad', 'onus', 'ip_addresses', 'firewall_bloqueos'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "auth_all_%1$s" ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY "auth_all_%1$s" ON %1$I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            t
        );
    END LOOP;
END $$;


-- =============================================================================
-- DATOS DE EJEMPLO (opcional — borrar si no los querés)
-- =============================================================================
INSERT INTO tipos_ont (marca, modelo, puertos_ethernet, puertos_fxs, wifi) VALUES
    ('Huawei', 'HG8310M', 1, 0, FALSE),
    ('Huawei', 'HG8546M', 4, 1, TRUE),
    ('V-SOL',  'V2801RH', 1, 0, FALSE),
    ('V-SOL',  'V2802RGW', 4, 1, TRUE)
ON CONFLICT (marca, modelo) DO NOTHING;

INSERT INTO planes_velocidad (nombre, bajada_kbps, subida_kbps, burst_limit, precio, traffic_table_index) VALUES
    ('PLAN_30M',  30000, 15000, NULL,        18.00, 30),
    ('PLAN_50M',  50000, 25000, '60M/30M',   25.00, 50),
    ('PLAN_100M', 102400, 10240, '120M/60M', 35.00, 10)
ON CONFLICT (nombre) DO NOTHING;
