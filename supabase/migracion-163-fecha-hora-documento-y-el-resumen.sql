-- =============================================================================
-- Migración 163 — Fecha y hora de facturación, el documento, y el resumen
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué agrega ──
--
--   FECHA        el día en que se facturó, 17/08/2026, en vez del mes suelto
--   HORA Y MINUTO  a qué hora se emitió
--   DOCUMENTO    el comprobante completo: FAC 001-002-000001047
--
-- Más un resumen general: de los que piden factura, cuántos vienen a pagar en
-- efectivo y cuántos por transferencia.
--
-- ── De dónde sale la hora ──
--
-- Del momento en que el SRI AUTORIZÓ el comprobante, que es el acto oficial. Si
-- por alguna razón no quedó registrado —un comprobante viejo, una autorización
-- que se cargó a mano— se cae a cuándo se creó la factura en el sistema.
--
-- La FECHA, en cambio, es la que declara el comprobante y no la de la
-- autorización. Casi siempre son la misma, pero una factura emitida a las 23:50 y
-- autorizada a las 00:05 declara el día anterior: ante el SRI vale lo declarado, y
-- el reporte tiene que coincidir con lo que el organismo tiene guardado.
--
-- ── Por qué las columnas van al final de la vista ──
--
-- Porque `CREATE OR REPLACE` puede agregar columnas pero no meterlas en el medio,
-- y la 162 puede haberse corrido ya. En el reporte aparecen en el orden que pidió
-- el regulador: eso lo decide la lista de columnas del exportador, no la vista.
-- =============================================================================

CREATE OR REPLACE VIEW v_reporte_arcotel AS
SELECT
    f.id                AS factura_id,
    f.client_id,
    f.numero_fiscal,
    f.fecha_emision,
    TO_CHAR(COALESCE(f.periodo_desde, f.fecha_emision), 'YYYY-MM') AS mes,
    INITCAP(TO_CHAR(COALESCE(f.periodo_desde, f.fecha_emision), 'TMMonth YYYY')) AS mes_nombre,

    COALESCE(f.cliente_nombre, c.nombre) AS usuario,
    c.identificacion,
    c.codigo,

    COALESCE(NULLIF(c.telefono_movil, ''), NULLIF(c.telefono, '')) AS telefono,
    COALESCE(NULLIF(c.canton, ''), NULLIF(c.ciudad, '')) AS canton,
    c.parroquia,
    c.direccion,

    p.nombre            AS plan,
    f.total             AS costo_con_impuestos,

    ROUND(p.bajada_kbps / 1000.0, 1) AS down_mbps,
    ROUND(p.subida_kbps / 1000.0, 1) AS up_mbps,

    CASE COALESCE(c.red_acceso::TEXT, i.tecnologia)
        WHEN 'fibra'       THEN 'FIBRA OPTICA'
        WHEN 'ftth'        THEN 'FIBRA OPTICA'
        WHEN 'inalambrico' THEN 'RADIO ENLACE'
        WHEN 'radio'       THEN 'RADIO ENLACE'
        WHEN 'wireless'    THEN 'RADIO ENLACE'
        WHEN 'par_cobre'   THEN 'PAR DE COBRE'
        WHEN 'coaxial'     THEN 'COAXIAL'
        WHEN 'otros'       THEN 'OTROS'
        ELSE 'POR DEFINIR'
    END AS tecnologia,

    c.prestador_id,
    f.estado_sri,
    p.comparticion,

    -- ── Lo de esta migración ──

    -- El día que declara el comprobante, como se lee en Ecuador.
    TO_CHAR(f.fecha_emision, 'DD/MM/YYYY') AS fecha,

    /**
     * La hora, en la del país.
     *
     * `AT TIME ZONE` es obligatorio: la base guarda en UTC y sin convertir, una
     * factura de las 20:30 de La Maná figuraría emitida a la 01:30 del día
     * siguiente. Es el mismo error que arruina un reporte sin que nada falle.
     */
    TO_CHAR(
        COALESCE(d.fecha_autorizacion, f.created_at) AT TIME ZONE 'America/Guayaquil',
        'HH24:MI'
    ) AS hora,

    /**
     * El comprobante como se lo nombra: FAC 001-002-000001047.
     *
     * Con el prefijo del tipo de documento, porque el mismo formato de numeración
     * lo usan las notas de crédito y las retenciones: sin él, dos filas distintas
     * pueden verse iguales.
     */
    CASE d.tipo_doc
        WHEN '01' THEN 'FAC '
        WHEN '04' THEN 'NC '
        WHEN '05' THEN 'ND '
        WHEN '06' THEN 'GR '
        WHEN '07' THEN 'RET '
        ELSE ''
    END || f.numero_fiscal AS documento,

    /**
     * Cómo pagó esta factura.
     *
     * Una factura puede saldarse con varios cobros y de varias formas —trae la
     * mitad en efectivo y transfiere el resto—. En ese caso se dice `mixto` en vez
     * de elegir uno: contarla como efectivo esconde una transferencia que sí
     * existe en el banco, y al revés.
     */
    COALESCE(pg.forma, 'sin cobrar') AS forma_pago
FROM v_facturas f
LEFT JOIN clientes c           ON c.id = f.client_id
LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
LEFT JOIN electronic_documents d ON d.id = f.document_id
LEFT JOIN LATERAL (
    SELECT ins.tecnologia
      FROM instalaciones ins
     WHERE ins.client_id = f.client_id
       AND ins.tecnologia IS NOT NULL
     ORDER BY ins.fecha DESC NULLS LAST, ins.created_at DESC
     LIMIT 1
) i ON TRUE
LEFT JOIN LATERAL (
    SELECT CASE
               WHEN COUNT(DISTINCT pa.forma_pago) = 0 THEN NULL
               WHEN COUNT(DISTINCT pa.forma_pago) = 1 THEN MIN(pa.forma_pago)
               ELSE 'mixto'
           END AS forma
      FROM pagos pa
     WHERE pa.factura_id = f.id
       AND NOT pa.anulado
) pg ON TRUE
WHERE NOT f.anulada
  AND f.numero_fiscal IS NOT NULL
  AND f.estado_sri = 'AUTORIZADO';

COMMENT ON VIEW v_reporte_arcotel IS
    'Las facturas autorizadas por el SRI con los campos que pide ARCOTEL: fecha y hora de emisión, documento, abonado, contacto, ubicación, plan, velocidades, compartición, costo, tecnología y cómo se pagó.';


-- =============================================================================
-- El resumen general
-- =============================================================================
/**
 * De los que piden factura, cómo pagan.
 *
 * ── Para qué sirve ──
 *
 * Para saber cuánta de la facturación electrónica entra por caja y cuánta por el
 * banco. Es la cuenta que dice si conviene empujar la transferencia: el efectivo
 * de un comprobante fiscal hay que depositarlo igual, y cada depósito es un viaje.
 *
 * ── Por qué el "mixto" tiene su propia fila ──
 *
 * Porque repartirlo entre efectivo y transferencia obligaría a partir el monto, y
 * una factura contada por mitades en dos filas hace que la suma de "cuántos
 * pagaron en efectivo" deje de ser un número de personas.
 */
CREATE OR REPLACE VIEW v_arcotel_resumen AS
SELECT
    r.mes,
    r.prestador_id,
    r.forma_pago,
    COUNT(*)                        AS facturas,
    COUNT(DISTINCT r.client_id)     AS abonados,
    SUM(r.costo_con_impuestos)      AS monto
FROM v_reporte_arcotel r
GROUP BY r.mes, r.prestador_id, r.forma_pago;

COMMENT ON VIEW v_arcotel_resumen IS
    'De las facturas emitidas al SRI, cuántas se cobraron en efectivo, cuántas por transferencia y cuántas siguen sin cobrar. Es la cuenta que dice cuánta plata fiscal entra por caja.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El reporte, como sale en el archivo:
--   SELECT fecha, hora, documento, usuario, costo_con_impuestos, comparticion, forma_pago
--     FROM v_reporte_arcotel WHERE mes = '2026-08' ORDER BY fecha, hora;
--
--   -- Y el resumen de cómo pagaron:
--   SELECT forma_pago, facturas, abonados, monto
--     FROM v_arcotel_resumen WHERE mes = '2026-08' ORDER BY monto DESC;
