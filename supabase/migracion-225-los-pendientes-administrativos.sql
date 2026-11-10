-- =============================================================================
-- Migración 225 — Los pendientes administrativos
-- =============================================================================
-- La gente se creaba tickets a sí misma para acordarse de cosas que no son
-- soporte: "cambiar a $23.10", "reconexión mañana 8:30", hacer firmar un
-- contrato, pedir la copia de la cédula. Como tickets, entraban en la ruta del
-- técnico, contaban en el plazo de atención, sonaban en Telegram como vencidos
-- y bajaban el % en plazo de una cuadrilla que no tenía nada que hacer ahí.
--
-- Los pendientes son otra cosa: una tarea para una persona, sobre un abonado,
-- con fecha si hace falta. No tienen ruta, ni plazo, ni técnico obligatorio.
--
-- ── Sin ficha del sistema también ──
--
-- Casi todos los abonados siguen en MikroWISP: el pendiente se puede atar a una
-- ficha (`client_id`) o llevar el nombre, la cédula y el teléfono a mano, igual
-- que un ticket.
--
-- ── Quién ve qué ──
--
-- Cualquiera con sesión ve los pendientes que no son privados: el técnico que
-- va a la casa tiene que enterarse de que falta la firma aunque la haya pedido
-- la oficina. Los privados, solo quien lo creó y a quien se lo asignaron.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pendientes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    numero         BIGSERIAL,
    client_id      UUID REFERENCES clientes(id) ON DELETE SET NULL,
    nombre         TEXT NOT NULL,
    identificacion TEXT,
    telefono       TEXT,
    tipo           TEXT NOT NULL DEFAULT 'otro'
                   CHECK (tipo IN ('cambio_plan', 'firma_contrato', 'copia_cedula', 'cobro',
                                   'cambio_datos', 'reconexion', 'otro')),
    detalle        TEXT,
    asignado_a     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    privado        BOOLEAN NOT NULL DEFAULT FALSE,
    vence_el       DATE,
    hecho_at       TIMESTAMPTZ,
    hecho_por      UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    nota_cierre    TEXT,
    -- Si nació de un ticket que en realidad era administrativo.
    ticket_origen  UUID REFERENCES tickets(id) ON DELETE SET NULL,
    creado_por     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL DEFAULT mi_usuario_id(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pendientes_abiertos ON pendientes (asignado_a, vence_el) WHERE hecho_at IS NULL;
CREATE INDEX IF NOT EXISTS pendientes_cliente ON pendientes (client_id) WHERE hecho_at IS NULL;

COMMENT ON TABLE pendientes IS
    'Tareas administrativas sobre un abonado (cambio de plan, firma, copia de cédula…). No son tickets: no tienen ruta, plazo ni técnico obligatorio.';


/** ¿Puede administrar cualquier pendiente? Administración. */
CREATE OR REPLACE FUNCTION administra_pendientes()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT rol IN ('super_admin', 'admin') OR permisos ? '*'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        FALSE
    )
$$;

GRANT EXECUTE ON FUNCTION administra_pendientes() TO authenticated;


ALTER TABLE pendientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pendientes_ver ON pendientes;
CREATE POLICY pendientes_ver ON pendientes
    FOR SELECT TO authenticated
    USING (
        mi_usuario_id() IS NOT NULL
        AND (NOT privado OR creado_por = mi_usuario_id() OR asignado_a = mi_usuario_id()
             OR administra_pendientes())
    );

-- Cualquiera del equipo crea pendientes, a nombre propio.
DROP POLICY IF EXISTS pendientes_crear ON pendientes;
CREATE POLICY pendientes_crear ON pendientes
    FOR INSERT TO authenticated
    WITH CHECK (mi_usuario_id() IS NOT NULL AND creado_por = mi_usuario_id());

-- Lo cambia (y lo marca hecho) quien lo creó, a quien le toca, o un pendiente
-- público cualquiera del equipo: el técnico que consiguió la firma en la casa
-- lo tiene que poder tildar aunque no fuera suyo.
DROP POLICY IF EXISTS pendientes_cambiar ON pendientes;
CREATE POLICY pendientes_cambiar ON pendientes
    FOR UPDATE TO authenticated
    USING (
        mi_usuario_id() IS NOT NULL
        AND (NOT privado OR creado_por = mi_usuario_id() OR asignado_a = mi_usuario_id()
             OR administra_pendientes())
    );

DROP POLICY IF EXISTS pendientes_borrar ON pendientes;
CREATE POLICY pendientes_borrar ON pendientes
    FOR DELETE TO authenticated
    USING (creado_por = mi_usuario_id() OR administra_pendientes());

GRANT SELECT, INSERT, UPDATE, DELETE ON pendientes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE pendientes_numero_seq TO authenticated;


-- =============================================================================
-- Quién lo cerró, puesto por la base
-- =============================================================================
-- Al marcarlo hecho se anota quién y cuándo; al desmarcarlo se borra. Lo hace
-- la base y no la pantalla, para que el registro no dependa de quién escribió
-- el botón.
CREATE OR REPLACE FUNCTION pendiente_sella_cierre()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.hecho_at IS NOT NULL AND OLD.hecho_at IS NULL THEN
        NEW.hecho_por := COALESCE(mi_usuario_id(), NEW.hecho_por);
    ELSIF NEW.hecho_at IS NULL THEN
        NEW.hecho_por := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pendiente_cierre ON pendientes;
CREATE TRIGGER trg_pendiente_cierre
    BEFORE UPDATE OF hecho_at ON pendientes
    FOR EACH ROW EXECUTE FUNCTION pendiente_sella_cierre();


-- =============================================================================
-- A quien se lo asignan se entera
-- =============================================================================
CREATE OR REPLACE FUNCTION pendiente_avisa_asignado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_quien TEXT;
BEGIN
    IF NEW.asignado_a IS NULL OR NEW.hecho_at IS NOT NULL THEN RETURN NEW; END IF;
    -- A uno mismo no se le avisa: lo acaba de escribir.
    IF NEW.asignado_a IS NOT DISTINCT FROM mi_usuario_id() THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND NEW.asignado_a IS NOT DISTINCT FROM OLD.asignado_a THEN RETURN NEW; END IF;

    SELECT TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) INTO v_quien
      FROM usuarios_sistema WHERE id = mi_usuario_id();

    PERFORM notificar(
        NEW.asignado_a, 'pendiente_asignado',
        COALESCE(NULLIF(v_quien, ''), 'Alguien') || ' te dejó un pendiente: ' || NEW.nombre,
        LEFT(COALESCE(NEW.detalle, ''), 200), '/pendientes', 'pendiente', NEW.id::TEXT);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pendiente_aviso ON pendientes;
CREATE TRIGGER trg_pendiente_aviso
    AFTER INSERT OR UPDATE OF asignado_a ON pendientes
    FOR EACH ROW EXECUTE FUNCTION pendiente_avisa_asignado();


-- =============================================================================
-- Un ticket que no era soporte, pasado a pendiente
-- =============================================================================
/**
 * Crea el pendiente con los datos del abonado del ticket y cancela el ticket,
 * dejando escrito por qué. Así sale de la ruta, del plazo y del desempeño.
 *
 * Lo puede hacer quien crea o asigna tickets.
 */
CREATE OR REPLACE FUNCTION pasar_ticket_a_pendiente(
    p_ticket     UUID,
    p_tipo       TEXT DEFAULT 'otro',
    p_detalle    TEXT DEFAULT NULL,
    p_asignado_a UUID DEFAULT NULL,
    p_vence_el   DATE DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    t     tickets%ROWTYPE;
    v_id  UUID;
    v_num BIGINT;
    v_yo  UUID := mi_usuario_id();
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo
           AND (rol IN ('super_admin', 'admin') OR permisos ? '*'
                OR permisos ? 'soporte.crear' OR permisos ? 'soporte.asignar')
    ) THEN
        RAISE EXCEPTION 'Pasar un ticket a pendiente lo hace quien crea o asigna tickets.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO t FROM tickets WHERE id = p_ticket FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese ticket.'; END IF;
    IF t.estado IN ('resuelto', 'cancelado') THEN
        RAISE EXCEPTION 'El ticket ya está cerrado.';
    END IF;
    IF t.estado IN ('en_ruta', 'en_proceso') THEN
        RAISE EXCEPTION 'El técnico ya está yendo o en el lugar: cerralo desde el ticket.';
    END IF;

    INSERT INTO pendientes (client_id, nombre, identificacion, telefono, tipo, detalle,
                            asignado_a, vence_el, ticket_origen, creado_por)
    VALUES (t.client_id, COALESCE(NULLIF(BTRIM(t.nombre), ''), 'Sin nombre'), t.identificacion,
            COALESCE(t.telefono_whatsapp, t.telefono), COALESCE(p_tipo, 'otro'),
            COALESCE(NULLIF(BTRIM(p_detalle), ''), t.incidencia_otro, t.descripcion),
            COALESCE(p_asignado_a, v_yo), COALESCE(p_vence_el, t.fecha_visita), t.id, v_yo)
    RETURNING id, numero INTO v_id, v_num;

    UPDATE tickets SET estado = 'cancelado' WHERE id = p_ticket;

    -- El motivo, en el evento que acaba de registrar la base. Se escribe sobre
    -- ese evento y no en uno nuevo: un evento nuevo con nota se le manda al
    -- abonado como respuesta, y esto es interno.
    UPDATE ticket_eventos
       SET nota = 'No era soporte: pasado a Pendientes (N° ' || v_num || ').'
     WHERE id = (SELECT id FROM ticket_eventos WHERE ticket_id = p_ticket
                  ORDER BY created_at DESC LIMIT 1);

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION pasar_ticket_a_pendiente(UUID, TEXT, TEXT, UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pasar_ticket_a_pendiente(UUID, TEXT, TEXT, UUID, DATE) TO authenticated;
