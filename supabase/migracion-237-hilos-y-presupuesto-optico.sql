-- =============================================================================
-- Migración 237 — Los hilos, las fusiones y el presupuesto óptico
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 234 (planta externa).
--
-- ── Qué resuelve ──
--
-- El mapa decía DÓNDE están las cajas y los cables, pero no cómo están
-- conectados: qué hilo del feeder llega a qué manga, dónde se fusiona, qué
-- splitter lo abre, qué puerto PON lo alimenta. Sin eso no se puede calcular
-- cuánta potencia debería llegar a una caja, ni saber qué se cae si se corta
-- un cable.
--
--   · planta_pon        los puertos PON, en el nodo donde arranca la fibra,
--                       con su clase (B+, C+) y su potencia de salida. Funciona
--                       aunque la OLT no esté cargada en el sistema.
--   · planta_splitters  cada splitter, en la caja o manga donde está:
--                       balanceado (1:2 … 1:64) o desbalanceado (10/90, 30/70…).
--   · planta_uniones    lo que se une en cada caja o manga: un hilo con otro
--                       (fusión), un hilo con un splitter, un hilo con el
--                       puerto PON (conector). Cuando el cable ATRAVIESA la
--                       manga (sangría), `lado` dice hacia dónde sigue ese
--                       pedazo de hilo: 'd' hacia el inicio del cable, 'h' hacia
--                       el final.
--   · planta_optica     los valores con que se calcula: dB/km, pérdida por
--                       fusión y conector, sensibilidad de la ONU, margen.
--
-- El recorrido y el cálculo los hace la aplicación (`web/src/lib/hilos.js`):
-- acá se guarda lo que hay en el poste.
-- =============================================================================


-- =============================================================================
-- 1. Los tubos del cable
-- =============================================================================
ALTER TABLE planta_cables
    -- Hilos por tubo (buffer). "HL 48FO 4X12" son 4 tubos de 12.
    ADD COLUMN IF NOT EXISTS hilos_por_tubo INT CHECK (hilos_por_tubo IS NULL OR hilos_por_tubo BETWEEN 1 AND 24);

-- Lo que el KMZ dice en el nombre ("4X6", "4X12").
UPDATE planta_cables
   SET hilos_por_tubo = (regexp_match(UPPER(nombre), '(\d+)\s*X\s*(\d+)'))[2]::int
 WHERE hilos_por_tubo IS NULL
   AND UPPER(nombre) ~ '\d+\s*X\s*\d+'
   AND (regexp_match(UPPER(nombre), '(\d+)\s*X\s*(\d+)'))[2]::int BETWEEN 1 AND 24;


-- =============================================================================
-- 2. Puertos PON, splitters y uniones
-- =============================================================================
CREATE TABLE IF NOT EXISTS planta_pon (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- El nodo u ODF donde sale la fibra de ese puerto.
    elemento_id UUID NOT NULL REFERENCES planta_elementos(id) ON DELETE CASCADE,
    nombre      VARCHAR(60) NOT NULL,                       -- "OLT1 0/1/3"
    olt_id      UUID REFERENCES olts(id) ON DELETE SET NULL,
    slot        INT,
    puerto      INT,
    clase       VARCHAR(4) NOT NULL DEFAULT 'B+' CHECK (clase IN ('B+', 'C+', 'C++')),
    -- Potencia de salida del módulo. B+ entrega de +1,5 a +5 dBm; C+ de +3 a +7.
    tx_dbm      NUMERIC(4,2) NOT NULL DEFAULT 3 CHECK (tx_dbm BETWEEN -5 AND 12),
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (elemento_id, nombre)
);

CREATE TABLE IF NOT EXISTS planta_splitters (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    elemento_id UUID NOT NULL REFERENCES planta_elementos(id) ON DELETE CASCADE,
    nombre      VARCHAR(60),
    -- '1:8' balanceado, o '10/90' desbalanceado (salida 1 = el 10%, salida 2 = el 90%).
    relacion    VARCHAR(8) NOT NULL CHECK (relacion ~ '^(1:(2|4|8|16|32|64)|\d{1,2}/\d{1,2})$'),
    -- Si se midió o el fabricante dice otra cosa. Vacío = la típica.
    perdida_db  NUMERIC(5,2) CHECK (perdida_db IS NULL OR perdida_db BETWEEN 0 AND 30),
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planta_splitters_el ON planta_splitters (elemento_id);

/**
 * Un extremo es: un hilo de un cable ('hilo', cable, número de hilo, lado), un
 * puerto de un splitter ('splitter', splitter, 0 = entrada / 1..N = salida) o
 * un puerto PON ('pon', puerto).
 */
CREATE TABLE IF NOT EXISTS planta_uniones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    elemento_id UUID NOT NULL REFERENCES planta_elementos(id) ON DELETE CASCADE,
    a_tipo      VARCHAR(8) NOT NULL CHECK (a_tipo IN ('hilo', 'splitter', 'pon')),
    a_id        UUID NOT NULL,
    a_num       INT,
    a_lado      CHAR(1) CHECK (a_lado IS NULL OR a_lado IN ('d', 'h')),
    b_tipo      VARCHAR(8) NOT NULL CHECK (b_tipo IN ('hilo', 'splitter', 'pon')),
    b_id        UUID NOT NULL,
    b_num       INT,
    b_lado      CHAR(1) CHECK (b_lado IS NULL OR b_lado IN ('d', 'h')),
    tipo        VARCHAR(8) NOT NULL DEFAULT 'fusion' CHECK (tipo IN ('fusion', 'conector')),
    -- Lo que dio la empalmadora o el OTDR. Vacío = la típica.
    perdida_db  NUMERIC(4,2) CHECK (perdida_db IS NULL OR perdida_db BETWEEN 0 AND 10),
    nota        TEXT,
    creado_por  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT planta_union_distintos CHECK (
        (a_tipo, a_id, COALESCE(a_num, -1), COALESCE(a_lado, '-'))
        IS DISTINCT FROM (b_tipo, b_id, COALESCE(b_num, -1), COALESCE(b_lado, '-'))
    )
);
CREATE INDEX IF NOT EXISTS idx_planta_uniones_el ON planta_uniones (elemento_id);
CREATE INDEX IF NOT EXISTS idx_planta_uniones_a ON planta_uniones (a_tipo, a_id);
CREATE INDEX IF NOT EXISTS idx_planta_uniones_b ON planta_uniones (b_tipo, b_id);

COMMENT ON TABLE planta_uniones IS
    'Fusiones y conectores en cada caja o manga: hilo con hilo, hilo con splitter, hilo con puerto PON. lado = d/h cuando el cable atraviesa la manga.';

/**
 * Un extremo se usa una sola vez en cada caja: el hilo 5 del lado de entrada no
 * puede estar fusionado con dos cosas a la vez. Y lo que se une tiene que
 * existir (los extremos no tienen FK: pueden ser de tres tablas distintas).
 */
CREATE OR REPLACE FUNCTION planta_union_controlar()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    i     INT;
    t     TEXT;
    x     UUID;
    n     INT;
    l     CHAR(1);
    v_hil INT;
    v_rel TEXT;
    v_sal INT;
BEGIN
    NEW.creado_por := COALESCE(NEW.creado_por, mi_usuario_id());
    FOR i IN 1..2 LOOP
        IF i = 1 THEN t := NEW.a_tipo; x := NEW.a_id; n := NEW.a_num; l := NEW.a_lado;
        ELSE         t := NEW.b_tipo; x := NEW.b_id; n := NEW.b_num; l := NEW.b_lado; END IF;

        IF t = 'hilo' THEN
            SELECT hilos INTO v_hil FROM planta_cables WHERE id = x;
            IF NOT FOUND THEN RAISE EXCEPTION 'Ese cable no existe.'; END IF;
            IF n IS NULL OR n < 1 OR (v_hil IS NOT NULL AND n > v_hil) THEN
                RAISE EXCEPTION 'El cable tiene % hilos: el hilo % no existe.', COALESCE(v_hil::text, '?'), n;
            END IF;
        ELSIF t = 'splitter' THEN
            SELECT relacion INTO v_rel FROM planta_splitters WHERE id = x AND elemento_id = NEW.elemento_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'Ese splitter no está en esta caja.'; END IF;
            v_sal := CASE WHEN v_rel LIKE '1:%' THEN split_part(v_rel, ':', 2)::int ELSE 2 END;
            IF n IS NULL OR n < 0 OR n > v_sal THEN
                RAISE EXCEPTION 'El splitter % tiene la entrada (0) y las salidas 1 a %.', v_rel, v_sal;
            END IF;
            l := NULL;
        ELSE
            IF NOT EXISTS (SELECT 1 FROM planta_pon WHERE id = x AND elemento_id = NEW.elemento_id) THEN
                RAISE EXCEPTION 'Ese puerto PON no está en este nodo.';
            END IF;
            l := NULL;
        END IF;

        IF EXISTS (
            SELECT 1 FROM planta_uniones u
             WHERE u.elemento_id = NEW.elemento_id AND u.id IS DISTINCT FROM NEW.id
               AND ((u.a_tipo = t AND u.a_id = x AND u.a_num IS NOT DISTINCT FROM n AND u.a_lado IS NOT DISTINCT FROM l)
                 OR (u.b_tipo = t AND u.b_id = x AND u.b_num IS NOT DISTINCT FROM n AND u.b_lado IS NOT DISTINCT FROM l))
        ) THEN
            RAISE EXCEPTION 'Ese extremo ya está unido a otra cosa en esta caja. Quitá esa unión primero.';
        END IF;
    END LOOP;
    -- Splitters y PON no tienen lado.
    IF NEW.a_tipo <> 'hilo' THEN NEW.a_lado := NULL; END IF;
    IF NEW.b_tipo <> 'hilo' THEN NEW.b_lado := NULL; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_planta_union_controlar ON planta_uniones;
CREATE TRIGGER trg_planta_union_controlar
    BEFORE INSERT OR UPDATE ON planta_uniones
    FOR EACH ROW EXECUTE FUNCTION planta_union_controlar();

-- Al borrar un cable o splitter, sus uniones no pueden quedar apuntando a nada.
CREATE OR REPLACE FUNCTION planta_union_huerfanas()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tipo TEXT := CASE TG_TABLE_NAME WHEN 'planta_cables' THEN 'hilo' WHEN 'planta_splitters' THEN 'splitter' ELSE 'pon' END;
BEGIN
    DELETE FROM planta_uniones
     WHERE (a_tipo = v_tipo AND a_id = OLD.id) OR (b_tipo = v_tipo AND b_id = OLD.id);
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_union_cable ON planta_cables;
CREATE TRIGGER trg_union_cable AFTER DELETE ON planta_cables FOR EACH ROW EXECUTE FUNCTION planta_union_huerfanas();
DROP TRIGGER IF EXISTS trg_union_splitter ON planta_splitters;
CREATE TRIGGER trg_union_splitter AFTER DELETE ON planta_splitters FOR EACH ROW EXECUTE FUNCTION planta_union_huerfanas();
DROP TRIGGER IF EXISTS trg_union_pon ON planta_pon;
CREATE TRIGGER trg_union_pon AFTER DELETE ON planta_pon FOR EACH ROW EXECUTE FUNCTION planta_union_huerfanas();


-- =============================================================================
-- 3. Con qué se calcula
-- =============================================================================
CREATE TABLE IF NOT EXISTS planta_optica (
    id                BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- La bajada (1490 nm) pierde ~0,25 dB/km; la subida (1310 nm) ~0,35. Se
    -- calcula con la peor, que es la que decide si el abonado engancha.
    atenuacion_db_km  NUMERIC(4,2) NOT NULL DEFAULT 0.35,
    perdida_fusion    NUMERIC(4,2) NOT NULL DEFAULT 0.10,
    perdida_conector  NUMERIC(4,2) NOT NULL DEFAULT 0.50,
    -- Lo mínimo que tiene que llegarle a la ONU (B+: −27 dBm; C+: −30 dBm).
    sensibilidad_dbm  NUMERIC(5,2) NOT NULL DEFAULT -27,
    -- Lo que se deja de colchón por envejecimiento, reparaciones y suciedad.
    margen_min_db     NUMERIC(4,2) NOT NULL DEFAULT 3,
    -- La acometida típica, para estimar lo que llega al abonado.
    drop_m            INT NOT NULL DEFAULT 150,
    -- Cuánto puede diferir lo medido de lo calculado antes de avisar.
    tolerancia_db     NUMERIC(4,2) NOT NULL DEFAULT 3,
    actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO planta_optica (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- 4. Permisos
-- =============================================================================
ALTER TABLE planta_pon       ENABLE ROW LEVEL SECURITY;
ALTER TABLE planta_splitters ENABLE ROW LEVEL SECURITY;
ALTER TABLE planta_uniones   ENABLE ROW LEVEL SECURITY;
ALTER TABLE planta_optica    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planta_pon_leer ON planta_pon;
CREATE POLICY planta_pon_leer ON planta_pon FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_pon_editar ON planta_pon;
CREATE POLICY planta_pon_editar ON planta_pon FOR ALL TO authenticated USING (gestiona_planta()) WITH CHECK (gestiona_planta());

DROP POLICY IF EXISTS planta_splitters_leer ON planta_splitters;
CREATE POLICY planta_splitters_leer ON planta_splitters FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_splitters_editar ON planta_splitters;
CREATE POLICY planta_splitters_editar ON planta_splitters FOR ALL TO authenticated USING (gestiona_planta()) WITH CHECK (gestiona_planta());

DROP POLICY IF EXISTS planta_uniones_leer ON planta_uniones;
CREATE POLICY planta_uniones_leer ON planta_uniones FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_uniones_editar ON planta_uniones;
CREATE POLICY planta_uniones_editar ON planta_uniones FOR ALL TO authenticated USING (gestiona_planta()) WITH CHECK (gestiona_planta());

DROP POLICY IF EXISTS planta_optica_leer ON planta_optica;
CREATE POLICY planta_optica_leer ON planta_optica FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS planta_optica_editar ON planta_optica;
CREATE POLICY planta_optica_editar ON planta_optica FOR UPDATE TO authenticated USING (gestiona_planta()) WITH CHECK (gestiona_planta());

REVOKE ALL ON planta_pon, planta_splitters, planta_uniones, planta_optica FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON planta_pon, planta_splitters, planta_uniones TO authenticated;
GRANT SELECT, UPDATE ON planta_optica TO authenticated;


-- =============================================================================
-- 5. Lo medido en campo, para comparar con lo calculado
-- =============================================================================
/**
 * Por cada caja: la última potencia que midió una cuadrilla (obra o mapeo) y el
 * promedio de lo que reportan las ONUs que cuelgan de ella.
 */
DROP VIEW IF EXISTS v_planta_medido;
CREATE VIEW v_planta_medido WITH (security_invoker = true) AS
SELECT e.id AS elemento_id,
       m.potencia_dbm AS medido_dbm,
       m.registrada_at AS medido_at,
       o.rx_promedio,
       o.rx_peor,
       o.onus
  FROM planta_elementos e
  LEFT JOIN LATERAL (
      SELECT n.potencia_dbm, n.registrada_at FROM obra_naps n
       WHERE n.punto_id = e.punto_id AND n.potencia_dbm IS NOT NULL
       ORDER BY n.registrada_at DESC LIMIT 1
  ) m ON TRUE
  LEFT JOIN LATERAL (
      SELECT ROUND(AVG(u.rx_power_dbm)::numeric, 2) AS rx_promedio, MIN(u.rx_power_dbm) AS rx_peor, COUNT(*)::int AS onus
        FROM onus u WHERE u.nap_id = e.punto_id AND u.rx_power_dbm IS NOT NULL
  ) o ON TRUE
 WHERE e.punto_id IS NOT NULL;

GRANT SELECT ON v_planta_medido TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT e.nombre, s.relacion FROM planta_splitters s JOIN planta_elementos e ON e.id = s.elemento_id;
--   SELECT e.nombre, u.a_tipo, u.a_num, u.b_tipo, u.b_num, u.tipo FROM planta_uniones u
--     JOIN planta_elementos e ON e.id = u.elemento_id ORDER BY e.nombre;
