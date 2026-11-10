-- =============================================================================
-- Migración 227: la oficina llama antes y confirma (o posterga) la visita
-- =============================================================================
--
-- Hasta acá, "el cliente no está" solo lo podía registrar el técnico: llegar,
-- marcar la llegada, llamar desde la app, esperar 10 minutos y sacar la foto
-- de la fachada (migración 216). Es la prueba correcta para el técnico, pero
-- cuesta un viaje y diez minutos que la oficina se puede ahorrar con una
-- llamada mientras la cuadrilla trabaja en otra casa.
--
-- Esto agrega la llamada de la oficina:
--
--   'esta'         el cliente está: la parada queda "confirmada" en la ruta y
--                  el técnico lo ve.
--   'no_contesta'  no atiende el teléfono.
--   'no_esta'      atiende pero no está en casa.
--   'otro_dia'     pide que vayan otro día u otra hora.
--
-- Las tres últimas sacan el ticket de la ruta de hoy SIN cerrarlo:
--   · con nueva fecha (y franja u hora): queda agendado para ese día;
--   · sin fecha: va a "Por reprogramar", como el "no se pudo" del técnico.
-- El plazo de atención queda justificado por el cliente, y el técnico (o la
-- cuadrilla) recibe el aviso para no ir.
--
-- No se escribe una nota en `ticket_eventos`: un evento con nota se le manda
-- al abonado como respuesta (migración 137), y esto es interno. El registro
-- vive en `confirmaciones_visita`.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

CREATE TABLE IF NOT EXISTS confirmaciones_visita (
    id           BIGSERIAL PRIMARY KEY,
    ticket_id    UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    resultado    VARCHAR(15) NOT NULL
                 CHECK (resultado IN ('esta', 'no_contesta', 'no_esta', 'otro_dia')),
    detalle      TEXT,
    nueva_fecha  DATE,
    nueva_franja VARCHAR(10),
    nueva_hora   TIME,
    usuario_id   UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_confirmaciones_visita_ticket
    ON confirmaciones_visita (ticket_id, creado_at DESC);

COMMENT ON TABLE confirmaciones_visita IS
    'Las llamadas de la oficina antes de la visita: si el cliente está, o por qué se postergó. Se escriben con oficina_confirma_visita().';

-- Lee quien puede ver el ticket (la política de tickets hace el resto). Nadie
-- escribe directo: solo la función.
ALTER TABLE confirmaciones_visita ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS confirmaciones_visita_leer ON confirmaciones_visita;
CREATE POLICY confirmaciones_visita_leer ON confirmaciones_visita
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_id));

REVOKE ALL ON confirmaciones_visita FROM anon;
GRANT SELECT ON confirmaciones_visita TO authenticated;


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

    -- Está en casa: solo queda la confirmación, que la ruta muestra.
    IF p_resultado = 'esta' THEN
        RETURN;
    END IF;

    -- Postergado: sale de la ruta de hoy sin cerrarse. Si el técnico ya había
    -- salido, vuelve a "asignado" (el disparador de estados deja el evento).
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
           -- El plazo se pasa por el cliente, no por la cuadrilla.
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

    -- Al técnico, o a toda la cuadrilla: que no vaya.
    FOR u IN
        SELECT DISTINCT us.id
          FROM usuarios_sistema us
         WHERE us.activo AND us.tecnico_id IS NOT NULL
           AND (us.tecnico_id = t.tecnico_id
                OR (t.tecnico_id IS NULL AND us.tecnico_id IN (
                        SELECT cm.tecnico_id FROM cuadrilla_miembros cm WHERE cm.cuadrilla_id = t.cuadrilla_id)))
           AND us.id IS DISTINCT FROM v_yo
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
--   SELECT c.creado_at, t.numero, t.nombre, c.resultado, c.nueva_fecha, c.nueva_franja
--     FROM confirmaciones_visita c JOIN tickets t ON t.id = c.ticket_id
--    ORDER BY c.creado_at DESC LIMIT 20;
