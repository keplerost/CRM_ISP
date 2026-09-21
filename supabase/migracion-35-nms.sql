-- =============================================================================
-- Migración 35 — Monitoreo de red en tiempo real (NMS / Watchdog)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 34.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_nodos_red` se redefinió en
-- la 36, con más columnas. Reemplazar esa versión por la de acá dejaría a las
-- pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Hoy una caída se detecta porque llaman los abonados. Eso significa que el ISP
-- se entera último y que nadie puede decir a qué hora empezó, que es
-- exactamente lo que se pregunta después.
--
-- Tres decisiones de fondo:
--
-- 1. **El historial son intervalos, no muestras.** Guardar una fila por ping
--    cada minuto son 43.000 filas por nodo por mes para responder "¿cuánto
--    estuvo caído?". Se guarda un intervalo por estado —desde cuándo, hasta
--    cuándo— y el uptime sale de sumarlos. Un nodo estable genera dos filas al
--    mes.
--
-- 2. **Un nodo hijo no alerta si su padre está caído.** Cuando se corta la
--    fibra de una torre, sus veinte antenas caen a la vez. Veinte mensajes al
--    técnico a las tres de la mañana no informan nada que el primero no dijera,
--    y hacen que la próxima vez nadie los lea. La caída del hijo se registra
--    igual —con quién la causó— pero no se avisa.
--
-- 3. **El estado lo escribe una función y no la aplicación.** Cerrar el
--    intervalo anterior y abrir el nuevo tiene que pasar junto o el uptime
--    queda mal para siempre.
-- =============================================================================


-- =============================================================================
-- Inventario
-- =============================================================================
CREATE TABLE IF NOT EXISTS nodos_red (
    id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL UNIQUE,

    tipo   VARCHAR(15) NOT NULL DEFAULT 'ptmp'
           CHECK (tipo IN ('ptp', 'ptmp', 'rb_torre', 'olt', 'energia', 'switch', 'otro')),

    -- A quién se le pregunta si está vivo.
    ip     VARCHAR(45) NOT NULL,

    /**
     * De quién depende.
     *
     * Es lo que evita la alerta masiva: si el padre está caído, la caída del
     * hijo es una consecuencia y no una noticia. Se permite nulo —los nodos de
     * cabecera no dependen de nadie— y se prohíbe que un nodo sea su propio
     * padre, que es el error de carga que dejaría el cálculo en un bucle.
     */
    padre_id UUID REFERENCES nodos_red(id) ON DELETE SET NULL,

    -- Desde dónde se lo pinguea. Sin router no se puede sondear: el servidor
    -- del middleware casi nunca tiene ruta hasta una antena de torre.
    router_id UUID REFERENCES routers_mikrotik(id) ON DELETE SET NULL,
    punto_id  UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    olt_id    UUID REFERENCES olts(id) ON DELETE SET NULL,

    -- Quién atiende este nodo. Sin técnico asignado, el aviso va a todos.
    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE SET NULL,

    /**
     * Umbrales propios.
     *
     * Un enlace PTP de 60 GHz a 2 ms y una antena sectorial saturada a 120 ms
     * son las dos cosas normales. Un umbral único obligaría a elegir entre no
     * enterarse del primero o recibir alertas constantes del segundo.
     */
    latencia_warning_ms INT NOT NULL DEFAULT 150 CHECK (latencia_warning_ms > 0),
    perdida_warning_pct INT NOT NULL DEFAULT 20
                        CHECK (perdida_warning_pct BETWEEN 1 AND 100),

    monitorear BOOLEAN NOT NULL DEFAULT TRUE,
    avisar     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Estado actual, cacheado para que el tablero no tenga que recorrer el
    -- historial en cada carga.
    estado     VARCHAR(12) NOT NULL DEFAULT 'desconocido'
               CHECK (estado IN ('up', 'warning', 'down', 'desconocido')),
    latencia_ms  NUMERIC(8,1),
    perdida_pct  INT,
    desde        TIMESTAMP WITH TIME ZONE,
    ultimo_chequeo TIMESTAMP WITH TIME ZONE,

    notas      TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT nodos_red_no_es_su_padre CHECK (padre_id IS NULL OR padre_id <> id)
);

COMMENT ON COLUMN nodos_red.padre_id IS
    'De qué nodo depende. Si el padre está caído, la caída del hijo se registra pero no se avisa: veinte mensajes por un solo corte de fibra hacen que nadie lea el próximo.';

COMMENT ON COLUMN nodos_red.desde IS
    'Desde cuándo está en el estado actual. Es la hora exacta que se manda en el aviso de caída y de recuperación.';

CREATE INDEX IF NOT EXISTS idx_nodos_monitoreo ON nodos_red (monitorear, estado);
CREATE INDEX IF NOT EXISTS idx_nodos_padre ON nodos_red (padre_id) WHERE padre_id IS NOT NULL;


-- =============================================================================
-- Historial: un intervalo por estado
-- =============================================================================
CREATE TABLE IF NOT EXISTS nodo_eventos (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nodo_id UUID NOT NULL REFERENCES nodos_red(id) ON DELETE CASCADE,

    estado  VARCHAR(12) NOT NULL CHECK (estado IN ('up', 'warning', 'down', 'desconocido')),
    desde   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Nulo = sigue en curso. Es el intervalo abierto.
    hasta   TIMESTAMP WITH TIME ZONE,

    latencia_ms NUMERIC(8,1),
    perdida_pct INT,

    -- Cuando la caída se explica por la del padre. Con esto se puede contestar
    -- "¿cuántas veces se cayó de verdad?" sin contar las consecuencias.
    causa_padre_id UUID REFERENCES nodos_red(id) ON DELETE SET NULL,

    notificado  BOOLEAN NOT NULL DEFAULT FALSE,
    notificado_at TIMESTAMP WITH TIME ZONE,
    detalle     TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodo_eventos ON nodo_eventos (nodo_id, desde DESC);

-- Un nodo no puede tener dos intervalos abiertos: sería estar en dos estados a
-- la vez y el uptime contaría el tiempo dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodo_evento_abierto
    ON nodo_eventos (nodo_id) WHERE hasta IS NULL;


-- =============================================================================
-- Registrar un sondeo
-- =============================================================================
-- Cierra el intervalo anterior y abre el nuevo, en una sola operación. Hecho
-- desde la aplicación, un corte entre las dos escrituras dejaría dos intervalos
-- abiertos o un hueco, y el uptime quedaría mal para siempre.
--
-- Si el estado no cambió, solo refresca la medición: no se abre un intervalo
-- nuevo cada minuto.
--
-- Devuelve TRUE cuando hubo cambio de estado, que es la señal de "esto hay que
-- avisarlo".
CREATE OR REPLACE FUNCTION registrar_chequeo_nodo(
    p_nodo_id  UUID,
    p_estado   TEXT,
    p_latencia NUMERIC DEFAULT NULL,
    p_perdida  INT DEFAULT NULL,
    p_detalle  TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_anterior TEXT;
    v_padre    UUID;
    v_cambio   BOOLEAN;
BEGIN
    SELECT estado INTO v_anterior FROM nodos_red WHERE id = p_nodo_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe el nodo %', p_nodo_id;
    END IF;

    v_cambio := v_anterior IS DISTINCT FROM p_estado;

    UPDATE nodos_red
       SET estado      = p_estado,
           latencia_ms = p_latencia,
           perdida_pct = p_perdida,
           ultimo_chequeo = NOW(),
           desde = CASE WHEN v_cambio THEN NOW() ELSE COALESCE(desde, NOW()) END
     WHERE id = p_nodo_id;

    IF NOT v_cambio THEN
        -- Mismo estado: se actualiza la medición del intervalo en curso y listo.
        UPDATE nodo_eventos
           SET latencia_ms = p_latencia,
               perdida_pct = p_perdida
         WHERE nodo_id = p_nodo_id AND hasta IS NULL;
        RETURN FALSE;
    END IF;

    -- Cambió: se cierra lo anterior y se abre lo nuevo.
    UPDATE nodo_eventos SET hasta = NOW() WHERE nodo_id = p_nodo_id AND hasta IS NULL;

    -- ¿La caída se explica por la del padre? Se mira en el momento, no después:
    -- si el padre se recupera antes de que alguien lea el evento, la respuesta
    -- correcta sigue siendo la de cuando pasó.
    IF p_estado = 'down' THEN
        SELECT n.padre_id INTO v_padre
          FROM nodos_red n
          JOIN nodos_red p ON p.id = n.padre_id
         WHERE n.id = p_nodo_id AND p.estado = 'down';
    END IF;

    INSERT INTO nodo_eventos (nodo_id, estado, latencia_ms, perdida_pct, causa_padre_id, detalle)
    VALUES (p_nodo_id, p_estado, p_latencia, p_perdida, v_padre, p_detalle);

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION registrar_chequeo_nodo IS
    'Registra un sondeo: refresca la medición y, si el estado cambió, cierra el intervalo anterior y abre el nuevo. Devuelve TRUE cuando hubo cambio.';


-- =============================================================================
-- La vista que lee el tablero
-- =============================================================================
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `equipo`, la cadena siguió y esta versión quedó
     * atrás: la 36 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_nodos_red'
           AND column_name = 'equipo'
    ) THEN
        RAISE NOTICE 'v_nodos_red ya está en su versión de la 36: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_nodos_red';
    EXECUTE $vista$
CREATE VIEW v_nodos_red WITH (security_invoker = true) AS
SELECT
    n.*,
    p.nombre  AS padre,
    p.estado  AS estado_padre,
    pr.nombre AS punto,
    r.nombre  AS router,
    t.nombre   AS tecnico,
    t.telefono AS tecnico_telefono,
    t.email    AS tecnico_email,

    -- Cuánto lleva así. Es lo primero que se mira en una caída.
    EXTRACT(EPOCH FROM (NOW() - n.desde)) / 60 AS minutos_en_estado,

    -- Si su padre está caído, lo de este nodo es consecuencia y no noticia.
    (p.estado = 'down') AS padre_caido,

    (SELECT COUNT(*) FROM nodos_red h WHERE h.padre_id = n.id) AS hijos,

    up.uptime_pct
FROM nodos_red n
LEFT JOIN nodos_red p        ON p.id  = n.padre_id
LEFT JOIN puntos_red pr      ON pr.id = n.punto_id
LEFT JOIN routers_mikrotik r ON r.id  = n.router_id
LEFT JOIN tecnicos t         ON t.id  = n.tecnico_id
LEFT JOIN LATERAL (
    -- Uptime de los últimos 30 días: tiempo en 'up' sobre tiempo medido. Los
    -- intervalos se recortan a la ventana para que uno viejo y largo no la
    -- distorsione, y se ignora 'desconocido' —no medir no es estar caído—.
    SELECT ROUND(
        100 * SUM(EXTRACT(EPOCH FROM (
            LEAST(COALESCE(e.hasta, NOW()), NOW())
            - GREATEST(e.desde, NOW() - INTERVAL '30 days')
        ))) FILTER (WHERE e.estado IN ('up', 'warning'))
        / NULLIF(SUM(EXTRACT(EPOCH FROM (
            LEAST(COALESCE(e.hasta, NOW()), NOW())
            - GREATEST(e.desde, NOW() - INTERVAL '30 days')
        ))) FILTER (WHERE e.estado <> 'desconocido'), 0),
    2) AS uptime_pct
    FROM nodo_eventos e
    WHERE e.nodo_id = n.id
      AND COALESCE(e.hasta, NOW()) > NOW() - INTERVAL '30 days'
) up ON TRUE
$vista$;
END $guarda$;

COMMENT ON VIEW v_nodos_red IS
    'Nodos con su estado, hace cuánto que están así, su uptime de 30 días y si su padre está caído.';


/** Las caídas, con cuánto duraron. Es el historial que se le muestra a alguien. */
CREATE OR REPLACE VIEW v_nodo_eventos WITH (security_invoker = true) AS
SELECT
    e.*,
    n.nombre   AS nodo,
    n.tipo     AS nodo_tipo,
    n.ip       AS nodo_ip,
    causa.nombre AS causado_por,
    EXTRACT(EPOCH FROM (COALESCE(e.hasta, NOW()) - e.desde)) / 60 AS minutos,
    (e.hasta IS NULL) AS en_curso
FROM nodo_eventos e
LEFT JOIN nodos_red n     ON n.id = e.nodo_id
LEFT JOIN nodos_red causa ON causa.id = e.causa_padre_id;


-- =============================================================================
-- RLS y updated_at
-- =============================================================================
ALTER TABLE nodos_red    ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodo_eventos ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['nodos_red', 'nodo_eventos']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "auth_all_%1$s" ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY "auth_all_%1$s" ON %1$I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            t
        );
    END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_nodos_red_updated_at ON nodos_red;
CREATE TRIGGER trg_nodos_red_updated_at
    BEFORE UPDATE ON nodos_red
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();
