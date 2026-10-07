-- =============================================================================
-- Migración 216 — La ruta del día
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 212 (ingreso en el primer cliente).
DROP FUNCTION IF EXISTS ruta_del_tecnico(UUID, DATE);
--
-- ── Qué resuelve ──
--
-- La app le mostraba al técnico todos sus trabajos y le dejaba hacer cualquiera,
-- en cualquier orden. No se iba según lo programado, y el cliente que no
-- contestaba quedaba "en proceso" sin que nadie se enterara.
--
-- 1. LA RUTA DEL DÍA. Los trabajos de hoy de cada técnico —los suyos y los de
--    sus cuadrillas: tickets e instalaciones— en un orden. El orden lo fija la
--    oficina (administración, jefe técnico, o quien tenga el permiso
--    `soporte.ruta`) o el jefe de grupo del día, que tiene que decir por qué.
--    Sin orden fijado, se ordena por prioridad, fecha, franja y hora.
--
-- 2. BLOQUEO ESTRICTO. Un trabajo a la vez: el técnico no puede salir hacia ni
--    llegar a otro trabajo mientras el actual no esté terminado. El actual es
--    el que está en curso; si no hay, el primero pendiente.
--
-- 3. NO SE PUDO ATENDER. El ticket que no se pudo hacer termina igual: con
--    motivo, foto de la fachada y la llegada marcada. Si el motivo es "no
--    contesta" o "no hay nadie", además hace falta haberlo llamado desde la app
--    y esperar 10 minutos desde la llegada. El ticket vuelve a la oficina para
--    reprogramar, se avisa por la campana y el siguiente se desbloquea.
-- =============================================================================


-- =============================================================================
-- 1. El orden de la ruta, en cada trabajo
-- =============================================================================
ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS ruta_fecha DATE,
    ADD COLUMN IF NOT EXISTS ruta_orden INT,
    -- Desde cuándo espera que la oficina le dé una nueva fecha (no se pudo
    -- atender). Se limpia sola al ponerle fecha de visita.
    ADD COLUMN IF NOT EXISTS reprogramar_desde TIMESTAMPTZ;

ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS ruta_fecha DATE,
    ADD COLUMN IF NOT EXISTS ruta_orden INT;

/** La fecha de hoy en la hora del ISP. */
CREATE OR REPLACE FUNCTION hoy_isp()
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
    SELECT (NOW() AT TIME ZONE zona_horaria())::date
$$;

-- Al ponerle fecha de visita a un ticket que esperaba reprogramación, deja de
-- esperar.
CREATE OR REPLACE FUNCTION limpiar_reprogramar()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.reprogramar_desde IS NOT NULL AND NEW.fecha_visita IS NOT NULL
       AND NEW.fecha_visita IS DISTINCT FROM OLD.fecha_visita THEN
        NEW.reprogramar_desde := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_limpiar_reprogramar ON tickets;
CREATE TRIGGER trg_limpiar_reprogramar
    BEFORE UPDATE OF fecha_visita ON tickets
    FOR EACH ROW EXECUTE FUNCTION limpiar_reprogramar();


-- =============================================================================
-- 2. Los trabajos de una ruta
-- =============================================================================
/**
 * Los trabajos pendientes de unos técnicos y unas cuadrillas para una fecha,
 * en el orden en que se hacen. `posicion` 1 es el que va primero.
 *
 * Pendiente = asignado y con fecha hasta ese día (los atrasados también), sin
 * fecha (un ticket sin fecha de visita es para cuando se pueda, o sea hoy), o
 * ya en curso aunque sea de otro día.
 */
CREATE OR REPLACE FUNCTION items_de_ruta(p_tecnicos UUID[], p_cuadrillas UUID[], p_fecha DATE)
RETURNS TABLE (
    tipo        TEXT,
    id          UUID,
    numero      BIGINT,
    nombre      TEXT,
    direccion   TEXT,
    telefono    TEXT,
    latitud     NUMERIC,
    longitud    NUMERIC,
    estado      TEXT,
    en_curso    BOOLEAN,
    prioridad   TEXT,
    fecha       DATE,
    franja      TEXT,
    hora        TIME,
    detalle     TEXT,
    tecnico_id  UUID,
    cuadrilla_id UUID,
    salida_at   TIMESTAMPTZ,
    llegada_at  TIMESTAMPTZ,
    orden_fijado BOOLEAN,
    posicion    INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH todo AS (
        SELECT 'ticket'::text AS tipo, t.id, t.numero::bigint, t.nombre::text,
               t.direccion::text, COALESCE(t.telefono_whatsapp, t.telefono)::text AS telefono,
               COALESCE(t.latitud, c.latitud) AS latitud, COALESCE(t.longitud, c.longitud) AS longitud,
               t.estado::text, t.estado IN ('en_ruta', 'en_proceso') AS en_curso,
               t.prioridad::text, t.fecha_visita AS fecha, t.franja::text, t.hora_visita AS hora,
               t.tipo_incidencia::text AS detalle, t.tecnico_id, t.cuadrilla_id,
               t.salida_at, t.llegada_at, t.ruta_fecha, t.ruta_orden, t.created_at
          FROM tickets t
          LEFT JOIN clientes c ON c.id = t.client_id
         WHERE t.estado IN ('asignado', 'en_ruta', 'en_proceso')
           AND (t.tecnico_id = ANY(p_tecnicos) OR t.cuadrilla_id = ANY(p_cuadrillas))
           -- Sin fecha de visita cuenta como de hoy (al final), salvo que esté
           -- esperando que la oficina lo reprograme.
           AND (t.fecha_visita <= p_fecha
                OR (t.fecha_visita IS NULL AND t.reprogramar_desde IS NULL)
                OR t.estado IN ('en_ruta', 'en_proceso'))
        UNION ALL
        SELECT 'instalacion', i.id, i.numero::bigint, COALESCE(c.nombre, i.nombre)::text,
               COALESCE(i.direccion, c.direccion)::text, COALESCE(i.telefono_whatsapp, i.telefono)::text,
               COALESCE(i.latitud, c.latitud), COALESCE(i.longitud, c.longitud),
               i.estado::text, i.estado IN ('en_ruta', 'en_curso'),
               'media', i.fecha, i.franja::text, i.hora,
               i.tipo::text, i.tecnico_id, i.cuadrilla_id,
               NULL::timestamptz, i.llegada_at, i.ruta_fecha, i.ruta_orden, i.created_at
          FROM instalaciones i
          LEFT JOIN clientes c ON c.id = i.client_id
         WHERE i.estado IN ('agendada', 'en_ruta', 'en_curso', 'reprogramada')
           AND (i.tecnico_id = ANY(p_tecnicos) OR i.cuadrilla_id = ANY(p_cuadrillas))
           AND (i.fecha <= p_fecha OR i.estado IN ('en_ruta', 'en_curso'))
    )
    SELECT tipo, id, numero, nombre, direccion, telefono, latitud, longitud, estado, en_curso,
           prioridad, fecha, franja, hora, detalle, tecnico_id, cuadrilla_id, salida_at, llegada_at,
           (ruta_fecha = p_fecha AND ruta_orden IS NOT NULL) AS orden_fijado,
           ROW_NUMBER() OVER (ORDER BY
               en_curso DESC,
               CASE WHEN ruta_fecha = p_fecha AND ruta_orden IS NOT NULL THEN ruta_orden ELSE 100000 END,
               CASE prioridad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
               fecha NULLS LAST,
               CASE franja WHEN 'manana' THEN 0 WHEN 'exacta' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END,
               hora NULLS LAST,
               created_at,
               id)::int AS posicion
      FROM todo
     ORDER BY posicion
$$;

-- =============================================================================
-- 3. El bloqueo estricto
-- =============================================================================
/**
 * Si quien pregunta es un técnico de campo y quiere iniciar un trabajo que no
 * es el actual de su ruta, lo rechaza diciendo cuál es el actual.
 */
CREATE OR REPLACE FUNCTION exigir_trabajo_actual(p_tipo TEXT, p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tec UUID := mi_tecnico_id();
    a     RECORD;
BEGIN
    IF NOT es_tecnico_de_campo() OR v_tec IS NULL THEN
        RETURN;
    END IF;

    SELECT r.tipo, r.id, r.numero, r.nombre INTO a
      FROM items_de_ruta(
               ARRAY[v_tec],
               COALESCE((SELECT array_agg(cuadrilla_id) FROM cuadrilla_miembros WHERE tecnico_id = v_tec), '{}'),
               hoy_isp()) r
     ORDER BY r.posicion
     LIMIT 1;

    IF FOUND AND NOT (a.tipo = p_tipo AND a.id = p_id) THEN
        RAISE EXCEPTION 'Tu trabajo actual es %#% (%). Terminalo o marcá "No se pudo atender" antes de empezar otro.',
            CASE a.tipo WHEN 'ticket' THEN 'el ticket ' ELSE 'la instalación ' END, a.numero, a.nombre
            USING ERRCODE = '42501';
    END IF;
END;
$$;

-- Los disparadores de la 212, con el bloqueo delante del ingreso.
CREATE OR REPLACE FUNCTION controlar_inicio_ticket()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado IN ('en_ruta', 'en_proceso') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        PERFORM exigir_trabajo_actual('ticket', NEW.id);
    END IF;
    -- Solo la llegada marca el ingreso. "En ruta" es manejar.
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
    IF NEW.estado IN ('en_ruta', 'en_curso') AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        PERFORM exigir_trabajo_actual('instalacion', NEW.id);
    END IF;
    IF NEW.estado = 'en_curso' AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        PERFORM ingreso_automatico(NEW.llegada_at, NEW.llegada_lat, NEW.llegada_lng);
    END IF;
    RETURN NEW;
END;
$$;


-- =============================================================================
-- 4. Quién ordena, y el orden
-- =============================================================================
/** ¿Quien pregunta ordena rutas como oficina? Administración, jefe técnico o el permiso. */
CREATE OR REPLACE FUNCTION ordena_rutas()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT dirige_cuadrillas() OR EXISTS (
        SELECT 1 FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo
           AND (permisos ? '*' OR permisos ? 'soporte.ruta')
    )
$$;

GRANT EXECUTE ON FUNCTION ordena_rutas() TO authenticated;

CREATE TABLE IF NOT EXISTS ruta_cambios (
    id         BIGSERIAL PRIMARY KEY,
    fecha      DATE NOT NULL,
    usuario_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    motivo     TEXT,
    items      JSONB NOT NULL,
    creado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ruta_cambios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ruta_cambios_leer ON ruta_cambios;
CREATE POLICY ruta_cambios_leer ON ruta_cambios
    FOR SELECT TO authenticated USING (ordena_rutas());

/**
 * Fija el orden de hoy. `p_items` = [{"tipo":"ticket","id":"…"}, …] en el orden
 * en que se hacen.
 *
 * La oficina ordena cualquier ruta. El jefe de grupo del día, solo trabajos de
 * su cuadrilla o suyos, y diciendo por qué: queda registrado.
 */
CREATE OR REPLACE FUNCTION ordenar_ruta(p_items JSONB, p_motivo TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_oficina BOOLEAN := ordena_rutas();
    v_tec     UUID := mi_tecnico_id();
    v_fecha   DATE := hoy_isp();
    v_mis     UUID[];
    it        RECORD;
    u         RECORD;
BEGIN
    IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'No hay trabajos que ordenar.';
    END IF;

    IF NOT v_oficina THEN
        -- Las cuadrillas que dirige hoy.
        SELECT array_agg(m.cuadrilla_id) INTO v_mis
          FROM cuadrilla_miembros m
         WHERE m.tecnico_id = v_tec AND jefe_de_grupo(m.cuadrilla_id, v_fecha) = v_tec;
        IF v_mis IS NULL THEN
            RAISE EXCEPTION 'La ruta la ordena la oficina o el jefe de grupo del día.' USING ERRCODE = '42501';
        END IF;
        IF NULLIF(BTRIM(p_motivo), '') IS NULL THEN
            RAISE EXCEPTION 'Contá por qué cambiás el orden: queda registrado.';
        END IF;
    END IF;

    FOR it IN
        SELECT e->>'tipo' AS tipo, (e->>'id')::uuid AS id, ord::int AS orden
          FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(e, ord)
    LOOP
        IF it.tipo = 'ticket' THEN
            UPDATE tickets SET ruta_fecha = v_fecha, ruta_orden = it.orden
             WHERE id = it.id
               AND (v_oficina OR tecnico_id = v_tec OR cuadrilla_id = ANY(v_mis));
        ELSIF it.tipo = 'instalacion' THEN
            UPDATE instalaciones SET ruta_fecha = v_fecha, ruta_orden = it.orden
             WHERE id = it.id
               AND (v_oficina OR tecnico_id = v_tec OR cuadrilla_id = ANY(v_mis));
        END IF;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Uno de los trabajos no es de tu cuadrilla.' USING ERRCODE = '42501';
        END IF;
    END LOOP;

    INSERT INTO ruta_cambios (fecha, usuario_id, motivo, items)
    VALUES (v_fecha, mi_usuario_id(), NULLIF(BTRIM(p_motivo), ''), p_items);

    -- Si lo cambió el jefe de grupo, la oficina se entera.
    IF NOT v_oficina THEN
        FOR u IN SELECT id FROM usuarios_sistema
                  WHERE activo AND rol IN ('super_admin', 'admin', 'jefe_tecnico')
        LOOP
            PERFORM notificar(u.id, 'ruta_cambiada',
                (SELECT nombre FROM tecnicos WHERE id = v_tec) || ' cambió el orden de la ruta',
                LEFT(BTRIM(p_motivo), 200), '/soporte/rutas', 'ruta', v_fecha::text || ':' || v_tec::text);
        END LOOP;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION ordenar_ruta(JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ordenar_ruta(JSONB, TEXT) TO authenticated;


-- =============================================================================
-- 5. Las llamadas al cliente
-- =============================================================================
CREATE TABLE IF NOT EXISTS campo_llamadas (
    id         BIGSERIAL PRIMARY KEY,
    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    usuario_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    item_tipo  VARCHAR(12) NOT NULL CHECK (item_tipo IN ('ticket', 'instalacion')),
    item_id    UUID NOT NULL,
    canal      VARCHAR(10) NOT NULL DEFAULT 'llamada' CHECK (canal IN ('llamada', 'whatsapp')),
    creado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campo_llamadas_item ON campo_llamadas (item_tipo, item_id, creado_at DESC);

ALTER TABLE campo_llamadas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campo_llamadas_leer ON campo_llamadas;
CREATE POLICY campo_llamadas_leer ON campo_llamadas
    FOR SELECT TO authenticated
    USING (tecnico_id = mi_tecnico_id() OR ordena_rutas());

/** El técnico tocó "Llamar" o "WhatsApp" en un trabajo: queda constancia. */
CREATE OR REPLACE FUNCTION registrar_llamada(p_tipo TEXT, p_id UUID, p_canal TEXT DEFAULT 'llamada')
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO campo_llamadas (tecnico_id, usuario_id, item_tipo, item_id, canal)
    VALUES (mi_tecnico_id(), mi_usuario_id(), p_tipo, p_id,
            CASE WHEN p_canal = 'whatsapp' THEN 'whatsapp' ELSE 'llamada' END)
$$;

REVOKE ALL ON FUNCTION registrar_llamada(TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_llamada(TEXT, UUID, TEXT) TO authenticated;


-- =============================================================================
-- 6. No se pudo atender
-- =============================================================================
CREATE TABLE IF NOT EXISTS visitas_fallidas (
    id         BIGSERIAL PRIMARY KEY,
    ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    usuario_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    motivo     VARCHAR(20) NOT NULL
               CHECK (motivo IN ('no_contesta', 'sin_nadie', 'no_permite', 'direccion_erronea',
                                 'falta_material', 'clima', 'otro')),
    detalle    TEXT,
    foto       TEXT NOT NULL,
    lat        NUMERIC(10,7),
    lng        NUMERIC(10,7),
    llegada_at TIMESTAMPTZ,
    creado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visitas_fallidas_ticket ON visitas_fallidas (ticket_id, creado_at DESC);

ALTER TABLE visitas_fallidas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visitas_fallidas_leer ON visitas_fallidas;
CREATE POLICY visitas_fallidas_leer ON visitas_fallidas
    FOR SELECT TO authenticated
    USING (ordena_rutas() OR cartera_completa() OR tecnico_id = mi_tecnico_id()
           OR ticket_id IN (SELECT id FROM tickets));

/**
 * El ticket que no se pudo hacer.
 *
 * Exige estar en el sitio (la llegada marcada), la foto de la fachada y, para
 * "no contesta" o "no hay nadie", haberlo llamado desde la app y esperar 10
 * minutos desde la llegada. Devuelve el ticket a la oficina para reprogramar:
 * sin fecha de visita y fuera de la ruta, así que el siguiente se desbloquea.
 */
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
    IF NULLIF(BTRIM(p_foto), '') IS NULL THEN
        RAISE EXCEPTION 'Falta la foto de la fachada: es la prueba de que estuviste ahí.';
    END IF;
    IF p_motivo NOT IN ('no_contesta', 'sin_nadie', 'no_permite', 'direccion_erronea', 'falta_material', 'clima', 'otro') THEN
        RAISE EXCEPTION 'Motivo desconocido: %', p_motivo;
    END IF;
    IF p_motivo = 'otro' AND NULLIF(BTRIM(p_detalle), '') IS NULL THEN
        RAISE EXCEPTION 'Contá qué pasó.';
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
    VALUES (p_ticket, v_tec, mi_usuario_id(), p_motivo, NULLIF(BTRIM(p_detalle), ''), p_foto,
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
        ELSE 'Otro' END;

    FOR u IN SELECT id FROM usuarios_sistema
              WHERE activo AND rol IN ('super_admin', 'admin', 'jefe_tecnico')
    LOOP
        PERFORM notificar(u.id, 'visita_fallida',
            format('No se pudo atender el ticket #%s · %s', t.numero, t.nombre),
            v_txt || COALESCE(': ' || NULLIF(BTRIM(p_detalle), ''), '') || '. Hay que reprogramarlo.',
            '/soporte/rutas', 'ticket', p_ticket::text);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION no_se_pudo_atender(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION no_se_pudo_atender(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC) TO authenticated;


-- =============================================================================
-- 7. Lo que leen las pantallas
-- =============================================================================
/** La ruta de hoy de quien pregunta (app de campo). */
CREATE OR REPLACE FUNCTION mi_ruta_hoy()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH r AS (
        SELECT * FROM items_de_ruta(
            ARRAY[mi_tecnico_id()],
            COALESCE((SELECT array_agg(cuadrilla_id) FROM cuadrilla_miembros WHERE tecnico_id = mi_tecnico_id()), '{}'),
            hoy_isp())
    )
    SELECT jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.posicion) FROM r), '[]'::jsonb),
        -- Puede reordenar: la oficina, o el jefe de grupo de hoy.
        'puede_ordenar', ordena_rutas() OR EXISTS (
            SELECT 1 FROM cuadrilla_miembros m
             WHERE m.tecnico_id = mi_tecnico_id()
               AND jefe_de_grupo(m.cuadrilla_id, hoy_isp()) = mi_tecnico_id()),
        'es_oficina', ordena_rutas()
    )
$$;

GRANT EXECUTE ON FUNCTION mi_ruta_hoy() TO authenticated;

/**
 * Todas las rutas del día, para la oficina: una por cuadrilla y una por cada
 * técnico suelto, con lo pendiente en orden, lo hecho hoy y lo que no se pudo.
 */
CREATE OR REPLACE FUNCTION rutas_del_dia(p_fecha DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fecha DATE := COALESCE(p_fecha, hoy_isp());
    v_salida JSONB := '[]'::jsonb;
    g RECORD;
    v_tecs UUID[];
    v_cuads UUID[];
BEGIN
    IF NOT ordena_rutas() THEN
        RAISE EXCEPTION 'Solo la oficina ve las rutas de todos.' USING ERRCODE = '42501';
    END IF;

    FOR g IN
        SELECT 'cuadrilla' AS clase, cu.id, cu.nombre::text AS nombre,
               (SELECT nombre FROM tecnicos WHERE id = jefe_de_grupo(cu.id, v_fecha)) AS jefe
          FROM cuadrillas cu WHERE cu.activo
        UNION ALL
        SELECT 'tecnico', t.id, t.nombre::text, NULL
          FROM tecnicos t
         WHERE t.activo AND NOT EXISTS (SELECT 1 FROM cuadrilla_miembros m WHERE m.tecnico_id = t.id)
        ORDER BY 1, 3
    LOOP
        IF g.clase = 'cuadrilla' THEN
            v_cuads := ARRAY[g.id];
            v_tecs := COALESCE((SELECT array_agg(tecnico_id) FROM cuadrilla_miembros WHERE cuadrilla_id = g.id), '{}');
        ELSE
            v_cuads := '{}';
            v_tecs := ARRAY[g.id];
        END IF;

        v_salida := v_salida || jsonb_build_array(jsonb_build_object(
            'clase', g.clase, 'id', g.id, 'nombre', g.nombre, 'jefe', g.jefe,
            'pendientes', COALESCE((
                SELECT jsonb_agg(to_jsonb(r) ORDER BY r.posicion)
                  FROM items_de_ruta(v_tecs, v_cuads, v_fecha) r), '[]'::jsonb),
            'hechos', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'tipo', 'ticket', 'id', t.id, 'numero', t.numero, 'nombre', t.nombre,
                    'salida_at', t.salida_at, 'llegada_at', t.llegada_at, 'cerrado_at', t.cerrado_at,
                    'minutos_en_sitio', (EXTRACT(EPOCH FROM (t.cerrado_at - t.llegada_at)) / 60)::int,
                    'minutos_de_viaje', (EXTRACT(EPOCH FROM (t.llegada_at - t.salida_at)) / 60)::int)
                    ORDER BY t.cerrado_at)
                  FROM tickets t
                 WHERE t.estado = 'resuelto'
                   AND (t.cerrado_at AT TIME ZONE zona_horaria())::date = v_fecha
                   AND (t.tecnico_id = ANY(v_tecs) OR t.cuadrilla_id = ANY(v_cuads))), '[]'::jsonb),
            'no_se_pudo', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'ticket_id', f.ticket_id, 'numero', t.numero, 'nombre', t.nombre,
                    'motivo', f.motivo, 'detalle', f.detalle, 'foto', f.foto,
                    'creado_at', f.creado_at, 'llegada_at', f.llegada_at)
                    ORDER BY f.creado_at)
                  FROM visitas_fallidas f
                  JOIN tickets t ON t.id = f.ticket_id
                 WHERE (f.creado_at AT TIME ZONE zona_horaria())::date = v_fecha
                   AND (f.tecnico_id = ANY(v_tecs) OR t.cuadrilla_id = ANY(v_cuads))), '[]'::jsonb)
        ));
    END LOOP;

    -- Solo las rutas con algo: una cuadrilla sin trabajo hoy no aporta nada.
    RETURN COALESCE((
        SELECT jsonb_agg(e) FROM jsonb_array_elements(v_salida) e
         WHERE jsonb_array_length(e->'pendientes') + jsonb_array_length(e->'hechos')
             + jsonb_array_length(e->'no_se_pudo') > 0), '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION rutas_del_dia(DATE) TO authenticated;

/** Los tickets que esperan una nueva fecha, con su último "no se pudo". */
CREATE OR REPLACE VIEW v_tickets_por_reprogramar WITH (security_invoker = true) AS
SELECT t.id, t.numero, t.nombre, t.direccion, t.telefono, t.prioridad, t.reprogramar_desde,
       t.tecnico_id, t.cuadrilla_id, cu.nombre AS cuadrilla, te.nombre AS tecnico,
       f.motivo, f.detalle, f.foto, f.creado_at AS fallida_at
  FROM tickets t
  LEFT JOIN cuadrillas cu ON cu.id = t.cuadrilla_id
  LEFT JOIN tecnicos te   ON te.id = t.tecnico_id
  LEFT JOIN LATERAL (
      SELECT * FROM visitas_fallidas v WHERE v.ticket_id = t.id ORDER BY v.creado_at DESC LIMIT 1
  ) f ON TRUE
 WHERE t.reprogramar_desde IS NOT NULL
   AND t.estado NOT IN ('resuelto', 'cancelado');

GRANT SELECT ON v_tickets_por_reprogramar TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT rutas_del_dia();
--   SELECT numero, nombre, motivo FROM v_tickets_por_reprogramar;
