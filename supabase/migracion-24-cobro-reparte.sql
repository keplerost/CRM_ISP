-- =============================================================================
-- Migración 24 — Un cobro salda todas las facturas que alcance
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 23.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_pagos_por_facturar` se
-- redefinió en la 25, con más columnas. Reemplazar esa versión por la de acá
-- dejaría a las pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- El abonado llega al mostrador y paga lo que debe: el mes atrasado, el del mes
-- corriente, los cables que se llevó la semana pasada y el cambio de clave. Es
-- un solo billete, pero son cuatro facturas.
--
-- Hasta ahora el cobro se imputaba a UNA factura y el resto quedaba a favor,
-- esperando que alguien apretara "Aplicarlo ahora". Si nadie lo hacía, el
-- abonado figuraba debiendo el resto y el corte automático lo dejaba sin
-- servicio habiendo pagado.
--
-- `aplicar_cobro` reparte la plata sola, de la factura más vieja a la más nueva,
-- y lo que sobra queda a favor, como antes.
--
-- Y no se factura al SRI hasta que el mes esté cancelado del todo: al abonado
-- que pide factura y paga en dos veces se le emite una sola, por el total, el
-- día que termina de pagar. Emitir por cada abono le daría dos comprobantes por
-- el mismo mes y obligaría a explicárselo al SRI y a él.
--
-- El reparto automático mira SOLO las facturas de servicio. Los cables, la
-- instalación y los cambios de clave se cobran cuando el cobrador los elige en
-- pantalla: esa factura se salda primero, aunque no sea de servicio. La razón es
-- que el servicio es lo que decide el corte —si el pago del mes se lo come una
-- factura vieja de materiales, el abonado queda sin internet habiendo pagado.
-- =============================================================================

-- Distingue las dos formas en que un cobro llega a una factura sin traer número
-- de comprobante propio: repartido en el momento del cobro, o aplicado después
-- desde un saldo que había quedado a favor. En el papel se leen distinto.
ALTER TABLE pagos
    ADD COLUMN IF NOT EXISTS es_reparto BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN pagos.es_reparto IS
    'Esta fila es parte de un cobro que se repartió entre varias facturas, no un saldo a favor aplicado después.';


-- =============================================================================
-- La vista tiene que volver a armarse
-- =============================================================================
-- v_pagos se define con `p.*`, y eso congela la lista de columnas al momento de
-- crearla: sin recrearla, `es_reparto` no llega al frontend por más que exista
-- en la tabla.
--
-- ── La guarda ──
--
-- Desde la 157, `v_transacciones` cuelga de `v_pagos`. Tirarla al reejecutar
-- esta migración aborta con "cannot drop view v_pagos because other objects
-- depend on it", y la corrida entera queda a medias: las columnas nuevas de la
-- tabla ya se agregaron y la vista quedó sin recrear.
--
-- La comprobación es por CONTENIDO y no por versión: si `es_reparto` ya está en
-- la vista, esta migración no tiene nada que hacer.
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_pagos'
           AND column_name = 'es_reparto'
    ) THEN
        RAISE NOTICE 'v_pagos ya trae es_reparto: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_pagos';
    EXECUTE $vista$
CREATE VIEW v_pagos WITH (security_invoker = true) AS
SELECT
    p.*,
    COALESCE(c.nombre, p.cliente_nombre) AS cliente,
    c.identificacion,
    c.ip,
    c.estado AS estado_cliente,
    cu.nombre AS cuenta,
    cu.tipo   AS cuenta_tipo,
    LPAD(f.numero::TEXT, 8, '0') AS numero_factura,
    f.concepto,
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante,
    d.importe_total AS total_comprobante,
    d.estado  AS estado_comprobante,
    p.monto - p.comision AS neto,
    p.monto + COALESCE((
        SELECT SUM(e.monto) FROM pagos e
         WHERE e.pago_origen_id = p.id AND NOT e.anulado
    ), 0) AS total_cobro,
    COALESCE((
        SELECT SUM(e.monto) FROM pagos e
         WHERE e.pago_origen_id = p.id AND NOT e.anulado
    ), 0) AS excedente
FROM pagos p
LEFT JOIN clientes c              ON c.id  = p.client_id
LEFT JOIN cuentas_pago cu         ON cu.id = p.cuenta_id
LEFT JOIN facturas f              ON f.id  = p.factura_id
LEFT JOIN electronic_documents d  ON d.id  = p.document_id
$vista$;
END $guarda$;


-- =============================================================================
-- El cobro que se reparte solo
-- =============================================================================
-- La plata entra como UN cobro: una fila principal —la que lleva el número del
-- banco, la comisión y la cuenta de destino— y una fila hija por cada factura
-- que además alcanza a cubrir. Las hijas cuelgan de la principal, así el recibo
-- imprime los $57 que el abonado entregó y la caja no los cuenta dos veces.
--
-- `p_factura_id` es la factura desde la que se cobró: se salda primero aunque no
-- sea la más vieja, porque es la que el cobrador tenía en pantalla. El resto va
-- por antigüedad.
CREATE OR REPLACE FUNCTION aplicar_cobro(
    p_client_id     UUID,
    p_monto         NUMERIC,
    p_forma_pago    TEXT    DEFAULT 'efectivo',
    p_cuenta_id     UUID    DEFAULT NULL,
    p_n_transaccion TEXT    DEFAULT NULL,
    p_fecha_pago    DATE    DEFAULT CURRENT_DATE,
    p_notas         TEXT    DEFAULT NULL,
    p_comision      NUMERIC DEFAULT 0,
    p_factura_id    UUID    DEFAULT NULL,
    -- NULL = como esté configurado el cliente. FALSE lo saca de la cola del SRI
    -- aunque el cliente sí facture: es la casilla de la pantalla de cobro.
    p_facturar      BOOLEAN DEFAULT NULL,
    p_activo_servicio BOOLEAN DEFAULT FALSE,
    -- FALSE reparte entre todas las facturas, del tipo que sean.
    p_solo_servicio BOOLEAN DEFAULT TRUE,
    p_created_by    UUID    DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_cliente     clientes%ROWTYPE;
    v_nombre      TEXT;
    v_electronica BOOLEAN;
    v_resta       NUMERIC;
    v_factura     RECORD;
    v_saldo       NUMERIC;
    v_usa         NUMERIC;
    v_cierra      BOOLEAN;
    v_principal   UUID := NULL;
    v_numero      BIGINT := NULL;
    v_pago_id     UUID;
    v_aplicado    NUMERIC := 0;
    v_detalle     JSONB := '[]'::JSONB;
    v_excedente   NUMERIC := 0;
BEGIN
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RAISE EXCEPTION 'El monto del cobro tiene que ser mayor que cero';
    END IF;

    SELECT * INTO v_cliente FROM clientes WHERE id = p_client_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese cliente';
    END IF;

    v_nombre      := v_cliente.nombre;
    -- NULL cuenta como "sí factura": es el valor de los clientes viejos, y
    -- dejarlos afuera de la cola del SRI sería peor que meterlos de más.
    v_electronica := COALESCE(p_facturar, v_cliente.factura_electronica, TRUE);
    v_resta       := ROUND(p_monto, 2);

    FOR v_factura IN
        SELECT f.id, f.numero, f.total, f.document_id, f.tipo
          FROM facturas f
         WHERE f.client_id = p_client_id
           AND NOT f.anulada
           -- La elegida entra siempre: es la que el cobrador quiso cobrar.
           AND (NOT p_solo_servicio OR f.tipo = 'servicios' OR f.id = p_factura_id)
         ORDER BY
             -- La que el cobrador tenía abierta va primero.
             (f.id = p_factura_id) DESC,
             f.fecha_emision,
             f.numero
    LOOP
        EXIT WHEN v_resta <= 0.005;

        v_saldo := v_factura.total - COALESCE((
            SELECT SUM(monto) FROM pagos
             WHERE factura_id = v_factura.id AND NOT anulado
        ), 0);

        CONTINUE WHEN v_saldo <= 0.005;

        v_usa := ROUND(LEAST(v_resta, v_saldo), 2);

        -- Si este cobro termina de pagar la factura. Es la condición para
        -- emitir: mientras deba, el comprobante no sale.
        v_cierra := v_usa >= v_saldo - 0.005;

        INSERT INTO pagos (
            client_id, cliente_nombre, factura_id, document_id, cuenta_id,
            monto, comision, forma_pago, n_transaccion, fecha_pago, notas,
            facturar, activo_servicio, es_excedente, es_reparto, pago_origen_id, created_by
        )
        VALUES (
            p_client_id, v_nombre, v_factura.id, v_factura.document_id, p_cuenta_id,
            v_usa,
            -- La comisión del medio de pago es una sola: va en la fila principal.
            CASE WHEN v_principal IS NULL THEN COALESCE(p_comision, 0) ELSE 0 END,
            p_forma_pago,
            -- El número del banco identifica la transferencia, no cada imputación:
            -- repetirlo en las hijas chocaría contra el índice único.
            CASE WHEN v_principal IS NULL THEN NULLIF(TRIM(COALESCE(p_n_transaccion, '')), '') END,
            p_fecha_pago,
            CASE
                WHEN v_principal IS NULL THEN p_notas
                ELSE 'Parte del cobro N° ' || v_numero || ' aplicada a esta factura'
            END,
            -- Solo el cobro que cancela la factura entra a la cola del SRI, y
            -- se emite por el total de la factura, no por este abono.
            v_electronica AND v_factura.document_id IS NULL AND v_cierra,
            -- La reactivación se pide una vez, no una por factura.
            p_activo_servicio AND v_principal IS NULL,
            v_principal IS NOT NULL,
            v_principal IS NOT NULL,
            v_principal,
            p_created_by
        )
        RETURNING id INTO v_pago_id;

        IF v_principal IS NULL THEN
            v_principal := v_pago_id;
            SELECT numero INTO v_numero FROM pagos WHERE id = v_pago_id;
        END IF;

        -- Los abonos anteriores de esta factura ya no se facturan por separado:
        -- el comprobante que sale ahora cubre el total.
        IF v_cierra THEN
            UPDATE pagos
               SET facturar = FALSE
             WHERE factura_id = v_factura.id
               AND id <> v_pago_id
               AND facturar
               AND document_id IS NULL;
        END IF;

        v_aplicado := v_aplicado + v_usa;
        v_resta    := ROUND(v_resta - v_usa, 2);

        v_detalle := v_detalle || JSONB_BUILD_OBJECT(
            'factura_id', v_factura.id,
            'numero',     LPAD(v_factura.numero::TEXT, 8, '0'),
            'tipo',       v_factura.tipo,
            'monto',      v_usa
        );
    END LOOP;

    -- Lo que sobró después de saldar todo. Entra a la misma cuenta: es plata que
    -- el abonado entregó, no una promesa.
    IF v_resta > 0.005 THEN
        v_excedente := v_resta;

        INSERT INTO pagos (
            client_id, cliente_nombre, cuenta_id, monto, comision, forma_pago,
            n_transaccion, fecha_pago, notas, activo_servicio, es_excedente,
            pago_origen_id, created_by
        )
        VALUES (
            p_client_id, v_nombre, p_cuenta_id, v_resta, 0, p_forma_pago,
            CASE WHEN v_principal IS NULL
                 THEN NULLIF(TRIM(COALESCE(p_n_transaccion, '')), '') END,
            p_fecha_pago,
            CASE
                WHEN v_principal IS NULL THEN COALESCE(p_notas, 'Cobro sin facturas pendientes: queda a favor del cliente')
                ELSE 'Excedente del cobro N° ' || v_numero || ': queda a favor del cliente'
            END,
            p_activo_servicio AND v_principal IS NULL,
            -- Sin facturas que saldar no hay de qué ser excedente: es el cobro.
            v_principal IS NOT NULL,
            v_principal,
            p_created_by
        )
        RETURNING id INTO v_pago_id;

        IF v_principal IS NULL THEN
            v_principal := v_pago_id;
            SELECT numero INTO v_numero FROM pagos WHERE id = v_pago_id;
        END IF;
    END IF;

    RETURN JSONB_BUILD_OBJECT(
        'pago_id',   v_principal,
        'numero',    v_numero,
        'recibo',    LPAD(COALESCE(v_numero, 0)::TEXT, 6, '0'),
        'cobrado',   ROUND(p_monto, 2),
        'aplicado',  v_aplicado,
        'excedente', v_excedente,
        'facturas',  v_detalle
    );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION aplicar_cobro IS
    'Registra un cobro y lo reparte entre las facturas de servicio pendientes, de la más vieja a la más nueva, más la factura elegida sea del tipo que sea. Lo que sobra queda a favor. Devuelve el recibo y el detalle.';

GRANT EXECUTE ON FUNCTION aplicar_cobro(
    UUID, NUMERIC, TEXT, UUID, TEXT, DATE, TEXT, NUMERIC, UUID, BOOLEAN, BOOLEAN, BOOLEAN, UUID
) TO authenticated, service_role;


-- =============================================================================
-- La lista de cobro dice de qué tipo es cada factura
-- =============================================================================
-- Sin el tipo, la pantalla no puede separar la deuda del servicio de la de los
-- materiales, y termina ofreciendo cobrar todo junto.
--
-- Se agrega al final con CREATE OR REPLACE: soltar la vista obligaría a soltar
-- también v_saldo_clientes y v_clientes_ficha, que cuelgan de ella.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `tipo`, la cadena siguió y esta versión quedó
     * atrás: la 24 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_facturas_por_cobrar'
           AND column_name = 'tipo'
    ) THEN
        RAISE NOTICE 'v_facturas_por_cobrar ya está en su versión de la 24: no se toca.';
        RETURN;
    END IF;

    -- Sin DROP: acá alcanza con reemplazar, porque esta versión solo AGREGA
    -- columnas al final y eso `CREATE OR REPLACE` sí lo permite. Soltarla
    -- fallaría: a esta altura de la cadena ya cuelgan otras vistas de ella.
    EXECUTE $vista$
CREATE OR REPLACE VIEW v_facturas_por_cobrar WITH (security_invoker = true) AS
SELECT
    f.id,
    f.client_id,
    LPAD(f.numero::TEXT, 8, '0') AS numero,
    f.numero_fiscal,
    f.fecha_emision,
    f.fecha_vencimiento,
    f.cliente     AS razon_social_comprador,
    f.total       AS importe_total,
    f.pagado,
    f.saldo,
    f.concepto,
    f.estado,
    f.tipo
FROM v_facturas f
WHERE NOT f.anulada
  AND f.saldo > 0.005
$vista$;
END $guarda$;


-- =============================================================================
-- La cola del SRI factura el mes, no el abono
-- =============================================================================
-- El cobro que entra a la cola es el que canceló la factura, pero el comprobante
-- tiene que salir por el TOTAL del mes: si el abonado pagó $20 y después $14.50,
-- la factura es de $34.50, no de $14.50.
--
-- `factura_id` faltaba en la vista, y sin él la emisión creaba una factura nueva
-- en vez de colgarle el comprobante a la que ya existía: el abonado terminaba
-- con el mes duplicado.
--
-- Las columnas nuevas van al final, con CREATE OR REPLACE: soltar la vista
-- obligaría a soltar lo que cuelga de ella.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `subtotal_factura`, la cadena siguió y esta versión quedó
     * atrás: la 25 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_pagos_por_facturar'
           AND column_name = 'subtotal_factura'
    ) THEN
        RAISE NOTICE 'v_pagos_por_facturar ya está en su versión de la 25: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_pagos_por_facturar';
    EXECUTE $vista$
CREATE VIEW v_pagos_por_facturar WITH (security_invoker = true) AS
SELECT
    p.id,
    p.numero,
    p.client_id,
    p.cliente_nombre,
    p.monto,
    p.comision,
    p.forma_pago,
    p.n_transaccion,
    p.cuenta_id,
    p.fecha_pago,
    p.notas,
    c.nombre          AS cliente,
    c.identificacion,
    c.tipo_identificacion,
    c.email,
    c.direccion,
    c.precio_mensual,
    c.descripcion_servicio,
    c.factura_electronica,
    pl.nombre         AS plan,
    pl.codigo_facturacion,
    cu.nombre         AS cuenta,
    -- Lo que impediría emitir: el SRI rechaza sin identificación del comprador.
    (c.identificacion IS NULL OR c.identificacion = '') AS falta_identificacion,
    p.factura_id,
    LPAD(f.numero::TEXT, 8, '0') AS numero_factura,
    f.concepto        AS concepto_factura,
    f.periodo_desde,
    f.periodo_hasta,
    -- Por cuánto se emite. Sin factura detrás —un abono suelto— es el cobro.
    COALESCE(f.total, p.monto) AS total_facturar
FROM pagos p
LEFT JOIN clientes c          ON c.id = p.client_id
LEFT JOIN planes_velocidad pl ON pl.id = c.plan_id
LEFT JOIN cuentas_pago cu     ON cu.id = p.cuenta_id
LEFT JOIN facturas f          ON f.id = p.factura_id
WHERE p.facturar
  AND p.document_id IS NULL
  AND NOT p.anulado
$vista$;
END $guarda$;


-- =============================================================================
-- Los abonos parciales que ya estaban en la cola salen de ella
-- =============================================================================
-- Se marcaron con la regla vieja —facturar cada cobro— y emitirían un
-- comprobante por una parte del mes. Se quedan en la cola solo los que dejaron
-- su factura en cero.
UPDATE pagos p
   SET facturar = FALSE
  FROM facturas f
 WHERE p.factura_id = f.id
   AND p.facturar
   AND p.document_id IS NULL
   AND NOT p.anulado
   AND f.total - COALESCE((
       SELECT SUM(x.monto) FROM pagos x
        WHERE x.factura_id = f.id AND NOT x.anulado
   ), 0) > 0.005;
