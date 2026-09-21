-- =============================================================================
-- Migración 89 — La visita que no salió bien, y la llegada al domicilio
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Los dos huecos que cierra ──
--
-- 1. El sistema sabe registrar el trabajo QUE SALE BIEN. El asistente de campo
--    solo sabe avanzar hacia el cierre. El técnico que llega y no puede
--    instalar —no hay línea de vista, la caja está llena, no había nadie— tiene
--    que llamar a la oficina para que lo cambien desde el escritorio. Y si no
--    llama, la orden queda "agendada" para siempre y figura como atrasada.
--
--    Los estados `no_realizada` y `reprogramada` ya los acepta la tabla; lo que
--    falta es dónde anotar POR QUÉ, que es el dato que sirve.
--
-- 2. En un ticket, "Llegué" toma el GPS y lo guarda. En una instalación no se
--    registra nada: se sabe cuándo se cerró, no cuándo se llegó. Es el mismo
--    técnico en el mismo domicilio, y en un caso queda constancia y en el otro
--    no.
-- =============================================================================


-- =============================================================================
-- 0. URGENTE — reponer el filtro de seguridad de la vista
-- =============================================================================
-- ── Qué pasó ──
--
-- `v_instalaciones` se creó en la migración 31 con `security_invoker = true`.
-- Esa opción es lo que hace que la vista aplique las políticas de quien
-- consulta; sin ella, corre con los permisos de quien la creó y EVADE RLS.
--
-- La migración 88 la recreó así:
--
--     CREATE OR REPLACE VIEW v_instalaciones AS ...
--
-- sin repetir el `WITH (security_invoker = true)`. Eso no la conserva: la borra.
--
-- ── Qué quedó expuesto ──
--
-- Todo lo que la vista muestra, a cualquiera con sesión: nombre y dirección del
-- abonado, coordenadas, y —lo más grave— `usuario_ppp` y `clave_ppp`, que son
-- las credenciales con las que ese cliente se conecta.
--
-- Se detectó comprobando con un vendedor de prueba: veía la instalación que no
-- le corresponde.
--
-- ── Por qué va primero ──
--
-- Porque si algo más de esta migración falla, esto ya quedó arreglado.
ALTER VIEW v_instalaciones SET (security_invoker = true);

DO $$
BEGIN
    RAISE NOTICE 'Repuesto security_invoker en v_instalaciones. Antes de esto, cualquiera con sesión veía todas las instalaciones.';
END $$;


-- =============================================================================
-- 1. Por qué no se pudo
-- =============================================================================
ALTER TABLE instalaciones
    -- El motivo en texto libre y ADEMÁS clasificado. El texto sirve para el
    -- caso puntual; la clasificación es lo que después responde "¿cuántas
    -- visitas perdimos por cajas llenas este mes?", que es una decisión de
    -- inversión y no se puede sacar de un campo libre.
    ADD COLUMN IF NOT EXISTS motivo_no_realizada  VARCHAR(30),
    ADD COLUMN IF NOT EXISTS detalle_no_realizada TEXT,

    -- Cuándo se vuelve. Nulo con estado `no_realizada` significa "todavía no se
    -- sabe": es un caso real —hay que esperar obra— y forzar una fecha
    -- inventada llenaría la agenda de visitas que nadie va a hacer.
    ADD COLUMN IF NOT EXISTS reprogramada_para DATE;

-- La restricción va aparte, con su DROP delante.
--
-- En `ALTER TABLE` la palabra es `ADD CONSTRAINT`; escribir `CONSTRAINT` suelto
-- —como se hace dentro de `CREATE TABLE`— es un error de sintaxis. Y como
-- `ADD CONSTRAINT` no admite `IF NOT EXISTS`, el `DROP` previo es lo que
-- permite volver a correr esta migración sin que falle la segunda vez.
ALTER TABLE instalaciones
    DROP CONSTRAINT IF EXISTS instalaciones_motivo_no_realizada_check;
ALTER TABLE instalaciones
    ADD CONSTRAINT instalaciones_motivo_no_realizada_check CHECK (
        motivo_no_realizada IS NULL OR motivo_no_realizada IN (
            'sin_nadie',        -- no había quien reciba
            'sin_cobertura',    -- no hay línea de vista o no llega la fibra
            'caja_llena',       -- la NAP no tiene puertos libres
            'falta_material',   -- al técnico le faltó algo
            'cliente_desiste',  -- se arrepintió en el momento
            'direccion_erronea',
            'requiere_obra',    -- hay que tender o levantar algo antes
            'otro'
        )
    );

COMMENT ON COLUMN instalaciones.motivo_no_realizada IS
    'Por qué no se pudo hacer. Clasificado para poder contar: "tres visitas perdidas por caja llena en Selva Alegre" es una decisión de inversión, y de un texto libre no sale.';


-- =============================================================================
-- 2. Cuándo llegó
-- =============================================================================
-- Las mismas cuatro columnas que ya tiene `tickets`, con los mismos nombres. Que
-- se llamen igual no es prolijidad: es lo que permite que mañana una consulta
-- pregunte "cuánto tarda este técnico en llegar" sin distinguir si fue a una
-- instalación o a una reparación.
ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS llegada_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS llegada_lat         NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS llegada_lng         NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS llegada_precision_m INT;

-- ── Por qué la coordenada NO es obligatoria ──
--
-- La regla de la migración 72 exige que una ubicación cargada a mano venga con
-- su precisión: prohíbe inventar una coordenada. Esta es otra cosa: acá el GPS
-- puede fallar de verdad —bajo techo, en un galpón, con el cielo tapado— y
-- negarle al técnico marcar la llegada porque el teléfono no ubicó sería
-- pedirle que resuelva algo que no depende de él.
--
-- Lo que sí se prohíbe es lo mismo de siempre: una coordenada sin precisión, que
-- es una coordenada de la que nadie puede decir si sirve.
ALTER TABLE instalaciones
    DROP CONSTRAINT IF EXISTS instalaciones_llegada_coherente;
ALTER TABLE instalaciones
    ADD CONSTRAINT instalaciones_llegada_coherente CHECK (
        (llegada_lat IS NULL AND llegada_lng IS NULL)
        OR (llegada_lat IS NOT NULL AND llegada_lng IS NOT NULL
            AND llegada_precision_m IS NOT NULL)
    );

COMMENT ON COLUMN instalaciones.llegada_at IS
    'Cuándo el técnico marcó que llegó al domicilio. Puede tener hora sin coordenada: el GPS falla bajo techo y eso no puede impedirle trabajar.';


-- =============================================================================
-- 3. Que se vea en la vista
-- =============================================================================
-- `v_instalaciones` se creó con `i.*`, y Postgres expande el asterisco al crear
-- la vista: las columnas nuevas no aparecerían solas.
--
-- Se reescribe la definición VIVA en vez de pegar una copia, por lo mismo que en
-- la migración 88: cualquier columna agregada entre la 31 y hoy —incluidos los
-- umbrales configurables que acabamos de meter— desaparecería en silencio.
DO $$
DECLARE
    v_def TEXT;
BEGIN
    /**
     * Si las columnas ya están expuestas, no hay nada que envolver.
     *
     * Envolver es la operación que NO se puede repetir: la segunda vez, el
     * `SELECT v.*, i.motivo_no_realizada` choca contra la columna que la primera
     * ya había agregado, y falla con "column already exists" — arrastrando toda
     * la migración, porque el editor de Supabase corre el archivo en una
     * transacción.
     *
     * Con esta guarda, volver a correr el archivo no hace nada en vez de
     * romperse. Y si quien la expone es una migración POSTERIOR —la 91 vuelve a
     * envolver la vista e incluye estas columnas por el `v.*`— tampoco hace
     * nada, que es exactamente lo correcto: lo último que se aplicó manda.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'v_instalaciones' AND column_name = 'motivo_no_realizada'
    ) THEN
        RAISE NOTICE 'v_instalaciones ya expone el motivo y la llegada: no se toca.';
        RETURN;
    END IF;

    SELECT pg_get_viewdef('v_instalaciones'::regclass, true) INTO v_def;

    -- El `i.*` original ya está expandido en la definición viva, así que las
    -- columnas nuevas se agregan envolviendo la vista y uniéndola a la tabla.
    --
    -- El `WITH (security_invoker = true)` va SIEMPRE, escrito a mano en cada
    -- recreación. Omitirlo no lo conserva: lo borra. Es el error que abrió el
    -- agujero de la sección 0, y la única forma de que no vuelva a pasar es que
    -- ninguna recreación de esta vista se escriba sin él.
    EXECUTE 'CREATE OR REPLACE VIEW v_instalaciones WITH (security_invoker = true) AS SELECT v.*, '
         || 'i.motivo_no_realizada, i.detalle_no_realizada, i.reprogramada_para, '
         || 'i.llegada_at, i.llegada_lat, i.llegada_lng, i.llegada_precision_m '
         || 'FROM (' || rtrim(v_def, ';') || ') v JOIN instalaciones i ON i.id = v.id';

    RAISE NOTICE 'v_instalaciones expone el motivo y la llegada, y sigue aplicando RLS.';
END $$;


-- =============================================================================
-- 3 bis. Comprobación de que el filtro quedó puesto
-- =============================================================================
-- No alcanza con haberlo escrito: si el bloque de arriba se recreó mal, esto lo
-- dice acá y no dentro de tres semanas.
DO $$
DECLARE
    v_invoker TEXT;
BEGIN
    SELECT COALESCE(
             (SELECT option_value FROM pg_options_to_table(c.reloptions)
               WHERE option_name = 'security_invoker'),
             'off')
      INTO v_invoker
      FROM pg_class c
     WHERE c.relname = 'v_instalaciones' AND c.relkind = 'v';

    IF v_invoker = 'true' THEN
        RAISE NOTICE 'COMPROBADO: v_instalaciones aplica RLS.';
    ELSE
        RAISE WARNING 'PELIGRO: v_instalaciones NO aplica RLS (security_invoker = %). Corré: ALTER VIEW v_instalaciones SET (security_invoker = true);', v_invoker;
    END IF;
END $$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT id, estado, motivo_no_realizada, reprogramada_para, llegada_at
--     FROM v_instalaciones LIMIT 5;
--
-- Y que el CHECK rechace lo incoherente:
--   UPDATE instalaciones SET llegada_lat = -0.9, llegada_lng = -78.6
--    WHERE id = '<alguna>';        -- error 23514: falta la precisión
