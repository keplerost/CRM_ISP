-- =============================================================================
-- Migración 31 — De prospecto a usuario activo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere las migraciones 10, 11, 12 y 26.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_instalaciones` se redefinió
-- en la 91, con más columnas. Reemplazar esa versión por la de acá dejaría a
-- las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Hasta ahora `instalaciones` era una agenda: se anotaba la visita de alguien
-- que YA era cliente. Pero el que llama pidiendo internet todavía no es cliente
-- de nada, y darlo de alta antes de saber si le llega la fibra ensucia el
-- padrón con gente que nunca se instaló.
--
-- Esta migración convierte la tabla en el expediente completo del trabajo, con
-- cuatro momentos:
--
--   1. Prospecto     — quién es, dónde vive, qué tecnología pide.
--   2. Factibilidad  — si hay cobertura desde alguna caja o torre con lugar.
--   3. Agenda        — qué día va y quién va (técnico suelto o cuadrilla).
--   4. Alta en campo — lo que el técnico captura con el celular: equipo,
--                      potencia, parámetros de red, pruebas, firma y fotos.
--
-- Tres decisiones de fondo:
--
-- * `client_id` pasa a ser opcional. El prospecto vive en esta tabla y recién
--   se convierte en cliente al finalizar el alta. Así el módulo Usuarios sigue
--   siendo lo que dice ser: los que tienen servicio.
--
-- * Los datos del alta se guardan acá aunque después se copien a `clientes`.
--   La ficha del abonado muestra la configuración de hoy; la instalación, la
--   que se dejó puesta ese día. Cuando el cliente reclama que "antes andaba
--   mejor", esa diferencia es la respuesta.
--
-- * El pase a Usuarios es una función y no un UPDATE desde la pantalla. Son
--   dos tablas que tienen que quedar consistentes: si se hace en dos llamadas
--   desde el navegador y la segunda falla, queda una instalación cerrada sin
--   cliente o un cliente activo sin instalación que lo respalde.
-- =============================================================================


-- =============================================================================
-- 1. El prospecto: alguien que todavía no es cliente
-- =============================================================================
ALTER TABLE instalaciones ALTER COLUMN client_id DROP NOT NULL;

ALTER TABLE instalaciones
    -- Datos que se toman por teléfono, antes de que exista la ficha.
    ADD COLUMN IF NOT EXISTS nombre              VARCHAR(150),
    ADD COLUMN IF NOT EXISTS tipo_identificacion VARCHAR(2) DEFAULT '05',
    ADD COLUMN IF NOT EXISTS identificacion      VARCHAR(20),
    ADD COLUMN IF NOT EXISTS telefono            VARCHAR(30),
    ADD COLUMN IF NOT EXISTS telefono_whatsapp   VARCHAR(30),
    ADD COLUMN IF NOT EXISTS email               VARCHAR(200),
    -- "Casa de dos pisos, portón verde". En un barrio sin nomenclatura es lo
    -- único con lo que el técnico llega.
    ADD COLUMN IF NOT EXISTS referencia          TEXT,
    ADD COLUMN IF NOT EXISTS sector              VARCHAR(100),
    ADD COLUMN IF NOT EXISTS canton              VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tecnologia          VARCHAR(10) NOT NULL DEFAULT 'ftth';

COMMENT ON COLUMN instalaciones.nombre IS
    'Nombre del prospecto. Se usa mientras no hay `client_id`: el que pide el servicio todavía no es cliente.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_tecnologia_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_tecnologia_check
            CHECK (tecnologia IN ('ftth', 'wireless'));
    END IF;

    -- Una visita sin cliente y sin nombre no se le puede entregar a nadie.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_tiene_destinatario') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_tiene_destinatario
            CHECK (client_id IS NOT NULL OR nombre IS NOT NULL);
    END IF;
END $$;


-- =============================================================================
-- 2. Factibilidad y cobertura
-- =============================================================================
ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS factibilidad       VARCHAR(15) NOT NULL DEFAULT 'pendiente',
    ADD COLUMN IF NOT EXISTS factibilidad_notas TEXT,
    ADD COLUMN IF NOT EXISTS factibilidad_at    TIMESTAMP WITH TIME ZONE,

    -- De dónde va a colgar. Se decide al validar la cobertura, no en la calle:
    -- si la caja está llena, el técnico se entera antes de subir a la escalera.
    ADD COLUMN IF NOT EXISTS nap_id             UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS puerto_nap         VARCHAR(20),
    ADD COLUMN IF NOT EXISTS torre_id           UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS distancia_nodo_m   INT CHECK (distancia_nodo_m IS NULL OR distancia_nodo_m >= 0);

COMMENT ON COLUMN instalaciones.factibilidad IS
    'pendiente = no se revisó; factible = hay cobertura y puerto libre; con_obra = llega pero hay que tender o poner un poste; no_factible = fuera de alcance.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_factibilidad_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_factibilidad_check
            CHECK (factibilidad IN ('pendiente', 'factible', 'con_obra', 'no_factible'));
    END IF;
END $$;


-- =============================================================================
-- 3. Agenda: quién va y cuándo
-- =============================================================================
-- El `tecnico` de texto se conserva: hay visitas viejas cargadas con el nombre
-- escrito a mano y borrarlas para ganar prolijidad sería perder el historial.
ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS tecnico_id   UUID REFERENCES tecnicos(id)   ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cuadrilla_id UUID REFERENCES cuadrillas(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS franja       VARCHAR(10),

    -- Lo que definió la oficina y el técnico no decide: qué plan contrató, a
    -- qué precio y qué día se le factura.
    ADD COLUMN IF NOT EXISTS plan_id         UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS precio_mensual  NUMERIC(10,2) CHECK (precio_mensual IS NULL OR precio_mensual >= 0),
    ADD COLUMN IF NOT EXISTS dia_facturacion INT CHECK (dia_facturacion IS NULL OR dia_facturacion BETWEEN 1 AND 28);

COMMENT ON COLUMN instalaciones.dia_facturacion IS
    'Día de corte/facturación. Lo fija la oficina al cerrar la venta; el técnico en campo no lo toca.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_franja_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_franja_check
            CHECK (franja IS NULL OR franja IN ('manana', 'tarde', 'exacta'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_instalaciones_tecnico
    ON instalaciones (tecnico_id, fecha) WHERE tecnico_id IS NOT NULL;


-- =============================================================================
-- 4. Lo que captura el técnico en el celular
-- =============================================================================
ALTER TABLE instalaciones
    -- Paso 1 — el equipo que se deja puesto -------------------------------
    ADD COLUMN IF NOT EXISTS equipo_tipo   VARCHAR(10),
    ADD COLUMN IF NOT EXISTS equipo_modelo VARCHAR(100),
    ADD COLUMN IF NOT EXISTS equipo_sn     VARCHAR(100),
    ADD COLUMN IF NOT EXISTS equipo_mac    VARCHAR(17),
    -- Escaneado o tecleado. Un SN mal copiado a mano es la causa más común de
    -- que la ONT "no aparezca" en la OLT, y conviene saber cuál fue.
    ADD COLUMN IF NOT EXISTS equipo_origen VARCHAR(10),

    -- Paso 2 — lo que dijo la OLT o el router en ese momento ---------------
    ADD COLUMN IF NOT EXISTS olt_id       UUID REFERENCES olts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS puerto_pon   VARCHAR(20),
    ADD COLUMN IF NOT EXISTS rx_power_dbm NUMERIC(6,2),
    ADD COLUMN IF NOT EXISTS tx_power_dbm NUMERIC(6,2),
    ADD COLUMN IF NOT EXISTS senal_dbm    NUMERIC(6,2),
    ADD COLUMN IF NOT EXISTS ccq          INT CHECK (ccq IS NULL OR ccq BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS lectura_at   TIMESTAMP WITH TIME ZONE,

    -- Paso 3 — parámetros de red ------------------------------------------
    ADD COLUMN IF NOT EXISTS router_id        UUID REFERENCES routers_mikrotik(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS tipo_conexion    VARCHAR(10) NOT NULL DEFAULT 'pppoe',
    ADD COLUMN IF NOT EXISTS tipo_ip          VARCHAR(10) NOT NULL DEFAULT 'fija',
    ADD COLUMN IF NOT EXISTS usuario_ppp      VARCHAR(100),
    ADD COLUMN IF NOT EXISTS clave_ppp        VARCHAR(100),
    ADD COLUMN IF NOT EXISTS ip               VARCHAR(45),
    ADD COLUMN IF NOT EXISTS ipv6             VARCHAR(45),
    ADD COLUMN IF NOT EXISTS pool             VARCHAR(100),
    ADD COLUMN IF NOT EXISTS aprovisionado_at TIMESTAMP WITH TIME ZONE,

    -- Paso 4 — pruebas de salida ------------------------------------------
    ADD COLUMN IF NOT EXISTS ping_ok          BOOLEAN,
    ADD COLUMN IF NOT EXISTS ping_ms          NUMERIC(8,1),
    ADD COLUMN IF NOT EXISTS ping_perdida     INT,
    ADD COLUMN IF NOT EXISTS test_bajada_mbps NUMERIC(8,2),
    ADD COLUMN IF NOT EXISTS test_subida_mbps NUMERIC(8,2),
    ADD COLUMN IF NOT EXISTS pruebas_at       TIMESTAMP WITH TIME ZONE,

    -- Paso 5 — conformidad y cierre ---------------------------------------
    ADD COLUMN IF NOT EXISTS firma_b64               TEXT,
    ADD COLUMN IF NOT EXISTS firmante_nombre         VARCHAR(150),
    ADD COLUMN IF NOT EXISTS firmante_identificacion VARCHAR(20),
    ADD COLUMN IF NOT EXISTS observaciones           TEXT,
    ADD COLUMN IF NOT EXISTS alta_at                 TIMESTAMP WITH TIME ZONE,

    -- Hasta dónde llegó el asistente. El técnico se queda sin señal a mitad
    -- del paso 3 más seguido de lo que parece: al volver a entrar tiene que
    -- retomar donde estaba y no empezar de cero.
    ADD COLUMN IF NOT EXISTS paso SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN instalaciones.rx_power_dbm IS
    'Potencia recibida por la ONT al momento del alta. Es la línea de base contra la que se compara cualquier reclamo posterior.';

COMMENT ON COLUMN instalaciones.clave_ppp IS
    'Clave PPPoE con la que quedó configurado el equipo. En claro porque el RouterOS la guarda así y hay que poder dictarla.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_equipo_tipo_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_equipo_tipo_check
            CHECK (equipo_tipo IS NULL OR equipo_tipo IN ('ont', 'cpe', 'router'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_equipo_origen_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_equipo_origen_check
            CHECK (equipo_origen IS NULL OR equipo_origen IN ('qr', 'codigo', 'manual'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_tipo_conexion_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_tipo_conexion_check
            CHECK (tipo_conexion IN ('ip', 'pppoe', 'hotspot'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_tipo_ip_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_tipo_ip_check
            CHECK (tipo_ip IN ('fija', 'dinamica'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_paso_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_paso_check
            CHECK (paso BETWEEN 0 AND 5);
    END IF;
END $$;

-- Dos instalaciones abiertas no pueden reclamar la misma ONT: si el técnico
-- escanea un equipo que ya está puesto en otra casa, tiene que enterarse ahí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instalaciones_equipo_sn
    ON instalaciones (equipo_sn)
    WHERE equipo_sn IS NOT NULL AND estado <> 'cancelada';


-- =============================================================================
-- 5. El estado arranca antes de la agenda
-- =============================================================================
-- Un prospecto sin fecha no es una visita "agendada": nadie va a ir todavía.
-- Mezclarlos haría que la agenda del día muestre trabajos que ni siquiera se
-- sabe si son factibles.
ALTER TABLE instalaciones DROP CONSTRAINT IF EXISTS instalaciones_estado_check;
ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_estado_check
    CHECK (estado IN ('prospecto', 'agendada', 'en_curso', 'hecha', 'cancelada'));


-- =============================================================================
-- 6. Fotos de la instalación
-- =============================================================================
-- La imagen va al bucket; acá queda la ruta y de qué es. Guardar el binario en
-- la tabla haría que el listado arrastre megabytes en cada consulta.
CREATE TABLE IF NOT EXISTS instalacion_fotos (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instalacion_id UUID NOT NULL REFERENCES instalaciones(id) ON DELETE CASCADE,
    tipo           VARCHAR(20) NOT NULL DEFAULT 'foto'
                   CHECK (tipo IN ('foto', 'fachada', 'equipo', 'potencia', 'cableado', 'otro')),
    ruta           TEXT NOT NULL,
    descripcion    VARCHAR(200),
    created_by     UUID,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instalacion_fotos ON instalacion_fotos (instalacion_id);

ALTER TABLE instalacion_fotos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_instalacion_fotos" ON instalacion_fotos;
CREATE POLICY "auth_all_instalacion_fotos" ON instalacion_fotos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- 7. La vista que lee la aplicación
-- =============================================================================
-- Se suelta y se rehace: está definida con `i.*`, y las columnas nuevas se
-- agregan al final de la tabla, así que un CREATE OR REPLACE fallaría por
-- cambio de tipos en las posiciones siguientes.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `numero`, la cadena siguió y esta versión quedó
     * atrás: la 91 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_instalaciones'
           AND column_name = 'numero'
    ) THEN
        RAISE NOTICE 'v_instalaciones ya está en su versión de la 91: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_instalaciones';
    EXECUTE $vista$
CREATE VIEW v_instalaciones WITH (security_invoker = true) AS
SELECT
    i.*,
    -- El nombre del prospecto vale mientras no haya ficha; después manda la
    -- del cliente, que es la que se mantiene actualizada.
    COALESCE(c.nombre, i.nombre)                 AS titular,
    COALESCE(c.identificacion, i.identificacion) AS cedula,
    c.nombre     AS cliente,
    c.ip         AS cliente_ip,
    c.estado     AS estado_cliente,
    o.sn         AS onu_serial,
    tec.nombre   AS tecnico_nombre,
    tec.telefono AS tecnico_telefono,
    cua.nombre   AS cuadrilla,
    nap.nombre   AS nap,
    torre.nombre AS torre,
    pl.nombre    AS plan,
    r.nombre     AS router,
    (SELECT COUNT(*) FROM instalacion_fotos f WHERE f.instalacion_id = i.id) AS fotos,

    -- Semáforo de la lectura, con el mismo criterio en las tres pantallas que
    -- lo muestran. Si vive en el frontend, cada una lo interpreta distinto.
    CASE
        WHEN i.tecnologia = 'ftth' AND i.rx_power_dbm IS NOT NULL THEN
            CASE
                WHEN i.rx_power_dbm < -27 OR i.rx_power_dbm > -8 THEN 'rojo'
                WHEN i.rx_power_dbm < -25                        THEN 'ambar'
                ELSE 'verde'
            END
        WHEN i.tecnologia = 'wireless' AND i.senal_dbm IS NOT NULL THEN
            CASE
                WHEN i.senal_dbm < -80                              THEN 'rojo'
                WHEN i.senal_dbm < -70 OR COALESCE(i.ccq, 100) < 80 THEN 'ambar'
                ELSE 'verde'
            END
    END AS semaforo,

    -- Qué falta para poder finalizar. Es la misma lista que valida la función
    -- de alta: la pantalla la muestra y el servidor la exige.
    (i.equipo_sn IS NOT NULL OR i.equipo_mac IS NOT NULL) AS tiene_equipo,
    (i.lectura_at IS NOT NULL)                            AS tiene_lectura,
    (i.tipo_conexion = 'pppoe' AND i.usuario_ppp IS NOT NULL)
        OR (i.tipo_conexion <> 'pppoe' AND (i.ip IS NOT NULL OR i.tipo_ip = 'dinamica')) AS tiene_red,
    (i.pruebas_at IS NOT NULL)                            AS tiene_pruebas,
    (i.firma_b64 IS NOT NULL)                             AS tiene_firma
FROM instalaciones i
LEFT JOIN clientes c          ON c.id     = i.client_id
LEFT JOIN onus o              ON o.id     = i.onu_id
LEFT JOIN tecnicos tec        ON tec.id   = i.tecnico_id
LEFT JOIN cuadrillas cua      ON cua.id   = i.cuadrilla_id
LEFT JOIN puntos_red nap      ON nap.id   = i.nap_id
LEFT JOIN puntos_red torre    ON torre.id = i.torre_id
LEFT JOIN planes_velocidad pl ON pl.id    = i.plan_id
LEFT JOIN routers_mikrotik r  ON r.id     = i.router_id
$vista$;
END $guarda$;

COMMENT ON VIEW v_instalaciones IS
    'Instalaciones con los nombres resueltos, el semáforo de la lectura y qué falta para poder dar de alta.';


-- =============================================================================
-- 8. Cobertura: qué hay cerca del domicilio
-- =============================================================================
-- Responde la pregunta de la validación de factibilidad: desde qué caja o qué
-- torre se le puede dar servicio a estas coordenadas, y si queda lugar.
--
-- La distancia es Haversine a mano, igual que en la migración 27: traer una
-- extensión de geometría para una cuenta de una línea sería cargar el proyecto
-- con algo que no se usa en ningún otro lado.
CREATE OR REPLACE FUNCTION cobertura_cercana(
    p_lat        NUMERIC,
    p_lng        NUMERIC,
    p_tecnologia TEXT DEFAULT 'ftth',
    p_limite     INT  DEFAULT 5
)
RETURNS TABLE (
    id           UUID,
    nombre       VARCHAR,
    tipo         VARCHAR,
    direccion    VARCHAR,
    distancia_m  INT,
    capacidad    INT,
    ocupados     BIGINT,
    disponibles  INT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        pr.id,
        pr.nombre,
        pr.tipo,
        pr.direccion,
        ROUND((6371000 * 2 * ASIN(SQRT(
            POWER(SIN(RADIANS(pr.latitud - p_lat) / 2), 2) +
            COS(RADIANS(p_lat)) * COS(RADIANS(pr.latitud)) *
            POWER(SIN(RADIANS(pr.longitud - p_lng) / 2), 2)
        )))::NUMERIC)::INT AS distancia_m,
        pr.capacidad,
        COALESCE(u.ocupados, 0) AS ocupados,
        CASE WHEN pr.capacidad IS NULL THEN NULL
             ELSE pr.capacidad - COALESCE(u.ocupados, 0)::INT
        END AS disponibles
    FROM puntos_red pr
    LEFT JOIN (
        -- Ocupación real: los abonados colgados más las instalaciones que ya
        -- reservaron un puerto y todavía no se hicieron. Sin contar estas
        -- últimas, dos ventas del mismo día terminan asignadas a la misma caja
        -- llena.
        SELECT punto_id, COUNT(*) AS ocupados FROM (
            SELECT nap_id AS punto_id FROM clientes
             WHERE nap_id IS NOT NULL AND estado <> 'baja'
            UNION ALL
            SELECT conectado_a_id FROM clientes
             WHERE conectado_a_id IS NOT NULL AND estado <> 'baja'
            UNION ALL
            SELECT COALESCE(nap_id, torre_id) FROM instalaciones
             WHERE COALESCE(nap_id, torre_id) IS NOT NULL
               AND estado IN ('prospecto', 'agendada', 'en_curso')
        ) t
        GROUP BY punto_id
    ) u ON u.punto_id = pr.id
    WHERE pr.activo
      AND pr.latitud IS NOT NULL
      AND pr.longitud IS NOT NULL
      AND pr.tipo::TEXT = ANY (
          CASE WHEN p_tecnologia = 'wireless'
               THEN ARRAY['antena', 'torre']
               ELSE ARRAY['nap']
          END
      )
    -- Se ordena por posición y no por nombre: en una función SQL las columnas
    -- de RETURNS TABLE se pueden referenciar como parámetros, y `distancia_m`
    -- sería ambiguo entre la columna calculada y la de salida.
    ORDER BY 5
    LIMIT GREATEST(p_limite, 1);
$$;

COMMENT ON FUNCTION cobertura_cercana IS
    'Puntos de red más cercanos a unas coordenadas, con su ocupación. Es lo que responde si una dirección es factible.';


-- =============================================================================
-- 9. El disparador tolera prospectos
-- =============================================================================
-- La 12 daba por hecho que toda instalación tenía cliente. Ahora puede no
-- tenerlo, y un UPDATE con `WHERE id = NULL` no falla: no hace nada y deja
-- pensar que actualizó. Se corta explícito.
CREATE OR REPLACE FUNCTION instalacion_actualiza_cliente()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.client_id IS NULL OR NEW.estado <> 'hecha' THEN
        RETURN NEW;
    END IF;

    IF NEW.tipo IN ('nueva', 'traslado') THEN
        UPDATE clientes
           SET fecha_instalacion = NEW.fecha,
               estado = CASE WHEN NEW.tipo = 'nueva' THEN 'activo' ELSE estado END,
               direccion = COALESCE(NEW.direccion, direccion),
               latitud   = COALESCE(NEW.latitud, latitud),
               longitud  = COALESCE(NEW.longitud, longitud)
         WHERE id = NEW.client_id;
    END IF;

    IF NEW.tipo = 'retiro' THEN
        UPDATE clientes SET estado = 'baja' WHERE id = NEW.client_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- 10. Finalizar el alta: la instalación pasa a Usuarios
-- =============================================================================
-- Es el botón "Finalizar Alta" del asistente. Crea la ficha del abonado si el
-- trabajo era de un prospecto, o la actualiza si ya existía, copia los
-- parámetros con los que quedó configurado y cierra la visita.
--
-- Todo en una función porque es una sola operación del negocio. Hecho desde el
-- navegador serían tres escrituras sueltas, y perder la señal entre la segunda
-- y la tercera dejaría un cliente activo sin instalación cerrada.
--
-- Es idempotente: si el técnico aprieta dos veces —o vuelve a entrar porque no
-- vio la confirmación— devuelve el mismo cliente en vez de crear un duplicado.
CREATE OR REPLACE FUNCTION finalizar_alta_instalacion(p_instalacion_id UUID)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    i  instalaciones%ROWTYPE;
    v_client_id UUID;
BEGIN
    SELECT * INTO i FROM instalaciones WHERE id = p_instalacion_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe la instalación %', p_instalacion_id;
    END IF;

    IF i.estado = 'hecha' AND i.client_id IS NOT NULL THEN
        RETURN i.client_id;
    END IF;

    IF i.estado = 'cancelada' THEN
        RAISE EXCEPTION 'La instalación está cancelada: no se puede dar de alta';
    END IF;

    -- Las mismas condiciones que muestra el asistente. Se validan también acá
    -- porque la pantalla se puede saltear y un alta a medias deja un abonado
    -- facturable que nadie verificó que tenga servicio.
    IF i.equipo_sn IS NULL AND i.equipo_mac IS NULL THEN
        RAISE EXCEPTION 'Falta leer el equipo: serie o MAC de la ONT/CPE';
    END IF;

    IF i.firma_b64 IS NULL THEN
        RAISE EXCEPTION 'Falta la firma de conformidad del cliente';
    END IF;

    IF i.tipo_conexion = 'pppoe' AND i.usuario_ppp IS NULL THEN
        RAISE EXCEPTION 'Falta el usuario PPPoE con el que quedó configurado el equipo';
    END IF;

    IF i.tipo_conexion <> 'pppoe' AND i.tipo_ip = 'fija' AND i.ip IS NULL THEN
        RAISE EXCEPTION 'Falta la IP asignada al abonado';
    END IF;

    v_client_id := i.client_id;

    IF v_client_id IS NULL THEN
        -- Era un prospecto: nace la ficha. `estado` queda en 'activo' porque
        -- desde este momento el abonado tiene servicio y entra a facturación.
        INSERT INTO clientes (
            nombre, tipo_identificacion, identificacion, telefono, telefono_movil,
            email, direccion, latitud, longitud,
            plan_id, precio_mensual, dia_facturacion,
            router_id, onu_id, nap_id, puerto_nap, conectado_a_id,
            tipo_conexion, tipo_ip, usuario_ppp, clave_ppp, ip, ipv6, mac_address,
            estado, origen, fecha_instalacion, notas
        ) VALUES (
            i.nombre, COALESCE(i.tipo_identificacion, '05'), i.identificacion,
            i.telefono, COALESCE(i.telefono_whatsapp, i.telefono),
            i.email, i.direccion, i.latitud, i.longitud,
            i.plan_id, i.precio_mensual, i.dia_facturacion,
            i.router_id, i.onu_id, i.nap_id, i.puerto_nap, i.torre_id,
            i.tipo_conexion, i.tipo_ip, i.usuario_ppp, i.clave_ppp, i.ip, i.ipv6, i.equipo_mac,
            'activo', 'manual', i.fecha, i.referencia
        )
        RETURNING id INTO v_client_id;
    ELSE
        -- Ya existía —un traslado, o una venta cargada desde la ficha—. Solo se
        -- pisa lo que el trabajo de hoy definió: COALESCE al revés borraría el
        -- dato viejo cuando el técnico no cargó el nuevo.
        UPDATE clientes SET
            plan_id         = COALESCE(i.plan_id, plan_id),
            precio_mensual  = COALESCE(i.precio_mensual, precio_mensual),
            dia_facturacion = COALESCE(i.dia_facturacion, dia_facturacion),
            router_id       = COALESCE(i.router_id, router_id),
            onu_id          = COALESCE(i.onu_id, onu_id),
            nap_id          = COALESCE(i.nap_id, nap_id),
            puerto_nap      = COALESCE(i.puerto_nap, puerto_nap),
            conectado_a_id  = COALESCE(i.torre_id, conectado_a_id),
            tipo_conexion   = i.tipo_conexion,
            tipo_ip         = i.tipo_ip,
            usuario_ppp     = COALESCE(i.usuario_ppp, usuario_ppp),
            clave_ppp       = COALESCE(i.clave_ppp, clave_ppp),
            ip              = COALESCE(i.ip, ip),
            ipv6            = COALESCE(i.ipv6, ipv6),
            mac_address     = COALESCE(i.equipo_mac, mac_address),
            telefono        = COALESCE(telefono, i.telefono),
            email           = COALESCE(email, i.email)
        WHERE id = v_client_id;
    END IF;

    -- El cierre. El disparador de la 12 se ocupa de la fecha de instalación y
    -- de dejar al cliente activo cuando el estado pasa a 'hecha'.
    UPDATE instalaciones
       SET client_id = v_client_id,
           estado    = 'hecha',
           paso      = 5,
           alta_at   = COALESCE(alta_at, NOW())
     WHERE id = p_instalacion_id;

    RETURN v_client_id;
END;
$$;

COMMENT ON FUNCTION finalizar_alta_instalacion IS
    'Cierra la instalación y la convierte en abonado activo: crea o actualiza la ficha del cliente con los parámetros con los que quedó el servicio. Devuelve el id del cliente.';


-- =============================================================================
-- 11. Lo que ya estaba cargado
-- =============================================================================
-- Las visitas viejas no tienen tecnología ni nombre propio: se completan con lo
-- que dice la ficha del cliente para que el listado no las muestre en blanco.
UPDATE instalaciones i
   SET nombre         = COALESCE(i.nombre, c.nombre),
       identificacion = COALESCE(i.identificacion, c.identificacion),
       telefono       = COALESCE(i.telefono, c.telefono),
       tecnologia     = CASE WHEN c.conectado_a_id IS NOT NULL THEN 'wireless' ELSE i.tecnologia END
  FROM clientes c
 WHERE c.id = i.client_id
   AND i.nombre IS NULL;

-- Y quedan en el paso final: son trabajos terminados antes de que existiera el
-- asistente, no altas a medio hacer.
UPDATE instalaciones SET paso = 5 WHERE estado = 'hecha' AND paso = 0;
