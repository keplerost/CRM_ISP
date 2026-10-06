-- =============================================================================
-- Migración 209 — La reparación de red, y quién la cierra
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 174 (cortes masivos), la 207 (NAP degradándose) y la 208 (jefe
-- de grupo).
--
-- ── Qué resuelve ──
--
-- 1. "NOVEDADES DE RED" SOLO MOSTRABA NODOS QUE NO RESPONDEN AL PING. Una fibra
--    troncal cortada no responde ni deja de responder: no aparecía nunca. Ahora
--    la línea de tiempo suma los cortes masivos abiertos (fibra rota, enlace
--    caído, energía), los cortes agrupados que detecta la OLT (varias ONTs de
--    una caja que se apagan juntas) y las cajas NAP degradándose.
--
-- 2. LA REPARACIÓN NO TENÍA DUEÑO. La oficina abría el corte masivo y nadie
--    quedaba a cargo de arreglarlo. Ahora administración o un jefe técnico le
--    asigna la REPARACIÓN a una cuadrilla (o a un técnico suelto). Les llega a
--    la campana y la ven en la app de campo.
--
-- 3. EL QUE ESTÁ EN EL POSTE ES EL QUE SABE CUÁNDO QUEDÓ. Cualquier integrante
--    de la cuadrilla reporta avances ("llegamos", "falta empalmar 2 hilos"). El
--    JEFE DE GRUPO del día la cierra como reparada. Si la reparación salió de
--    un corte masivo abierto, cerrarla lo resuelve y sale el "ya está" a los
--    abonados que habían recibido el aviso.
--
-- ── Por qué una tabla propia y no un ticket ──
--
-- El ticket es de un abonado: pide firma de conformidad, checklist de domicilio
-- y cuenta para el desempeño por visita. Una fibra troncal no tiene a nadie que
-- firme, y meterla ahí obligaba a inventar un abonado o a saltear la firma.
--
-- ── Quién puede qué ──
--
--   · Asignar, reasignar o cancelar: super administrador, administrador y jefe
--     técnico (`dirige_cuadrillas()`, de la 208).
--   · Reportar avances: cualquiera de la cuadrilla asignada, o el técnico
--     asignado.
--   · Cerrar como reparada: el jefe de grupo del día (o su reemplazo). Si la
--     cuadrilla no tiene jefe definido, cualquiera de ella. Y siempre la oficina.
-- =============================================================================


-- =============================================================================
-- 1. La reparación y su bitácora
-- =============================================================================
CREATE TABLE IF NOT EXISTS reparaciones_red (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Para decirlo por radio: "la reparación 14".
    numero        BIGSERIAL,

    -- De dónde salió. Las dos pueden ir vacías: una reparación que la oficina
    -- carga a mano ("cambiar el poste caído de la calle 5") no viene de ninguna
    -- alerta.
    incidencia_id UUID REFERENCES incidencias_masivas(id) ON DELETE SET NULL,
    alerta_id     UUID REFERENCES alerta_eventos(id) ON DELETE SET NULL,

    -- Lo que se copia al asignar. La alerta la lee solo quien configura
    -- alertas; el técnico tiene que poder ver qué le mandaron a arreglar.
    tipo          VARCHAR(20) NOT NULL DEFAULT 'averia',
    titulo        VARCHAR(150) NOT NULL,
    lugar         VARCHAR(150),
    afectados     INT,
    instrucciones TEXT,
    prioridad     VARCHAR(10) NOT NULL DEFAULT 'alta'
                  CHECK (prioridad IN ('alta', 'media', 'baja')),

    cuadrilla_id  UUID REFERENCES cuadrillas(id) ON DELETE SET NULL,
    tecnico_id    UUID REFERENCES tecnicos(id) ON DELETE SET NULL,

    estado        VARCHAR(12) NOT NULL DEFAULT 'asignada'
                  CHECK (estado IN ('asignada', 'en_curso', 'reparada', 'cancelada')),

    asignada_por  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creada_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    iniciada_at   TIMESTAMPTZ,
    cerrada_at    TIMESTAMPTZ,
    cerrada_por   UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    cierre_nota   TEXT,

    CONSTRAINT reparacion_con_responsable CHECK (cuadrilla_id IS NOT NULL OR tecnico_id IS NOT NULL)
);

-- Una sola reparación en marcha por corte y por alerta: asignarla otra vez es
-- reasignarla, no abrir una segunda que nadie va a cerrar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reparacion_una_por_incidencia
    ON reparaciones_red (incidencia_id)
    WHERE incidencia_id IS NOT NULL AND estado IN ('asignada', 'en_curso');
CREATE UNIQUE INDEX IF NOT EXISTS idx_reparacion_una_por_alerta
    ON reparaciones_red (alerta_id)
    WHERE alerta_id IS NOT NULL AND estado IN ('asignada', 'en_curso');
CREATE INDEX IF NOT EXISTS idx_reparaciones_abiertas
    ON reparaciones_red (creada_at DESC) WHERE estado IN ('asignada', 'en_curso');

COMMENT ON TABLE reparaciones_red IS
    'Orden de reparación de red (fibra, enlace, caja NAP) asignada a una cuadrilla. La cierra el jefe de grupo; si viene de un corte masivo abierto, cerrarla lo resuelve.';

CREATE TABLE IF NOT EXISTS reparacion_reportes (
    id            BIGSERIAL PRIMARY KEY,
    reparacion_id UUID NOT NULL REFERENCES reparaciones_red(id) ON DELETE CASCADE,
    tipo          VARCHAR(12) NOT NULL DEFAULT 'avance'
                  CHECK (tipo IN ('asignada', 'avance', 'reparada', 'cancelada')),
    texto         TEXT,
    usuario_id    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    tecnico_id    UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    lat           NUMERIC(10,7),
    lng           NUMERIC(10,7),
    creado_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reparacion_reportes
    ON reparacion_reportes (reparacion_id, creado_at);


-- =============================================================================
-- 2. Quién la ve y quién la cierra
-- =============================================================================
/** El legajo de quien pregunta. NULL sin sesión o sin legajo. */
CREATE OR REPLACE FUNCTION mi_usuario_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION mi_usuario_id() TO authenticated;

CREATE OR REPLACE FUNCTION ve_reparacion(p_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT dirige_cuadrillas() OR EXISTS (
        SELECT 1 FROM reparaciones_red r
         WHERE r.id = p_id
           AND ((r.tecnico_id IS NOT NULL AND r.tecnico_id = mi_tecnico_id())
             OR (r.cuadrilla_id IS NOT NULL AND r.cuadrilla_id IN (SELECT mis_cuadrillas())))
    )
$$;

GRANT EXECUTE ON FUNCTION ve_reparacion(UUID) TO authenticated;

/**
 * ¿Quien pregunta puede cerrarla como reparada?
 *
 * La oficina siempre. En el campo: el técnico asignado, o el jefe de grupo de
 * HOY de la cuadrilla asignada (el reemplazo del día, si lo hay). Una cuadrilla
 * sin jefe definido no deja a nadie bloqueado: cierra cualquiera de ella.
 */
CREATE OR REPLACE FUNCTION puede_cerrar_reparacion(p_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT dirige_cuadrillas() OR EXISTS (
        SELECT 1 FROM reparaciones_red r
         WHERE r.id = p_id
           AND ((r.tecnico_id IS NOT NULL AND r.tecnico_id = mi_tecnico_id())
             OR (r.cuadrilla_id IS NOT NULL
                 AND r.cuadrilla_id IN (SELECT mis_cuadrillas())
                 AND COALESCE(jefe_de_grupo(r.cuadrilla_id, (NOW() AT TIME ZONE zona_horaria())::date),
                              mi_tecnico_id()) = mi_tecnico_id()))
    )
$$;

GRANT EXECUTE ON FUNCTION puede_cerrar_reparacion(UUID) TO authenticated;

-- Solo se LEEN desde el navegador. Asignar, reportar y cerrar van por las
-- funciones de abajo, que son las que controlan quién y avisan a quien toca.
ALTER TABLE reparaciones_red    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reparacion_reportes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reparaciones_leer ON reparaciones_red;
CREATE POLICY reparaciones_leer ON reparaciones_red
    FOR SELECT TO authenticated USING (ve_reparacion(id));

DROP POLICY IF EXISTS reparacion_reportes_leer ON reparacion_reportes;
CREATE POLICY reparacion_reportes_leer ON reparacion_reportes
    FOR SELECT TO authenticated USING (ve_reparacion(reparacion_id));


-- =============================================================================
-- 3. Asignar (o reasignar)
-- =============================================================================
/**
 * Le asigna la reparación a una cuadrilla o a un técnico.
 *
 * Si el corte o la alerta ya tiene una en marcha, la REASIGNA en vez de abrir
 * otra: dos órdenes por la misma fibra son dos cuadrillas en el mismo poste.
 *
 * Avisa a la campana de cada integrante. Devuelve el id de la reparación.
 */
CREATE OR REPLACE FUNCTION asignar_reparacion(
    p_incidencia    UUID DEFAULT NULL,
    p_alerta        UUID DEFAULT NULL,
    p_cuadrilla     UUID DEFAULT NULL,
    p_tecnico       UUID DEFAULT NULL,
    p_titulo        TEXT DEFAULT NULL,
    p_instrucciones TEXT DEFAULT NULL,
    p_prioridad     TEXT DEFAULT 'alta'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id     UUID;
    v_tipo   TEXT := 'averia';
    v_titulo TEXT := NULLIF(BTRIM(p_titulo), '');
    v_lugar  TEXT;
    v_afect  INT;
    v_quien  TEXT;
    v_previo reparaciones_red%ROWTYPE;
    u        RECORD;
BEGIN
    IF NOT dirige_cuadrillas() THEN
        RAISE EXCEPTION 'Solo administración o un jefe técnico asigna reparaciones.' USING ERRCODE = '42501';
    END IF;
    IF p_cuadrilla IS NULL AND p_tecnico IS NULL THEN
        RAISE EXCEPTION 'Elegí la cuadrilla (o el técnico) que va a reparar.';
    END IF;
    IF COALESCE(p_prioridad, 'alta') NOT IN ('alta', 'media', 'baja') THEN
        RAISE EXCEPTION 'Prioridad desconocida: %', p_prioridad;
    END IF;

    -- Lo que se copia del origen.
    IF p_incidencia IS NOT NULL THEN
        SELECT i.tipo, i.titulo,
               COALESCE(i.zona, p.nombre, n.nombre, o.nombre || COALESCE(' · PON ' || i.puerto_pon, ''), r.nombre),
               i.afectados
          INTO v_tipo, v_titulo, v_lugar, v_afect
          FROM incidencias_masivas i
          LEFT JOIN puntos_red p       ON p.id = i.punto_id
          LEFT JOIN nodos_red n        ON n.id = i.nodo_id
          LEFT JOIN olts o             ON o.id = i.olt_id
          LEFT JOIN routers_mikrotik r ON r.id = i.router_id
         WHERE i.id = p_incidencia;
        IF NOT FOUND THEN RAISE EXCEPTION 'No existe ese corte masivo.'; END IF;
        v_titulo := COALESCE(NULLIF(BTRIM(p_titulo), ''), v_titulo);
        SELECT * INTO v_previo FROM reparaciones_red
         WHERE incidencia_id = p_incidencia AND estado IN ('asignada', 'en_curso');

    ELSIF p_alerta IS NOT NULL THEN
        SELECT CASE e.regla WHEN 'degradacion' THEN 'nap_degradada' ELSE e.regla END,
               CASE e.regla
                    WHEN 'corte_grupo' THEN 'Posible daño de fibra: ' || COALESCE(e.etiqueta, 'grupo') || ' sin señal'
                    WHEN 'degradacion' THEN COALESCE(e.etiqueta, 'Caja NAP') || ': revisar la caja (potencia degradándose)'
                    ELSE COALESCE(e.etiqueta, e.regla) END,
               COALESCE(e.zona, e.detalle->>'direccion'),
               e.abonados
          INTO v_tipo, v_titulo, v_lugar, v_afect
          FROM alerta_eventos e
         WHERE e.id = p_alerta;
        IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa alerta.'; END IF;
        v_titulo := COALESCE(NULLIF(BTRIM(p_titulo), ''), v_titulo);
        SELECT * INTO v_previo FROM reparaciones_red
         WHERE alerta_id = p_alerta AND estado IN ('asignada', 'en_curso');
    END IF;

    IF v_titulo IS NULL THEN
        RAISE EXCEPTION 'Escribí qué hay que reparar.';
    END IF;

    SELECT COALESCE((SELECT nombre FROM cuadrillas WHERE id = p_cuadrilla),
                    (SELECT nombre FROM tecnicos WHERE id = p_tecnico))
      INTO v_quien;

    IF v_previo.id IS NOT NULL THEN
        UPDATE reparaciones_red
           SET cuadrilla_id  = p_cuadrilla,
               tecnico_id    = p_tecnico,
               prioridad     = COALESCE(p_prioridad, prioridad),
               instrucciones = COALESCE(NULLIF(BTRIM(p_instrucciones), ''), instrucciones),
               titulo        = v_titulo
         WHERE id = v_previo.id;
        v_id := v_previo.id;
    ELSE
        INSERT INTO reparaciones_red
            (incidencia_id, alerta_id, tipo, titulo, lugar, afectados, instrucciones,
             prioridad, cuadrilla_id, tecnico_id, asignada_por)
        VALUES
            (p_incidencia, CASE WHEN p_incidencia IS NULL THEN p_alerta END, v_tipo,
             LEFT(v_titulo, 150), LEFT(v_lugar, 150), v_afect, NULLIF(BTRIM(p_instrucciones), ''),
             COALESCE(p_prioridad, 'alta'), p_cuadrilla, p_tecnico, mi_usuario_id())
        RETURNING id INTO v_id;
    END IF;

    INSERT INTO reparacion_reportes (reparacion_id, tipo, texto, usuario_id)
    VALUES (v_id, 'asignada',
            CASE WHEN v_previo.id IS NOT NULL THEN 'Reasignada a ' ELSE 'Asignada a ' END || COALESCE(v_quien, '—'),
            mi_usuario_id());

    -- La campana de cada uno de los que van.
    FOR u IN
        SELECT DISTINCT us.id
          FROM usuarios_sistema us
         WHERE us.activo AND us.tecnico_id IS NOT NULL
           AND (us.tecnico_id = p_tecnico
                OR us.tecnico_id IN (SELECT tecnico_id FROM cuadrilla_miembros WHERE cuadrilla_id = p_cuadrilla))
    LOOP
        PERFORM notificar(
            u.id, 'reparacion_red',
            'Reparación asignada: ' || LEFT(v_titulo, 80),
            COALESCE(v_lugar || '. ', '') || COALESCE(NULLIF(BTRIM(p_instrucciones), ''), 'Revisala en Estado de la red.'),
            '/campo/red', 'reparacion', v_id::text);
    END LOOP;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION asignar_reparacion(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION asignar_reparacion(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) TO authenticated;


-- =============================================================================
-- 4. Reportar un avance
-- =============================================================================
/**
 * "Llegamos", "el corte está a 300 m del poste 14", "falta un empalme".
 *
 * Lo puede escribir cualquiera de la cuadrilla. El primero pasa la reparación a
 * "en curso": es la señal para la oficina de que alguien ya está ahí.
 */
CREATE OR REPLACE FUNCTION reportar_reparacion(
    p_id    UUID,
    p_texto TEXT,
    p_lat   NUMERIC DEFAULT NULL,
    p_lng   NUMERIC DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v reparaciones_red%ROWTYPE;
BEGIN
    IF NOT ve_reparacion(p_id) THEN
        RAISE EXCEPTION 'Esa reparación no está asignada a tu cuadrilla.' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(BTRIM(p_texto), '') IS NULL THEN
        RAISE EXCEPTION 'Escribí qué encontraron o qué hicieron.';
    END IF;

    SELECT * INTO v FROM reparaciones_red WHERE id = p_id FOR UPDATE;
    IF v.estado NOT IN ('asignada', 'en_curso') THEN
        RAISE EXCEPTION 'Esa reparación ya está cerrada.';
    END IF;

    INSERT INTO reparacion_reportes (reparacion_id, tipo, texto, usuario_id, tecnico_id, lat, lng)
    VALUES (p_id, 'avance', BTRIM(p_texto), mi_usuario_id(), mi_tecnico_id(), p_lat, p_lng);

    IF v.estado = 'asignada' THEN
        UPDATE reparaciones_red SET estado = 'en_curso', iniciada_at = NOW() WHERE id = p_id;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION reportar_reparacion(UUID, TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reportar_reparacion(UUID, TEXT, NUMERIC, NUMERIC) TO authenticated;


-- =============================================================================
-- 5. Cerrarla como reparada
-- =============================================================================
/**
 * El jefe de grupo dice "quedó".
 *
 * Si la reparación vino de un corte masivo ABIERTO, lo resuelve con la misma
 * función de la 174: se encola el "ya está" para los abonados que habían
 * recibido el aviso, y sale con el próximo latido del middleware.
 *
 * Una alerta (corte agrupado, NAP degradándose) NO se cierra acá: la cierran
 * las lecturas cuando las ONTs vuelven o la potencia se normaliza. Si se cerrara
 * a mano, una reparación mal hecha borraría la única prueba de que sigue mal.
 *
 * Avisa a la oficina por la campana.
 */
CREATE OR REPLACE FUNCTION cerrar_reparacion(
    p_id   UUID,
    p_nota TEXT,
    p_lat  NUMERIC DEFAULT NULL,
    p_lng  NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v          reparaciones_red%ROWTYPE;
    v_corte    TEXT;
    v_res      JSONB;
    v_quien    TEXT;
    u          RECORD;
BEGIN
    IF NOT puede_cerrar_reparacion(p_id) THEN
        RAISE EXCEPTION 'La reparación la cierra el jefe de grupo de hoy.' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(BTRIM(p_nota), '') IS NULL THEN
        RAISE EXCEPTION 'Contá qué se reparó: es lo que lee la oficina.';
    END IF;

    SELECT * INTO v FROM reparaciones_red WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa reparación.'; END IF;
    IF v.estado NOT IN ('asignada', 'en_curso') THEN
        RAISE EXCEPTION 'Esa reparación ya está cerrada.';
    END IF;

    UPDATE reparaciones_red
       SET estado      = 'reparada',
           cerrada_at  = NOW(),
           cerrada_por = mi_usuario_id(),
           cierre_nota = BTRIM(p_nota),
           iniciada_at = COALESCE(iniciada_at, NOW())
     WHERE id = p_id;

    INSERT INTO reparacion_reportes (reparacion_id, tipo, texto, usuario_id, tecnico_id, lat, lng)
    VALUES (p_id, 'reparada', BTRIM(p_nota), mi_usuario_id(), mi_tecnico_id(), p_lat, p_lng);

    IF v.incidencia_id IS NOT NULL THEN
        SELECT estado INTO v_corte FROM incidencias_masivas WHERE id = v.incidencia_id;
        IF v_corte = 'abierta' THEN
            v_res := resolver_incidencia(v.incidencia_id, mi_usuario_id());
        END IF;
    END IF;

    SELECT COALESCE((SELECT nombre FROM tecnicos WHERE id = mi_tecnico_id()),
                    (SELECT CONCAT_WS(' ', nombre, apellido) FROM usuarios_sistema WHERE id = mi_usuario_id()))
      INTO v_quien;

    FOR u IN
        SELECT id FROM usuarios_sistema
         WHERE activo AND rol IN ('super_admin', 'admin', 'jefe_tecnico')
           AND id IS DISTINCT FROM mi_usuario_id()
    LOOP
        PERFORM notificar(
            u.id, 'reparacion_cerrada',
            'Reparada: ' || LEFT(v.titulo, 90),
            COALESCE(v_quien || ': ', '') || LEFT(BTRIM(p_nota), 200)
                || CASE WHEN v_res IS NOT NULL THEN ' · Se resolvió el corte masivo y salen los avisos de restablecimiento.' ELSE '' END,
            '/monitoreo/incidencias', 'reparacion', p_id::text);
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'corte_resuelto', v_res IS NOT NULL,
        'avisos', COALESCE((v_res->>'encolados')::int, 0),
        -- El corte quedó en borrador: nunca se avisó, así que no hay "ya está"
        -- que mandar. Lo cancela la oficina.
        'corte_en_borrador', v_corte = 'borrador'
    );
END;
$$;

REVOKE ALL ON FUNCTION cerrar_reparacion(UUID, TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cerrar_reparacion(UUID, TEXT, NUMERIC, NUMERIC) TO authenticated;

/** Para la que se asignó por error o ya no hace falta. Solo la oficina. */
CREATE OR REPLACE FUNCTION cancelar_reparacion(p_id UUID, p_motivo TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT dirige_cuadrillas() THEN
        RAISE EXCEPTION 'Solo administración o un jefe técnico cancela una reparación.' USING ERRCODE = '42501';
    END IF;

    UPDATE reparaciones_red
       SET estado = 'cancelada', cerrada_at = NOW(), cerrada_por = mi_usuario_id(),
           cierre_nota = NULLIF(BTRIM(p_motivo), '')
     WHERE id = p_id AND estado IN ('asignada', 'en_curso');
    IF NOT FOUND THEN RAISE EXCEPTION 'Esa reparación no existe o ya está cerrada.'; END IF;

    INSERT INTO reparacion_reportes (reparacion_id, tipo, texto, usuario_id)
    VALUES (p_id, 'cancelada', COALESCE(NULLIF(BTRIM(p_motivo), ''), 'Cancelada'), mi_usuario_id());
END;
$$;

REVOKE ALL ON FUNCTION cancelar_reparacion(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancelar_reparacion(UUID, TEXT) TO authenticated;


-- =============================================================================
-- 6. Lo que leen las pantallas
-- =============================================================================
-- Vistas con los permisos del dueño y el filtro escrito adentro, igual que
-- `v_novedades_red`: el técnico tiene que ver si la alerta de origen sigue
-- abierta, y `alerta_eventos` no la puede leer directo.
DROP VIEW IF EXISTS v_reparaciones_red;
CREATE VIEW v_reparaciones_red AS
SELECT
    r.*,
    cu.nombre AS cuadrilla,
    t.nombre  AS tecnico,
    jt.nombre AS jefe,
    us.nombre AS asignada_por_nombre,
    i.estado  AS corte_estado,
    i.afectados AS corte_afectados,
    e.regla   AS alerta_regla,
    -- ¿El problema sigue? NULL si la reparación no vino de ningún lado.
    CASE
        WHEN r.incidencia_id IS NOT NULL THEN i.estado IN ('borrador', 'abierta')
        WHEN r.alerta_id IS NOT NULL THEN e.resuelto_en IS NULL
    END AS origen_activo,
    ult.texto     AS ultimo_reporte,
    ult.creado_at AS ultimo_reporte_at,
    ult.quien     AS ultimo_reporte_de,
    puede_cerrar_reparacion(r.id) AS puedo_cerrar
FROM reparaciones_red r
LEFT JOIN cuadrillas cu        ON cu.id = r.cuadrilla_id
LEFT JOIN tecnicos t           ON t.id  = r.tecnico_id
LEFT JOIN tecnicos jt          ON jt.id = jefe_de_grupo(r.cuadrilla_id, (NOW() AT TIME ZONE zona_horaria())::date)
LEFT JOIN usuarios_sistema us  ON us.id = r.asignada_por
LEFT JOIN incidencias_masivas i ON i.id = r.incidencia_id
LEFT JOIN alerta_eventos e     ON e.id = r.alerta_id
LEFT JOIN LATERAL (
    SELECT rp.texto, rp.creado_at,
           COALESCE(tp.nombre, CONCAT_WS(' ', up.nombre, up.apellido)) AS quien
      FROM reparacion_reportes rp
      LEFT JOIN tecnicos tp         ON tp.id = rp.tecnico_id
      LEFT JOIN usuarios_sistema up ON up.id = rp.usuario_id
     WHERE rp.reparacion_id = r.id
     ORDER BY rp.creado_at DESC, rp.id DESC
     LIMIT 1
) ult ON TRUE
WHERE ve_reparacion(r.id);

COMMENT ON VIEW v_reparaciones_red IS
    'Reparaciones de red con su cuadrilla, el jefe de grupo de hoy, el último reporte y si quien pregunta puede cerrarla.';

GRANT SELECT ON v_reparaciones_red TO authenticated;

DROP VIEW IF EXISTS v_reparacion_reportes;
CREATE VIEW v_reparacion_reportes AS
SELECT rp.*,
       COALESCE(t.nombre, CONCAT_WS(' ', u.nombre, u.apellido)) AS quien
  FROM reparacion_reportes rp
  LEFT JOIN tecnicos t         ON t.id = rp.tecnico_id
  LEFT JOIN usuarios_sistema u ON u.id = rp.usuario_id
 WHERE ve_reparacion(rp.reparacion_id);

GRANT SELECT ON v_reparacion_reportes TO authenticated;

/**
 * Lo que está roto y nadie tiene asignado: cortes masivos en borrador o
 * abiertos, cortes agrupados y cajas NAP degradándose. Solo para la oficina.
 */
DROP VIEW IF EXISTS v_averias_sin_asignar;
CREATE VIEW v_averias_sin_asignar AS
SELECT 'incidencia'::text AS origen,
       i.id,
       i.tipo::text AS tipo,
       i.titulo::text AS titulo,
       COALESCE(i.zona, p.nombre, n.nombre, o.nombre)::text AS lugar,
       i.afectados AS afectados,
       i.ocurrio_at AS desde,
       i.estado::text AS estado
  FROM incidencias_masivas i
  LEFT JOIN puntos_red p ON p.id = i.punto_id
  LEFT JOIN nodos_red n  ON n.id = i.nodo_id
  LEFT JOIN olts o       ON o.id = i.olt_id
 WHERE i.estado IN ('borrador', 'abierta')
   AND i.tipo <> 'mantenimiento'
   AND NOT EXISTS (SELECT 1 FROM reparaciones_red r
                    WHERE r.incidencia_id = i.id AND r.estado IN ('asignada', 'en_curso'))
   AND dirige_cuadrillas()

UNION ALL

SELECT 'alerta',
       e.id,
       CASE e.regla WHEN 'degradacion' THEN 'nap_degradada' ELSE e.regla END,
       CASE e.regla
            WHEN 'corte_grupo' THEN COALESCE(e.etiqueta, 'Grupo') || ': ' || e.abonados || ' ONTs sin señal a la vez'
            ELSE COALESCE(e.etiqueta, 'Caja NAP') || ': bajó ' || COALESCE(e.detalle->>'caida', '?') || ' dB en 7 días'
       END,
       COALESCE(e.zona, e.detalle->>'direccion'),
       e.abonados,
       e.empezo_en,
       'abierta'
  FROM alerta_eventos e
 WHERE e.resuelto_en IS NULL
   AND (e.regla = 'corte_grupo' OR (e.regla = 'degradacion' AND e.entidad = 'nap'))
   AND NOT EXISTS (SELECT 1 FROM reparaciones_red r
                    WHERE r.alerta_id = e.id AND r.estado IN ('asignada', 'en_curso'))
   AND dirige_cuadrillas();

GRANT SELECT ON v_averias_sin_asignar TO authenticated;


-- =============================================================================
-- 7. Novedades de red, con lo que no responde al ping
-- =============================================================================
-- Se recrea entera: cambian las columnas (`fuente`, `titulo`, `detalle`,
-- `afectados`, `reparacion_*`). Las de antes siguen con el mismo nombre y
-- significado, así la pantalla vieja no se rompe si llega antes que esto.
DROP VIEW IF EXISTS v_novedades_red;
CREATE VIEW v_novedades_red AS
-- ── Nodos: cuándo empezó el problema ──
SELECT
    e.id,
    'nodo'::text AS fuente,
    e.nodo_id,
    n.nombre::text AS nodo,
    n.tipo::text   AS nodo_tipo,
    pr.nombre::text AS punto,
    e.desde        AS momento,
    CASE WHEN e.estado = 'down' THEN 'caida' ELSE 'degradado' END AS clase,
    NULL::int      AS duracion_min,
    (e.causa_padre_id IS NOT NULL) AS por_el_padre,
    n.nombre::text AS titulo,
    NULL::text     AS detalle,
    NULL::int      AS afectados,
    NULL::uuid     AS reparacion_id,
    NULL::text     AS reparacion_estado,
    NULL::text     AS reparacion_cuadrilla
FROM nodo_eventos e
JOIN nodos_red n        ON n.id  = e.nodo_id
LEFT JOIN puntos_red pr ON pr.id = n.punto_id
WHERE e.estado IN ('down', 'warning')
  AND e.desde > NOW() - INTERVAL '7 days'
  AND puede_ver_monitoreo()

UNION ALL

-- ── Nodos: cuándo se resolvió ──
SELECT
    e.id, 'nodo', e.nodo_id, n.nombre, n.tipo, pr.nombre,
    e.hasta, 'recuperado',
    (EXTRACT(EPOCH FROM (e.hasta - e.desde)) / 60)::int,
    (e.causa_padre_id IS NOT NULL),
    n.nombre, NULL, NULL, NULL, NULL, NULL
FROM nodo_eventos e
JOIN nodos_red n        ON n.id  = e.nodo_id
LEFT JOIN puntos_red pr ON pr.id = n.punto_id
WHERE e.estado IN ('down', 'warning')
  AND e.hasta IS NOT NULL
  AND e.hasta > NOW() - INTERVAL '7 days'
  AND puede_ver_monitoreo()

UNION ALL

-- ── Cortes masivos ──
-- Los abiertos, y los borradores que ya tienen reparación asignada: un borrador
-- suelto puede ser una zona mal elegida; con cuadrilla asignada, es real.
-- Los abiertos de hace más de 7 días siguen apareciendo: siguen rotos.
SELECT
    i.id, 'corte', NULL,
    COALESCE(i.zona, p.nombre, nd.nombre, o.nombre)::text, i.tipo::text,
    COALESCE(i.zona, p.nombre)::text,
    COALESCE(i.abierta_at, i.ocurrio_at), 'corte_masivo', NULL, FALSE,
    i.titulo::text,
    CASE i.tipo
         WHEN 'fibra_rota'    THEN 'Fibra cortada'
         WHEN 'enlace_caido'  THEN 'Enlace o antena caída'
         WHEN 'corte_energia' THEN 'Corte de energía'
         WHEN 'mantenimiento' THEN 'Mantenimiento programado'
         ELSE 'Avería' END,
    i.afectados,
    rr.id, rr.estado::text, COALESCE(rc.nombre, rt.nombre)::text
FROM incidencias_masivas i
LEFT JOIN puntos_red p ON p.id = i.punto_id
LEFT JOIN nodos_red nd ON nd.id = i.nodo_id
LEFT JOIN olts o       ON o.id = i.olt_id
LEFT JOIN LATERAL (
    SELECT * FROM reparaciones_red r WHERE r.incidencia_id = i.id
     ORDER BY r.creada_at DESC LIMIT 1
) rr ON TRUE
LEFT JOIN cuadrillas rc ON rc.id = rr.cuadrilla_id
LEFT JOIN tecnicos rt   ON rt.id = rr.tecnico_id
WHERE (i.estado = 'abierta' OR (i.estado = 'borrador' AND rr.estado IN ('asignada', 'en_curso')))
  AND puede_ver_monitoreo()

UNION ALL

SELECT
    i.id, 'corte', NULL,
    COALESCE(i.zona, p.nombre, nd.nombre, o.nombre)::text, i.tipo::text,
    COALESCE(i.zona, p.nombre)::text,
    i.resuelta_at, 'recuperado',
    (EXTRACT(EPOCH FROM (i.resuelta_at - i.ocurrio_at)) / 60)::int, FALSE,
    i.titulo::text, 'Corte masivo resuelto', i.afectados,
    NULL, NULL, NULL
FROM incidencias_masivas i
LEFT JOIN puntos_red p ON p.id = i.punto_id
LEFT JOIN nodos_red nd ON nd.id = i.nodo_id
LEFT JOIN olts o       ON o.id = i.olt_id
WHERE i.estado = 'resuelta'
  AND i.resuelta_at > NOW() - INTERVAL '7 days'
  AND puede_ver_monitoreo()

UNION ALL

-- ── Alertas de la OLT: cortes agrupados y cajas NAP degradándose ──
SELECT
    e.id, CASE e.regla WHEN 'corte_grupo' THEN 'grupo' ELSE 'nap' END, NULL,
    e.etiqueta::text, e.entidad::text, COALESCE(e.zona, e.detalle->>'direccion')::text,
    e.empezo_en,
    CASE e.regla WHEN 'corte_grupo' THEN 'corte_grupo' ELSE 'nap_degradada' END,
    NULL, FALSE,
    CASE e.regla
         WHEN 'corte_grupo' THEN 'Posible daño de fibra: ' || COALESCE(e.etiqueta, 'grupo')
         ELSE COALESCE(e.etiqueta, 'Caja NAP') || ' se está degradando' END,
    CASE e.regla
         WHEN 'corte_grupo' THEN e.abonados || ' ONTs sin señal a la vez'
         ELSE 'Bajó ' || COALESCE(e.detalle->>'caida', '?') || ' dB en 7 días · ' || e.abonados || ' clientes' END,
    e.abonados,
    rr.id, rr.estado::text, COALESCE(rc.nombre, rt.nombre)::text
FROM alerta_eventos e
LEFT JOIN LATERAL (
    SELECT * FROM reparaciones_red r WHERE r.alerta_id = e.id
     ORDER BY r.creada_at DESC LIMIT 1
) rr ON TRUE
LEFT JOIN cuadrillas rc ON rc.id = rr.cuadrilla_id
LEFT JOIN tecnicos rt   ON rt.id = rr.tecnico_id
WHERE (e.regla = 'corte_grupo' OR (e.regla = 'degradacion' AND e.entidad = 'nap'))
  AND (e.resuelto_en IS NULL OR e.empezo_en > NOW() - INTERVAL '7 days')
  AND puede_ver_monitoreo()

UNION ALL

SELECT
    e.id, CASE e.regla WHEN 'corte_grupo' THEN 'grupo' ELSE 'nap' END, NULL,
    e.etiqueta::text, e.entidad::text, COALESCE(e.zona, e.detalle->>'direccion')::text,
    e.resuelto_en, 'recuperado',
    (EXTRACT(EPOCH FROM (e.resuelto_en - e.empezo_en)) / 60)::int, FALSE,
    e.etiqueta::text,
    CASE e.regla WHEN 'corte_grupo' THEN 'Volvieron las ONTs' ELSE 'La potencia se normalizó' END,
    e.abonados, NULL, NULL, NULL
FROM alerta_eventos e
WHERE (e.regla = 'corte_grupo' OR (e.regla = 'degradacion' AND e.entidad = 'nap'))
  AND e.resuelto_en IS NOT NULL
  AND e.resuelto_en > NOW() - INTERVAL '7 days'
  AND puede_ver_monitoreo();

COMMENT ON VIEW v_novedades_red IS
    'Línea de tiempo de la red: nodos caídos y recuperados, cortes masivos, cortes agrupados y cajas NAP degradándose, con la reparación asignada. Ordenar por `momento` descendente.';

GRANT SELECT ON v_novedades_red TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Lo que la oficina tiene para asignar:
--   SELECT origen, tipo, titulo, lugar, afectados FROM v_averias_sin_asignar;
--
--   -- La línea de tiempo del técnico:
--   SELECT momento, fuente, clase, titulo, detalle, reparacion_estado
--     FROM v_novedades_red ORDER BY momento DESC;
--
--   -- Las reparaciones en marcha y quién las cierra hoy:
--   SELECT numero, titulo, cuadrilla, jefe, estado FROM v_reparaciones_red
--    WHERE estado IN ('asignada', 'en_curso');
