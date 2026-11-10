-- =============================================================================
-- Migración 228: la llamada sin señal, y "hace falta otro trabajo"
-- =============================================================================
--
-- 1. LA LLAMADA SIN SEÑAL
--
--    El técnico sin datos igual puede llamar (la voz no usa datos), pero la
--    constancia de la llamada no llegaba a la base y después el "no contesta"
--    se le rechazaba. Ahora la app la guarda en su cola y la sube sola cuando
--    vuelve la señal. Para eso `registrar_llamada` recibe:
--      · p_cuando: la hora en que se llamó de verdad, no la de la subida. Se
--        acepta hasta 12 horas atrás y nunca en el futuro (el reloj del
--        teléfono puede estar mal);
--      · p_clave: la clave de la cola. Si la subida se reintenta, la misma
--        llamada no se cuenta dos veces.
--
-- 2. "HACE FALTA OTRO TRABAJO"
--
--    El caso que lo pidió: Diana Niola pidió una reconexión; la cuadrilla llega
--    y no tiene potencia, y como hace años que no tenía servicio es en realidad
--    una instalación nueva. La cuadrilla tiene otra instalación agendada y no
--    se puede quedar. Con los motivos que había, el único "no se pudo" que
--    servía era "Otro", que exige la foto de la fachada: una prueba de que
--    estuvo ahí que en este caso no hace falta, porque el técnico está
--    reportando lo que encontró, no que el cliente no estaba.
--
--    Motivo nuevo 'requiere_otro': sin foto ni espera, con la explicación
--    obligatoria (al menos 10 letras). El ticket vuelve a la oficina para
--    reprogramar, como cualquier "no se pudo", y el aviso a la oficina lleva lo
--    que escribió el técnico.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

-- ─── 1. La llamada ──────────────────────────────────────────────────────────

ALTER TABLE campo_llamadas ADD COLUMN IF NOT EXISTS clave UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ux_campo_llamadas_clave ON campo_llamadas (clave);

-- La firma cambia: se borra la de tres argumentos para que una app vieja que
-- todavía llama con tres caiga en esta (los otros dos tienen valor por
-- omisión) y PostgREST no encuentre dos candidatas.
DROP FUNCTION IF EXISTS registrar_llamada(TEXT, UUID, TEXT);

CREATE OR REPLACE FUNCTION registrar_llamada(
    p_tipo   TEXT,
    p_id     UUID,
    p_canal  TEXT DEFAULT 'llamada',
    p_cuando TIMESTAMPTZ DEFAULT NULL,
    p_clave  UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO campo_llamadas (tecnico_id, usuario_id, item_tipo, item_id, canal, creado_at, clave)
    VALUES (mi_tecnico_id(), mi_usuario_id(), p_tipo, p_id,
            CASE WHEN p_canal = 'whatsapp' THEN 'whatsapp' ELSE 'llamada' END,
            LEAST(NOW(), GREATEST(COALESCE(p_cuando, NOW()), NOW() - INTERVAL '12 hours')),
            p_clave)
    ON CONFLICT (clave) DO NOTHING
$$;

REVOKE ALL ON FUNCTION registrar_llamada(TEXT, UUID, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_llamada(TEXT, UUID, TEXT, TIMESTAMPTZ, UUID) TO authenticated;


-- ─── 2. Hace falta otro trabajo ─────────────────────────────────────────────

ALTER TABLE visitas_fallidas DROP CONSTRAINT IF EXISTS visitas_fallidas_motivo_check;
ALTER TABLE visitas_fallidas ADD CONSTRAINT visitas_fallidas_motivo_check
    CHECK (motivo IN ('no_contesta', 'sin_nadie', 'no_permite', 'direccion_erronea',
                      'falta_material', 'clima', 'requiere_otro', 'otro'));

-- La foto deja de ser obligatoria en la tabla: la exige la función, salvo
-- para 'requiere_otro'.
ALTER TABLE visitas_fallidas ALTER COLUMN foto DROP NOT NULL;

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

    FOR u IN SELECT id FROM usuarios_sistema
              WHERE activo AND rol IN ('super_admin', 'admin', 'jefe_tecnico')
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


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT canal, creado_at, clave IS NOT NULL AS desde_la_cola
--     FROM campo_llamadas ORDER BY id DESC LIMIT 10;
--   SELECT t.numero, f.motivo, f.detalle FROM visitas_fallidas f
--     JOIN tickets t ON t.id = f.ticket_id ORDER BY f.creado_at DESC LIMIT 10;
