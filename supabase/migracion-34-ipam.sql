-- =============================================================================
-- Migración 34 — IPAM: las subredes y quién ocupa cada dirección
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere el schema.sql base.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_subredes` se redefinió en la
-- 51, con más columnas. Reemplazar esa versión por la de acá dejaría a las
-- pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Hasta ahora las direcciones vivían en tres lugares que no se hablaban: el
-- pool del MikroTik, la ficha del abonado y la cabeza del que arma la red. La
-- consecuencia se ve al dar de alta: "¿qué IP le pongo?" se contesta mirando el
-- cuaderno, y de ahí salen las direcciones repetidas que dejan a dos abonados
-- con internet intermitente.
--
-- Dos decisiones de fondo:
--
-- 1. `cidr` usa un tipo nativo de Postgres y no texto. En los tickets las IPs se
--    guardan como texto a propósito —quien atiende el teléfono escribe lo que le
--    dictan y una IP a medias no puede hacer fallar el reclamo—, pero acá es al
--    revés: una subred mal escrita se propaga a cada dirección que se asigne
--    desde ella. El tipo la valida y además permite contar cuántas entran sin
--    hacer la cuenta a mano.
--
--    El tipo es INET y no CIDR, que sería lo obvio. CIDR exige que los bits de
--    host estén en cero: rechaza "192.168.5.254/24" y solo acepta
--    "192.168.5.0/24". Pero así es como se carga una subred en la práctica —se
--    escribe el gateway con su prefijo, que es el dato que uno tiene a mano— y
--    obligar a normalizarlo antes de guardar haría fallar la carga con un error
--    que no explica nada. INET conserva lo que se escribió y `network()` calcula
--    el bloque igual.
--
-- 2. Las direcciones libres NO se materializan. Un /24 son 254 filas por subred
--    que habría que mantener sincronizadas; la ocupación se calcula y el mapa lo
--    arma la pantalla. Lo que se guarda es lo que alguien decidió: esta IP es de
--    este abonado, esta otra está reservada para el gateway.
-- =============================================================================


-- =============================================================================
-- Subredes
-- =============================================================================
CREATE TABLE IF NOT EXISTS subredes (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Número corto para nombrarla en el listado y decirla por teléfono. El UUID
    -- es la clave, pero nadie dicta un UUID.
    numero   BIGSERIAL,
    nombre   VARCHAR(100) NOT NULL,
    cidr     INET NOT NULL,

    -- De dónde sale y para qué se usa. El tipo cambia cómo se administra:
    -- una estática se asigna abonado por abonado, un pool PPPoE lo reparte el
    -- router solo, y una CGNAT no se le promete a nadie.
    tipo     VARCHAR(15) NOT NULL DEFAULT 'estatica'
             CHECK (tipo IN ('estatica', 'pool_pppoe', 'cgnat', 'nodos')),

    router_id UUID REFERENCES routers_mikrotik(id) ON DELETE SET NULL,
    -- Nombre del pool en el equipo, cuando la subred se reparte por DHCP o PPP.
    pool_router VARCHAR(100),

    gateway  INET,
    vlan     INT CHECK (vlan IS NULL OR vlan BETWEEN 1 AND 4094),
    -- Del nodo o la torre de la que cuelga, para poder ver la red por zona.
    punto_id UUID REFERENCES puntos_red(id) ON DELETE SET NULL,

    notas    TEXT,
    activo   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON COLUMN subredes.tipo IS
    'estatica = se asigna a mano, dirección por dirección · pool_pppoe = la reparte el router al autenticar · cgnat = direccionamiento compartido, no se promete a nadie · nodos = enlaces y equipos propios, no abonados.';

COMMENT ON COLUMN subredes.cidr IS
    'INET y no CIDR: se carga como se tiene a mano —el gateway con su prefijo, "192.168.5.254/24"— y CIDR rechazaría eso por tener bits de host. El bloque se calcula con network().';

-- Dos subredes con el mismo bloque son la misma subred cargada dos veces, y a
-- partir de ahí la ocupación de las dos miente. Se compara la RED y no lo
-- escrito: "192.168.5.254/24" y "192.168.5.0/24" son el mismo bloque.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subredes_cidr ON subredes (network(cidr));
CREATE INDEX IF NOT EXISTS idx_subredes_router ON subredes (router_id) WHERE router_id IS NOT NULL;


-- =============================================================================
-- Las direcciones, sobre la tabla que ya existía
-- =============================================================================
ALTER TABLE ip_addresses
    ADD COLUMN IF NOT EXISTS subred_id   UUID REFERENCES subredes(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS client_id   UUID REFERENCES clientes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS descripcion VARCHAR(150),
    ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17),

    -- De dónde salió el dato. Distingue lo que alguien decidió de lo que se
    -- encontró escaneando: una IP "vista por ARP" que nadie asignó es
    -- justamente lo que la auditoría tiene que sacar a la luz.
    ADD COLUMN IF NOT EXISTS origen VARCHAR(15) NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS visto_at TIMESTAMP WITH TIME ZONE;

-- `interfaz` era obligatoria porque la tabla nació para volcar lo que había en
-- el router. Una dirección reservada de antemano —el gateway de una subred que
-- todavía no se configuró— no cuelga de ninguna interfaz.
ALTER TABLE ip_addresses ALTER COLUMN interfaz DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ip_addresses_origen_check') THEN
        ALTER TABLE ip_addresses ADD CONSTRAINT ip_addresses_origen_check
            CHECK (origen IN ('manual', 'arp', 'dhcp', 'ppp', 'address', 'alta'));
    END IF;
END $$;

COMMENT ON COLUMN ip_addresses.origen IS
    'manual = alguien la asignó · arp/dhcp/ppp/address = se encontró en el router · alta = la puso el asistente de instalación. Sirve para separar lo decidido de lo descubierto.';

-- Una dirección no puede estar dos veces en la misma subred.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ip_addresses_subred
    ON ip_addresses (subred_id, ip_address) WHERE subred_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ip_addresses_cliente
    ON ip_addresses (client_id) WHERE client_id IS NOT NULL;


-- =============================================================================
-- Ocupación
-- =============================================================================
-- El porcentaje sale de dividir lo ocupado por lo que entra en el bloque, y lo
-- que entra lo calcula Postgres a partir del prefijo.
--
-- Se descuentan la dirección de red y la de broadcast: dárselas a un abonado es
-- un ticket asegurado. En /31 y /32 no hay ninguna de las dos —son enlaces
-- punto a punto— y el bloque entero es utilizable.
--
-- En IPv6 el total no se calcula: un /64 son 18 trillones de direcciones y un
-- porcentaje sobre eso siempre daría cero. Queda en nulo y la pantalla muestra
-- la cuenta de asignadas, que es lo único que significa algo.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `olt`, la cadena siguió y esta versión quedó
     * atrás: la 51 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_subredes'
           AND column_name = 'olt'
    ) THEN
        RAISE NOTICE 'v_subredes ya está en su versión de la 51: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_subredes';
    EXECUTE $vista$
CREATE VIEW v_subredes WITH (security_invoker = true) AS
SELECT
    s.*,
    family(s.cidr)  AS version,
    masklen(s.cidr) AS prefijo,
    -- El bloque, calculado: lo que se escribió puede ser el gateway.
    host(network(s.cidr))   AS red,
    host(network(s.cidr))   AS primera,
    host(broadcast(s.cidr)) AS ultima,
    text(network(s.cidr))   AS bloque,
    r.nombre AS router,
    pr.nombre AS punto,

    CASE
        WHEN family(s.cidr) = 4 AND masklen(s.cidr) <= 30
            THEN POWER(2, 32 - masklen(s.cidr))::BIGINT - 2
        WHEN family(s.cidr) = 4
            THEN POWER(2, 32 - masklen(s.cidr))::BIGINT
    END AS utilizables,

    COALESCE(u.asignadas, 0)  AS asignadas,
    COALESCE(u.reservadas, 0) AS reservadas,
    COALESCE(u.sin_autorizar, 0) AS sin_autorizar,

    CASE
        WHEN family(s.cidr) = 4 AND masklen(s.cidr) <= 30 AND POWER(2, 32 - masklen(s.cidr)) > 2
            THEN ROUND(
                (COALESCE(u.asignadas, 0) + COALESCE(u.reservadas, 0))::NUMERIC
                * 100 / (POWER(2, 32 - masklen(s.cidr))::NUMERIC - 2),
                1)
    END AS ocupacion_pct
FROM subredes s
LEFT JOIN routers_mikrotik r ON r.id = s.router_id
LEFT JOIN puntos_red pr      ON pr.id = s.punto_id
LEFT JOIN (
    SELECT
        subred_id,
        COUNT(*) FILTER (WHERE estado = 'asignada')  AS asignadas,
        COUNT(*) FILTER (WHERE estado = 'reservada') AS reservadas,
        -- Encontradas en la red pero sin dueño en el sistema. Es el número que
        -- mira la auditoría.
        COUNT(*) FILTER (WHERE origen = 'arp' AND client_id IS NULL) AS sin_autorizar
    FROM ip_addresses
    WHERE subred_id IS NOT NULL
    GROUP BY subred_id
) u ON u.subred_id = s.id
$vista$;
END $guarda$;

COMMENT ON VIEW v_subredes IS
    'Subredes con su ocupación calculada: cuántas direcciones entran, cuántas están asignadas y qué porcentaje va usado.';


/** Las direcciones con el nombre de su dueño resuelto. */
CREATE OR REPLACE VIEW v_direcciones_ip WITH (security_invoker = true) AS
SELECT
    d.*,
    s.nombre AS subred,
    s.cidr,
    s.tipo   AS subred_tipo,
    c.nombre AS cliente,
    c.estado AS estado_cliente,
    -- Vista en la red y sin dueño: o es un equipo que nadie registró, o alguien
    -- se puso una IP que no le tocaba.
    (d.origen = 'arp' AND d.client_id IS NULL) AS sin_autorizar
FROM ip_addresses d
LEFT JOIN subredes s ON s.id = d.subred_id
LEFT JOIN clientes c ON c.id = d.client_id;


-- =============================================================================
-- RLS y updated_at
-- =============================================================================
ALTER TABLE subredes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_subredes" ON subredes;
CREATE POLICY "auth_all_subredes" ON subredes
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_subredes_updated_at ON subredes;
CREATE TRIGGER trg_subredes_updated_at
    BEFORE UPDATE ON subredes
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();
