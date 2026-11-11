-- =============================================================================
-- Migración 238 — Los proyectos: diseñar, presupuestar y construir
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 232 (obras), la 234 (planta externa) y la 237 (hilos).
--
-- ── Qué resuelve ──
--
-- Una expansión se diseñaba en Google Earth, el material se contaba a mano en
-- una hoja, y la obra se cargaba aparte: tres lugares que se contradecían a la
-- semana. Y lo que se terminaba construyendo nunca volvía al plano.
--
-- Ahora el ciclo entero vive acá:
--
--   1. DISEÑO. Un proyecto agrupa lo que se dibuja (cajas, postes, cables,
--      splitters, fusiones) como "proyectado": no toca la red real. La lista
--      de materiales y el presupuesto óptico salen solos.
--   2. OBRA. `proyecto_a_obra` crea la obra para la cuadrilla con el alcance
--      del diseño (metros, NAP, fusiones, mangas, postes, puertos) y el
--      material presupuestado.
--   3. AS-BUILT. Cuando la oficina aprueba la obra, el proyecto queda
--      construido y todo lo suyo pasa a red existente. Si la obra se cancela,
--      el proyecto vuelve a diseño.
-- =============================================================================


-- =============================================================================
-- 1. El proyecto
-- =============================================================================
CREATE TABLE IF NOT EXISTS planta_proyectos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre        VARCHAR(120) NOT NULL,
    descripcion   TEXT,
    zona          VARCHAR(150),
    estado        VARCHAR(12) NOT NULL DEFAULT 'diseno'
                  CHECK (estado IN ('diseno', 'en_obra', 'construido', 'cancelado')),
    -- Cuánto se suma a los metros de cable por reservas, curvas y bajadas.
    reserva_pct   NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (reserva_pct BETWEEN 0 AND 100),
    obra_id       UUID REFERENCES obras_red(id) ON DELETE SET NULL,
    creado_por    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    construido_at TIMESTAMPTZ,
    UNIQUE (nombre)
);

COMMENT ON TABLE planta_proyectos IS
    'Un diseño de red (expansión, troncal): lo dibujado como proyectado, su lista de materiales y la obra que lo construye.';

ALTER TABLE planta_elementos ADD COLUMN IF NOT EXISTS proyecto_id UUID REFERENCES planta_proyectos(id) ON DELETE SET NULL;
ALTER TABLE planta_cables    ADD COLUMN IF NOT EXISTS proyecto_id UUID REFERENCES planta_proyectos(id) ON DELETE SET NULL;
ALTER TABLE planta_splitters ADD COLUMN IF NOT EXISTS proyecto_id UUID REFERENCES planta_proyectos(id) ON DELETE SET NULL;
ALTER TABLE planta_uniones   ADD COLUMN IF NOT EXISTS proyecto_id UUID REFERENCES planta_proyectos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_planta_elementos_proy ON planta_elementos (proyecto_id) WHERE proyecto_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_planta_cables_proy ON planta_cables (proyecto_id) WHERE proyecto_id IS NOT NULL;

-- La vista se arma con `e.*`: se recrea para que tome la columna nueva.
DROP VIEW IF EXISTS v_planta_elementos;
CREATE VIEW v_planta_elementos WITH (security_invoker = true) AS
SELECT e.*,
       p.nombre AS caja,
       ab.abonados,
       CASE WHEN e.capacidad IS NULL THEN NULL ELSE GREATEST(0, e.capacidad - COALESCE(ab.abonados, 0)) END AS libres
  FROM planta_elementos e
  LEFT JOIN puntos_red p ON p.id = e.punto_id
  LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS abonados FROM clientes c WHERE c.nap_id = e.punto_id
  ) ab ON e.punto_id IS NOT NULL;

GRANT SELECT ON v_planta_elementos TO authenticated;

ALTER TABLE planta_proyectos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS planta_proyectos_leer ON planta_proyectos;
CREATE POLICY planta_proyectos_leer ON planta_proyectos FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_proyectos_editar ON planta_proyectos;
CREATE POLICY planta_proyectos_editar ON planta_proyectos FOR ALL TO authenticated
    USING (gestiona_planta()) WITH CHECK (gestiona_planta());
REVOKE ALL ON planta_proyectos FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON planta_proyectos TO authenticated;

CREATE OR REPLACE FUNCTION planta_proyecto_autor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.creado_por := COALESCE(NEW.creado_por, mi_usuario_id());
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_planta_proyecto_autor ON planta_proyectos;
CREATE TRIGGER trg_planta_proyecto_autor BEFORE INSERT ON planta_proyectos
    FOR EACH ROW EXECUTE FUNCTION planta_proyecto_autor();


-- =============================================================================
-- 2. Borrar un diseño
-- =============================================================================
/**
 * Borra el proyecto y TODO lo que se dibujó en él. Solo mientras es un diseño:
 * uno en obra o construido ya es red de verdad (o lo va a ser).
 */
CREATE OR REPLACE FUNCTION borrar_proyecto(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v planta_proyectos%ROWTYPE;
    v_e INT;
    v_c INT;
BEGIN
    IF NOT gestiona_planta() THEN
        RAISE EXCEPTION 'Sin permiso para editar la planta externa.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v FROM planta_proyectos WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese proyecto.'; END IF;
    IF v.estado NOT IN ('diseno', 'cancelado') THEN
        RAISE EXCEPTION 'El proyecto está en obra o construido: no se borra.';
    END IF;
    DELETE FROM planta_uniones   WHERE proyecto_id = p_id;
    DELETE FROM planta_splitters WHERE proyecto_id = p_id;
    DELETE FROM planta_cables    WHERE proyecto_id = p_id AND estado = 'proyectado';
    GET DIAGNOSTICS v_c = ROW_COUNT;
    DELETE FROM planta_elementos WHERE proyecto_id = p_id AND estado = 'proyectado';
    GET DIAGNOSTICS v_e = ROW_COUNT;
    DELETE FROM planta_proyectos WHERE id = p_id;
    RETURN jsonb_build_object('elementos', v_e, 'cables', v_c);
END;
$$;

REVOKE ALL ON FUNCTION borrar_proyecto(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION borrar_proyecto(UUID) TO authenticated;


-- =============================================================================
-- 3. Del diseño a la obra
-- =============================================================================
/**
 * Crea la obra que construye el proyecto. El alcance y el material los arma la
 * aplicación con la lista de materiales (`p_metas`, `p_materiales`); acá se
 * crea la obra con `guardar_obra` (232: avisa a la cuadrilla) y se le carga el
 * presupuesto de material.
 *
 * `p_materiales`: [{ descripcion, unidad, cantidad, articulo_id? }]
 */
CREATE OR REPLACE FUNCTION proyecto_a_obra(
    p_proyecto   UUID,
    p_cuadrilla  UUID,
    p_fecha_meta DATE,
    p_metas      JSONB,
    p_materiales JSONB DEFAULT '[]'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v      planta_proyectos%ROWTYPE;
    v_obra UUID;
    m      JSONB;
BEGIN
    IF NOT gestiona_planta() THEN
        RAISE EXCEPTION 'Sin permiso para editar la planta externa.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v FROM planta_proyectos WHERE id = p_proyecto FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese proyecto.'; END IF;
    IF v.estado <> 'diseno' THEN
        RAISE EXCEPTION 'El proyecto ya tiene obra o está construido.';
    END IF;
    IF p_cuadrilla IS NULL THEN
        RAISE EXCEPTION 'Elegí la cuadrilla que lo construye.';
    END IF;

    -- guardar_obra controla el permiso de obras y avisa a la cuadrilla.
    v_obra := guardar_obra(NULL, COALESCE(p_metas, '{}'::jsonb) || jsonb_build_object(
        'titulo', LEFT(v.nombre, 150),
        'tipo', 'expansion',
        'zona', v.zona,
        'instrucciones', COALESCE(v.descripcion, 'Construir según el proyecto "' || v.nombre || '" de la planta externa.'),
        'cuadrilla_id', p_cuadrilla,
        'fecha_inicio', (NOW() AT TIME ZONE zona_horaria())::date,
        'fecha_meta', p_fecha_meta
    ));

    FOR m IN SELECT * FROM jsonb_array_elements(COALESCE(p_materiales, '[]'))
    LOOP
        IF COALESCE((m->>'cantidad')::numeric, 0) > 0 AND NULLIF(BTRIM(m->>'descripcion'), '') IS NOT NULL THEN
            INSERT INTO obra_materiales (obra_id, articulo_id, descripcion, unidad, presupuesto)
            VALUES (v_obra, NULLIF(m->>'articulo_id', '')::uuid, LEFT(BTRIM(m->>'descripcion'), 140),
                    LEFT(COALESCE(NULLIF(m->>'unidad', ''), 'u'), 10), (m->>'cantidad')::numeric);
        END IF;
    END LOOP;

    UPDATE planta_proyectos SET estado = 'en_obra', obra_id = v_obra WHERE id = p_proyecto;
    RETURN v_obra;
END;
$$;

REVOKE ALL ON FUNCTION proyecto_a_obra(UUID, UUID, DATE, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION proyecto_a_obra(UUID, UUID, DATE, JSONB, JSONB) TO authenticated;


-- =============================================================================
-- 4. El as-built: la obra aprobada vuelve al plano
-- =============================================================================
/**
 * Aprobada la obra (`revisar_obra`, 232), el proyecto queda construido: lo
 * suyo pasa de "proyectado" a "existente". Las cajas que la cuadrilla registró
 * ya quedaron con su ubicación y potencia reales (trigger de la 234).
 *
 * Cancelada la obra, el proyecto vuelve a diseño, listo para otra.
 */
CREATE OR REPLACE FUNCTION obra_al_proyecto()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_p UUID;
BEGIN
    IF NEW.estado IS NOT DISTINCT FROM OLD.estado THEN RETURN NEW; END IF;
    SELECT id INTO v_p FROM planta_proyectos WHERE obra_id = NEW.id;
    IF v_p IS NULL THEN RETURN NEW; END IF;

    IF NEW.estado = 'aprobada' THEN
        UPDATE planta_proyectos SET estado = 'construido', construido_at = NOW() WHERE id = v_p;
        UPDATE planta_elementos
           SET estado = 'existente',
               verificacion = CASE WHEN verificacion = 'importado' THEN 'oficina' ELSE verificacion END
         WHERE proyecto_id = v_p AND estado = 'proyectado';
        UPDATE planta_cables
           SET estado = 'existente',
               verificacion = CASE WHEN verificacion = 'importado' THEN 'oficina' ELSE verificacion END
         WHERE proyecto_id = v_p AND estado = 'proyectado';
    ELSIF NEW.estado = 'cancelada' THEN
        UPDATE planta_proyectos SET estado = 'diseno', obra_id = NULL WHERE id = v_p;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_obra_al_proyecto ON obras_red;
CREATE TRIGGER trg_obra_al_proyecto
    AFTER UPDATE OF estado ON obras_red
    FOR EACH ROW EXECUTE FUNCTION obra_al_proyecto();


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT p.nombre, p.estado, o.numero AS obra,
--          (SELECT COUNT(*) FROM planta_elementos e WHERE e.proyecto_id = p.id) AS elementos,
--          (SELECT COUNT(*) FROM planta_cables c WHERE c.proyecto_id = p.id) AS cables
--     FROM planta_proyectos p LEFT JOIN obras_red o ON o.id = p.obra_id;
