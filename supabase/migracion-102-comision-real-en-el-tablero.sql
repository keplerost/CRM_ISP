-- =============================================================================
-- Migración 102 — El tablero deja de estimar la comisión (Fase 6)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere la 98 (el motor) y la 100 (cohortes y bono).
--
-- ── El problema que arregla ──
--
-- El tablero comercial muestra "Comisión generada" desde la migración 77, y ese
-- número sale de una cuenta que el requerimiento prohíbe explícitamente:
--
--     prospectos marcados como GANADOS este mes × un porcentaje fijo
--
-- Es exactamente el punto 8 —"la comisión NO debe generarse solamente porque el
-- vendedor marque una oportunidad como Ganada"— y también el punto 4, porque
-- ignora los escalones. Aquella migración lo decía en su propio encabezado: "un
-- porcentaje sobre la primera mensualidad es el caso más común... cuando haga
-- falta más, la columna se reemplaza por la tabla y la vista cambia en un solo
-- lugar". Esta es esa vez.
--
-- ── Por qué no se deja el número viejo conviviendo con el nuevo ──
--
-- Porque serían dos respuestas distintas a "cuánto llevo este mes", en dos
-- pantallas del mismo sistema, y la que el vendedor va a creer es la más alta.
-- Discutir cuál valía sería una conversación evitable: hay un solo motor y todo
-- lee de él.
--
-- ── Qué NO se borra ──
--
-- `config_cartera.comision_porcentaje` se queda donde está, con un comentario
-- que dice que ya no se usa. Borrar una columna que alguien pudo haber llenado
-- —y que aparece en respaldos y en reportes viejos— no aporta nada y rompe
-- cualquier consulta hecha a mano que la mire.
-- =============================================================================


-- =============================================================================
-- 1. La vista del tablero, leyendo del motor
-- =============================================================================
/**
 * Se recrea igual que estaba salvo la comisión, que ahora viene de
 * `v_comision_resumen`.
 *
 * ── Por qué se lee la VISTA y no se llama a la función ──
 *
 * `comision_de_periodo()` levanta una excepción si le preguntás por un vendedor
 * que no podés ver — es lo que impide que alguien averigüe el sueldo de un
 * compañero desde la consola. Esta vista devuelve una fila por cada persona del
 * equipo comercial, así que llamar a la función en cada fila haría que la
 * consulta ENTERA fallara para cualquiera sin `comisiones.ver_todas`: el
 * vendedor abriría su tablero y no vería nada.
 *
 * `v_comision_resumen` ya resuelve eso: lleva `security_invoker`, RLS le deja
 * ver solo lo suyo y las filas ajenas simplemente no aparecen. Lo que no se
 * puede ver queda en NULL, y NULL acá significa cero.
 */
DROP VIEW IF EXISTS v_comercial_vendedor;
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

    -- ── La comisión, del motor ──
    --
    -- Es la proyectada del mes en curso: cuenta solo las ventas que ya cumplieron
    -- todos los requisitos configurados, y aplica el escalón alcanzado con el
    -- modo del esquema (retroactivo o progresivo).
    COALESCE(r.monto, 0)                  AS comision_mes,
    -- Las tres que hacen que el número se entienda sin abrir otra pantalla. Sin
    -- el conteo, "$146" no se puede verificar; con "25 ventas · ORO 40 %", sí.
    COALESCE(r.ventas_validas, 0)         AS comision_ventas,
    r.nivel                               AS comision_nivel,
    COALESCE(r.porcentaje, 0)             AS comision_nivel_pct,
    -- Las que cumplen todo menos el primer pago y siguen en cortesía. Es la
    -- diferencia entre "no vendiste" y "todavía no te lo puedo contar".
    COALESCE(r.pendientes, 0)             AS comision_pendientes,

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
LEFT JOIN v_comision_resumen r ON r.vendedor_id = u.id
                              AND r.periodo = DATE_TRUNC('month', NOW())::DATE
WHERE u.rol IN ('vendedor', 'supervisor_ventas', 'admin', 'super_admin')
GROUP BY u.id, u.nombre, u.apellido, m.meta_altas, m.meta_monto,
         r.monto, r.ventas_validas, r.nivel, r.porcentaje, r.pendientes;

COMMENT ON VIEW v_comercial_vendedor IS
    'Resumen por vendedor para el tablero. La comisión sale del motor de comisiones, no de un porcentaje sobre prospectos ganados.';

COMMENT ON COLUMN config_cartera.comision_porcentaje IS
    'OBSOLETO desde la migración 102. La comisión la calcula el motor (comision_de_periodo) con las bases y los escalones configurados en Comisiones e Incentivos. Se conserva para no romper consultas viejas.';


-- =============================================================================
-- 2. El embudo del vendedor
-- =============================================================================
/**
 * Las dos métricas del punto 6, una al lado de la otra.
 *
 * ── Por qué hace falta una vista y no basta con contar en la pantalla ──
 *
 * Porque "30 solicitudes ingresadas NO significan 30 ventas" solo se demuestra
 * si los dos números salen de la misma consulta. Contando prospectos en el
 * navegador y comisiones en otra llamada, cualquier diferencia de criterio
 * —¿cuenta el mes de carga o el de cierre?— produce un embudo que no cierra y
 * que nadie puede auditar.
 *
 * ── Qué mide cada escalón ──
 *
 *   solicitudes    prospectos cargados en el mes. Es el trabajo hecho.
 *   ganadas        los que el vendedor marcó como cerrados.
 *   registradas    los que el motor tomó como venta (tienen cliente).
 *   aprobadas      pasaron admisión, cuando esa exigencia está encendida.
 *   instaladas / activadas / con_primer_pago  los hitos reales.
 *   comisionables  las que cumplen TODO lo que pide su esquema.
 *
 * El período es el de la comisión, no el de la carga: una venta de julio que se
 * instaló en agosto cuenta en agosto, igual que en el motor.
 */
DROP VIEW IF EXISTS v_comision_embudo;
CREATE VIEW v_comision_embudo AS
SELECT
    u.id AS vendedor_id,
    per.periodo,

    (SELECT COUNT(*) FROM prospectos p
      WHERE p.vendedor_id = u.id
        AND DATE_TRUNC('month', p.creado_en)::DATE = per.periodo) AS solicitudes,

    (SELECT COUNT(*) FROM prospectos p
      WHERE p.vendedor_id = u.id
        AND p.estado = 'ganado'
        AND DATE_TRUNC('month', p.actualizado_en)::DATE = per.periodo) AS ganadas,

    COUNT(cv.id)                                                   AS registradas,
    COUNT(cv.aprobado_en)                                          AS aprobadas,
    COUNT(cv.instalado_en)                                         AS instaladas,
    COUNT(cv.activado_en)                                          AS activadas,
    COUNT(cv.primer_pago_en)                                       AS con_primer_pago,
    COUNT(cv.comisionable_en)                                      AS comisionables,
    COUNT(*) FILTER (WHERE cv.estado = 'pendiente_validacion')     AS en_cortesia
FROM usuarios_sistema u
/**
 * Los meses que tienen algo que contar, más el actual.
 *
 * El mes actual va SIEMPRE, aunque no haya ni una venta registrada. Es
 * justamente el caso que el punto 6 quiere hacer visible: alguien que cargó
 * treinta solicitudes y todavía no tiene ninguna comisionable tiene que ver
 * "30 → 0", no una pantalla vacía que parece un error del sistema.
 */
CROSS JOIN LATERAL (
    SELECT DISTINCT x.periodo
      FROM comision_ventas x
     WHERE x.vendedor_id = u.id AND x.periodo IS NOT NULL
    UNION
    SELECT DATE_TRUNC('month', CURRENT_DATE)::DATE
) per
LEFT JOIN comision_ventas cv ON cv.vendedor_id = u.id
                            AND cv.periodo = per.periodo
                            AND cv.estado <> 'anulada'
-- Sin `security_invoker`: la vista tiene que poder contar `prospectos` y
-- `comision_ventas` para armar el embudo, y el filtro de quién ve a quién está
-- acá abajo. Es el mismo criterio que la bandeja de cobranza.
WHERE ve_comisiones_de_todos() OR u.id = mi_legajo_id()
GROUP BY u.id, per.periodo;

GRANT SELECT ON v_comision_embudo TO authenticated;

COMMENT ON VIEW v_comision_embudo IS
    'Solicitudes ingresadas frente a ventas comisionables, por vendedor y período. El punto 6: 30 solicitudes no son 30 ventas.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- La comisión del tablero, que ahora tiene que dar lo mismo que el motor:
--   SELECT vendedor, altas_mes, comision_ventas, comision_nivel,
--          comision_nivel_pct, comision_mes, comision_pendientes
--     FROM v_comercial_vendedor ORDER BY comision_mes DESC;
--
--   SELECT vendedor, periodo, ventas_validas, nivel, porcentaje, monto
--     FROM v_comision_resumen ORDER BY periodo DESC;
--
--   -- Y el embudo:
--   SELECT periodo, solicitudes, ganadas, registradas, instaladas,
--          con_primer_pago, comisionables, en_cortesia
--     FROM v_comision_embudo ORDER BY periodo DESC;
