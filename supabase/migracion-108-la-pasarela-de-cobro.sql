-- =============================================================================
-- Migración 108 — Con qué pasarela paga cada abonado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué falta y por qué ──
--
-- `clientes.codigo_pago` guarda el código con el que el abonado paga, pero no
-- DÓNDE lo paga. Y el código solo no alcanza: el mismo número no significa lo
-- mismo en Cuentadigital que en Cobro Digital, y quien concilia los cobros del
-- mes necesita saber contra qué reporte cruzarlo.
--
-- Se agrega ahora, antes de que exista la integración, para que el día que se
-- conecte una pasarela el dato ya esté cargado y no haya que salir a
-- preguntárselo a cada abonado.
--
-- ── Por qué texto libre y no una lista cerrada ──
--
-- Porque las pasarelas cambian más rápido que el esquema: aparece una nueva, se
-- cae otra, se agrega un banco. Una restricción CHECK obligaría a una migración
-- cada vez que el ISP firma con alguien, y el día que eso pase el dato se va a
-- cargar igual, mal, en el campo de notas.
--
-- La app ofrece las de siempre en una lista desplegable, así que en la práctica
-- se escribe una de esas — pero nada impide poner la que haga falta.
-- =============================================================================

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS pasarela VARCHAR(40);

COMMENT ON COLUMN clientes.pasarela IS
    'Dónde paga el abonado: Cuentadigital, Cobro Digital, PayPhone, Datafast, ventanilla… Va junto a codigo_pago, que es el número con el que se lo identifica ahí. Texto libre: las pasarelas cambian más seguido que el esquema.';

CREATE INDEX IF NOT EXISTS idx_clientes_pasarela ON clientes (pasarela) WHERE pasarela IS NOT NULL;


-- =============================================================================
-- Que la ficha la vea
-- =============================================================================
-- Mismo procedimiento que la 107 y por los mismos dos motivos: la lista de
-- columnas va enumerada para que agregar una columna a `clientes` no la publique
-- sin querer, y se usa CREATE OR REPLACE —con lo nuevo AL FINAL— porque de esta
-- vista cuelgan la bandeja de cobranza y la cartera en riesgo, y un DROP se las
-- llevaría puestas.
--
-- ── Y el mismo guardián que la 107 ──
--
-- Porque una migración posterior le agrega más columnas a esta vista —la 121 le
-- sumó `ultimo_pago_externo`— y volver a correr esta se las llevaría:
-- `CREATE OR REPLACE VIEW` sabe agregar columnas al final, pero no sacarlas, así
-- que ni siquiera falla limpio: aborta con "cannot drop columns from view" y
-- deja la migración a medias.
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'ultimo_pago_externo'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya tiene una versión posterior a la 108: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS
SELECT
    c.id,
    c.nombre,
    c.router_id,
    c.onu_id,
    c.plan_id,
    c.ip,
    c.mac_address,
    c.usuario_ppp,
    c.estado,
    c.origen,
    c.velocidad_cruda,
    c.comentario,
    c.created_at,
    c.updated_at,
    c.tipo_identificacion,
    c.identificacion,
    c.email,
    c.telefono,
    c.direccion,
    c.precio_mensual,
    c.dia_facturacion,
    c.telefono_movil,
    c.codigo_pago,
    c.clave_ppp,
    c.latitud,
    c.longitud,
    c.notas,
    c.nap_id,
    c.puerto_nap,
    c.conectado_a_id,
    c.ip_administracion,
    c.tipo_antena,
    c.tipo_conexion,
    c.tipo_ip,
    c.red_ipv4,
    c.ipv6,
    c.ipv6_duid,
    c.rutas,
    c.descripcion_servicio,
    c.excluir_firewall,
    c.fecha_instalacion,
    c.factura_electronica,
    c.modalidad_pago,
    c.dia_generar_factura,
    c.tipo_impuesto,
    c.dias_gracia,
    c.aplicar_corte,
    c.descuento_tipo,
    c.descuento_porcentaje,
    c.descuento_documento,
    c.promo_porcentaje,
    c.promo_meses,
    c.promo_desde,
    c.telegram_chat_id,
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
    -- Lo que agregó la 107.
    c.codigo,
    c.zona,
    c.estado_desde,
    c.portal_clave,
    c.numero_orden,
    -- Y lo de esta.
    c.pasarela,
    -- La fecha de la baja: es la que contesta "¿cuándo se retiró?" sin tener
    -- que deducirla del estado. La escribe `dar_de_baja_cliente` (la 100).
    c.baja_en
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
--   SELECT codigo, nombre, pasarela, codigo_pago, baja_en
--     FROM v_clientes_ficha ORDER BY codigo LIMIT 5;
--
--   -- Y con qué pasarelas se está cobrando hoy:
--   SELECT COALESCE(pasarela, '— sin cargar —') AS pasarela, COUNT(*)
--     FROM clientes WHERE estado <> 'baja' GROUP BY 1 ORDER BY 2 DESC;
