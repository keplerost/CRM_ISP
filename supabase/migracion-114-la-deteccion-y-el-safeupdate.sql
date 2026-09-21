-- =============================================================================
-- Migración 114 — La detección chocaba contra pg_safeupdate
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El error ──
--
--     detectar_alertas() → DELETE requires a WHERE clause
--
-- ── Por qué ──
--
-- La 113 vacía una tabla temporal con `DELETE FROM _grupos_onu;`, sin WHERE.
-- Supabase carga la extensión `pg_safeupdate` en las sesiones del API, y esa
-- extensión rechaza cualquier DELETE o UPDATE sin WHERE — es una red de
-- seguridad contra el clásico "borré la tabla entera sin querer".
--
-- La protección está bien y no se toca. Lo que se cambia es la sentencia.
--
-- ── Por qué no lo agarró el arnés ──
--
-- Porque PGlite es Postgres pelado: `pg_safeupdate` es una extensión que
-- Supabase agrega, no algo del motor. El arnés prueba el SQL contra Postgres,
-- no contra la configuración de Supabase — y esta es la diferencia entre las
-- dos. Es el mismo aviso que la 101 ya había mostrado en el editor SQL
-- ("This query runs an UPDATE without a WHERE clause") y que ahí era solo un
-- cartel; en tiempo de ejecución es un error.
--
-- ── El cambio ──
--
-- `TRUNCATE` en vez de `DELETE`: no lo alcanza la extensión, y además es lo
-- correcto para vaciar una tabla entera —no recorre filas ni genera basura que
-- después haya que limpiar—.
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
     * El grupo de cada ONU: la caja si la hay, y si no el puerto PON.
     *
     * Se resuelve una sola vez porque se usa tres veces —contar caídas por
     * grupo, saltear los abonados de un grupo ya avisado, y cerrar el evento
     * cuando el grupo vuelve—.
     */
    CREATE TEMP TABLE IF NOT EXISTS _grupos_onu (
        onu_id UUID PRIMARY KEY,
        grupo_tipo TEXT,
        grupo_clave TEXT,
        grupo_nombre TEXT,
        caida BOOLEAN
    ) ON COMMIT DROP;

    -- TRUNCATE y no DELETE: `pg_safeupdate`, que Supabase carga en las sesiones
    -- del API, rechaza un DELETE sin WHERE.
    TRUNCATE _grupos_onu;

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
            SELECT o.id, o.sn, g.grupo_nombre
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


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT * FROM detectar_alertas();   -- ya no da "DELETE requires a WHERE clause"
--   SELECT regla, etiqueta, detalle->>'direccion' FROM alerta_eventos WHERE resuelto_en IS NULL;
