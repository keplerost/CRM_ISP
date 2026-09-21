-- =============================================================================
-- Migración 54 — Pools de IP para la gestión de las ONUs (TR069)
-- =============================================================================
-- Las ONTs necesitan una dirección propia para que la OLT y el ACS les hablen:
-- es la que viaja por la VLAN 999 de este equipo, en paralelo a la del abonado.
-- Hasta ahora esas direcciones no estaban en ningún lado: se elegían a mano y
-- la única forma de saber cuál estaba libre era mirar el equipo.
--
-- NO se crea una tabla nueva. Un pool de gestión es una subred con un rango, un
-- gateway, DNS y una VLAN — que es exactamente lo que ya guarda `subredes`— y
-- sus direcciones son filas de `ip_addresses`, que ya tiene `onu_id`, `estado`
-- y `subred_id`. Duplicar todo eso en tablas paralelas habría significado
-- duplicar también la auditoría, el mapa de IPs y el buscador de libres, y que
-- las dos copias se separaran con el tiempo.
--
-- Lo único que falta es decir PARA QUÉ es cada subred, y los datos que un pool
-- de gestión tiene y uno de abonados no: los DNS y el rango explícito.
-- =============================================================================

ALTER TABLE subredes
    -- Para qué sirve el bloque. Sin esto, la pantalla de pools de gestión
    -- mostraría los segmentos de los abonados y viceversa.
    ADD COLUMN IF NOT EXISTS proposito VARCHAR(20) NOT NULL DEFAULT 'abonados'
        CHECK (proposito IN ('abonados', 'gestion_onu', 'wan_onu')),

    -- Los DNS que se le entregan a la ONU junto con su dirección.
    ADD COLUMN IF NOT EXISTS dns1 INET,
    ADD COLUMN IF NOT EXISTS dns2 INET,

    -- Qué parte del bloque se reparte. NO es lo mismo que el CIDR: de un
    -- 10.100.0.0/20 se puede querer entregar solo 10.100.0.2-10.100.15.254,
    -- dejando el resto para equipos propios. Sin estos dos campos habría que
    -- deducirlo, y deducirlo mal reparte la dirección de un switch.
    ADD COLUMN IF NOT EXISTS rango_desde INET,
    ADD COLUMN IF NOT EXISTS rango_hasta INET;

COMMENT ON COLUMN subredes.proposito IS
    'abonados = el segmento de los clientes · gestion_onu = las IPs con las que se administra la ONT (TR069/OMCI) · wan_onu = las estáticas que la ONT usa en su WAN.';

COMMENT ON COLUMN subredes.rango_desde IS
    'Primera dirección que este pool entrega. Puede ser más chica que el bloque: el resto queda para equipos propios.';

CREATE INDEX IF NOT EXISTS idx_subredes_proposito
    ON subredes (proposito, olt_id) WHERE proposito <> 'abonados';


-- -----------------------------------------------------------------------------
-- Resumen de cada pool
-- -----------------------------------------------------------------------------
-- Los tres números que se miran: cuántas se entregaron, cuántas están
-- reservadas y cuántas quedan. Salen de contar filas y no de restar sobre el
-- tamaño del bloque, porque el pool puede entregar solo una parte del CIDR y
-- restar daría "disponibles" que no existen.
DROP VIEW IF EXISTS v_pools_onu;
CREATE VIEW v_pools_onu WITH (security_invoker = true) AS
SELECT
    s.id,
    s.numero,
    s.nombre,
    s.cidr,
    s.proposito,
    s.gateway,
    s.dns1,
    s.dns2,
    s.vlan,
    s.rango_desde,
    s.rango_hasta,
    s.notas,
    s.activo,
    s.olt_id,
    o.nombre AS olt,
    s.router_id,
    r.nombre AS router,

    COALESCE(i.usadas, 0)     AS usadas,
    COALESCE(i.reservadas, 0) AS reservadas,
    COALESCE(i.libres, 0)     AS libres,
    COALESCE(i.total, 0)      AS total,

    -- El porcentaje se calcula sobre las direcciones que el pool tiene
    -- cargadas, no sobre el tamaño del bloque. Es la diferencia entre "usaste
    -- el 26% de lo que hay" y "el 26% de un /20 que nunca cargaste".
    CASE WHEN COALESCE(i.total, 0) > 0
         THEN ROUND((COALESCE(i.usadas, 0) + COALESCE(i.reservadas, 0))::NUMERIC * 100 / i.total, 0)
    END AS uso_pct,

    -- Direcciones que hay que mirar: se encontraron en la red y nadie las
    -- asignó, o están asignadas a una ONU que ya no existe.
    COALESCE(i.sin_dueno, 0) AS sin_dueno
FROM subredes s
LEFT JOIN olts o             ON o.id = s.olt_id
LEFT JOIN routers_mikrotik r ON r.id = s.router_id
LEFT JOIN (
    SELECT
        subred_id,
        COUNT(*)                                       AS total,
        COUNT(*) FILTER (WHERE estado = 'asignada')    AS usadas,
        COUNT(*) FILTER (WHERE estado = 'reservada')   AS reservadas,
        COUNT(*) FILTER (WHERE estado = 'libre')       AS libres,
        COUNT(*) FILTER (WHERE estado = 'asignada' AND onu_id IS NULL AND client_id IS NULL)
                                                       AS sin_dueno
    FROM ip_addresses
    WHERE subred_id IS NOT NULL
    GROUP BY subred_id
) i ON i.subred_id = s.id
WHERE s.proposito <> 'abonados';

COMMENT ON VIEW v_pools_onu IS
    'Pools de gestión y de WAN de las ONUs, con cuántas direcciones se entregaron y cuántas quedan. El porcentaje se calcula sobre las direcciones cargadas en el pool, no sobre el tamaño del bloque.';
