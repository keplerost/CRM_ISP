-- =============================================================================
-- Migración 113 — Las alertas, con los datos que la red de verdad tiene
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Los dos errores que apareció la primera corrida con datos reales ──
--
-- La 112 se probó contra una base vacía y contra el arnés, y ahí funcionaba. Al
-- correrla sobre una OLT con 91 ONUs quedaron a la vista dos cosas:
--
--   1. TODAS las alertas decían "ONT sin abonado".
--
--      La función buscaba el nombre en `clientes`, por `c.onu_id = o.id`. En esta
--      instalación ninguna ficha tiene la ONU vinculada todavía —la red está
--      cargada, el CRM se está armando— así que el LEFT JOIN no encontraba nada.
--
--      Pero el nombre SÍ está: `onus.nombre_cliente` lo trae leído del equipo, y
--      las 91 lo tienen. También la dirección y la zona. Un aviso que dice
--      "MORALES GUAMAN KLEVER ARNULFO · RECINTO SELVALEGRE" sirve para llamar;
--      uno que dice "ONT sin abonado" no sirve para nada.
--
--   2. La agrupación por caja no se iba a disparar NUNCA.
--
--      `corte_grupo` agrupaba por `onus.nap_id`, y en esta red está vacío en
--      todas. O sea: un corte de fibra que tira ocho abonados habría mandado
--      ocho mensajes individuales — exactamente lo que la 112 decía evitar.
--
--      Se agrupa por PUERTO PON cuando no hay caja. Es el corte natural de una
--      red GPON: una fibra cortada o un puerto muerto se llevan el puerto
--      entero, y esos campos —frame, slot, puerto— sí están cargados.
--
-- ── Lo que esto enseña ──
--
-- Que el arnés prueba que el SQL corre, no que sirva. Las dos fallas necesitaban
-- una red real para aparecer.
-- =============================================================================


-- =============================================================================
-- 1. De dónde sale el nombre de cada abonado
-- =============================================================================
/**
 * Quién es el dueño de una ONU, con lo que haya.
 *
 * El orden importa: primero la ficha del sistema —que es la que alguien mantiene
 * y corrige—, después lo que dice la OLT, y como último recurso el número de
 * serie, que al menos permite encontrar el equipo.
 *
 * Devuelve también dirección y zona porque un aviso sin dónde manda a nadie a
 * ninguna parte.
 */
CREATE OR REPLACE FUNCTION quien_es_la_onu(p_onu UUID)
RETURNS TABLE (nombre TEXT, zona TEXT, direccion TEXT, telefono TEXT, cliente_id UUID, codigo INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE(
            NULLIF(BTRIM(c.nombre), ''),
            NULLIF(BTRIM(o.nombre_cliente), ''),
            'ONT ' || o.sn
        )::TEXT,
        COALESCE(NULLIF(BTRIM(c.zona), ''), NULLIF(BTRIM(o.zona), ''))::TEXT,
        COALESCE(NULLIF(BTRIM(c.direccion), ''), NULLIF(BTRIM(o.direccion), ''))::TEXT,
        COALESCE(
            NULLIF(BTRIM(c.telefono_movil), ''),
            NULLIF(BTRIM(c.telefono), ''),
            NULLIF(BTRIM(o.contacto), '')
        )::TEXT,
        c.id,
        c.codigo
      FROM onus o
      LEFT JOIN clientes c ON c.onu_id = o.id
     WHERE o.id = p_onu
$$;

COMMENT ON FUNCTION quien_es_la_onu IS
    'El nombre, la zona, la dirección y el teléfono del dueño de una ONU: de su ficha si la tiene, y si no de lo que la OLT trae leído del equipo.';


-- =============================================================================
-- 2. La detección, agrupando por lo que exista
-- =============================================================================
CREATE OR REPLACE FUNCTION detectar_alertas()
RETURNS TABLE (abiertos INT, resueltos INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_grupo   alerta_reglas%ROWTYPE;
    v_ind     alerta_reglas%ROWTYPE;
    v_pot     alerta_reglas%ROWTYPE;
    v_abre    INT := 0;
    v_cierra  INT := 0;
    r         RECORD;
    q         RECORD;
BEGIN
    SELECT * INTO v_grupo FROM alerta_reglas WHERE clave = 'corte_grupo';
    SELECT * INTO v_ind   FROM alerta_reglas WHERE clave = 'ont_caida';
    SELECT * INTO v_pot   FROM alerta_reglas WHERE clave = 'potencia_critica';

    /*
     * ── El grupo de cada ONU ──
     *
     * Se resuelve una sola vez, en una tabla temporal, porque se usa tres veces:
     * para contar caídas por grupo, para saltear los abonados de un grupo ya
     * avisado, y para cerrar el evento cuando el grupo vuelve.
     *
     * `grupo_clave` es la caja si la hay, y si no el puerto PON. `grupo_tipo`
     * dice cuál de las dos, para que el mensaje pueda decir "NAP-12" o
     * "OLT LA MANÁ 0/1/2" y no un identificador suelto.
     */
    CREATE TEMP TABLE IF NOT EXISTS _grupos_onu (
        onu_id UUID PRIMARY KEY,
        grupo_tipo TEXT,
        grupo_clave TEXT,
        grupo_nombre TEXT,
        caida BOOLEAN
    ) ON COMMIT DROP;
    DELETE FROM _grupos_onu;

    INSERT INTO _grupos_onu
    SELECT
        o.id,
        CASE WHEN o.nap_id IS NOT NULL THEN 'nap' ELSE 'pon' END,
        CASE WHEN o.nap_id IS NOT NULL
             THEN o.nap_id::TEXT
             ELSE o.olt_id::TEXT || '/' || COALESCE(o.frame, 0) || '/' ||
                  COALESCE(o.slot, 0) || '/' || COALESCE(o.puerto, 0)
        END,
        CASE WHEN o.nap_id IS NOT NULL
             THEN COALESCE(p.nombre, 'Caja sin nombre')
             ELSE COALESCE(ol.nombre, 'OLT') || ' ' || COALESCE(o.frame, 0) || '/' ||
                  COALESCE(o.slot, 0) || '/' || COALESCE(o.puerto, 0)
        END,
        o.estado IN ('offline', 'los', 'dying_gasp')
      FROM onus o
      LEFT JOIN puntos_red p ON p.id = o.nap_id
      LEFT JOIN olts ol      ON ol.id = o.olt_id;

    -- ── 1. Cortes agrupados ─────────────────────────────────────────────────
    IF v_grupo.activa THEN
        FOR r IN
            SELECT g.grupo_tipo, g.grupo_clave, g.grupo_nombre,
                   COUNT(*) FILTER (WHERE g.caida)::INT AS caidas
              FROM _grupos_onu g
             GROUP BY g.grupo_tipo, g.grupo_clave, g.grupo_nombre
            HAVING COUNT(*) FILTER (WHERE g.caida) >= COALESCE(v_grupo.umbral, 3)
        LOOP
            INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, abonados, detalle)
            VALUES ('corte_grupo', r.grupo_tipo, r.grupo_clave, r.grupo_nombre, r.caidas,
                    jsonb_build_object('grupo', r.grupo_tipo))
            ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL
            DO UPDATE SET abonados = EXCLUDED.abonados;

            v_abre := v_abre + 1;
        END LOOP;
    END IF;

    -- ── 2. Las que quedaron solas ───────────────────────────────────────────
    IF v_ind.activa THEN
        FOR r IN
            SELECT o.id, o.sn, g.grupo_tipo, g.grupo_clave, g.grupo_nombre
              FROM onus o
              JOIN _grupos_onu g ON g.onu_id = o.id
             WHERE g.caida
               AND NOT EXISTS (
                   SELECT 1 FROM alerta_eventos e
                    WHERE e.regla = 'corte_grupo'
                      AND e.entidad = g.grupo_tipo
                      AND e.entidad_id = g.grupo_clave
                      AND e.resuelto_en IS NULL
               )
        LOOP
            SELECT * INTO q FROM quien_es_la_onu(r.id);

            INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, zona, abonados, detalle)
            VALUES ('ont_caida', 'onu', r.id::TEXT, q.nombre, q.zona, 1,
                    jsonb_build_object(
                        'cliente_id', q.cliente_id,
                        'codigo', q.codigo,
                        'telefono', q.telefono,
                        'direccion', q.direccion,
                        'sn', r.sn,
                        -- Que su grupo esté sano es LO que hace sospechoso el
                        -- caso, así que va en el mensaje.
                        'grupo', r.grupo_nombre
                    ))
            ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL
            DO UPDATE SET etiqueta = EXCLUDED.etiqueta,
                          zona = EXCLUDED.zona,
                          detalle = EXCLUDED.detalle;

            v_abre := v_abre + 1;
        END LOOP;
    END IF;

    -- ── 3. Potencia bajo el umbral, con la ONT todavía arriba ───────────────
    IF v_pot.activa THEN
        FOR r IN
            SELECT o.id, o.sn, o.rx_power_dbm
              FROM onus o
             WHERE o.estado = 'online'
               AND o.rx_power_dbm IS NOT NULL
               AND o.rx_power_dbm < COALESCE(v_pot.umbral, -27)
        LOOP
            SELECT * INTO q FROM quien_es_la_onu(r.id);

            INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, zona, detalle)
            VALUES ('potencia_critica', 'onu', r.id::TEXT, q.nombre, q.zona,
                    jsonb_build_object('rx_dbm', r.rx_power_dbm, 'sn', r.sn,
                                       'telefono', q.telefono, 'direccion', q.direccion))
            ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL
            DO UPDATE SET etiqueta = EXCLUDED.etiqueta, detalle = EXCLUDED.detalle;

            v_abre := v_abre + 1;
        END LOOP;
    END IF;

    -- ── 4. Lo que volvió ────────────────────────────────────────────────────
    WITH vueltas AS (
        UPDATE alerta_eventos e
           SET resuelto_en = NOW()
         WHERE e.resuelto_en IS NULL
           AND (
             (e.regla = 'ont_caida' AND e.entidad = 'onu'
              AND EXISTS (SELECT 1 FROM onus o
                           WHERE o.id::TEXT = e.entidad_id AND o.estado = 'online'))
             OR
             (e.regla = 'potencia_critica' AND e.entidad = 'onu'
              AND EXISTS (SELECT 1 FROM onus o WHERE o.id::TEXT = e.entidad_id
                            AND (o.rx_power_dbm IS NULL
                                 OR o.rx_power_dbm >= COALESCE(v_pot.umbral, -27))))
             OR
             (e.regla = 'corte_grupo'
              AND (SELECT COUNT(*) FROM _grupos_onu g
                    WHERE g.grupo_tipo = e.entidad
                      AND g.grupo_clave = e.entidad_id
                      AND g.caida) < COALESCE(v_grupo.umbral, 3))
           )
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_cierra FROM vueltas;

    RETURN QUERY SELECT v_abre, v_cierra;
END $$;

COMMENT ON FUNCTION detectar_alertas IS
    'Abre y cierra eventos de alerta. Agrupa por caja, o por puerto PON cuando la caja no está cargada. El nombre del abonado sale de su ficha o de lo que la OLT tiene leído.';


-- =============================================================================
-- 3. Los eventos que ya se abrieron con el nombre equivocado
-- =============================================================================
-- Se cierran los que dicen "ONT sin abonado": la próxima pasada los vuelve a
-- abrir con el nombre de verdad. Corregirles el texto uno por uno dejaría la
-- fecha de inicio vieja y la antigüedad del aviso mentiría.
UPDATE alerta_eventos
   SET resuelto_en = NOW()
 WHERE resuelto_en IS NULL
   AND etiqueta = 'ONT sin abonado';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT * FROM detectar_alertas();
--
--   SELECT regla, etiqueta, zona, abonados, detalle->>'direccion' AS direccion
--     FROM alerta_eventos WHERE resuelto_en IS NULL;
--   -- Las caídas tienen que salir con nombre y dirección, no con "ONT sin abonado".
--
--   -- Y de qué grupo es cada ONU, para ver que la agrupación tenga de qué agarrarse:
--   SELECT COUNT(*) FILTER (WHERE nap_id IS NOT NULL) AS con_caja,
--          COUNT(*) FILTER (WHERE nap_id IS NULL)     AS por_puerto
--     FROM onus;
