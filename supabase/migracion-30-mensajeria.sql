-- =============================================================================
-- Migración 30 — A dónde escribirle a cada abonado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 29.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_clientes_ficha` se redefinió
-- en la 37, con más columnas. Reemplazar esa versión por la de acá dejaría a
-- las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Telegram no se maneja por número de teléfono: hace falta el `chat_id`, que se
-- obtiene cuando la persona le escribe primero al bot. Por eso es una columna
-- aparte y no se puede deducir del celular que ya está cargado.
-- =============================================================================

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(40),
    -- Por dónde prefiere que le escriban. El aviso automático usa este canal y
    -- cae a los otros si no está configurado.
    ADD COLUMN IF NOT EXISTS canal_preferido VARCHAR(15) DEFAULT 'whatsapp';

ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_canal_preferido_check;
ALTER TABLE clientes
    ADD CONSTRAINT clientes_canal_preferido_check
    CHECK (canal_preferido IS NULL OR canal_preferido IN ('email', 'whatsapp', 'telegram', 'sms'));

COMMENT ON COLUMN clientes.telegram_chat_id IS
    'Identificador de la conversación con el bot. Se obtiene cuando el abonado le escribe primero: Telegram no deja iniciar la charla al revés.';

-- `v_clientes_ficha` se define con `c.*`: sin rehacerla, las columnas nuevas no
-- llegan a la pantalla. Cuelga de v_saldo_clientes y de ella cuelga
-- v_promesas_a_cortar, así que se sueltan en orden y se rehacen las tres.
DROP VIEW IF EXISTS v_promesas_a_cortar;
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `plan_tipo_impuesto`, la cadena siguió y esta versión quedó
     * atrás: la 37 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya está en su versión de la 37: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_clientes_ficha';
    EXECUTE $vista$
CREATE VIEW v_clientes_ficha WITH (security_invoker = true) AS
SELECT
    c.*,
    p.nombre  AS plan,
    p.precio  AS plan_precio,
    p.bajada_kbps,
    p.subida_kbps,
    r.nombre  AS router,
    o.sn      AS onu_serial,
    o.estado  AS onu_estado,
    o.rx_power_dbm,
    o.causa_caida,
    nap.nombre AS nap,
    ap.nombre  AS conectado_a,
    COALESCE(s.saldo, 0)               AS saldo,
    COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
    s.ultimo_pago,
    ct.id     AS contrato_id,
    ct.numero AS contrato_numero,
    ct.precio_mensual AS contrato_precio,
    CASE
        WHEN c.promo_desde IS NOT NULL AND COALESCE(c.promo_meses, 0) > 0
        THEN (c.promo_desde + MAKE_INTERVAL(months => c.promo_meses))::DATE
    END AS promo_hasta
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

CREATE VIEW v_promesas_a_cortar WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.client_id) p.*
FROM v_promesas_pago p
LEFT JOIN v_saldo_clientes s ON s.client_id = p.client_id
WHERE p.activo_servicio
  AND p.estado_cliente = 'activo'
  AND COALESCE(s.saldo, 0) > 0
  AND ((p.estado = 'activa' AND p.vencida) OR p.estado = 'incumplida')
ORDER BY p.client_id, p.fecha_promesa DESC;

COMMENT ON VIEW v_promesas_a_cortar IS
    'Clientes habilitados por una promesa que vencieron sin pagar o pagaron de menos, siguen activos y deben.';
