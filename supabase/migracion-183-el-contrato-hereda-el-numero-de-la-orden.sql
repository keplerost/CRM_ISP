-- =============================================================================
-- Migración 183 — El contrato nace con el alta y hereda el número de la orden
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Los dos agujeros que tapa ──
--
-- 1. AL DAR DE ALTA NO NACÍA NINGÚN CONTRATO.
--
--    `finalizar_alta_instalacion` creaba la ficha del abonado y cerraba la
--    orden, pero nunca insertaba en `contratos`. La fila solo aparecía si
--    alguien entraba a la ficha y la cargaba a mano, y eso no lo hace nadie
--    cuando el técnico ya se fue y el cliente ya está navegando.
--
--    Resultado: abonados activos, facturando, sin contrato en el sistema. El
--    papel firmado existe en una carpeta y el sistema no sabe que existe.
--
-- 2. CUANDO SÍ SE CARGABA, EL NÚMERO NO ERA EL DEL PAPEL.
--
--    El contrato que firma el cliente sale con el NÚMERO DE LA ORDEN —así lo
--    arma `armarContratoArcotelDeInstalacion`:
--
--        -- El número de la orden hace de número de contrato hasta que haya uno
--        numero: inst.numero ? String(inst.numero) : ''
--
--    Pero al crear la fila desde la ficha, el número por defecto era el CÓDIGO
--    DEL ABONADO con ceros adelante. O sea que el papel decía «1010» y el
--    sistema guardaba «000048». Buscar el contrato 1010 dentro del sistema no
--    daba nada, y son dos identificadores para el mismo documento.
--
-- Ahora el contrato nace solo al cerrar el alta, con el número de la orden: lo
-- que está impreso en el papel que el cliente firmó es lo que se puede buscar.
--
-- ── Por qué no toca los traslados ──
--
-- Un traslado es el mismo abonado mudándose, y ya tiene su contrato vigente. La
-- guarda `NOT EXISTS (... estado = 'vigente')` lo saltea: mudarse no genera un
-- contrato nuevo ni cambia el número del que se firmó.
-- =============================================================================


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
    v_numero    TEXT;
    v_precio    NUMERIC(12,2);
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

    -- ── La IP fija, sin excepciones por tipo de conexión ──
    --
    -- Antes esto solo corría para las conexiones que no eran PPPoE. En PPPoE la
    -- dirección vive en el secret del router en vez de en la ONT, pero sigue
    -- siendo una IP fija que alguien tiene que haber elegido de la subred de
    -- ESTE sector.
    IF i.tipo_ip = 'fija' AND i.ip IS NULL THEN
        RAISE EXCEPTION
            'Falta la IP fija del abonado. Sacala del segmento de este sector (el asistente la propone en el paso de red); la del domicilio anterior es de otra subred y no le va a servir.';
    END IF;

    -- ── El router, en un traslado ──
    --
    -- Un traslado a otro sector casi siempre cambia de router. Cerrarlo con el
    -- del domicilio viejo deja los cortes apuntando al equipo equivocado y el
    -- secret PPPoE buscándose donde no está. El paso de aprovisionamiento ya lo
    -- guarda, así que exigirlo no agrega trabajo: detecta el caso en que ese
    -- paso se salteó.
    IF i.tipo = 'traslado' AND i.router_id IS NULL THEN
        RAISE EXCEPTION
            'Falta el router del sector nuevo. Sin eso, el abonado quedaría atado al router del domicilio anterior.';
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
            onu_id          = COALESCE(i.onu_id, onu_id),
            nap_id          = COALESCE(i.nap_id, nap_id),
            puerto_nap      = COALESCE(i.puerto_nap, puerto_nap),
            conectado_a_id  = COALESCE(i.torre_id, conectado_a_id),
            tipo_conexion   = i.tipo_conexion,
            tipo_ip         = i.tipo_ip,
            usuario_ppp     = COALESCE(i.usuario_ppp, usuario_ppp),
            clave_ppp       = COALESCE(i.clave_ppp, clave_ppp),
            mac_address     = COALESCE(i.equipo_mac, mac_address),
            telefono        = COALESCE(telefono, i.telefono),
            email           = COALESCE(email, i.email),

            /**
             * La red, en un traslado, se REEMPLAZA. No se conserva.
             *
             * El COALESCE existe para no borrar un dato bueno cuando el técnico
             * no cargó el nuevo, y para casi todos los campos eso es correcto.
             * Para la dirección IP y el router, en una mudanza, es exactamente
             * al revés: lo que había pertenece a otra subred y a otro equipo.
             * Conservarlo no es "no perder el dato", es guardar uno falso que
             * además parece configurado.
             *
             * La validación de arriba ya garantiza que un traslado con IP fija
             * traiga la suya, así que esto no borra nada que haga falta.
             */
            router_id = CASE WHEN i.tipo = 'traslado'
                             THEN i.router_id ELSE COALESCE(i.router_id, router_id) END,
            ip        = CASE WHEN i.tipo = 'traslado'
                             THEN i.ip      ELSE COALESCE(i.ip, ip)      END,
            ipv6      = CASE WHEN i.tipo = 'traslado'
                             THEN i.ipv6    ELSE COALESCE(i.ipv6, ipv6)  END,

            direccion = CASE WHEN i.tipo IN ('nueva', 'traslado')
                             THEN COALESCE(i.direccion, direccion) ELSE direccion END,
            latitud   = CASE WHEN i.tipo IN ('nueva', 'traslado')
                             THEN COALESCE(i.latitud, latitud)     ELSE latitud   END,
            longitud  = CASE WHEN i.tipo IN ('nueva', 'traslado')
                             THEN COALESCE(i.longitud, longitud)   ELSE longitud  END,

            -- La antigüedad no se pisa: un cliente de cinco años que se muda no
            -- es un cliente nuevo. Cuándo fue la mudanza está en la orden.
            fecha_instalacion = COALESCE(fecha_instalacion, i.fecha)
        WHERE id = v_client_id;
    END IF;

    -- =========================================================================
    -- El contrato, con el número que dice el papel
    -- =========================================================================
    --
    -- Solo si no tiene uno vigente. Eso cubre el traslado —el abonado ya tiene
    -- el suyo y mudarse no lo cambia— y cubre volver a correr el alta.
    IF NOT EXISTS (
        SELECT 1 FROM contratos WHERE client_id = v_client_id AND estado = 'vigente'
    ) THEN
        v_numero := NULLIF(TRIM(COALESCE(i.numero::TEXT, '')), '');

        /**
         * Si ese número ya está tomado, el contrato nace sin número.
         *
         * `idx_contratos_numero` es único, así que insertar un repetido haría
         * fallar la transacción entera — y con ella el alta. Un técnico en la
         * vereda vería "no se pudo cerrar la instalación" por un choque de
         * numeración que no puede resolver ni entender.
         *
         * Perder el número es reversible desde la ficha en diez segundos;
         * perder el alta no. Por eso se prefiere el contrato sin número al alta
         * caída.
         */
        IF v_numero IS NOT NULL
           AND EXISTS (SELECT 1 FROM contratos WHERE numero = v_numero) THEN
            v_numero := NULL;
        END IF;

        -- El precio de la orden si el vendedor lo pactó; si no, el que le quedó
        -- a la ficha. La columna es NOT NULL, así que el 0 es el último recurso.
        SELECT COALESCE(i.precio_mensual, c.precio_mensual, 0)
          INTO v_precio
          FROM clientes c WHERE c.id = v_client_id;

        INSERT INTO contratos (
            client_id, numero, plan_id, fecha_inicio,
            permanencia_meses, precio_mensual, dia_pago, estado
        ) VALUES (
            v_client_id,
            v_numero,
            i.plan_id,
            COALESCE(i.fecha, CURRENT_DATE),
            -- El CHECK pide >= 0. Un valor raro se descarta en vez de tumbar el alta.
            CASE WHEN i.permanencia_meses >= 0 THEN i.permanencia_meses END,
            v_precio,
            -- El CHECK pide entre 1 y 28: el 29, 30 y 31 no existen todos los meses.
            CASE WHEN i.dia_facturacion BETWEEN 1 AND 28 THEN i.dia_facturacion END,
            'vigente'
        );
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
    'Cierra la instalación y la convierte en abonado activo, creando su contrato con el numero de la orden (que es el que sale impreso en el papel que firma el cliente). En altas y traslados actualiza el domicilio; en traslados REEMPLAZA la IP y el router en vez de conservarlos. Exige la IP siempre que el servicio sea de IP fija.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El contrato tiene que decir lo mismo que el papel firmado:
--   SELECT i.numero AS orden, c.numero AS contrato, cl.nombre, c.estado
--     FROM instalaciones i
--     JOIN clientes  cl ON cl.id = i.client_id
--     JOIN contratos c  ON c.client_id = cl.id AND c.estado = 'vigente'
--    WHERE i.estado = 'hecha'
--    ORDER BY i.alta_at DESC
--    LIMIT 10;
--
--   -- Abonados activos que quedaron sin contrato (los de antes de esta migración):
--   SELECT codigo, nombre FROM clientes cl
--    WHERE cl.estado = 'activo'
--      AND NOT EXISTS (SELECT 1 FROM contratos c
--                       WHERE c.client_id = cl.id AND c.estado = 'vigente');
