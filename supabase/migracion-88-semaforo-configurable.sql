-- =============================================================================
-- Migración 88 — El semáforo de instalaciones, leyendo los parámetros
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué quedó pendiente de la 84 ──
--
-- La 84 creó `parametros_tecnicos` y trató de hacer que `v_instalaciones` leyera
-- de ahí. El bloque que reescribía la vista no aplicó, y el resguardo funcionó:
-- no rompió nada, la vista siguió con los números escritos a mano.
--
-- ── Por qué falló, y cómo se averiguó ──
--
-- No se podía leer la definición de la vista desde afuera, así que se dedujeron
-- sus umbrales POR SONDEO: se creó una instalación de prueba y se le barrió la
-- potencia de -35 a 0 dBm de a 0,25, mirando en qué punto exacto cambiaba el
-- color.
--
--     rojo  → ámbar  al llegar a -27
--     ámbar → verde  al llegar a -25
--     verde → rojo   al llegar a -7,75      (o sea, el corte está en -8)
--     radio: -80 y -70 · ccq mínimo 80
--
-- Conclusión: los valores eran los correctos. Lo que no acertaba era el patrón
-- de texto — `pg_get_viewdef` no devuelve el SQL original, lo reimprime, y según
-- la versión un -27 sale como `'-27'::numeric`, como `(- 27)` o pelado.
--
-- Por eso esta versión no apuesta a un formato: busca el NÚMERO, venga como
-- venga. Y si algo no calza, lo dice con el fragmento exacto en la salida, en
-- vez de fallar en silencio.
-- =============================================================================


-- =============================================================================
-- 1. El reemplazo
-- =============================================================================
DO $$
DECLARE
    v_def      TEXT;
    v_original TEXT;
    v_par      TEXT[];
    v_n        INT;
    v_total    INT := 0;
    v_faltan   TEXT := '';

    -- Qué número corresponde a qué parámetro. El orden importa: -80 tiene que
    -- salir antes que -8, porque si no el patrón de -8 partiría al de -80.
    -- El `(?![0-9])` del patrón ya lo evita, pero el orden lo hace evidente
    -- para quien lea esto en un año.
    v_mapa TEXT[][] := ARRAY[
        ['-80', 'radio_limite'],
        ['-70', 'radio_optimo'],
        ['-27', 'optica_limite'],
        ['-25', 'optica_optimo'],
        ['-8',  'optica_saturado']
    ];
BEGIN
    SELECT pg_get_viewdef('v_instalaciones'::regclass, true) INTO v_def;
    v_original := v_def;

    FOREACH v_par SLICE 1 IN ARRAY v_mapa LOOP
        -- El patrón busca el número con su signo, permitiendo espacios y
        -- envoltorios: `-27`, `- 27`, `(-27)`, `'-27'::numeric`.
        --
        -- `(?<![0-9.])` y `(?![0-9.])` son lo que evita que -8 muerda dentro de
        -- -80 o que -27 muerda dentro de -27.5.
        v_n := 0;
        SELECT COUNT(*) INTO v_n
          FROM regexp_matches(
                 v_def,
                 '''?-\s*' || LTRIM(v_par[1], '-') || '''?(::numeric)?(?![0-9.])',
                 'g');

        IF v_n = 0 THEN
            v_faltan := v_faltan || v_par[1] || ' (' || v_par[2] || ') ';
        ELSE
            v_def := regexp_replace(
                v_def,
                '''?-\s*' || LTRIM(v_par[1], '-') || '''?(::numeric)?(?![0-9.])',
                '( SELECT p.' || v_par[2] || ' FROM parametros_tecnicos p WHERE p.id = 1 )',
                'g');
            v_total := v_total + v_n;
            RAISE NOTICE '  % → parametros_tecnicos.%  (% aparición/es)', v_par[1], v_par[2], v_n;
        END IF;
    END LOOP;

    -- El CCQ va aparte: es el único positivo, y un `80` suelto podría aparecer
    -- en cualquier lado. Se ancla a su comparación completa.
    SELECT COUNT(*) INTO v_n
      FROM regexp_matches(v_def, '<\s*80(?![0-9.])', 'g');
    IF v_n > 0 THEN
        v_def := regexp_replace(
            v_def, '<\s*80(?![0-9.])',
            '< ( SELECT p.radio_ccq_minimo FROM parametros_tecnicos p WHERE p.id = 1 )', 'g');
        v_total := v_total + v_n;
        RAISE NOTICE '  ccq 80 → parametros_tecnicos.radio_ccq_minimo  (% aparición/es)', v_n;
    ELSE
        v_faltan := v_faltan || '80 (radio_ccq_minimo) ';
    END IF;

    -- ── Todo o nada ──
    --
    -- Media vista reemplazada sería peor que ninguna: mezclaría dos fuentes de
    -- verdad, que es exactamente lo que esta migración vino a eliminar.
    IF v_faltan <> '' THEN
        RAISE WARNING 'NO se tocó la vista. No se encontraron estos umbrales: %', v_faltan;
        RAISE WARNING 'Pegale esta salida a quien hizo la migración — con el fragmento de abajo alcanza para arreglarlo:';
        RAISE WARNING '%', substring(v_original from '.{0,80}27.{0,80}');
    ELSE
        EXECUTE 'CREATE OR REPLACE VIEW v_instalaciones AS ' || v_def;
        RAISE NOTICE 'LISTO: v_instalaciones lee los umbrales de parametros_tecnicos (% reemplazos)', v_total;
    END IF;
END $$;


-- =============================================================================
-- 2. Cómo comprobarlo sin salir del editor
-- =============================================================================
-- Se mueve el umbral, se mira si el color cambió, y se deja como estaba. Si el
-- semáforo no se mueve, la vista siguió con los números fijos.
DO $$
DECLARE
    v_id     UUID;
    v_antes  TEXT;
    v_movido TEXT;
    v_opt    NUMERIC;
    v_lim    NUMERIC;
BEGIN
    SELECT optica_optimo, optica_limite INTO v_opt, v_lim FROM parametros_tecnicos WHERE id = 1;

    INSERT INTO instalaciones (tipo, estado, nombre, tecnologia, rx_power_dbm)
    VALUES ('nueva', 'agendada', 'SONDA 88', 'ftth', -21)
    RETURNING id INTO v_id;

    SELECT semaforo INTO v_antes FROM v_instalaciones WHERE id = v_id;

    UPDATE parametros_tecnicos SET optica_optimo = -5, optica_limite = -6 WHERE id = 1;
    SELECT semaforo INTO v_movido FROM v_instalaciones WHERE id = v_id;

    UPDATE parametros_tecnicos SET optica_optimo = v_opt, optica_limite = v_lim WHERE id = 1;
    DELETE FROM instalaciones WHERE id = v_id;

    IF v_antes IS DISTINCT FROM v_movido THEN
        RAISE NOTICE 'COMPROBADO: una lectura de -21 dBm pasó de % a % al mover el umbral. La vista lee los parámetros.', v_antes, v_movido;
    ELSE
        RAISE WARNING 'La vista NO lee los parámetros: el color siguió en % con el umbral movido.', v_antes;
    END IF;
END $$;


-- =============================================================================
-- 3. Las vistas del tablero GPON
-- =============================================================================
-- Quedan para otra migración, y se deja anotado para que no se pierda:
-- `v_gpon_*` (migraciones 39 y 40) marcan aviso por debajo de -24, mientras que
-- instalaciones lo hace en -25. La misma ONU a -24,5 sale verde en una pantalla
-- y amarilla en otra, y quien mire las dos juntas concluye —con razón— que una
-- de las dos miente.
--
-- No se tocan acá porque son del tablero de la oficina y esta migración es del
-- semáforo de campo: mezclarlas haría que un problema en una impida arreglar la
-- otra.
