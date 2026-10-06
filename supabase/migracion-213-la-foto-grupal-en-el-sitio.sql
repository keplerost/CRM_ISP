-- =============================================================================
-- Migración 213 — La foto grupal en el sitio
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 212 (el ingreso en el primer cliente).
--
-- ── Qué resuelve ──
--
-- Con la 212 cada técnico se sacaba su selfie al llegar a su primer trabajo.
-- En una cuadrilla de tres son tres fotos de lo mismo, y ninguna prueba que
-- estaban EN EL SITIO: una selfie se saca en cualquier lado.
--
-- Ahora, en una cuadrilla con jefe de grupo:
--
--   · Al llegar al primer trabajo del día, el JEFE DE GRUPO toma una FOTO
--     GRUPAL. Antes de dejarlo, la base mide su GPS contra la ubicación del
--     cliente: a más de 250 m (más el error que informa el GPS, hasta 100 m)
--     no la acepta. La distancia la calcula la base con la coordenada guardada
--     del cliente, no la que manda el teléfono.
--   · El jefe marca quiénes están en la foto. A cada uno se le registra el
--     ingreso con esa foto, esa hora y ese lugar. No se sacan selfie.
--   · Quien no estaba (llegó tarde, trabaja separado ese día) marca el suyo
--     aparte, con su selfie, como en la 212.
--
-- Si el trabajo no tiene ubicación cargada, no hay contra qué medir: la foto
-- se acepta y queda registrada SIN distancia, para que la oficina lo vea.
-- =============================================================================


-- =============================================================================
-- 1. El ingreso grupal
-- =============================================================================
CREATE TABLE IF NOT EXISTS ingresos_grupales (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cuadrilla_id UUID REFERENCES cuadrillas(id) ON DELETE SET NULL,
    jefe_id      UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    fecha        DATE NOT NULL,
    momento      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Dónde estaba el jefe al tomarla, y a cuánto del sitio. NULL en la
    -- distancia = el trabajo no tenía ubicación cargada.
    lat          NUMERIC(10,7),
    lng          NUMERIC(10,7),
    precision_m  INT,
    distancia_m  INT,

    -- El trabajo en el que se tomó.
    sitio_tipo   VARCHAR(12) CHECK (sitio_tipo IN ('ticket', 'instalacion', 'reparacion')),
    sitio_id     UUID,

    presentes    UUID[] NOT NULL DEFAULT '{}',
    foto         TEXT,
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingresos_grupales_fecha ON ingresos_grupales (fecha DESC, cuadrilla_id);

COMMENT ON TABLE ingresos_grupales IS
    'Foto grupal del jefe de grupo en el primer trabajo del día: marca el ingreso de los que están en ella, medido contra la ubicación del sitio.';

ALTER TABLE jornadas
    ADD COLUMN IF NOT EXISTS ingreso_grupal_id UUID REFERENCES ingresos_grupales(id) ON DELETE SET NULL;

ALTER TABLE ingresos_grupales ENABLE ROW LEVEL SECURITY;

-- Se escribe solo por las funciones de abajo.
DROP POLICY IF EXISTS ingresos_grupales_leer ON ingresos_grupales;
CREATE POLICY ingresos_grupales_leer ON ingresos_grupales
    FOR SELECT TO authenticated
    USING (cartera_completa() OR ve_todo_el_equipo() OR dirige_cuadrillas()
           OR cuadrilla_id IN (SELECT mis_cuadrillas()));

-- La foto, en el bucket de los ingresos (la 188), en `grupal/<id>/`.
DROP POLICY IF EXISTS ingresos_grupales_foto_subir ON storage.objects;
CREATE POLICY ingresos_grupales_foto_subir ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'jornadas'
        AND (storage.foldername(name))[1] = 'grupal'
        AND (storage.foldername(name))[2] IN (SELECT id::TEXT FROM ingresos_grupales)
    );

DROP POLICY IF EXISTS ingresos_grupales_foto_leer ON storage.objects;
CREATE POLICY ingresos_grupales_foto_leer ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'jornadas'
        AND (storage.foldername(name))[1] = 'grupal'
        AND (storage.foldername(name))[2] IN (SELECT id::TEXT FROM ingresos_grupales)
    );


-- =============================================================================
-- 2. Qué tiene que hacer quien inicia un trabajo
-- =============================================================================
/**
 * Lo que la app pregunta antes de iniciar un trabajo.
 *
 *   estado: 'en_servicio' | 'jornada_cerrada' | 'falta_ingreso'
 *   modo (con falta_ingreso):
 *     'grupal'        → es el jefe de grupo de hoy: toma la foto grupal.
 *     'espera_grupal' → su jefe todavía no la tomó: que espere, o que marque
 *                       el suyo si hoy trabaja separado.
 *     'individual'    → selfie, como en la 212.
 */
CREATE OR REPLACE FUNCTION mi_ingreso_de_hoy()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tec    UUID := mi_tecnico_id();
    v_fecha  DATE := (NOW() AT TIME ZONE zona_horaria())::date;
    v_estado TEXT := estado_de_ingreso();
    v_cuad   UUID;
    v_jefe   UUID;
BEGIN
    IF v_estado <> 'falta_ingreso' THEN
        RETURN jsonb_build_object('estado', v_estado);
    END IF;

    -- La cuadrilla que dirige hoy; si no dirige ninguna, la primera que tenga jefe.
    SELECT m.cuadrilla_id, jefe_de_grupo(m.cuadrilla_id, v_fecha)
      INTO v_cuad, v_jefe
      FROM cuadrilla_miembros m
     WHERE m.tecnico_id = v_tec
       AND jefe_de_grupo(m.cuadrilla_id, v_fecha) IS NOT NULL
     ORDER BY (jefe_de_grupo(m.cuadrilla_id, v_fecha) = v_tec) DESC
     LIMIT 1;

    IF v_cuad IS NULL THEN
        RETURN jsonb_build_object('estado', v_estado, 'modo', 'individual');
    END IF;

    IF v_jefe = v_tec THEN
        RETURN jsonb_build_object(
            'estado', v_estado,
            'modo', 'grupal',
            'cuadrilla_id', v_cuad,
            'cuadrilla', (SELECT nombre FROM cuadrillas WHERE id = v_cuad),
            'integrantes', (
                SELECT COALESCE(jsonb_agg(jsonb_build_object(
                           'id', t.id,
                           'nombre', t.nombre,
                           'es_jefe', t.id = v_tec,
                           'en_servicio', en_servicio(t.id, NOW())
                       ) ORDER BY (t.id = v_tec) DESC, t.nombre), '[]'::jsonb)
                  FROM cuadrilla_miembros m
                  JOIN tecnicos t ON t.id = m.tecnico_id AND t.activo
                 WHERE m.cuadrilla_id = v_cuad));
    END IF;

    -- Integrante: si su jefe ya tomó la foto hoy y él no estaba, va solo.
    IF EXISTS (SELECT 1 FROM ingresos_grupales
                WHERE cuadrilla_id = v_cuad AND fecha = v_fecha) THEN
        RETURN jsonb_build_object('estado', v_estado, 'modo', 'individual');
    END IF;

    RETURN jsonb_build_object(
        'estado', v_estado,
        'modo', 'espera_grupal',
        'jefe', (SELECT nombre FROM tecnicos WHERE id = v_jefe));
END;
$$;

GRANT EXECUTE ON FUNCTION mi_ingreso_de_hoy() TO authenticated;


-- =============================================================================
-- 3. Tomar la foto grupal
-- =============================================================================
/** Metros entre dos puntos (haversine). NULL si falta alguno. */
CREATE OR REPLACE FUNCTION distancia_m(p_lat1 NUMERIC, p_lng1 NUMERIC, p_lat2 NUMERIC, p_lng2 NUMERIC)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE WHEN p_lat1 IS NULL OR p_lng1 IS NULL OR p_lat2 IS NULL OR p_lng2 IS NULL THEN NULL
    ELSE ROUND(6371000 * 2 * ASIN(SQRT(
        POWER(SIN(RADIANS(p_lat2 - p_lat1) / 2), 2) +
        COS(RADIANS(p_lat1)) * COS(RADIANS(p_lat2)) *
        POWER(SIN(RADIANS(p_lng2 - p_lng1) / 2), 2))))::int
    END
$$;

/**
 * El jefe de grupo marca el ingreso de su cuadrilla en el sitio.
 *
 * Mide su ubicación contra la del trabajo (la del ticket o la instalación, y
 * si no tiene, la del abonado). Lejos, la rechaza. Devuelve el id, para subir
 * la foto a su carpeta y anotarla con `foto_ingreso_grupal`.
 */
CREATE OR REPLACE FUNCTION ingreso_grupal(
    p_presentes  UUID[],
    p_sitio_tipo TEXT,
    p_sitio_id   UUID,
    p_lat        NUMERIC,
    p_lng        NUMERIC,
    p_precision  INT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tec    UUID := mi_tecnico_id();
    v_fecha  DATE := (NOW() AT TIME ZONE zona_horaria())::date;
    v_cuad   UUID;
    v_slat   NUMERIC;
    v_slng   NUMERIC;
    v_dist   INT;
    v_tol    INT := 250 + LEAST(GREATEST(COALESCE(p_precision, 0), 0), 100);
    v_pres   UUID[];
    v_id     UUID;
    p        UUID;
    j        jornadas%ROWTYPE;
    u        RECORD;
BEGIN
    SELECT m.cuadrilla_id INTO v_cuad
      FROM cuadrilla_miembros m
     WHERE m.tecnico_id = v_tec AND jefe_de_grupo(m.cuadrilla_id, v_fecha) = v_tec
     LIMIT 1;
    IF v_cuad IS NULL THEN
        RAISE EXCEPTION 'La foto grupal la toma el jefe de grupo de hoy.' USING ERRCODE = '42501';
    END IF;
    IF p_lat IS NULL OR p_lng IS NULL THEN
        RAISE EXCEPTION 'Sin ubicación no se puede tomar la foto grupal: activá el GPS del teléfono.';
    END IF;

    -- Dónde queda el sitio. La coordenada del trabajo, y si no tiene, la del abonado.
    IF p_sitio_tipo = 'ticket' THEN
        SELECT COALESCE(t.latitud, c.latitud), COALESCE(t.longitud, c.longitud)
          INTO v_slat, v_slng
          FROM tickets t LEFT JOIN clientes c ON c.id = t.client_id
         WHERE t.id = p_sitio_id;
    ELSIF p_sitio_tipo = 'instalacion' THEN
        SELECT COALESCE(i.latitud, c.latitud), COALESCE(i.longitud, c.longitud)
          INTO v_slat, v_slng
          FROM instalaciones i LEFT JOIN clientes c ON c.id = i.client_id
         WHERE i.id = p_sitio_id;
    END IF;

    v_dist := distancia_m(p_lat, p_lng, v_slat, v_slng);
    IF v_dist IS NOT NULL AND v_dist > v_tol THEN
        RAISE EXCEPTION 'Estás a % m del sitio. La foto grupal se toma donde el cliente: acercate y volvé a intentar.', v_dist
            USING ERRCODE = '42501';
    END IF;

    -- Solo integrantes de la cuadrilla, y el jefe siempre.
    SELECT ARRAY(
        SELECT DISTINCT x FROM unnest(COALESCE(p_presentes, '{}') || v_tec) AS x
         WHERE x IN (SELECT tecnico_id FROM cuadrilla_miembros WHERE cuadrilla_id = v_cuad)
    ) INTO v_pres;

    INSERT INTO ingresos_grupales (cuadrilla_id, jefe_id, fecha, lat, lng, precision_m, distancia_m,
                                   sitio_tipo, sitio_id, presentes)
    VALUES (v_cuad, v_tec, v_fecha, p_lat, p_lng, p_precision, v_dist,
            CASE WHEN p_sitio_tipo IN ('ticket', 'instalacion', 'reparacion') THEN p_sitio_tipo END,
            p_sitio_id, v_pres)
    RETURNING id INTO v_id;

    -- El ingreso de cada uno. Quien ya estaba en servicio queda como estaba;
    -- quien ya cerró su jornada de hoy, también.
    FOREACH p IN ARRAY v_pres LOOP
        CONTINUE WHEN en_servicio(p, NOW());

        SELECT * INTO j FROM jornadas WHERE tecnico_id = p AND fecha = v_fecha FOR UPDATE;
        IF NOT FOUND THEN
            INSERT INTO jornadas (tecnico_id, fecha, inicio_at, lat_ingreso, lng_ingreso,
                                  precision_ingreso_m, distancia_ingreso_m, ingreso_grupal_id)
            VALUES (p, v_fecha, NOW(), p_lat, p_lng, p_precision, v_dist, v_id);
        ELSIF j.fin_at IS NULL THEN
            UPDATE jornadas
               SET inicio_at = NOW(), lat_ingreso = p_lat, lng_ingreso = p_lng,
                   precision_ingreso_m = p_precision, distancia_ingreso_m = v_dist,
                   ingreso_grupal_id = v_id
             WHERE id = j.id;
        END IF;

        -- Que cada uno sepa que su ingreso ya está.
        FOR u IN SELECT id FROM usuarios_sistema WHERE tecnico_id = p AND activo AND tecnico_id <> v_tec LOOP
            PERFORM notificar(u.id, 'ingreso_grupal',
                'Tu ingreso quedó marcado con la foto grupal',
                'A las ' || TO_CHAR(NOW() AT TIME ZONE zona_horaria(), 'HH24:MI') || '. Tus horas cuentan desde ahí.',
                '/campo/jornada', 'ingreso_grupal', v_id::text);
        END LOOP;
    END LOOP;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION ingreso_grupal(UUID[], TEXT, UUID, NUMERIC, NUMERIC, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ingreso_grupal(UUID[], TEXT, UUID, NUMERIC, NUMERIC, INT) TO authenticated;

/** La foto ya subió: queda en el ingreso grupal y en la jornada de cada presente. */
CREATE OR REPLACE FUNCTION foto_ingreso_grupal(p_id UUID, p_ruta TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE ingresos_grupales SET foto = p_ruta
     WHERE id = p_id AND jefe_id = mi_tecnico_id();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ese ingreso grupal no es tuyo.' USING ERRCODE = '42501';
    END IF;

    UPDATE jornadas
       SET foto_ingreso = p_ruta, foto_ingreso_at = NOW()
     WHERE ingreso_grupal_id = p_id AND foto_ingreso IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION foto_ingreso_grupal(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION foto_ingreso_grupal(UUID, TEXT) TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT g.fecha, cu.nombre, g.momento, g.distancia_m, cardinality(g.presentes) AS presentes,
--          g.foto IS NOT NULL AS con_foto
--     FROM ingresos_grupales g LEFT JOIN cuadrillas cu ON cu.id = g.cuadrilla_id
--    ORDER BY g.momento DESC;
