-- =============================================================================
-- Migración 84 — Parámetros técnicos e idempotencia
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Prepara el terreno para el módulo del técnico de campo. Dos cosas, las dos
-- aburridas y las dos necesarias antes de escribir una sola pantalla.
--
--   1. Los umbrales del semáforo dejan de estar escritos a mano.
--   2. Las escrituras del técnico se pueden reintentar sin duplicar nada.
--
-- No crea ninguna pantalla. Lo que habilita es que las que vienen no nazcan
-- torcidas.
-- =============================================================================


-- =============================================================================
-- 1. Los umbrales, en un solo lugar
-- =============================================================================
-- ── Qué pasaba ──
--
-- El límite de potencia óptica estaba escrito a mano en seis archivos: la vista
-- `v_instalaciones`, dos vistas del tablero GPON, el asistente de campo, y
-- `lib/optica.js` del middleware.
--
-- Y no coincidían. La vista de instalaciones marca ámbar por debajo de -25 dBm;
-- el tablero GPON, por debajo de -24. O sea que la misma ONU a -24.5 aparecía
-- verde en una pantalla y amarilla en otra, y quien las mirara juntas concluía
-- —con razón— que una de las dos miente.
--
-- Nadie se equivocó al escribirlas: se escribieron en momentos distintos, y no
-- había forma de que la segunda supiera qué decía la primera. Eso es lo que
-- arregla tener un solo lugar.
--
-- ── Por qué una tabla de una fila y no un ENUM de claves sueltas ──
--
-- Una tabla clave/valor obliga a cada consulta a hacer varios `SELECT` y a
-- convertir texto a número. Una fila con columnas tipadas se une con `CROSS
-- JOIN`, el planificador la resuelve una vez, y un valor mal cargado —un texto
-- donde va un número— lo rechaza la base y no la pantalla.

CREATE TABLE IF NOT EXISTS parametros_tecnicos (
    -- Fila única. El CHECK es lo que garantiza que no aparezca una segunda:
    -- con dos filas, cada `CROSS JOIN` duplicaría todos los resultados y el
    -- síntoma —listados con todo repetido— no se parece en nada a la causa.
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- ── Fibra (GPON) ──
    -- Por encima de `optica_optimo` está bien. Entre eso y `optica_limite`, en
    -- observación. Por debajo del límite, o por encima de `optica_saturado`
    -- —tan cerca que satura el receptor—, mal.
    optica_optimo    NUMERIC(5,2) NOT NULL DEFAULT -25,
    optica_limite    NUMERIC(5,2) NOT NULL DEFAULT -27,
    optica_saturado  NUMERIC(5,2) NOT NULL DEFAULT -8,

    -- ── Radio enlace ──
    radio_optimo     NUMERIC(5,2) NOT NULL DEFAULT -70,
    radio_limite     NUMERIC(5,2) NOT NULL DEFAULT -80,
    radio_ccq_minimo SMALLINT     NOT NULL DEFAULT 80,

    -- ── Pruebas de salida ──
    -- Qué se considera una instalación bien entregada. `velocidad_minima_pct`
    -- es sobre el plan contratado: 80 significa que un plan de 100 Mbps tiene
    -- que medir al menos 80 de bajada para darse por buena.
    ping_bueno_ms         SMALLINT NOT NULL DEFAULT 30,
    ping_limite_ms        SMALLINT NOT NULL DEFAULT 80,
    perdida_maxima_pct    SMALLINT NOT NULL DEFAULT 2,
    velocidad_minima_pct  SMALLINT NOT NULL DEFAULT 80,

    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    -- Un óptimo peor que el límite invertiría el semáforo entero sin avisar:
    -- todo verde justo cuando todo está mal.
    CONSTRAINT parametros_optica_coherente CHECK (optica_optimo > optica_limite),
    CONSTRAINT parametros_radio_coherente  CHECK (radio_optimo  > radio_limite),
    CONSTRAINT parametros_ping_coherente   CHECK (ping_bueno_ms < ping_limite_ms)
);

-- Los valores de arranque son los que el sistema ya venía usando, no unos
-- nuevos. Esta migración no cambia ningún semáforo: solo mueve de dónde salen
-- los números. Si cambiara los valores además de moverlos, y algo se viera
-- distinto mañana, no habría forma de saber cuál de las dos cosas fue.
INSERT INTO parametros_tecnicos (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE parametros_tecnicos IS
    'Los umbrales del semáforo técnico, en un solo lugar. Fila única.';


-- Un atajo para las pantallas: devuelve la fila sin que cada una tenga que
-- saber que es fila única.
CREATE OR REPLACE FUNCTION parametros_tecnicos()
RETURNS parametros_tecnicos
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$ SELECT * FROM parametros_tecnicos WHERE id = 1 $$;


-- =============================================================================
-- 2. El semáforo de instalaciones, leyendo los parámetros
-- =============================================================================
-- Se cambia SOLO la expresión del semáforo dentro de `v_instalaciones`. Las 94
-- columnas siguen siendo las mismas y en el mismo orden: nada de lo que la usa
-- se entera.
--
-- Las dos vistas del tablero GPON (migraciones 39 y 40) todavía tienen sus
-- números escritos a mano y quedan para después, cuando se arme el monitoreo.
-- Se dice acá para que quede constancia de que falta, en vez de descubrirlo
-- dentro de tres meses viendo dos colores distintos otra vez.

DO $$
DECLARE
    v_def       TEXT;
    v_original  TEXT;
    v_cambios   INT := 0;
    -- Qué literal corresponde a qué parámetro. El orden importa: -80 tiene que
    -- reemplazarse antes que -8, o el patrón de -8 partiría al de -80 en dos.
    v_mapa TEXT[][] := ARRAY[
        ['-80', 'radio_limite'],
        ['-70', 'radio_optimo'],
        ['-27', 'optica_limite'],
        ['-25', 'optica_optimo'],
        ['-8',  'optica_saturado']
    ];
    v_par TEXT[];
BEGIN
    -- Se reescribe la definición VIVA en vez de pegar acá una copia de la vista
    -- entera. Pegar la copia significa que cualquier columna agregada entre la
    -- migración 31 y hoy desaparecería en silencio.
    SELECT pg_get_viewdef('v_instalaciones'::regclass, true) INTO v_def;
    v_original := v_def;

    -- Postgres no guarda el texto original: lo reimprime, y según la versión un
    -- -27 sale como `(- 27)` o como `'-27'::numeric`. Se contemplan las dos en
    -- vez de apostar a una, porque acertar depende de qué versión de Postgres
    -- tenga cada instalación.
    FOREACH v_par SLICE 1 IN ARRAY v_mapa LOOP
        v_def := regexp_replace(
            v_def,
            '\(\s*-\s*' || LTRIM(v_par[1], '-') || '\s*\)|''' || v_par[1] || '''::numeric',
            '(SELECT p.' || v_par[2] || ' FROM parametros_tecnicos p WHERE p.id = 1)',
            'g'
        );
    END LOOP;

    SELECT COUNT(*) INTO v_cambios
      FROM regexp_matches(v_def, 'parametros_tecnicos', 'g');

    -- Los cinco umbrales o ninguno. Una vista a medio reemplazar es peor que una
    -- vista con números fijos: mezclaría dos fuentes de verdad, que es
    -- exactamente lo que esta migración vino a eliminar.
    IF v_cambios >= 5 THEN
        EXECUTE 'CREATE OR REPLACE VIEW v_instalaciones AS ' || v_def;
        RAISE NOTICE 'LISTO: v_instalaciones lee los umbrales de parametros_tecnicos (% reemplazos)', v_cambios;
    ELSE
        RAISE WARNING 'v_instalaciones NO se tocó: se esperaban 5 umbrales y se encontraron %. Sigue con los números fijos — avisale a quien hizo la migración.', v_cambios;
    END IF;
END $$;


-- =============================================================================
-- 3. Que reintentar no duplique
-- =============================================================================
-- ── El problema que esto resuelve ──
--
-- El técnico va a poder trabajar sin señal: lo que carga se guarda en el
-- teléfono y sale cuando vuelve la conexión.
--
-- El caso peligroso no es "no se envió". Es "se envió, se guardó, y la
-- respuesta no volvió". El teléfono no puede distinguir eso de un fallo, así
-- que reintenta — y descuenta el material dos veces. A fin de mes el inventario
-- no cuadra por un margen que nadie puede explicar, que es exactamente el
-- problema que el módulo de inventario vino a resolver.
--
-- ── Cómo se resuelve ──
--
-- Quien escribe genera un identificador ANTES de intentar, y lo manda con el
-- dato. Si el segundo intento trae el mismo identificador, el índice único lo
-- rechaza y la fila no se duplica. El error que devuelve —23505— es la señal de
-- "esto ya estaba", no de un problema.
--
-- El identificador lo genera el cliente y no la base a propósito: tiene que
-- sobrevivir al reintento, y algo que la base genera cambia en cada intento.
--
-- ── Por qué no hace falta en la instalación misma ──
--
-- `finalizar_alta_instalacion` ya es idempotente: si la instalación ya tiene
-- `client_id`, devuelve ese mismo id sin crear otro abonado, y el `FOR UPDATE`
-- serializa dos llamadas simultáneas. Ese botón se puede reintentar tal como
-- está. Lo que faltaba blindar era el material y las evidencias.

ALTER TABLE movimientos_inventario
    ADD COLUMN IF NOT EXISTS clave_idempotencia UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_idempotencia
    ON movimientos_inventario (clave_idempotencia)
    -- Parcial: las filas viejas y las que se cargan desde el escritorio no
    -- tienen clave, y sin el WHERE todos esos NULL competirían por el índice.
    WHERE clave_idempotencia IS NOT NULL;

ALTER TABLE instalacion_fotos
    ADD COLUMN IF NOT EXISTS clave_idempotencia UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_instalacion_fotos_idempotencia
    ON instalacion_fotos (clave_idempotencia)
    WHERE clave_idempotencia IS NOT NULL;

ALTER TABLE ticket_adjuntos
    ADD COLUMN IF NOT EXISTS clave_idempotencia UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_adjuntos_idempotencia
    ON ticket_adjuntos (clave_idempotencia)
    WHERE clave_idempotencia IS NOT NULL;

ALTER TABLE ticket_eventos
    ADD COLUMN IF NOT EXISTS clave_idempotencia UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_eventos_idempotencia
    ON ticket_eventos (clave_idempotencia)
    WHERE clave_idempotencia IS NOT NULL;

ALTER TABLE mensajes_comerciales
    ADD COLUMN IF NOT EXISTS clave_idempotencia UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mensajes_comerciales_idempotencia
    ON mensajes_comerciales (clave_idempotencia)
    WHERE clave_idempotencia IS NOT NULL;


-- =============================================================================
-- 4. Seguridad
-- =============================================================================
ALTER TABLE parametros_tecnicos ENABLE ROW LEVEL SECURITY;

-- Leer: todo el personal. El técnico necesita los umbrales para ver el color en
-- el momento de la lectura, parado en la vereda y antes de guardar nada.
DROP POLICY IF EXISTS parametros_tecnicos_lectura ON parametros_tecnicos;
CREATE POLICY parametros_tecnicos_lectura ON parametros_tecnicos
    FOR SELECT TO authenticated USING (true);

-- Escribir: nadie desde el navegador. Estos números deciden qué instalación se
-- da por buena; moverlos es aflojar el estándar de la empresa entera, y quien
-- tiene el incentivo de aflojarlo es justamente quien es medido con él.
-- Se cambian desde el middleware, que verifica el permiso y lo deja auditado.

COMMENT ON COLUMN movimientos_inventario.clave_idempotencia IS
    'La genera el cliente antes de enviar. Un reintento trae la misma y el índice único lo rechaza: el material no se descuenta dos veces.';
