-- =============================================================================
-- Migración 222 — El plazo por cuadrilla
-- =============================================================================
-- `v_plazos_tecnico` (219) mide por técnico, y un trabajo asignado a una
-- cuadrilla entera —sin técnico individual— no contaba para nadie.
--
-- Decisión: esos trabajos se miden en la CUADRILLA, con su propia fila en
-- Desempeño del equipo. No se reparten entre los integrantes:
--
--   · Van juntos en el carro y llegan juntos: la llegada es del grupo. El que
--     responde es el jefe de grupo (208).
--   · Cargarlo a cada integrante contaría tres veces el mismo atraso.
--   · Cargarlo a quien marcó la llegada deja sin dueño justo al que nunca se
--     atendió, y premia a los que no llevan el celular.
--   · Y si alguien cambia de cuadrilla, su historia personal no se mueve.
--
-- Los trabajos con técnico asignado siguen contando en ese técnico, aunque
-- también tengan cuadrilla: nada se cuenta dos veces.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

CREATE OR REPLACE VIEW v_plazos_cuadrilla WITH (security_invoker = true) AS
WITH base AS (
    SELECT
        p.*,
        DATE_TRUNC('month', COALESCE(p.llegada_at, p.vence_at) AT TIME ZONE zona_horaria())::DATE AS mes
    FROM v_plazos_trabajo p
    WHERE p.tecnico_id IS NULL
      AND p.cuadrilla_id IS NOT NULL
      AND (p.en_plazo IS NOT NULL OR p.minutos_espera IS NOT NULL)
),
motivos AS (
    SELECT cuadrilla_id, mes, jsonb_object_agg(demora_motivo, n) AS motivos
      FROM (SELECT cuadrilla_id, mes, demora_motivo, COUNT(*) AS n
              FROM base
             WHERE en_plazo = FALSE AND demora_motivo IS NOT NULL
             GROUP BY 1, 2, 3) m
     GROUP BY 1, 2
)
SELECT
    b.cuadrilla_id,
    b.mes,
    MAX(b.cuadrilla)                                 AS cuadrilla,
    MAX(b.cuadrilla_integrantes)                     AS integrantes,
    (SELECT t.nombre
       FROM cuadrilla_miembros cm
       JOIN tecnicos t ON t.id = cm.tecnico_id
      WHERE cm.cuadrilla_id = b.cuadrilla_id AND cm.rol = 'lider'
      LIMIT 1)                                       AS lider,
    COUNT(*) FILTER (WHERE b.llegada_at IS NOT NULL) AS atendidos,
    COUNT(*) FILTER (WHERE b.en_plazo IS NOT NULL)   AS con_plazo,
    COUNT(*) FILTER (WHERE b.en_plazo)               AS en_plazo,
    CASE WHEN COUNT(*) FILTER (WHERE b.en_plazo IS NOT NULL) > 0
         THEN ROUND(100.0 * COUNT(*) FILTER (WHERE b.en_plazo)
                    / COUNT(*) FILTER (WHERE b.en_plazo IS NOT NULL)) END AS pct_en_plazo,
    COUNT(*) FILTER (WHERE b.minutos_espera IS NOT NULL) AS con_espera,
    (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.minutos_espera)
        FILTER (WHERE b.minutos_espera IS NOT NULL))::INT AS espera_mediana_min,
    COUNT(*) FILTER (WHERE b.en_plazo = FALSE)                                       AS fuera_plazo,
    COUNT(*) FILTER (WHERE b.en_plazo = FALSE AND b.llegada_at IS NULL)              AS esperando,
    COUNT(*) FILTER (WHERE b.en_plazo = FALSE AND b.llegada_at IS NOT NULL
                       AND b.demora_motivo IS NULL)                                  AS sin_justificar,
    COALESCE(MAX(m.motivos::TEXT)::JSONB, '{}'::JSONB)                               AS motivos
FROM base b
LEFT JOIN motivos m ON m.cuadrilla_id = b.cuadrilla_id AND m.mes = b.mes
GROUP BY b.cuadrilla_id, b.mes;

COMMENT ON VIEW v_plazos_cuadrilla IS
    'Espera del abonado y cumplimiento del plazo de los trabajos asignados a una cuadrilla sin técnico individual, por cuadrilla y mes.';

GRANT SELECT ON v_plazos_cuadrilla TO authenticated;
