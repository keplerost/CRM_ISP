-- =============================================================================
-- Migración 81 — El precio que se le dice al cliente lleva IVA
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El problema ──
--
-- `planes_velocidad.precio` es el precio NETO. Con un plan de 20.09 y 15% de
-- IVA, lo que el abonado paga son 23.10. Todo el módulo comercial —el cotizador,
-- el selector de plan del prospecto, el valor del embudo— venía mostrando 20.09.
--
-- Eso no es un redondeo: es que el vendedor dice "veinte" por teléfono y al mes
-- llega una factura de veintitrés. El cliente siente que le cambiaron el precio,
-- y la conversación siguiente la tiene el vendedor.
--
-- ── La regla, de ahora en adelante ──
--
-- En el módulo comercial, precio = LO QUE PAGA EL CLIENTE. El neto sigue
-- existiendo para contabilidad y facturación, que es donde corresponde.
--
-- `v_planes` ya calculaba las tres formas —`precio_sin_iva`, `iva_valor`,
-- `precio_total`— contemplando los tres modos de impuesto: incluido, más, y
-- exento. No hay que calcular nada nuevo: hay que usar la columna correcta.
-- =============================================================================


-- =============================================================================
-- 1. El valor de una oportunidad
-- =============================================================================
-- Reemplaza la versión de la 79, que caía al precio neto.
--
-- La cotización sigue mandando sobre el plan: si al cliente se le cotizó un
-- número, ese es el que vale. Lo que cambia es el respaldo cuando no hay
-- cotización — antes el neto, ahora el total.
CREATE OR REPLACE FUNCTION valor_del_prospecto(p_prospecto UUID, p_precio_lista NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT c.precio_mensual FROM cotizaciones c
          WHERE c.prospecto_id = p_prospecto
          ORDER BY c.creado_en DESC LIMIT 1),
        p_precio_lista,
        0
    )
$$;

-- Las vistas de reportes le pasan ahora `precio_total` en vez de `precio`. Se
-- recrean las tres para que el cambio sea completo: dejar una con el neto
-- produciría dos reportes que no cuadran, que es peor que tenerlos todos mal.
DROP VIEW IF EXISTS v_reporte_mensual;
CREATE VIEW v_reporte_mensual WITH (security_invoker = true) AS
SELECT
    DATE_TRUNC('month', p.creado_en)::DATE       AS mes,
    COUNT(*)                                      AS cargados,
    COUNT(*) FILTER (WHERE p.estado = 'ganado')   AS ganados,
    COUNT(*) FILTER (WHERE p.estado = 'perdido')  AS perdidos,
    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio_total))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto
FROM prospectos p
LEFT JOIN v_planes pl ON pl.id = p.plan_id
GROUP BY 1
ORDER BY 1;

DROP VIEW IF EXISTS v_reporte_vendedores;
CREATE VIEW v_reporte_vendedores WITH (security_invoker = true) AS
SELECT
    u.id                                    AS vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', u.apellido)) AS vendedor,
    u.activo,
    COUNT(p.id)                                       AS cargados,
    COUNT(p.id) FILTER (WHERE p.estado = 'ganado')    AS ganados,
    COUNT(p.id) FILTER (WHERE p.estado = 'perdido')   AS perdidos,
    COUNT(p.id) FILTER (WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,
    CASE WHEN COUNT(p.id) FILTER (WHERE p.estado IN ('ganado','perdido')) = 0 THEN NULL
         ELSE ROUND(100.0 * COUNT(p.id) FILTER (WHERE p.estado = 'ganado')
              / COUNT(p.id) FILTER (WHERE p.estado IN ('ganado','perdido')), 1)
    END AS tasa_cierre,
    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio_total))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto_total,
    ROUND(AVG(
        EXTRACT(EPOCH FROM (p.ganado_en - p.creado_en)) / 86400
    ) FILTER (WHERE p.ganado_en IS NOT NULL)::NUMERIC, 1) AS dias_cierre
FROM usuarios_sistema u
LEFT JOIN prospectos p ON p.vendedor_id = u.id
LEFT JOIN v_planes pl  ON pl.id = p.plan_id
WHERE u.rol IN ('vendedor', 'supervisor_ventas', 'admin', 'super_admin')
GROUP BY u.id, u.nombre, u.apellido, u.activo;

DROP VIEW IF EXISTS v_reporte_planes;
CREATE VIEW v_reporte_planes WITH (security_invoker = true) AS
SELECT
    COALESCE(pl.nombre, 'Sin plan definido')     AS plan,
    -- Las dos, para que el dueño vea qué factura y qué le queda.
    pl.precio_total                               AS precio,
    pl.precio_sin_iva,
    COUNT(*)                                      AS cotizados,
    COUNT(*) FILTER (WHERE p.estado = 'ganado')   AS ganados,
    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio_total))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto
FROM prospectos p
LEFT JOIN v_planes pl ON pl.id = p.plan_id
GROUP BY pl.nombre, pl.precio_total, pl.precio_sin_iva
ORDER BY 6 DESC;

DROP VIEW IF EXISTS v_reporte_sectores;
CREATE VIEW v_reporte_sectores WITH (security_invoker = true) AS
SELECT
    COALESCE(NULLIF(BTRIM(p.sector), ''), 'Sin sector') AS sector,
    COUNT(*)                                             AS prospectos,
    COUNT(*) FILTER (WHERE p.estado = 'ganado')          AS ganados,
    COUNT(*) FILTER (WHERE p.estado = 'perdido')         AS perdidos,
    CASE WHEN COUNT(*) FILTER (WHERE p.estado IN ('ganado','perdido')) = 0 THEN NULL
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE p.estado = 'ganado')
              / COUNT(*) FILTER (WHERE p.estado IN ('ganado','perdido')), 1)
    END AS tasa_cierre,
    COALESCE(SUM(valor_del_prospecto(p.id, pl.precio_total))
             FILTER (WHERE p.estado = 'ganado'), 0) AS monto
FROM prospectos p
LEFT JOIN v_planes pl ON pl.id = p.plan_id
GROUP BY 1
ORDER BY 3 DESC;


-- =============================================================================
-- 2. El embudo
-- =============================================================================
-- `v_prospectos.valor_mensual` alimenta el tablero: "dinero en juego",
-- "facturación nueva", el puntaje. Pasaba lo mismo — sumaba netos.
--
-- Se recrea entera porque no hay forma de cambiarle una columna a una vista. Es
-- idéntica a la de la migración 68 salvo por el JOIN a `v_planes` y las dos
-- columnas de precio.
--
-- `v_prospectos` es el eje del módulo comercial: cinco vistas cuelgan de ella.
-- Postgres no deja reemplazarla mientras existan, así que hay que bajarlas y
-- volver a levantarlas — están todas más abajo, ninguna se pierde.
--
-- Se listan una por una en vez de usar CASCADE a propósito. CASCADE también
-- funcionaría, pero borraría en silencio cualquier vista que alguien haya creado
-- después y que yo no conozca. Nombrarlas obliga a que el archivo diga
-- exactamente qué toca, y si mañana aparece una sexta, la migración falla y
-- avisa en vez de hacerla desaparecer.
DROP VIEW IF EXISTS v_comercial_vendedor;
DROP VIEW IF EXISTS v_demanda_por_sector;
DROP VIEW IF EXISTS v_puntos_sin_cobertura;
DROP VIEW IF EXISTS v_cierre_por_origen;
DROP VIEW IF EXISTS v_perdidos_recientes;
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `plan_precio_neto`, la cadena siguió y esta versión quedó
     * atrás: la esta misma migracion la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_prospectos'
           AND column_name = 'plan_precio_neto'
    ) THEN
        RAISE NOTICE 'v_prospectos ya está en su versión de la esta misma migracion: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_prospectos';
    EXECUTE $vista$
CREATE VIEW v_prospectos WITH (security_invoker = true) AS
WITH base AS (
    SELECT
        p.*,
        pl.nombre        AS plan,
        -- El precio que se le dice al cliente.
        pl.precio_total  AS plan_precio,
        -- Y el neto, disponible para quien lo necesite sin tener que ir al
        -- catálogo: la comisión y la contabilidad miran este.
        pl.precio_sin_iva AS plan_precio_neto,
        pl.iva_valor      AS plan_iva,
        TRIM(CONCAT(v.nombre, ' ', v.apellido)) AS vendedor,
        n.nombre   AS nap,

        (SELECT COUNT(*) FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'completado') AS actividades,
        (SELECT MAX(a.creado_en) FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'completado') AS ultima_actividad,
        (SELECT a.resultado FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'completado'
          ORDER BY a.creado_en DESC LIMIT 1) AS ultimo_resultado,
        (SELECT COUNT(*) FROM cotizaciones c WHERE c.prospecto_id = p.id) AS cotizaciones,
        COALESCE(
            (SELECT c.precio_mensual FROM cotizaciones c
              WHERE c.prospecto_id = p.id ORDER BY c.creado_en DESC LIMIT 1),
            pl.precio_total, 0
        ) AS valor_mensual,
        (SELECT COUNT(*) FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'pendiente'
            AND a.programado_para < NOW()) AS seguimientos_vencidos
    FROM prospectos p
    LEFT JOIN v_planes pl      ON pl.id = p.plan_id
    LEFT JOIN usuarios_sistema v ON v.id = p.vendedor_id
    LEFT JOIN puntos_red       n ON n.id = p.nap_id
),
senales AS (
    SELECT
        b.*,
        EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en))::INT AS dias_sin_contacto,
        CASE b.estado WHEN 'negociacion' THEN 40 WHEN 'cotizado' THEN 30
                      WHEN 'contactado' THEN 15 WHEN 'nuevo' THEN 5 ELSE 0 END AS pt_etapa,
        CASE b.cobertura WHEN 'factible' THEN 25 WHEN 'con_obra' THEN 10
                         WHEN 'no_factible' THEN -40 ELSE 0 END AS pt_cobertura,
        CASE b.ultimo_resultado WHEN 'interesado' THEN 15 WHEN 'contactado' THEN 5
                                WHEN 'no_contesta' THEN -5 WHEN 'no_interesado' THEN -30
                                ELSE 0 END AS pt_resultado,
        CASE WHEN b.cotizaciones > 0 THEN 15 ELSE 0 END AS pt_cotizacion,
        CASE
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 2 THEN 10
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 5 THEN 5
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 10 THEN 0
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 20 THEN -10
            ELSE -20
        END AS pt_frescura
    FROM base b
)
SELECT
    s.*,
    CASE WHEN s.estado IN ('ganado', 'perdido') THEN 0
         ELSE GREATEST(0, LEAST(100,
             s.pt_etapa + s.pt_cobertura + s.pt_resultado + s.pt_cotizacion + s.pt_frescura))
    END AS puntaje,
    ARRAY_REMOVE(ARRAY[
        CASE WHEN s.pt_etapa      >= 30 THEN 'Etapa avanzada' END,
        CASE WHEN s.pt_cobertura  >= 25 THEN 'Tiene cobertura'
             WHEN s.pt_cobertura  <   0 THEN 'Fuera de cobertura' END,
        CASE WHEN s.pt_cotizacion >   0 THEN 'Ya cotizado' END,
        CASE WHEN s.pt_resultado  >   0 THEN 'Se mostró interesado'
             WHEN s.pt_resultado  <   0 THEN 'Última respuesta fría' END,
        CASE WHEN s.pt_frescura   >   0 THEN 'Contacto reciente'
             WHEN s.pt_frescura   <   0 THEN 'Se está enfriando' END,
        CASE WHEN s.seguimientos_vencidos > 0 THEN 'Tiene seguimientos vencidos' END
    ], NULL) AS motivos_puntaje
FROM senales s
$vista$;
END $guarda$;


-- =============================================================================
-- 3. El resumen por vendedor
-- =============================================================================
-- Se recrea porque depende de `v_prospectos`, que se acaba de reemplazar.
--
-- La comisión pasa a calcularse sobre el NETO y no sobre el total. El IVA no es
-- ingreso del ISP: se cobra y se entrega al SRI. Comisionar sobre él sería pagar
-- porcentaje sobre plata que no queda en la empresa.
CREATE VIEW v_comercial_vendedor WITH (security_invoker = true) AS
SELECT
    u.id                                  AS vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', u.apellido)) AS vendedor,
    u.nombre                              AS nombre_pila,
    m.meta_altas,
    m.meta_monto,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS altas_mes,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ), 0) AS monto_mes,

    ROUND(
        COALESCE(SUM(p.plan_precio_neto) FILTER (
            WHERE p.estado = 'ganado'
              AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
        ), 0) * (SELECT comision_porcentaje FROM config_cartera WHERE id = 1) / 100,
        2
    ) AS comision_mes,

    COUNT(p.id) FILTER (WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')
    ), 0) AS monto_en_juego,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'perdido'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS perdidos_mes,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW() - INTERVAL '1 month')
    ) AS altas_mes_pasado,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW() - INTERVAL '1 month')
    ), 0) AS monto_mes_pasado
FROM usuarios_sistema u
LEFT JOIN v_prospectos p ON p.vendedor_id = u.id
LEFT JOIN metas_venta  m ON m.vendedor_id = u.id
                        AND m.anio = EXTRACT(YEAR  FROM NOW())::SMALLINT
                        AND m.mes  = EXTRACT(MONTH FROM NOW())::SMALLINT
WHERE u.rol IN ('vendedor', 'supervisor_ventas', 'admin', 'super_admin')
GROUP BY u.id, u.nombre, u.apellido, m.meta_altas, m.meta_monto;




-- =============================================================================
-- 4. Las vistas de inteligencia, de vuelta
-- =============================================================================
-- Idénticas a las de la migración 78. Se recrean porque cuelgan de
-- `v_prospectos`, no porque cambien: los montos que muestran ahora incluyen IVA
-- solos, heredado de la vista de abajo.

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
        AVG(latitud)  FILTER (WHERE latitud IS NOT NULL)  AS lat,
        AVG(longitud) FILTER (WHERE longitud IS NOT NULL) AS lng
    FROM verificaciones_cobertura
    GROUP BY 1
),
perdidos AS (
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
    (COALESCE(c.sin_cobertura, 0) + COALESCE(c.con_obra, 0) * 0.5
     + COALESCE(p.prospectos_perdidos, 0) * 3)::NUMERIC(10,1) AS prioridad
FROM consultas c
FULL OUTER JOIN perdidos p ON p.sector = c.sector
WHERE COALESCE(c.sin_cobertura, 0) + COALESCE(c.con_obra, 0)
      + COALESCE(p.prospectos_perdidos, 0) > 0;

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
    p.nombre        AS prospecto,
    p.valor_mensual
FROM verificaciones_cobertura v
LEFT JOIN v_prospectos p ON p.id = v.prospecto_id
WHERE v.resultado IN ('sin_cobertura', 'con_obra')
  AND v.latitud IS NOT NULL AND v.longitud IS NOT NULL;

DROP VIEW IF EXISTS v_cierre_por_origen;
CREATE VIEW v_cierre_por_origen WITH (security_invoker = true) AS
SELECT
    origen,
    COUNT(*)                                        AS total,
    COUNT(*) FILTER (WHERE estado = 'ganado')       AS ganados,
    COUNT(*) FILTER (WHERE estado = 'perdido')      AS perdidos,
    COUNT(*) FILTER (WHERE estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,
    CASE WHEN COUNT(*) FILTER (WHERE estado IN ('ganado','perdido')) = 0 THEN NULL
         ELSE ROUND(
            100.0 * COUNT(*) FILTER (WHERE estado = 'ganado')
            / COUNT(*) FILTER (WHERE estado IN ('ganado','perdido')), 1)
    END AS tasa_cierre,
    COALESCE(SUM(valor_mensual) FILTER (WHERE estado = 'ganado'), 0) AS monto_ganado
FROM v_prospectos
GROUP BY origen;

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
-- Sobre las cotizaciones ya guardadas
-- =============================================================================
-- `cotizaciones.precio_mensual` guarda lo que el vendedor escribió al cotizar.
-- Las hechas antes de este cambio tienen el neto; las nuevas van a tener el
-- total. NO se convierten hacia atrás a propósito: una cotización es lo que se
-- le dijo al cliente en ese momento, y reescribirla cambiaría el registro de una
-- conversación que ya pasó.
--
-- Si hay alguna vigente con el precio viejo, conviene rehacerla.
