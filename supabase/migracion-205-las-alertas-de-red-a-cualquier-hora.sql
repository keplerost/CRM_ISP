-- =============================================================================
-- Migración 205 — Las alertas de red a cualquier hora
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- 1. "ONT sin señal" y "Potencia crítica" solo se mandaban de 07:00 a 22:00.
--    Un abonado sin servicio a las 23:00 es tan urgente como a las 15:00: pasan
--    a salir a cualquier hora, apenas cumplen su espera. "Señal degradándose"
--    conserva su franja: se mide sobre días y no amerita despertar a nadie.
--
-- 2. La franja horaria se comparaba con LOCALTIME, que es la hora del servidor
--    de la base —UTC en Supabase—, cinco horas adelante de Ecuador. "07:00 a
--    22:00" funcionaba en realidad de 02:00 a 17:00: retenía las alertas de la
--    tarde y dejaba salir las de madrugada. Ahora se compara con la hora de la
--    zona configurada (`zona_horaria()`), y una franja que cruza la medianoche
--    —20:00 a 07:00, la guardia nocturna— funciona como se lee.
--
-- Las esperas (minutos antes de avisar) no cambian: son las que evitan que un
-- corte de luz de dos minutos mande cien mensajes.
-- =============================================================================

UPDATE alerta_reglas
   SET desde_hora = NULL,
       hasta_hora = NULL,
       actualizado_en = NOW()
 WHERE clave IN ('ont_caida', 'potencia_critica')
   AND (desde_hora IS NOT NULL OR hasta_hora IS NOT NULL);


-- Igual a la de la migración 204, con la franja corregida.
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
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, espera_min, desde_hora, hasta_hora FROM alerta_reglas ORDER BY clave;
--
--   -- La hora con la que se compara la franja (tiene que ser la de Ecuador):
--   SELECT (NOW() AT TIME ZONE zona_horaria())::time AS hora_local, LOCALTIME AS hora_del_servidor;
