-- =============================================================================
-- Migración 103 — Inteligencia comercial (Fase 7)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere la 100, la 101 y la 102.
--
-- ── Qué trae ──
--
-- Los números del punto 23 y la comparación del punto 19, en cuatro vistas:
--
--   v_comision_kpis       el mes, de punta a punta: embudo, ventas, dinero.
--   v_comision_equipo     una fila por vendedor y mes. Es la comparación.
--   v_comision_por_plan   qué se vende y cuánto vale el ticket promedio.
--   v_cartera_kpis        la foto de HOY: quién está por caerse y qué equipos
--                         hay en la calle.
--
-- ── Por qué la foto de hoy va aparte ──
--
-- Porque "clientes con 2 meses sin pagar" no es un dato de agosto: es un dato de
-- este momento, y mañana es otro. Mezclarlo en la tabla por mes produciría una
-- columna que cambia sola cada vez que se abre la pantalla, dentro de filas
-- históricas que no cambian nunca. Alguien la exportaría en septiembre y en
-- noviembre, obtendría números distintos para agosto y tendría razón en no
-- confiar en ninguno de los dos.
--
-- ── Lo que estas vistas NO hacen ──
--
-- Sancionar. El punto 19 es explícito: "no realizar sanciones automáticas, solo
-- mostrar información para decisión administrativa". Acá no hay ninguna columna
-- que descuente, marque ni bloquee a nadie: hay conteos y tasas, y quien decide
-- es una persona mirándolos.
--
-- ── Por qué ninguna llama al motor ──
--
-- `comision_de_periodo()` levanta una excepción si le preguntás por un vendedor
-- que no podés ver. Es correcto ahí y sería una trampa acá: una vista de equipo
-- que la invoque explota entera para cualquiera sin `comisiones.ver_todas`, en
-- vez de simplemente no mostrarle nada.
--
-- Así que estas vistas cuentan hechos —solicitudes, hitos, cohortes, órdenes de
-- retiro— y el dinero sale de donde ya está escrito: `comision_periodos` para lo
-- cerrado, y `v_comision_resumen` para lo proyectado, que la pantalla suma
-- aparte porque esa vista sí sabe filtrar por RLS.
-- =============================================================================


-- =============================================================================
-- 1. El mes, de punta a punta
-- =============================================================================
/**
 * Una fila por período con todo lo que el punto 23 pide contar.
 *
 * ── El embudo y el dinero, juntos ──
 *
 * Están en la misma fila a propósito: "45 solicitudes, 12 comisionables, $340 de
 * comisión" es una frase que se entiende. Las mismas tres cifras en tres
 * pantallas distintas obligan a que alguien las junte a mano, y ahí es donde
 * aparecen las diferencias de criterio.
 *
 * ── Sobre el ticket promedio ──
 *
 * Es el precio comercial del plan con el que quedó ACTIVADO el abonado, no la
 * base comisionable ni lo que pagó el primer mes con promoción. Es lo que va a
 * facturar todos los meses, que es lo que interesa para saber cuánto vale un
 * cliente nuevo.
 */
DROP VIEW IF EXISTS v_comision_kpis;
CREATE VIEW v_comision_kpis AS
SELECT
    per.periodo,

    -- ── El embudo ──
    (SELECT COUNT(*) FROM prospectos p
      WHERE DATE_TRUNC('month', p.creado_en)::DATE = per.periodo)          AS solicitudes,
    (SELECT COUNT(*) FROM prospectos p
      WHERE p.estado = 'ganado'
        AND DATE_TRUNC('month', p.actualizado_en)::DATE = per.periodo)     AS ganadas,
    (SELECT COUNT(*) FROM prospectos p
      WHERE p.estado = 'perdido'
        AND DATE_TRUNC('month', p.actualizado_en)::DATE = per.periodo)     AS perdidas,

    -- ── La admisión ──
    -- Cuenta las decisiones tomadas en el mes. Si la validación está apagada,
    -- estas tres dan cero y la pantalla lo dice en vez de mostrar una tasa
    -- calculada sobre nada.
    (SELECT COUNT(*) FROM solicitudes_validacion sv
      WHERE sv.estado = 'aprobado'
        AND DATE_TRUNC('month', sv.validado_en)::DATE = per.periodo)       AS aprobaciones,
    (SELECT COUNT(*) FROM solicitudes_validacion sv
      WHERE sv.estado = 'rechazado'
        AND DATE_TRUNC('month', sv.validado_en)::DATE = per.periodo)       AS rechazos,
    -- Las solicitudes que están esperando admisión NO van acá: son de hoy, no de
    -- agosto, y una columna así dentro de una fila histórica cambia sola cada
    -- vez que se abre la pantalla. Están en `v_cartera_kpis`, con el resto de la
    -- foto del momento.

    -- ── Las ventas del período ──
    COUNT(cv.id)                                                AS registradas,
    COUNT(cv.instalado_en)                                      AS instalaciones,
    COUNT(cv.activado_en)                                       AS activaciones,
    COUNT(cv.primer_pago_en)                                    AS primeros_pagos,
    COUNT(cv.comisionable_en)                                   AS comisionables,
    COUNT(*) FILTER (WHERE cv.estado = 'pendiente_validacion')  AS en_cortesia,
    COALESCE(SUM(cv.base) FILTER (WHERE cv.comisionable_en IS NOT NULL), 0) AS base_total,
    ROUND(AVG(pl.precio) FILTER (WHERE cv.comisionable_en IS NOT NULL), 2)  AS ticket_promedio,

    -- ── El dinero ya escrito ──
    -- De `comision_periodos`, que es lo que se congeló al cerrar. Lo PROYECTADO
    -- del mes en curso no está acá: todavía no existe como cifra cerrada, y la
    -- pantalla lo suma de `v_comision_resumen`.
    COALESCE((SELECT SUM(cp.monto) FROM comision_periodos cp
               WHERE cp.periodo = per.periodo), 0)              AS comision_cerrada,
    COALESCE((SELECT SUM(cp.monto) FROM comision_periodos cp
               WHERE cp.periodo = per.periodo AND cp.estado IN ('aprobado', 'pagado')), 0)
                                                                AS comision_aprobada,
    COALESCE((SELECT SUM(cp.monto) FROM comision_periodos cp
               WHERE cp.periodo = per.periodo AND cp.estado = 'pagado'), 0)
                                                                AS comision_pagada,
    COALESCE((SELECT SUM(cp.bono) FROM comision_periodos cp
               WHERE cp.periodo = per.periodo), 0)              AS bonos,

    -- ── Calidad del mes ──
    -- La cohorte que nació en este período: cómo terminó, si ya cerró.
    (SELECT COUNT(*) FROM comision_cohortes cc WHERE cc.cohorte = per.periodo)     AS cohortes,
    (SELECT SUM(cc.evaluables) FROM comision_cohortes cc WHERE cc.cohorte = per.periodo)  AS cohorte_evaluables,
    (SELECT SUM(cc.conservados) FROM comision_cohortes cc WHERE cc.cohorte = per.periodo) AS cohorte_conservados,
    (SELECT SUM(cc.perdidos) FROM comision_cohortes cc WHERE cc.cohorte = per.periodo)    AS cohorte_perdidos,

    -- ── Reactivaciones del mes ──
    -- No son ventas nuevas y por eso van en su propia columna: sumarlas a
    -- `comisionables` sería exactamente lo que el punto 14 prohíbe.
    (SELECT COUNT(*) FROM reactivaciones ra
      WHERE DATE_TRUNC('month', ra.reactivado_el)::DATE = per.periodo)     AS reactivaciones
FROM (
    SELECT DISTINCT x.periodo FROM comision_ventas x WHERE x.periodo IS NOT NULL
    UNION
    SELECT DATE_TRUNC('month', CURRENT_DATE)::DATE
) per
LEFT JOIN comision_ventas cv ON cv.periodo = per.periodo AND cv.estado <> 'anulada'
LEFT JOIN planes_velocidad pl ON pl.id = cv.plan_id
-- Sin `security_invoker`: la vista agrega el equipo entero, así que corre con
-- privilegio y decide adentro quién puede verla. Sin este filtro sería la
-- planilla de sueldos comerciales abierta a cualquiera con sesión.
WHERE ve_comisiones_de_todos()
GROUP BY per.periodo;

GRANT SELECT ON v_comision_kpis TO authenticated;

COMMENT ON VIEW v_comision_kpis IS
    'Los indicadores del punto 23 por período: embudo, ventas, dinero cerrado, calidad y reactivaciones.';


-- =============================================================================
-- 2. La comparación entre vendedores
-- =============================================================================
/**
 * Una fila por vendedor y período. El punto 19.
 *
 * ── Qué permite ver ──
 *
 * El ejemplo del requerimiento, exacto: el vendedor A ingresa 32 solicitudes y
 * conserva el 94 % a los 90 días; el B ingresa 48 y conserva el 71 %. Los dos
 * "venden mucho". Uno construye cartera y el otro construye trabajo para el
 * área de cobranza.
 *
 * Sin esta vista, la única forma de notarlo es que alguien sume a mano tres
 * pantallas distintas, y eso no pasa hasta que el problema ya es grande.
 *
 * ── Por qué las tasas pueden venir en NULL ──
 *
 * Porque dividir por cero da una respuesta falsa con cara de dato. Un vendedor
 * sin solicitudes no tiene una tasa de conversión del 0 %: no tiene tasa. La
 * pantalla muestra un guion, que es lo que corresponde.
 */
DROP VIEW IF EXISTS v_comision_equipo;
CREATE VIEW v_comision_equipo AS
SELECT
    u.id AS vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    per.periodo,

    (SELECT COUNT(*) FROM prospectos p
      WHERE p.vendedor_id = u.id
        AND DATE_TRUNC('month', p.creado_en)::DATE = per.periodo)          AS solicitudes,
    (SELECT COUNT(*) FROM prospectos p
      WHERE p.vendedor_id = u.id AND p.estado = 'ganado'
        AND DATE_TRUNC('month', p.actualizado_en)::DATE = per.periodo)     AS ganadas,
    (SELECT COUNT(*) FROM prospectos p
      JOIN solicitudes_validacion sv ON sv.prospecto_id = p.id
     WHERE p.vendedor_id = u.id AND sv.estado = 'aprobado'
       AND DATE_TRUNC('month', sv.validado_en)::DATE = per.periodo)        AS aprobadas,
    (SELECT COUNT(*) FROM prospectos p
      JOIN solicitudes_validacion sv ON sv.prospecto_id = p.id
     WHERE p.vendedor_id = u.id AND sv.estado = 'rechazado'
       AND DATE_TRUNC('month', sv.validado_en)::DATE = per.periodo)        AS rechazadas,

    COUNT(cv.id)                                                AS registradas,
    COUNT(cv.instalado_en)                                      AS instaladas,
    COUNT(cv.primer_pago_en)                                    AS primeros_pagos,
    COUNT(cv.comisionable_en)                                   AS comisionables,
    COUNT(*) FILTER (WHERE cv.estado = 'pendiente_validacion')  AS en_cortesia,
    COALESCE(SUM(cv.base) FILTER (WHERE cv.comisionable_en IS NOT NULL), 0) AS base_total,

    -- ── Las tasas ──
    ROUND(COUNT(cv.comisionable_en) * 100.0
          / NULLIF((SELECT COUNT(*) FROM prospectos p
                     WHERE p.vendedor_id = u.id
                       AND DATE_TRUNC('month', p.creado_en)::DATE = per.periodo), 0), 1)
                                                                AS tasa_conversion,
    ROUND(COUNT(cv.primer_pago_en) * 100.0
          / NULLIF(COUNT(cv.instalado_en), 0), 1)               AS tasa_primer_pago,

    -- ── La calidad de su cohorte de ese mes ──
    coh.calidad                                                 AS retencion,
    coh.evaluables                                              AS cohorte_evaluables,
    coh.perdidos                                                AS cohorte_perdidos,
    coh.bono,
    coh.estado                                                  AS cohorte_estado,

    (SELECT COUNT(*) FROM reactivaciones ra
      WHERE ra.vendedor_id = u.id
        AND DATE_TRUNC('month', ra.reactivado_el)::DATE = per.periodo)     AS reactivaciones
FROM usuarios_sistema u
CROSS JOIN LATERAL (
    SELECT DISTINCT x.periodo FROM comision_ventas x
     WHERE x.vendedor_id = u.id AND x.periodo IS NOT NULL
    UNION
    SELECT DATE_TRUNC('month', CURRENT_DATE)::DATE
) per
LEFT JOIN comision_ventas cv ON cv.vendedor_id = u.id
                            AND cv.periodo = per.periodo
                            AND cv.estado <> 'anulada'
LEFT JOIN comision_cohortes coh ON coh.vendedor_id = u.id AND coh.cohorte = per.periodo
WHERE ve_comisiones_de_todos()
  /**
   * Quién entra en la comparación.
   *
   * Todo el que ALGUNA VEZ vendió, esté activo hoy o no. Filtrar por `activo`
   * parecía razonable hasta ver la consecuencia: las ventas de quien se fue en
   * marzo desaparecerían de marzo, y la suma de los vendedores dejaría de dar el
   * total del mes. Un tablero cuyas filas no suman el total es un tablero que
   * nadie vuelve a mirar.
   *
   * Y además los vendedores activos aunque todavía no tengan una sola venta:
   * son los que hay que mirar, no los que hay que esconder.
   */
  AND (
      EXISTS (SELECT 1 FROM comision_ventas x WHERE x.vendedor_id = u.id)
      OR (u.activo AND u.rol IN ('vendedor', 'supervisor_ventas'))
  )
GROUP BY u.id, u.nombre, u.apellido, per.periodo,
         coh.calidad, coh.evaluables, coh.perdidos, coh.bono, coh.estado;

GRANT SELECT ON v_comision_equipo TO authenticated;

COMMENT ON VIEW v_comision_equipo IS
    'Comparación entre vendedores: embudo, tasas y retención por cohorte. Información para decidir, no para sancionar.';


-- =============================================================================
-- 3. Qué se vende
-- =============================================================================
/**
 * Ventas comisionables por plan y período.
 *
 * Sirve para la pregunta que ordena el esquema entero: si el 70 % de lo que se
 * vende es el plan más barato, subir la base del más caro no cambia nada y hay
 * que mirar el escalón, no la base.
 */
DROP VIEW IF EXISTS v_comision_por_plan;
CREATE VIEW v_comision_por_plan AS
SELECT
    cv.periodo,
    cv.plan_id,
    COALESCE(pl.nombre, 'Sin plan')  AS plan,
    pl.precio                        AS precio_plan,
    COUNT(*)                         AS ventas,
    COUNT(cv.comisionable_en)        AS comisionables,
    COALESCE(SUM(cv.base) FILTER (WHERE cv.comisionable_en IS NOT NULL), 0) AS base_total,
    ROUND(AVG(cv.base) FILTER (WHERE cv.comisionable_en IS NOT NULL), 2)    AS base_promedio
FROM comision_ventas cv
LEFT JOIN planes_velocidad pl ON pl.id = cv.plan_id
WHERE cv.estado <> 'anulada'
  AND ve_comisiones_de_todos()
GROUP BY cv.periodo, cv.plan_id, pl.nombre, pl.precio;

GRANT SELECT ON v_comision_por_plan TO authenticated;


-- =============================================================================
-- 4. La foto de hoy
-- =============================================================================
/**
 * Lo que está pasando ahora mismo con la cartera y con los equipos.
 *
 * ── Por qué el cálculo de meses va escrito acá y no llama a `meses_sin_pago()` ──
 *
 * Porque esa función hace una consulta por abonado, y acá se recorre la base
 * entera: con dos mil clientes serían cuatro mil consultas para pintar una
 * tarjeta. La misma cuenta hecha con un solo agregado tarda lo que tarda una
 * consulta.
 *
 * La fórmula es la MISMA —meses cumplidos con `AGE`, contra el último pago no
 * anulado y, si nunca pagó, contra la activación—. Es una duplicación
 * deliberada y tiene su costo: si algún día cambia la definición de "meses sin
 * pagar", hay que cambiarla en los DOS lugares, acá y en `meses_sin_pago()` de
 * la migración 100. Está escrito así de explícito para que quien la cambie lo
 * lea antes.
 */
DROP VIEW IF EXISTS v_cartera_kpis;
CREATE VIEW v_cartera_kpis AS
WITH reglas AS (
    SELECT COALESCE(r.meses_sin_pago_suspension, 1) AS suspension,
           COALESCE(r.meses_sin_pago_retiro, 2)     AS retiro
      FROM comision_reglas r
     WHERE r.esquema_id = esquema_comisiones_vigente(CURRENT_DATE)
    UNION ALL
    -- Sin esquema cargado la pantalla igual tiene que poder abrirse.
    SELECT 1, 2
     WHERE NOT EXISTS (
        SELECT 1 FROM comision_reglas r2
         WHERE r2.esquema_id = esquema_comisiones_vigente(CURRENT_DATE))
),
atrasos AS (
    SELECT
        c.id,
        (EXTRACT(YEAR  FROM AGE(CURRENT_DATE, COALESCE(
             MAX(pg.fecha_pago)::DATE, c.activado_en::DATE,
             c.fecha_instalacion::DATE, c.created_at::DATE))) * 12
       + EXTRACT(MONTH FROM AGE(CURRENT_DATE, COALESCE(
             MAX(pg.fecha_pago)::DATE, c.activado_en::DATE,
             c.fecha_instalacion::DATE, c.created_at::DATE))))::INT AS meses
    FROM clientes c
    LEFT JOIN pagos pg ON pg.client_id = c.id AND NOT pg.anulado
    WHERE c.estado <> 'baja'
    GROUP BY c.id, c.activado_en, c.fecha_instalacion, c.created_at
)
SELECT
    (SELECT COUNT(*) FROM atrasos a, reglas g
      WHERE a.meses >= g.suspension AND a.meses < g.retiro)          AS clientes_1_mes,
    (SELECT COUNT(*) FROM atrasos a, reglas g
      WHERE a.meses >= g.retiro)                                     AS clientes_2_meses,

    -- ── Equipos ──
    (SELECT COUNT(*) FROM retiros_equipo r
      WHERE r.estado IN ('pendiente', 'asignado'))                   AS ont_pendientes,
    (SELECT COUNT(*) FROM retiros_equipo r WHERE r.estado = 'recuperado')     AS ont_recuperadas,
    (SELECT COUNT(*) FROM retiros_equipo r WHERE r.estado = 'no_recuperado')  AS ont_no_recuperadas,
    COALESCE((SELECT SUM(r.valor) FROM retiros_equipo r
               WHERE r.estado IN ('pendiente', 'asignado')), 0)      AS valor_en_riesgo,
    COALESCE((SELECT SUM(r.valor) FROM retiros_equipo r
               WHERE r.estado = 'no_recuperado'), 0)                 AS valor_perdido,

    -- ── Movimiento del mes ──
    (SELECT COUNT(*) FROM reactivaciones ra
      WHERE DATE_TRUNC('month', ra.reactivado_el) = DATE_TRUNC('month', CURRENT_DATE))
                                                                     AS reactivaciones_mes,
    -- Bajas tempranas: se fueron dentro del plazo de seguimiento de su cohorte.
    -- Es la señal que el punto 18 pide medir sin usarla para descontar nada.
    (SELECT COUNT(*) FROM comision_ventas cv
      WHERE cv.calidad_estado = 'perdido'
        AND cv.comisionable_en >= CURRENT_DATE - INTERVAL '12 months') AS bajas_tempranas,

    (SELECT COUNT(*) FROM solicitudes_validacion sv
      WHERE sv.estado IN ('pendiente', 'revision_manual', 'requiere_info'))  AS validaciones_abiertas,

    (SELECT COUNT(*) FROM comision_periodos cp WHERE cp.estado = 'cerrado')  AS periodos_por_aprobar,
    COALESCE((SELECT SUM(cp.monto + cp.bono) FROM comision_periodos cp
               WHERE cp.estado = 'cerrado'), 0)                      AS monto_por_aprobar
WHERE ve_comisiones_de_todos();

GRANT SELECT ON v_cartera_kpis TO authenticated;

COMMENT ON VIEW v_cartera_kpis IS
    'La foto de hoy: clientes por caerse, ONT en la calle y lo que espera autorización. No es histórico: cambia cada día.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT periodo, solicitudes, ganadas, comisionables, base_total,
--          ticket_promedio, comision_cerrada, bonos, reactivaciones
--     FROM v_comision_kpis ORDER BY periodo DESC;
--
--   -- La comparación del punto 19:
--   SELECT vendedor, solicitudes, ganadas, instaladas, primeros_pagos,
--          comisionables, tasa_conversion, retencion
--     FROM v_comision_equipo
--    WHERE periodo = DATE_TRUNC('month', CURRENT_DATE)::DATE
--    ORDER BY comisionables DESC;
--
--   SELECT * FROM v_cartera_kpis;
--
--   SELECT plan, ventas, comisionables, base_promedio
--     FROM v_comision_por_plan
--    WHERE periodo = DATE_TRUNC('month', CURRENT_DATE)::DATE
--    ORDER BY ventas DESC;
