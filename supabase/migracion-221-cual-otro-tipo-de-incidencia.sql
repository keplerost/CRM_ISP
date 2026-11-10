-- =============================================================================
-- Migración 221 — Cuál es el "otro" tipo de incidencia
-- =============================================================================
-- Elegir "Otro" como tipo de incidencia no decía nada: el técnico abría el
-- ticket y tenía que deducir de lo que contó el abonado qué clase de trabajo
-- era. Ahora, con "Otro", quien registra escribe cuál —"cambio de router",
-- "reubicar la ONT"—, aparte de lo que reporta el abonado.
--
-- `v_tickets` se rehace porque es `SELECT t.*` (migración 28) y congeló sus
-- columnas: sin rehacerla la columna nueva no llega a las pantallas. De paso
-- trae las de la 219 (motivo de la demora), que tampoco llegaban.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS incidencia_otro TEXT;

COMMENT ON COLUMN tickets.incidencia_otro IS
    'Con tipo_incidencia = ''otro'': cuál es, en palabras de quien registra. Aparte de la descripción del abonado.';


DROP VIEW IF EXISTS v_tickets;

CREATE VIEW v_tickets WITH (security_invoker = true) AS
SELECT
    t.*,
    LPAD(t.numero::TEXT, 6, '0')          AS codigo,
    nap.nombre                            AS nap,
    torre.nombre                          AS torre,
    tec.nombre                            AS tecnico,
    tec.telefono                          AS tecnico_telefono,
    cua.nombre                            AS cuadrilla,
    c.nombre                              AS cliente,
    c.plan_id,
    c.estado                              AS estado_cliente,
    EXTRACT(EPOCH FROM (COALESCE(t.cerrado_at, NOW()) - t.created_at)) / 3600 AS horas_abierto,
    (t.estado NOT IN ('resuelto', 'cancelado')
     AND t.fecha_visita IS NOT NULL
     AND t.fecha_visita < CURRENT_DATE)   AS visita_atrasada,
    (SELECT COUNT(*) FROM ticket_adjuntos a WHERE a.ticket_id = t.id) AS adjuntos,
    EXTRACT(EPOCH FROM (t.llegada_at - t.salida_at)) / 60 AS minutos_en_ruta,
    EXTRACT(EPOCH FROM (COALESCE(t.cerrado_at, NOW()) - t.llegada_at)) / 60 AS minutos_en_sitio,
    CASE
        WHEN t.llegada_lat IS NOT NULL AND t.latitud IS NOT NULL THEN
            ROUND((6371000 * 2 * ASIN(SQRT(
                POWER(SIN(RADIANS(t.llegada_lat - t.latitud) / 2), 2) +
                COS(RADIANS(t.latitud)) * COS(RADIANS(t.llegada_lat)) *
                POWER(SIN(RADIANS(t.llegada_lng - t.longitud) / 2), 2)
            )))::NUMERIC, 0)
    END AS llegada_distancia_m
FROM tickets t
LEFT JOIN puntos_red nap   ON nap.id   = t.nap_id
LEFT JOIN puntos_red torre ON torre.id = t.torre_id
LEFT JOIN tecnicos tec     ON tec.id   = t.tecnico_id
LEFT JOIN cuadrillas cua   ON cua.id   = t.cuadrilla_id
LEFT JOIN clientes c       ON c.id     = t.client_id;

GRANT SELECT ON v_tickets TO authenticated;
