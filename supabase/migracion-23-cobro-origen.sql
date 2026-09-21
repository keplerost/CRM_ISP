-- =============================================================================
-- Migración 23 — El excedente queda atado a su cobro
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 22. Es idempotente.
--
-- Cuando el abonado entrega $50 por una factura de $34.50, la plata se guarda
-- en dos filas: lo que cubre la factura y el excedente. Las dos entran a la
-- misma cuenta, así que la caja cuadra — el problema es de lectura:
--
--   * El recibo imprimía $34.50 cuando el cliente entregó $50.
--   * En el historial se veían dos cobros sueltos sin nada que los relacione.
--
-- Con el vínculo, las dos filas siguen existiendo —es lo que permite imputar el
-- excedente a otra factura sin tocar el cobro original— pero se pueden mostrar
-- y sumar como lo que son: un solo cobro.
-- =============================================================================

ALTER TABLE pagos
    ADD COLUMN IF NOT EXISTS pago_origen_id UUID REFERENCES pagos(id) ON DELETE CASCADE;

COMMENT ON COLUMN pagos.pago_origen_id IS
    'El cobro del que salió este excedente. ON DELETE CASCADE: si se borra el cobro mal registrado, su excedente se va con él.';

CREATE INDEX IF NOT EXISTS idx_pagos_origen
    ON pagos (pago_origen_id) WHERE pago_origen_id IS NOT NULL;


-- =============================================================================
-- La vista suma el cobro completo
-- =============================================================================
-- `total_cobro` es lo que el abonado entregó de verdad: esta fila más su
-- excedente. Es lo que va en el recibo y lo que hay que ver en el historial.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `es_reparto`, la cadena siguió y esta versión quedó
     * atrás: la 24 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_pagos'
           AND column_name = 'es_reparto'
    ) THEN
        RAISE NOTICE 'v_pagos ya está en su versión de la 24: no se toca.';
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
-- Al partir un cobro, la parte nueva recuerda de dónde salió
-- =============================================================================
CREATE OR REPLACE FUNCTION aplicar_saldo_a_favor(p_factura_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_factura   facturas%ROWTYPE;
    v_pendiente NUMERIC;
    v_aplicado  NUMERIC := 0;
    v_pago      pagos%ROWTYPE;
    v_usa       NUMERIC;
BEGIN
    SELECT * INTO v_factura FROM facturas WHERE id = p_factura_id;
    IF NOT FOUND OR v_factura.anulada THEN
        RETURN 0;
    END IF;

    v_pendiente := v_factura.total - COALESCE((
        SELECT SUM(monto) FROM pagos
         WHERE factura_id = p_factura_id AND NOT anulado
    ), 0);

    FOR v_pago IN
        SELECT * FROM pagos
         WHERE client_id = v_factura.client_id
           AND factura_id IS NULL
           AND NOT anulado
         ORDER BY fecha_pago, created_at
    LOOP
        EXIT WHEN v_pendiente <= 0.005;

        v_usa := LEAST(v_pago.monto, v_pendiente);

        IF v_usa >= v_pago.monto - 0.005 THEN
            UPDATE pagos SET factura_id = p_factura_id WHERE id = v_pago.id;
        ELSE
            UPDATE pagos SET monto = v_usa, factura_id = p_factura_id WHERE id = v_pago.id;

            INSERT INTO pagos (
                client_id, cliente_nombre, cuenta_id, monto, comision, forma_pago,
                fecha_pago, notas, es_excedente, pago_origen_id
            )
            VALUES (
                v_pago.client_id, v_pago.cliente_nombre, v_pago.cuenta_id,
                v_pago.monto - v_usa, 0, v_pago.forma_pago, v_pago.fecha_pago,
                'Excedente del cobro N° ' || v_pago.numero || ': queda a favor del cliente',
                TRUE,
                -- El excedente que sobra de partir un excedente sigue apuntando
                -- al cobro original, no a la parte intermedia.
                COALESCE(v_pago.pago_origen_id, v_pago.id)
            );
        END IF;

        v_aplicado  := v_aplicado + v_usa;
        v_pendiente := v_pendiente - v_usa;
    END LOOP;

    RETURN v_aplicado;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- Atar los excedentes que ya existen
-- =============================================================================
-- Los que se crearon antes de esta migración quedaron sueltos. Se los vincula
-- al cobro del mismo cliente, misma cuenta y misma fecha que los originó.
UPDATE pagos e
   SET pago_origen_id = o.id
  FROM pagos o
 WHERE e.es_excedente
   AND e.pago_origen_id IS NULL
   AND o.id <> e.id
   AND NOT o.es_excedente
   AND o.client_id = e.client_id
   AND o.fecha_pago = e.fecha_pago
   AND o.created_at < e.created_at
   -- El más cercano en el tiempo: es el cobro del que se partió.
   AND NOT EXISTS (
       SELECT 1 FROM pagos x
        WHERE NOT x.es_excedente
          AND x.client_id = e.client_id
          AND x.fecha_pago = e.fecha_pago
          AND x.created_at < e.created_at
          AND x.created_at > o.created_at
   );
