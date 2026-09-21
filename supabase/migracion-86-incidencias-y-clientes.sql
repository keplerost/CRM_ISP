-- =============================================================================
-- Migración 86 — Cruce entre incidencias de red y clientes
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué habilita ──
--
-- Que el técnico, al abrir el trabajo de un cliente, se entere de que el nodo
-- del que ese cliente cuelga está caído.
--
-- Es la pieza que evita el viaje al pedo: hoy sale, maneja media hora, revisa el
-- domicilio, no encuentra nada, y recién ahí alguien le dice que se cayó la
-- torre. Con esto lo sabe antes de subirse a la camioneta.
--
-- ── OJO: no muestra nada hasta que haya nodos cargados ──
--
-- Al escribir esto, `nodos_red` tiene 0 filas y ningún cliente tiene
-- `conectado_a_id`, `onu_id` ni `nap_id`. Todo lo de acá abajo va a devolver
-- vacío —correctamente vacío— hasta que se cargue el monitoreo y se vinculen
-- los abonados. Se deja escrito para que el día que existan los datos la
-- pantalla ya sepa qué hacer con ellos, no para que hoy se vea algo.
-- =============================================================================


-- =============================================================================
-- 1. De qué nodo depende un cliente
-- =============================================================================
-- ── Los dos caminos, y por qué son dos ──
--
-- Un ISP mixto conecta de dos maneras y el vínculo con el nodo es distinto:
--
--   Inalámbrico → el cliente apunta a un punto de red (`conectado_a_id`), y el
--                 nodo que lo representa apunta al mismo punto.
--   Fibra       → el cliente cuelga de una ONU, la ONU de una OLT, y el nodo de
--                 esa OLT.
--
-- Y una NAP también es un punto de red, así que `nap_id` entra por el primer
-- camino. Un solo camino dejaría a la mitad de los abonados sin aviso, y sería
-- la mitad que no se nota — porque el aviso simplemente no aparecería.

CREATE OR REPLACE FUNCTION nodos_de_cliente(p_cliente UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT n.id
      FROM nodos_red n
      JOIN clientes c ON c.id = p_cliente
     WHERE
        -- Inalámbrico, o colgado de una NAP.
        (n.punto_id IS NOT NULL AND n.punto_id IN (c.conectado_a_id, c.nap_id))
        -- Fibra: por la OLT de su ONU.
        OR (n.olt_id IS NOT NULL
            AND n.olt_id = (SELECT o.olt_id FROM onus o WHERE o.id = c.onu_id))
$$;

COMMENT ON FUNCTION nodos_de_cliente IS
    'Los nodos de red de los que depende un abonado. Vacío si no está vinculado a ninguno.';


/**
 * Cuántos abonados activos cuelgan de un nodo.
 *
 * Es el número que convierte "una torre está caída" en "37 clientes sin
 * servicio", que es lo que hace que alguien priorice. Sin él, todas las caídas
 * parecen iguales.
 *
 * Solo cuenta activos: un cortado por falta de pago no está sin servicio por la
 * caída, y contarlo infla el número justo cuando se lo usa para decidir.
 */
CREATE OR REPLACE FUNCTION clientes_de_nodo(p_nodo UUID)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COUNT(*)::INT
      FROM clientes c
      JOIN nodos_red n ON n.id = p_nodo
     WHERE c.estado = 'activo'
       AND (
            (n.punto_id IS NOT NULL AND n.punto_id IN (c.conectado_a_id, c.nap_id))
            OR (n.olt_id IS NOT NULL
                AND n.olt_id = (SELECT o.olt_id FROM onus o WHERE o.id = c.onu_id))
       )
$$;


-- =============================================================================
-- 2. El estado de la red, ahora con cuántos afecta
-- =============================================================================
-- Se recrea `v_estado_red` de la migración 85 agregando dos columnas. El resto
-- es idéntico: las mismas columnas, en el mismo orden, sin IPs ni credenciales.
DROP VIEW IF EXISTS v_estado_red;
CREATE VIEW v_estado_red AS
SELECT
    n.id,
    n.nombre,
    n.tipo,
    pr.nombre AS punto,
    n.estado,
    n.monitorear,
    n.latencia_ms,
    n.perdida_pct,
    n.ultimo_chequeo,
    n.desde,
    CASE WHEN n.desde IS NULL THEN NULL
         ELSE (EXTRACT(EPOCH FROM (NOW() - n.desde)) / 60)::INT END AS minutos_asi,
    (p.estado = 'down') AS por_el_padre,
    p.nombre AS depende_de,
    (n.tecnico_id IS NOT NULL AND n.tecnico_id = mi_tecnico_id()) AS es_mio,

    -- Lo nuevo.
    clientes_de_nodo(n.id) AS clientes_afectados,
    -- Cuántos nodos cuelgan de este. Un nodo con hijos es cabecera: su caída no
    -- es una caída más.
    (SELECT COUNT(*)::INT FROM nodos_red h WHERE h.padre_id = n.id) AS hijos
FROM nodos_red n
LEFT JOIN nodos_red  p  ON p.id  = n.padre_id
LEFT JOIN puntos_red pr ON pr.id = n.punto_id
WHERE puede_ver_monitoreo();

COMMENT ON VIEW v_estado_red IS
    'El estado de la red para quien trabaja en campo, con cuántos abonados afecta cada nodo. Sin IPs ni credenciales.';

GRANT SELECT ON v_estado_red TO authenticated;


-- =============================================================================
-- 3. Qué le pasa al cliente de esta orden
-- =============================================================================
-- La consulta que hace la pantalla del técnico al abrir un trabajo.
--
-- Devuelve filas solo cuando hay algo que avisar: si el nodo está bien, no
-- devuelve nada y la pantalla no dibuja ninguna advertencia. Una advertencia
-- verde que dice "todo en orden" se aprende a ignorar en dos días, y entonces
-- tampoco se lee la roja.
DROP VIEW IF EXISTS v_incidencia_de_cliente;
CREATE VIEW v_incidencia_de_cliente AS
SELECT
    c.id AS client_id,
    n.id AS nodo_id,
    n.nombre AS nodo,
    n.tipo   AS nodo_tipo,
    n.estado,
    n.desde,
    (EXTRACT(EPOCH FROM (NOW() - n.desde)) / 60)::INT AS minutos_asi,
    clientes_de_nodo(n.id) AS clientes_afectados
FROM clientes c
JOIN nodos_red n ON n.id IN (SELECT nodos_de_cliente(c.id))
WHERE n.estado IN ('down', 'warning')
  AND puede_ver_monitoreo();

GRANT SELECT ON v_incidencia_de_cliente TO authenticated;


-- =============================================================================
-- 4. Novedades de red
-- =============================================================================
-- Qué pasó mientras el técnico no estaba.
--
-- ── Por qué es un UNION y no un SELECT ──
--
-- `nodo_eventos` no guarda transiciones: guarda INTERVALOS. Una fila es "este
-- nodo estuvo caído desde las 05:42 hasta las 07:48", con `hasta` en nulo
-- mientras sigue caído.
--
-- Una línea de tiempo necesita las dos puntas del intervalo como dos noticias
-- distintas: a las 05:42 se cayó, a las 07:48 volvió. Sacarlas de la misma fila
-- con un solo SELECT daría una sola línea por caída, y el técnico que entra a
-- las 8 vería "TORRE PUJILÍ caída" sin enterarse de que ya volvió.
--
-- La ventaja de que sean intervalos: el cierre trae la duración exacta, que es
-- el dato que se pide en el aviso de recuperación.
DROP VIEW IF EXISTS v_novedades_red;
CREATE VIEW v_novedades_red AS
-- Cuándo empezó el problema.
SELECT
    e.id,
    e.nodo_id,
    n.nombre  AS nodo,
    n.tipo    AS nodo_tipo,
    pr.nombre AS punto,
    e.desde   AS momento,
    CASE WHEN e.estado = 'down' THEN 'caida' ELSE 'degradado' END AS clase,
    -- Nulo: todavía no terminó, así que no hay duración que contar.
    NULL::INT AS duracion_min,
    -- Si la caída se explica por la del padre, no es una noticia propia. Se
    -- marca en vez de esconderse: veinte nodos rojos por un solo corte de fibra
    -- hacen que nadie lea el próximo aviso.
    (e.causa_padre_id IS NOT NULL) AS por_el_padre
FROM nodo_eventos e
JOIN nodos_red n        ON n.id  = e.nodo_id
LEFT JOIN puntos_red pr ON pr.id = n.punto_id
WHERE e.estado IN ('down', 'warning')
  AND e.desde > NOW() - INTERVAL '7 days'
  AND puede_ver_monitoreo()

UNION ALL

-- Y cuándo se resolvió.
SELECT
    e.id,
    e.nodo_id,
    n.nombre  AS nodo,
    n.tipo    AS nodo_tipo,
    pr.nombre AS punto,
    e.hasta   AS momento,
    'recuperado' AS clase,
    (EXTRACT(EPOCH FROM (e.hasta - e.desde)) / 60)::INT AS duracion_min,
    (e.causa_padre_id IS NOT NULL) AS por_el_padre
FROM nodo_eventos e
JOIN nodos_red n        ON n.id  = e.nodo_id
LEFT JOIN puntos_red pr ON pr.id = n.punto_id
WHERE e.estado IN ('down', 'warning')
  AND e.hasta IS NOT NULL
  AND e.hasta > NOW() - INTERVAL '7 days'
  AND puede_ver_monitoreo();

COMMENT ON VIEW v_novedades_red IS
    'Línea de tiempo de la red en los últimos 7 días: cuándo se cayó cada nodo y cuándo volvió, con la duración. Ordenar por `momento` descendente.';

GRANT SELECT ON v_novedades_red TO authenticated;


-- =============================================================================
-- Cómo comprobar que quedó bien
-- =============================================================================
-- Con nodos cargados y clientes vinculados:
--
--   SELECT nombre, estado, clientes_afectados FROM v_estado_red;
--
--   SELECT * FROM v_incidencia_de_cliente WHERE client_id = '<un cliente>';
--
--   -- La columna de tiempo se llama `momento`, no `created_at`: la vista une
--   -- las dos puntas de cada intervalo —cuándo se cayó y cuándo volvió— y
--   -- ninguna de las dos es la fecha de creación de la fila.
--   SELECT momento, nodo, clase, duracion_min
--     FROM v_novedades_red
--    ORDER BY momento DESC;
--
-- Sin nodos cargados las tres devuelven vacío. Eso es correcto, no es un error:
-- no hay red monitoreada todavía.
