-- =============================================================================
-- Migración 02 — Clientes e importación desde MikroTik
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- Por qué: al dar de baja el sistema de gestión anterior (WispHub / MikroWISP),
-- la información de los clientes queda solo en el MikroTik — en los PPPoE
-- secrets, las simple queues, los leases DHCP y las address-list de cortes.
-- Esta migración crea dónde guardarla al importarla.
-- =============================================================================

-- La lista de cortes no es la misma en todos lados: el router del taller ya
-- usaba "Moroso". Forzar un nombre propio dejaría dos mecanismos de corte
-- conviviendo sobre el mismo equipo.
ALTER TABLE routers_mikrotik
    ADD COLUMN IF NOT EXISTS lista_morosos VARCHAR(50) NOT NULL DEFAULT 'CORTE_MOROSOS';

COMMENT ON COLUMN routers_mikrotik.lista_morosos IS
    'Nombre del address-list que usa este router para cortar el servicio. Debe coincidir con el que referencian sus reglas de firewall.';


-- =============================================================================
-- Clientes
-- =============================================================================
CREATE TABLE IF NOT EXISTS clientes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      VARCHAR(150) NOT NULL,
    router_id   UUID REFERENCES routers_mikrotik(id) ON DELETE SET NULL,
    onu_id      UUID REFERENCES onus(id) ON DELETE SET NULL,
    plan_id     UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,

    ip          VARCHAR(45),
    mac_address VARCHAR(17),
    -- Usuario de PPPoE, cuando el cliente se conecta así.
    usuario_ppp VARCHAR(100),

    estado      VARCHAR(20) NOT NULL DEFAULT 'activo'
                CHECK (estado IN ('activo', 'cortado', 'suspendido', 'baja')),

    -- De dónde salió: sirve para distinguir lo importado de lo cargado a mano,
    -- y para poder deshacer una importación equivocada.
    origen      VARCHAR(20) NOT NULL DEFAULT 'manual'
                CHECK (origen IN ('manual', 'ppp-secret', 'simple-queue', 'dhcp-lease', 'address-list')),

    -- Velocidad tal como estaba en el MikroTik (ej. "50M/25M"), por si no se
    -- pudo asociar a un plan del sistema.
    velocidad_cruda VARCHAR(50),
    comentario  TEXT,

    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Un cliente no puede estar dos veces con la misma IP en el mismo router.
-- Es lo que permite reimportar sin duplicar: el segundo escaneo actualiza.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_router_ip
    ON clientes (router_id, ip) WHERE ip IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_router_ppp
    ON clientes (router_id, usuario_ppp) WHERE usuario_ppp IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clientes_estado ON clientes (estado);
CREATE INDEX IF NOT EXISTS idx_clientes_router ON clientes (router_id);


-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_clientes" ON clientes;
CREATE POLICY "auth_all_clientes" ON clientes
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Vínculo entre bloqueos y clientes
-- =============================================================================
ALTER TABLE firewall_bloqueos
    ADD COLUMN IF NOT EXISTS cliente_id UUID REFERENCES clientes(id) ON DELETE CASCADE;

-- El nombre del address-list donde se aplicó, para poder revertir con exactitud.
ALTER TABLE firewall_bloqueos
    ADD COLUMN IF NOT EXISTS lista VARCHAR(50);


-- =============================================================================
-- updated_at automático
-- =============================================================================
CREATE OR REPLACE FUNCTION tocar_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clientes_updated_at ON clientes;
CREATE TRIGGER trg_clientes_updated_at
    BEFORE UPDATE ON clientes
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();
