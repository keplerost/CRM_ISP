-- =============================================================================
-- Migración 234 — La planta externa: la red física en el mapa
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 46 (cajas NAP) y la 232 (obras de red).
--
-- ── Qué resuelve ──
--
-- La red estaba dibujada en un KMZ de Google Earth que nadie mantiene al día:
-- cajas que se llaman todas "NAP", tendidos marcados poste por poste sin la
-- línea del cable, puntos duplicados, una coordenada a 200 km. Y el sistema no
-- sabía nada de eso.
--
-- Ahora la planta externa vive acá:
--
--   · planta_elementos   nodos, postes (con su herraje A/J), cajas NAP, mangas,
--                        reservas, splitters, ODF. Cada caja NAP es la misma
--                        caja de `puntos_red`: la que usan las obras, el mapeo
--                        y la ficha del abonado.
--   · planta_cables      troncales, feeder, distribución y drops, con su ruta,
--                        hilos y metros (los calcula la base).
--   · planta_importaciones  cada KMZ que se trajo, para poder deshacerlo.
--
-- ── Qué tan confiable es cada dato ──
--
-- `verificacion`: 'importado' (salió de un KMZ: puede estar mal), 'oficina'
-- (alguien lo cargó o lo revisó en el mapa) o 'campo' (alguien fue y lo vio:
-- una caja registrada en una obra o en un mapeo queda así sola).
--
-- `revisar`: lo que el importador vio raro y no quiso adivinar: sin nombre,
-- duplicada, lejos del resto, ruta armada uniendo postes. Se muestra en la
-- lista "A revisar" hasta que alguien lo resuelva.
--
-- ── Quién ──
--
-- La ve cualquiera con sesión (igual que `puntos_red`). La edita
-- administración, el jefe técnico o quien tenga el permiso `red.planta`.
-- =============================================================================


-- =============================================================================
-- 1. Quién la edita
-- =============================================================================
CREATE OR REPLACE FUNCTION gestiona_planta()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo
           AND (rol IN ('super_admin', 'admin', 'jefe_tecnico')
                OR permisos ? '*' OR permisos ? 'red.planta')
    )
$$;

GRANT EXECUTE ON FUNCTION gestiona_planta() TO authenticated;

-- El permiso es nuevo: a los que ya existían no les llega solo.
UPDATE usuarios_sistema
   SET permisos = permisos || '["red.planta"]'::jsonb
 WHERE rol IN ('admin', 'jefe_tecnico')
   AND jsonb_typeof(permisos) = 'array'
   AND NOT permisos ? 'red.planta'
   AND NOT permisos ? '*';


-- =============================================================================
-- 2. Las tablas
-- =============================================================================
CREATE TABLE IF NOT EXISTS planta_importaciones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    archivo     VARCHAR(200) NOT NULL,
    resumen     JSONB NOT NULL DEFAULT '{}'::jsonb,
    creado_por  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deshecha_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS planta_elementos (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo           VARCHAR(10) NOT NULL
                   CHECK (tipo IN ('nodo', 'poste', 'nap', 'manga', 'reserva', 'splitter', 'odf', 'otro')),
    nombre         VARCHAR(150) NOT NULL,
    latitud        NUMERIC(10,7) NOT NULL CHECK (latitud BETWEEN -90 AND 90),
    longitud       NUMERIC(10,7) NOT NULL CHECK (longitud BETWEEN -180 AND 180),
    estado         VARCHAR(10) NOT NULL DEFAULT 'existente'
                   CHECK (estado IN ('existente', 'proyectado', 'retirado')),
    verificacion   VARCHAR(10) NOT NULL DEFAULT 'oficina'
                   CHECK (verificacion IN ('importado', 'oficina', 'campo')),

    -- Lo que aplica según el tipo; el resto queda vacío.
    hilos          INT CHECK (hilos IS NULL OR hilos > 0),          -- manga
    capacidad      INT CHECK (capacidad IS NULL OR capacidad > 0),  -- NAP: puertos
    splitter       VARCHAR(10),                                     -- '1:8', '1:16'
    herraje        VARCHAR(10),                                     -- poste: 'A' (anclaje), 'J' (suspensión)
    metros         NUMERIC(8,2) CHECK (metros IS NULL OR metros >= 0), -- reserva
    descripcion    TEXT,
    foto_url       TEXT,

    -- La caja NAP de siempre. Se crea sola al cargar una NAP.
    punto_id       UUID REFERENCES puntos_red(id) ON DELETE SET NULL,

    importacion_id UUID REFERENCES planta_importaciones(id) ON DELETE SET NULL,
    -- Cómo venía en el KMZ: carpeta, nombre y estilo originales.
    origen         JSONB,
    revisar        TEXT[] NOT NULL DEFAULT '{}',

    creado_por     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planta_elementos_tipo ON planta_elementos (tipo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_planta_elementos_punto ON planta_elementos (punto_id) WHERE punto_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_planta_elementos_imp ON planta_elementos (importacion_id) WHERE importacion_id IS NOT NULL;

COMMENT ON TABLE planta_elementos IS
    'La planta externa: nodos, postes, cajas NAP, mangas, reservas, splitters. Cada NAP es un punto de puntos_red.';

CREATE TABLE IF NOT EXISTS planta_cables (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre         VARCHAR(150) NOT NULL,
    tipo           VARCHAR(12) NOT NULL DEFAULT 'distribucion'
                   CHECK (tipo IN ('troncal', 'feeder', 'distribucion', 'drop', 'hilo', 'otro')),
    hilos          INT CHECK (hilos IS NULL OR hilos > 0),
    -- Cuando la línea es un solo hilo ("HILO VERDE NAP A3").
    color_hilo     VARCHAR(12),
    -- [[lat, lng], …] en el orden del recorrido.
    ruta           JSONB NOT NULL,
    -- Calculado por la base a partir de la ruta.
    longitud_m     NUMERIC(10,1),
    desde_id       UUID REFERENCES planta_elementos(id) ON DELETE SET NULL,
    hasta_id       UUID REFERENCES planta_elementos(id) ON DELETE SET NULL,
    estado         VARCHAR(10) NOT NULL DEFAULT 'existente'
                   CHECK (estado IN ('existente', 'proyectado', 'retirado')),
    verificacion   VARCHAR(10) NOT NULL DEFAULT 'oficina'
                   CHECK (verificacion IN ('importado', 'oficina', 'campo')),
    descripcion    TEXT,
    importacion_id UUID REFERENCES planta_importaciones(id) ON DELETE SET NULL,
    origen         JSONB,
    revisar        TEXT[] NOT NULL DEFAULT '{}',
    creado_por     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT planta_cable_ruta CHECK (jsonb_typeof(ruta) = 'array' AND jsonb_array_length(ruta) >= 2)
);
CREATE INDEX IF NOT EXISTS idx_planta_cables_imp ON planta_cables (importacion_id) WHERE importacion_id IS NOT NULL;


-- =============================================================================
-- 3. Los metros del cable, de su ruta
-- =============================================================================
/** Suma de los tramos de una ruta [[lat, lng], …], en metros (haversine). */
CREATE OR REPLACE FUNCTION ruta_metros(p_ruta JSONB)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(ROUND(SUM(
               6371000 * 2 * ASIN(SQRT(
                   POWER(SIN(RADIANS((b.lat - a.lat) / 2)), 2)
                 + COS(RADIANS(a.lat)) * COS(RADIANS(b.lat))
                   * POWER(SIN(RADIANS((b.lng - a.lng) / 2)), 2)))
           )::numeric, 1), 0)
      FROM (SELECT n, (p->>0)::float8 AS lat, (p->>1)::float8 AS lng
              FROM jsonb_array_elements(p_ruta) WITH ORDINALITY AS x(p, n)) a
      JOIN (SELECT n, (p->>0)::float8 AS lat, (p->>1)::float8 AS lng
              FROM jsonb_array_elements(p_ruta) WITH ORDINALITY AS x(p, n)) b ON b.n = a.n + 1
$$;

GRANT EXECUTE ON FUNCTION ruta_metros(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION planta_cable_calcular()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.longitud_m := ruta_metros(NEW.ruta);
    NEW.actualizado_at := NOW();
    NEW.creado_por := COALESCE(NEW.creado_por, mi_usuario_id());
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_planta_cable_calcular ON planta_cables;
CREATE TRIGGER trg_planta_cable_calcular
    BEFORE INSERT OR UPDATE ON planta_cables
    FOR EACH ROW EXECUTE FUNCTION planta_cable_calcular();


-- =============================================================================
-- 4. La NAP del mapa es la caja de siempre
-- =============================================================================
/**
 * Al cargar una NAP en el mapa se crea su caja en `puntos_red` (la que usan las
 * obras, el mapeo y la ficha del abonado), y al cambiarle el nombre, la
 * ubicación o los puertos, se le cambian a la caja.
 *
 * El nombre de la caja es único. Si el KMZ trae noventa cajas llamadas "NAP",
 * la caja lleva un sufijo ("NAP · 3F2A") hasta que alguien le ponga el rótulo
 * real; el elemento queda marcado para revisar.
 */
CREATE OR REPLACE FUNCTION planta_elemento_sincronizar()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_nombre TEXT;
    v_otro   UUID;
BEGIN
    NEW.actualizado_at := NOW();
    NEW.creado_por := COALESCE(NEW.creado_por, mi_usuario_id());
    IF NEW.tipo <> 'nap' THEN
        RETURN NEW;
    END IF;

    v_nombre := UPPER(BTRIM(NEW.nombre));

    IF NEW.punto_id IS NULL THEN
        SELECT id INTO v_otro FROM puntos_red WHERE UPPER(nombre) = v_nombre LIMIT 1;
        IF v_otro IS NOT NULL AND NOT EXISTS (SELECT 1 FROM planta_elementos WHERE punto_id = v_otro) THEN
            -- Ya había una caja con ese nombre que no estaba en el mapa: es esa.
            NEW.punto_id := v_otro;
            UPDATE puntos_red SET latitud = NEW.latitud, longitud = NEW.longitud,
                                  capacidad = COALESCE(NEW.capacidad, capacidad)
             WHERE id = v_otro;
        ELSE
            IF v_otro IS NOT NULL THEN
                v_nombre := LEFT(v_nombre, 90) || ' · ' || UPPER(LEFT(REPLACE(NEW.id::text, '-', ''), 4));
            END IF;
            INSERT INTO puntos_red (nombre, tipo, capacidad, latitud, longitud, notas, origen, activo)
            VALUES (v_nombre, 'nap', NEW.capacidad, NEW.latitud, NEW.longitud, NEW.descripcion,
                    CASE NEW.verificacion WHEN 'campo' THEN 'campo' WHEN 'importado' THEN 'kmz' ELSE 'oficina' END,
                    NEW.estado <> 'retirado')
            RETURNING id INTO NEW.punto_id;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.nombre IS DISTINCT FROM OLD.nombre THEN
            IF EXISTS (SELECT 1 FROM puntos_red WHERE UPPER(nombre) = v_nombre AND id <> NEW.punto_id) THEN
                RAISE EXCEPTION 'Ya hay otra caja que se llama %.', v_nombre;
            END IF;
            UPDATE puntos_red SET nombre = v_nombre WHERE id = NEW.punto_id;
        END IF;
        UPDATE puntos_red
           SET latitud   = NEW.latitud,
               longitud  = NEW.longitud,
               capacidad = NEW.capacidad,
               activo    = NEW.estado <> 'retirado',
               origen    = CASE WHEN NEW.verificacion = 'campo' THEN 'campo' ELSE origen END
         WHERE id = NEW.punto_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_planta_elemento_sincronizar ON planta_elementos;
CREATE TRIGGER trg_planta_elemento_sincronizar
    BEFORE INSERT OR UPDATE ON planta_elementos
    FOR EACH ROW EXECUTE FUNCTION planta_elemento_sincronizar();

/**
 * Y al revés: la caja que una cuadrilla registra en una obra o en un mapeo
 * (232/233) aparece en el mapa, verificada en campo. Si ya estaba (importada
 * del KMZ), se le corrige la ubicación y los puertos con lo que vieron.
 */
CREATE OR REPLACE FUNCTION obra_nap_al_mapa()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    p puntos_red%ROWTYPE;
BEGIN
    IF NEW.punto_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO p FROM puntos_red WHERE id = NEW.punto_id;

    IF EXISTS (SELECT 1 FROM planta_elementos WHERE punto_id = NEW.punto_id) THEN
        UPDATE planta_elementos
           SET latitud      = COALESCE(NEW.latitud, latitud),
               longitud     = COALESCE(NEW.longitud, longitud),
               capacidad    = COALESCE(NEW.puertos, capacidad),
               verificacion = 'campo',
               revisar      = '{}'
         WHERE punto_id = NEW.punto_id;
    ELSIF COALESCE(NEW.latitud, p.latitud) IS NOT NULL THEN
        INSERT INTO planta_elementos (tipo, nombre, latitud, longitud, capacidad, verificacion, punto_id, descripcion)
        VALUES ('nap', p.nombre, COALESCE(NEW.latitud, p.latitud), COALESCE(NEW.longitud, p.longitud),
                COALESCE(NEW.puertos, p.capacidad), 'campo', NEW.punto_id,
                (SELECT 'Registrada en la obra #' || numero FROM obras_red WHERE id = NEW.obra_id));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_obra_nap_al_mapa ON obra_naps;
CREATE TRIGGER trg_obra_nap_al_mapa
    AFTER INSERT OR UPDATE ON obra_naps
    FOR EACH ROW EXECUTE FUNCTION obra_nap_al_mapa();


-- =============================================================================
-- 5. Permisos
-- =============================================================================
ALTER TABLE planta_importaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE planta_elementos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE planta_cables        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planta_imp_leer ON planta_importaciones;
CREATE POLICY planta_imp_leer ON planta_importaciones FOR SELECT TO authenticated USING (gestiona_planta());

DROP POLICY IF EXISTS planta_elementos_leer ON planta_elementos;
CREATE POLICY planta_elementos_leer ON planta_elementos FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_elementos_editar ON planta_elementos;
CREATE POLICY planta_elementos_editar ON planta_elementos FOR ALL TO authenticated
    USING (gestiona_planta()) WITH CHECK (gestiona_planta());

DROP POLICY IF EXISTS planta_cables_leer ON planta_cables;
CREATE POLICY planta_cables_leer ON planta_cables FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_cables_editar ON planta_cables;
CREATE POLICY planta_cables_editar ON planta_cables FOR ALL TO authenticated
    USING (gestiona_planta()) WITH CHECK (gestiona_planta());

REVOKE ALL ON planta_importaciones, planta_elementos, planta_cables FROM anon;
GRANT SELECT ON planta_importaciones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON planta_elementos, planta_cables TO authenticated;


-- =============================================================================
-- 6. Importar un KMZ, y deshacerlo
-- =============================================================================
/**
 * Carga de una vez lo que el navegador leyó del KMZ y ya clasificó.
 *
 * `p_elementos` y `p_cables` son arreglos con las columnas de cada tabla. Todo
 * entra como 'importado' y en una sola transacción: o entra el archivo entero
 * o no entra nada. Devuelve el id de la importación, para poder deshacerla.
 */
CREATE OR REPLACE FUNCTION importar_planta(p_archivo TEXT, p_elementos JSONB, p_cables JSONB, p_resumen JSONB DEFAULT '{}')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
    e    JSONB;
BEGIN
    IF NOT gestiona_planta() THEN
        RAISE EXCEPTION 'Solo administración, el jefe técnico o quien tenga el permiso de planta externa importa la red.' USING ERRCODE = '42501';
    END IF;
    IF jsonb_array_length(COALESCE(p_elementos, '[]')) + jsonb_array_length(COALESCE(p_cables, '[]')) = 0 THEN
        RAISE EXCEPTION 'El archivo no trae nada que importar.';
    END IF;

    INSERT INTO planta_importaciones (archivo, resumen, creado_por)
    VALUES (LEFT(COALESCE(NULLIF(BTRIM(p_archivo), ''), 'archivo.kmz'), 200), COALESCE(p_resumen, '{}'), mi_usuario_id())
    RETURNING id INTO v_id;

    FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_elementos, '[]'))
    LOOP
        INSERT INTO planta_elementos
            (tipo, nombre, latitud, longitud, estado, verificacion, hilos, capacidad, splitter, herraje,
             metros, descripcion, foto_url, importacion_id, origen, revisar)
        VALUES
            (COALESCE(e->>'tipo', 'otro'), LEFT(COALESCE(NULLIF(BTRIM(e->>'nombre'), ''), 'Sin nombre'), 150),
             (e->>'latitud')::numeric, (e->>'longitud')::numeric,
             COALESCE(e->>'estado', 'existente'), 'importado',
             NULLIF(e->>'hilos', '')::int, NULLIF(e->>'capacidad', '')::int,
             NULLIF(e->>'splitter', ''), NULLIF(e->>'herraje', ''), NULLIF(e->>'metros', '')::numeric,
             NULLIF(BTRIM(e->>'descripcion'), ''), NULLIF(e->>'foto_url', ''), v_id, e->'origen',
             COALESCE(ARRAY(SELECT jsonb_array_elements_text(e->'revisar')), '{}'));
    END LOOP;

    FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_cables, '[]'))
    LOOP
        INSERT INTO planta_cables
            (nombre, tipo, hilos, color_hilo, ruta, estado, verificacion, descripcion, importacion_id, origen, revisar)
        VALUES
            (LEFT(COALESCE(NULLIF(BTRIM(e->>'nombre'), ''), 'Cable sin nombre'), 150),
             COALESCE(e->>'tipo', 'distribucion'), NULLIF(e->>'hilos', '')::int, NULLIF(e->>'color_hilo', ''),
             e->'ruta', COALESCE(e->>'estado', 'existente'), 'importado',
             NULLIF(BTRIM(e->>'descripcion'), ''), v_id, e->'origen',
             COALESCE(ARRAY(SELECT jsonb_array_elements_text(e->'revisar')), '{}'));
    END LOOP;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION importar_planta(TEXT, JSONB, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION importar_planta(TEXT, JSONB, JSONB, JSONB) TO authenticated;

/**
 * Saca lo que entró con una importación y nadie tocó todavía. Lo que ya se
 * verificó (en la oficina o en campo) se queda: borrarlo sería perder trabajo.
 * Las cajas que se crearon con ella se borran si no tienen abonados ni ONUs.
 */
CREATE OR REPLACE FUNCTION deshacer_importacion_planta(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_el INT;
    v_ca INT;
    v_puntos UUID[];
BEGIN
    IF NOT gestiona_planta() THEN
        RAISE EXCEPTION 'Sin permiso para deshacer la importación.' USING ERRCODE = '42501';
    END IF;

    SELECT array_agg(punto_id) INTO v_puntos FROM planta_elementos
     WHERE importacion_id = p_id AND verificacion = 'importado' AND punto_id IS NOT NULL;

    DELETE FROM planta_cables WHERE importacion_id = p_id AND verificacion = 'importado';
    GET DIAGNOSTICS v_ca = ROW_COUNT;
    DELETE FROM planta_elementos WHERE importacion_id = p_id AND verificacion = 'importado';
    GET DIAGNOSTICS v_el = ROW_COUNT;

    DELETE FROM puntos_red p
     WHERE p.id = ANY (COALESCE(v_puntos, '{}'))
       AND NOT EXISTS (SELECT 1 FROM clientes c WHERE c.nap_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM onus u WHERE u.nap_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM obra_naps n WHERE n.punto_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM planta_elementos e WHERE e.punto_id = p.id);

    UPDATE planta_importaciones SET deshecha_at = NOW() WHERE id = p_id;
    RETURN jsonb_build_object('elementos', v_el, 'cables', v_ca);
END;
$$;

REVOKE ALL ON FUNCTION deshacer_importacion_planta(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION deshacer_importacion_planta(UUID) TO authenticated;


-- =============================================================================
-- 7. Lo que lee el mapa
-- =============================================================================
/** Cada elemento con lo que se sabe de su caja: abonados y puertos libres. */
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


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT tipo, verificacion, COUNT(*) FROM planta_elementos GROUP BY 1, 2 ORDER BY 1, 2;
--   SELECT tipo, COUNT(*), ROUND(SUM(longitud_m) / 1000, 2) AS km FROM planta_cables GROUP BY 1;
--   SELECT nombre, revisar FROM planta_elementos WHERE cardinality(revisar) > 0;
