-- =============================================================================
-- Migración 157 — La pantalla de transacciones
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Para qué ──
--
-- Cerrar caja. Al final del día alguien tiene que poder decir cuánto entró, por
-- qué punto de cobro, quién lo cobró y cuánto se llevó de comisión — y poder
-- imprimirlo. Hoy eso no se puede: `v_pagos` sirve para buscar UN comprobante,
-- no para cuadrar una jornada.
--
-- ── Lo que agrega ──
--
-- Tres datos que `v_pagos` no trae y que son justamente por los que se filtra
-- cuando se cierra caja:
--
--   OPERADOR   quién registró el cobro. Es la pregunta de "¿esta caja de quién
--              es?", y sin ella no se le puede cuadrar la jornada a nadie.
--   ROUTER     de qué nodo es el abonado.
--   UBICACIÓN  la zona. En un ISP con varios sitios, el cierre es por sitio.
--
-- Más la HORA. `fecha_pago` es solo la fecha —y puede ser retroactiva, porque el
-- cobrador carga hoy lo que recibió ayer—; para cuadrar caja hace falta el
-- momento en que la plata se registró, que es `created_at`.
--
-- ── Por qué una vista nueva y no columnas en v_pagos ──
--
-- Porque `v_pagos` la usan la ficha del abonado, el buscador de comprobantes y la
-- pantalla de cobro, y las tres traen todas las columnas. Agregarle tres joins
-- las haría más lentas a las tres para una pregunta que solo se hace una vez por
-- día.
-- =============================================================================

CREATE OR REPLACE VIEW v_transacciones AS
SELECT
    p.id,
    p.numero,
    p.client_id,
    p.cliente,
    p.identificacion,
    p.numero_factura,
    /**
     * El comprobante legal.
     *
     * Es el del SRI, y es distinto del número de factura del sistema: uno lo
     * lleva el negocio y el otro el organismo. En el cierre de caja se miran los
     * dos porque no todos los cobros generan comprobante fiscal.
     */
    p.numero_comprobante,
    p.n_transaccion,
    /**
     * El tipo del cobro.
     *
     * Sale del documento que saldó. Sin documento —un abono a cuenta, un
     * excedente— se dice así en vez de dejarlo vacío: un tipo en blanco en un
     * cierre de caja hace pensar en un error de carga.
     */
    COALESCE(UPPER(f.tipo), CASE WHEN p.es_excedente THEN 'EXCEDENTE' ELSE 'SIN DOCUMENTO' END) AS tipo,
    p.forma_pago,
    p.fecha_pago,
    -- El momento en que se registró: es lo que cuadra una caja, no la fecha que
    -- alguien escribió en el formulario.
    p.created_at        AS registrado_en,
    p.monto             AS cobrado,
    p.comision,
    p.neto,
    p.cuenta_id,
    p.cuenta,
    p.cuenta_tipo,
    p.anulado,
    p.motivo_anulacion,
    p.es_excedente,
    p.factura_id,
    -- Quién cobró. El nombre completo, que es como se lo nombra en la oficina.
    u.id                AS operador_id,
    NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido)), '') AS operador,
    c.router_id,
    r.nombre            AS router,
    c.zona              AS ubicacion
FROM v_pagos p
LEFT JOIN clientes c          ON c.id = p.client_id
LEFT JOIN routers_mikrotik r  ON r.id = c.router_id
LEFT JOIN facturas f          ON f.id = p.factura_id
LEFT JOIN usuarios_sistema u  ON u.auth_id = p.created_by;

COMMENT ON VIEW v_transacciones IS
    'Todos los cobros con lo que hace falta para cerrar caja: operador, router, ubicación, hora de registro, comisión y neto. Los anulados vienen incluidos y se filtran en la pantalla: esconderlos acá impediría explicar por qué un número no cuadra.';


/**
 * Los totales de un corte de caja.
 *
 * ── Por qué es una función y no una cuenta en la pantalla ──
 *
 * Porque el total tiene que ser el de TODO lo filtrado, no el de la página que se
 * está mirando. Sumar en la pantalla da el total de quince filas y parece
 * correcto: es el error que hace que una caja cuadre con la mitad de la plata.
 *
 * Los parámetros son todos opcionales. En NULL no filtran, que es lo que permite
 * usar la misma función para "todo el mes" y para "lo de Juan en La Maná hoy".
 */
CREATE OR REPLACE FUNCTION totales_transacciones(
    p_desde      DATE    DEFAULT NULL,
    p_hasta      DATE    DEFAULT NULL,
    p_operador   UUID    DEFAULT NULL,
    p_router     UUID    DEFAULT NULL,
    p_ubicacion  TEXT    DEFAULT NULL,
    p_forma_pago TEXT    DEFAULT NULL,
    p_cuenta     UUID    DEFAULT NULL,
    p_anulados   BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    cantidad  BIGINT,
    cobrado   NUMERIC,
    comision  NUMERIC,
    neto      NUMERIC,
    anulados  BIGINT,
    anulado_monto NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COUNT(*) FILTER (WHERE NOT t.anulado),
        COALESCE(SUM(t.cobrado)  FILTER (WHERE NOT t.anulado), 0),
        COALESCE(SUM(t.comision) FILTER (WHERE NOT t.anulado), 0),
        COALESCE(SUM(t.neto)     FILTER (WHERE NOT t.anulado), 0),
        /**
         * Lo anulado se cuenta aparte, siempre.
         *
         * Un cierre que no dice cuánto se anuló no permite explicar por qué la
         * caja tiene menos plata de la que dicen los recibos impresos.
         */
        COUNT(*) FILTER (WHERE t.anulado),
        COALESCE(SUM(t.cobrado) FILTER (WHERE t.anulado), 0)
      FROM v_transacciones t
     WHERE (p_desde      IS NULL OR t.fecha_pago  >= p_desde)
       AND (p_hasta      IS NULL OR t.fecha_pago  <= p_hasta)
       AND (p_operador   IS NULL OR t.operador_id  = p_operador)
       AND (p_router     IS NULL OR t.router_id    = p_router)
       AND (p_ubicacion  IS NULL OR t.ubicacion    = p_ubicacion)
       AND (p_forma_pago IS NULL OR t.forma_pago   = p_forma_pago)
       AND (p_cuenta     IS NULL OR t.cuenta_id    = p_cuenta)
       AND (p_anulados OR NOT t.anulado);
$$;

COMMENT ON FUNCTION totales_transacciones IS
    'Cobrado, comisión y neto de un corte de caja, sobre TODO lo filtrado y no sobre la página visible. Lo anulado se informa aparte.';


/**
 * Las ubicaciones que existen de verdad.
 *
 * Para que el filtro ofrezca las zonas que tienen cobros y no una lista escrita a
 * mano que se desactualiza el día que alguien crea una zona nueva.
 */
CREATE OR REPLACE VIEW v_ubicaciones_con_cobros AS
SELECT DISTINCT c.zona AS ubicacion
  FROM pagos p
  JOIN clientes c ON c.id = p.client_id
 WHERE c.zona IS NOT NULL AND c.zona <> ''
 ORDER BY 1;

COMMENT ON VIEW v_ubicaciones_con_cobros IS
    'Zonas que tienen al menos un cobro. Alimenta el filtro de ubicación de la pantalla de transacciones.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El cierre de caja de hoy:
--   SELECT * FROM totales_transacciones(CURRENT_DATE, CURRENT_DATE);
--
--   -- Y el detalle, como lo muestra la pantalla:
--   SELECT numero, cliente, numero_factura, n_transaccion, tipo,
--          registrado_en, cobrado, operador, router, ubicacion
--     FROM v_transacciones
--    WHERE fecha_pago = CURRENT_DATE
--    ORDER BY registrado_en DESC;
