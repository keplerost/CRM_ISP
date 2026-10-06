-- =============================================================================
-- Migración 211 — Cada cuadrilla con su vehículo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 208 (jefe de grupo).
--
-- ── Qué resuelve ──
--
-- El jefe de grupo elegía cada mañana el vehículo con el que salía, aunque la
-- cuadrilla siempre sale con el mismo. El vehículo de la cuadrilla era un
-- texto libre ("Hilux blanca") sin enlace a Vehículos, así que la jornada no
-- podía ponerlo sola.
--
-- Ahora la cuadrilla apunta al vehículo (`cuadrillas.vehiculo_id`) y la
-- jornada lo trae puesto. Se puede cambiar ese día —préstamo, taller—, pero ya
-- no hay que elegirlo.
--
-- Los textos que ya estaban se enlazan solos si coinciden con el nombre o la
-- placa de un vehículo cargado. Los que no coinciden quedan como texto: hay que
-- elegirlos una vez en Soporte → Técnicos y cuadrillas.
-- =============================================================================

ALTER TABLE cuadrillas
    ADD COLUMN IF NOT EXISTS vehiculo_id UUID REFERENCES vehiculos(id) ON DELETE SET NULL;

COMMENT ON COLUMN cuadrillas.vehiculo_id IS
    'El vehículo con el que sale la cuadrilla. La jornada del jefe de grupo lo trae puesto.';

-- Enlazar lo que ya estaba escrito, si coincide sin ambigüedad.
UPDATE cuadrillas c
   SET vehiculo_id = (
        SELECT v.id FROM vehiculos v
         WHERE v.activo
           AND (LOWER(BTRIM(v.nombre)) = LOWER(BTRIM(c.vehiculo))
             OR UPPER(REPLACE(REPLACE(v.placa, '-', ''), ' ', ''))
              = UPPER(REPLACE(REPLACE(BTRIM(c.vehiculo), '-', ''), ' ', '')))
         ORDER BY v.creado_en
         LIMIT 1)
 WHERE c.vehiculo_id IS NULL
   AND NULLIF(BTRIM(c.vehiculo), '') IS NOT NULL;


-- =============================================================================
-- La cuadrilla de hoy, con su vehículo
-- =============================================================================
CREATE OR REPLACE FUNCTION mi_cuadrilla_hoy(p_fecha DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH c AS (
        SELECT m.cuadrilla_id, cu.nombre, cu.vehiculo_id, jefe_de_grupo(m.cuadrilla_id, p_fecha) AS jefe
          FROM cuadrilla_miembros m
          JOIN cuadrillas cu ON cu.id = m.cuadrilla_id
         WHERE m.tecnico_id = mi_tecnico_id()
         -- Si integra más de una, la que dirige hoy va primero.
         ORDER BY (jefe_de_grupo(m.cuadrilla_id, p_fecha) = mi_tecnico_id()) DESC NULLS LAST, cu.nombre
         LIMIT 1
    )
    SELECT jsonb_build_object(
        'cuadrilla_id', c.cuadrilla_id,
        'cuadrilla', c.nombre,
        -- El vehículo de la cuadrilla (migración 211): la jornada lo pone sola.
        'vehiculo_id', c.vehiculo_id,
        'vehiculo', (SELECT nombre FROM vehiculos WHERE id = c.vehiculo_id),
        'placa', (SELECT placa FROM vehiculos WHERE id = c.vehiculo_id),
        'jefe_id', c.jefe,
        'jefe', (SELECT nombre FROM tecnicos WHERE id = c.jefe),
        'soy_jefe', COALESCE(c.jefe = mi_tecnico_id(), false),
        'sin_jefe', c.jefe IS NULL,
        'es_reemplazo', EXISTS (SELECT 1 FROM cuadrilla_reemplazos r
                                 WHERE r.cuadrilla_id = c.cuadrilla_id AND r.fecha = p_fecha),
        'integrantes', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'nombre', t.nombre,
                       'es_jefe', t.id = c.jefe,
                       'ingreso_at', j.inicio_at,
                       'con_foto', j.foto_ingreso IS NOT NULL
                   ) ORDER BY (t.id = c.jefe) DESC, t.nombre), '[]'::jsonb)
              FROM cuadrilla_miembros m
              JOIN tecnicos t ON t.id = m.tecnico_id
              LEFT JOIN jornadas j ON j.tecnico_id = t.id AND j.fecha = p_fecha
             WHERE m.cuadrilla_id = c.cuadrilla_id
        )
    )
      FROM c
$$;

GRANT EXECUTE ON FUNCTION mi_cuadrilla_hoy(DATE) TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT c.nombre, c.vehiculo AS texto_viejo, v.nombre AS vehiculo, v.placa
--     FROM cuadrillas c LEFT JOIN vehiculos v ON v.id = c.vehiculo_id;
