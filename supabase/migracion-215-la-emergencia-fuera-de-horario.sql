-- =============================================================================
-- Migración 215 — La emergencia es fuera de horario
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 210 (salida de emergencia).
--
-- ── Qué resuelve ──
--
-- Un jefe de grupo abrió una salida de emergencia a las 7 de la mañana en vez
-- de seguir el día normal. Con la emergencia abierta el sistema lo daba por
-- "en servicio": no se le pidió la foto grupal, nadie de la cuadrilla quedó con
-- ingreso, y sus horas del día figuraban como horas de emergencia.
--
-- Ahora, dentro del HORARIO LABORAL (07:00 a 18:00 de fábrica) la salida de
-- emergencia solo se puede abrir si el técnico ya cerró su jornada de ese día.
-- Fuera de ese horario —de noche, de madrugada— se puede siempre.
--
-- El horario se guarda en `config_tareas` (`horario_desde`, `horario_hasta`),
-- en la hora del ISP (`zona_horaria()`). Para cambiarlo:
--
--   UPDATE config_tareas SET horario_desde = '06:30', horario_hasta = '19:00' WHERE id = 1;
-- =============================================================================

ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS horario_desde TIME NOT NULL DEFAULT '07:00',
    ADD COLUMN IF NOT EXISTS horario_hasta TIME NOT NULL DEFAULT '18:00';

COMMENT ON COLUMN config_tareas.horario_desde IS
    'Inicio del horario laboral. Dentro de él, la salida de emergencia exige haber cerrado la jornada.';


/**
 * ¿Quien pregunta puede abrir una salida de emergencia ahora? NULL si puede;
 * si no, el motivo, en el texto que ve el técnico.
 */
CREATE OR REPLACE FUNCTION motivo_sin_emergencia()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tec   UUID := mi_tecnico_id();
    v_hora  TIME := (NOW() AT TIME ZONE zona_horaria())::time;
    v_fecha DATE := (NOW() AT TIME ZONE zona_horaria())::date;
    v_desde TIME;
    v_hasta TIME;
BEGIN
    SELECT horario_desde, horario_hasta INTO v_desde, v_hasta FROM config_tareas WHERE id = 1;
    v_desde := COALESCE(v_desde, '07:00');
    v_hasta := COALESCE(v_hasta, '18:00');

    -- Fuera del horario laboral, siempre.
    IF v_hora < v_desde OR v_hora >= v_hasta THEN
        RETURN NULL;
    END IF;

    -- Dentro, solo con la jornada de hoy ya cerrada.
    IF EXISTS (SELECT 1 FROM jornadas
                WHERE tecnico_id = v_tec AND fecha = v_fecha AND fin_at IS NOT NULL) THEN
        RETURN NULL;
    END IF;

    RETURN format(
        'En horario laboral (%s a %s) no se usa la salida de emergencia: tu ingreso se marca al llegar a tu primer cliente. '
        || 'La emergencia es para después de cerrar tu jornada o fuera de ese horario.',
        TO_CHAR(v_desde, 'HH24:MI'), TO_CHAR(v_hasta, 'HH24:MI'));
END;
$$;

GRANT EXECUTE ON FUNCTION motivo_sin_emergencia() TO authenticated;


-- La 210, con el control. El resto queda igual.
CREATE OR REPLACE FUNCTION abrir_emergencia(
    p_motivo      TEXT,
    p_reparacion  UUID DEFAULT NULL,
    p_lat         NUMERIC DEFAULT NULL,
    p_lng         NUMERIC DEFAULT NULL,
    p_vehiculo    UUID DEFAULT NULL,
    p_km_inicio   INT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tec    UUID := mi_tecnico_id();
    v_motivo TEXT := NULLIF(BTRIM(p_motivo), '');
    v_no     TEXT;
    v_id     UUID;
    u        RECORD;
BEGIN
    IF v_tec IS NULL THEN
        RAISE EXCEPTION 'Tu usuario no está vinculado a un técnico.';
    END IF;
    IF en_servicio(v_tec, NOW()) THEN
        RAISE EXCEPTION 'Ya estás en servicio: tu jornada está abierta. La emergencia es un trabajo más del día.';
    END IF;

    v_no := motivo_sin_emergencia();
    IF v_no IS NOT NULL THEN
        RAISE EXCEPTION '%', v_no USING ERRCODE = '42501';
    END IF;

    IF p_reparacion IS NOT NULL AND NOT ve_reparacion(p_reparacion) THEN
        RAISE EXCEPTION 'Esa reparación no está asignada a tu cuadrilla.' USING ERRCODE = '42501';
    END IF;

    IF v_motivo IS NULL AND p_reparacion IS NOT NULL THEN
        SELECT 'Reparación #' || numero || ': ' || titulo INTO v_motivo
          FROM reparaciones_red WHERE id = p_reparacion;
    END IF;
    IF v_motivo IS NULL THEN
        RAISE EXCEPTION 'Contá por qué salís: qué se cayó o quién te llamó.';
    END IF;

    INSERT INTO salidas_emergencia (tecnico_id, reparacion_id, motivo, lat_ingreso, lng_ingreso,
                                    vehiculo_id, km_inicio)
    VALUES (v_tec, p_reparacion, v_motivo, p_lat, p_lng, p_vehiculo, p_km_inicio)
    RETURNING id INTO v_id;

    FOR u IN
        SELECT id FROM usuarios_sistema
         WHERE activo AND rol IN ('super_admin', 'admin', 'jefe_tecnico')
    LOOP
        PERFORM notificar(
            u.id, 'emergencia_salida',
            (SELECT nombre FROM tecnicos WHERE id = v_tec) || ' salió por una emergencia',
            LEFT(v_motivo, 200),
            '/soporte/jornadas', 'emergencia', v_id::text);
    END LOOP;

    RETURN v_id;
END;
$$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT horario_desde, horario_hasta FROM config_tareas WHERE id = 1;
