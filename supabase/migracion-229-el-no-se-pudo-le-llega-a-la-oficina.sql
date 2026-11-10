-- =============================================================================
-- Migración 229: el "no se pudo atender" le llega a toda la oficina
-- =============================================================================
--
-- Hasta acá el aviso de la campana ("No se pudo atender el ticket #45 ·
-- Diana Niola — Hace falta otro trabajo: …") les llegaba solo a los roles
-- super_admin, admin y jefe_tecnico. Quien atiende soporte y carga tickets con
-- otro rol no se enteraba, y es justamente quien llama al abonado y reagenda.
--
-- Ahora le llega a todo usuario activo que crea, asigna u ordena tickets
-- (permisos soporte.crear, soporte.asignar o soporte.ruta, o '*'), además de
-- esos tres roles. No a quien lo marca: si un administrador que también hace
-- campo marca el "no se pudo", no se avisa a sí mismo.
--
-- El resto de la función es igual a la de la migración 228.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

CREATE OR REPLACE FUNCTION no_se_pudo_atender(
    p_ticket  UUID,
    p_motivo  TEXT,
    p_detalle TEXT,
    p_foto    TEXT,
    p_lat     NUMERIC DEFAULT NULL,
    p_lng     NUMERIC DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    t       tickets%ROWTYPE;
    v_tec   UUID := mi_tecnico_id();
    v_min   NUMERIC;
    v_txt   TEXT;
    v_det   TEXT := NULLIF(BTRIM(p_detalle), '');
    u       RECORD;
BEGIN
    SELECT * INTO t FROM tickets WHERE id = p_ticket FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese ticket.'; END IF;

    IF NOT (ordena_rutas() OR t.tecnico_id = v_tec
            OR t.cuadrilla_id IN (SELECT cuadrilla_id FROM cuadrilla_miembros WHERE tecnico_id = v_tec)) THEN
        RAISE EXCEPTION 'Ese ticket no es tuyo ni de tu cuadrilla.' USING ERRCODE = '42501';
    END IF;
    IF t.estado <> 'en_proceso' OR t.llegada_at IS NULL THEN
        RAISE EXCEPTION 'Primero marcá "Llegué" en el sitio: el "no se pudo" se registra donde el cliente.';
    END IF;
    IF p_motivo NOT IN ('no_contesta', 'sin_nadie', 'no_permite', 'direccion_erronea',
                        'falta_material', 'clima', 'requiere_otro', 'otro') THEN
        RAISE EXCEPTION 'Motivo desconocido: %', p_motivo;
    END IF;

    IF p_motivo = 'requiere_otro' THEN
        -- Lo que encontró es lo que la oficina necesita para reagendar bien.
        IF length(COALESCE(v_det, '')) < 10 THEN
            RAISE EXCEPTION 'Contá qué encontraste y qué hace falta: es lo que lee la oficina para reagendar.';
        END IF;
    ELSE
        IF NULLIF(BTRIM(p_foto), '') IS NULL THEN
            RAISE EXCEPTION 'Falta la foto de la fachada: es la prueba de que estuviste ahí.';
        END IF;
        IF p_motivo = 'otro' AND v_det IS NULL THEN
            RAISE EXCEPTION 'Contá qué pasó.';
        END IF;
    END IF;

    IF p_motivo IN ('no_contesta', 'sin_nadie') THEN
        v_min := EXTRACT(EPOCH FROM (NOW() - t.llegada_at)) / 60;
        IF v_min < 10 THEN
            RAISE EXCEPTION 'Esperá 10 minutos desde que llegaste: faltan % min.', CEIL(10 - v_min)::int;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM campo_llamadas
                        WHERE item_tipo = 'ticket' AND item_id = p_ticket
                          AND creado_at >= t.llegada_at - INTERVAL '2 hours') THEN
            RAISE EXCEPTION 'Llamá o escribile al cliente desde la app antes de marcar que no contesta.';
        END IF;
    END IF;

    INSERT INTO visitas_fallidas (ticket_id, tecnico_id, usuario_id, motivo, detalle, foto, lat, lng, llegada_at)
    VALUES (p_ticket, v_tec, mi_usuario_id(), p_motivo, v_det, NULLIF(BTRIM(p_foto), ''),
            p_lat, p_lng, t.llegada_at);

    -- Vuelve a la oficina: sin fecha, fuera de la ruta, para reprogramar.
    UPDATE tickets
       SET estado = 'asignado', fecha_visita = NULL, ruta_fecha = NULL, ruta_orden = NULL,
           salida_at = NULL, llegada_at = NULL, reprogramar_desde = NOW()
     WHERE id = p_ticket;

    v_txt := CASE p_motivo
        WHEN 'no_contesta' THEN 'No contesta'
        WHEN 'sin_nadie' THEN 'No hay nadie'
        WHEN 'no_permite' THEN 'No permite el ingreso'
        WHEN 'direccion_erronea' THEN 'Dirección errónea'
        WHEN 'falta_material' THEN 'Faltó material'
        WHEN 'clima' THEN 'Lluvia o peligro'
        WHEN 'requiere_otro' THEN 'Hace falta otro trabajo'
        ELSE 'Otro' END;

    -- A toda la oficina que maneja tickets: quien los crea, los asigna u
    -- ordena las rutas, además de los administradores y el jefe técnico
    -- (migración 229). Menos a quien lo está marcando.
    FOR u IN SELECT id FROM usuarios_sistema
              WHERE activo
                AND id IS DISTINCT FROM mi_usuario_id()
                AND (rol IN ('super_admin', 'admin', 'jefe_tecnico')
                     OR permisos ? '*'
                     OR permisos ? 'soporte.crear'
                     OR permisos ? 'soporte.asignar'
                     OR permisos ? 'soporte.ruta')
    LOOP
        PERFORM notificar(u.id, 'visita_fallida',
            format('No se pudo atender el ticket #%s · %s', t.numero, t.nombre),
            v_txt || COALESCE(': ' || v_det, '') || '. Hay que reprogramarlo.',
            '/soporte/rutas', 'ticket', p_ticket::text);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION no_se_pudo_atender(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION no_se_pudo_atender(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) TO authenticated;
