-- =============================================================================
-- Migración 94 — Traslado de domicilio
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Dos cosas, y la primera es un arreglo ──
--
-- 1. Cerrar un traslado NO cambiaba la dirección del abonado.
--
--    Comprobado contra esta base: se creó un cliente en "VIEJA 111", una orden
--    de traslado a "NUEVA 999", y al llamar a `finalizar_alta_instalacion()` el
--    PPPoE y la IP se actualizaron pero la dirección quedó en "VIEJA 111". O
--    sea: se hace el traslado completo y el próximo técnico que vaya, va a la
--    casa equivocada. La lista del UPDATE tenía plan, ONU, NAP, router, IP y
--    PPPoE — todo menos lo único que define a una mudanza.
--
--    (Existía un disparador que sí lo hacía, `trg_instalacion_alta` de la 12,
--    pero en esta base no está: se probó y no corre. Por eso además
--    `fecha_instalacion` quedó siempre en NULL.)
--
-- 2. El traslado no deja rastro de DÓNDE estaba el abonado.
--
--    Y ese es el dato que hace falta para dar de baja la ONT vieja. Cuando el
--    técnico llega al domicilio nuevo y quiere autorizar el mismo equipo, la
--    OLT lo rechaza —una serie no puede estar viva en dos puertos— y el sistema
--    contesta "está en placa 6 puerto 4, si es una mudanza primero hay que
--    darla de baja". Ahí el técnico se queda parado esperando que alguien en la
--    oficina la borre a mano.
--
--    Esta migración guarda la foto del origen ANTES de que el traslado empiece,
--    y deja la baja en una cola visible — la misma idea que
--    `v_reemplazos_pendientes` de la 93.
--
-- ── Qué NO hace ──
--
-- No toca la OLT. La baja de la ONT vieja en el equipo la ejecuta el middleware,
-- que es el único que tiene las credenciales. Acá queda anotada y pendiente.
--
-- No elige puerto PON, VLAN ni segmento del destino: eso ya lo resuelve el
-- flujo de alta a partir de dónde aparece físicamente la ONT, y es a propósito
-- que el técnico no los elija.
-- =============================================================================


-- =============================================================================
-- 1. El arreglo: la dirección viaja con el traslado
-- =============================================================================
/**
 * Cierra la instalación y la convierte en abonado activo.
 *
 * Es la misma función de la 31 con una sola diferencia: el domicilio.
 *
 * Se aplica solo en 'nueva' y 'traslado'. Una reparación también lleva la
 * dirección copiada del cliente, y dejarla pisar la ficha significaría que una
 * orden vieja mal cargada le cambie el domicilio a alguien que nunca se mudó.
 *
 * `COALESCE` en cada campo: si el técnico no cargó coordenadas nuevas, se
 * conservan las que había. Un traslado sin GPS es normal —se cargan después—;
 * borrar las viejas dejaría al abonado sin punto en el mapa.
 */
CREATE OR REPLACE FUNCTION finalizar_alta_instalacion(p_instalacion_id UUID)
RETURNS UUID
LANGUAGE plpgsql
/**
 * SECURITY DEFINER, y no es un adorno.
 *
 * La 70 cerró la escritura sobre `clientes` a quien no tiene la cartera
 * completa, y dejó esta función como DEFINER para que el alta en campo siguiera
 * funcionando: el técnico no puede editar abonados, pero SÍ puede cerrar su
 * instalación y que de ahí nazca la ficha.
 *
 * Esa marca la puso un `ALTER FUNCTION` aparte, y `CREATE OR REPLACE` la BORRA
 * —vuelve al modo invoker— sin decir nada. Al recrear la función acá sin
 * repetirla, el alta quedó rota para todos los técnicos: al finalizar, el INSERT
 * en `clientes` choca contra la política y devuelve "new row violates row-level
 * security policy". Y no se vio hasta que alguien completó un alta entera.
 *
 * Por eso va escrita en la definición y no en un ALTER suelto: acá no se puede
 * perder al reemplazarla.
 */
SECURITY DEFINER
SET search_path = public, pg_temp
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
            email           = COALESCE(email, i.email),

            -- ── Lo que faltaba ──
            direccion = CASE WHEN i.tipo IN ('nueva', 'traslado')
                             THEN COALESCE(i.direccion, direccion) ELSE direccion END,
            latitud   = CASE WHEN i.tipo IN ('nueva', 'traslado')
                             THEN COALESCE(i.latitud, latitud)     ELSE latitud   END,
            longitud  = CASE WHEN i.tipo IN ('nueva', 'traslado')
                             THEN COALESCE(i.longitud, longitud)   ELSE longitud  END,

            -- La fecha de instalación se llena solo si estaba vacía.
            --
            -- Es a propósito que un traslado NO la pise: es la fecha desde la
            -- que la persona es abonada, y de ahí sale su antigüedad. Un cliente
            -- de cinco años que se muda no es un cliente nuevo. Cuándo fue la
            -- mudanza ya está en la orden, con su número y su fecha.
            fecha_instalacion = COALESCE(fecha_instalacion, i.fecha)
        WHERE id = v_client_id;
    END IF;

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
    'Cierra la instalación y la convierte en abonado activo: crea o actualiza la ficha con los parámetros con los que quedó el servicio. En altas y traslados también actualiza el domicilio. Devuelve el id del cliente.';


-- =============================================================================
-- 2. La foto del origen
-- =============================================================================
/**
 * De dónde se mudó el abonado.
 *
 * ── Por qué una tabla y no columnas en `instalaciones` ──
 *
 * Porque la orden de trabajo describe el DESTINO: a dónde va el técnico, qué
 * ONT deja, con qué IP queda. El origen es otra cosa y tiene otro dueño: es lo
 * que hay que desarmar, y lo desarma la oficina o el middleware, no quien está
 * parado en la casa nueva.
 *
 * ── Por qué se copian los valores y no solo los ids ──
 *
 * Porque el objetivo de esta fila es sobrevivir a que el origen desaparezca. La
 * ONU vieja se va a borrar —ese es el punto— y con `ON DELETE SET NULL` el id
 * quedaría en NULL. Si además no guardamos el puerto y la serie, la fila diría
 * "hubo un traslado" y nada más, que es exactamente lo que no sirve para
 * auditar ni para limpiar a mano lo que quedó colgado.
 */
CREATE TABLE IF NOT EXISTS traslados (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    cliente_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    -- La orden de trabajo del destino. Es opcional porque el traslado se
    -- registra al aceptarlo y la orden puede agendarse después.
    instalacion_id UUID REFERENCES instalaciones(id) ON DELETE SET NULL,

    -- ── El origen, tal como estaba ──
    direccion_anterior VARCHAR(300),
    latitud_anterior   NUMERIC(10,7),
    longitud_anterior  NUMERIC(10,7),

    olt_anterior_id  UUID REFERENCES olts(id) ON DELETE SET NULL,
    onu_anterior_id  UUID REFERENCES onus(id) ON DELETE SET NULL,
    sn_anterior      VARCHAR(60),
    slot_anterior    INT,
    puerto_anterior  INT,
    onu_index_anterior INT,
    vlan_anterior    INT,

    nap_anterior_id  UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    puerto_nap_anterior VARCHAR(20),
    router_anterior_id UUID REFERENCES routers_mikrotik(id) ON DELETE SET NULL,
    ip_anterior      VARCHAR(45),

    -- ── El destino, mientras se sepa ──
    direccion_nueva  VARCHAR(300),
    latitud_nueva    NUMERIC(10,7),
    longitud_nueva   NUMERIC(10,7),

    motivo   TEXT,

    /**
     * La ONT vieja sigue autorizada en la OLT de origen.
     *
     * Mientras esto sea TRUE, dos cosas: ocupa un ONT-ID que nadie usa, y —si
     * es el mismo aparato físico que se llevaron— NO se puede autorizar en el
     * destino, porque una serie no puede estar viva en dos puertos.
     *
     * O sea que esta bandera no es contabilidad: es lo que traba el traslado.
     */
    pendiente_baja BOOLEAN NOT NULL DEFAULT TRUE,
    baja_at        TIMESTAMPTZ,
    baja_detalle   TEXT,

    estado   VARCHAR(12) NOT NULL DEFAULT 'abierto',

    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    creado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cerrado_en TIMESTAMPTZ,

    CONSTRAINT traslados_estado_check CHECK (estado IN ('abierto', 'hecho', 'cancelado')),
    -- Un traslado cerrado con la ONT vieja todavía viva es el estado que hace
    -- daño: nadie lo vuelve a mirar y el índice queda ocupado para siempre.
    CONSTRAINT traslados_cierre_check CHECK (estado <> 'hecho' OR pendiente_baja = FALSE)
);

CREATE INDEX IF NOT EXISTS idx_traslados_cliente ON traslados (cliente_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_traslados_pendientes
    ON traslados (creado_en) WHERE pendiente_baja;


-- =============================================================================
-- 3. Empezar un traslado
-- =============================================================================
/**
 * Registra la mudanza y agenda la visita al domicilio nuevo.
 *
 * ── Qué hace, en una transacción ──
 *
 *   1. Saca la foto de dónde está el abonado HOY.
 *   2. Crea la orden de trabajo de tipo 'traslado' con la dirección nueva.
 *   3. Deja la baja de la ONT vieja pendiente, en una cola que se ve.
 *
 * ── Por qué la foto va primero ──
 *
 * Porque después no se puede sacar. En cuanto el técnico autorice la ONT en el
 * destino, `clientes.onu_id` va a apuntar al lugar nuevo y el viejo se pierde.
 * Es el mismo error que tenía el cambio de equipo antes de la 93.
 *
 * ── Qué NO hace ──
 *
 * No toca la OLT y no elige nada de red del destino. El puerto PON, la VLAN y
 * el segmento salen de dónde aparezca físicamente la ONT cuando el técnico
 * mida, igual que en un alta.
 */
CREATE OR REPLACE FUNCTION iniciar_traslado(
    p_cliente     UUID,
    p_direccion   TEXT,
    p_latitud     NUMERIC DEFAULT NULL,
    p_longitud    NUMERIC DEFAULT NULL,
    p_fecha       DATE    DEFAULT NULL,
    p_motivo      TEXT    DEFAULT NULL,
    p_tecnico     UUID    DEFAULT NULL,
    p_referencia  TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c            clientes%ROWTYPE;
    u            onus%ROWTYPE;
    v_instalacion UUID;
    v_traslado   UUID;
    v_abierto    UUID;
BEGIN
    /**
     * Quién puede mudar a un abonado.
     *
     * La función es SECURITY DEFINER —tiene que serlo, porque escribe en
     * `instalaciones` y en `traslados` en una sola transacción— y eso significa
     * que corre saltándose RLS. Sin esta verificación, cualquiera con sesión
     * podría abrirle un traslado a cualquier abonado y agendarle una visita.
     *
     * Es la misma regla que la política de escritura de la tabla: quien maneja
     * la cartera. Un traslado es una decisión comercial, no algo que se resuelve
     * parado en la vereda.
     */
    IF NOT cartera_completa() THEN
        RAISE EXCEPTION 'No tenés permiso para trasladar abonados';
    END IF;

    IF p_direccion IS NULL OR BTRIM(p_direccion) = '' THEN
        RAISE EXCEPTION 'Falta la dirección nueva: sin eso no hay traslado que agendar';
    END IF;

    SELECT * INTO c FROM clientes WHERE id = p_cliente;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese abonado';
    END IF;

    -- Dos traslados abiertos sobre el mismo abonado significan dos fotos del
    -- origen, y la segunda ya se sacó con el servicio a medio mover: guardaría
    -- datos falsos. Se corta y se manda a cerrar el que está.
    SELECT id INTO v_abierto
      FROM traslados
     WHERE cliente_id = p_cliente AND estado = 'abierto'
     LIMIT 1;
    IF v_abierto IS NOT NULL THEN
        RAISE EXCEPTION 'Ese abonado ya tiene un traslado en curso. Cerralo o cancelalo antes de abrir otro.';
    END IF;

    -- La ONU de origen. Puede no haber —un abonado por radio, o uno importado
    -- sin enlazar— y eso no impide mudarlo: solo significa que no hay nada que
    -- dar de baja en ninguna OLT.
    IF c.onu_id IS NOT NULL THEN
        SELECT * INTO u FROM onus WHERE id = c.onu_id;
    END IF;

    -- ── La orden de trabajo del destino ──
    INSERT INTO instalaciones (
        client_id, tipo, estado, fecha,
        nombre, tipo_identificacion, identificacion, telefono, email,
        direccion, latitud, longitud, referencia,
        plan_id, precio_mensual, dia_facturacion,
        tecnologia, tecnico_id,
        -- El plan y la conexión se arrastran: el abonado se muda, no cambia de
        -- servicio. Lo que NO se arrastra es la red —OLT, puerto, VLAN, IP—,
        -- que es justo lo que cambia de sector a sector.
        tipo_conexion, tipo_ip,
        notas
    ) VALUES (
        p_cliente, 'traslado', 'agendada', COALESCE(p_fecha, CURRENT_DATE),
        c.nombre, c.tipo_identificacion, c.identificacion, c.telefono, c.email,
        BTRIM(p_direccion), p_latitud, p_longitud, p_referencia,
        c.plan_id, c.precio_mensual, c.dia_facturacion,
        CASE WHEN c.conectado_a_id IS NOT NULL THEN 'wireless' ELSE 'ftth' END,
        p_tecnico,
        COALESCE(c.tipo_conexion, 'pppoe'), COALESCE(c.tipo_ip, 'dinamica'),
        CASE WHEN p_motivo IS NULL THEN NULL
             ELSE 'Traslado desde: ' || COALESCE(c.direccion, 's/d') || '. ' || p_motivo END
    )
    RETURNING id INTO v_instalacion;

    -- ── La foto del origen ──
    INSERT INTO traslados (
        cliente_id, instalacion_id,
        direccion_anterior, latitud_anterior, longitud_anterior,
        olt_anterior_id, onu_anterior_id, sn_anterior,
        slot_anterior, puerto_anterior, onu_index_anterior, vlan_anterior,
        nap_anterior_id, puerto_nap_anterior, router_anterior_id, ip_anterior,
        direccion_nueva, latitud_nueva, longitud_nueva,
        motivo,
        -- Sin ONU no hay nada que bajar de ninguna OLT: nace resuelta.
        pendiente_baja,
        tecnico_id, creado_por
    ) VALUES (
        p_cliente, v_instalacion,
        c.direccion, c.latitud, c.longitud,
        u.olt_id, u.id, u.sn,
        u.slot, u.puerto, u.onu_index, u.vlan,
        c.nap_id, c.puerto_nap, c.router_id, c.ip,
        BTRIM(p_direccion), p_latitud, p_longitud,
        p_motivo,
        u.id IS NOT NULL,
        COALESCE(p_tecnico, mi_tecnico_id()), mi_legajo_id()
    )
    RETURNING id INTO v_traslado;

    RETURN v_traslado;
END $$;

COMMENT ON FUNCTION iniciar_traslado IS
    'Abre un traslado de domicilio: guarda de dónde está el abonado hoy (OLT, puerto, VLAN, NAP, IP), agenda la orden de trabajo en la dirección nueva y deja pendiente la baja de la ONT vieja. No toca la OLT.';


-- =============================================================================
-- 4. Lo que falta desarmar
-- =============================================================================
-- La cola de la oficina: traslados cuya ONT vieja sigue autorizada.
--
-- A diferencia de `v_reemplazos_pendientes`, acá el abonado NO está sin
-- servicio: sigue conectado en el domicilio viejo hasta que se mude de verdad.
-- Lo que traba es el destino — si es el mismo equipo físico, no se va a poder
-- autorizar hasta que esta fila desaparezca.
DROP VIEW IF EXISTS v_traslados_pendientes;
CREATE VIEW v_traslados_pendientes WITH (security_invoker = true) AS
SELECT
    t.*,
    c.nombre     AS cliente,
    o.nombre     AS olt_anterior,
    tc.nombre    AS tecnico,
    i.numero     AS orden_numero,
    i.fecha      AS orden_fecha,
    i.estado     AS orden_estado,
    (EXTRACT(EPOCH FROM (NOW() - t.creado_en)) / 86400)::INT AS dias_esperando
FROM traslados t
LEFT JOIN clientes      c  ON c.id  = t.cliente_id
LEFT JOIN olts          o  ON o.id  = t.olt_anterior_id
LEFT JOIN tecnicos      tc ON tc.id = t.tecnico_id
LEFT JOIN instalaciones i  ON i.id  = t.instalacion_id
WHERE t.pendiente_baja AND t.estado = 'abierto';

GRANT SELECT ON v_traslados_pendientes TO authenticated;

-- El historial completo de mudanzas de un abonado, con las dos direcciones.
DROP VIEW IF EXISTS v_traslados;
CREATE VIEW v_traslados WITH (security_invoker = true) AS
SELECT
    t.*,
    c.nombre  AS cliente,
    o.nombre  AS olt_anterior,
    tc.nombre AS tecnico,
    i.numero  AS orden_numero,
    i.estado  AS orden_estado
FROM traslados t
LEFT JOIN clientes      c  ON c.id  = t.cliente_id
LEFT JOIN olts          o  ON o.id  = t.olt_anterior_id
LEFT JOIN tecnicos      tc ON tc.id = t.tecnico_id
LEFT JOIN instalaciones i  ON i.id  = t.instalacion_id;

GRANT SELECT ON v_traslados TO authenticated;


-- =============================================================================
-- 5. Seguridad
-- =============================================================================
ALTER TABLE traslados ENABLE ROW LEVEL SECURITY;

-- Leer: quien maneja la cartera, y el técnico el suyo. La fila lleva la
-- dirección vieja y la nueva del abonado, así que se rige por la misma regla
-- que el resto de sus datos.
DROP POLICY IF EXISTS traslados_lectura ON traslados;
CREATE POLICY traslados_lectura ON traslados
    FOR SELECT TO authenticated
    USING (cartera_completa() OR tecnico_id = mi_tecnico_id());

-- Escribir directo: solo quien maneja la cartera, y para corregir o cancelar.
-- Abrir un traslado va por la función: una fila insertada a mano no tendría la
-- foto del origen —que es todo el punto— ni la orden de trabajo asociada.
DROP POLICY IF EXISTS traslados_escritura ON traslados;
CREATE POLICY traslados_escritura ON traslados
    FOR ALL TO authenticated
    USING (cartera_completa()) WITH CHECK (cartera_completa());


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT iniciar_traslado('<cliente>', 'Av. Nueva 456 y Segunda', NULL, NULL,
--                           CURRENT_DATE + 2, 'Se muda por trabajo');
--
--   SELECT cliente, direccion_anterior, direccion_nueva,
--          sn_anterior, puerto_anterior, vlan_anterior, dias_esperando
--     FROM v_traslados_pendientes;
--
-- Y que la dirección ahora sí viaje al cerrar la orden:
--   SELECT finalizar_alta_instalacion('<la orden de traslado>');
--   SELECT direccion FROM clientes WHERE id = '<cliente>';
