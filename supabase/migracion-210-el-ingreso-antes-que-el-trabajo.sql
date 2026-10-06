-- =============================================================================
-- Migración 210 — El ingreso antes que el trabajo, y la salida de emergencia
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 209 (reparaciones de red).
--
-- ── Qué resuelve ──
--
-- 1. SE TRABAJABA SIN MARCAR INGRESO. El técnico podía salir hacia un ticket,
--    marcar la llegada a una instalación o reportar una reparación sin haber
--    abierto su jornada, y la asistencia del día quedaba sin foto ni hora.
--    Ahora la base lo rechaza: para INICIAR un trabajo (ticket en ruta o en
--    proceso, instalación en ruta o en curso, avance o cierre de una
--    reparación) el técnico tiene que estar EN SERVICIO.
--
-- 2. LA EMERGENCIA FUERA DE HORARIO. Con la jornada cerrada —o de madrugada,
--    antes de abrirla— se corta la fibra troncal. El técnico marca una SALIDA
--    DE EMERGENCIA: motivo (idealmente la reparación asignada), foto y
--    ubicación, igual que el ingreso. Mientras esté abierta puede trabajar; al
--    terminar la cierra. Queda separada de la jornada, para que la oficina vea
--    las horas fuera de horario y las pague o las compense.
--
-- ── Qué es "en servicio" ──
--
-- Tener, en el MOMENTO del trabajo, una jornada abierta (ingreso marcado y sin
-- salida) o una salida de emergencia abierta.
--
-- El momento es la hora que trae la marca —`salida_at`, `llegada_at`— y no la
-- hora en que llega a la base: lo que se marcó sin señal a las 10:00 y
-- sincroniza a las 19:00, con la jornada ya cerrada, era válido a las 10:00 y
-- no se pierde.
--
-- ── A quién se le aplica ──
--
-- Solo al rol `tecnico`. La oficina y el jefe técnico mueven estados desde el
-- escritorio sin jornada, y el middleware (sin sesión) tampoco se frena.
-- =============================================================================


-- =============================================================================
-- 1. La salida de emergencia
-- =============================================================================
CREATE TABLE IF NOT EXISTS salidas_emergencia (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tecnico_id    UUID NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
    -- Por qué salió. La reparación cuando la hay: es lo que permite cruzar las
    -- horas de emergencia con lo que se arregló.
    reparacion_id UUID REFERENCES reparaciones_red(id) ON DELETE SET NULL,
    motivo        TEXT NOT NULL,

    inicio_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin_at        TIMESTAMPTZ,
    lat_ingreso   NUMERIC(10,7),
    lng_ingreso   NUMERIC(10,7),
    foto_ingreso  TEXT,
    -- Lo que se hizo, al cerrarla.
    cierre_nota   TEXT,

    -- Opcionales: solo quien maneja carga el vehículo y el odómetro.
    vehiculo_id   UUID REFERENCES vehiculos(id) ON DELETE SET NULL,
    km_inicio     INT CHECK (km_inicio IS NULL OR km_inicio >= 0),
    km_fin        INT CHECK (km_fin IS NULL OR km_fin >= 0),

    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT emergencia_km_coherente CHECK (km_fin IS NULL OR km_inicio IS NULL OR km_fin >= km_inicio),
    CONSTRAINT emergencia_fin_coherente CHECK (fin_at IS NULL OR fin_at >= inicio_at)
);

-- Una sola abierta por técnico: dos a la vez contarían las horas dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emergencia_una_abierta
    ON salidas_emergencia (tecnico_id) WHERE fin_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_emergencias_tecnico
    ON salidas_emergencia (tecnico_id, inicio_at DESC);

COMMENT ON TABLE salidas_emergencia IS
    'Trabajo fuera de la jornada (corte de noche, torre caída de madrugada). Habilita a trabajar mientras está abierta y deja las horas aparte de la jornada.';

ALTER TABLE salidas_emergencia ENABLE ROW LEVEL SECURITY;

-- Igual que las jornadas: cada técnico las suyas, la oficina todas. Se abren y
-- se cierran por las funciones de abajo; directo solo se lee y se sube la foto.
DROP POLICY IF EXISTS emergencias_leer ON salidas_emergencia;
CREATE POLICY emergencias_leer ON salidas_emergencia
    FOR SELECT TO authenticated
    USING (cartera_completa() OR ve_todo_el_equipo() OR tecnico_id = mi_tecnico_id());

DROP POLICY IF EXISTS emergencias_foto ON salidas_emergencia;
CREATE POLICY emergencias_foto ON salidas_emergencia
    FOR UPDATE TO authenticated
    USING (tecnico_id = mi_tecnico_id())
    WITH CHECK (tecnico_id = mi_tecnico_id());

-- La foto va al mismo bucket que la del ingreso (la 188), en
-- `emergencia/<id>/`. Mismo criterio: subir y reemplazar sí, borrar no.
DROP POLICY IF EXISTS emergencias_foto_subir ON storage.objects;
CREATE POLICY emergencias_foto_subir ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'jornadas'
        AND (storage.foldername(name))[1] = 'emergencia'
        AND (storage.foldername(name))[2] IN (SELECT id::TEXT FROM salidas_emergencia)
    );

DROP POLICY IF EXISTS emergencias_foto_leer ON storage.objects;
CREATE POLICY emergencias_foto_leer ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'jornadas'
        AND (storage.foldername(name))[1] = 'emergencia'
        AND (storage.foldername(name))[2] IN (SELECT id::TEXT FROM salidas_emergencia)
    );


-- =============================================================================
-- 2. ¿Está en servicio?
-- =============================================================================
/** ¿Quien pregunta es un técnico de campo? Es a quien se le exige el ingreso. */
CREATE OR REPLACE FUNCTION es_tecnico_de_campo()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo AND rol = 'tecnico'
    )
$$;

GRANT EXECUTE ON FUNCTION es_tecnico_de_campo() TO authenticated;

/**
 * ¿El técnico estaba trabajando en ese momento?
 *
 * Por ventana de horas y no por fecha: una emergencia que empieza a las 23:00
 * y termina a las 02:00 cubre las dos fechas.
 */
CREATE OR REPLACE FUNCTION en_servicio(p_tecnico UUID, p_momento TIMESTAMPTZ DEFAULT NOW())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_tecnico IS NOT NULL AND (
        EXISTS (
            SELECT 1 FROM jornadas j
             WHERE j.tecnico_id = p_tecnico
               AND j.inicio_at IS NOT NULL
               AND j.inicio_at <= p_momento + INTERVAL '2 minutes'
               AND (j.fin_at IS NULL OR j.fin_at >= p_momento)
        )
        OR EXISTS (
            SELECT 1 FROM salidas_emergencia e
             WHERE e.tecnico_id = p_tecnico
               AND e.inicio_at <= p_momento + INTERVAL '2 minutes'
               AND (e.fin_at IS NULL OR e.fin_at >= p_momento)
        )
    )
$$;

GRANT EXECUTE ON FUNCTION en_servicio(UUID, TIMESTAMPTZ) TO authenticated;

/**
 * Para la pantalla: si quien pregunta puede iniciar un trabajo ahora.
 * Quien no es técnico de campo siempre puede.
 */
CREATE OR REPLACE FUNCTION estoy_en_servicio()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NOT es_tecnico_de_campo() OR en_servicio(mi_tecnico_id(), NOW())
$$;

GRANT EXECUTE ON FUNCTION estoy_en_servicio() TO authenticated;

/** El rechazo, con el mismo texto en todos lados. */
CREATE OR REPLACE FUNCTION exigir_en_servicio(p_momento TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF es_tecnico_de_campo() AND NOT en_servicio(mi_tecnico_id(), COALESCE(p_momento, NOW())) THEN
        -- 42501: la cola de campo lo trata como definitivo y no lo reintenta
        -- ocho veces; reintentar no le abre la jornada.
        RAISE EXCEPTION 'Primero marcá tu ingreso en Mi jornada. Si tu jornada ya terminó y es una emergencia, marcá una salida de emergencia.'
            USING ERRCODE = '42501';
    END IF;
END;
$$;


-- =============================================================================
-- 3. Los trabajos que no arrancan sin ingreso
-- =============================================================================
CREATE OR REPLACE FUNCTION controlar_inicio_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado IN ('en_ruta', 'en_proceso') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        PERFORM exigir_en_servicio(
            CASE NEW.estado WHEN 'en_ruta' THEN NEW.salida_at ELSE NEW.llegada_at END);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inicio_ticket ON tickets;
CREATE TRIGGER trg_inicio_ticket
    BEFORE UPDATE OF estado ON tickets
    FOR EACH ROW EXECUTE FUNCTION controlar_inicio_ticket();

CREATE OR REPLACE FUNCTION controlar_inicio_instalacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado IN ('en_ruta', 'en_curso') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        PERFORM exigir_en_servicio(NEW.llegada_at);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inicio_instalacion ON instalaciones;
CREATE TRIGGER trg_inicio_instalacion
    BEFORE UPDATE OF estado ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION controlar_inicio_instalacion();

-- Las reparaciones de la 209: el avance y el cierre también son trabajo.
CREATE OR REPLACE FUNCTION controlar_reporte_reparacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.tipo IN ('avance', 'reparada') THEN
        PERFORM exigir_en_servicio(NEW.creado_at);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reporte_reparacion ON reparacion_reportes;
CREATE TRIGGER trg_reporte_reparacion
    BEFORE INSERT ON reparacion_reportes
    FOR EACH ROW EXECUTE FUNCTION controlar_reporte_reparacion();


-- =============================================================================
-- 4. Abrir y cerrar la emergencia
-- =============================================================================
/**
 * Sale por una emergencia.
 *
 * Solo si NO está en servicio: con la jornada abierta, la emergencia es un
 * trabajo más del día y no hace falta marcar nada. Devuelve el id, para subir
 * la foto a su carpeta.
 */
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
    v_id     UUID;
    u        RECORD;
BEGIN
    IF v_tec IS NULL THEN
        RAISE EXCEPTION 'Tu usuario no está vinculado a un técnico.';
    END IF;
    IF en_servicio(v_tec, NOW()) THEN
        RAISE EXCEPTION 'Ya estás en servicio: tu jornada está abierta. La emergencia es un trabajo más del día.';
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

    -- La oficina se entera de que alguien salió fuera de horario.
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

REVOKE ALL ON FUNCTION abrir_emergencia(TEXT, UUID, NUMERIC, NUMERIC, UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION abrir_emergencia(TEXT, UUID, NUMERIC, NUMERIC, UUID, INT) TO authenticated;

CREATE OR REPLACE FUNCTION cerrar_emergencia(p_nota TEXT DEFAULT NULL, p_km_fin INT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v salidas_emergencia%ROWTYPE;
BEGIN
    SELECT * INTO v FROM salidas_emergencia
     WHERE tecnico_id = mi_tecnico_id() AND fin_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No tenés ninguna emergencia abierta.';
    END IF;
    IF v.km_inicio IS NOT NULL AND p_km_fin IS NULL THEN
        RAISE EXCEPTION 'Anotá el kilometraje al volver.';
    END IF;
    IF p_km_fin IS NOT NULL AND v.km_inicio IS NOT NULL AND p_km_fin < v.km_inicio THEN
        RAISE EXCEPTION 'El tablero no puede marcar menos que al salir (% km).', v.km_inicio;
    END IF;

    UPDATE salidas_emergencia
       SET fin_at = NOW(),
           cierre_nota = NULLIF(BTRIM(p_nota), ''),
           km_fin = p_km_fin
     WHERE id = v.id;
END;
$$;

REVOKE ALL ON FUNCTION cerrar_emergencia(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cerrar_emergencia(TEXT, INT) TO authenticated;

/** Las emergencias con nombre y duración, para la jornada y para la oficina. */
DROP VIEW IF EXISTS v_salidas_emergencia;
CREATE VIEW v_salidas_emergencia WITH (security_invoker = true) AS
SELECT e.*,
       t.nombre AS tecnico,
       r.numero AS reparacion_numero,
       r.titulo AS reparacion_titulo,
       (EXTRACT(EPOCH FROM (COALESCE(e.fin_at, NOW()) - e.inicio_at)) / 60)::int AS minutos,
       e.km_fin - e.km_inicio AS km_recorridos
  FROM salidas_emergencia e
  JOIN tecnicos t ON t.id = e.tecnico_id
  LEFT JOIN reparaciones_red r ON r.id = e.reparacion_id;

GRANT SELECT ON v_salidas_emergencia TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- ¿Quién está en servicio ahora?
--   SELECT t.nombre, en_servicio(t.id) FROM tecnicos t WHERE t.activo;
--
--   -- Las emergencias de la semana:
--   SELECT tecnico, motivo, inicio_at, minutos FROM v_salidas_emergencia
--    WHERE inicio_at > NOW() - INTERVAL '7 days' ORDER BY inicio_at DESC;
