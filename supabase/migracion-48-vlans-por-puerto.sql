-- =============================================================================
-- Migración 48 — Qué VLAN le corresponde a cada puerto PON
-- =============================================================================
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_vlan_por_puerto` y las
-- columnas de puerto de `vlans_olt` se redefinió en la 52, con más columnas.
-- Reemplazar esa versión por la de acá dejaría a las pantallas sin lo que hoy
-- usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- El objetivo real no es la pantalla de VLANs: es que el técnico, arriba de una
-- escalera, no tenga que elegir de qué segmento de red sacar la IP del abonado.
--
-- La cadena que lo resuelve es ésta:
--
--     la ONT apareció en la placa 6, puerto 4
--        → ese puerto tiene por defecto la VLAN 204
--           → esa VLAN es la de la subred 10.20.4.0/24
--              → la IP sale de ahí, sin que nadie elija nada
--
-- Hoy el eslabón del medio no existe en ningún lado: la OLT sabe qué VLANs
-- tiene, pero no que la 204 "es la del puerto 4". Eso es una convención del
-- ISP, y las convenciones que no están escritas se aplican mal el día que las
-- aplica otra persona.
--
-- `subredes.vlan` ya existía, así que el último eslabón está puesto desde la
-- migración 34.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vlans_olt (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id      UUID NOT NULL REFERENCES olts(id) ON DELETE CASCADE,
    vlan        INT NOT NULL CHECK (vlan BETWEEN 1 AND 4094),

    descripcion TEXT,

    -- De qué puerto PON es la VLAN por defecto. Es el eslabón que faltaba.
    --
    -- Nulos cuando la VLAN no es de un puerto en particular: la de gestión, la
    -- de VoIP, o una que se usa en varios.
    slot        INT,
    puerto      INT,

    -- Para qué se usa. Cambia cómo se trata: la de gestión no lleva abonados y
    -- ofrecerla al dar de alta a alguien sería un error caro.
    uso         VARCHAR(20) NOT NULL DEFAULT 'internet'
                CHECK (uso IN ('internet', 'gestion', 'voip', 'iptv', 'otra')),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (olt_id, vlan)
);

-- Un puerto tiene UNA VLAN por defecto. Dos filas diciendo cosas distintas
-- sobre el mismo puerto es una contradicción que el sistema tendría que
-- resolver adivinando, y adivinaría distinto según cómo ordene la base.
--
-- Va condicionado —y con SQL dinámico— porque la 52 se llevó estas dos columnas
-- a `puertos_pon`: si ya no están, el índice no tiene sentido y escrito suelto
-- ni siquiera se analiza.
DO $slot$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'vlans_olt'
           AND column_name = 'slot'
    ) THEN
        RAISE NOTICE 'vlans_olt ya no habla de puertos: lo movió la 52.';
        RETURN;
    END IF;

    EXECUTE $ix$
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vlans_olt_puerto
            ON vlans_olt (olt_id, slot, puerto)
            WHERE slot IS NOT NULL AND puerto IS NOT NULL
    $ix$;

    EXECUTE $cm$
        COMMENT ON COLUMN vlans_olt.slot IS
            'Placa del puerto del que esta VLAN es la predeterminada. Es lo que permite que una instalación elija sola su segmento de red a partir de dónde apareció la ONT.'
    $cm$;
END $slot$;

CREATE INDEX IF NOT EXISTS idx_vlans_olt_olt ON vlans_olt (olt_id);

COMMENT ON TABLE vlans_olt IS
    'Lo que el ISP sabe de cada VLAN de una OLT y que el equipo no puede saber: para qué la usa y de qué puerto PON es la VLAN por defecto. La existencia de la VLAN se lee del equipo; esto es lo que la explica.';

COMMENT ON COLUMN vlans_olt.uso IS
    'internet = abonados · gestion = la de administración de las ONTs, no lleva abonados · voip · iptv. Ofrecer la de gestión en un alta deja al abonado sin servicio y con acceso a la red de administración.';


-- -----------------------------------------------------------------------------
-- La cadena completa, en una vista
-- -----------------------------------------------------------------------------
-- Puerto PON → VLAN → subred. Es lo que consulta el paso de red de una
-- instalación para no preguntarle nada al técnico.
DO $guarda$
BEGIN
    /**
     * Si ya existe `puertos_pon`, la 52 rehizo este enfoque y esta versión
     * de la vista quedó atrás. Recrearla desde acá volvería a un diseño que se
     * corrigió a propósito.
     */
    IF to_regclass('public.puertos_pon') IS NOT NULL THEN
        RAISE NOTICE 'v_vlan_por_puerto ya está en su versión de la 52: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_vlan_por_puerto';
    EXECUTE $vista$
CREATE VIEW v_vlan_por_puerto WITH (security_invoker = true) AS
SELECT
    v.olt_id,
    o.nombre        AS olt,
    v.slot,
    v.puerto,
    v.vlan,
    v.uso,
    v.descripcion,

    s.id            AS subred_id,
    s.nombre        AS subred,
    s.cidr,
    s.tipo          AS subred_tipo,
    s.gateway,
    s.pool_router,
    s.router_id,
    r.nombre        AS router,

    -- Sin subred con esa VLAN, la cadena se corta y el técnico va a tener que
    -- elegir a mano. Se dice explícitamente en vez de devolver una fila a medias.
    (s.id IS NULL)  AS sin_subred
FROM vlans_olt v
JOIN olts o             ON o.id = v.olt_id
LEFT JOIN subredes s    ON s.vlan = v.vlan AND s.activo
LEFT JOIN routers_mikrotik r ON r.id = s.router_id
WHERE v.slot IS NOT NULL AND v.puerto IS NOT NULL
$vista$;
END $guarda$;


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
-- Explícito y fuera de bloques DO: el analizador de Supabase no lee adentro de
-- un EXECUTE y reporta la tabla como si quedara sin RLS.

ALTER TABLE vlans_olt ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_vlans_olt" ON vlans_olt;
CREATE POLICY "auth_all_vlans_olt" ON vlans_olt
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
