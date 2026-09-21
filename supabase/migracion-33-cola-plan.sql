-- =============================================================================
-- Migración 33 — Cómo se traduce un plan a una cola del router
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 32. Es idempotente.
--
-- Hasta ahora el plan solo decía dos números: cuánto baja y cuánto sube. Eso
-- alcanza para un max-limit, pero no para una cola de verdad.
--
-- El disparador de esta migración fue concreto: al aplicar un plan con burst a
-- un router real, el equipo rechazó la cola entera con "no download-burst-time".
-- RouterOS no acepta un `burst-limit` suelto — exige también a partir de qué
-- caudal se habilita (`burst-threshold`) y cuántos segundos dura
-- (`burst-time`)—. Y el plan no guardaba ninguno de los dos.
--
-- Esos valores no se pueden poner por defecto: cuántos segundos puede un
-- abonado pasarse de su plan, y qué caudal se le garantiza cuando la red está
-- cargada, son decisiones comerciales del ISP. Se configuran, no se adivinan.
--
-- Todas las columnas van en kbps, como `bajada_kbps` y `subida_kbps`, para no
-- tener dos unidades en la misma tabla. Todas admiten nulo: un plan sin nada de
-- esto sigue siendo un max-limit y nada más, que es como funcionaba antes.
-- =============================================================================

ALTER TABLE planes_velocidad
    -- Ráfaga: hasta cuánto puede subir por encima de su plan.
    ADD COLUMN IF NOT EXISTS burst_bajada_kbps INT
        CHECK (burst_bajada_kbps IS NULL OR burst_bajada_kbps > 0),
    ADD COLUMN IF NOT EXISTS burst_subida_kbps INT
        CHECK (burst_subida_kbps IS NULL OR burst_subida_kbps > 0),

    -- Umbral: por debajo de este promedio se le habilita la ráfaga. Suele
    -- ponerse algo por debajo del plan, para que el que ya viene usando todo su
    -- caudal no acumule ráfaga.
    ADD COLUMN IF NOT EXISTS umbral_bajada_kbps INT
        CHECK (umbral_bajada_kbps IS NULL OR umbral_bajada_kbps > 0),
    ADD COLUMN IF NOT EXISTS umbral_subida_kbps INT
        CHECK (umbral_subida_kbps IS NULL OR umbral_subida_kbps > 0),

    -- Cuántos segundos dura la ráfaga.
    ADD COLUMN IF NOT EXISTS burst_segundos_bajada INT
        CHECK (burst_segundos_bajada IS NULL OR burst_segundos_bajada BETWEEN 1 AND 120),
    ADD COLUMN IF NOT EXISTS burst_segundos_subida INT
        CHECK (burst_segundos_subida IS NULL OR burst_segundos_subida BETWEEN 1 AND 120),

    -- Caudal garantizado (`limit-at`): lo que se le asegura aunque la red esté
    -- saturada. Es la diferencia entre vender "hasta 100 megas" y vender
    -- "100 megas".
    ADD COLUMN IF NOT EXISTS garantizado_bajada_kbps INT
        CHECK (garantizado_bajada_kbps IS NULL OR garantizado_bajada_kbps > 0),
    ADD COLUMN IF NOT EXISTS garantizado_subida_kbps INT
        CHECK (garantizado_subida_kbps IS NULL OR garantizado_subida_kbps > 0),

    -- Prioridad de 1 a 8: el 1 se atiende primero cuando hay congestión. Es lo
    -- que distingue un plan corporativo de uno hogareño con la misma velocidad.
    ADD COLUMN IF NOT EXISTS prioridad SMALLINT
        CHECK (prioridad IS NULL OR prioridad BETWEEN 1 AND 8);

COMMENT ON COLUMN planes_velocidad.umbral_bajada_kbps IS
    'burst-threshold: por debajo de este promedio se habilita la ráfaga. Sin él RouterOS rechaza la cola entera.';

COMMENT ON COLUMN planes_velocidad.garantizado_bajada_kbps IS
    'limit-at: caudal asegurado aunque la red esté saturada. Es la diferencia entre vender "hasta 100 megas" y "100 megas".';

COMMENT ON COLUMN planes_velocidad.prioridad IS
    '1 a 8, donde 1 se atiende primero. Distingue un plan corporativo de uno hogareño con la misma velocidad.';


-- =============================================================================
-- Lo que había escrito en `burst_limit`
-- =============================================================================
-- La columna vieja es texto libre, del estilo "120M/60M": bajada primero,
-- porque se escribía como se le vende al cliente. Se pasa a números para no
-- perder lo que ya estaba cargado.
--
-- El umbral y la duración quedan vacíos a propósito: no estaban en ningún lado,
-- y ponerles un valor inventado es exactamente lo que esta migración viene a
-- evitar. Hasta que se completen, la ráfaga no se aplica — y la pantalla lo
-- dice, en vez de fallar contra el equipo.
UPDATE planes_velocidad
   SET burst_bajada_kbps = COALESCE(
           burst_bajada_kbps,
           CASE
               WHEN split_part(burst_limit, '/', 1) ~* '^\s*\d+(\.\d+)?\s*[kmg]?\s*$' THEN
                   ROUND(
                       (regexp_replace(split_part(burst_limit, '/', 1), '[^0-9.]', '', 'g'))::NUMERIC
                       * CASE lower(right(trim(split_part(burst_limit, '/', 1)), 1))
                             WHEN 'g' THEN 1000000
                             WHEN 'm' THEN 1000
                             ELSE 1
                         END
                   )::INT
           END
       ),
       burst_subida_kbps = COALESCE(
           burst_subida_kbps,
           CASE
               WHEN split_part(burst_limit, '/', 2) ~* '^\s*\d+(\.\d+)?\s*[kmg]?\s*$' THEN
                   ROUND(
                       (regexp_replace(split_part(burst_limit, '/', 2), '[^0-9.]', '', 'g'))::NUMERIC
                       * CASE lower(right(trim(split_part(burst_limit, '/', 2)), 1))
                             WHEN 'g' THEN 1000000
                             WHEN 'm' THEN 1000
                             ELSE 1
                         END
                   )::INT
           END
       )
 WHERE burst_limit IS NOT NULL;

COMMENT ON COLUMN planes_velocidad.burst_limit IS
    'OBSOLETA. Reemplazada por burst_bajada_kbps y burst_subida_kbps en la migración 33. Se conserva por si hay que revisar qué decía antes.';
