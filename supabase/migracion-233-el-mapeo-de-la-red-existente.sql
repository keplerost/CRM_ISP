-- =============================================================================
-- Migración 233 — El mapeo de la red que ya existe
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 232 (obras de red) y la 46 (cajas NAP).
--
-- ── Qué resuelve ──
--
-- El sistema no sabe de qué caja cuelga cada abonado: los splitters son
-- pasivos y la OLT ve lo mismo con una caja que con cinco. La pantalla de Cajas
-- NAP solo PROPONE agrupaciones. Alguien tiene que ir al poste a confirmarlas.
--
-- Ahora la oficina le asigna a la cuadrilla una obra de tipo "Mapeo de red
-- existente". En cada caja la cuadrilla registra el nombre, la ubicación, la
-- potencia y la foto (como en una obra), y además releva PUERTO POR PUERTO:
-- qué abonado está en cada uno, cuál está libre y cuál está dañado. La app le
-- sugiere los abonados cercanos por GPS y, si la obra dice de qué OLT y puerto
-- PON es la zona, los de ese puerto con la distancia que mide la OLT.
--
-- Asignar un puerto deja al abonado en esa caja y en ese puerto, marcado como
-- verificado en campo (`onus.nap_origen = 'campo'`, `puntos_red.origen =
-- 'campo'`): es lo que distingue un dato confiable de una deducción.
--
-- ── Se mide aparte ──
--
-- Las cajas de un mapeo ya estaban: no son producción de la cuadrilla, no
-- cuentan en su calidad óptica y los tickets de esas cajas no son "fallas de lo
-- que construyeron". El mapeo tiene su propio indicador: cajas mapeadas,
-- puertos relevados, abonados ubicados y puertos libres encontrados.
--
-- ── No se entrega a medias ──
--
-- Un mapeo se entrega con cada caja completa (ubicación, potencia, puertos,
-- foto) y con TODOS sus puertos relevados: un puerto sin mirar es justo el que
-- después se ofrece como libre y está ocupado.
-- =============================================================================


-- =============================================================================
-- 1. El tipo nuevo y de qué parte de la red es
-- =============================================================================
ALTER TABLE obras_red DROP CONSTRAINT IF EXISTS obras_red_tipo_check;
ALTER TABLE obras_red ADD CONSTRAINT obras_red_tipo_check
    CHECK (tipo IN ('expansion', 'troncal', 'reubicacion', 'preventivo',
                    'reparacion', 'acometida', 'mapeo', 'otro'));

ALTER TABLE obras_red
    -- De qué OLT y puerto PON es la zona. Opcional: sirve para sugerir los
    -- abonados de ese puerto con la distancia que mide la OLT.
    ADD COLUMN IF NOT EXISTS olt_id     UUID REFERENCES olts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS slot       INT,
    ADD COLUMN IF NOT EXISTS puerto_pon VARCHAR(20);


-- =============================================================================
-- 2. Puerto por puerto
-- =============================================================================
CREATE TABLE IF NOT EXISTS mapeo_puertos (
    id            BIGSERIAL PRIMARY KEY,
    obra_nap_id   UUID NOT NULL REFERENCES obra_naps(id) ON DELETE CASCADE,
    puerto        INT NOT NULL CHECK (puerto > 0),
    estado        VARCHAR(10) NOT NULL CHECK (estado IN ('ocupado', 'libre', 'danado')),
    cliente_id    UUID REFERENCES clientes(id) ON DELETE SET NULL,
    nota          TEXT,
    tecnico_id    UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    usuario_id    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    relevado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (obra_nap_id, puerto),
    CONSTRAINT mapeo_ocupado_con_abonado CHECK (estado <> 'ocupado' OR cliente_id IS NOT NULL OR nota IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mapeo_puertos_cliente ON mapeo_puertos (cliente_id) WHERE cliente_id IS NOT NULL;

COMMENT ON TABLE mapeo_puertos IS
    'Lo que se vio en cada puerto de una caja NAP al mapear la red: el abonado que está, libre o dañado.';

ALTER TABLE mapeo_puertos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mapeo_puertos_leer ON mapeo_puertos;
CREATE POLICY mapeo_puertos_leer ON mapeo_puertos FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM obra_naps n WHERE n.id = obra_nap_id AND ve_obra(n.obra_id)));
REVOKE ALL ON mapeo_puertos FROM anon;
GRANT SELECT ON mapeo_puertos TO authenticated;

/**
 * Lo que leen las pantallas: el puerto con el nombre del abonado. El técnico
 * no lee `clientes` directo; acá ve solo los de las cajas de sus obras.
 */
DROP VIEW IF EXISTS v_mapeo_puertos;
CREATE VIEW v_mapeo_puertos AS
SELECT mp.id, mp.obra_nap_id, n.obra_id, mp.puerto, mp.estado, mp.cliente_id, mp.nota, mp.relevado_at,
       c.nombre AS cliente, c.direccion AS cliente_direccion,
       COALESCE(t.nombre, CONCAT_WS(' ', u.nombre, u.apellido)) AS quien
  FROM mapeo_puertos mp
  JOIN obra_naps n            ON n.id = mp.obra_nap_id
  LEFT JOIN clientes c        ON c.id = mp.cliente_id
  LEFT JOIN tecnicos t        ON t.id = mp.tecnico_id
  LEFT JOIN usuarios_sistema u ON u.id = mp.usuario_id
 WHERE ve_obra(n.obra_id);
GRANT SELECT ON v_mapeo_puertos TO authenticated;


-- =============================================================================
-- 3. Relevar un puerto
-- =============================================================================
/**
 * Marca lo que hay en un puerto de una caja del mapeo.
 *
 * Con abonado: queda colgado de esa caja y ese puerto (`clientes.nap_id`,
 * `puerto_nap`), y su ONU marcada como verificada en campo. Si el mismo
 * abonado estaba en otro puerto del mapeo, se lo saca de ahí: está en un solo
 * lugar, y el último que lo vio es el que estuvo en el poste.
 *
 * `p_estado` NULL borra lo relevado en ese puerto (se marcó mal).
 */
CREATE OR REPLACE FUNCTION relevar_puerto_nap(
    p_obra_nap UUID,
    p_puerto   INT,
    p_estado   TEXT,
    p_cliente  UUID DEFAULT NULL,
    p_nota     TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    n      obra_naps%ROWTYPE;
    v_prev mapeo_puertos%ROWTYPE;
BEGIN
    SELECT * INTO n FROM obra_naps WHERE id = p_obra_nap;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe esa caja.'; END IF;
    PERFORM obra_abierta_para_mi(n.obra_id);

    IF p_puerto IS NULL OR p_puerto < 1 OR (n.puertos IS NOT NULL AND p_puerto > n.puertos) THEN
        RAISE EXCEPTION 'La caja tiene % puertos: el % no existe.', COALESCE(n.puertos::text, '?'), p_puerto;
    END IF;
    IF p_estado IS NOT NULL AND p_estado NOT IN ('ocupado', 'libre', 'danado') THEN
        RAISE EXCEPTION 'Estado desconocido: %', p_estado;
    END IF;
    IF p_estado = 'ocupado' AND p_cliente IS NULL AND NULLIF(BTRIM(p_nota), '') IS NULL THEN
        RAISE EXCEPTION 'Decí qué abonado está, o escribí lo que dice la etiqueta si no lo encontrás.';
    END IF;

    SELECT * INTO v_prev FROM mapeo_puertos WHERE obra_nap_id = p_obra_nap AND puerto = p_puerto;

    -- El que estaba en este puerto y ya no: deja de figurar en la caja.
    IF v_prev.cliente_id IS NOT NULL AND v_prev.cliente_id IS DISTINCT FROM p_cliente THEN
        UPDATE clientes SET nap_id = NULL, puerto_nap = NULL
         WHERE id = v_prev.cliente_id AND nap_id = n.punto_id AND puerto_nap = p_puerto::text;
        UPDATE onus SET nap_id = NULL, nap_origen = NULL
         WHERE id = (SELECT onu_id FROM clientes WHERE id = v_prev.cliente_id) AND nap_id = n.punto_id;
    END IF;

    IF p_estado IS NULL THEN
        DELETE FROM mapeo_puertos WHERE obra_nap_id = p_obra_nap AND puerto = p_puerto;
        RETURN;
    END IF;

    IF p_cliente IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM clientes WHERE id = p_cliente) THEN
            RAISE EXCEPTION 'No existe ese abonado.';
        END IF;
        -- Estaba anotado en otro puerto (de esta caja o de otra): se mueve.
        DELETE FROM mapeo_puertos
         WHERE cliente_id = p_cliente AND NOT (obra_nap_id = p_obra_nap AND puerto = p_puerto);

        UPDATE clientes SET nap_id = n.punto_id, puerto_nap = p_puerto::text WHERE id = p_cliente;
        UPDATE onus SET nap_id = n.punto_id, nap_origen = 'campo'
         WHERE id = (SELECT onu_id FROM clientes WHERE id = p_cliente);
    END IF;

    INSERT INTO mapeo_puertos (obra_nap_id, puerto, estado, cliente_id, nota, tecnico_id, usuario_id)
    VALUES (p_obra_nap, p_puerto, p_estado,
            CASE WHEN p_estado = 'ocupado' THEN p_cliente END,
            NULLIF(BTRIM(p_nota), ''), mi_tecnico_id(), mi_usuario_id())
    ON CONFLICT (obra_nap_id, puerto) DO UPDATE
       SET estado      = EXCLUDED.estado,
           cliente_id  = EXCLUDED.cliente_id,
           nota        = EXCLUDED.nota,
           tecnico_id  = EXCLUDED.tecnico_id,
           usuario_id  = EXCLUDED.usuario_id,
           relevado_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION relevar_puerto_nap(UUID, INT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION relevar_puerto_nap(UUID, INT, TEXT, UUID, TEXT) TO authenticated;


-- =============================================================================
-- 4. A quién sugerir
-- =============================================================================
/**
 * Los abonados que pueden estar en esa caja, del más probable al menos:
 *
 *   · los del puerto PON de la obra (si la obra lo dice), con la distancia que
 *     mide la OLT: los de una misma caja están todos a casi la misma distancia;
 *   · los que tienen ubicación a menos de `p_radio` metros de la caja.
 *
 * Con `p_texto`, busca por nombre, cédula o código en toda la cartera (hasta
 * 15): el abonado que no tiene ubicación cargada también tiene que poder
 * encontrarse.
 *
 * Solo para quien ve la obra. Devuelve dónde figura hoy cada uno, para que la
 * app avise "ya está en NAP-03, puerto 4".
 */
CREATE OR REPLACE FUNCTION abonados_para_caja(
    p_obra   UUID,
    p_lat    NUMERIC DEFAULT NULL,
    p_lng    NUMERIC DEFAULT NULL,
    p_texto  TEXT DEFAULT NULL,
    p_radio  INT DEFAULT 300
)
RETURNS TABLE (
    cliente_id   UUID,
    nombre       TEXT,
    direccion    TEXT,
    distancia_m  INT,
    distancia_olt_m INT,
    por          TEXT,
    caja_actual  TEXT,
    puerto_actual TEXT,
    verificado   BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    o obras_red%ROWTYPE;
    v_txt TEXT := NULLIF(BTRIM(p_texto), '');
BEGIN
    IF NOT ve_obra(p_obra) THEN
        RAISE EXCEPTION 'Esa obra no está asignada a tu cuadrilla.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO o FROM obras_red WHERE id = p_obra;

    RETURN QUERY
    WITH cand AS (
        SELECT c.id, c.nombre::text AS nombre, c.direccion::text AS direccion,
               CASE WHEN p_lat IS NOT NULL AND c.latitud IS NOT NULL THEN
                   (6371000 * 2 * ASIN(SQRT(
                        POWER(SIN(RADIANS((c.latitud - p_lat) / 2)), 2)
                      + COS(RADIANS(p_lat)) * COS(RADIANS(c.latitud))
                        * POWER(SIN(RADIANS((c.longitud - p_lng) / 2)), 2))))::int
               END AS dist,
               u.distancia_m AS dist_olt,
               (o.olt_id IS NOT NULL AND u.olt_id = o.olt_id
                AND (o.puerto_pon IS NULL OR u.puerto::text = o.puerto_pon)
                AND (o.slot IS NULL OR u.slot = o.slot)) AS del_pon,
               p.nombre::text AS caja, c.puerto_nap::text AS puerto,
               (u.nap_origen = 'campo' OR EXISTS (SELECT 1 FROM mapeo_puertos mp WHERE mp.cliente_id = c.id)) AS verif
          FROM clientes c
          LEFT JOIN onus u       ON u.id = c.onu_id
          LEFT JOIN puntos_red p ON p.id = c.nap_id
         WHERE (c.estado IS NULL OR c.estado NOT IN ('baja', 'retirado'))
    )
    SELECT cand.id, cand.nombre, cand.direccion, cand.dist, cand.dist_olt,
           CASE WHEN v_txt IS NOT NULL THEN 'busqueda'
                WHEN cand.del_pon THEN 'puerto_pon'
                ELSE 'cerca' END,
           cand.caja, cand.puerto, COALESCE(cand.verif, FALSE)
      FROM cand
     WHERE CASE WHEN v_txt IS NOT NULL THEN
                    cand.nombre ILIKE '%' || v_txt || '%'
                 OR EXISTS (SELECT 1 FROM clientes c2 WHERE c2.id = cand.id
                             AND (c2.identificacion ILIKE v_txt || '%' OR c2.codigo::text ILIKE v_txt || '%'))
                ELSE cand.del_pon OR cand.dist <= p_radio
           END
     ORDER BY (v_txt IS NULL AND cand.del_pon) DESC, cand.dist NULLS LAST, cand.dist_olt NULLS LAST, cand.nombre
     LIMIT CASE WHEN v_txt IS NOT NULL THEN 15 ELSE 40 END;
END;
$$;

REVOKE ALL ON FUNCTION abonados_para_caja(UUID, NUMERIC, NUMERIC, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION abonados_para_caja(UUID, NUMERIC, NUMERIC, TEXT, INT) TO authenticated;

-- =============================================================================
-- 5. Crear la obra con su OLT y puerto PON
-- =============================================================================
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
        ticket_id     = CASE WHEN d ? 'ticket_id' THEN NULLIF(d->>'ticket_id', '')::uuid ELSE ticket_id END,
        olt_id        = CASE WHEN d ? 'olt_id' THEN NULLIF(d->>'olt_id', '')::uuid ELSE olt_id END,
        slot          = CASE WHEN d ? 'slot' THEN NULLIF(d->>'slot', '')::int ELSE slot END,
        puerto_pon    = CASE WHEN d ? 'puerto_pon' THEN NULLIF(BTRIM(d->>'puerto_pon'), '') ELSE puerto_pon END
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
                CASE WHEN v_nueva.tipo = 'mapeo' THEN 'Mapeo asignado: ' ELSE 'Obra asignada: ' END || LEFT(v_nueva.titulo, 80),
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
-- 6. La caja relevada queda verificada en campo
-- =============================================================================
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
        INSERT INTO puntos_red (nombre, tipo, capacidad, direccion, latitud, longitud, notas,
                                olt_id, slot, puerto_pon, origen)
        VALUES (v_nombre, 'nap', p_puertos, LEFT(v_obra.zona, 300), p_lat, p_lng,
                CASE WHEN v_obra.tipo = 'mapeo' THEN 'Relevada en el mapeo #' ELSE 'Instalada en la obra #' END
                    || v_obra.numero,
                v_obra.olt_id, v_obra.slot, v_obra.puerto_pon, 'campo')
        RETURNING id INTO v_punto;
    ELSE
        UPDATE puntos_red
           SET latitud   = COALESCE(p_lat, latitud),
               longitud  = COALESCE(p_lng, longitud),
               capacidad = COALESCE(p_puertos, capacidad),
               olt_id    = COALESCE(olt_id, v_obra.olt_id),
               slot      = COALESCE(slot, v_obra.slot),
               puerto_pon = COALESCE(puerto_pon, v_obra.puerto_pon),
               -- Alguien la abrió: ya no es una propuesta.
               origen    = 'campo'
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

-- =============================================================================
-- 7. El mapeo se entrega con todos los puertos relevados
-- =============================================================================
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
    v_sin  INT;
BEGIN
    IF NOT ve_obra(p_id) THEN RETURN f; END IF;
    SELECT * INTO v FROM obras_red WHERE id = p_id;

    -- En un mapeo la foto es la de cada caja: no hace falta un parte con foto.
    IF v.tipo <> 'mapeo'
       AND NOT EXISTS (SELECT 1 FROM obra_avances WHERE obra_id = p_id AND cardinality(fotos) > 0) THEN
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
    IF v.tipo = 'mapeo' THEN
        IF v.meta_naps = 0 AND v_naps = 0 THEN
            f := f || 'Registrar al menos una caja'::text;
        END IF;
        SELECT COUNT(*) INTO v_sin
          FROM obra_naps n
         WHERE n.obra_id = p_id
           AND (n.puertos IS NULL
                OR (SELECT COUNT(*) FROM mapeo_puertos mp WHERE mp.obra_nap_id = n.id) < n.puertos);
        IF v_sin > 0 THEN
            f := f || format('%s caja(s) con puertos sin relevar', v_sin);
        END IF;
    END IF;
    RETURN f;
END;
$$;

GRANT EXECUTE ON FUNCTION faltantes_obra(UUID) TO authenticated;

-- =============================================================================
-- 8. La vista, con lo relevado
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
    -- El mapeo: cuántos puertos se miraron y cuántos abonados se ubicaron.
    COALESCE(mp.relevados, 0) AS puertos_relevados,
    COALESCE(mp.ubicados, 0)  AS abonados_ubicados,
    COALESCE(mp.libres, 0)    AS puertos_libres,
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
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS relevados,
           COUNT(*) FILTER (WHERE x.cliente_id IS NOT NULL) AS ubicados,
           COUNT(*) FILTER (WHERE x.estado = 'libre') AS libres
      FROM mapeo_puertos x JOIN obra_naps y ON y.id = x.obra_nap_id
     WHERE y.obra_id = o.id
) mp ON TRUE
WHERE ve_obra(o.id);

COMMENT ON VIEW v_obras_red IS
    'Obras de red con su cuadrilla, el jefe de grupo de hoy, lo hecho contra cada meta, el avance y si quien pregunta puede entregarla.';
GRANT SELECT ON v_obras_red TO authenticated;

-- =============================================================================
-- 9. Los indicadores: el mapeo, aparte
-- =============================================================================
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
    v_map     JSONB;
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
         WHERE o.cuadrilla_id = c.id AND o.tipo <> 'mapeo' AND a.fecha BETWEEN p_desde AND p_hasta;

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
         WHERE o.cuadrilla_id = c.id AND o.tipo <> 'mapeo'
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
         WHERE o.cuadrilla_id = c.id AND o.tipo <> 'mapeo' AND a.fecha BETWEEN p_desde AND p_hasta AND a.fusiones > 0;

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
                               WHERE o2.cuadrilla_id = c.id AND o2.tipo <> 'mapeo'
                                 AND (o2.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta
                                 AND tk.created_at >= o2.entregada_at
                                 AND tk.created_at < o2.entregada_at + make_interval(days => cfg.dias_fallas)
                                 AND tk.tipo_incidencia IN ('sin_internet', 'intermitencia', 'fibra_cortada', 'potencia_baja')
                                 AND tk.estado <> 'cancelado'),
                   'clientes_conectados', (SELECT COUNT(*) FROM clientes cl
                                            WHERE cl.nap_id IN (SELECT n3.punto_id FROM obra_naps n3 JOIN obras_red o3 ON o3.id = n3.obra_id
                                                                 WHERE o3.cuadrilla_id = c.id AND o3.tipo <> 'mapeo'
                                                                   AND (o3.entregada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta)),
                   'puertos', COALESCE(SUM(n.puertos), 0),
                   'dias', cfg.dias_fallas)
          INTO v_fallas
          FROM obras_red o
          LEFT JOIN obra_naps n ON n.obra_id = o.id
         WHERE o.cuadrilla_id = c.id AND o.tipo <> 'mapeo'
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
        SELECT (SELECT COUNT(*) FROM tk), (SELECT COUNT(*) FROM tk WHERE dia IN (SELECT dia FROM ob)),
               (SELECT COUNT(*) FROM ob)
          INTO v_dias_tk, v_dias_ambos, v_dias_obra;

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

        -- 9. El mapeo de la red existente: cajas relevadas en el período.
        SELECT jsonb_build_object(
                   'obras', COUNT(DISTINCT n.obra_id),
                   'cajas', COUNT(*),
                   'puertos', COALESCE(SUM(n.puertos), 0),
                   'relevados', COALESCE(SUM(x.relevados), 0),
                   'ubicados', COALESCE(SUM(x.ubicados), 0),
                   'libres', COALESCE(SUM(x.libres), 0),
                   'danados', COALESCE(SUM(x.danados), 0),
                   'sin_identificar', COALESCE(SUM(x.sin_identificar), 0))
          INTO v_map
          FROM obra_naps n
          JOIN obras_red o ON o.id = n.obra_id
          LEFT JOIN LATERAL (
              SELECT COUNT(*) AS relevados,
                     COUNT(*) FILTER (WHERE mp.cliente_id IS NOT NULL) AS ubicados,
                     COUNT(*) FILTER (WHERE mp.estado = 'libre') AS libres,
                     COUNT(*) FILTER (WHERE mp.estado = 'danado') AS danados,
                     COUNT(*) FILTER (WHERE mp.estado = 'ocupado' AND mp.cliente_id IS NULL) AS sin_identificar
                FROM mapeo_puertos mp WHERE mp.obra_nap_id = n.id
          ) x ON TRUE
         WHERE o.cuadrilla_id = c.id AND o.tipo = 'mapeo' AND o.estado <> 'cancelada'
           AND (n.registrada_at AT TIME ZONE zona_horaria())::date BETWEEN p_desde AND p_hasta;

        -- Quién reportó qué.
        SELECT COALESCE(jsonb_agg(x ORDER BY x.metros DESC), '[]'::jsonb) INTO v_tec
          FROM (SELECT COALESCE(t.nombre, '—') AS nombre, SUM(a.metros) AS metros, SUM(a.naps) AS naps,
                       SUM(a.fusiones) AS fusiones, COUNT(DISTINCT a.fecha) AS dias
                  FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
                  LEFT JOIN tecnicos t ON t.id = a.tecnico_id
                 WHERE o.cuadrilla_id = c.id AND o.tipo <> 'mapeo' AND a.fecha BETWEEN p_desde AND p_hasta
                 GROUP BY t.nombre) x;

        -- Semana a semana.
        SELECT COALESCE(jsonb_agg(x ORDER BY x.semana), '[]'::jsonb) INTO v_sem
          FROM (SELECT date_trunc('week', a.fecha)::date AS semana, SUM(a.metros) AS metros,
                       SUM(a.naps) AS naps, SUM(a.fusiones) AS fusiones, COUNT(DISTINCT a.fecha) AS dias
                  FROM obra_avances a JOIN obras_red o ON o.id = a.obra_id
                 WHERE o.cuadrilla_id = c.id AND o.tipo <> 'mapeo' AND a.fecha BETWEEN p_desde AND p_hasta
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
            'mapeo', v_map, 'por_tecnico', v_tec, 'semanas', v_sem, 'obras', v_obras);
    END LOOP;

    RETURN jsonb_build_object('desde', p_desde, 'hasta', p_hasta, 'config', to_jsonb(cfg), 'cuadrillas', v_lista);
END;
$$;

REVOKE ALL ON FUNCTION indicadores_obras(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION indicadores_obras(DATE, DATE) TO authenticated;

-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Lo relevado en cada caja de un mapeo:
--   SELECT n.nombre, mp.puerto, mp.estado, c.nombre AS abonado
--     FROM mapeo_puertos mp JOIN obra_naps n ON n.id = mp.obra_nap_id
--     LEFT JOIN clientes c ON c.id = mp.cliente_id
--    ORDER BY n.nombre, mp.puerto;
