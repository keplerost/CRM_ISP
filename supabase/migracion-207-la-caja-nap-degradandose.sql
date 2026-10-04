-- =============================================================================
-- Migración 207 — La caja NAP degradándose
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 205 (alertas_por_enviar con la franja en hora del ISP).
--
-- ── Qué resuelve ──
--
-- Cuando empeora la potencia de TODOS los clientes de una caja a la vez, el
-- problema no está en ninguna casa: está antes de la caja —la fibra de
-- distribución, un conector sucio, el splitter—. Se ve en el promedio de la
-- caja días antes de que alguien se quede sin señal.
--
-- La regla "Señal degradándose" (`degradacion`) existía en Ajustes → Alertas
-- pero ningún proceso la generaba. Pasa a ser ESTA alerta, por caja NAP.
--
-- ── Cómo se decide ──
--
--   · Se comparan las MISMAS ONTs en dos momentos: su promedio de las últimas
--     24 horas contra su promedio de hace 7 días (entre 6 y 8 días atrás).
--     Comparar todas las de la caja haría que un cliente nuevo y lejano
--     "empeore" el promedio sin que nada se haya dañado.
--   · Hacen falta al menos 3 ONTs con lectura en los dos momentos. Con menos,
--     es un problema de un cliente, no de la caja.
--   · Si el promedio cayó `umbral` dB o más (2 de fábrica), se abre la alerta.
--   · Se cierra cuando la caja vuelve a menos de 1 dB del promedio que tenía
--     ANTES de degradarse — no contra "hace 7 días", que al cabo de una semana
--     ya sería el valor degradado y cerraría la alerta sin que nadie arreglara
--     nada.
--
-- ── A quién avisa ──
--
--   · La campana: super administradores, administradores, jefes técnicos,
--     técnicos y finanzas.
--   · Los destinos de Ajustes → Alertas, sin espera (espera_min = 0) y a
--     cualquier hora.
--
-- La detección corre al final de cada lectura óptica, que es cuando hay datos
-- nuevos. Sin OLTs ni cajas NAP cargadas no detecta nada, y no falla.
-- =============================================================================

UPDATE alerta_reglas
   SET nombre      = 'NAP degradándose',
       descripcion = 'El promedio de potencia de los clientes de una caja empeoró de golpe o de a poco. No es un cliente: es la fibra, un conector o el splitter que alimenta la caja. Se arregla antes de que se corte.',
       umbral      = 2,
       espera_min  = 0,
       desde_hora  = NULL,
       hasta_hora  = NULL,
       actualizado_en = NOW()
 WHERE clave = 'degradacion'
   AND nombre <> 'NAP degradándose';


/**
 * Detecta, abre, actualiza y cierra los eventos de cajas degradadas.
 *
 * Devuelve cuántos eventos nuevos abrió. La campana la deja acá mismo, en la
 * misma transacción que el evento: no depende de que otra tarea esté
 * encendida para que el técnico se entere.
 */
CREATE OR REPLACE FUNCTION detectar_nap_degradada()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_regla   alerta_reglas%ROWTYPE;
    v_umbral  NUMERIC;
    v_nuevos  INT := 0;
    v_id      UUID;
    r         RECORD;
    u         RECORD;
BEGIN
    SELECT * INTO v_regla FROM alerta_reglas WHERE clave = 'degradacion';
    IF NOT FOUND OR NOT v_regla.activa THEN
        RETURN 0;
    END IF;
    v_umbral := COALESCE(v_regla.umbral, 2);

    CREATE TEMP TABLE IF NOT EXISTS _nap_hoy (
        nap_id UUID PRIMARY KEY, onts INT, ahora NUMERIC, antes NUMERIC
    ) ON COMMIT DROP;
    TRUNCATE _nap_hoy;

    INSERT INTO _nap_hoy (nap_id, onts, ahora, antes)
    WITH ahora AS (
        SELECT h.onu_id, AVG(h.rx_dbm) AS rx
          FROM onu_optica_historial h
         WHERE h.medida_at >= NOW() - INTERVAL '1 day'
           AND h.rx_dbm IS NOT NULL
         GROUP BY h.onu_id
    ),
    antes AS (
        SELECT h.onu_id, AVG(h.rx_dbm) AS rx
          FROM onu_optica_historial h
         WHERE h.medida_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '6 days'
           AND h.rx_dbm IS NOT NULL
         GROUP BY h.onu_id
    )
    SELECT o.nap_id, COUNT(*)::int, ROUND(AVG(a.rx), 2), ROUND(AVG(b.rx), 2)
      FROM ahora a
      JOIN antes b ON b.onu_id = a.onu_id
      JOIN onus o  ON o.id = a.onu_id
     WHERE o.nap_id IS NOT NULL
     GROUP BY o.nap_id
    HAVING COUNT(*) >= 3;

    -- ── Abrir o actualizar ──
    FOR r IN
        SELECT n.*, p.nombre, p.direccion,
               (SELECT c.zona FROM clientes c
                 WHERE c.nap_id = n.nap_id AND c.zona IS NOT NULL
                 GROUP BY c.zona ORDER BY COUNT(*) DESC LIMIT 1) AS zona
          FROM _nap_hoy n
          JOIN puntos_red p ON p.id = n.nap_id
         WHERE n.antes - n.ahora >= v_umbral
    LOOP
        UPDATE alerta_eventos
           SET abonados = r.onts,
               detalle  = detalle || jsonb_build_object(
                   'hasta', r.ahora, 'onus', r.onts,
                   'caida', ROUND(r.antes - r.ahora, 2), 'medido_en', NOW())
         WHERE regla = 'degradacion' AND entidad = 'nap'
           AND entidad_id = r.nap_id::text AND resuelto_en IS NULL;

        IF NOT FOUND THEN
            INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, zona, abonados, detalle)
            VALUES ('degradacion', 'nap', r.nap_id::text, r.nombre, r.zona, r.onts,
                    jsonb_build_object(
                        'desde', r.antes, 'hasta', r.ahora,
                        'caida', ROUND(r.antes - r.ahora, 2), 'dias', 7,
                        'onus', r.onts, 'direccion', r.direccion, 'medido_en', NOW()))
            RETURNING id INTO v_id;
            v_nuevos := v_nuevos + 1;

            FOR u IN
                SELECT id FROM usuarios_sistema
                 WHERE activo AND rol IN ('super_admin', 'admin', 'jefe_tecnico', 'tecnico', 'finanzas')
            LOOP
                PERFORM notificar(
                    u.id, 'nap_degradada',
                    format('%s: la caja se está degradando', r.nombre),
                    format('El promedio de sus %s clientes bajó de %s a %s dBm (%s dB en 7 días). '
                           'Es la fibra, un conector o el splitter que alimenta la caja, no un cliente.',
                           r.onts, ROUND(r.antes, 1), ROUND(r.ahora, 1), ROUND(r.antes - r.ahora, 1)),
                    '/naps', 'nap', r.nap_id::text);
            END LOOP;
        END IF;
    END LOOP;

    -- ── Cerrar ──
    -- Contra el promedio de ANTES de degradarse, guardado al abrir.
    UPDATE alerta_eventos e
       SET resuelto_en = NOW(),
           detalle = e.detalle || jsonb_build_object('hasta', n.ahora, 'medido_en', NOW())
      FROM _nap_hoy n
     WHERE e.regla = 'degradacion' AND e.entidad = 'nap' AND e.resuelto_en IS NULL
       AND e.entidad_id = n.nap_id::text
       AND n.ahora >= (e.detalle->>'desde')::numeric - 1;

    -- Una caja que se quedó sin lecturas tres días (se borró, se reasignaron sus
    -- ONTs, la OLT dejó de leerse) no puede quedar abierta para siempre.
    UPDATE alerta_eventos e
       SET resuelto_en = NOW()
     WHERE e.regla = 'degradacion' AND e.entidad = 'nap' AND e.resuelto_en IS NULL
       AND COALESCE((e.detalle->>'medido_en')::timestamptz, e.empezo_en) < NOW() - INTERVAL '3 days';

    RETURN v_nuevos;
END;
$$;

COMMENT ON FUNCTION detectar_nap_degradada IS
    'Abre una alerta cuando el promedio de potencia de una caja NAP cae el umbral de la regla "degradacion" en 7 días. La corre la lectura óptica.';

REVOKE ALL ON FUNCTION detectar_nap_degradada() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION detectar_nap_degradada() TO service_role;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, nombre, umbral, espera_min, desde_hora FROM alerta_reglas WHERE clave = 'degradacion';
--   SELECT detectar_nap_degradada();
--   SELECT etiqueta, abonados, detalle FROM alerta_eventos
--    WHERE regla = 'degradacion' AND resuelto_en IS NULL;
