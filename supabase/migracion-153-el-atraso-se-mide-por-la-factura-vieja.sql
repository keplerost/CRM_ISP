-- =============================================================================
-- Migración 153 — El atraso se mide por la factura más vieja, no por el último pago
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El agujero que esto tapa ──
--
-- El corte por mora decidía con `meses_sin_pago`, que mide desde el ÚLTIMO PAGO.
-- Suena razonable y no lo es: cualquier abono, del monto que sea, reinicia el
-- reloj un mes entero.
--
-- Medido contra la base de verdad, con un abonado que debía tres meses y $60:
--
--   debiendo tres meses         deuda $60.00 · SE CORTA (3 meses)
--   después de abonar $1        deuda $59.00 · no se corta
--   el abono fue hace 40 días   deuda $59.00 · SE CORTA (1 mes)
--
-- Un dólar compra un mes de servicio. Y no hace falta mala fe para que pase: el
-- abonado que cada tanto deja algo a cuenta —cosa que en la práctica hacen
-- muchos— queda fuera del corte para siempre mientras la deuda crece.
--
-- ── La medida correcta ──
--
-- El atraso es la edad de la factura más vieja que sigue sin pagarse. Eso no lo
-- mueve un abono parcial: mientras esa factura no se cubra, el atraso sigue
-- corriendo. Cubrirla sí lo mueve, y ahí corresponde: pagar lo más viejo primero
-- es exactamente lo que hace la imputación de pagos del sistema.
--
-- ── Qué NO se toca ──
--
-- `meses_sin_pago` se queda como está. La usan comisiones, cartera y las órdenes
-- de retiro, y para ellas SÍ es la pregunta correcta: "hace cuánto que este
-- abonado no aporta plata". Cambiarla arreglaría el corte y rompería los cobros
-- de tres vendedores.
--
-- Las dos convivan, y las dos se muestran en la vista para poder comparar.
--
-- ── Consecuencia que hay que saber ──
--
-- Un abono parcial ya NO reconecta. Antes reconectaba solo, sin que nadie lo
-- decidiera; ahora el que quiere devolverle el servicio a cambio de una parte
-- tiene que registrarle una promesa de pago, que es una decisión con nombre,
-- fecha y responsable. Si la promesa se incumple, el corte de promesas lo agarra.
-- =============================================================================

/**
 * Meses de atraso: la edad de la factura más vieja sin cubrir.
 *
 * Cero cuando no debe nada, y también cuando lo que debe todavía no venció —
 * la factura emitida ayer no es un atraso.
 */
CREATE OR REPLACE FUNCTION meses_de_atraso(p_cliente UUID, p_hasta DATE DEFAULT CURRENT_DATE)
RETURNS INT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_vence DATE;
    v_edad  INTERVAL;
BEGIN
    /**
     * La más vieja de las que tienen saldo.
     *
     * `v_facturas_por_cobrar` ya excluye anuladas y pagadas, así que acá no hay
     * que repetir esas condiciones: si mañana se agrega otra razón para no
     * cobrar una factura, esta función la respeta sin que nadie la edite.
     *
     * El COALESCE con la emisión es para la factura cargada a mano sin
     * vencimiento: sin él, una sola factura así haría que el abonado no tenga
     * atraso nunca.
     */
    SELECT MIN(COALESCE(f.fecha_vencimiento, f.fecha_emision))::DATE
      INTO v_vence
      FROM v_facturas_por_cobrar f
     WHERE f.client_id = p_cliente;

    IF v_vence IS NULL OR v_vence >= p_hasta THEN
        RETURN 0;
    END IF;

    v_edad := AGE(p_hasta, v_vence);
    RETURN (EXTRACT(YEAR FROM v_edad) * 12 + EXTRACT(MONTH FROM v_edad))::INT;
END $$;

COMMENT ON FUNCTION meses_de_atraso IS
    'Meses cumplidos desde que venció la factura más vieja que sigue debiendo. No la mueve un abono parcial: para eso está meses_sin_pago, que mide otra cosa.';


/**
 * Y los días, que es como se habla del atraso en la oficina.
 *
 * Nadie dice "tiene un mes y medio": dice "está a cuarenta y cinco días". Se
 * expone en las vistas para que la pantalla pueda mostrarlo sin recalcularlo.
 */
CREATE OR REPLACE FUNCTION dias_de_atraso(p_cliente UUID, p_hasta DATE DEFAULT CURRENT_DATE)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT GREATEST(
        0,
        COALESCE(
            (p_hasta - MIN(COALESCE(f.fecha_vencimiento, f.fecha_emision))::DATE),
            0
        )
    )
      FROM v_facturas_por_cobrar f
     WHERE f.client_id = p_cliente;
$$;

COMMENT ON FUNCTION dias_de_atraso IS
    'Días desde que venció la factura más vieja sin pagar. Cero si no debe nada o si lo que debe no venció.';


-- =============================================================================
-- Las dos vistas del corte, con la medida corregida
-- =============================================================================
-- Se reemplazan con DROP porque hay que AGREGAR columnas en el medio y
-- CREATE OR REPLACE no lo permite. El orden importa: primero la que depende.
--
-- ── La guarda ──
--
-- La 154 cambió la REGLA del corte: pasó de un umbral en meses a la fecha de
-- corte de cada abonado. Reejecutar esta migración no daría ningún error y
-- devolvería la regla vieja, con la que el que no paga el 5 se corta el 5 del mes
-- siguiente. Ese es el peor error posible en un archivo: el que no avisa.

DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'v_clientes_a_cortar_por_mora'
           AND column_name = 'fecha_corte'
    ) THEN
        RAISE NOTICE 'Las vistas del corte ya están en su versión de la 154: no se tocan.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_reconexiones_a_procesar';
    EXECUTE 'DROP VIEW IF EXISTS v_clientes_a_reconectar';
    EXECUTE 'DROP VIEW IF EXISTS v_clientes_a_cortar_por_mora';

/**
 * A quién le toca el corte hoy.
 */
    EXECUTE $vista$
CREATE VIEW v_clientes_a_cortar_por_mora AS
SELECT
    c.id            AS cliente_id,
    c.codigo,
    c.nombre,
    c.estado,
    c.ip,
    c.router_id,
    c.cortar_tras_meses,
    meses_de_atraso(c.id) AS meses_de_atraso,
    dias_de_atraso(c.id)  AS dias_de_atraso,
    /**
     * Se sigue mostrando, aunque ya no decida nada.
     *
     * Es lo que permite ver de un vistazo el caso que motivó esta migración: el
     * que dejó algo a cuenta hace poco y aun así está atrasado meses.
     */
    meses_sin_pago(c.id)  AS meses_sin_pago,
    COALESCE(s.saldo, 0)  AS saldo,
    s.ultimo_pago,
    (SELECT MIN(f.fecha_vencimiento)
       FROM v_facturas_por_cobrar f WHERE f.client_id = c.id) AS vence_desde
FROM clientes c
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.estado = 'activo'
  AND c.cortar_tras_meses > 0
  AND NOT c.excluir_firewall
  AND c.ip IS NOT NULL AND c.ip <> ''
  AND COALESCE(s.saldo, 0) > 0
  -- Acá estaba el error: era meses_sin_pago(c.id).
  AND meses_de_atraso(c.id) >= c.cortar_tras_meses
  /**
   * Y que no tenga una promesa vigente.
   *
   * Se le dio un plazo y todavía está dentro. Cortarlo ahí es no haber cumplido
   * nuestra parte, y es la clase de cosa que un abonado no olvida.
   *
   * La promesa VENCIDA no protege: de esa se encarga el corte de promesas, que
   * es más específico y llega antes.
   */
  AND NOT EXISTS (
      SELECT 1 FROM promesas_pago p
       WHERE p.client_id = c.id
         AND p.estado = 'activa'
         AND p.fecha_promesa >= CURRENT_DATE
  )
$vista$;

    EXECUTE $comentario$
COMMENT ON VIEW v_clientes_a_cortar_por_mora IS
    'Abonados activos cuya factura más vieja pasó el umbral de meses. Ya excluye promesas vigentes, exclusiones de firewall, servicio gratis y a los que no tienen IP.'
$comentario$;

/**
 * Los que están cortados y ya no deberían estarlo.
 *
 * Solo lo que cortó esta tarea: un corte pedido por el abonado, por abuso o por
 * decisión administrativa no se deshace con un automatismo.
 */
    EXECUTE $vista$
CREATE VIEW v_clientes_a_reconectar AS
SELECT DISTINCT ON (c.id)
    c.id            AS cliente_id,
    c.codigo,
    c.nombre,
    c.ip,
    c.router_id,
    b.id            AS bloqueo_id,
    b.routeros_id,
    b.lista,
    COALESCE(s.saldo, 0)  AS saldo,
    meses_de_atraso(c.id) AS meses_de_atraso,
    meses_sin_pago(c.id)  AS meses_sin_pago,
    c.cortar_tras_meses
FROM clientes c
JOIN firewall_bloqueos b
  ON b.cliente_id = c.id
 AND b.activo
 AND b.comentario LIKE 'Corte por mora%'
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.estado <> 'baja'
  /**
   * La condición del corte, al revés. Tiene que ser la misma medida: con una
   * distinta, un abonado podría cumplir las dos y quedar cortándose y
   * reconectándose en cada corrida.
   */
  AND (
      COALESCE(s.saldo, 0) <= 0
      OR meses_de_atraso(c.id) < c.cortar_tras_meses
      -- O consiguió una promesa de pago vigente: eso lo devuelve al servicio.
      OR EXISTS (
          SELECT 1 FROM promesas_pago p
           WHERE p.client_id = c.id
             AND p.estado = 'activa'
             AND p.fecha_promesa >= CURRENT_DATE
      )
  )
ORDER BY c.id, b.created_at DESC
$vista$;

    EXECUTE $comentario$
COMMENT ON VIEW v_clientes_a_reconectar IS
    'Cortados por mora que ya no deberían estarlo: cubrieron la factura vieja, quedaron dentro de su umbral, o consiguieron una promesa. Solo los que cortó esta tarea.'
$comentario$;

/**
 * Los pedidos de reconexión que corresponde atender ahora.
 *
 * Se recrea igual que en la 134: cambió la vista de la que se cuelga, no esta.
 */
    EXECUTE $vista$
CREATE VIEW v_reconexiones_a_procesar AS
SELECT
    p.id            AS pedido_id,
    p.motivo,
    p.creado_en,
    r.cliente_id,
    r.nombre,
    r.ip,
    r.router_id,
    r.bloqueo_id,
    r.routeros_id,
    r.lista,
    r.saldo
FROM reconexiones_pendientes p
JOIN v_clientes_a_reconectar r ON r.cliente_id = p.cliente_id
WHERE p.procesado_en IS NULL
ORDER BY p.creado_en
$vista$;

    EXECUTE $comentario$
COMMENT ON VIEW v_reconexiones_a_procesar IS
    'Pedidos de reconexión que corresponde atender ahora. Lo que aparece acá se reconecta sin más preguntas.'
$comentario$;
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El caso del agujero: atrasado meses, pero con un abono reciente.
--   SELECT nombre, dias_de_atraso, meses_de_atraso, meses_sin_pago, saldo
--     FROM v_clientes_a_cortar_por_mora
--    ORDER BY dias_de_atraso DESC;
--
--   -- Y quiénes eran los que se salvaban con el criterio viejo:
--   SELECT c.nombre, meses_de_atraso(c.id) AS atraso, meses_sin_pago(c.id) AS sin_pago
--     FROM clientes c
--    WHERE c.estado = 'activo'
--      AND meses_de_atraso(c.id) >= c.cortar_tras_meses
--      AND meses_sin_pago(c.id)  <  c.cortar_tras_meses;
