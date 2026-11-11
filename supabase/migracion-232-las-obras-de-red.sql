-- =============================================================================
-- Migración 232 — Las obras de red, y cómo se mide a la cuadrilla que construye
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 69 (inventario), la 208 (jefe de grupo), la 209 (reparaciones)
-- y la 212 (el ingreso en el primer trabajo).
--
-- ── Qué resuelve ──
--
-- MAZDA es una cuadrilla de construcción de redes, y hasta acá solo podía
-- figurar haciendo tickets. Medirla por tickets cerrados castiga lo que mejor
-- hace: un día de tendido que deja una zona lista para 50 abonados no cierra
-- ningún ticket.
--
-- Ahora la oficina le asigna OBRAS: una zona, un alcance (metros de fibra, cajas
-- NAP, fusiones, mangas, postes, puertos), una fecha meta y el material
-- presupuestado. La cuadrilla reporta el avance de cada día con fotos, registra
-- cada NAP con su ubicación y su potencia, y carga el material que usó. El jefe
-- de grupo la entrega; la oficina la aprueba o la devuelve con la observación.
--
-- ── Los indicadores ──
--
--   1. Producción        metros, NAP, fusiones, mangas, postes, puertos; por día
--   2. Avance vs. plan    % del alcance hecho; entregas a tiempo; obras atrasadas
--   3. Calidad óptica     potencia en cada NAP y pérdida por fusión
--   4. Fallas a 30 días   tickets de "sin señal" en las NAP que construyeron
--   5. Material           consumido vs. presupuestado (desvío y extras)
--   6. Documentación      días con foto; entregas aprobadas a la primera
--   7. Seguridad          días con EPP completo; incidentes
--   8. Apoyo a soporte    qué parte de sus días se fue en tickets
--
-- Las metas de cada uno se ajustan en `obras_config`.
--
-- ── Una obra NO se entrega sin su documentación ──
--
-- Al menos un avance con foto, y cada NAP con ubicación, potencia, puertos y
-- foto. Si la obra prometía N cajas, tienen que estar las N registradas. Lo
-- controla la base: el botón de la app solo refleja lo que ella va a aceptar.
--
-- ── Quién puede qué ──
--
--   · Crear, editar, aprobar, devolver, cancelar: administración, jefe técnico
--     o quien tenga el permiso `soporte.obras` (`dirige_obras()`).
--   · Reportar avances, registrar NAP y material: cualquiera de la cuadrilla.
--   · Entregar: el jefe de grupo del día (si no hay, cualquiera de ella).
-- =============================================================================


-- =============================================================================
-- 1. Quién dirige las obras
-- =============================================================================
CREATE OR REPLACE FUNCTION dirige_obras()
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
                OR permisos ? '*' OR permisos ? 'soporte.obras')
    )
$$;

GRANT EXECUTE ON FUNCTION dirige_obras() TO authenticated;

-- El permiso es nuevo: los administradores y jefes técnicos que ya existían no
-- lo tienen en su ficha (los permisos se copian del rol al crearlos). Sin esto,
-- el menú no les mostraría Obras aunque la base los deje.
UPDATE usuarios_sistema
   SET permisos = permisos || '["soporte.obras"]'::jsonb
 WHERE rol IN ('admin', 'jefe_tecnico')
   AND jsonb_typeof(permisos) = 'array'
   AND NOT permisos ? 'soporte.obras'
   AND NOT permisos ? '*';


-- =============================================================================
-- 2. Las metas de los indicadores
-- =============================================================================
CREATE TABLE IF NOT EXISTS obras_config (
    id                     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- Una NAP está bien si su potencia es igual o mejor que esto (−22 dBm).
    potencia_min_dbm       NUMERIC(5,2) NOT NULL DEFAULT -22,
    -- Pérdida máxima aceptable por fusión.
    perdida_fusion_max_db  NUMERIC(4,2) NOT NULL DEFAULT 0.10,
    -- Cuánto más material que el presupuestado se tolera.
    merma_max_pct          NUMERIC(5,2) NOT NULL DEFAULT 10,
    -- Qué parte de los días puede irse en tickets antes de avisar.
    apoyo_max_pct          NUMERIC(5,2) NOT NULL DEFAULT 35,
    -- Cuántos días después de entregar se cuentan las fallas.
    dias_fallas            INT NOT NULL DEFAULT 30 CHECK (dias_fallas BETWEEN 1 AND 180),
    -- % de obras que tienen que entregarse a tiempo.
    meta_a_tiempo_pct      NUMERIC(5,2) NOT NULL DEFAULT 90,
    -- Metros de fibra por día trabajado (0 = sin meta).
    meta_metros_dia        NUMERIC(8,2) NOT NULL DEFAULT 0,
    actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO obras_config (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

ALTER TABLE obras_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS obras_config_leer ON obras_config;
CREATE POLICY obras_config_leer ON obras_config FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS obras_config_editar ON obras_config;
CREATE POLICY obras_config_editar ON obras_config FOR UPDATE TO authenticated
    USING (dirige_obras()) WITH CHECK (dirige_obras());
REVOKE ALL ON obras_config FROM anon;
GRANT SELECT, UPDATE ON obras_config TO authenticated;


-- =============================================================================
-- 3. La obra, su bitácora, sus avances, sus NAP y su material
-- =============================================================================
CREATE TABLE IF NOT EXISTS obras_red (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Para decirlo por radio: "la obra 7".
    numero          BIGSERIAL,
    tipo            VARCHAR(14) NOT NULL DEFAULT 'expansion'
                    CHECK (tipo IN ('expansion', 'troncal', 'reubicacion', 'preventivo',
                                    'reparacion', 'acometida', 'otro')),
    titulo          VARCHAR(150) NOT NULL,
    zona            VARCHAR(150),
    instrucciones   TEXT,
    latitud         NUMERIC(10,7),
    longitud        NUMERIC(10,7),
    prioridad       VARCHAR(10) NOT NULL DEFAULT 'media'
                    CHECK (prioridad IN ('alta', 'media', 'baja')),

    cuadrilla_id    UUID REFERENCES cuadrillas(id) ON DELETE SET NULL,
    tecnico_id      UUID REFERENCES tecnicos(id) ON DELETE SET NULL,

    fecha_inicio    DATE,
    fecha_meta      DATE,

    -- El alcance. 0 = esa obra no lo incluye.
    meta_metros     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (meta_metros >= 0),
    meta_naps       INT NOT NULL DEFAULT 0 CHECK (meta_naps >= 0),
    meta_fusiones   INT NOT NULL DEFAULT 0 CHECK (meta_fusiones >= 0),
    meta_mangas     INT NOT NULL DEFAULT 0 CHECK (meta_mangas >= 0),
    meta_postes     INT NOT NULL DEFAULT 0 CHECK (meta_postes >= 0),
    meta_puertos    INT NOT NULL DEFAULT 0 CHECK (meta_puertos >= 0),

    -- El ticket que la originó: "no hay potencia, es como una instalación
    -- nueva". Al aprobar la obra se avisa que ya se puede reprogramar.
    ticket_id       UUID REFERENCES tickets(id) ON DELETE SET NULL,

    estado          VARCHAR(12) NOT NULL DEFAULT 'planificada'
                    CHECK (estado IN ('planificada', 'en_curso', 'entregada', 'aprobada', 'cancelada')),
    -- Cuántas veces la oficina la devolvió: es retrabajo.
    devoluciones    INT NOT NULL DEFAULT 0,

    creada_por      UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creada_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    iniciada_at     TIMESTAMPTZ,
    entregada_at    TIMESTAMPTZ,
    entregada_por   UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    entrega_nota    TEXT,
    aprobada_at     TIMESTAMPTZ,
    aprobada_por    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    cancelada_at    TIMESTAMPTZ,
    cierre_nota     TEXT,

    CONSTRAINT obra_con_responsable CHECK (cuadrilla_id IS NOT NULL OR tecnico_id IS NOT NULL),
    CONSTRAINT obra_fechas CHECK (fecha_meta IS NULL OR fecha_inicio IS NULL OR fecha_meta >= fecha_inicio)
);

CREATE INDEX IF NOT EXISTS idx_obras_abiertas ON obras_red (cuadrilla_id, estado);
CREATE INDEX IF NOT EXISTS idx_obras_entregadas ON obras_red (entregada_at) WHERE entregada_at IS NOT NULL;

COMMENT ON TABLE obras_red IS
    'Obra de construcción de red (tendido, NAP, troncal) asignada a una cuadrilla, con su alcance, fecha meta y material presupuestado.';

CREATE TABLE IF NOT EXISTS obra_eventos (
    id          BIGSERIAL PRIMARY KEY,
    obra_id     UUID NOT NULL REFERENCES obras_red(id) ON DELETE CASCADE,
    tipo        VARCHAR(12) NOT NULL
                CHECK (tipo IN ('creada', 'asignada', 'iniciada', 'entregada', 'aprobada',
                                'devuelta', 'cancelada', 'nota')),
    texto       TEXT,
    usuario_id  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    tecnico_id  UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obra_eventos ON obra_eventos (obra_id, creado_at);

/** El parte del día: lo que se hizo, con fotos. */
CREATE TABLE IF NOT EXISTS obra_avances (
    id                  BIGSERIAL PRIMARY KEY,
    obra_id             UUID NOT NULL REFERENCES obras_red(id) ON DELETE CASCADE,
    fecha               DATE NOT NULL,
    tecnico_id          UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    usuario_id          UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    metros              NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (metros >= 0),
    naps                INT NOT NULL DEFAULT 0 CHECK (naps >= 0),
    fusiones            INT NOT NULL DEFAULT 0 CHECK (fusiones >= 0),
    -- La pérdida promedio de las fusiones del día, de la empalmadora.
    perdida_fusion_db   NUMERIC(4,2) CHECK (perdida_fusion_db IS NULL OR perdida_fusion_db BETWEEN 0 AND 5),
    mangas              INT NOT NULL DEFAULT 0 CHECK (mangas >= 0),
    postes              INT NOT NULL DEFAULT 0 CHECK (postes >= 0),
    puertos             INT NOT NULL DEFAULT 0 CHECK (puertos >= 0),

    texto               TEXT,
    fotos               TEXT[] NOT NULL DEFAULT '{}',

    epp_completo        BOOLEAN NOT NULL DEFAULT TRUE,
    incidente           BOOLEAN NOT NULL DEFAULT FALSE,
    incidente_nota      TEXT,

    lat                 NUMERIC(10,7),
    lng                 NUMERIC(10,7),
    -- Para que reintentar el envío no lo cargue dos veces.
    clave               UUID,
    creado_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obra_avances ON obra_avances (obra_id, fecha);
CREATE INDEX IF NOT EXISTS idx_obra_avances_fecha ON obra_avances (fecha);
CREATE UNIQUE INDEX IF NOT EXISTS idx_obra_avances_clave ON obra_avances (clave) WHERE clave IS NOT NULL;

/** Cada caja NAP que deja la obra: dónde, cuántos puertos y con qué potencia. */
CREATE TABLE IF NOT EXISTS obra_naps (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obra_id       UUID NOT NULL REFERENCES obras_red(id) ON DELETE CASCADE,
    -- La caja en el mapa de la red (`puntos_red`): se crea al registrarla.
    punto_id      UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    nombre        VARCHAR(100) NOT NULL,
    latitud       NUMERIC(10,7),
    longitud      NUMERIC(10,7),
    puertos       INT CHECK (puertos IS NULL OR puertos > 0),
    potencia_dbm  NUMERIC(5,2) CHECK (potencia_dbm IS NULL OR potencia_dbm BETWEEN -50 AND 10),
    foto          TEXT,
    tecnico_id    UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    usuario_id    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    registrada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (obra_id, nombre)
);
CREATE INDEX IF NOT EXISTS idx_obra_naps_punto ON obra_naps (punto_id) WHERE punto_id IS NOT NULL;

/** El material presupuestado: lo carga la oficina al crear la obra. */
CREATE TABLE IF NOT EXISTS obra_materiales (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obra_id       UUID NOT NULL REFERENCES obras_red(id) ON DELETE CASCADE,
    -- Del inventario, si está dado de alta. Si no, alcanza con la descripción.
    articulo_id   UUID REFERENCES articulos(id) ON DELETE SET NULL,
    descripcion   VARCHAR(140) NOT NULL,
    unidad        VARCHAR(10) NOT NULL DEFAULT 'u',
    presupuesto   NUMERIC(12,2) NOT NULL CHECK (presupuesto > 0)
);
CREATE INDEX IF NOT EXISTS idx_obra_materiales ON obra_materiales (obra_id);

/** Lo que de verdad se usó. */
CREATE TABLE IF NOT EXISTS obra_consumos (
    id            BIGSERIAL PRIMARY KEY,
    obra_id       UUID NOT NULL REFERENCES obras_red(id) ON DELETE CASCADE,
    -- La línea del presupuesto. NULL = material que no estaba presupuestado.
    material_id   UUID REFERENCES obra_materiales(id) ON DELETE SET NULL,
    articulo_id   UUID REFERENCES articulos(id) ON DELETE SET NULL,
    descripcion   VARCHAR(140) NOT NULL,
    unidad        VARCHAR(10) NOT NULL DEFAULT 'u',
    cantidad      NUMERIC(12,2) NOT NULL CHECK (cantidad > 0),
    -- El movimiento de inventario, cuando se pudo descontar del almacén del
    -- técnico. NULL = el almacén no tenía ese material cargado.
    movimiento_id UUID REFERENCES movimientos_inventario(id) ON DELETE SET NULL,
    tecnico_id    UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    usuario_id    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obra_consumos ON obra_consumos (obra_id);


-- =============================================================================
-- 4. Quién la ve y quién la entrega
-- =============================================================================
CREATE OR REPLACE FUNCTION ve_obra(p_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT dirige_obras() OR EXISTS (
        SELECT 1 FROM obras_red o
         WHERE o.id = p_id
           AND ((o.tecnico_id IS NOT NULL AND o.tecnico_id = mi_tecnico_id())
             OR (o.cuadrilla_id IS NOT NULL AND o.cuadrilla_id IN (SELECT mis_cuadrillas())))
    )
$$;

GRANT EXECUTE ON FUNCTION ve_obra(UUID) TO authenticated;

/**
 * La entrega la hace el jefe de grupo de HOY de la cuadrilla (o su reemplazo).
 * Una cuadrilla sin jefe definido no deja a nadie bloqueado. Y la oficina.
 */
CREATE OR REPLACE FUNCTION puede_entregar_obra(p_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT dirige_obras() OR EXISTS (
        SELECT 1 FROM obras_red o
         WHERE o.id = p_id
           AND ((o.tecnico_id IS NOT NULL AND o.tecnico_id = mi_tecnico_id())
             OR (o.cuadrilla_id IS NOT NULL
                 AND o.cuadrilla_id IN (SELECT mis_cuadrillas())
                 AND COALESCE(jefe_de_grupo(o.cuadrilla_id, hoy_isp()), mi_tecnico_id()) = mi_tecnico_id()))
    )
$$;

GRANT EXECUTE ON FUNCTION puede_entregar_obra(UUID) TO authenticated;

ALTER TABLE obras_red       ENABLE ROW LEVEL SECURITY;
ALTER TABLE obra_eventos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE obra_avances    ENABLE ROW LEVEL SECURITY;
ALTER TABLE obra_naps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE obra_materiales ENABLE ROW LEVEL SECURITY;
ALTER TABLE obra_consumos   ENABLE ROW LEVEL SECURITY;

-- Se LEEN desde el navegador. Crear, reportar, entregar y aprobar van por las
-- funciones de abajo, que controlan quién y avisan a quien toca. El presupuesto
-- de material lo escribe la oficina directo.
DROP POLICY IF EXISTS obras_leer ON obras_red;
CREATE POLICY obras_leer ON obras_red FOR SELECT TO authenticated USING (ve_obra(id));
DROP POLICY IF EXISTS obra_eventos_leer ON obra_eventos;
CREATE POLICY obra_eventos_leer ON obra_eventos FOR SELECT TO authenticated USING (ve_obra(obra_id));
DROP POLICY IF EXISTS obra_avances_leer ON obra_avances;
CREATE POLICY obra_avances_leer ON obra_avances FOR SELECT TO authenticated USING (ve_obra(obra_id));
DROP POLICY IF EXISTS obra_naps_leer ON obra_naps;
CREATE POLICY obra_naps_leer ON obra_naps FOR SELECT TO authenticated USING (ve_obra(obra_id));
DROP POLICY IF EXISTS obra_consumos_leer ON obra_consumos;
CREATE POLICY obra_consumos_leer ON obra_consumos FOR SELECT TO authenticated USING (ve_obra(obra_id));
DROP POLICY IF EXISTS obra_materiales_leer ON obra_materiales;
CREATE POLICY obra_materiales_leer ON obra_materiales FOR SELECT TO authenticated USING (ve_obra(obra_id));
DROP POLICY IF EXISTS obra_materiales_oficina ON obra_materiales;
CREATE POLICY obra_materiales_oficina ON obra_materiales FOR ALL TO authenticated
    USING (dirige_obras()) WITH CHECK (dirige_obras());

REVOKE ALL ON obras_red, obra_eventos, obra_avances, obra_naps, obra_materiales, obra_consumos FROM anon;
GRANT SELECT ON obras_red, obra_eventos, obra_avances, obra_naps, obra_consumos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON obra_materiales TO authenticated;

-- El primer avance del día en la obra es el ingreso, igual que el primer
-- reporte de una reparación (212).
CREATE OR REPLACE FUNCTION controlar_avance_obra()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.fecha = hoy_isp() THEN
        PERFORM ingreso_automatico(NEW.creado_at, NEW.lat, NEW.lng);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_avance_obra ON obra_avances;
CREATE TRIGGER trg_avance_obra
    AFTER INSERT ON obra_avances
    FOR EACH ROW EXECUTE FUNCTION controlar_avance_obra();


-- =============================================================================
-- 5. Las fotos
-- =============================================================================
-- Privado. La carpeta es el id de la obra: si no corresponde a una obra que
-- quien sube puede ver, la política lo rechaza.
INSERT INTO storage.buckets (id, name, public)
VALUES ('obras', 'obras', FALSE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS obras_foto_subir ON storage.objects;
CREATE POLICY obras_foto_subir ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'obras'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM obras_red)
    );

DROP POLICY IF EXISTS obras_foto_leer ON storage.objects;
CREATE POLICY obras_foto_leer ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'obras'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM obras_red)
    );


-- =============================================================================
-- 6. Crear o editar (la oficina)
-- =============================================================================
/**
 * Crea la obra (p_id NULL) o la edita. `p_datos` lleva los campos de la tabla
 * por nombre; los que no vienen quedan como estaban.
 *
 * Avisa a la campana de la cuadrilla al crearla y cada vez que cambia de manos.
 */
CREATE OR REPLACE FUNCTION guardar_obra(p_id UUID, p_datos JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id      UUID := p_id;
    v_prev    obras_red%ROWTYPE;
    v_nueva   obras_red%ROWTYPE;
    v_quien   TEXT;
    u         RECORD;
    d         JSONB := COALESCE(p_datos, '{}'::jsonb);
BEGIN
    IF NOT dirige_obras() THEN
        RAISE EXCEPTION 'Solo administración, el jefe técnico o quien tenga el permiso de obras las crea.' USING ERRCODE = '42501';
    END IF;

    IF v_id IS NULL THEN
        IF NULLIF(BTRIM(d->>'titulo'), '') IS NULL THEN
            RAISE EXCEPTION 'Escribí qué obra es.';
        END IF;
        INSERT INTO obras_red (titulo, cuadrilla_id, tecnico_id, creada_por)
        VALUES (BTRIM(d->>'titulo'), NULLIF(d->>'cuadrilla_id', '')::uuid,
                NULLIF(d->>'tecnico_id', '')::uuid, mi_usuario_id())
        RETURNING id INTO v_id;
        INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id)
        VALUES (v_id, 'creada', 'Obra creada', mi_usuario_id());
    ELSE
        SELECT * INTO v_prev FROM obras_red WHERE id = v_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa obra.'; END IF;
        IF v_prev.estado IN ('aprobada', 'cancelada') THEN
            RAISE EXCEPTION 'Esa obra ya está cerrada.';
        END IF;
    END IF;

    UPDATE obras_red SET
        tipo          = COALESCE(NULLIF(d->>'tipo', ''), tipo),
        titulo        = COALESCE(NULLIF(BTRIM(d->>'titulo'), ''), titulo),
        zona          = CASE WHEN d ? 'zona' THEN NULLIF(BTRIM(d->>'zona'), '') ELSE zona END,
        instrucciones = CASE WHEN d ? 'instrucciones' THEN NULLIF(BTRIM(d->>'instrucciones'), '') ELSE instrucciones END,
        latitud       = CASE WHEN d ? 'latitud' THEN NULLIF(d->>'latitud', '')::numeric ELSE latitud END,
        longitud      = CASE WHEN d ? 'longitud' THEN NULLIF(d->>'longitud', '')::numeric ELSE longitud END,
        prioridad     = COALESCE(NULLIF(d->>'prioridad', ''), prioridad),
        cuadrilla_id  = CASE WHEN d ? 'cuadrilla_id' THEN NULLIF(d->>'cuadrilla_id', '')::uuid ELSE cuadrilla_id END,
        tecnico_id    = CASE WHEN d ? 'tecnico_id' THEN NULLIF(d->>'tecnico_id', '')::uuid ELSE tecnico_id END,
        fecha_inicio  = CASE WHEN d ? 'fecha_inicio' THEN NULLIF(d->>'fecha_inicio', '')::date ELSE fecha_inicio END,
        fecha_meta    = CASE WHEN d ? 'fecha_meta' THEN NULLIF(d->>'fecha_meta', '')::date ELSE fecha_meta END,
        meta_metros   = COALESCE(NULLIF(d->>'meta_metros', '')::numeric, meta_metros),
        meta_naps     = COALESCE(NULLIF(d->>'meta_naps', '')::int, meta_naps),
        meta_fusiones = COALESCE(NULLIF(d->>'meta_fusiones', '')::int, meta_fusiones),
        meta_mangas   = COALESCE(NULLIF(d->>'meta_mangas', '')::int, meta_mangas),
        meta_postes   = COALESCE(NULLIF(d->>'meta_postes', '')::int, meta_postes),
        meta_puertos  = COALESCE(NULLIF(d->>'meta_puertos', '')::int, meta_puertos),
        ticket_id     = CASE WHEN d ? 'ticket_id' THEN NULLIF(d->>'ticket_id', '')::uuid ELSE ticket_id END
     WHERE id = v_id
     RETURNING * INTO v_nueva;

    -- ¿Cambió de manos (o es nueva)? Se avisa a los que van.
    IF v_prev.id IS NULL
       OR v_nueva.cuadrilla_id IS DISTINCT FROM v_prev.cuadrilla_id
       OR v_nueva.tecnico_id IS DISTINCT FROM v_prev.tecnico_id THEN
        SELECT COALESCE((SELECT nombre FROM cuadrillas WHERE id = v_nueva.cuadrilla_id),
                        (SELECT nombre FROM tecnicos WHERE id = v_nueva.tecnico_id))
          INTO v_quien;
        INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id)
        VALUES (v_id, 'asignada',
                CASE WHEN v_prev.id IS NULL THEN 'Asignada a ' ELSE 'Reasignada a ' END || COALESCE(v_quien, '—'),
                mi_usuario_id());
        FOR u IN
            SELECT DISTINCT us.id
              FROM usuarios_sistema us
             WHERE us.activo AND us.tecnico_id IS NOT NULL
               AND (us.tecnico_id = v_nueva.tecnico_id
                    OR us.tecnico_id IN (SELECT tecnico_id FROM cuadrilla_miembros
                                          WHERE cuadrilla_id = v_nueva.cuadrilla_id))
        LOOP
            PERFORM notificar(
                u.id, 'obra_asignada',
                'Obra asignada: ' || LEFT(v_nueva.titulo, 80),
                COALESCE(v_nueva.zona || '. ', '')
                    || COALESCE('Meta: ' || to_char(v_nueva.fecha_meta, 'DD/MM') || '. ', '')
                    || 'Revisala en Obras.',
                '/campo/obras?obra=' || v_id::text, 'obra', v_id::text);
        END LOOP;
    END IF;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION guardar_obra(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION guardar_obra(UUID, JSONB) TO authenticated;


-- =============================================================================
-- 7. Lo que hace la cuadrilla
-- =============================================================================
CREATE OR REPLACE FUNCTION obra_abierta_para_mi(p_id UUID)
RETURNS obras_red
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v obras_red%ROWTYPE;
BEGIN
    IF NOT ve_obra(p_id) THEN
        RAISE EXCEPTION 'Esa obra no está asignada a tu cuadrilla.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v FROM obras_red WHERE id = p_id FOR UPDATE;
    IF v.estado NOT IN ('planificada', 'en_curso') THEN
        RAISE EXCEPTION 'Esa obra ya fue entregada o está cerrada.';
    END IF;
    IF v.estado = 'planificada' THEN
        UPDATE obras_red SET estado = 'en_curso', iniciada_at = NOW() WHERE id = p_id;
        INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id, tecnico_id)
        VALUES (p_id, 'iniciada', 'Empezó la obra', mi_usuario_id(), mi_tecnico_id());
        v.estado := 'en_curso';
    END IF;
    RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION obra_abierta_para_mi(UUID) FROM PUBLIC, anon;

/**
 * El parte del día. Cualquiera de la cuadrilla lo manda; el primero pasa la
 * obra a "en curso". Con la misma `p_clave` no se carga dos veces.
 */
CREATE OR REPLACE FUNCTION reportar_avance_obra(p_obra UUID, p_datos JSONB, p_clave UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id   BIGINT;
    d      JSONB := COALESCE(p_datos, '{}'::jsonb);
    v_fecha DATE := COALESCE(NULLIF(d->>'fecha', '')::date, hoy_isp());
    v_fotos TEXT[];
BEGIN
    IF p_clave IS NOT NULL THEN
        SELECT id INTO v_id FROM obra_avances WHERE clave = p_clave;
        IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    END IF;

    PERFORM obra_abierta_para_mi(p_obra);

    IF v_fecha > hoy_isp() OR v_fecha < hoy_isp() - 7 THEN
        RAISE EXCEPTION 'El avance es de hoy o de los últimos 7 días.';
    END IF;

    SELECT COALESCE(array_agg(x), '{}') INTO v_fotos
      FROM jsonb_array_elements_text(COALESCE(d->'fotos', '[]'::jsonb)) x
     WHERE x LIKE p_obra::text || '/%';

    IF COALESCE((d->>'metros')::numeric, 0) = 0 AND COALESCE((d->>'naps')::int, 0) = 0
       AND COALESCE((d->>'fusiones')::int, 0) = 0 AND COALESCE((d->>'mangas')::int, 0) = 0
       AND COALESCE((d->>'postes')::int, 0) = 0 AND COALESCE((d->>'puertos')::int, 0) = 0
       AND NULLIF(BTRIM(d->>'texto'), '') IS NULL THEN
        RAISE EXCEPTION 'Contá qué se hizo: las cantidades del día o una nota.';
    END IF;
    IF COALESCE((d->>'incidente')::boolean, FALSE) AND NULLIF(BTRIM(d->>'incidente_nota'), '') IS NULL THEN
        RAISE EXCEPTION 'Contá qué pasó en el incidente.';
    END IF;

    INSERT INTO obra_avances
        (obra_id, fecha, tecnico_id, usuario_id, metros, naps, fusiones, perdida_fusion_db,
         mangas, postes, puertos, texto, fotos, epp_completo, incidente, incidente_nota, lat, lng, clave)
    VALUES
        (p_obra, v_fecha, mi_tecnico_id(), mi_usuario_id(),
         COALESCE((d->>'metros')::numeric, 0), COALESCE((d->>'naps')::int, 0),
         COALESCE((d->>'fusiones')::int, 0), NULLIF(d->>'perdida_fusion_db', '')::numeric,
         COALESCE((d->>'mangas')::int, 0), COALESCE((d->>'postes')::int, 0),
         COALESCE((d->>'puertos')::int, 0), NULLIF(BTRIM(d->>'texto'), ''), v_fotos,
         COALESCE((d->>'epp_completo')::boolean, TRUE), COALESCE((d->>'incidente')::boolean, FALSE),
         NULLIF(BTRIM(d->>'incidente_nota'), ''),
         NULLIF(d->>'lat', '')::numeric, NULLIF(d->>'lng', '')::numeric, p_clave)
    RETURNING id INTO v_id;

    -- Un incidente de seguridad no espera al informe semanal.
    IF COALESCE((d->>'incidente')::boolean, FALSE) THEN
        PERFORM notificar(us.id, 'obra_incidente',
                  'Incidente en obra: ' || LEFT(o.titulo, 80),
                  LEFT(BTRIM(d->>'incidente_nota'), 200),
                  '/soporte/obras?obra=' || p_obra::text, 'obra', p_obra::text)
           FROM usuarios_sistema us, obras_red o
          WHERE o.id = p_obra AND us.activo
            AND us.id IS DISTINCT FROM mi_usuario_id()
            AND (us.rol IN ('super_admin', 'admin', 'jefe_tecnico')
                 OR us.permisos ? '*' OR us.permisos ? 'soporte.obras');
    END IF;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION reportar_avance_obra(UUID, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reportar_avance_obra(UUID, JSONB, UUID) TO authenticated;

/**
 * Registra (o corrige) una caja NAP de la obra, y la pone en el mapa de la red:
 * si no existe un punto con ese nombre lo crea; si existe, le actualiza la
 * ubicación y la capacidad.
 */
CREATE OR REPLACE FUNCTION registrar_nap_obra(
    p_obra      UUID,
    p_nombre    TEXT,
    p_lat       NUMERIC,
    p_lng       NUMERIC,
    p_puertos   INT,
    p_potencia  NUMERIC,
    p_foto      TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_obra   obras_red%ROWTYPE;
    v_nombre TEXT := UPPER(NULLIF(BTRIM(p_nombre), ''));
    v_punto  UUID;
    v_id     UUID;
BEGIN
    v_obra := obra_abierta_para_mi(p_obra);
    IF v_nombre IS NULL THEN
        RAISE EXCEPTION 'Poné el nombre de la caja, como está rotulada.';
    END IF;
    IF p_foto IS NOT NULL AND p_foto NOT LIKE p_obra::text || '/%' THEN
        RAISE EXCEPTION 'La foto no es de esta obra.';
    END IF;

    SELECT id INTO v_punto FROM puntos_red WHERE UPPER(nombre) = v_nombre LIMIT 1;
    IF v_punto IS NULL THEN
        INSERT INTO puntos_red (nombre, tipo, capacidad, direccion, latitud, longitud, notas)
        VALUES (v_nombre, 'nap', p_puertos, LEFT(v_obra.zona, 300), p_lat, p_lng,
                'Instalada en la obra #' || v_obra.numero)
        RETURNING id INTO v_punto;
    ELSE
        UPDATE puntos_red
           SET latitud   = COALESCE(p_lat, latitud),
               longitud  = COALESCE(p_lng, longitud),
               capacidad = COALESCE(p_puertos, capacidad)
         WHERE id = v_punto;
    END IF;

    INSERT INTO obra_naps (obra_id, punto_id, nombre, latitud, longitud, puertos, potencia_dbm, foto,
                           tecnico_id, usuario_id)
    VALUES (p_obra, v_punto, v_nombre, p_lat, p_lng, p_puertos, p_potencia, p_foto,
            mi_tecnico_id(), mi_usuario_id())
    ON CONFLICT (obra_id, nombre) DO UPDATE
       SET punto_id     = EXCLUDED.punto_id,
           latitud      = COALESCE(EXCLUDED.latitud, obra_naps.latitud),
           longitud     = COALESCE(EXCLUDED.longitud, obra_naps.longitud),
           puertos      = COALESCE(EXCLUDED.puertos, obra_naps.puertos),
           potencia_dbm = COALESCE(EXCLUDED.potencia_dbm, obra_naps.potencia_dbm),
           foto         = COALESCE(EXCLUDED.foto, obra_naps.foto),
           registrada_at = NOW()
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION registrar_nap_obra(UUID, TEXT, NUMERIC, NUMERIC, INT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_nap_obra(UUID, TEXT, NUMERIC, NUMERIC, INT, NUMERIC, TEXT) TO authenticated;

/**
 * El material que se usó. Si es de una línea del presupuesto, se cuenta contra
 * ella. Si el artículo está en el almacén de quien lo carga y alcanza, se
 * descuenta del inventario; si no, queda registrado igual —la obra no espera a
 * que bodega ponga el stock al día— y la pantalla lo marca.
 */
CREATE OR REPLACE FUNCTION registrar_consumo_obra(
    p_obra        UUID,
    p_material    UUID,
    p_cantidad    NUMERIC,
    p_descripcion TEXT DEFAULT NULL,
    p_unidad      TEXT DEFAULT NULL,
    p_articulo    UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_obra    obras_red%ROWTYPE;
    m         obra_materiales%ROWTYPE;
    v_art     UUID := p_articulo;
    v_desc    TEXT := NULLIF(BTRIM(p_descripcion), '');
    v_unidad  TEXT := COALESCE(NULLIF(BTRIM(p_unidad), ''), 'u');
    v_alm     UUID;
    v_stock   NUMERIC;
    v_serie   BOOLEAN;
    v_mov     UUID;
    v_id      BIGINT;
BEGIN
    v_obra := obra_abierta_para_mi(p_obra);
    IF COALESCE(p_cantidad, 0) <= 0 THEN
        RAISE EXCEPTION 'La cantidad tiene que ser mayor que cero.';
    END IF;

    IF p_material IS NOT NULL THEN
        SELECT * INTO m FROM obra_materiales WHERE id = p_material AND obra_id = p_obra;
        IF NOT FOUND THEN RAISE EXCEPTION 'Ese material no está en el presupuesto de la obra.'; END IF;
        v_art := m.articulo_id;
        v_desc := m.descripcion;
        v_unidad := m.unidad;
    ELSIF v_art IS NOT NULL THEN
        SELECT nombre, unidad INTO v_desc, v_unidad FROM articulos WHERE id = v_art;
    END IF;
    IF v_desc IS NULL THEN
        RAISE EXCEPTION 'Decí qué material se usó.';
    END IF;

    -- Del almacén de quien lo carga, si alcanza.
    IF v_art IS NOT NULL THEN
        SELECT a.id INTO v_alm FROM almacenes a WHERE a.tecnico_id = mi_tecnico_id() AND a.activo;
        SELECT por_serie INTO v_serie FROM articulos WHERE id = v_art;
        IF v_alm IS NOT NULL AND NOT COALESCE(v_serie, FALSE) THEN
            SELECT cantidad INTO v_stock FROM existencias WHERE articulo_id = v_art AND almacen_id = v_alm;
            IF COALESCE(v_stock, 0) >= p_cantidad THEN
                INSERT INTO movimientos_inventario
                    (tipo, articulo_id, cantidad, almacen_origen_id, motivo, usuario_id, usuario_nombre)
                VALUES ('consumo', v_art, p_cantidad, v_alm, 'Obra #' || v_obra.numero || ': ' || v_obra.titulo,
                        mi_usuario_id(),
                        (SELECT CONCAT_WS(' ', nombre, apellido) FROM usuarios_sistema WHERE id = mi_usuario_id()))
                RETURNING id INTO v_mov;
            END IF;
        END IF;
    END IF;

    INSERT INTO obra_consumos (obra_id, material_id, articulo_id, descripcion, unidad, cantidad,
                               movimiento_id, tecnico_id, usuario_id)
    VALUES (p_obra, p_material, v_art, LEFT(v_desc, 140), LEFT(v_unidad, 10), p_cantidad,
            v_mov, mi_tecnico_id(), mi_usuario_id())
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'descontado', v_mov IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION registrar_consumo_obra(UUID, UUID, NUMERIC, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_consumo_obra(UUID, UUID, NUMERIC, TEXT, TEXT, UUID) TO authenticated;


-- =============================================================================
-- 8. Entregar, aprobar, devolver, cancelar
-- =============================================================================
/**
 * Lo que le falta a la obra para poder entregarse. Vacío = se puede.
 * Es lo mismo que mira `entregar_obra`; la app lo muestra antes del botón.
 */
CREATE OR REPLACE FUNCTION faltantes_obra(p_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v      obras_red%ROWTYPE;
    f      TEXT[] := '{}';
    v_naps INT;
    v_inc  INT;
BEGIN
    IF NOT ve_obra(p_id) THEN RETURN f; END IF;
    SELECT * INTO v FROM obras_red WHERE id = p_id;

    IF NOT EXISTS (SELECT 1 FROM obra_avances WHERE obra_id = p_id AND cardinality(fotos) > 0) THEN
        f := f || 'Al menos un avance con foto'::text;
    END IF;

    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE latitud IS NULL OR longitud IS NULL OR potencia_dbm IS NULL
                                  OR puertos IS NULL OR foto IS NULL)
      INTO v_naps, v_inc
      FROM obra_naps WHERE obra_id = p_id;

    IF v.meta_naps > 0 AND v_naps < v.meta_naps THEN
        f := f || format('Registrar las cajas NAP: van %s de %s', v_naps, v.meta_naps);
    END IF;
    IF v_inc > 0 THEN
        f := f || format('%s caja(s) NAP sin ubicación, potencia, puertos o foto', v_inc);
    END IF;
    RETURN f;
END;
$$;

GRANT EXECUTE ON FUNCTION faltantes_obra(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION entregar_obra(p_id UUID, p_nota TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v       obras_red%ROWTYPE;
    f       TEXT[];
    v_quien TEXT;
BEGIN
    IF NOT puede_entregar_obra(p_id) THEN
        RAISE EXCEPTION 'La obra la entrega el jefe de grupo de hoy.' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(BTRIM(p_nota), '') IS NULL THEN
        RAISE EXCEPTION 'Contá cómo quedó la obra: es lo que lee la oficina.';
    END IF;

    SELECT * INTO v FROM obras_red WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa obra.'; END IF;
    IF v.estado NOT IN ('planificada', 'en_curso') THEN
        RAISE EXCEPTION 'Esa obra ya fue entregada o está cerrada.';
    END IF;

    f := faltantes_obra(p_id);
    IF cardinality(f) > 0 THEN
        RAISE EXCEPTION 'Falta la documentación: %.', array_to_string(f, '; ');
    END IF;

    UPDATE obras_red
       SET estado = 'entregada', entregada_at = NOW(), entregada_por = mi_usuario_id(),
           entrega_nota = BTRIM(p_nota), iniciada_at = COALESCE(iniciada_at, NOW())
     WHERE id = p_id;
    INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id, tecnico_id)
    VALUES (p_id, 'entregada', BTRIM(p_nota), mi_usuario_id(), mi_tecnico_id());

    SELECT COALESCE((SELECT nombre FROM tecnicos WHERE id = mi_tecnico_id()),
                    (SELECT CONCAT_WS(' ', nombre, apellido) FROM usuarios_sistema WHERE id = mi_usuario_id()))
      INTO v_quien;

    PERFORM notificar(us.id, 'obra_entregada',
              'Obra entregada: ' || LEFT(v.titulo, 80),
              COALESCE(v_quien || ': ', '') || LEFT(BTRIM(p_nota), 200) || ' · Revisala y aprobala.',
              '/soporte/obras?obra=' || p_id::text, 'obra', p_id::text)
       FROM usuarios_sistema us
      WHERE us.activo AND us.id IS DISTINCT FROM mi_usuario_id()
        AND (us.rol IN ('super_admin', 'admin', 'jefe_tecnico')
             OR us.permisos ? '*' OR us.permisos ? 'soporte.obras');
END;
$$;

REVOKE ALL ON FUNCTION entregar_obra(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION entregar_obra(UUID, TEXT) TO authenticated;

/**
 * La oficina revisa: aprueba, o devuelve con lo que falta. Devolverla la vuelve
 * a "en curso" y suma una devolución (retrabajo, entra en los indicadores).
 */
CREATE OR REPLACE FUNCTION revisar_obra(p_id UUID, p_aprobar BOOLEAN, p_nota TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v obras_red%ROWTYPE;
    u RECORD;
    v_tk RECORD;
BEGIN
    IF NOT dirige_obras() THEN
        RAISE EXCEPTION 'La obra la aprueba la oficina.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v FROM obras_red WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa obra.'; END IF;
    IF v.estado <> 'entregada' THEN
        RAISE EXCEPTION 'Solo se revisa una obra entregada.';
    END IF;

    IF p_aprobar THEN
        UPDATE obras_red SET estado = 'aprobada', aprobada_at = NOW(), aprobada_por = mi_usuario_id(),
                             cierre_nota = NULLIF(BTRIM(p_nota), '')
         WHERE id = p_id;
        INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id)
        VALUES (p_id, 'aprobada', COALESCE(NULLIF(BTRIM(p_nota), ''), 'Aprobada'), mi_usuario_id());

        -- La obra salió de un ticket: ya se puede volver a agendar al abonado.
        IF v.ticket_id IS NOT NULL THEN
            SELECT numero, nombre INTO v_tk FROM tickets WHERE id = v.ticket_id;
            PERFORM notificar(us.id, 'obra_aprobada',
                      format('Obra lista: ya se puede reprogramar el ticket #%s · %s', v_tk.numero, v_tk.nombre),
                      LEFT(v.titulo, 150),
                      '/soporte/' || v.ticket_id::text, 'ticket', v.ticket_id::text)
               FROM usuarios_sistema us
              WHERE us.activo AND us.id IS DISTINCT FROM mi_usuario_id()
                AND (us.rol IN ('super_admin', 'admin', 'jefe_tecnico')
                     OR us.permisos ? '*' OR us.permisos ? 'soporte.crear'
                     OR us.permisos ? 'soporte.asignar' OR us.permisos ? 'soporte.ruta');
        END IF;
    ELSE
        IF NULLIF(BTRIM(p_nota), '') IS NULL THEN
            RAISE EXCEPTION 'Decí qué falta o qué hay que corregir.';
        END IF;
        UPDATE obras_red SET estado = 'en_curso', devoluciones = devoluciones + 1,
                             entregada_at = NULL, entregada_por = NULL
         WHERE id = p_id;
        INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id)
        VALUES (p_id, 'devuelta', BTRIM(p_nota), mi_usuario_id());
    END IF;

    -- La cuadrilla se entera de las dos cosas.
    FOR u IN
        SELECT DISTINCT us.id FROM usuarios_sistema us
         WHERE us.activo AND us.tecnico_id IS NOT NULL
           AND (us.tecnico_id = v.tecnico_id
                OR us.tecnico_id IN (SELECT tecnico_id FROM cuadrilla_miembros WHERE cuadrilla_id = v.cuadrilla_id))
    LOOP
        PERFORM notificar(u.id, CASE WHEN p_aprobar THEN 'obra_aprobada' ELSE 'obra_devuelta' END,
            CASE WHEN p_aprobar THEN 'Obra aprobada: ' ELSE 'Obra devuelta: ' END || LEFT(v.titulo, 80),
            COALESCE(NULLIF(BTRIM(p_nota), ''), CASE WHEN p_aprobar THEN 'Buen trabajo.' END),
            '/campo/obras?obra=' || p_id::text, 'obra', p_id::text);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION revisar_obra(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION revisar_obra(UUID, BOOLEAN, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION cancelar_obra(p_id UUID, p_motivo TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT dirige_obras() THEN
        RAISE EXCEPTION 'Solo la oficina cancela una obra.' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(BTRIM(p_motivo), '') IS NULL THEN
        RAISE EXCEPTION 'Decí por qué se cancela.';
    END IF;
    UPDATE obras_red SET estado = 'cancelada', cancelada_at = NOW(), cierre_nota = BTRIM(p_motivo)
     WHERE id = p_id AND estado IN ('planificada', 'en_curso', 'entregada');
    IF NOT FOUND THEN RAISE EXCEPTION 'Esa obra no existe o ya está cerrada.'; END IF;
    INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id)
    VALUES (p_id, 'cancelada', BTRIM(p_motivo), mi_usuario_id());
END;
$$;

REVOKE ALL ON FUNCTION cancelar_obra(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancelar_obra(UUID, TEXT) TO authenticated;


-- =============================================================================
-- 9. Lo que leen las pantallas
-- =============================================================================
DROP VIEW IF EXISTS v_obras_red;
CREATE VIEW v_obras_red AS
SELECT
    o.*,
    cu.nombre AS cuadrilla,
    t.nombre  AS tecnico,
    jt.nombre AS jefe,
    tk.numero AS ticket_numero,
    tk.nombre AS ticket_cliente,
    COALESCE(a.metros, 0)   AS hecho_metros,
    COALESCE(a.naps, 0)     AS hecho_naps,
    COALESCE(a.fusiones, 0) AS hecho_fusiones,
    COALESCE(a.mangas, 0)   AS hecho_mangas,
    COALESCE(a.postes, 0)   AS hecho_postes,
    COALESCE(a.puertos, 0)  AS hecho_puertos,
    COALESCE(a.dias, 0)     AS dias_trabajados,
    a.ultimo_dia,
    COALESCE(n.registradas, 0) AS naps_registradas,
    -- El avance: el promedio de lo hecho sobre cada meta que la obra tiene.
    (SELECT ROUND(AVG(LEAST(x.hecho / x.meta, 1)) * 100)
       FROM (VALUES (COALESCE(a.metros, 0), o.meta_metros),
                    (GREATEST(COALESCE(a.naps, 0), COALESCE(n.registradas, 0))::numeric, o.meta_naps::numeric),
                    (COALESCE(a.fusiones, 0)::numeric, o.meta_fusiones::numeric),
                    (COALESCE(a.mangas, 0)::numeric, o.meta_mangas::numeric),
                    (COALESCE(a.postes, 0)::numeric, o.meta_postes::numeric),
                    (COALESCE(a.puertos, 0)::numeric, o.meta_puertos::numeric)) x(hecho, meta)
      WHERE x.meta > 0) AS avance_pct,
    (o.estado IN ('planificada', 'en_curso') AND o.fecha_meta < hoy_isp()) AS atrasada,
    puede_entregar_obra(o.id) AS puedo_entregar
FROM obras_red o
LEFT JOIN cuadrillas cu ON cu.id = o.cuadrilla_id
LEFT JOIN tecnicos t    ON t.id  = o.tecnico_id
LEFT JOIN tecnicos jt   ON jt.id = jefe_de_grupo(o.cuadrilla_id, hoy_isp())
LEFT JOIN tickets tk    ON tk.id = o.ticket_id
LEFT JOIN LATERAL (
    SELECT SUM(metros) AS metros, SUM(naps) AS naps, SUM(fusiones) AS fusiones, SUM(mangas) AS mangas,
           SUM(postes) AS postes, SUM(puertos) AS puertos, COUNT(DISTINCT fecha) AS dias, MAX(fecha) AS ultimo_dia
      FROM obra_avances WHERE obra_id = o.id
) a ON TRUE
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS registradas FROM obra_naps WHERE obra_id = o.id
) n ON TRUE
WHERE ve_obra(o.id);

COMMENT ON VIEW v_obras_red IS
    'Obras de red con su cuadrilla, el jefe de grupo de hoy, lo hecho contra cada meta, el avance y si quien pregunta puede entregarla.';
GRANT SELECT ON v_obras_red TO authenticated;

DROP VIEW IF EXISTS v_obra_bitacora;
CREATE VIEW v_obra_bitacora AS
SELECT e.id, e.obra_id, e.tipo, e.texto, e.creado_at,
       COALESCE(t.nombre, CONCAT_WS(' ', u.nombre, u.apellido)) AS quien
  FROM obra_eventos e
  LEFT JOIN tecnicos t         ON t.id = e.tecnico_id
  LEFT JOIN usuarios_sistema u ON u.id = e.usuario_id
 WHERE ve_obra(e.obra_id);
GRANT SELECT ON v_obra_bitacora TO authenticated;

DROP VIEW IF EXISTS v_obra_avances;
CREATE VIEW v_obra_avances AS
SELECT a.*, COALESCE(t.nombre, CONCAT_WS(' ', u.nombre, u.apellido)) AS quien
  FROM obra_avances a
  LEFT JOIN tecnicos t         ON t.id = a.tecnico_id
  LEFT JOIN usuarios_sistema u ON u.id = a.usuario_id
 WHERE ve_obra(a.obra_id);
GRANT SELECT ON v_obra_avances TO authenticated;


-- =============================================================================
-- 10. Los indicadores
-- =============================================================================
/**
 * Los ocho indicadores de cada cuadrilla con obras, entre dos fechas.
 *
 * La oficina ve todas; un técnico, solo la suya. Devuelve
 *   { config, cuadrillas: [ { cuadrilla_id, cuadrilla, produccion, plan,
 *     calidad, fallas, material, documentacion, seguridad, apoyo,
 *     por_tecnico, semanas, obras } ] }
 */
CREATE OR REPLACE FUNCTION indicadores_obras(p_desde DATE, p_hasta DATE)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    cfg       obras_config%ROWTYPE;
    c         RECORD;
    v_lista   JSONB := '[]'::jsonb;
    v_miembros UUID[];
    v_prod    JSONB;
    v_plan    JSONB;
    v_cal     JSONB;
    v_fallas  JSONB;
    v_mat     JSONB;
    v_doc     JSONB;
    v_seg     JSONB;
    v_apoyo   JSONB;
    v_tec     JSONB;
    v_sem     JSONB;
    v_obras   JSONB;
    v_dias_obra INT;
    v_dias_tk   INT;
    v_dias_ambos INT;
BEGIN
    IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde THEN
        RAISE EXCEPTION 'Elegí un período válido.';
    END IF;
    SELECT * INTO cfg FROM obras_config WHERE id;

    FOR c IN
        SELECT cu.id, cu.nombre
          FROM cuadrillas cu
         WHERE EXISTS (SELECT 1 FROM obras_red o WHERE o.cuadrilla_id = cu.id AND o.estado <> 'cancelada')
           AND (dirige_obras() OR cu.id IN (SELECT mis_cuadrillas()))
         ORDER BY cu.nombre
    LOOP
        SELECT array_agg(tecnico_id) INTO v_miembros FROM cuadrilla_miembros WHERE cuadrilla_id = c.id;

        -- 1. Producción
        SELECT jsonb_build_object(
                   'metros', COALESCE(SUM(a.metros), 0), 'naps', COALESCE(SUM(a.naps), 0),
                   'fusiones', COALESCE(SUM(a.fusiones), 0), 'mangas', COALESCE(SUM(a.mangas), 0),
                   'postes', COALESCE(SUM(a.postes), 0), 'puertos', COALESCE(SUM(a.puertos), 0),
                   'dias', COUNT(DISTINCT a.fecha),
                   'metros_dia', CASE WHEN COUNT(DISTINCT a.fecha) > 0
                                      THEN ROUND(SUM(a.metros) / COUNT(DISTINCT a.fecha), 1) END,
                   'meta_metros_dia', NULLIF(cfg.meta_metros_dia, 0)),
               COUNT(DISTINCT a.fecha)
          INTO v_prod, v_dias_obra
          FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
         WHERE o.cuadrilla_id = c.id AND a.fecha BETWEEN p_desde AND p_hasta;

        -- 2. Avance vs. plan
        SELECT jsonb_build_object(
                   'entregadas', COUNT(*) FILTER (WHERE (o.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta),
                   'a_tiempo', COUNT(*) FILTER (WHERE (o.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta
                                                  AND (o.fecha_meta IS NULL OR (o.entregada_at AT TIME ZONE zona_horaria())::date <= o.fecha_meta)),
                   'abiertas', COUNT(*) FILTER (WHERE o.estado IN ('planificada', 'en_curso')),
                   'atrasadas', COUNT(*) FILTER (WHERE o.estado IN ('planificada', 'en_curso') AND o.fecha_meta < hoy_isp()),
                   'avance_promedio', ROUND(AVG(v.avance_pct) FILTER (WHERE o.estado IN ('planificada', 'en_curso'))),
                   'meta_a_tiempo_pct', cfg.meta_a_tiempo_pct)
          INTO v_plan
          FROM obras_red o JOIN v_obras_red v ON v.id = o.id
         WHERE o.cuadrilla_id = c.id AND o.estado <> 'cancelada';

        -- 3. Calidad óptica
        SELECT jsonb_build_object(
                   'naps_medidas', COUNT(*) FILTER (WHERE n.potencia_dbm IS NOT NULL),
                   'naps_ok', COUNT(*) FILTER (WHERE n.potencia_dbm >= cfg.potencia_min_dbm),
                   'potencia_promedio', ROUND(AVG(n.potencia_dbm), 2),
                   'potencia_peor', MIN(n.potencia_dbm),
                   'potencia_min_dbm', cfg.potencia_min_dbm)
          INTO v_cal
          FROM obra_naps n JOIN obras_red o ON o.id = n.obra_id
         WHERE o.cuadrilla_id = c.id
           AND (n.registrada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta;

        SELECT v_cal || jsonb_build_object(
                   'fusiones_medidas', COALESCE(SUM(a.fusiones) FILTER (WHERE a.perdida_fusion_db IS NOT NULL), 0),
                   'perdida_promedio', ROUND(SUM(a.perdida_fusion_db * a.fusiones) FILTER (WHERE a.perdida_fusion_db IS NOT NULL)
                                             / NULLIF(SUM(a.fusiones) FILTER (WHERE a.perdida_fusion_db IS NOT NULL), 0), 3),
                   'dias_fusion_ok', COUNT(*) FILTER (WHERE a.perdida_fusion_db IS NOT NULL AND a.perdida_fusion_db <= cfg.perdida_fusion_max_db),
                   'dias_fusion_medidos', COUNT(*) FILTER (WHERE a.perdida_fusion_db IS NOT NULL),
                   'perdida_max_db', cfg.perdida_fusion_max_db)
          INTO v_cal
          FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
         WHERE o.cuadrilla_id = c.id AND a.fecha BETWEEN p_desde AND p_hasta AND a.fusiones > 0;

        -- 4. Fallas en los primeros N días de lo que entregaron. Se miran las
        --    obras entregadas en el período; las fallas pueden caer después.
        SELECT jsonb_build_object(
                   'obras', COUNT(DISTINCT o.id),
                   'naps', COUNT(DISTINCT n.punto_id),
                   'fallas', (SELECT COUNT(DISTINCT tk.id)
                                FROM obras_red o2
                                JOIN obra_naps n2 ON n2.obra_id = o2.id AND n2.punto_id IS NOT NULL
                                JOIN tickets tk ON (tk.nap_id = n2.punto_id
                                                    OR tk.client_id IN (SELECT id FROM clientes WHERE nap_id = n2.punto_id))
                               WHERE o2.cuadrilla_id = c.id
                                 AND (o2.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta
                                 AND tk.created_at >= o2.entregada_at
                                 AND tk.created_at < o2.entregada_at + make_interval(days => cfg.dias_fallas)
                                 AND tk.tipo_incidencia IN ('sin_internet', 'intermitencia', 'fibra_cortada', 'potencia_baja')
                                 AND tk.estado <> 'cancelado'),
                   'clientes_conectados', (SELECT COUNT(*) FROM clientes cl
                                            WHERE cl.nap_id IN (SELECT n3.punto_id FROM obra_naps n3 JOIN obras_red o3 ON o3.id = n3.obra_id
                                                                 WHERE o3.cuadrilla_id = c.id
                                                                   AND (o3.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta)),
                   'puertos', COALESCE(SUM(n.puertos), 0),
                   'dias', cfg.dias_fallas)
          INTO v_fallas
          FROM obras_red o
          LEFT JOIN obra_naps n ON n.obra_id = o.id
         WHERE o.cuadrilla_id = c.id
           AND (o.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta;

        -- 5. Material: obras entregadas en el período, cada línea contra su
        --    presupuesto.
        SELECT jsonb_build_object(
                   'lineas', COUNT(*),
                   'desvio_pct', ROUND((AVG(x.usado / x.presupuesto) - 1) * 100, 1),
                   'lineas_excedidas', COUNT(*) FILTER (WHERE x.usado > x.presupuesto * (1 + cfg.merma_max_pct / 100)),
                   'extras', (SELECT COUNT(*) FROM obra_consumos k JOIN obras_red o4 ON o4.id = k.obra_id
                               WHERE o4.cuadrilla_id = c.id AND k.material_id IS NULL
                                 AND (o4.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta),
                   'merma_max_pct', cfg.merma_max_pct)
          INTO v_mat
          FROM (SELECT m.presupuesto, COALESCE((SELECT SUM(k.cantidad) FROM obra_consumos k WHERE k.material_id = m.id), 0) AS usado
                  FROM obra_materiales m JOIN obras_red o ON o.id = m.obra_id
                 WHERE o.cuadrilla_id = c.id
                   AND (o.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta) x;

        -- 6. Documentación
        SELECT jsonb_build_object(
                   'dias', COUNT(DISTINCT (a.obra_id, a.fecha)),
                   'dias_con_foto', COUNT(DISTINCT (a.obra_id, a.fecha)) FILTER (WHERE cardinality(a.fotos) > 0))
          INTO v_doc
          FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
         WHERE o.cuadrilla_id = c.id AND a.fecha BETWEEN p_desde AND p_hasta;

        SELECT v_doc || jsonb_build_object(
                   'revisadas', COUNT(*) FILTER (WHERE o.estado = 'aprobada'),
                   'a_la_primera', COUNT(*) FILTER (WHERE o.estado = 'aprobada' AND o.devoluciones = 0),
                   'devoluciones', COALESCE(SUM(o.devoluciones), 0))
          INTO v_doc
          FROM obras_red o
         WHERE o.cuadrilla_id = c.id
           AND ((o.aprobada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta
                OR (o.estado = 'en_curso' AND o.devoluciones > 0));

        -- 7. Seguridad
        SELECT jsonb_build_object(
                   'partes', COUNT(*),
                   'con_epp', COUNT(*) FILTER (WHERE a.epp_completo),
                   'incidentes', COUNT(*) FILTER (WHERE a.incidente),
                   'detalle', COALESCE(jsonb_agg(jsonb_build_object('fecha', a.fecha, 'nota', a.incidente_nota)
                                       ORDER BY a.fecha) FILTER (WHERE a.incidente), '[]'::jsonb))
          INTO v_seg
          FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
         WHERE o.cuadrilla_id = c.id AND a.fecha BETWEEN p_desde AND p_hasta;

        -- 8. Apoyo a soporte: los días con tickets cerrados, frente a los días
        --    de obra. Un día con las dos cosas cuenta medio y medio.
        WITH tk AS (
            SELECT DISTINCT (t.cerrado_at AT TIME ZONE zona_horaria())::date AS dia
              FROM tickets t
             WHERE t.estado = 'resuelto' AND t.cerrado_at IS NOT NULL
               AND (t.cuadrilla_id = c.id OR t.tecnico_id = ANY (COALESCE(v_miembros, '{}')))
               AND (t.cerrado_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta
        ), ob AS (
            SELECT DISTINCT a.fecha AS dia
              FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
             WHERE o.cuadrilla_id = c.id AND a.fecha BETWEEN p_desde AND p_hasta
        )
        SELECT (SELECT COUNT(*) FROM tk), (SELECT COUNT(*) FROM tk WHERE dia IN (SELECT dia FROM ob))
          INTO v_dias_tk, v_dias_ambos;

        SELECT jsonb_build_object(
                   'tickets', COUNT(*),
                   'dias_tickets', v_dias_tk,
                   'dias_obra', v_dias_obra,
                   'pct', CASE WHEN v_dias_tk + v_dias_obra - v_dias_ambos > 0
                               THEN ROUND((v_dias_tk - v_dias_ambos * 0.5) * 100.0
                                          / (v_dias_tk + v_dias_obra - v_dias_ambos)) END,
                   'apoyo_max_pct', cfg.apoyo_max_pct)
          INTO v_apoyo
          FROM tickets t
         WHERE t.estado = 'resuelto' AND t.cerrado_at IS NOT NULL
           AND (t.cuadrilla_id = c.id OR t.tecnico_id = ANY (COALESCE(v_miembros, '{}')))
           AND (t.cerrado_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta;

        -- Quién reportó qué.
        SELECT COALESCE(jsonb_agg(x ORDER BY x.metros DESC), '[]'::jsonb) INTO v_tec
          FROM (SELECT COALESCE(t.nombre, '—') AS nombre, SUM(a.metros) AS metros, SUM(a.naps) AS naps,
                       SUM(a.fusiones) AS fusiones, COUNT(DISTINCT a.fecha) AS dias
                  FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
                  LEFT JOIN tecnicos t ON t.id = a.tecnico_id
                 WHERE o.cuadrilla_id = c.id AND a.fecha BETWEEN p_desde AND p_hasta
                 GROUP BY t.nombre) x;

        -- Semana a semana.
        SELECT COALESCE(jsonb_agg(x ORDER BY x.semana), '[]'::jsonb) INTO v_sem
          FROM (SELECT date_trunc('week', a.fecha)::date AS semana, SUM(a.metros) AS metros,
                       SUM(a.naps) AS naps, SUM(a.fusiones) AS fusiones, COUNT(DISTINCT a.fecha) AS dias
                  FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
                 WHERE o.cuadrilla_id = c.id AND a.fecha BETWEEN p_desde AND p_hasta
                 GROUP BY 1) x;

        -- Las obras: abiertas, y las cerradas en el período.
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'id', v.id, 'numero', v.numero, 'titulo', v.titulo, 'estado', v.estado,
                   'fecha_meta', v.fecha_meta, 'avance_pct', v.avance_pct, 'atrasada', v.atrasada,
                   'devoluciones', v.devoluciones) ORDER BY v.numero DESC), '[]'::jsonb)
          INTO v_obras
          FROM v_obras_red v
         WHERE v.cuadrilla_id = c.id
           AND (v.estado IN ('planificada', 'en_curso', 'entregada')
                OR (v.estado = 'aprobada' AND (v.aprobada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta));

        v_lista := v_lista || jsonb_build_object(
            'cuadrilla_id', c.id, 'cuadrilla', c.nombre,
            'produccion', v_prod, 'plan', v_plan, 'calidad', v_cal, 'fallas', v_fallas,
            'material', v_mat, 'documentacion', v_doc, 'seguridad', v_seg, 'apoyo', v_apoyo,
            'por_tecnico', v_tec, 'semanas', v_sem, 'obras', v_obras);
    END LOOP;

    RETURN jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'config', to_jsonb(cfg), 'cuadrillas', v_lista);
END;
$$;

REVOKE ALL ON FUNCTION indicadores_obras(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION indicadores_obras(DATE, DATE) TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT numero, titulo, estado, avance_pct, atrasada FROM v_obras_red ORDER BY numero DESC;
--   SELECT jsonb_pretty(indicadores_obras(date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE));
--   -- (desde el SQL Editor no hay sesión: devuelve solo lo que ve un anónimo.)
