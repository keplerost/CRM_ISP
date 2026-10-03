-- =============================================================================
-- Migración 204 — La subida saturada
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Un abonado que llena su propia subida —cámaras subiendo a la nube, torrents,
-- un equipo infectado, un backup— se queda lento para todo, porque cada página
-- que pide necesita subir algo y la subida está tapada. Llama diciendo que "el
-- internet anda mal", y no es la red: es su casa.
--
-- Esto lo detecta mientras pasa: el middleware mide la subida de cada cola
-- cada pocos minutos y, si el abonado pasa un tiempo sostenido por encima de un
-- porcentaje de su límite, abre una alerta. La alerta sale por la campana y
-- por los destinos configurados en Ajustes → Alertas, como las demás.
--
-- ── Lo que NO hace ──
--
-- No corta ni limita a nadie. Avisa, y deja la evidencia en la ficha para
-- cuando llame.
--
-- ── Los dos números ──
--
--   umbral      % del límite de subida de su cola. 80 de fábrica.
--   espera_min  cuánto tiene que sostenerse antes de avisar. 15 de fábrica:
--               una foto a WhatsApp o una videollamada corta no son el caso.
-- =============================================================================

INSERT INTO alerta_reglas (clave, nombre, descripcion, espera_min, umbral, desde_hora, hasta_hora)
VALUES (
    'subida_saturada',
    'Subida saturada',
    'Un abonado lleva un rato usando casi toda su subida. Se pone lento para todo y suele llamar diciendo que es el internet: es tráfico que sale de su casa.',
    15, 80, NULL, NULL
)
ON CONFLICT (clave) DO NOTHING;


-- =============================================================================
-- La tarea que mide
-- =============================================================================
/**
 * Encendida de fábrica: solo LEE las colas del router (una consulta por
 * equipo) y anota eventos. No toca la configuración de nadie.
 */
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS subida_automatico   BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS subida_cada_minutos INT     NOT NULL DEFAULT 5
        CHECK (subida_cada_minutos BETWEEN 1 AND 60);

COMMENT ON COLUMN config_tareas.subida_automatico IS
    'Medir la subida de cada abonado y alertar cuando la satura de forma sostenida.';
COMMENT ON COLUMN config_tareas.subida_cada_minutos IS
    'Cada cuántos minutos se mide. La velocidad es el promedio entre dos lecturas.';


-- =============================================================================
-- Que WhatsApp y Telegram esperen la confirmación
-- =============================================================================
/**
 * La misma función de la migración 112, con una condición más.
 *
 * Para las demás reglas, "abierto y cumplió la espera" alcanza. Para esta no:
 * el evento se abre con la primera muestra alta y la tarea de envíos podría
 * pasar justo antes de la muestra que lo confirma o lo borra. Se manda solo
 * cuando el middleware ya lo dio por sostenido, que es cuando suena la campana:
 * los dos avisos dicen lo mismo y al mismo tiempo.
 */
CREATE OR REPLACE FUNCTION alertas_por_enviar()
RETURNS TABLE (
    id UUID, regla VARCHAR, nombre VARCHAR, entidad VARCHAR, entidad_id VARCHAR,
    etiqueta VARCHAR, zona VARCHAR, abonados INT, detalle JSONB,
    empezo_en TIMESTAMPTZ, resuelto BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT e.id, e.regla, r.nombre, e.entidad, e.entidad_id, e.etiqueta, e.zona,
           e.abonados, e.detalle, e.empezo_en,
           (e.resuelto_en IS NOT NULL) AS resuelto
      FROM alerta_eventos e
      JOIN alerta_reglas r ON r.clave = e.regla
     WHERE r.activa
       AND (
         (e.avisado_en IS NULL
          AND e.resuelto_en IS NULL
          AND e.empezo_en <= NOW() - (r.espera_min || ' minutes')::INTERVAL
          AND (e.regla <> 'subida_saturada' OR e.detalle ? 'confirmado_en'))
         OR
         (e.resuelto_en IS NOT NULL AND e.avisado_en IS NOT NULL AND e.resuelto_avisado_en IS NULL)
       )
       -- La franja, en la hora del ISP y no en la del servidor de la base (UTC).
       -- Si cruza la medianoche (20:00 a 07:00) vale de un lado o del otro.
       AND (r.desde_hora IS NULL OR r.hasta_hora IS NULL
            OR CASE WHEN r.desde_hora <= r.hasta_hora
                    THEN (NOW() AT TIME ZONE zona_horaria())::time BETWEEN r.desde_hora AND r.hasta_hora
                    ELSE (NOW() AT TIME ZONE zona_horaria())::time >= r.desde_hora
                      OR (NOW() AT TIME ZONE zona_horaria())::time <= r.hasta_hora
               END)
     ORDER BY e.abonados DESC, e.empezo_en
$$;


-- =============================================================================
-- La evidencia en la ficha
-- =============================================================================
/**
 * Las veces que este abonado saturó su subida.
 *
 * `alerta_eventos` solo lo lee quien configura alertas, y la ficha la abre
 * soporte, que es justamente quien atiende la llamada. Por eso va por una
 * función: devuelve solo los eventos de esta regla y de este abonado, y nada
 * más de la tabla.
 *
 * Solo los confirmados —los que sostuvieron la espera—: un pico que no duró
 * no es evidencia de nada, y el middleware ni siquiera lo deja guardado.
 */
CREATE OR REPLACE FUNCTION subida_saturada_de(p_cliente UUID)
RETURNS TABLE (
    id          UUID,
    empezo_en   TIMESTAMPTZ,
    resuelto_en TIMESTAMPTZ,
    detalle     JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT e.id, e.empezo_en, e.resuelto_en, e.detalle
      FROM alerta_eventos e
     WHERE e.regla = 'subida_saturada'
       AND e.entidad = 'cliente'
       AND e.entidad_id = p_cliente::text
       AND e.detalle ? 'confirmado_en'
       AND auth.uid() IS NOT NULL
     ORDER BY e.empezo_en DESC
     LIMIT 50
$$;

COMMENT ON FUNCTION subida_saturada_de IS
    'Historial de subida saturada de un abonado, para mostrar en su ficha.';

REVOKE ALL ON FUNCTION subida_saturada_de(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION subida_saturada_de(UUID) TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT * FROM alerta_reglas WHERE clave = 'subida_saturada';
--   SELECT subida_automatico, subida_cada_minutos FROM config_tareas;
--
--   -- Lo que está pasando ahora:
--   SELECT etiqueta, empezo_en, avisado_en, detalle
--     FROM alerta_eventos
--    WHERE regla = 'subida_saturada' AND resuelto_en IS NULL;
