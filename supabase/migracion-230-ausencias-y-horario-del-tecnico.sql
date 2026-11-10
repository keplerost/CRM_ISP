-- =============================================================================
-- Migración 230: quién de la cuadrilla está hoy
-- =============================================================================
--
-- El panel "Personal en campo" le daba a cada integrante todos los trabajos de
-- su cuadrilla: con uno en descanso médico y otro que trabaja medio día, los
-- tres de TROOPER salían "En camino". Faltaban dos datos que solo la oficina
-- conoce:
--
--   1. LAS AUSENCIAS: descanso médico, vacaciones, permiso. Con fecha de
--      inicio y de fin, para cargarlas una vez y no todos los días.
--   2. EL HORARIO de cada técnico: jornada completa, solo mañana o solo tarde.
--
-- El tercer dato —quién ingresó hoy— ya estaba: la foto grupal o la jornada de
-- cada uno (migraciones 188 a 213). El panel lo cruza en la web.
--
-- Además, al ausente no le llega el "No vayas" de la oficina (227): no está
-- trabajando, y el aviso es para la cuadrilla que sí.
--
-- Quién las carga: administración, quien asigna u ordena tickets, o quien edita
-- el personal. Leerlas, cualquiera del sistema: el jefe de grupo necesita saber
-- quién falta.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

-- ─── 1. El horario ──────────────────────────────────────────────────────────

ALTER TABLE tecnicos ADD COLUMN IF NOT EXISTS horario VARCHAR(10) NOT NULL DEFAULT 'completo';
ALTER TABLE tecnicos DROP CONSTRAINT IF EXISTS tecnicos_horario_check;
ALTER TABLE tecnicos ADD CONSTRAINT tecnicos_horario_check
    CHECK (horario IN ('completo', 'manana', 'tarde'));

COMMENT ON COLUMN tecnicos.horario IS
    'completo, manana o tarde. El panel lo muestra "Fuera de horario" en la otra mitad del día.';


-- ─── 2. Las ausencias ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tecnico_ausencias (
    id         BIGSERIAL PRIMARY KEY,
    tecnico_id UUID NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
    tipo       VARCHAR(20) NOT NULL DEFAULT 'descanso_medico'
               CHECK (tipo IN ('descanso_medico', 'vacaciones', 'permiso', 'otro')),
    desde      DATE NOT NULL,
    hasta      DATE NOT NULL,
    nota       TEXT,
    creado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL DEFAULT mi_usuario_id(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tecnico_ausencias_fechas CHECK (hasta >= desde)
);

CREATE INDEX IF NOT EXISTS idx_tecnico_ausencias_tecnico ON tecnico_ausencias (tecnico_id, hasta DESC);

COMMENT ON TABLE tecnico_ausencias IS
    'Descanso médico, vacaciones o permiso de un técnico, de una fecha a otra (las dos incluidas).';

/** ¿Quien pregunta puede cargar ausencias? */
CREATE OR REPLACE FUNCTION gestiona_ausencias()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo
           AND (rol IN ('super_admin', 'admin') OR permisos ? '*'
                OR permisos ? 'soporte.asignar' OR permisos ? 'soporte.ruta'
                OR permisos ? 'usuarios.editar')
    )
$$;

GRANT EXECUTE ON FUNCTION gestiona_ausencias() TO authenticated;

ALTER TABLE tecnico_ausencias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tecnico_ausencias_leer ON tecnico_ausencias;
CREATE POLICY tecnico_ausencias_leer ON tecnico_ausencias
    FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS tecnico_ausencias_cargar ON tecnico_ausencias;
CREATE POLICY tecnico_ausencias_cargar ON tecnico_ausencias
    FOR INSERT TO authenticated WITH CHECK (gestiona_ausencias());

DROP POLICY IF EXISTS tecnico_ausencias_cambiar ON tecnico_ausencias;
CREATE POLICY tecnico_ausencias_cambiar ON tecnico_ausencias
    FOR UPDATE TO authenticated USING (gestiona_ausencias()) WITH CHECK (gestiona_ausencias());

DROP POLICY IF EXISTS tecnico_ausencias_borrar ON tecnico_ausencias;
CREATE POLICY tecnico_ausencias_borrar ON tecnico_ausencias
    FOR DELETE TO authenticated USING (gestiona_ausencias());

REVOKE ALL ON tecnico_ausencias FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tecnico_ausencias TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE tecnico_ausencias_id_seq TO authenticated;

/** ¿Está ausente ese día? */
CREATE OR REPLACE FUNCTION tecnico_ausente(p_tecnico UUID, p_fecha DATE DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM tecnico_ausencias
         WHERE tecnico_id = p_tecnico
           AND COALESCE(p_fecha, hoy_isp()) BETWEEN desde AND hasta
    )
$$;

GRANT EXECUTE ON FUNCTION tecnico_ausente(UUID, DATE) TO authenticated;


-- ─── 3. El "No vayas" no le llega al ausente ────────────────────────────────
-- La misma función de la 227; cambia solo a quién se avisa.

CREATE OR REPLACE FUNCTION oficina_confirma_visita(
    p_ticket    UUID,
    p_resultado TEXT,
    p_detalle   TEXT DEFAULT NULL,
    p_fecha     DATE DEFAULT NULL,
    p_franja    TEXT DEFAULT NULL,
    p_hora      TIME DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    t        tickets%ROWTYPE;
    v_yo     UUID := mi_usuario_id();
    v_txt    TEXT;
    v_cuando TEXT;
    u        RECORD;
BEGIN
    IF NOT (ordena_rutas() OR EXISTS (
        SELECT 1 FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo
           AND (rol IN ('super_admin', 'admin') OR permisos ? '*'
                OR permisos ? 'soporte.crear' OR permisos ? 'soporte.asignar')
    )) THEN
        RAISE EXCEPTION 'Confirmar la visita lo hace la oficina: quien crea, asigna u ordena tickets.'
            USING ERRCODE = '42501';
    END IF;

    IF p_resultado NOT IN ('esta', 'no_contesta', 'no_esta', 'otro_dia') THEN
        RAISE EXCEPTION 'Resultado desconocido: %', p_resultado;
    END IF;

    SELECT * INTO t FROM tickets WHERE id = p_ticket FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese ticket.'; END IF;
    IF t.estado IN ('resuelto', 'cancelado') THEN
        RAISE EXCEPTION 'El ticket ya está cerrado.';
    END IF;
    IF t.estado = 'en_proceso' THEN
        RAISE EXCEPTION 'El técnico ya está en el lugar: el "no se pudo" lo marca él desde la app.';
    END IF;

    IF p_fecha IS NOT NULL AND p_fecha < hoy_isp() THEN
        RAISE EXCEPTION 'La nueva fecha no puede ser anterior a hoy.';
    END IF;
    IF p_franja IS NOT NULL AND p_franja NOT IN ('manana', 'tarde', 'exacta') THEN
        RAISE EXCEPTION 'Franja desconocida: %', p_franja;
    END IF;
    IF p_franja = 'exacta' AND p_hora IS NULL THEN
        RAISE EXCEPTION 'Con hora exacta, falta la hora.';
    END IF;

    INSERT INTO confirmaciones_visita (ticket_id, resultado, detalle, nueva_fecha, nueva_franja, nueva_hora, usuario_id)
    VALUES (p_ticket, p_resultado, NULLIF(BTRIM(p_detalle), ''),
            CASE WHEN p_resultado <> 'esta' THEN p_fecha END,
            CASE WHEN p_resultado <> 'esta' THEN p_franja END,
            CASE WHEN p_resultado <> 'esta' THEN p_hora END,
            v_yo);

    IF p_resultado = 'esta' THEN
        RETURN;
    END IF;

    UPDATE tickets
       SET estado            = CASE WHEN estado = 'en_ruta' THEN 'asignado' ELSE estado END,
           salida_at         = NULL,
           ruta_fecha        = NULL,
           ruta_orden        = NULL,
           ruta_auto         = TRUE,
           fecha_visita      = p_fecha,
           franja            = CASE WHEN p_fecha IS NOT NULL THEN COALESCE(p_franja, franja) ELSE franja END,
           hora_visita       = CASE
                                   WHEN p_fecha IS NULL THEN hora_visita
                                   WHEN COALESCE(p_franja, franja) = 'exacta' THEN COALESCE(p_hora, hora_visita)
                                   ELSE NULL
                               END,
           reprogramar_desde = CASE WHEN p_fecha IS NULL THEN NOW() ELSE NULL END,
           demora_motivo     = COALESCE(demora_motivo, 'cliente'),
           demora_nota       = COALESCE(demora_nota,
                                        'Oficina: ' || CASE p_resultado
                                            WHEN 'no_contesta' THEN 'no contesta'
                                            WHEN 'no_esta' THEN 'no está en casa'
                                            ELSE 'pidió otro día' END
                                        || ' (' || to_char(NOW() AT TIME ZONE zona_horaria(), 'DD/MM HH24:MI') || ')'),
           demora_registrada_at = COALESCE(demora_registrada_at, NOW())
     WHERE id = p_ticket;

    v_txt := CASE p_resultado
        WHEN 'no_contesta' THEN 'No contesta'
        WHEN 'no_esta' THEN 'No está en casa'
        ELSE 'Pidió otro día' END;
    v_cuando := CASE
        WHEN p_fecha IS NULL THEN 'Queda por reprogramar.'
        ELSE 'Nueva visita: ' || to_char(p_fecha, 'DD/MM')
             || CASE COALESCE(p_franja, t.franja)
                    WHEN 'manana' THEN ' (mañana)'
                    WHEN 'tarde' THEN ' (tarde)'
                    WHEN 'exacta' THEN ' a las ' || to_char(COALESCE(p_hora, t.hora_visita), 'HH24:MI')
                    ELSE '' END || '.'
        END;

    -- Al técnico, o a la cuadrilla: que no vaya. Menos al que hoy no trabaja.
    FOR u IN
        SELECT DISTINCT us.id
          FROM usuarios_sistema us
         WHERE us.activo AND us.tecnico_id IS NOT NULL
           AND (us.tecnico_id = t.tecnico_id
                OR (t.tecnico_id IS NULL AND us.tecnico_id IN (
                        SELECT cm.tecnico_id FROM cuadrilla_miembros cm WHERE cm.cuadrilla_id = t.cuadrilla_id)))
           AND us.id IS DISTINCT FROM v_yo
           AND NOT tecnico_ausente(us.tecnico_id)
    LOOP
        PERFORM notificar(u.id, 'visita_postergada',
            format('No vayas: ticket #%s · %s', t.numero, t.nombre),
            'La oficina llamó: ' || lower(v_txt)
                || COALESCE(' (' || NULLIF(BTRIM(p_detalle), '') || ')', '') || '. ' || v_cuando,
            '/campo', 'ticket', p_ticket::text);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION oficina_confirma_visita(UUID, TEXT, TEXT, DATE, TEXT, TIME) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION oficina_confirma_visita(UUID, TEXT, TEXT, DATE, TEXT, TIME) TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT t.nombre, t.horario, a.tipo, a.desde, a.hasta
--     FROM tecnicos t LEFT JOIN tecnico_ausencias a
--       ON a.tecnico_id = t.id AND hoy_isp() BETWEEN a.desde AND a.hasta
--    WHERE t.activo ORDER BY t.nombre;
