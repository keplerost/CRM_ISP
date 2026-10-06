-- =============================================================================
-- Migración 208 — Un solo técnico, y el jefe de grupo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- 1. EL TÉCNICO SE CARGABA DOS VECES. Una en Ajustes → Personal (el usuario
--    con contraseña) y otra en Soporte → Técnicos (a quién se le asigna). Si
--    nadie las enlazaba a mano, el técnico entraba y no veía ningún ticket.
--    Ahora el usuario con rol técnico o jefe técnico crea y mantiene su ficha
--    de Soporte solo: nombre, correo, celular y activo.
--
-- 2. LOS TICKETS DE CUADRILLA NO LOS VEÍA NADIE DE LA CUADRILLA. El técnico
--    solo veía los asignados a su nombre. Ahora ve también los de las
--    cuadrillas que integra.
--
-- 3. EL JEFE DE GRUPO. Cada cuadrilla tiene un líder (`cuadrilla_miembros.rol
--    = 'lider'`, que existía y no se usaba). Él carga el vehículo y los km de la
--    cuadrilla; los demás marcan su ingreso (foto y ubicación) para la
--    asistencia, sin vehículo ni km. Así una camioneta con tres técnicos no
--    suma el recorrido tres veces.
--
-- 4. EL REEMPLAZO DEL DÍA. Si el jefe de grupo falta, un administrador o un
--    jefe técnico designa a otro integrante SOLO PARA ESA FECHA. Al día
--    siguiente vuelve el titular sin que nadie toque nada.
--
-- Una cuadrilla sin jefe de grupo definido sigue como antes: cualquiera de sus
-- integrantes carga vehículo y km. Nadie queda bloqueado por no haberlo
-- configurado todavía.
-- =============================================================================


-- =============================================================================
-- 1. La ficha de Soporte sale del usuario
-- =============================================================================
CREATE OR REPLACE FUNCTION sincronizar_ficha_tecnico()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_nombre TEXT := NULLIF(BTRIM(CONCAT_WS(' ', NEW.nombre, NEW.apellido)), '');
BEGIN
    IF NEW.rol NOT IN ('tecnico', 'jefe_tecnico') THEN
        RETURN NEW;
    END IF;

    IF NEW.tecnico_id IS NULL THEN
        INSERT INTO tecnicos (nombre, email, telefono, user_id, activo)
        VALUES (COALESCE(v_nombre, NEW.usuario, 'Técnico'), NEW.email, NEW.celular, NEW.auth_id, NEW.activo)
        RETURNING id INTO NEW.tecnico_id;
        RETURN NEW;
    END IF;

    -- Ya enlazado: lo que se cambia en Personal se refleja en Soporte. Solo lo
    -- que cambió, para no pisar lo que se cargó a mano en la ficha (cédula,
    -- especialidad) ni el nombre largo que tenía de antes.
    IF TG_OP = 'INSERT' THEN
        UPDATE tecnicos SET user_id = COALESCE(user_id, NEW.auth_id) WHERE id = NEW.tecnico_id;
    ELSE
        UPDATE tecnicos t
           SET nombre   = CASE WHEN (NEW.nombre, NEW.apellido) IS DISTINCT FROM (OLD.nombre, OLD.apellido)
                                AND v_nombre IS NOT NULL THEN v_nombre ELSE t.nombre END,
               email    = CASE WHEN NEW.email   IS DISTINCT FROM OLD.email   THEN NEW.email   ELSE t.email END,
               telefono = CASE WHEN NEW.celular IS DISTINCT FROM OLD.celular THEN NEW.celular ELSE t.telefono END,
               activo   = CASE WHEN NEW.activo  IS DISTINCT FROM OLD.activo  THEN NEW.activo  ELSE t.activo END,
               user_id  = COALESCE(NEW.auth_id, t.user_id)
         WHERE t.id = NEW.tecnico_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ficha_tecnico ON usuarios_sistema;
CREATE TRIGGER trg_ficha_tecnico
    BEFORE INSERT OR UPDATE OF rol, nombre, apellido, email, celular, activo, auth_id, tecnico_id
    ON usuarios_sistema
    FOR EACH ROW EXECUTE FUNCTION sincronizar_ficha_tecnico();

-- Los que ya existen sin enlazar reciben su ficha ahora. (El UPDATE dispara el
-- trigger, que es quien la crea.)
UPDATE usuarios_sistema
   SET rol = rol
 WHERE rol IN ('tecnico', 'jefe_tecnico') AND tecnico_id IS NULL;

-- Y los que ya estaban enlazados a mano, con su usuario anotado en la ficha.
UPDATE tecnicos t
   SET user_id = u.auth_id
  FROM usuarios_sistema u
 WHERE u.tecnico_id = t.id AND t.user_id IS NULL AND u.auth_id IS NOT NULL;


-- =============================================================================
-- 2. Las cuadrillas de quien pregunta, y los tickets de su cuadrilla
-- =============================================================================
CREATE OR REPLACE FUNCTION mis_cuadrillas()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT cuadrilla_id FROM cuadrilla_miembros WHERE tecnico_id = mi_tecnico_id()
$$;

GRANT EXECUTE ON FUNCTION mis_cuadrillas() TO authenticated;

DROP POLICY IF EXISTS tickets_acceso ON tickets;
CREATE POLICY tickets_acceso ON tickets
    FOR ALL TO authenticated
    USING (
        cartera_completa()
        OR (tecnico_id IS NOT NULL AND tecnico_id = mi_tecnico_id())
        OR (cuadrilla_id IS NOT NULL AND cuadrilla_id IN (SELECT mis_cuadrillas()))
        OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles())
    )
    WITH CHECK (
        cartera_completa()
        OR (tecnico_id IS NOT NULL AND tecnico_id = mi_tecnico_id())
        OR (cuadrilla_id IS NOT NULL AND cuadrilla_id IN (SELECT mis_cuadrillas()))
    );


-- =============================================================================
-- 3. El jefe de grupo y su reemplazo del día
-- =============================================================================
-- Un solo líder por cuadrilla. Si hoy hubiera dos, se deja el índice sin crear
-- y se avisa: elegir cuál queda no es una decisión de una migración.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cuadrilla_miembros WHERE rol = 'lider'
                GROUP BY cuadrilla_id HAVING COUNT(*) > 1) THEN
        RAISE NOTICE 'Hay cuadrillas con más de un líder: corregilo en Soporte → Técnicos y volvé a correr esta migración.';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cuadrilla_un_lider
            ON cuadrilla_miembros (cuadrilla_id) WHERE rol = 'lider';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS cuadrilla_reemplazos (
    cuadrilla_id  UUID NOT NULL REFERENCES cuadrillas(id) ON DELETE CASCADE,
    fecha         DATE NOT NULL,
    tecnico_id    UUID NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
    designado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cuadrilla_id, fecha)
);

COMMENT ON TABLE cuadrilla_reemplazos IS
    'Quién hace de jefe de grupo un día puntual. Vale solo para esa fecha: al día siguiente vuelve el titular.';

/** Quién puede designar un reemplazo: administración y jefes técnicos. */
CREATE OR REPLACE FUNCTION dirige_cuadrillas()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo
           AND rol IN ('super_admin', 'admin', 'jefe_tecnico')
    )
$$;

GRANT EXECUTE ON FUNCTION dirige_cuadrillas() TO authenticated;

ALTER TABLE cuadrilla_reemplazos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reemplazos_leer ON cuadrilla_reemplazos;
CREATE POLICY reemplazos_leer ON cuadrilla_reemplazos
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS reemplazos_escribir ON cuadrilla_reemplazos;
CREATE POLICY reemplazos_escribir ON cuadrilla_reemplazos
    FOR ALL TO authenticated USING (dirige_cuadrillas()) WITH CHECK (dirige_cuadrillas());

/**
 * El jefe de grupo de una cuadrilla en una fecha: el reemplazo de ese día si
 * lo hay, si no el líder. NULL si la cuadrilla no tiene ninguno definido.
 */
CREATE OR REPLACE FUNCTION jefe_de_grupo(p_cuadrilla UUID, p_fecha DATE)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT tecnico_id FROM cuadrilla_reemplazos WHERE cuadrilla_id = p_cuadrilla AND fecha = p_fecha),
        (SELECT tecnico_id FROM cuadrilla_miembros WHERE cuadrilla_id = p_cuadrilla AND rol = 'lider' LIMIT 1)
    )
$$;

GRANT EXECUTE ON FUNCTION jefe_de_grupo(UUID, DATE) TO authenticated;


-- =============================================================================
-- 4. La jornada: vehículo y km solo los carga el jefe de grupo
-- =============================================================================
ALTER TABLE jornadas
    ADD COLUMN IF NOT EXISTS cuadrilla_id UUID REFERENCES cuadrillas(id) ON DELETE SET NULL;

/**
 * ¿Este técnico puede cargar vehículo y km este día?
 *
 * Sí si no integra ninguna cuadrilla (trabaja suelto), si alguna de sus
 * cuadrillas no tiene jefe definido, o si es el jefe de grupo de alguna.
 */
CREATE OR REPLACE FUNCTION puede_cargar_km(p_tecnico UUID, p_fecha DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NOT EXISTS (SELECT 1 FROM cuadrilla_miembros WHERE tecnico_id = p_tecnico)
        OR EXISTS (
            SELECT 1 FROM cuadrilla_miembros m
             WHERE m.tecnico_id = p_tecnico
               AND (jefe_de_grupo(m.cuadrilla_id, p_fecha) IS NULL
                    OR jefe_de_grupo(m.cuadrilla_id, p_fecha) = p_tecnico)
        )
$$;

CREATE OR REPLACE FUNCTION controlar_km_jornada()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_jefe TEXT;
BEGIN
    -- La cuadrilla con la que salió, para los reportes. La primera que integra.
    IF NEW.cuadrilla_id IS NULL THEN
        SELECT cuadrilla_id INTO NEW.cuadrilla_id
          FROM cuadrilla_miembros WHERE tecnico_id = NEW.tecnico_id
         ORDER BY (rol = 'lider') DESC LIMIT 1;
    END IF;

    IF (NEW.vehiculo_id IS NOT NULL OR NEW.km_inicio IS NOT NULL OR NEW.km_fin IS NOT NULL)
       AND (TG_OP = 'INSERT'
            OR NEW.vehiculo_id IS DISTINCT FROM OLD.vehiculo_id
            OR NEW.km_inicio  IS DISTINCT FROM OLD.km_inicio
            OR NEW.km_fin     IS DISTINCT FROM OLD.km_fin)
       AND NOT puede_cargar_km(NEW.tecnico_id, NEW.fecha) THEN
        SELECT t.nombre INTO v_jefe FROM tecnicos t
         WHERE t.id = jefe_de_grupo(NEW.cuadrilla_id, NEW.fecha);
        RAISE EXCEPTION 'El vehículo y los kilómetros los registra el jefe de grupo%.',
            COALESCE(' (' || v_jefe || ')', '')
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_km_jornada ON jornadas;
CREATE TRIGGER trg_km_jornada
    BEFORE INSERT OR UPDATE ON jornadas
    FOR EACH ROW EXECUTE FUNCTION controlar_km_jornada();

/**
 * Lo que la pantalla de Jornada necesita saber de la cuadrilla de hoy.
 *
 * Va por función porque el jefe de grupo tiene que ver si sus compañeros ya
 * marcaron, y las jornadas de los demás no las puede leer directo.
 */
CREATE OR REPLACE FUNCTION mi_cuadrilla_hoy(p_fecha DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH c AS (
        SELECT m.cuadrilla_id, cu.nombre, jefe_de_grupo(m.cuadrilla_id, p_fecha) AS jefe
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
--   -- Todos los técnicos con usuario, enlazados:
--   SELECT nombre, rol, tecnico_id IS NOT NULL AS enlazado
--     FROM usuarios_sistema WHERE rol IN ('tecnico', 'jefe_tecnico');
--
--   -- El jefe de grupo de hoy de cada cuadrilla:
--   SELECT nombre, jefe_de_grupo(id, CURRENT_DATE) FROM cuadrillas;
