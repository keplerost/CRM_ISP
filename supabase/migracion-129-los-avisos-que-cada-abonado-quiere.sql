-- =============================================================================
-- Migración 129 — Los avisos que cada abonado quiere recibir
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Hasta acá los avisos de pago eran una decisión del ISP para todos por igual:
-- los mismos días, por los mismos canales. En la práctica no es así. Hay
-- abonados a los que un mensaje de cobranza les molesta, hay quien pide que le
-- escriban solo por WhatsApp, y hay quien quiere el último aviso un día antes
-- del corte y no cinco días después de vencer.
--
-- Un ISP que no puede respetar eso termina con abonados pidiendo que los saquen
-- de todo, y ahí pierde también el aviso que sí servía.
--
-- ── Lo que estas opciones NO cambian ──
--
-- El corte. Apagar los avisos es dejar de MOLESTAR, no dejar de cobrar: el
-- abonado que no paga se corta igual, solo que sin recordatorios previos. Vale
-- la pena tenerlo claro antes de apagárselos a alguien, porque el corte sin
-- aviso previo genera exactamente la llamada que los avisos evitan.
-- =============================================================================

ALTER TABLE clientes
    /**
     * El interruptor general de este abonado.
     *
     * Apagado, no se le manda NINGÚN aviso automático. Es lo que se usa con el
     * que pidió que no lo molesten, y con el institucional que tiene su propio
     * circuito administrativo.
     */
    ADD COLUMN IF NOT EXISTS avisos_activos BOOLEAN NOT NULL DEFAULT TRUE,

    /**
     * Por qué canales acepta que le escriban.
     *
     * NULL significa "por los que se pueda", que es como venía funcionando: se
     * usa el canal preferido y se cae a los otros. Una lista lo restringe a
     * esos, y una lista vacía es lo mismo que apagar el interruptor general —
     * pero se distingue, porque no es lo mismo "no quiero avisos" que "quiero
     * solo por WhatsApp y todavía no me cargaron el número".
     */
    ADD COLUMN IF NOT EXISTS avisos_canales TEXT[],

    /**
     * Si se le muestra la pantalla de aviso o de corte en el navegador.
     *
     * Apagado, el abonado cortado NO ve la página: ve el error de conexión que
     * vería sin nada. Se corta igual — esto solo decide si se le explica por
     * qué.
     */
    ADD COLUMN IF NOT EXISTS avisos_pantalla BOOLEAN NOT NULL DEFAULT TRUE,

    /**
     * Cuándo recibe cada aviso, si difiere del general.
     *
     * En días respecto del vencimiento: negativo es antes, positivo después.
     * NULL usa el valor general. Es lo que permite decirle a un abonado "el
     * último aviso, un día antes del corte" sin cambiárselo a todos.
     */
    ADD COLUMN IF NOT EXISTS aviso_dias_1 INT,
    ADD COLUMN IF NOT EXISTS aviso_dias_2 INT,
    ADD COLUMN IF NOT EXISTS aviso_dias_3 INT;

COMMENT ON COLUMN clientes.avisos_activos IS
    'Interruptor general de avisos automáticos de este abonado. Apagado no impide el corte: solo deja de avisarle.';

COMMENT ON COLUMN clientes.avisos_canales IS
    'Canales que acepta. NULL = los que se pueda, empezando por el preferido.';


-- =============================================================================
-- Quién recibe cuál, respetando lo que pidió cada uno
-- =============================================================================
/**
 * Se agregan columnas AL FINAL y no se reordena ninguna.
 *
 * `CREATE OR REPLACE VIEW` sabe agregar columnas al final pero no renombrar ni
 * mover las que ya están. Respetando el orden de la 128 esta migración no
 * necesita soltar la vista, y la 128 no necesita un guardián.
 */
CREATE OR REPLACE VIEW v_avisos_pago_pendientes WITH (security_invoker = true) AS
WITH reglas AS (
    SELECT dias_aviso_1, dias_aviso_2, dias_aviso_3 FROM config_avisos_pago WHERE id = 1
),
candidatas AS (
    SELECT
        f.id                                        AS factura_id,
        f.client_id,
        f.numero,
        f.fecha_vencimiento,
        f.saldo,
        f.importe_total,
        f.concepto,
        (CURRENT_DATE - f.fecha_vencimiento)        AS dias,
        /**
         * El día de cada aviso: el del abonado si lo tiene, si no el general.
         *
         * La cuenta se hace por abonado y no una vez para todos, que es de
         * donde sale poder decirle a uno "avisame un día antes" sin tocarle
         * nada al resto.
         */
        CASE
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= COALESCE(cl.aviso_dias_3, r.dias_aviso_3) THEN 3
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= COALESCE(cl.aviso_dias_2, r.dias_aviso_2) THEN 2
            WHEN (CURRENT_DATE - f.fecha_vencimiento) >= COALESCE(cl.aviso_dias_1, r.dias_aviso_1) THEN 1
        END                                         AS nivel
    FROM v_facturas_por_cobrar f
    JOIN clientes cl ON cl.id = f.client_id
    CROSS JOIN reglas r
    WHERE f.fecha_vencimiento IS NOT NULL
      -- El que pidió que no lo molesten no entra ni al cálculo.
      AND cl.avisos_activos
)
SELECT DISTINCT ON (c.id)
    c.id            AS cliente_id,
    c.nombre,
    c.estado,
    c.canal_preferido,
    c.email,
    c.telefono_movil,
    c.telefono,
    c.telegram_chat_id,
    can.nivel,
    can.factura_id,
    can.numero      AS factura_numero,
    can.fecha_vencimiento,
    can.dias,
    can.saldo,
    can.importe_total,
    can.concepto,
    largo.id        AS plantilla_email_id,
    corto.id        AS plantilla_corta_id,
    COALESCE(largo.id, corto.id) AS plantilla_id,
    can.nivel       AS plantilla_nivel,
    -- Lo nuevo de la 129, al final para no mover nada de lugar.
    c.avisos_canales
FROM candidatas can
JOIN clientes c ON c.id = can.client_id
LEFT JOIN plantillas_mensaje largo
       ON largo.clave = 'mail_aviso_pago_' || can.nivel AND largo.activa
LEFT JOIN plantillas_mensaje corto
       ON corto.clave = 'sms_aviso_pago_'  || can.nivel AND corto.activa
WHERE can.nivel IS NOT NULL
  AND (largo.id IS NOT NULL OR corto.id IS NOT NULL)
  AND c.estado <> 'baja'
  AND NOT EXISTS (
      SELECT 1
        FROM comunicaciones m
        JOIN plantillas_mensaje pm ON pm.id = m.plantilla_id
       WHERE m.factura_id = can.factura_id
         AND m.estado <> 'fallido'
         AND pm.clave IN ('mail_aviso_pago_' || can.nivel, 'sms_aviso_pago_' || can.nivel)
  )
ORDER BY c.id, can.nivel DESC, can.fecha_vencimiento;


-- =============================================================================
-- Y la página del corte, que también es un aviso
-- =============================================================================
/**
 * Se agrega `avisos_pantalla` al final, por lo mismo que arriba.
 *
 * El servidor de la página lo lee para decidir si le muestra el aviso o lo deja
 * con el error de conexión que vería sin nada.
 */
DO $guarda$
BEGIN
    -- La 130 le agrega el aviso previo. Reejecutar esto se lo llevaría, y no
    -- falla limpio: aborta con "cannot drop columns from view".
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_corte_abonado'
           AND column_name = 'en_aviso_previo'
    ) THEN
        RAISE NOTICE 'v_corte_abonado ya tiene una versión posterior a la 129: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_corte_abonado AS
SELECT
    c.id,
    c.codigo,
    c.nombre,
    c.ip,
    c.router_id,
    c.estado,
    c.estado_desde,
    c.telefono_movil,
    p.nombre                            AS plan,
    COALESCE(s.saldo, 0)                AS saldo,
    COALESCE(s.facturas_pendientes, 0)  AS facturas_pendientes,
    s.ultimo_pago,
    c.avisos_pantalla
FROM clientes c
LEFT JOIN planes_velocidad p ON p.id = c.plan_id
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.ip IS NOT NULL AND c.ip <> ''
    $vista$;
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- A este abonado, el último aviso un día antes del corte:
--   UPDATE clientes SET aviso_dias_3 = -1 WHERE codigo = 42;
--
--   -- Y a este, nada de nada:
--   UPDATE clientes SET avisos_activos = FALSE WHERE codigo = 17;
--
--   -- A quién le llegaría hoy, ya con las preferencias aplicadas:
--   SELECT nombre, nivel, dias, avisos_canales FROM v_avisos_pago_pendientes;
