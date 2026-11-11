-- =============================================================================
-- Migración 235 — Capas propias y estilos de la planta externa
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 234 (planta externa).
--
-- ── Qué resuelve ──
--
-- El mapa dibujaba todo con colores fijos por tipo: no había forma de decir
-- "este es el feeder principal, va en rojo y grueso", ni de juntar los postes
-- de El Carmen en una capa que se prende y apaga.
--
--   · planta_capas      capas que crea la oficina ("Feeder principal",
--                       "Postería CNEL"), cada una con su color, tamaño o
--                       grosor en píxeles, tipo de línea y opacidad.
--   · planta_estilos    el estilo de cada tipo (NAP, poste, troncal…), editable.
--   · capa_id, color y tamaño en cada elemento y cable.
--
-- El estilo que se ve sale de lo más específico que haya:
--
--     el propio del elemento o cable  >  el de su capa  >  el de su tipo
-- =============================================================================


-- =============================================================================
-- 1. Las capas
-- =============================================================================
CREATE TABLE IF NOT EXISTS planta_capas (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre     VARCHAR(80) NOT NULL,
    -- Una capa es de puntos (postes, cajas…) o de cables.
    clase      VARCHAR(8) NOT NULL DEFAULT 'cable' CHECK (clase IN ('elemento', 'cable')),
    color      VARCHAR(9) NOT NULL DEFAULT '#2563eb' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    -- Radio del punto o grosor de la línea, en píxeles.
    tamano     NUMERIC(4,1) NOT NULL DEFAULT 3 CHECK (tamano BETWEEN 1 AND 30),
    linea      VARCHAR(10) NOT NULL DEFAULT 'solida' CHECK (linea IN ('solida', 'rayada', 'punteada')),
    opacidad   NUMERIC(3,2) NOT NULL DEFAULT 0.9 CHECK (opacidad BETWEEN 0.1 AND 1),
    visible    BOOLEAN NOT NULL DEFAULT TRUE,
    orden      INT NOT NULL DEFAULT 0,
    descripcion TEXT,
    creado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (nombre)
);

COMMENT ON TABLE planta_capas IS
    'Capas de la planta externa que define la oficina, con su estilo. Un elemento o cable en una capa toma su estilo, salvo que tenga uno propio.';

/** El estilo de cada tipo: 'e:nap', 'e:poste', 'c:troncal'… */
CREATE TABLE IF NOT EXISTS planta_estilos (
    clave      VARCHAR(20) PRIMARY KEY,
    color      VARCHAR(9) NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    tamano     NUMERIC(4,1) NOT NULL CHECK (tamano BETWEEN 1 AND 30),
    linea      VARCHAR(10) NOT NULL DEFAULT 'solida' CHECK (linea IN ('solida', 'rayada', 'punteada')),
    opacidad   NUMERIC(3,2) NOT NULL DEFAULT 0.9 CHECK (opacidad BETWEEN 0.1 AND 1)
);

-- Los de siempre, para que el mapa se vea igual que antes hasta que alguien
-- los cambie.
INSERT INTO planta_estilos (clave, color, tamano) VALUES
    ('e:nodo', '#dc2626', 9), ('e:poste', '#475569', 4), ('e:nap', '#f59e0b', 6),
    ('e:manga', '#9333ea', 6), ('e:reserva', '#0d9488', 5), ('e:splitter', '#0ea5e9', 5),
    ('e:odf', '#334155', 7), ('e:otro', '#64748b', 4),
    ('c:troncal', '#1d4ed8', 5), ('c:feeder', '#2563eb', 4), ('c:distribucion', '#16a34a', 3),
    ('c:drop', '#0891b2', 2), ('c:hilo', '#f97316', 2), ('c:otro', '#64748b', 2)
ON CONFLICT (clave) DO NOTHING;


-- =============================================================================
-- 2. Cada elemento y cable: su capa y, si quiere, su propio estilo
-- =============================================================================
ALTER TABLE planta_elementos
    ADD COLUMN IF NOT EXISTS capa_id UUID REFERENCES planta_capas(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS color   VARCHAR(9) CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD COLUMN IF NOT EXISTS tamano  NUMERIC(4,1) CHECK (tamano IS NULL OR tamano BETWEEN 1 AND 30);

ALTER TABLE planta_cables
    ADD COLUMN IF NOT EXISTS capa_id UUID REFERENCES planta_capas(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS color   VARCHAR(9) CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD COLUMN IF NOT EXISTS tamano  NUMERIC(4,1) CHECK (tamano IS NULL OR tamano BETWEEN 1 AND 30),
    ADD COLUMN IF NOT EXISTS linea   VARCHAR(10) CHECK (linea IS NULL OR linea IN ('solida', 'rayada', 'punteada'));

CREATE INDEX IF NOT EXISTS idx_planta_elementos_capa ON planta_elementos (capa_id) WHERE capa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_planta_cables_capa ON planta_cables (capa_id) WHERE capa_id IS NOT NULL;

-- La vista se arma con `e.*`: se recrea para que tome las columnas nuevas.
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
-- 3. Pasar de una vez lo de una carpeta del KMZ a una capa
-- =============================================================================
/**
 * "Todos los postes de la carpeta POSTERIA EL CARMEN, a la capa Postería El
 * Carmen". Uno por uno serían horas. `p_carpeta` y `p_tipo` son opcionales;
 * `p_capa` NULL los saca de su capa. Devuelve cuántos movió.
 */
CREATE OR REPLACE FUNCTION mover_a_capa(p_capa UUID, p_clase TEXT, p_carpeta TEXT DEFAULT NULL, p_tipo TEXT DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_n INT;
BEGIN
    IF NOT gestiona_planta() THEN
        RAISE EXCEPTION 'Sin permiso para editar la planta externa.' USING ERRCODE = '42501';
    END IF;
    IF p_carpeta IS NULL AND p_tipo IS NULL THEN
        RAISE EXCEPTION 'Elegí la carpeta del KMZ o el tipo: mover todo de una vez no tiene vuelta atrás fácil.';
    END IF;
    IF p_clase = 'elemento' THEN
        UPDATE planta_elementos SET capa_id = p_capa
         WHERE (p_carpeta IS NULL OR origen->>'carpeta' = p_carpeta)
           AND (p_tipo IS NULL OR tipo = p_tipo);
    ELSE
        UPDATE planta_cables SET capa_id = p_capa
         WHERE (p_carpeta IS NULL OR origen->>'carpeta' = p_carpeta)
           AND (p_tipo IS NULL OR tipo = p_tipo);
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION mover_a_capa(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mover_a_capa(UUID, TEXT, TEXT, TEXT) TO authenticated;


-- =============================================================================
-- 4. Permisos
-- =============================================================================
ALTER TABLE planta_capas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE planta_estilos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planta_capas_leer ON planta_capas;
CREATE POLICY planta_capas_leer ON planta_capas FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_capas_editar ON planta_capas;
CREATE POLICY planta_capas_editar ON planta_capas FOR ALL TO authenticated
    USING (gestiona_planta()) WITH CHECK (gestiona_planta());

DROP POLICY IF EXISTS planta_estilos_leer ON planta_estilos;
CREATE POLICY planta_estilos_leer ON planta_estilos FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_estilos_editar ON planta_estilos;
CREATE POLICY planta_estilos_editar ON planta_estilos FOR UPDATE TO authenticated
    USING (gestiona_planta()) WITH CHECK (gestiona_planta());

REVOKE ALL ON planta_capas, planta_estilos FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON planta_capas TO authenticated;
GRANT SELECT, UPDATE ON planta_estilos TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT c.nombre, c.color, c.tamano,
--          (SELECT COUNT(*) FROM planta_cables x WHERE x.capa_id = c.id) AS cables,
--          (SELECT COUNT(*) FROM planta_elementos x WHERE x.capa_id = c.id) AS elementos
--     FROM planta_capas c ORDER BY c.orden, c.nombre;
