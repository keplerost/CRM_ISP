-- =============================================================================
-- Migración 36 — El listado de monitoreo: equipo y abonados por nodo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 35. Es idempotente.
--
-- El inventario decía si un nodo responde, pero no lo que se pregunta a
-- continuación: cuánta gente hay colgando de él. Una base caída con cero
-- abonados es un aviso; la misma base con ochenta es una emergencia, y en el
-- listado se veían igual.
--
-- Las tres cuentas salen de datos que ya existen y no se guardan en el nodo:
--
--   ACTIVOS      abonados de ese sitio con servicio.
--   SUSPENDIDOS  cortados por mora o suspendidos.
--   ONLINE       los que tienen una sesión abierta AHORA, de
--                `sesiones_conexion`. No es lo mismo que activo: un abonado al
--                día con el equipo apagado está activo y no está online, y esa
--                diferencia es justamente la que se mira cuando cae un sector.
--
-- Se calculan en la vista y no se copian en la tabla: un contador guardado
-- queda viejo en cuanto alguien da de alta a un cliente, y nadie se acuerda de
-- refrescarlo.
-- =============================================================================

ALTER TABLE nodos_red
    -- Número corto para el listado. El UUID es la clave, pero nadie dicta un
    -- UUID por radio.
    ADD COLUMN IF NOT EXISTS numero BIGSERIAL,
    -- El modelo del equipo: "RB912UAG-5HPnD", "SECTORIAL NETMETAL 5". Es lo que
    -- se mira para saber qué llevar antes de subir a la torre.
    ADD COLUMN IF NOT EXISTS equipo VARCHAR(100);

COMMENT ON COLUMN nodos_red.equipo IS
    'Modelo del hardware. Se mira antes de subir a la torre para saber qué repuesto llevar.';


-- =============================================================================
-- La vista, con los abonados de cada sitio
-- =============================================================================
-- Se suelta y se rehace: está definida con `n.*` y las columnas nuevas se
-- agregan al final de la tabla, lo que correría el orden de las calculadas.
DROP VIEW IF EXISTS v_nodos_red;

CREATE VIEW v_nodos_red WITH (security_invoker = true) AS
SELECT
    n.*,
    p.nombre   AS padre,
    p.estado   AS estado_padre,
    pr.nombre  AS punto,
    r.nombre   AS router,
    t.nombre   AS tecnico,
    t.telefono AS tecnico_telefono,
    t.email    AS tecnico_email,

    EXTRACT(EPOCH FROM (NOW() - n.desde)) / 60 AS minutos_en_estado,
    (p.estado = 'down') AS padre_caido,
    (SELECT COUNT(*) FROM nodos_red h WHERE h.padre_id = n.id) AS hijos,

    COALESCE(ab.activos, 0)     AS activos,
    COALESCE(ab.suspendidos, 0) AS suspendidos,
    COALESCE(ab.online, 0)      AS online,

    up.uptime_pct
FROM nodos_red n
LEFT JOIN nodos_red p        ON p.id  = n.padre_id
LEFT JOIN puntos_red pr      ON pr.id = n.punto_id
LEFT JOIN routers_mikrotik r ON r.id  = n.router_id
LEFT JOIN tecnicos t         ON t.id  = n.tecnico_id

LEFT JOIN LATERAL (
    -- Los abonados del sitio del nodo. Se cuentan los que cuelgan de esa caja
    -- NAP o apuntan a esa antena: son las dos formas en que un cliente queda
    -- atado a un punto de red.
    SELECT
        COUNT(*) FILTER (WHERE c.estado = 'activo')                    AS activos,
        COUNT(*) FILTER (WHERE c.estado IN ('cortado', 'suspendido'))  AS suspendidos,
        COUNT(*) FILTER (WHERE s.client_id IS NOT NULL)                AS online
    FROM clientes c
    LEFT JOIN LATERAL (
        SELECT client_id FROM sesiones_conexion
         WHERE client_id = c.id AND fin IS NULL
         LIMIT 1
    ) s ON TRUE
    WHERE n.punto_id IS NOT NULL
      AND (c.nap_id = n.punto_id OR c.conectado_a_id = n.punto_id)
      AND c.estado <> 'baja'
) ab ON TRUE

LEFT JOIN LATERAL (
    -- Uptime de los últimos 30 días: tiempo en servicio sobre tiempo medido.
    -- Los intervalos se recortan a la ventana para que uno viejo y largo no la
    -- distorsione, y se ignora 'desconocido' — no medir no es estar caído.
    SELECT ROUND(
        100 * SUM(EXTRACT(EPOCH FROM (
            LEAST(COALESCE(e.hasta, NOW()), NOW())
            - GREATEST(e.desde, NOW() - INTERVAL '30 days')
        ))) FILTER (WHERE e.estado IN ('up', 'warning'))
        / NULLIF(SUM(EXTRACT(EPOCH FROM (
            LEAST(COALESCE(e.hasta, NOW()), NOW())
            - GREATEST(e.desde, NOW() - INTERVAL '30 days')
        ))) FILTER (WHERE e.estado <> 'desconocido'), 0),
    2) AS uptime_pct
    FROM nodo_eventos e
    WHERE e.nodo_id = n.id
      AND COALESCE(e.hasta, NOW()) > NOW() - INTERVAL '30 days'
) up ON TRUE;

COMMENT ON VIEW v_nodos_red IS
    'Nodos con su estado, hace cuánto están así, su uptime de 30 días, si su padre está caído y cuántos abonados cuelgan del sitio.';
