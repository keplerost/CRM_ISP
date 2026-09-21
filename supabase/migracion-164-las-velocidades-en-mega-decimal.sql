-- =============================================================================
-- Migración 164 — Las velocidades, en mega decimal
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué estaba mal ──
--
-- Los cinco planes tenían la velocidad cargada con la convención de que un Mega
-- son 1024 kbps:
--
--   PLAN_BASICO    51200 kbps  =  50 × 1024
--   PLAN_HOME     153600 kbps  = 150 × 1024
--   PLAN_PRO      307200 kbps  = 300 × 1024
--   PLAN_PRO_MAX  409600 kbps  = 400 × 1024
--   PLAN_ULTRA    512000 kbps  = 500 × 1024
--
-- Pero el sistema entero divide por 1000 —la ficha del abonado, las pantallas de
-- la OLT, el reporte del regulador—, así que un plan de 50 Mbps se mostraba como
-- 51.2 Mbps en todos lados.
--
-- ── Por qué importa y no es un detalle cosmético ──
--
-- Porque el mismo campo alimenta tres cosas que tienen que decir lo mismo:
--
--   El CONTRATO de adhesión que firma el abonado.
--   El REPORTE a ARCOTEL, que declara la velocidad contratada.
--   Las COLAS del router, que es lo que el abonado recibe.
--
-- Un contrato que dice 50 y un reporte que dice 51.2 es una diferencia que el
-- regulador puede observar, y no hay forma de explicarla salvo "está mal cargado".
--
-- ── Qué cambia en la red ──
--
-- El techo de cada cola baja un 2,34%: de 51200 a 50000 kbps. En la práctica no
-- se nota —nadie satura su plan de forma sostenida— y a cambio el abonado recibe
-- exactamente lo que dice su contrato, que es lo que corresponde.
--
-- Las colas se reescriben cuando el plan se vuelve a aplicar. Esta migración
-- cambia el dato; el shaping se sincroniza con la pantalla de la red, como
-- siempre.
--
-- ── Por qué solo toca los múltiplos exactos de 1024 ──
--
-- Porque son los que tienen la convención vieja. Un plan cargado a mano en 60000
-- kbps ya está en decimal y dividirlo otra vez lo dejaría en 58.6: la migración
-- se aplicaría a sí misma cada vez que se corre, y cada corrida achicaría los
-- planes un poco más.
-- =============================================================================

/**
 * Se guarda cómo estaba antes de tocar nada.
 *
 * No es paranoia: es un cambio de velocidad sobre planes con abonados. Si
 * mañana aparece que alguno de verdad era de 51.2, esta tabla dice exactamente
 * qué valor tenía y cuándo se cambió, sin depender de que alguien se acuerde.
 */
CREATE TABLE IF NOT EXISTS planes_velocidad_historico (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id        UUID REFERENCES planes_velocidad(id) ON DELETE CASCADE,
    nombre         VARCHAR(100),
    bajada_kbps    INT,
    subida_kbps    INT,
    motivo         TEXT,
    cambiado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE planes_velocidad_historico IS
    'Cómo estaba la velocidad de un plan antes de que una migración o una corrección la cambiara. Se consulta cuando alguien pregunta por qué su plan mide distinto que el mes pasado.';

ALTER TABLE planes_velocidad_historico ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planes_historico_lectura ON planes_velocidad_historico;
CREATE POLICY planes_historico_lectura ON planes_velocidad_historico
    FOR SELECT TO authenticated USING (TRUE);


DO $arreglo$
DECLARE
    v_tocados INT;
BEGIN
    /**
     * Solo los múltiplos exactos de 1024, y solo si al dividir dan un número
     * redondo de mega.
     *
     * La segunda condición es la que impide que la migración se coma a sí misma:
     * 50000 / 1024 no es entero, así que un plan ya corregido no vuelve a
     * entrar. Correrla diez veces deja el mismo resultado que correrla una.
     */
    WITH candidatos AS (
        SELECT id, nombre, bajada_kbps, subida_kbps
          FROM planes_velocidad
         WHERE bajada_kbps IS NOT NULL
           AND bajada_kbps % 1024 = 0
           AND (subida_kbps IS NULL OR subida_kbps % 1024 = 0)
    ), guardados AS (
        INSERT INTO planes_velocidad_historico (plan_id, nombre, bajada_kbps, subida_kbps, motivo)
        SELECT id, nombre, bajada_kbps, subida_kbps,
               'Migración 164: estaban en mega de 1024, el sistema lee mega de 1000'
          FROM candidatos
        RETURNING plan_id
    )
    UPDATE planes_velocidad p
       SET bajada_kbps = (p.bajada_kbps / 1024) * 1000,
           subida_kbps = CASE WHEN p.subida_kbps IS NULL
                              THEN NULL
                              ELSE (p.subida_kbps / 1024) * 1000 END
      FROM candidatos c
     WHERE p.id = c.id;

    GET DIAGNOSTICS v_tocados = ROW_COUNT;

    IF v_tocados = 0 THEN
        RAISE NOTICE 'Ningún plan estaba en mega de 1024: no había nada que corregir.';
    ELSE
        RAISE NOTICE '% plan(es) pasaron a mega decimal. Lo anterior quedó en planes_velocidad_historico.', v_tocados;
    END IF;
END $arreglo$;


/**
 * Y los mismos campos del resto del plan, si algún día se cargan.
 *
 * Hoy están vacíos —solo bajada y subida tenían valor— pero el burst, el umbral y
 * el garantizado se escriben con la misma convención que la velocidad. Se
 * corrigen ahora para que no queden dos criterios conviviendo en la misma fila el
 * día que alguien los complete copiando el formato viejo.
 */
UPDATE planes_velocidad
   SET burst_bajada_kbps       = (burst_bajada_kbps / 1024) * 1000
 WHERE burst_bajada_kbps IS NOT NULL AND burst_bajada_kbps % 1024 = 0;

UPDATE planes_velocidad
   SET burst_subida_kbps       = (burst_subida_kbps / 1024) * 1000
 WHERE burst_subida_kbps IS NOT NULL AND burst_subida_kbps % 1024 = 0;

UPDATE planes_velocidad
   SET umbral_bajada_kbps      = (umbral_bajada_kbps / 1024) * 1000
 WHERE umbral_bajada_kbps IS NOT NULL AND umbral_bajada_kbps % 1024 = 0;

UPDATE planes_velocidad
   SET umbral_subida_kbps      = (umbral_subida_kbps / 1024) * 1000
 WHERE umbral_subida_kbps IS NOT NULL AND umbral_subida_kbps % 1024 = 0;

UPDATE planes_velocidad
   SET garantizado_bajada_kbps = (garantizado_bajada_kbps / 1024) * 1000
 WHERE garantizado_bajada_kbps IS NOT NULL AND garantizado_bajada_kbps % 1024 = 0;

UPDATE planes_velocidad
   SET garantizado_subida_kbps = (garantizado_subida_kbps / 1024) * 1000
 WHERE garantizado_subida_kbps IS NOT NULL AND garantizado_subida_kbps % 1024 = 0;


COMMENT ON COLUMN planes_velocidad.bajada_kbps IS
    'Velocidad de bajada en kbps DECIMALES: 50 Mbps son 50000, no 51200. Es la unidad que usa todo el sistema —contrato, reporte a ARCOTEL, pantallas— y la que lee el shaping.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Los planes, como los va a declarar el reporte:
--   SELECT nombre, bajada_kbps, bajada_kbps / 1000.0 AS down_mbps,
--          subida_kbps / 1000.0 AS up_mbps, comparticion
--     FROM planes_velocidad ORDER BY bajada_kbps;
--
--   -- Y cómo estaban antes:
--   SELECT nombre, bajada_kbps, subida_kbps, cambiado_en
--     FROM planes_velocidad_historico ORDER BY cambiado_en DESC;
