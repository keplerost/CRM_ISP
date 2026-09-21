-- =============================================================================
-- Migración 174 — El corte masivo se avisa antes de que llamen
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── El problema, medido en llamadas ──
--
-- Se corta una fibra troncal a las 19:40. Cuelgan de ella 180 abonados. En los
-- diez minutos siguientes entran cuarenta mensajes al WhatsApp de soporte
-- diciendo lo mismo, y quien atiende contesta cuarenta veces lo mismo mientras
-- el técnico que podría estar arreglándolo está explicando por teléfono que ya
-- lo saben. Los que escriben a los veinte minutos no reciben respuesta, porque
-- el canal está tapado — y entre ellos está el que tenía una falla distinta.
--
-- El monitoreo YA sabe que el nodo se cayó: `nodos_red` lo detecta y le avisa al
-- técnico (migración 35). Lo que falta es la otra mitad, que es la que descarga
-- el canal: decírselo a los abonados afectados antes de que pregunten.
--
-- ── Qué se agrega ──
--
--   incidencias_masivas  la avería o el mantenimiento: qué pasó, a quiénes
--                        afecta y hasta cuándo se estima.
--   incidencia_avisos    a quién se le avisó, por dónde y cuándo. Es lo que
--                        garantiza UN mensaje por abonado y por momento.
--
-- ── Por qué el alcance no es una lista de abonados ──
--
-- Porque nadie arma a mano una lista de 180 cédulas a las siete y cuarenta de
-- la tarde. El alcance se dice como se piensa el problema: "la zona El
-- Progreso", "la caja NAP-14", "todo lo que cuelga de la torre Cerro Azul",
-- "el puerto PON 0/1/3". La lista de afectados la calcula la base con lo que ya
-- tiene cargado.
--
-- Se deja también `clientes_manual` para el caso que ninguna de esas formas
-- cubre — un grupo suelto de abonados de una calle— porque el día que pase, si
-- no está, se manda por otro lado y no queda registrado en ningún lugar.
--
-- ── Por qué NADA de esto se manda solo por instalar la migración ──
--
-- Mandar un mensaje a 180 personas es irreversible. Una incidencia nace en
-- `borrador`: existe, tiene su lista de afectados calculada y no salió nada.
-- Abrirla es un acto explícito. Y cuando la abre el monitoreo por su cuenta,
-- solo lo hace si el ISP encendió esa opción Y el nodo lleva caído más que el
-- umbral configurado — un enlace que parpadea dos minutos con la lluvia no
-- puede escribirle a un pueblo.
-- =============================================================================


-- =============================================================================
-- 1. La incidencia
-- =============================================================================
CREATE TABLE IF NOT EXISTS incidencias_masivas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tipo        VARCHAR(20) NOT NULL DEFAULT 'averia'
                CHECK (tipo IN ('averia', 'fibra_rota', 'mantenimiento', 'corte_energia', 'enlace_caido', 'otro')),

    -- Lo que se le dice al abonado. `titulo` es el renglón corto que va al SMS;
    -- `descripcion` es el texto largo, para el correo.
    titulo      VARCHAR(120) NOT NULL,
    descripcion TEXT,

    -- --- A quiénes afecta ---------------------------------------------------
    --
    -- Se dice de UNA de estas formas. La lista de abonados sale de
    -- `afectados_por_incidencia()`, que resuelve según cuál se haya usado.
    alcance     VARCHAR(12) NOT NULL
                CHECK (alcance IN ('zona', 'punto', 'nodo', 'olt', 'router', 'manual')),

    zona        VARCHAR(60),
    punto_id    UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    nodo_id     UUID REFERENCES nodos_red(id) ON DELETE SET NULL,
    olt_id      UUID REFERENCES olts(id) ON DELETE SET NULL,
    -- Solo con `olt_id`: acota a un puerto PON. Una fibra rota no se lleva la
    -- OLT entera, se lleva el puerto — y avisarle a los 900 abonados de la OLT
    -- por los 60 de un puerto genera más llamadas de las que evita.
    puerto_pon  VARCHAR(20),
    router_id   UUID REFERENCES routers_mikrotik(id) ON DELETE SET NULL,
    clientes_manual UUID[] NOT NULL DEFAULT '{}',

    -- --- Estado y tiempos ---------------------------------------------------
    estado      VARCHAR(12) NOT NULL DEFAULT 'borrador'
                CHECK (estado IN ('borrador', 'abierta', 'resuelta', 'cancelada')),

    -- Cuándo empezó el problema de verdad. En una detectada por el monitoreo es
    -- la hora en que el nodo se cayó, no la hora en que alguien la abrió: el
    -- abonado ya estaba sin servicio.
    ocurrio_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    abierta_at  TIMESTAMPTZ,
    resuelta_at TIMESTAMPTZ,

    -- Lo que se le promete al abonado. Puede quedar vacío —"estamos
    -- trabajando"— pero cuando hay un número, es lo que más baja la reincidencia
    -- de mensajes.
    estimado_at TIMESTAMPTZ,

    -- Mantenimiento programado: se avisa ANTES, con la ventana de corte.
    programada  BOOLEAN NOT NULL DEFAULT FALSE,
    inicio_previsto TIMESTAMPTZ,
    fin_previsto    TIMESTAMPTZ,

    -- --- De dónde salió -----------------------------------------------------
    origen      VARCHAR(10) NOT NULL DEFAULT 'manual'
                CHECK (origen IN ('manual', 'nms')),
    -- El evento de caída del monitoreo que la originó. Sirve para cerrarla sola
    -- cuando el nodo vuelve, y para no abrir dos por la misma caída.
    nodo_evento_id BIGINT,

    -- --- Qué se avisa -------------------------------------------------------
    avisar_apertura   BOOLEAN NOT NULL DEFAULT TRUE,
    -- El "ya está solucionado" es la mitad que se olvida, y es la que hace que
    -- el abonado que reinició el router doce veces sepa que puede dejar de
    -- hacerlo.
    avisar_resolucion BOOLEAN NOT NULL DEFAULT TRUE,

    -- Cuántos salieron. Se cachea al abrir: la lista de afectados cambia con el
    -- padrón, y el reporte de la incidencia tiene que decir a cuántos se les
    -- escribió ESE día.
    afectados   INT,

    notas       TEXT,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- El alcance tiene que traer con qué resolverse. Sin esto, una incidencia
    -- "de zona" sin zona afecta a todos los abonados que tienen zona nula.
    CONSTRAINT incidencia_alcance_completo CHECK (
        (alcance = 'zona'   AND zona IS NOT NULL)
     OR (alcance = 'punto'  AND punto_id IS NOT NULL)
     OR (alcance = 'nodo'   AND nodo_id IS NOT NULL)
     OR (alcance = 'olt'    AND olt_id IS NOT NULL)
     OR (alcance = 'router' AND router_id IS NOT NULL)
     OR (alcance = 'manual' AND array_length(clientes_manual, 1) > 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_incidencias_abiertas
    ON incidencias_masivas (ocurrio_at DESC) WHERE estado = 'abierta';
CREATE INDEX IF NOT EXISTS idx_incidencias_nodo
    ON incidencias_masivas (nodo_id) WHERE nodo_id IS NOT NULL;

-- Una sola incidencia abierta por nodo. Es lo que impide que el monitoreo abra
-- una nueva en cada sondeo mientras el nodo sigue caído — que serían 180
-- mensajes cada dos minutos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidencia_una_por_nodo
    ON incidencias_masivas (nodo_id)
    WHERE nodo_id IS NOT NULL AND estado IN ('borrador', 'abierta');

COMMENT ON TABLE incidencias_masivas IS
    'Averias y mantenimientos que afectan a un grupo de abonados. En borrador no sale nada: abrirla es lo que dispara los avisos.';


-- =============================================================================
-- 2. A quién se le avisó
-- =============================================================================
-- ── Por qué una tabla y no la cola general de avisos ──
--
-- `avisos_pendientes` tiene un índice único por (tipo, referencia_id): sirve
-- para "un aviso por pago", donde la referencia identifica al aviso entero. Acá
-- la referencia es la MISMA para 180 filas, así que ese índice dejaría entrar
-- una sola.
--
-- Y hace falta el par (incidencia, abonado, momento) igual, porque es lo único
-- que garantiza que nadie reciba dos veces el mismo mensaje cuando la cola se
-- reintenta o cuando alguien vuelve a apretar "avisar".
CREATE TABLE IF NOT EXISTS incidencia_avisos (
    id            BIGSERIAL PRIMARY KEY,
    incidencia_id UUID NOT NULL REFERENCES incidencias_masivas(id) ON DELETE CASCADE,
    client_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    -- 'apertura' = te avisamos que pasó. 'resolucion' = ya está.
    momento       VARCHAR(12) NOT NULL CHECK (momento IN ('apertura', 'resolucion')),

    estado        VARCHAR(10) NOT NULL DEFAULT 'pendiente'
                  CHECK (estado IN ('pendiente', 'enviado', 'fallido', 'omitido')),
    canal         VARCHAR(15),
    motivo        TEXT,
    intentos      INT NOT NULL DEFAULT 0,

    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    enviado_en    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incidencia_aviso_unico
    ON incidencia_avisos (incidencia_id, client_id, momento);

CREATE INDEX IF NOT EXISTS idx_incidencia_avisos_cola
    ON incidencia_avisos (creado_en) WHERE estado = 'pendiente';

COMMENT ON TABLE incidencia_avisos IS
    'Un renglon por abonado y por momento. El indice unico es lo que impide que alguien reciba dos veces el mismo aviso.';


-- =============================================================================
-- 3. Quiénes están afectados
-- =============================================================================
-- ── Lo que hace el caso del nodo distinto de los demás ──
--
-- Un nodo tiene hijos: de la torre cuelgan tres sectoriales, y de una de ellas
-- un enlace a otro caserío. Si se cae la torre, los afectados no son solo los
-- que cuelgan de ella: son los de todo lo que hay debajo. Por eso el recorrido
-- es recursivo — y por eso también el monitoreo silencia la alerta del hijo
-- cuando el padre está caído (migración 35): es el mismo corte visto dos veces.
--
-- ── Por qué recibe el alcance suelto y no el id de una incidencia ──
--
-- Porque la pregunta más importante se hace ANTES de que la incidencia exista:
-- "si aviso a esta zona, ¿a cuántos le escribo?". Con una función que solo
-- acepta un id, esa cuenta obliga a crear la incidencia para poder verla — y
-- una vez creada, la tentación es abrirla igual.
--
-- La versión por id existe abajo y delega en esta: así "a quiénes se les avisó"
-- y "a cuántos les iba a avisar" no pueden dar distinto.
CREATE OR REPLACE FUNCTION afectados_por_alcance(
    p_alcance    TEXT,
    p_zona       TEXT   DEFAULT NULL,
    p_punto_id   UUID   DEFAULT NULL,
    p_nodo_id    UUID   DEFAULT NULL,
    p_olt_id     UUID   DEFAULT NULL,
    p_puerto_pon TEXT   DEFAULT NULL,
    p_router_id  UUID   DEFAULT NULL,
    p_manual     UUID[] DEFAULT '{}'
)
RETURNS TABLE (client_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_alcance = 'zona' THEN
        -- Un alcance de zona sin zona traería a TODOS los que tienen zona nula,
        -- que en un padrón recién migrado son casi todos.
        IF p_zona IS NULL THEN RETURN; END IF;
        RETURN QUERY
        SELECT c.id FROM clientes c
         WHERE c.zona = p_zona AND c.estado <> 'baja';

    ELSIF p_alcance = 'punto' THEN
        IF p_punto_id IS NULL THEN RETURN; END IF;
        RETURN QUERY
        SELECT c.id FROM clientes c
         WHERE (c.nap_id = p_punto_id OR c.conectado_a_id = p_punto_id)
           AND c.estado <> 'baja';

    ELSIF p_alcance = 'router' THEN
        IF p_router_id IS NULL THEN RETURN; END IF;
        RETURN QUERY
        SELECT c.id FROM clientes c
         WHERE c.router_id = p_router_id AND c.estado <> 'baja';

    ELSIF p_alcance = 'olt' THEN
        IF p_olt_id IS NULL THEN RETURN; END IF;
        RETURN QUERY
        SELECT DISTINCT c.id
          FROM clientes c
          LEFT JOIN onus o       ON o.id = c.onu_id
          LEFT JOIN puntos_red p ON p.id = c.nap_id
         WHERE c.estado <> 'baja'
           AND (
                -- Por la ONT: es el dato más confiable, lo escribe la OLT.
                (o.olt_id = p_olt_id AND (p_puerto_pon IS NULL OR o.puerto::TEXT = p_puerto_pon))
                -- O por la caja de la que cuelga, para el abonado cuya ONT
                -- todavía no se emparejó con la ficha.
             OR (p.olt_id = p_olt_id AND (p_puerto_pon IS NULL OR p.puerto_pon = p_puerto_pon))
           );

    ELSIF p_alcance = 'nodo' THEN
        IF p_nodo_id IS NULL THEN RETURN; END IF;
        RETURN QUERY
        WITH RECURSIVE rama AS (
            SELECT n.id, n.punto_id, n.olt_id
              FROM nodos_red n WHERE n.id = p_nodo_id
            UNION ALL
            SELECT h.id, h.punto_id, h.olt_id
              FROM nodos_red h
              JOIN rama r ON h.padre_id = r.id
        )
        SELECT DISTINCT c.id
          FROM clientes c
          LEFT JOIN onus o ON o.id = c.onu_id
         WHERE c.estado <> 'baja'
           AND (
                -- De la caja o la antena que ese nodo representa.
                c.nap_id         IN (SELECT punto_id FROM rama WHERE punto_id IS NOT NULL)
             OR c.conectado_a_id IN (SELECT punto_id FROM rama WHERE punto_id IS NOT NULL)
                -- De la OLT que ese nodo representa.
             OR o.olt_id        IN (SELECT olt_id FROM rama WHERE olt_id IS NOT NULL)
           );

    ELSIF p_alcance = 'manual' THEN
        RETURN QUERY
        SELECT c.id FROM clientes c
         WHERE c.id = ANY(p_manual) AND c.estado <> 'baja';
    END IF;
    -- Un alcance desconocido no devuelve nada, a propósito: es preferible un
    -- aviso que no sale a uno que sale a todo el padrón.
END;
$$;

COMMENT ON FUNCTION afectados_por_alcance IS
    'Los abonados alcanzados por un alcance dado. Se usa para previsualizar antes de crear la incidencia y para resolverla despues: la misma cuenta en los dos momentos.';


/** La misma pregunta, para una incidencia que ya existe. */
CREATE OR REPLACE FUNCTION afectados_por_incidencia(p_id UUID)
RETURNS TABLE (client_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT a.client_id
      FROM incidencias_masivas i
      CROSS JOIN LATERAL afectados_por_alcance(
          i.alcance, i.zona, i.punto_id, i.nodo_id, i.olt_id, i.puerto_pon,
          i.router_id, i.clientes_manual
      ) a
     WHERE i.id = p_id;
$$;


-- =============================================================================
-- 4. ¿Este abonado está adentro de una avería conocida?
-- =============================================================================
-- Es la pregunta que le hace el bot cuando alguien escribe "no tengo internet",
-- y es la que descarga el canal de soporte: contestar "sí, lo sabemos, es en tu
-- zona y estimamos las 21:30" es lo que evita el ticket y la llamada.
--
-- Solo mira las ABIERTAS. Una en borrador es algo que el ISP todavía no
-- comunicó: contestarla sería anunciar por el bot lo que nadie decidió anunciar.
CREATE OR REPLACE FUNCTION incidencia_activa_de(p_cliente UUID)
RETURNS incidencias_masivas
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT i.*
      FROM incidencias_masivas i
     WHERE i.estado = 'abierta'
       AND EXISTS (
             SELECT 1 FROM afectados_por_incidencia(i.id) a WHERE a.client_id = p_cliente
           )
     -- La más reciente: si hay dos, la que empezó después es la que explica lo
     -- que el abonado está viviendo ahora.
     ORDER BY i.ocurrio_at DESC
     LIMIT 1;
$$;


-- =============================================================================
-- 5. Abrir: es el acto que manda los mensajes
-- =============================================================================
-- ── Por qué encolar y no mandar ──
--
-- Porque son 180 mensajes y ninguna API de WhatsApp los acepta de golpe. Si
-- esto intentara enviarlos, la pantalla quedaría colgada varios minutos, el
-- proveedor devolvería 429 a la mitad, y lo que se reintentara sin registro
-- llegaría dos veces a los primeros.
--
-- Se dejan 180 renglones en `incidencia_avisos` y el middleware los drena a su
-- ritmo. El índice único es lo que hace que ese ritmo sea seguro.
CREATE OR REPLACE FUNCTION abrir_incidencia(p_id UUID, p_usuario UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v incidencias_masivas%ROWTYPE;
    v_encolados INT := 0;
BEGIN
    SELECT * INTO v FROM incidencias_masivas WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa incidencia';
    END IF;
    IF v.estado = 'abierta' THEN
        RAISE EXCEPTION 'Esa incidencia ya está abierta';
    END IF;
    IF v.estado IN ('resuelta', 'cancelada') THEN
        RAISE EXCEPTION 'Esa incidencia ya se cerró: creá una nueva';
    END IF;

    IF v.avisar_apertura THEN
        INSERT INTO incidencia_avisos (incidencia_id, client_id, momento)
        SELECT p_id, a.client_id, 'apertura'
          FROM afectados_por_incidencia(p_id) a
        -- Si alguien vuelve a abrirla, los que ya tienen renglón no reciben otro.
        ON CONFLICT (incidencia_id, client_id, momento) DO NOTHING;

        GET DIAGNOSTICS v_encolados = ROW_COUNT;
    END IF;

    UPDATE incidencias_masivas
       SET estado     = 'abierta',
           abierta_at = NOW(),
           afectados  = (SELECT COUNT(*) FROM afectados_por_incidencia(p_id))
     WHERE id = p_id;

    RETURN jsonb_build_object(
        'incidencia_id', p_id,
        'afectados', (SELECT afectados FROM incidencias_masivas WHERE id = p_id),
        'encolados', v_encolados
    );
END;
$$;


-- =============================================================================
-- 6. Resolver
-- =============================================================================
-- El "ya está" se le manda SOLO a quien recibió el aviso de la avería.
--
-- Avisarle de la solución a quien nunca supo del problema es contarle que
-- estuvo sin servicio: el abonado que a esa hora estaba durmiendo se entera de
-- una falla que no vivió, y el mensaje que buscaba tranquilizar genera la
-- consulta que no existía.
CREATE OR REPLACE FUNCTION resolver_incidencia(p_id UUID, p_usuario UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v incidencias_masivas%ROWTYPE;
    v_encolados INT := 0;
BEGIN
    SELECT * INTO v FROM incidencias_masivas WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa incidencia';
    END IF;
    IF v.estado <> 'abierta' THEN
        RAISE EXCEPTION 'Solo se puede resolver una incidencia abierta';
    END IF;

    IF v.avisar_resolucion THEN
        INSERT INTO incidencia_avisos (incidencia_id, client_id, momento)
        SELECT p_id, ia.client_id, 'resolucion'
          FROM incidencia_avisos ia
         WHERE ia.incidencia_id = p_id
           AND ia.momento = 'apertura'
           -- Solo a quien le llegó de verdad. Al que falló el envío no se le
           -- manda el "ya está" de algo que nunca supo.
           AND ia.estado = 'enviado'
        ON CONFLICT (incidencia_id, client_id, momento) DO NOTHING;

        GET DIAGNOSTICS v_encolados = ROW_COUNT;
    END IF;

    UPDATE incidencias_masivas
       SET estado = 'resuelta', resuelta_at = NOW()
     WHERE id = p_id;

    RETURN jsonb_build_object('incidencia_id', p_id, 'encolados', v_encolados);
END;
$$;


-- =============================================================================
-- 7. La cola que drena el middleware
-- =============================================================================
CREATE OR REPLACE VIEW v_incidencia_avisos_a_enviar WITH (security_invoker = true) AS
SELECT
    ia.id            AS aviso_id,
    ia.incidencia_id,
    ia.momento,
    ia.intentos,
    c.id             AS cliente_id,
    c.nombre,
    c.email,
    c.telefono,
    c.telefono_movil,
    c.telegram_chat_id,
    c.zona,
    c.avisos_activos,
    c.avisos_canales,
    c.canal_preferido,
    i.tipo,
    i.titulo,
    i.descripcion,
    i.estimado_at,
    i.programada,
    i.inicio_previsto,
    i.fin_previsto,
    i.ocurrio_at
FROM incidencia_avisos ia
JOIN incidencias_masivas i ON i.id = ia.incidencia_id
JOIN clientes c            ON c.id = ia.client_id
WHERE ia.estado = 'pendiente'
  AND c.estado <> 'baja'
  -- Una incidencia cancelada deja de mandar lo que todavía no salió: es el
  -- botón de "me equivoqué de zona" y tiene que servir de verdad.
  AND i.estado <> 'cancelada'
ORDER BY ia.creado_en;

COMMENT ON VIEW v_incidencia_avisos_a_enviar IS
    'Avisos de incidencia por mandar, con los datos de contacto del abonado y el texto de la incidencia.';


-- =============================================================================
-- 8. El tablero
-- =============================================================================
DROP VIEW IF EXISTS v_incidencias_masivas;
CREATE VIEW v_incidencias_masivas WITH (security_invoker = true) AS
SELECT
    i.*,
    p.nombre AS punto,
    n.nombre AS nodo,
    n.estado AS nodo_estado,
    o.nombre AS olt,
    r.nombre AS router,
    (SELECT COUNT(*) FROM incidencia_avisos a
      WHERE a.incidencia_id = i.id AND a.momento = 'apertura' AND a.estado = 'enviado') AS avisados,
    (SELECT COUNT(*) FROM incidencia_avisos a
      WHERE a.incidencia_id = i.id AND a.estado = 'pendiente') AS por_avisar,
    (SELECT COUNT(*) FROM incidencia_avisos a
      WHERE a.incidencia_id = i.id AND a.estado = 'fallido') AS fallidos,
    -- Cuánto lleva. Es lo primero que se mira, igual que en un nodo caído.
    EXTRACT(EPOCH FROM (COALESCE(i.resuelta_at, NOW()) - i.ocurrio_at)) / 60 AS minutos
FROM incidencias_masivas i
LEFT JOIN puntos_red p       ON p.id = i.punto_id
LEFT JOIN nodos_red n        ON n.id = i.nodo_id
LEFT JOIN olts o             ON o.id = i.olt_id
LEFT JOIN routers_mikrotik r ON r.id = i.router_id;


-- =============================================================================
-- 9. Los textos
-- =============================================================================
-- Se siembran desactivables y editables desde el editor de plantillas: lo que
-- el ISP le dice a su gente es suyo. Lo que no se puede es no tener ninguno —
-- una incidencia abierta sin plantilla no manda nada y parece que falló.
INSERT INTO plantillas_mensaje
    (clave, categoria, canal, formato, del_sistema, nombre, descripcion, asunto, cuerpo, variables)
VALUES
('sms_incidencia_abierta', 'sms', 'sms', 'texto', TRUE,
 'Aviso de avería en la zona',
 'Sale a todos los abonados afectados apenas se abre la incidencia. Es el mensaje que evita que el canal de soporte se tape.',
 NULL,
 '{{empresa}}: estamos con una avería que afecta el servicio en su sector ({{titulo}}). Ya estamos trabajando. {{estimado}} Disculpe las molestias.',
 ARRAY['nombre','empresa','titulo','estimado','zona']),

('mail_incidencia_abierta', 'correo', 'email', 'html', TRUE,
 'Aviso de avería en la zona (correo)',
 'La versión larga del aviso de avería, con el detalle y el horario estimado.',
 'Estamos trabajando en una avería en su sector',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Le informamos que se registró una avería que afecta el servicio de internet en su sector: <b>{{titulo}}</b>.</p>\n<p>{{descripcion}}</p>\n<p>{{estimado}}</p>\n<p>No hace falta que reinicie su equipo ni que nos escriba: le vamos a avisar apenas quede restablecido.</p>\n<p>Disculpe las molestias.</p>',
 ARRAY['nombre','empresa','titulo','descripcion','estimado','zona']),

('sms_incidencia_resuelta', 'sms', 'sms', 'texto', TRUE,
 'Aviso de avería solucionada',
 'Va solo a quien recibió el aviso de la avería. Es lo que hace que el abonado deje de reiniciar el router.',
 NULL,
 '{{empresa}}: la avería en su sector quedó solucionada y el servicio está restablecido. Si sigue sin internet, escríbanos.',
 ARRAY['nombre','empresa','titulo','duracion']),

('mail_incidencia_resuelta', 'correo', 'email', 'html', TRUE,
 'Aviso de avería solucionada (correo)',
 'La versión larga del aviso de restablecimiento.',
 'Su servicio quedó restablecido',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>La avería que afectaba el servicio en su sector quedó solucionada y su internet está restablecido.</p>\n<p>Si después de reiniciar su equipo sigue sin conexión, escríbanos: en ese caso se trata de algo puntual de su domicilio y lo revisamos aparte.</p>\n<p>Gracias por la paciencia.</p>',
 ARRAY['nombre','empresa','titulo','duracion']),

('sms_mantenimiento_programado', 'sms', 'sms', 'texto', TRUE,
 'Aviso de mantenimiento programado',
 'Se manda ANTES del corte, con la ventana. Un mantenimiento avisado no genera reclamos; el mismo corte sin avisar, sí.',
 NULL,
 '{{empresa}}: el {{ventana}} haremos un mantenimiento programado que puede interrumpir su servicio ({{titulo}}). Le pedimos disculpas por el inconveniente.',
 ARRAY['nombre','empresa','titulo','ventana','zona']),

('mail_mantenimiento_programado', 'correo', 'email', 'html', TRUE,
 'Aviso de mantenimiento programado (correo)',
 'La versión larga del aviso previo de mantenimiento.',
 'Mantenimiento programado en su sector',
 E'<p>Estimado/a {{nombre}}:</p>\n<p>Le informamos que realizaremos un mantenimiento programado que puede interrumpir su servicio de internet.</p>\n<p><b>Cuándo:</b> {{ventana}}<br/><b>Motivo:</b> {{titulo}}</p>\n<p>{{descripcion}}</p>\n<p>El trabajo es para mejorar la calidad del servicio en su sector. Disculpe las molestias.</p>',
 ARRAY['nombre','empresa','titulo','descripcion','ventana','zona'])
ON CONFLICT (clave) WHERE clave IS NOT NULL DO NOTHING;


-- =============================================================================
-- 10. Los interruptores de la tarea
-- =============================================================================
-- ── El umbral es la salvaguarda principal ──
--
-- `incidencias_minutos` es lo que separa "avisar de un corte" de "escribirle a
-- 180 personas porque llovió". Un enlace de radio que pierde el haz treinta
-- segundos vuelve solo; uno que lleva quince minutos caído es una salida de
-- técnico. El umbral por defecto es 15 y NO conviene bajarlo hasta tener varias
-- semanas de historial del nodo.
--
-- Y la apertura automática viene APAGADA, como todo lo que le habla al abonado:
-- el monitoreo crea la incidencia en borrador igual, así que se puede ver
-- durante un mes qué habría mandado antes de dejarlo mandar.
ALTER TABLE config_tareas
    -- El que MANDA lo que ya está encolado. Apagado, una incidencia abierta a
    -- mano deja su cola quieta y hay que apretar "enviar ahora" — que es lo
    -- correcto los primeros días: se ve la lista antes de que salga nada.
    ADD COLUMN IF NOT EXISTS incidencias_cola_activa BOOLEAN,
    -- El más fuerte: deja que el MONITOREO abra la incidencia por su cuenta.
    -- Es lo único del sistema que le escribe a cientos de abonados sin que
    -- ninguna persona haya apretado nada.
    ADD COLUMN IF NOT EXISTS incidencias_automatico BOOLEAN,
    ADD COLUMN IF NOT EXISTS incidencias_minutos INT
        CHECK (incidencias_minutos IS NULL OR incidencias_minutos BETWEEN 1 AND 1440),
    ADD COLUMN IF NOT EXISTS incidencias_cada_minutos INT
        CHECK (incidencias_cada_minutos IS NULL OR incidencias_cada_minutos BETWEEN 1 AND 60),
    ADD COLUMN IF NOT EXISTS incidencias_lote INT
        CHECK (incidencias_lote IS NULL OR incidencias_lote BETWEEN 1 AND 500);

COMMENT ON COLUMN config_tareas.incidencias_cola_activa IS
    'Si los avisos encolados salen solos. Apagado, se mandan desde el boton "enviar ahora" de la pantalla de incidencias.';
COMMENT ON COLUMN config_tareas.incidencias_automatico IS
    'Si el monitoreo ABRE la incidencia por su cuenta (y por lo tanto avisa a los abonados). Apagado: la crea en borrador y la abre una persona.';
COMMENT ON COLUMN config_tareas.incidencias_minutos IS
    'Minutos que un nodo tiene que llevar caido antes de que su incidencia se abra sola. Es lo que impide que un parpadeo escriba a un pueblo.';
COMMENT ON COLUMN config_tareas.incidencias_lote IS
    'Cuantos avisos se mandan por corrida. Mandar 180 de golpe hace que el proveedor devuelva 429 a la mitad.';


-- =============================================================================
-- 11. RLS
-- =============================================================================
-- El personal las lee y las escribe desde la pantalla; el envío lo hace el
-- middleware con la service_role key.
ALTER TABLE incidencias_masivas ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidencia_avisos   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incidencias_staff ON incidencias_masivas;
CREATE POLICY incidencias_staff ON incidencias_masivas
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Los renglones de aviso solo se LEEN desde el navegador: quién recibió qué es
-- el registro de lo que se comunicó, y se escribe abriendo o resolviendo la
-- incidencia, nunca a mano.
DROP POLICY IF EXISTS incidencia_avisos_staff ON incidencia_avisos;
CREATE POLICY incidencia_avisos_staff ON incidencia_avisos
    FOR SELECT TO authenticated USING (true);


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- A cuántos afectaría, ANTES de abrirla:
--   INSERT INTO incidencias_masivas (tipo, titulo, alcance, zona)
--        VALUES ('fibra_rota', 'Fibra cortada en la vía principal', 'zona', 'EL PROGRESO')
--     RETURNING id;
--   SELECT COUNT(*) FROM afectados_por_incidencia('<id>');
--
--   -- Abrirla (encola los avisos, no manda nada todavía):
--   SELECT abrir_incidencia('<id>');
--   SELECT COUNT(*) FROM v_incidencia_avisos_a_enviar;
--
--   -- Lo que el bot ve al preguntar por un abonado:
--   SELECT titulo, estimado_at FROM incidencia_activa_de('<client_id>');
