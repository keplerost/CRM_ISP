-- =============================================================================
-- Migración 92 — Desempeño del técnico
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué se puede medir, y con qué ──
--
-- Todo lo que se pidió sale de datos que ya existen. No hace falta que el
-- técnico cargue nada nuevo: son subproductos de trabajar.
--
--   productividad   cuántos trabajos cerró
--   tiempos         `llegada_at` → `alta_at` / `cerrado_at`
--   puntualidad     la `hora` agendada contra `llegada_at`
--   calidad         el semáforo de la señal y la velocidad entregada
--   reincidencia    tickets del mismo cliente poco después
--   materiales      `movimientos_inventario` por orden
--   kilómetros      las jornadas de la migración 91
--
-- ── UNA ADVERTENCIA QUE VA EN EL CÓDIGO ──
--
-- Estos números NO son directamente comparables entre técnicos.
--
-- El que atiende la zona rural maneja el triple, tarda más por trabajo, gasta
-- más drop y llega tarde más seguido — y puede ser el mejor de los dos. Un
-- ranking crudo lo castiga por su ruta.
--
-- Por eso cada fila trae su contexto: kilómetros, cuántos trabajos fueron en
-- zona propia, y la dispersión. Quien mire la comparación tiene que ver ESO al
-- lado del número, y las pantallas que se construyan sobre estas vistas están
-- obligadas a mostrarlo.
--
-- Un indicador de productividad sin su denominador es cómo se termina
-- premiando al que agarra los trabajos fáciles.
-- =============================================================================


-- =============================================================================
-- 1. Los parámetros que faltaban
-- =============================================================================
-- Cuántos minutos de atraso se toleran, y en cuántos días una visita nueva del
-- mismo cliente cuenta como reincidencia. Van a `parametros_tecnicos` por lo
-- mismo que los umbrales del semáforo: son decisiones de la empresa, no
-- constantes del código, y cambian sin tocar una línea.
ALTER TABLE parametros_tecnicos
    ADD COLUMN IF NOT EXISTS tolerancia_puntualidad_min SMALLINT NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS dias_reincidencia          SMALLINT NOT NULL DEFAULT 30;

COMMENT ON COLUMN parametros_tecnicos.dias_reincidencia IS
    'En cuántos días una visita nueva al mismo cliente se cuenta como reincidencia. 30 por defecto: más corto deja afuera fallas que tardan en aparecer; más largo mete problemas nuevos que no tienen que ver.';


-- =============================================================================
-- 2. Trabajo por trabajo
-- =============================================================================
-- La base de todo lo demás. Una fila por trabajo cerrado, con sus tiempos y su
-- resultado, sin importar si fue instalación o ticket: para medir a una persona
-- las dos son "una salida a un domicilio".
/**
 * Va con `CREATE OR REPLACE` y no con `DROP` + `CREATE`.
 *
 * De esta vista cuelgan otras que se crean DESPUÉS —v_reincidencias y v_desempeno_tecnico, en este mismo archivo—, así que un `DROP`
 * hace que volver a correr este archivo falle con "cannot drop view because
 * other objects depend on it". Y como el editor de Supabase corre el archivo
 * entero en una transacción, se cae la migración completa.
 *
 * `CREATE OR REPLACE` reemplaza la definición sin tocar a quien depende de ella.
 * Exige que las columnas sean las mismas, que es exactamente el caso cuando lo
 * que se reejecuta es este mismo archivo.
 */
CREATE OR REPLACE VIEW v_trabajos_tecnico WITH (security_invoker = true) AS
WITH p AS (SELECT * FROM parametros_tecnicos WHERE id = 1)

-- ── Instalaciones ──
SELECT
    'instalacion'::TEXT AS clase,
    i.id,
    i.numero,
    i.tecnico_id,
    i.client_id,
    i.fecha,
    i.hora,
    i.llegada_at,
    i.alta_at         AS cierre_at,
    i.estado,

    -- Cuánto tardó adentro. Nulo si no marcó llegada: no se inventa.
    CASE WHEN i.llegada_at IS NOT NULL AND i.alta_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (i.alta_at - i.llegada_at)) / 60)::INT END AS minutos_trabajo,

    -- Puntualidad: solo se puede juzgar si había hora acordada Y marcó llegada.
    -- Sin las dos, la fila queda en nulo y NO cuenta como puntual ni como tarde.
    -- Contarla como puntual inflaría el indicador de quien nunca marca llegada.
    CASE WHEN i.hora IS NOT NULL AND i.llegada_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (i.llegada_at - (i.fecha + i.hora))) / 60)::INT END AS minutos_atraso,

    -- Calidad: cómo quedó la señal y cuánto entregó del plan.
    vi.semaforo,
    i.test_bajada_mbps,
    pl.bajada_mbps AS plan_mbps,
    CASE WHEN pl.bajada_mbps > 0 AND i.test_bajada_mbps IS NOT NULL
         THEN ROUND(100.0 * i.test_bajada_mbps / pl.bajada_mbps) END AS pct_del_plan,

    i.motivo_no_realizada
FROM instalaciones i
LEFT JOIN v_instalaciones vi ON vi.id = i.id
LEFT JOIN v_planes pl        ON pl.id = i.plan_id
WHERE i.tecnico_id IS NOT NULL

UNION ALL

-- ── Tickets ──
SELECT
    'ticket'::TEXT,
    t.id,
    t.numero,
    t.tecnico_id,
    t.client_id,
    COALESCE(t.fecha_visita, t.created_at::DATE),
    t.hora_visita,
    t.llegada_at,
    t.cerrado_at,
    t.estado,
    CASE WHEN t.llegada_at IS NOT NULL AND t.cerrado_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (t.cerrado_at - t.llegada_at)) / 60)::INT END,
    CASE WHEN t.hora_visita IS NOT NULL AND t.llegada_at IS NOT NULL AND t.fecha_visita IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (t.llegada_at - (t.fecha_visita + t.hora_visita))) / 60)::INT END,
    NULL, NULL, NULL, NULL,
    NULL
FROM tickets t
WHERE t.tecnico_id IS NOT NULL;

GRANT SELECT ON v_trabajos_tecnico TO authenticated;


-- =============================================================================
-- 3. Reincidencias
-- =============================================================================
-- ── Qué mide, y qué NO ──
--
-- Mide que el cliente VOLVIÓ A LLAMAR poco después de un trabajo cerrado. Eso
-- es un hecho.
--
-- Lo que NO mide es de quién es la culpa. El cliente puede llamar porque se le
-- cortó la fibra en la vereda, porque le cambió el router, o porque el trabajo
-- quedó mal. Llamar a esto "trabajos mal hechos" sería sacar una conclusión que
-- el dato no soporta, y usarla para evaluar a alguien.
--
-- Por eso la columna se llama `volvio_a_llamar` y no `falla`.
/**
 * Va con `CREATE OR REPLACE` y no con `DROP` + `CREATE`.
 *
 * De esta vista cuelgan otras que se crean DESPUÉS —v_desempeno_tecnico, en este mismo archivo—, así que un `DROP`
 * hace que volver a correr este archivo falle con "cannot drop view because
 * other objects depend on it". Y como el editor de Supabase corre el archivo
 * entero en una transacción, se cae la migración completa.
 *
 * `CREATE OR REPLACE` reemplaza la definición sin tocar a quien depende de ella.
 * Exige que las columnas sean las mismas, y lo son: este archivo es el ÚLTIMO
 * que define la vista, así que reejecutarlo reproduce exactamente lo que ya está.
 */
CREATE OR REPLACE VIEW v_reincidencias WITH (security_invoker = true) AS
SELECT
    tr.clase,
    tr.id            AS trabajo_id,
    tr.numero,
    tr.tecnico_id,
    tr.client_id,
    tr.cierre_at,
    t2.id            AS ticket_posterior,
    t2.numero        AS numero_posterior,
    t2.created_at    AS reclamo_en,
    t2.tipo_incidencia,
    (EXTRACT(EPOCH FROM (t2.created_at - tr.cierre_at)) / 86400)::INT AS dias_despues
FROM v_trabajos_tecnico tr
JOIN tickets t2
      ON t2.client_id = tr.client_id
     AND t2.created_at > tr.cierre_at
     AND t2.created_at < tr.cierre_at
         + ((SELECT dias_reincidencia FROM parametros_tecnicos WHERE id = 1) || ' days')::INTERVAL
     -- El ticket que originó el propio trabajo no cuenta como reincidencia.
     AND t2.id <> tr.id
WHERE tr.cierre_at IS NOT NULL
  AND tr.client_id IS NOT NULL;

GRANT SELECT ON v_reincidencias TO authenticated;


-- =============================================================================
-- 4. El resumen por técnico y por mes
-- =============================================================================
DROP VIEW IF EXISTS v_desempeno_tecnico;
CREATE VIEW v_desempeno_tecnico WITH (security_invoker = true) AS
WITH p AS (SELECT * FROM parametros_tecnicos WHERE id = 1),

trabajos AS (
    SELECT
        tr.tecnico_id,
        DATE_TRUNC('month', COALESCE(tr.cierre_at, tr.fecha::TIMESTAMPTZ))::DATE AS mes,

        COUNT(*) FILTER (WHERE tr.clase = 'instalacion' AND tr.estado = 'hecha')      AS instalaciones,
        COUNT(*) FILTER (WHERE tr.clase = 'ticket'      AND tr.estado = 'resuelto')   AS tickets,
        COUNT(*) FILTER (WHERE tr.estado IN ('no_realizada', 'reprogramada'))         AS visitas_fallidas,

        -- Tiempos. La MEDIANA y no el promedio: un solo trabajo de ocho horas
        -- —un poste caído, una obra— mueve el promedio de todo el mes y hace
        -- parecer lento a quien no lo es.
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tr.minutos_trabajo)
            FILTER (WHERE tr.minutos_trabajo IS NOT NULL)                             AS minutos_mediana,

        COUNT(*) FILTER (WHERE tr.minutos_atraso IS NOT NULL)                         AS con_hora_y_llegada,
        COUNT(*) FILTER (WHERE tr.minutos_atraso IS NOT NULL
                           AND tr.minutos_atraso <= (SELECT tolerancia_puntualidad_min FROM p)) AS a_tiempo,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tr.minutos_atraso)
            FILTER (WHERE tr.minutos_atraso IS NOT NULL)                              AS atraso_mediana,

        -- Calidad, solo sobre instalaciones: un ticket no deja señal medida.
        COUNT(*) FILTER (WHERE tr.semaforo IS NOT NULL)                                AS con_medicion,
        COUNT(*) FILTER (WHERE tr.semaforo = 'verde')                                  AS en_verde,
        COUNT(*) FILTER (WHERE tr.pct_del_plan IS NOT NULL)                            AS con_velocidad,
        COUNT(*) FILTER (WHERE tr.pct_del_plan >= (SELECT velocidad_minima_pct FROM p)) AS velocidad_ok
    FROM v_trabajos_tecnico tr
    GROUP BY 1, 2
),

reinc AS (
    SELECT tecnico_id, DATE_TRUNC('month', cierre_at)::DATE AS mes,
           COUNT(DISTINCT trabajo_id) AS trabajos_con_reclamo
      FROM v_reincidencias GROUP BY 1, 2
),

-- Material: los metros de cable por instalación son lo que de verdad se
-- compara. Los conectores y las grapas se usan de a uno y no dicen nada.
material AS (
    SELECT i.tecnico_id, DATE_TRUNC('month', i.alta_at)::DATE AS mes,
           SUM(m.cantidad) FILTER (WHERE a.unidad = 'm') AS metros_cable,
           COUNT(DISTINCT m.instalacion_id)              AS ordenes_con_material
      FROM movimientos_inventario m
      JOIN articulos a     ON a.id = m.articulo_id
      JOIN instalaciones i ON i.id = m.instalacion_id
     WHERE m.tipo = 'consumo' AND i.tecnico_id IS NOT NULL AND i.alta_at IS NOT NULL
     GROUP BY 1, 2
),

km AS (
    SELECT tecnico_id, DATE_TRUNC('month', fecha)::DATE AS mes,
           SUM(km_fin - km_inicio) AS km_mes,
           COUNT(*) FILTER (WHERE km_fin IS NOT NULL) AS dias_con_km
      FROM jornadas WHERE km_fin IS NOT NULL AND km_inicio IS NOT NULL
     GROUP BY 1, 2
)

SELECT
    t.tecnico_id,
    tc.nombre AS tecnico,
    t.mes,

    t.instalaciones,
    t.tickets,
    (t.instalaciones + t.tickets) AS trabajos,
    t.visitas_fallidas,

    t.minutos_mediana::INT,
    t.atraso_mediana::INT,
    -- Los porcentajes se dan CON su denominador al lado. Un "100% puntual" sobre
    -- dos trabajos medidos no es lo mismo que sobre cuarenta, y sin el
    -- denominador los dos se ven igual.
    t.con_hora_y_llegada,
    CASE WHEN t.con_hora_y_llegada > 0
         THEN ROUND(100.0 * t.a_tiempo / t.con_hora_y_llegada) END AS pct_puntual,

    t.con_medicion,
    CASE WHEN t.con_medicion > 0
         THEN ROUND(100.0 * t.en_verde / t.con_medicion) END AS pct_senal_optima,
    t.con_velocidad,
    CASE WHEN t.con_velocidad > 0
         THEN ROUND(100.0 * t.velocidad_ok / t.con_velocidad) END AS pct_velocidad_ok,

    COALESCE(r.trabajos_con_reclamo, 0) AS trabajos_con_reclamo,
    CASE WHEN (t.instalaciones + t.tickets) > 0
         THEN ROUND(100.0 * COALESCE(r.trabajos_con_reclamo, 0) / (t.instalaciones + t.tickets))
    END AS pct_reincidencia,

    m.metros_cable,
    CASE WHEN t.instalaciones > 0 AND m.metros_cable IS NOT NULL
         THEN ROUND(m.metros_cable / t.instalaciones) END AS metros_por_instalacion,

    -- El contexto, sin el cual la comparación entre técnicos no significa nada.
    k.km_mes,
    k.dias_con_km,
    CASE WHEN (t.instalaciones + t.tickets) > 0 AND k.km_mes IS NOT NULL
         THEN ROUND(k.km_mes::NUMERIC / (t.instalaciones + t.tickets)) END AS km_por_trabajo
FROM trabajos t
LEFT JOIN tecnicos tc ON tc.id = t.tecnico_id
LEFT JOIN reinc r     ON r.tecnico_id = t.tecnico_id AND r.mes = t.mes
LEFT JOIN material m  ON m.tecnico_id = t.tecnico_id AND m.mes = t.mes
LEFT JOIN km k        ON k.tecnico_id = t.tecnico_id AND k.mes = t.mes;

COMMENT ON VIEW v_desempeno_tecnico IS
    'Desempeño por técnico y mes. Los porcentajes vienen con su denominador al lado a propósito: 100% de puntualidad sobre dos trabajos medidos no es lo mismo que sobre cuarenta. Y `km_por_trabajo` está para que la comparación entre técnicos no castigue al de la zona rural.';

GRANT SELECT ON v_desempeno_tecnico TO authenticated;


-- =============================================================================
-- 5. Seguridad
-- =============================================================================
-- Las vistas llevan `security_invoker`, así que heredan las políticas de las
-- tablas: el técnico ve sus propios trabajos y nada más, porque
-- `instalaciones_lectura` y `tickets_acceso` ya lo filtran.
--
-- Es lo que hace que la MISMA vista sirva para las dos pantallas: la de "Mi
-- desempeño" del técnico y la comparación del administrador. No hay dos
-- verdades ni dos cálculos que se puedan separar con el tiempo — hay uno, y
-- cada quien ve lo que le toca.
--
-- Se comprueba entrando como técnico:
--
--   SELECT tecnico, trabajos FROM v_desempeno_tecnico;
--   -- tiene que devolver solo sus propias filas
