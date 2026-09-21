-- =============================================================================
-- Migración 96 — La IP fija no se muda con el abonado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El problema, comprobado contra esta base ──
--
-- Un abonado con IP fija en el sector viejo, un traslado, y el técnico cierra la
-- orden sin cargar dirección nueva:
--
--   Cerrar la orden SIN IP nueva: ACEPTADO
--   La ficha quedó con: ip = 172.16.5.20   ← la IP del sector VIEJO
--
-- Esa dirección pertenece a la subred del otro sector. El abonado no navega, y
-- el diagnóstico no se parece en nada a la causa: "se mudó y no anda" no sugiere
-- "tiene una IP de otra subred".
--
-- Y hay algo peor. El desarme del origen devuelve esa misma IP al pool —tiene
-- que hacerlo, el abonado ya no está ahí—, así que queda libre para el próximo
-- alta mientras la ficha del que se mudó la sigue mostrando como suya. Dos
-- abonados con la misma dirección, con meses de diferencia entre la causa y el
-- síntoma.
--
-- ── Por qué pasaba ──
--
-- La validación pedía la IP solo cuando la conexión NO era PPPoE:
--
--   IF i.tipo_conexion <> 'pppoe' AND i.tipo_ip = 'fija' AND i.ip IS NULL
--
-- Pero PPPoE con IP fija —la dirección va en el secret del router— es la forma
-- más común de dar una IP fija en un ISP. Justo la que quedaba sin verificar.
--
-- Y aunque la orden trajera la IP nueva, el UPDATE hacía `ip = COALESCE(i.ip,
-- ip)`: sin IP en la orden, gana la vieja. Para un traslado eso está al revés.
-- Una dirección de otra subred es PEOR que ninguna, porque parece configurada.
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
    'Cierra la instalación y la convierte en abonado activo. En altas y traslados actualiza el domicilio; en traslados REEMPLAZA la IP y el router en vez de conservarlos, porque los del domicilio anterior son de otra subred. Exige la IP siempre que el servicio sea de IP fija.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Un traslado de un abonado con IP fija, cerrado sin IP nueva:
--   SELECT finalizar_alta_instalacion('<orden>');
--   -- ERROR: Falta la IP fija del abonado...
--
--   -- Y con la IP del sector nuevo cargada, la ficha queda con ESA:
--   UPDATE instalaciones SET ip = '10.20.0.55', router_id = '<router nuevo>'
--    WHERE id = '<orden>';
--   SELECT finalizar_alta_instalacion('<orden>');
--   SELECT ip, router_id FROM clientes WHERE id = '<cliente>';
