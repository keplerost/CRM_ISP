-- =============================================================================
-- Migración 212 — El ingreso se marca en el primer cliente
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 210 (en servicio y salida de emergencia).
--
-- ── Qué cambia respecto de la 210 ──
--
-- Las cuadrillas salen de la base, pero las horas se cuentan desde el primer
-- cliente. La 210 exigía marcar el ingreso (con foto) ANTES de salir: la foto
-- probaba que llegó a la base, y la hora contaba desde ahí.
--
-- Ahora son dos cosas separadas:
--
--   1. LA SALIDA DEL VEHÍCULO, en la base. Solo el jefe de grupo: vehículo y
--      km. Sin foto y sin ingreso: es un dato del vehículo, no de asistencia.
--      Queda en la jornada con `inicio_at` vacío.
--
--   2. EL INGRESO, en el primer trabajo. Al llegar al primer ticket o a la
--      primera instalación del día —o al primer reporte de una reparación—, el
--      ingreso se marca SOLO, con la hora y la ubicación de esa llegada. La
--      foto la pide la app en ese momento.
--
-- "Salir hacia el domicilio" ya no pide nada: manejar no es empezar a trabajar.
--
-- ── Lo que no cambia ──
--
--   · Con la jornada CERRADA no se inicia nada: para eso está la salida de
--     emergencia.
--   · Se juzga con la hora de la marca. Una llegada marcada sin señal a las
--     9:00 que sincroniza a las 11:00 abre (o adelanta) el ingreso a las 9:00.
--   · Solo al rol `tecnico`.
-- =============================================================================


/**
 * El ingreso automático: lo llama cada trabajo que arranca.
 *
 * Si el técnico ya está en servicio en ese momento, no hace nada. Si no:
 *
 *   · sin jornada ese día → la crea, con el ingreso en la llegada;
 *   · con la salida del vehículo cargada pero sin ingreso → le pone el ingreso;
 *   · con un ingreso POSTERIOR (una llegada sin señal que sincronizó tarde) →
 *     lo adelanta a esta;
 *   · con la jornada ya cerrada antes de este momento → rechaza: es una
 *     emergencia.
 */
CREATE OR REPLACE FUNCTION ingreso_automatico(
    p_momento TIMESTAMPTZ,
    p_lat     NUMERIC DEFAULT NULL,
    p_lng     NUMERIC DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tec    UUID := mi_tecnico_id();
    v_mom    TIMESTAMPTZ := COALESCE(p_momento, NOW());
    v_fecha  DATE := (COALESCE(p_momento, NOW()) AT TIME ZONE zona_horaria())::date;
    j        jornadas%ROWTYPE;
BEGIN
    IF NOT es_tecnico_de_campo() OR en_servicio(v_tec, v_mom) THEN
        RETURN;
    END IF;

    SELECT * INTO j FROM jornadas WHERE tecnico_id = v_tec AND fecha = v_fecha FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO jornadas (tecnico_id, fecha, inicio_at, lat_ingreso, lng_ingreso, distancia_ingreso_m)
        VALUES (v_tec, v_fecha, v_mom, p_lat, p_lng, 0);
        RETURN;
    END IF;

    IF j.fin_at IS NOT NULL AND j.fin_at < v_mom THEN
        RAISE EXCEPTION 'Tu jornada de hoy ya está cerrada. Si es una emergencia, marcá una salida de emergencia en Mi jornada.'
            USING ERRCODE = '42501';
    END IF;

    -- Sin ingreso todavía (solo la salida del vehículo), o con uno posterior.
    UPDATE jornadas
       SET inicio_at   = v_mom,
           lat_ingreso = COALESCE(p_lat, lat_ingreso),
           lng_ingreso = COALESCE(p_lng, lng_ingreso),
           distancia_ingreso_m = 0
     WHERE id = j.id;
END;
$$;

REVOKE ALL ON FUNCTION ingreso_automatico(TIMESTAMPTZ, NUMERIC, NUMERIC) FROM PUBLIC, anon;


-- =============================================================================
-- Los disparadores de la 210, con el ingreso automático
-- =============================================================================
CREATE OR REPLACE FUNCTION controlar_inicio_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Solo la llegada. "En ruta" es manejar, y manejar no es empezar.
    IF NEW.estado = 'en_proceso' AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        PERFORM ingreso_automatico(NEW.llegada_at, NEW.llegada_lat, NEW.llegada_lng);
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION controlar_inicio_instalacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'en_curso' AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        PERFORM ingreso_automatico(NEW.llegada_at, NEW.llegada_lat, NEW.llegada_lng);
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION controlar_reporte_reparacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.tipo IN ('avance', 'reparada') THEN
        PERFORM ingreso_automatico(NEW.creado_at, NEW.lat, NEW.lng);
    END IF;
    RETURN NEW;
END;
$$;


-- =============================================================================
-- Lo que pregunta la app antes de iniciar un trabajo
-- =============================================================================
/**
 * 'en_servicio'     → puede trabajar, no hace falta nada.
 * 'falta_ingreso'   → este trabajo marca su ingreso: la app pide la foto.
 * 'jornada_cerrada' → ya cerró hoy: solo con salida de emergencia.
 */
CREATE OR REPLACE FUNCTION estado_de_ingreso()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN NOT es_tecnico_de_campo() OR en_servicio(mi_tecnico_id(), NOW()) THEN 'en_servicio'
        WHEN EXISTS (SELECT 1 FROM jornadas
                      WHERE tecnico_id = mi_tecnico_id()
                        AND fecha = (NOW() AT TIME ZONE zona_horaria())::date
                        AND fin_at IS NOT NULL) THEN 'jornada_cerrada'
        ELSE 'falta_ingreso'
    END
$$;

GRANT EXECUTE ON FUNCTION estado_de_ingreso() TO authenticated;

/** La jornada de hoy de quien pregunta, para subirle la foto de ingreso. */
CREATE OR REPLACE FUNCTION mi_jornada_de_hoy()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id FROM jornadas
     WHERE tecnico_id = mi_tecnico_id()
       AND fecha = (NOW() AT TIME ZONE zona_horaria())::date
$$;

GRANT EXECUTE ON FUNCTION mi_jornada_de_hoy() TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Quién marcó ingreso hoy, a qué hora y si fue en el primer trabajo:
--   SELECT t.nombre, j.km_inicio, j.inicio_at, j.distancia_ingreso_m
--     FROM jornadas j JOIN tecnicos t ON t.id = j.tecnico_id
--    WHERE j.fecha = (NOW() AT TIME ZONE zona_horaria())::date;
