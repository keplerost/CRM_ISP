-- =============================================================================
-- Migración 112 — Por dónde sale WhatsApp, y las alertas en tiempo real
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué resuelve ──
--
-- Una ONT se apaga un martes y en la oficina se sabe el viernes, cuando el
-- abonado llama —si llama—. Para entonces el equipo puede estar en otra ciudad.
--
-- Esto es lo que permite enterarse en diez minutos: reglas configurables, varios
-- destinos y un canal de WhatsApp que puede ser gratuito.
--
-- ── La idea que hace que esto se use y no se silencie ──
--
-- Una ONT sola que cae es sospechosa. Veinte a la vez es una fibra cortada.
--
-- Si se manda un mensaje por cada ONT que se apaga, la primera noche de tormenta
-- llegan cuarenta y a la semana nadie los lee. Por eso los eventos se AGRUPAN
-- por causa probable: si caen varias de la misma caja o del mismo puerto, es un
-- solo aviso de corte; si cae una sola con su caja sana, ese es el caso que
-- interesa mirar de cerca.
-- =============================================================================


-- =============================================================================
-- 1. Por dónde sale WhatsApp
-- =============================================================================
-- ── Las cinco vías, y por qué se elige y no se deduce ──
--
--   manual     Arma el enlace wa.me y lo manda una persona. No sirve para
--              alertas: no hay nadie apretando el botón a las tres de la mañana.
--   baileys    Librería libre que se conecta como WhatsApp Web. Gratis, con tu
--              propio número. No es oficial: Meta puede bloquear el número.
--   evolution  Un servicio aparte que envuelve a Baileys y habla HTTP. Mismo
--              costo y mismo riesgo, pero la sesión vive FUERA del middleware:
--              un reinicio por despliegue no desconecta WhatsApp.
--   meta       La API oficial. Se paga por conversación y pide plantillas
--              aprobadas para lo que inicia la empresa.
--   twilio     La misma API oficial, revendida.
--
-- Se guarda cuál se eligió en vez de deducirlo de qué campos están llenos:
-- deducirlo hace que quien probó dos y dejó datos viejos no entienda por qué
-- sale por donde sale.
--
-- ── Antes de tocar la tabla, comprobar que exista ──
--
-- Pasó de verdad: en una instalación la 61 nunca se había corrido y esta
-- migración murió con «relation "config_mensajeria" does not exist», que no dice
-- qué hacer. Y no se notaba antes porque el middleware trata la falta de esa
-- tabla como "instalación sin configurar" y sigue con el .env — la pantalla de
-- Mensajería no guardaba nada y nadie se enteraba.
DO $guarda$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'config_mensajeria'
    ) THEN
        RAISE EXCEPTION
            'Falta la tabla config_mensajeria. Corré primero supabase/migracion-61-configuracion-de-mensajeria.sql y después esta.';
    END IF;
END $guarda$;

ALTER TABLE config_mensajeria DROP CONSTRAINT IF EXISTS config_mensajeria_whatsapp_via_check;

ALTER TABLE config_mensajeria
    ALTER COLUMN whatsapp_via TYPE VARCHAR(12);

ALTER TABLE config_mensajeria
    ADD CONSTRAINT config_mensajeria_whatsapp_via_check
    CHECK (whatsapp_via IN ('manual', 'meta', 'twilio', 'baileys', 'evolution'));

ALTER TABLE config_mensajeria
    -- Evolution API: dónde está el servicio y con qué instancia hablar.
    ADD COLUMN IF NOT EXISTS whatsapp_evolution_url        VARCHAR(200),
    ADD COLUMN IF NOT EXISTS whatsapp_evolution_instancia  VARCHAR(64),
    ADD COLUMN IF NOT EXISTS whatsapp_evolution_key_encrypted TEXT;

COMMENT ON COLUMN config_mensajeria.whatsapp_via IS
    'Por dónde sale WhatsApp: manual (enlace wa.me), baileys, evolution, meta o twilio. Solo las últimas cuatro sirven para avisos automáticos.';
COMMENT ON COLUMN config_mensajeria.whatsapp_evolution_url IS
    'URL del servidor de Evolution API, por ejemplo http://localhost:8080. Sin barra al final.';


-- ── Quién puede tocar esto ──
--
-- Mismo patrón que el resto del sistema: se pregunta por el permiso, y sin
-- legajo no se bloquea, para que una instalación a medio migrar no quede
-- inutilizable.
CREATE OR REPLACE FUNCTION puede_configurar_alertas()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'ajustes.editar' OR permisos ? 'nms.ver'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        TRUE
    )
$$;

COMMENT ON FUNCTION puede_configurar_alertas IS
    'TRUE si quien pregunta puede ver y editar las reglas y los destinos de las alertas.';


-- =============================================================================
-- 2. Las reglas: qué se considera alerta
-- =============================================================================
CREATE TABLE IF NOT EXISTS alerta_reglas (
    clave       VARCHAR(30) PRIMARY KEY,
    nombre      VARCHAR(80) NOT NULL,
    descripcion TEXT,

    activa      BOOLEAN NOT NULL DEFAULT true,

    /*
     * El número que más importa de toda esta migración.
     *
     * Sin espera, un corte de luz de dos minutos manda cien mensajes y al día
     * siguiente nadie mira el teléfono. Diez minutos es el valor que se pidió;
     * queda configurable en minutos porque el número correcto depende de la red
     * de cada quien.
     */
    espera_min  INT NOT NULL DEFAULT 10 CHECK (espera_min BETWEEN 0 AND 1440),

    -- El umbral que usa la regla. Qué significa depende de cuál sea: dBm para
    -- las de potencia, cantidad de equipos para la de corte agrupado.
    umbral      NUMERIC(8,2),

    -- Fuera de esta franja no se manda. NULL = a cualquier hora.
    desde_hora  TIME,
    hasta_hora  TIME,

    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN alerta_reglas.espera_min IS
    'Cuántos minutos tiene que sostenerse la condición antes de avisar. Es lo que separa un corte de luz de dos minutos de una caída real.';

INSERT INTO alerta_reglas (clave, nombre, descripcion, espera_min, umbral, desde_hora, hasta_hora) VALUES
    ('ont_caida', 'ONT sin señal',
     'Un abonado se quedó sin señal y el resto de su caja está bien. Es el caso que más interesa: puede ser una mudanza o un equipo que se está yendo.',
     10, NULL, '07:00', '22:00'),
    ('corte_grupo', 'Corte agrupado',
     'Varias ONTs de la misma caja o del mismo puerto se cayeron juntas. Es la red, no el abonado: se manda un solo aviso.',
     5, 3, NULL, NULL),
    ('potencia_critica', 'Potencia crítica',
     'La señal cayó por debajo del umbral. El servicio todavía anda pero se va a cortar.',
     30, -27, '07:00', '22:00'),
    ('degradacion', 'Señal degradándose',
     'La potencia viene bajando de a poco. Es lo que permite arreglar una fibra antes de que se corte.',
     1440, 3, '08:00', '18:00')
ON CONFLICT (clave) DO NOTHING;

ALTER TABLE alerta_reglas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alerta_reglas_lectura ON alerta_reglas;
CREATE POLICY alerta_reglas_lectura ON alerta_reglas
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS alerta_reglas_escritura ON alerta_reglas;
CREATE POLICY alerta_reglas_escritura ON alerta_reglas
    FOR ALL TO authenticated
    USING (puede_configurar_alertas()) WITH CHECK (puede_configurar_alertas());


-- =============================================================================
-- 3. A quién se le avisa
-- =============================================================================
-- Varios destinos, cada uno con lo suyo: el dueño quiere todo, el técnico quiere
-- lo de su zona y en horario de trabajo, y la guardia nocturna solo los cortes
-- grandes. Un solo destino obliga a elegir entre no enterarse y que suene toda
-- la noche.
CREATE TABLE IF NOT EXISTS alerta_destinos (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre   VARCHAR(60) NOT NULL,

    canal    VARCHAR(12) NOT NULL DEFAULT 'whatsapp'
             CHECK (canal IN ('whatsapp', 'telegram', 'email', 'sms')),
    -- El número, el chat o el correo, según el canal.
    destino  VARCHAR(120) NOT NULL,

    -- Qué tipos recibe. Vacío = todos. Se guardan las claves de alerta_reglas.
    tipos    TEXT[] NOT NULL DEFAULT '{}',

    -- Solo lo de estas zonas. Vacío = todas.
    zonas    TEXT[] NOT NULL DEFAULT '{}',

    desde_hora TIME,
    hasta_hora TIME,

    activo   BOOLEAN NOT NULL DEFAULT true,
    -- Cuándo se probó por última vez y cómo salió. Es lo único que evita
    -- descubrir que el número estaba mal el día del primer corte.
    probado_en TIMESTAMPTZ,
    probado_ok BOOLEAN,

    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerta_destinos_activos ON alerta_destinos (activo);

ALTER TABLE alerta_destinos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alerta_destinos_lectura ON alerta_destinos;
CREATE POLICY alerta_destinos_lectura ON alerta_destinos
    FOR SELECT TO authenticated USING (puede_configurar_alertas());

DROP POLICY IF EXISTS alerta_destinos_escritura ON alerta_destinos;
CREATE POLICY alerta_destinos_escritura ON alerta_destinos
    FOR ALL TO authenticated
    USING (puede_configurar_alertas()) WITH CHECK (puede_configurar_alertas());


-- =============================================================================
-- 4. Lo detectado
-- =============================================================================
CREATE TABLE IF NOT EXISTS alerta_eventos (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regla     VARCHAR(30) NOT NULL REFERENCES alerta_reglas(clave) ON DELETE CASCADE,

    /*
     * Sobre qué es. Se guarda el tipo y el id sueltos, sin clave foránea, porque
     * puede ser una ONT, una caja, un puerto de OLT o un nodo, y una columna por
     * cada uno serían cuatro columnas vacías en cada fila.
     */
    entidad     VARCHAR(20) NOT NULL,
    entidad_id  VARCHAR(80) NOT NULL,
    -- Cómo se llama en el mensaje: "NAP-12", "Ana Pérez", "OLT LA MANÁ 1/2".
    etiqueta    VARCHAR(150),
    zona        VARCHAR(60),

    -- Cuántos abonados abarca. 1 en el caso individual; el grupo entero en un corte.
    abonados    INT NOT NULL DEFAULT 1,
    detalle     JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Cuándo empezó la condición y cuándo se avisó. Que sean dos fechas es lo
    -- que permite medir después cuánto tardamos en enterarnos.
    empezo_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    avisado_en  TIMESTAMPTZ,
    -- Y cuándo volvió a la normalidad, para poder mandar el "ya está".
    resuelto_en TIMESTAMPTZ,
    resuelto_avisado_en TIMESTAMPTZ,

    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un evento abierto por entidad y regla: sin esto, cada pasada de la tarea
-- abriría uno nuevo para la misma ONT que sigue caída.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerta_eventos_abierto
    ON alerta_eventos (regla, entidad, entidad_id) WHERE resuelto_en IS NULL;

CREATE INDEX IF NOT EXISTS idx_alerta_eventos_pendientes
    ON alerta_eventos (avisado_en, empezo_en) WHERE avisado_en IS NULL;

ALTER TABLE alerta_eventos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alerta_eventos_lectura ON alerta_eventos;
CREATE POLICY alerta_eventos_lectura ON alerta_eventos
    FOR SELECT TO authenticated USING (puede_configurar_alertas());


CREATE TABLE IF NOT EXISTS alerta_envios (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evento_id UUID REFERENCES alerta_eventos(id) ON DELETE CASCADE,
    destino_id UUID REFERENCES alerta_destinos(id) ON DELETE SET NULL,

    canal     VARCHAR(12) NOT NULL,
    destino   VARCHAR(120) NOT NULL,
    texto     TEXT,

    estado    VARCHAR(12) NOT NULL DEFAULT 'enviado'
              CHECK (estado IN ('enviado', 'fallido', 'omitido')),
    -- Lo que contestó el proveedor, tal cual. Sin esto, "no me llegó nada" es
    -- indiscutible.
    respuesta TEXT,

    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerta_envios ON alerta_envios (creado_en DESC);

ALTER TABLE alerta_envios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alerta_envios_lectura ON alerta_envios;
CREATE POLICY alerta_envios_lectura ON alerta_envios
    FOR SELECT TO authenticated USING (puede_configurar_alertas());


-- =============================================================================
-- 5. La detección
-- =============================================================================
/**
 * Abre y cierra eventos comparando el estado de la red contra lo que ya estaba.
 *
 * ── Cómo agrupa ──
 *
 * Primero mira las cajas: si en una hay tantas ONTs caídas como pide el umbral
 * de `corte_grupo`, abre UN evento por la caja y no toca a sus abonados. Recién
 * después abre eventos individuales para las que quedaron sueltas.
 *
 * Ese orden es todo: al revés, un corte de una caja con ocho abonados mandaría
 * nueve mensajes.
 *
 * ── Qué NO hace ──
 *
 * No manda nada. Solo deja los eventos anotados; el middleware los toma, arma el
 * texto y despacha. Separarlo es lo que permite que la base no dependa de que
 * exista un proveedor de WhatsApp configurado.
 */
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
BEGIN
    SELECT * INTO v_grupo FROM alerta_reglas WHERE clave = 'corte_grupo';
    SELECT * INTO v_ind   FROM alerta_reglas WHERE clave = 'ont_caida';
    SELECT * INTO v_pot   FROM alerta_reglas WHERE clave = 'potencia_critica';

    -- ── 1. Cortes agrupados, por caja ───────────────────────────────────────
    IF v_grupo.activa THEN
        FOR r IN
            SELECT o.nap_id AS caja,
                   p.nombre AS etiqueta,
                   COUNT(*)::INT AS caidas
              FROM onus o
              LEFT JOIN puntos_red p ON p.id = o.nap_id
             WHERE o.nap_id IS NOT NULL
               AND o.estado IN ('offline', 'los', 'dying_gasp')
             GROUP BY o.nap_id, p.nombre
            HAVING COUNT(*) >= COALESCE(v_grupo.umbral, 3)
        LOOP
            INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, abonados)
            VALUES ('corte_grupo', 'nap', r.caja::TEXT,
                    COALESCE(r.etiqueta, 'Caja ' || r.caja), r.caidas)
            ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL
            DO UPDATE SET abonados = EXCLUDED.abonados;

            v_abre := v_abre + 1;
        END LOOP;
    END IF;

    -- ── 2. Las que quedaron solas ───────────────────────────────────────────
    -- Se saltean las que pertenecen a una caja con corte abierto: ese abonado ya
    -- está contado en el aviso del grupo.
    IF v_ind.activa THEN
        FOR r IN
            SELECT o.id, c.id AS cliente_id, c.nombre AS cliente, c.zona, c.codigo
              FROM onus o
              LEFT JOIN clientes c ON c.onu_id = o.id
             WHERE o.estado IN ('offline', 'los', 'dying_gasp')
               AND NOT EXISTS (
                   SELECT 1 FROM alerta_eventos e
                    WHERE e.regla = 'corte_grupo'
                      AND e.entidad = 'nap'
                      AND e.entidad_id = o.nap_id::TEXT
                      AND e.resuelto_en IS NULL
               )
        LOOP
            INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, zona, abonados, detalle)
            VALUES ('ont_caida', 'onu', r.id::TEXT,
                    COALESCE(r.cliente, 'ONT sin abonado'), r.zona, 1,
                    jsonb_build_object('cliente_id', r.cliente_id, 'codigo', r.codigo))
            ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL
            DO NOTHING;

            v_abre := v_abre + 1;
        END LOOP;
    END IF;

    -- ── 3. Potencia bajo el umbral, con la ONT todavía arriba ───────────────
    IF v_pot.activa THEN
        FOR r IN
            SELECT o.id, o.rx_power_dbm, c.nombre AS cliente, c.zona
              FROM onus o
              LEFT JOIN clientes c ON c.onu_id = o.id
             WHERE o.estado = 'online'
               AND o.rx_power_dbm IS NOT NULL
               AND o.rx_power_dbm < COALESCE(v_pot.umbral, -27)
        LOOP
            INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, zona, detalle)
            VALUES ('potencia_critica', 'onu', r.id::TEXT,
                    COALESCE(r.cliente, 'ONT sin abonado'), r.zona,
                    jsonb_build_object('rx_dbm', r.rx_power_dbm))
            ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL
            DO UPDATE SET detalle = EXCLUDED.detalle;

            v_abre := v_abre + 1;
        END LOOP;
    END IF;

    -- ── 4. Lo que volvió ────────────────────────────────────────────────────
    WITH vueltas AS (
        UPDATE alerta_eventos e
           SET resuelto_en = NOW()
         WHERE e.resuelto_en IS NULL
           AND (
             (e.entidad = 'onu' AND e.regla IN ('ont_caida')
              AND EXISTS (SELECT 1 FROM onus o WHERE o.id::TEXT = e.entidad_id AND o.estado = 'online'))
             OR
             (e.entidad = 'onu' AND e.regla = 'potencia_critica'
              AND EXISTS (SELECT 1 FROM onus o WHERE o.id::TEXT = e.entidad_id
                            AND (o.rx_power_dbm IS NULL OR o.rx_power_dbm >= COALESCE(v_pot.umbral, -27))))
             OR
             (e.entidad = 'nap'
              AND (SELECT COUNT(*) FROM onus o
                    WHERE o.nap_id::TEXT = e.entidad_id
                      AND o.estado IN ('offline', 'los', 'dying_gasp')) < COALESCE(v_grupo.umbral, 3))
           )
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_cierra FROM vueltas;

    RETURN QUERY SELECT v_abre, v_cierra;
END $$;

COMMENT ON FUNCTION detectar_alertas IS
    'Abre y cierra eventos de alerta comparando el estado de la red. Agrupa por caja antes de mirar abonados sueltos. No envía nada: eso lo hace el middleware.';


/**
 * Los eventos que ya cumplieron su espera y todavía no se avisaron.
 *
 * La espera se mide contra `empezo_en`, no contra el momento de la consulta: un
 * evento que arrancó hace media hora ya cumplió sus diez minutos aunque la tarea
 * se haya salteado dos pasadas.
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
         -- Todavía abierto, cumplió la espera y no se avisó.
         (e.avisado_en IS NULL
          AND e.resuelto_en IS NULL
          AND e.empezo_en <= NOW() - (r.espera_min || ' minutes')::INTERVAL)
         OR
         -- O se resolvió después de haberse avisado: hay que decir que volvió.
         (e.resuelto_en IS NOT NULL AND e.avisado_en IS NOT NULL AND e.resuelto_avisado_en IS NULL)
       )
       -- La franja horaria de la regla. Fuera de ella el evento espera; no se
       -- pierde: se manda apenas empieza la franja.
       AND (r.desde_hora IS NULL OR LOCALTIME BETWEEN r.desde_hora AND r.hasta_hora)
     ORDER BY e.abonados DESC, e.empezo_en
$$;


-- =============================================================================
-- 6. Historial legible
-- =============================================================================
DROP VIEW IF EXISTS v_alerta_envios;
CREATE VIEW v_alerta_envios AS
SELECT
    en.id,
    en.creado_en,
    en.canal,
    en.destino,
    en.estado,
    en.respuesta,
    LEFT(en.texto, 200) AS texto,
    d.nombre  AS destino_nombre,
    e.regla,
    e.etiqueta,
    e.abonados
FROM alerta_envios en
LEFT JOIN alerta_destinos d ON d.id = en.destino_id
LEFT JOIN alerta_eventos  e ON e.id = en.evento_id
WHERE puede_configurar_alertas();

GRANT SELECT ON v_alerta_envios TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, nombre, espera_min, umbral FROM alerta_reglas;
--   SELECT * FROM detectar_alertas();
--   SELECT regla, etiqueta, abonados, empezo_en FROM alerta_eventos WHERE resuelto_en IS NULL;
--   SELECT * FROM alertas_por_enviar();
--
--   -- Y para probar la espera sin esperar diez minutos:
--   UPDATE alerta_reglas SET espera_min = 0 WHERE clave = 'ont_caida';


-- =============================================================================
-- 7. La tarea
-- =============================================================================
-- Cinco minutos es el intervalo más corto de todo el sistema, y es a propósito:
-- una alerta que llega media hora tarde no evita nada. La espera de cada regla
-- —los diez minutos configurables— es lo que impide que ese intervalo corto se
-- convierta en cien mensajes por un corte de luz.
--
-- Arranca APAGADA. Encenderla sin destinos cargados no rompe nada, pero tampoco
-- sirve: primero se carga a quién avisarle y se prueba, después se enciende.
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS alertas_automaticas BOOLEAN DEFAULT FALSE;
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS alertas_cada_minutos INT DEFAULT 5;
