-- =============================================================================
-- Migración 121 — El último pago que viene del sistema anterior
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- `meses_sin_pago()` mira los pagos registrados acá. Un abonado recién migrado
-- no tiene ninguno, así que la función cae a su fecha de instalación — y un
-- cliente instalado hace dos años, al día. da 24.
--
-- La cartera lee ese número. Con el umbral en 3 meses, la primera noche después
-- de migrar el padrón se abre una orden de retiro para CADA abonado antiguo, y
-- a la mañana siguiente hay técnicos yendo a levantar equipos de casas que
-- están al día. Está medido:
--
--     meses_sin_pago de un abonado migrado sin historial: 24
--     generar_retiros_equipo() -> {"creadas": 1}
--
--     con el último pago migrado:                          0
--     generar_retiros_equipo() -> {"creadas": 0}
--
-- ── Por qué una columna y no un pago falso ──
--
-- Lo obvio sería insertar en `pagos` una fila con la fecha del último pago del
-- sistema viejo. No se hace, y es a propósito: eso es plata que este sistema
-- nunca cobró. Aparecería en el cierre de caja, en los reportes de recaudación,
-- en la comisión del vendedor y en el estado de cuenta del abonado, con un
-- monto inventado y sin recibo que lo respalde. Se estaría arreglando un
-- problema de cartera ensuciando la contabilidad.
--
-- Lo que se guarda es lo único que se sabe de verdad: la FECHA en que ese
-- abonado pagó por última vez en el otro sistema. No es un cobro, es un dato de
-- referencia — y por eso vive en la ficha del cliente y no en los pagos.
-- =============================================================================

ALTER TABLE clientes
    -- La fecha del último pago según el sistema del que se migró. No es un
    -- cobro de este sistema: es el punto de partida para no tratar a un
    -- abonado antiguo como si nunca hubiera pagado.
    ADD COLUMN IF NOT EXISTS ultimo_pago_externo DATE;

COMMENT ON COLUMN clientes.ultimo_pago_externo IS
    'Fecha del último pago en el sistema anterior. Referencia para la cartera, no es un pago: no suma a caja ni a comisiones.';


-- =============================================================================
-- La cuenta de meses, ahora mirando también lo que vino de afuera
-- =============================================================================
/**
 * Meses cumplidos desde el último pago.
 *
 * El orden importa y es el que se lee:
 *
 *   1. Un pago cobrado ACÁ. Es el único hecho contable, y manda siempre. En
 *      cuanto el abonado migrado paga una vez, lo de afuera deja de usarse.
 *
 *   2. El último pago del sistema anterior. No es plata nuestra, pero es
 *      información cierta sobre el abonado y evita tratarlo como moroso el día
 *      que se lo migra.
 *
 *   3. Desde que se activó. Para el abonado nuevo que todavía no pagó nunca,
 *      que es el caso para el que se escribió esto originalmente.
 */
CREATE OR REPLACE FUNCTION meses_sin_pago(p_cliente UUID, p_hasta DATE DEFAULT CURRENT_DATE)
RETURNS INT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ref DATE;
    v_edad INTERVAL;
BEGIN
    SELECT MAX(pg.fecha_pago)::DATE INTO v_ref
      FROM pagos pg
     WHERE pg.client_id = p_cliente
       AND NOT pg.anulado;

    IF v_ref IS NULL THEN
        SELECT COALESCE(
                   c.ultimo_pago_externo,
                   c.activado_en::DATE,
                   c.fecha_instalacion::DATE,
                   c.created_at::DATE
               )
          INTO v_ref
          FROM clientes c WHERE c.id = p_cliente;
    END IF;

    IF v_ref IS NULL OR v_ref >= p_hasta THEN
        RETURN 0;
    END IF;

    v_edad := AGE(p_hasta, v_ref);
    RETURN (EXTRACT(YEAR FROM v_edad) * 12 + EXTRACT(MONTH FROM v_edad))::INT;
END $$;

COMMENT ON FUNCTION meses_sin_pago IS
    'Meses cumplidos desde el último pago no anulado. Si nunca pagó acá, desde el último pago del sistema anterior; y si tampoco, desde que se activó.';


-- =============================================================================
-- La ficha, para poder verlo
-- =============================================================================
/**
 * Se agrega a la vista porque es un dato que hay que poder mirar: cuando un
 * abonado migrado aparece en la cartera, lo primero que se pregunta es desde
 * cuándo no paga, y la respuesta está acá. Al lado de `ultimo_pago`, que es el
 * de este sistema — juntas se lee de un vistazo si ya pagó con nosotros.
 *
 * La lista de columnas va explícita y no `c.*`, porque `clientes` tiene
 * `portal_clave_hash` y un `SELECT *` lo publicaría en la vista.
 *
 * La columna nueva va AL FINAL: `CREATE OR REPLACE VIEW` sabe agregar columnas
 * al final, pero no reordenarlas ni sacarlas.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'ultimo_pago_externo'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone ultimo_pago_externo: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
        CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS
        SELECT
            c.id, c.nombre, c.router_id, c.onu_id, c.plan_id, c.ip, c.mac_address,
            c.usuario_ppp, c.estado, c.origen, c.velocidad_cruda, c.comentario,
            c.created_at, c.updated_at, c.tipo_identificacion, c.identificacion,
            c.email, c.telefono, c.direccion, c.precio_mensual, c.dia_facturacion,
            c.telefono_movil, c.codigo_pago, c.clave_ppp, c.latitud, c.longitud,
            c.notas, c.nap_id, c.puerto_nap, c.conectado_a_id, c.ip_administracion,
            c.tipo_antena, c.tipo_conexion, c.tipo_ip, c.red_ipv4, c.ipv6,
            c.ipv6_duid, c.rutas, c.descripcion_servicio, c.excluir_firewall,
            c.fecha_instalacion, c.factura_electronica, c.modalidad_pago,
            c.dia_generar_factura, c.tipo_impuesto, c.dias_gracia, c.aplicar_corte,
            c.descuento_tipo, c.descuento_porcentaje, c.descuento_documento,
            c.promo_porcentaje, c.promo_meses, c.promo_desde, c.telegram_chat_id,
            c.canal_preferido,
            p.nombre  AS plan,
            p.precio  AS plan_precio,
            p.bajada_kbps,
            p.subida_kbps,
            p.categoria      AS plan_categoria,
            p.tipo_impuesto  AS plan_tipo_impuesto,
            p.iva_porcentaje AS plan_iva_porcentaje,
            p.perfil_ppp     AS plan_perfil_ppp,
            r.nombre  AS router,
            o.sn      AS onu_serial,
            o.estado  AS onu_estado,
            o.rx_power_dbm,
            nap.nombre AS nap,
            ap.nombre  AS conectado_a,
            COALESCE(s.saldo, 0)               AS saldo,
            COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
            s.ultimo_pago,
            ct.id     AS contrato_id,
            ct.numero AS contrato_numero,
            ct.precio_mensual AS contrato_precio,
            c.codigo, c.zona, c.estado_desde, c.portal_clave, c.numero_orden,
            c.pasarela,
            c.baja_en,
            -- Lo de esta migración, al final.
            c.ultimo_pago_externo
        FROM clientes c
        LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
        LEFT JOIN routers_mikrotik r   ON r.id = c.router_id
        LEFT JOIN onus o               ON o.id = c.onu_id
        LEFT JOIN puntos_red nap       ON nap.id = c.nap_id
        LEFT JOIN puntos_red ap        ON ap.id = c.conectado_a_id
        LEFT JOIN v_saldo_clientes s   ON s.client_id = c.id
        LEFT JOIN contratos ct         ON ct.client_id = c.id AND ct.estado = 'vigente'
    $vista$;
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Un abonado migrado que pagó el mes pasado NO tiene que estar en cartera:
--   SELECT nombre, fecha_instalacion, ultimo_pago_externo, meses_sin_pago(id)
--     FROM clientes WHERE ultimo_pago_externo IS NOT NULL
--    ORDER BY meses_sin_pago(id) DESC LIMIT 20;
--
--   -- Y cuántos quedarían en cartera si se migrara sin esa fecha:
--   SELECT COUNT(*) FROM clientes
--    WHERE estado <> 'baja' AND ultimo_pago_externo IS NULL
--      AND fecha_instalacion < CURRENT_DATE - INTERVAL '3 months';
