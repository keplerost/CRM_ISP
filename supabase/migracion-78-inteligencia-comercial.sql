-- =============================================================================
-- Migración 78 — Inteligencia comercial
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué contesta ──
--
-- Dónde te están pidiendo servicio y no llegás.
--
-- Cada vez que alguien verifica una cobertura y da negativo, el sistema guarda
-- la dirección, el sector y las coordenadas. Ese registro se viene acumulando
-- desde la migración 68 y nadie lo consulta. Agrupado, es un mapa de demanda
-- comprobada: no "creemos que en tal barrio hay mercado", sino "doce personas
-- de ese barrio llamaron preguntando y les dijimos que no".
--
-- Es la diferencia entre decidir dónde tender red por intuición y decidirlo por
-- pedidos que ya llegaron.
--
-- ── Lo que estas vistas NO hacen ──
--
-- No estiman cuánta plata se pierde en las consultas anónimas. Cuando alguien
-- pregunta y no queda cargado como prospecto, no se sabe qué plan habría
-- contratado, y multiplicar por un precio promedio produciría un número grande y
-- falso. Se cuentan las consultas —que es un hecho— y aparte se suma el valor
-- real de los prospectos que sí se cargaron y se perdieron por cobertura.
-- =============================================================================


-- =============================================================================
-- 1. Demanda insatisfecha, por sector
-- =============================================================================
DROP VIEW IF EXISTS v_demanda_por_sector;
CREATE VIEW v_demanda_por_sector WITH (security_invoker = true) AS
WITH consultas AS (
    SELECT
        COALESCE(NULLIF(BTRIM(sector), ''), 'Sin sector') AS sector,
        COUNT(*) FILTER (WHERE resultado = 'sin_cobertura')        AS sin_cobertura,
        COUNT(*) FILTER (WHERE resultado = 'con_obra')             AS con_obra,
        COUNT(*) FILTER (WHERE resultado = 'requiere_verificacion') AS a_verificar,
        COUNT(*)                                                    AS consultas_total,
        MIN(creado_en) AS primera_consulta,
        MAX(creado_en) AS ultima_consulta,
        -- El punto medio de las consultas del sector. Sirve para centrar el mapa
        -- en la zona sin tener que dibujar un polígono.
        AVG(latitud)  FILTER (WHERE latitud IS NOT NULL)  AS lat,
        AVG(longitud) FILTER (WHERE longitud IS NOT NULL) AS lng
    FROM verificaciones_cobertura
    GROUP BY 1
),
perdidos AS (
    -- Solo los que se perdieron POR cobertura, no todos los perdidos. El motivo
    -- está en un campo estructurado, no en el texto libre: agrupar texto escrito
    -- a mano produce categorías que no existen.
    SELECT
        COALESCE(NULLIF(BTRIM(sector), ''), 'Sin sector') AS sector,
        COUNT(*)                                  AS prospectos_perdidos,
        COALESCE(SUM(valor_mensual), 0)           AS valor_mensual_perdido
    FROM v_prospectos
    WHERE cobertura = 'no_factible'
    GROUP BY 1
)
SELECT
    COALESCE(c.sector, p.sector)                    AS sector,
    COALESCE(c.sin_cobertura, 0)                    AS sin_cobertura,
    COALESCE(c.con_obra, 0)                         AS con_obra,
    COALESCE(c.a_verificar, 0)                      AS a_verificar,
    COALESCE(c.consultas_total, 0)                  AS consultas_total,
    COALESCE(p.prospectos_perdidos, 0)              AS prospectos_perdidos,
    COALESCE(p.valor_mensual_perdido, 0)            AS valor_mensual_perdido,
    c.primera_consulta,
    c.ultima_consulta,
    c.lat,
    c.lng,

    -- El orden en que conviene mirar los sectores.
    --
    -- Pesa más un prospecto perdido que una consulta suelta: el primero llegó a
    -- cargarse, o sea que alguien habló con esa persona y quería el servicio.
    -- Una consulta puede ser un curioso.
    (COALESCE(c.sin_cobertura, 0) + COALESCE(c.con_obra, 0) * 0.5
     + COALESCE(p.prospectos_perdidos, 0) * 3)::NUMERIC(10,1) AS prioridad
FROM consultas c
FULL OUTER JOIN perdidos p ON p.sector = c.sector
WHERE COALESCE(c.sin_cobertura, 0) + COALESCE(c.con_obra, 0)
      + COALESCE(p.prospectos_perdidos, 0) > 0;

COMMENT ON VIEW v_demanda_por_sector IS
    'Dónde pidieron servicio y no llegamos. Demanda comprobada para decidir dónde tender red.';


-- =============================================================================
-- 2. Los puntos, para el mapa
-- =============================================================================
-- Cada consulta negativa con coordenadas. Sin agrupar: en el mapa, ver los
-- puntos separados muestra si la demanda está concentrada en una cuadra o
-- desparramada en todo el cantón — y eso cambia por completo la decisión.
DROP VIEW IF EXISTS v_puntos_sin_cobertura;
CREATE VIEW v_puntos_sin_cobertura WITH (security_invoker = true) AS
SELECT
    v.id,
    v.direccion,
    v.sector,
    v.latitud,
    v.longitud,
    v.resultado,
    v.distancia_m,
    v.creado_en,
    -- Si además quedó cargado como prospecto, se sabe cuánto valía.
    p.nombre        AS prospecto,
    p.valor_mensual
FROM verificaciones_cobertura v
LEFT JOIN v_prospectos p ON p.id = v.prospecto_id
WHERE v.resultado IN ('sin_cobertura', 'con_obra')
  AND v.latitud IS NOT NULL AND v.longitud IS NOT NULL;


-- =============================================================================
-- 3. Por dónde se pierde el embudo
-- =============================================================================
-- La tasa de cierre de cada canal. Es lo que dice en qué conviene gastar: si los
-- referidos cierran el triple que las redes, eso cambia el presupuesto del mes.
DROP VIEW IF EXISTS v_cierre_por_origen;
CREATE VIEW v_cierre_por_origen WITH (security_invoker = true) AS
SELECT
    origen,
    COUNT(*)                                        AS total,
    COUNT(*) FILTER (WHERE estado = 'ganado')       AS ganados,
    COUNT(*) FILTER (WHERE estado = 'perdido')      AS perdidos,
    COUNT(*) FILTER (WHERE estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,
    -- Sobre los CERRADOS, no sobre el total: incluir los que todavía están en
    -- proceso castiga a los canales que traen prospectos nuevos y hace que un
    -- canal viejo y agotado parezca mejor que uno que está funcionando hoy.
    CASE WHEN COUNT(*) FILTER (WHERE estado IN ('ganado','perdido')) = 0 THEN NULL
         ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE estado = 'ganado')
            / COUNT(*) FILTER (WHERE estado IN ('ganado','perdido')), 1)
    END AS tasa_cierre,
    COALESCE(SUM(valor_mensual) FILTER (WHERE estado = 'ganado'), 0) AS monto_ganado
FROM v_prospectos
GROUP BY origen;


-- =============================================================================
-- 4. Por qué se pierden
-- =============================================================================
-- `motivo_perdida` es texto libre y no se agrupa: escrito a mano, "precio",
-- "muy caro" y "no le alcanzaba" son tres categorías distintas para un GROUP BY
-- y la misma para una persona. Se listan crudos, ordenados por fecha, y se
-- cuenta aparte lo que SÍ está estructurado — la cobertura.
DROP VIEW IF EXISTS v_perdidos_recientes;
CREATE VIEW v_perdidos_recientes WITH (security_invoker = true) AS
SELECT
    p.id,
    p.nombre,
    p.sector,
    p.motivo_perdida,
    p.cobertura,
    p.valor_mensual,
    p.actualizado_en AS perdido_en,
    p.vendedor
FROM v_prospectos p
WHERE p.estado = 'perdido'
ORDER BY p.actualizado_en DESC;


-- =============================================================================
-- 5. Dónde se está por acabar el lugar
-- =============================================================================
-- Cajas con pocos puertos libres. Cruzado con la demanda del sector, dice dónde
-- hay que ampliar ANTES de que una venta se caiga por falta de boca — que es
-- distinto de "dónde no llegamos".
DROP VIEW IF EXISTS v_cajas_al_limite;
CREATE VIEW v_cajas_al_limite WITH (security_invoker = true) AS
SELECT
    n.id,
    n.nombre,
    n.direccion,
    n.latitud,
    n.longitud,
    n.capacidad,
    n.ocupadas,
    n.libres,
    n.llena,
    n.olt
FROM v_cajas_nap n
WHERE n.activo
  -- Sin capacidad cargada no se sabe, y "no sé" no es "está llena".
  AND n.capacidad IS NOT NULL
  AND n.libres <= 3
ORDER BY n.libres, n.nombre;
