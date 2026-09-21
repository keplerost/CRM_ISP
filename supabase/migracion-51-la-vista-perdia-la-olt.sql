-- =============================================================================
-- Migración 51 — La vista de subredes perdía la OLT
-- =============================================================================
-- `v_subredes` se creó en la 34 con `SELECT s.*`. Eso NO es dinámico: Postgres
-- expande el asterisco al crear la vista y congela la lista de columnas. Cuando
-- la 49 le agregó `olt_id` a la tabla, la vista siguió devolviendo las de antes.
--
-- El efecto no era que faltara un dato en un listado. La pantalla de Redes IPv4
-- lee de la vista y le pasa la fila al formulario; el formulario tomaba
-- `subred.olt_id`, encontraba undefined, y al guardar escribía NULL. Es decir:
-- abrir una subred para cambiarle el nombre le borraba la OLT, en silencio.
--
-- Y sin OLT, el segmento de una instalación deja de resolverse: los bloques
-- dejan de ser "de esta OLT" y un abonado puede recibir una dirección del rango
-- del otro equipo.
--
-- Se rehace la vista. Va con DROP y no con CREATE OR REPLACE porque reemplazar
-- una vista no permite agregar columnas en el medio, y las calculadas van
-- después de las de la tabla.
-- =============================================================================

DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `olt`, la cadena siguió y esta versión quedó
     * atrás: la esta misma migracion la redefinió con más columnas. Recrearla desde acá se
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
        RAISE NOTICE 'v_subredes ya está en su versión de la esta misma migracion: no se toca.';
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
    r.nombre  AS router,
    pr.nombre AS punto,
    o.nombre  AS olt,

    CASE
        WHEN family(s.cidr) = 4 AND masklen(s.cidr) <= 30
            THEN POWER(2, 32 - masklen(s.cidr))::BIGINT - 2
        WHEN family(s.cidr) = 4
            THEN POWER(2, 32 - masklen(s.cidr))::BIGINT
    END AS utilizables,

    COALESCE(u.asignadas, 0)     AS asignadas,
    COALESCE(u.reservadas, 0)    AS reservadas,
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
LEFT JOIN olts o             ON o.id = s.olt_id
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
    'Subredes con su ocupación calculada: cuántas direcciones entran, cuántas están asignadas y qué porcentaje va usado. Incluye la OLT del bloque, sin la cual una instalación no puede saber si el segmento le sirve al equipo del que cuelga el abonado.';


-- -----------------------------------------------------------------------------
-- Reparar lo que la vista rompió
-- -----------------------------------------------------------------------------
-- Cada bloque que quedó sin OLT y cuya VLAN pertenece a UNA sola OLT se puede
-- recuperar sin adivinar: la VLAN dice de qué equipo es.
--
-- Se toca solamente las que están en NULL, y solo cuando la respuesta es única.
-- Una VLAN que existe en dos OLTs no se completa: preferible dejarla vacía y que
-- alguien la elija a llenarla con una suposición que después nadie revisa.
--
-- Se toma la primera del array y no MIN(): Postgres no sabe ordenar UUIDs, y
-- acá da igual cuál se elija porque el HAVING ya garantiza que hay una sola.
UPDATE subredes s
SET olt_id = v.olt_id
FROM (
    SELECT vlan, (array_agg(DISTINCT olt_id))[1] AS olt_id
    FROM vlans_olt
    GROUP BY vlan
    HAVING COUNT(DISTINCT olt_id) = 1
) v
WHERE s.olt_id IS NULL
  AND s.vlan = v.vlan;
