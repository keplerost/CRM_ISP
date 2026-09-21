-- =============================================================================
-- Migración 50 — La IP la da el puerto, no el plan
-- =============================================================================
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_vlan_por_puerto` se
-- redefinió en la 52, con más columnas. Reemplazar esa versión por la de acá
-- dejaría a las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Corrige la 49, que estaba mal.
--
-- La 49 se escribió leyendo los comentarios del MikroTik:
--
--     172.18.1.254/24  vlan200-OLT-X7  PLAN 150 MEGAS OLT-10G
--     172.18.2.254/24  vlan200-OLT-X7  PLAN 300 MEGAS OLT-10G
--
-- y de ahí se dedujo que el bloque de IP dependía del plan contratado. Es una
-- lectura razonable de esos nombres y es falsa: describen con qué criterio se
-- cargaron ese día, no una regla del ISP. En la misma VLAN conviven un abonado
-- de 150 megas y uno de 500. Los bloques sirven a TODOS los planes.
--
-- La regla verdadera es la que estaba planteada en la 48:
--
--     la ONT apareció en la placa 6, puerto 4
--        → ese puerto usa la VLAN 204
--           → esa VLAN es la del bloque 192.168.111.0/24
--              → la IP sale de ahí
--
-- El plan decide la VELOCIDAD —las traffic tables del service-port— y nada más.
-- Son dos ejes independientes y cruzarlos es lo que hacía que un abonado que
-- cambia de plan tuviera que cambiar de IP, que no es como funciona esta red.
--
-- Se quita el vínculo plan → subred. `olt_id` se conserva: de qué equipo es un
-- bloque sí importa, porque una dirección de otra OLT no enruta desde donde el
-- abonado está colgado.
-- =============================================================================

DROP VIEW IF EXISTS v_subred_por_plan;

ALTER TABLE subredes DROP COLUMN IF EXISTS plan_id;


-- -----------------------------------------------------------------------------
-- Puerto PON → VLAN → subred, ahora sin cruzar equipos
-- -----------------------------------------------------------------------------
-- La versión de la 48 unía por `s.vlan = v.vlan` a secas. Dos OLTs que usen el
-- mismo número de VLAN —lo normal cuando cada una arranca su numeración en 100—
-- se cruzaban entre sí, y el técnico de una recibía el bloque de la otra.
--
-- Ahora la subred tiene que ser del mismo equipo, o de ninguno en particular.
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

    -- Lo que este sistema tiene anotado dentro del bloque, y cuánto entra. Sirve
    -- para elegir entre varios bloques de la misma VLAN y para mostrar "quedan
    -- tantas". No es la verdad completa: el router puede tener direcciones
    -- puestas a mano que nadie cargó acá.
    (SELECT COUNT(*) FROM ip_addresses i
      WHERE i.ip_address::INET << network(s.cidr))     AS anotadas,
    CASE WHEN s.cidr IS NULL THEN NULL
         ELSE (2 ^ (32 - masklen(s.cidr)) - 2)::INT END AS direcciones_del_bloque,

    -- Sin subred con esa VLAN la cadena se corta y el técnico va a tener que
    -- elegir a mano. Se dice explícitamente en vez de devolver una fila a medias.
    (s.id IS NULL)  AS sin_subred
FROM vlans_olt v
JOIN olts o             ON o.id = v.olt_id
LEFT JOIN subredes s    ON s.vlan = v.vlan
                       AND s.activo
                       AND (s.olt_id = v.olt_id OR s.olt_id IS NULL)
LEFT JOIN routers_mikrotik r ON r.id = s.router_id
WHERE v.slot IS NOT NULL AND v.puerto IS NOT NULL
$vista$;
END $guarda$;

COMMENT ON VIEW v_vlan_por_puerto IS
    'Puerto PON → VLAN → subred. Es lo que consulta el paso de red de una instalación para no preguntarle nada al técnico. El plan del abonado no interviene: decide la velocidad, no la dirección.';
