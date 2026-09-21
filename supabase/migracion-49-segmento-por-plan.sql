-- =============================================================================
-- Migración 49 — Qué segmento de red le toca a cada plan
-- =============================================================================
-- La red de este ISP no está organizada por puerto PON sino por PLAN. Se ve en
-- las direcciones de su propio router:
--
--     172.18.1.254/24  vlan200-OLT-X7  PLAN 150 MEGAS OLT-10G
--     172.18.2.254/24  vlan200-OLT-X7  PLAN 300 MEGAS OLT-10G
--     172.18.3.254/24  vlan200-OLT-X7  PLAN 500 MEGAS OLT-10G
--     172.18.4.254/24  vlan200-OLT-X7  PLAN 50 MEGAS OLT-10G
--
-- Una sola VLAN para todos los abonados de la OLT, y el bloque de IP según la
-- velocidad contratada. Eso está escrito en los comentarios del MikroTik, que
-- es donde nadie puede consultarlo desde un celular arriba de una escalera.
--
-- Un plan puede tener VARIAS subredes: cuando el bloque de los de 150 megas se
-- llena, se agrega otro. Por eso la relación va de la subred al plan y no al
-- revés — así agregar un bloque nuevo es una fila más y no tocar nada.
-- =============================================================================

ALTER TABLE subredes
    -- De qué OLT es el segmento. Un mismo plan usa bloques distintos según de
    -- qué equipo cuelgue el abonado, y sin esto el sistema le daría al de LA
    -- MANA una dirección del rango de PROGRESO.
    --
    -- Esta columna sobrevivió a la corrección de la 50; `plan_id` no, y por eso
    -- se agrega más abajo y solo cuando corresponde.
    ADD COLUMN IF NOT EXISTS olt_id UUID REFERENCES olts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_subredes_olt ON subredes (olt_id) WHERE olt_id IS NOT NULL;

/**
 * El vínculo plan → subred, que la 50 después deshizo.
 *
 * ── Por qué está condicionado ──
 *
 * La 50 corrigió el enfoque de esta migración: quitó `subredes.plan_id` y borró
 * la vista que lo usaba, porque la IP la da el puerto y no el plan. Escrito
 * suelto, volver a correr este archivo RESUCITA la columna y la vista —el
 * `IF NOT EXISTS` no distingue "todavía no se creó" de "se quitó a propósito"—
 * y deshace en silencio parte de una corrección posterior.
 *
 * La condición mira si ya existe `puertos_pon`, la tabla con la que la 52 cerró
 * ese rediseño. Si está, esta parte de la 49 pertenece a una etapa terminada y
 * no hay nada que hacer.
 */
DO $$
BEGIN
    IF to_regclass('public.puertos_pon') IS NOT NULL THEN
        RAISE NOTICE 'El vínculo plan → subred lo deshizo la 50: no se resucita.';
        RETURN;
    END IF;

    ALTER TABLE subredes
        ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_subredes_plan ON subredes (plan_id) WHERE plan_id IS NOT NULL;

    COMMENT ON COLUMN subredes.plan_id IS
        'Plan al que sirve este bloque. Varias subredes pueden apuntar al mismo plan: cuando una se llena se agrega otra, y el sistema elige la que tenga lugar.';
END $$;

COMMENT ON COLUMN subredes.olt_id IS
    'De qué OLT es el segmento. Sin esto, un abonado de una OLT recibiría una dirección del rango de otra.';


-- -----------------------------------------------------------------------------
-- Plan → segmento, con cuánto lugar le queda a cada uno
-- -----------------------------------------------------------------------------
-- La ocupación sale de las direcciones que este sistema tiene registradas. NO es
-- toda la verdad —el router puede tener asignaciones hechas a mano que nadie
-- cargó acá— y por eso la vista devuelve el número tal cual, sin llamarlo
-- "libres". Decir "quedan 120" cuando el router repartió 200 a mano es peor que
-- no decir nada.
-- La vista corre la misma suerte que la columna: si la 50 ya deshizo el
-- enfoque, no se vuelve a crear. Va con SQL dinámico porque lee `s.plan_id`, y
-- escrita suelta fallaría al analizarse aunque el `IF` la saltee.
DO $$
BEGIN
    IF to_regclass('public.puertos_pon') IS NOT NULL THEN
        RETURN;
    END IF;

    DROP VIEW IF EXISTS v_subred_por_plan;
    EXECUTE $vista$
CREATE VIEW v_subred_por_plan WITH (security_invoker = true) AS
SELECT
    s.id            AS subred_id,
    s.nombre        AS subred,
    s.cidr,
    s.tipo,
    s.gateway,
    s.vlan,
    s.pool_router,
    s.router_id,
    r.nombre        AS router,
    s.olt_id,
    o.nombre        AS olt,

    p.id            AS plan_id,
    p.nombre        AS plan,
    p.bajada_kbps,
    p.subida_kbps,

    -- Direcciones que ESTE sistema tiene anotadas en el bloque. La capacidad
    -- real se calcula del prefijo; las dos son cotas, no la verdad completa.
    (SELECT COUNT(*) FROM ip_addresses i
      WHERE i.ip_address::INET << network(s.cidr)) AS anotadas,
    (2 ^ (32 - masklen(s.cidr)) - 2)::INT          AS direcciones_del_bloque
FROM subredes s
JOIN planes_velocidad p      ON p.id = s.plan_id
LEFT JOIN routers_mikrotik r ON r.id = s.router_id
LEFT JOIN olts o             ON o.id = s.olt_id
WHERE s.activo
$vista$;
END $$;
