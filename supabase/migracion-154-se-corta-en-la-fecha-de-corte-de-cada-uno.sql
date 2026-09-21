-- =============================================================================
-- Migración 154 — Se corta en la fecha de corte de cada abonado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El desajuste que esto corrige ──
--
-- La regla del negocio es: se factura el mes vencido, y si el abonado no paga
-- hasta SU fecha de corte, se lo corta. Cada uno tiene la suya.
--
-- El sistema ya tenía esa fecha —`dias_gracia` en la ficha, "días después del
-- vencimiento antes de cortar"— y es la misma que usa `v_facturas` para marcar
-- una factura como `vencida`. Pero el corte por mora no la miraba: decidía con
-- `cortar_tras_meses`, un umbral EN MESES. Con el valor 1, que es el que tienen
-- todos, eso significa "esperá 30 días después del vencimiento". El abonado que
-- no paga el 5 se cortaba el 5 del mes siguiente, no el día que le corresponde.
--
-- Eran dos campos para lo mismo, y el corte usaba el equivocado.
--
-- ── La regla, ahora ──
--
--   Se corta al que tiene una factura VENCIDA. Nada más.
--
-- Vencida quiere decir exactamente lo que ya decía la pantalla de facturación:
-- que pasó su vencimiento más sus días de gracia. Un solo concepto, un solo
-- campo, y el mismo que el abonado ve en su estado de cuenta.
--
-- ── Qué pasa con `cortar_tras_meses` ──
--
-- Se queda, pero solo como el interruptor que ya era en la práctica:
--
--   0  → NUNCA se corta. Servicio gratis, enlace institucional, cámara.
--   >0 → Se corta en su fecha de corte.
--
-- Los meses dejan de decidir el momento. Al que paga cada varios meses se lo
-- expresa con sus días de gracia, que es donde vive el plazo de verdad: por eso
-- acá se le levanta el techo de 60 a 365 días. Un campo menos que explicar.
--
-- ── Qué NO cambia ──
--
-- Todo lo demás del corte sigue igual: no se corta al que tiene promesa
-- vigente, al excluido del firewall, al que no tiene IP, ni al que no debe. Y la
-- medida del atraso sigue siendo la de la 153: la factura más vieja sin cubrir,
-- que un abono parcial no mueve.
-- =============================================================================

/**
 * El plazo de verdad vive en los días de gracia, así que tiene que alcanzar.
 *
 * Sesenta días no alcanzaban para el abonado que paga cada tres o cada seis
 * meses —el caso que antes se resolvía con el umbral en meses—. Un año es tope
 * de sobra y sigue atajando el error de tipeo de tres ceros.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'clientes'::regclass
           AND conname = 'clientes_dias_gracia_check'
           AND pg_get_constraintdef(oid) LIKE '%365%'
    ) THEN
        RAISE NOTICE 'El techo de dias_gracia ya está en 365: no se toca.';
        RETURN;
    END IF;

    ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_dias_gracia_check;
    ALTER TABLE clientes ADD CONSTRAINT clientes_dias_gracia_check
        CHECK (dias_gracia >= 0 AND dias_gracia <= 365);
END $guarda$;

COMMENT ON COLUMN clientes.dias_gracia IS
    'Días después del vencimiento antes de que corresponda cortar. Es la fecha de corte del abonado: es lo que decide el corte por mora y lo que marca una factura como vencida.';

COMMENT ON COLUMN clientes.cortar_tras_meses IS
    'Interruptor del corte por mora: 0 = nunca se corta (servicio gratis, institucional); mayor que 0 = se corta en su fecha de corte. Desde la 154 los meses ya no deciden el momento: eso lo hacen los días de gracia.';


/**
 * La fecha en que le corresponde el corte.
 *
 * Se expone como función y no como cuenta suelta dentro de la vista para que la
 * pantalla y la tarea digan el mismo día. Devuelve NULL cuando no debe nada:
 * "no tiene fecha de corte" es distinto de "le toca hoy".
 */
CREATE OR REPLACE FUNCTION fecha_de_corte(p_cliente UUID)
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT MIN(COALESCE(f.fecha_vencimiento, f.fecha_emision))::DATE
           + COALESCE((SELECT c.dias_gracia FROM clientes c WHERE c.id = p_cliente), 0)
      FROM v_facturas_por_cobrar f
     WHERE f.client_id = p_cliente;
$$;

COMMENT ON FUNCTION fecha_de_corte IS
    'El día en que le corresponde el corte: el vencimiento de su factura más vieja sin pagar, más sus días de gracia. NULL si no debe nada.';


-- =============================================================================
-- Las dos vistas, decidiendo por la fecha de corte
-- =============================================================================
-- Se usa CREATE OR REPLACE y las columnas nuevas van al FINAL a propósito: así
-- no hay que tirar `v_clientes_a_reconectar`, y con ella
-- `v_reconexiones_a_procesar`, que es la que atiende la cola. Cada DROP de esa
-- cadena es una oportunidad de olvidarse de recrear la última.

CREATE OR REPLACE VIEW v_clientes_a_cortar_por_mora AS
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
    meses_sin_pago(c.id)  AS meses_sin_pago,
    COALESCE(s.saldo, 0)  AS saldo,
    s.ultimo_pago,
    (SELECT MIN(f.fecha_vencimiento)
       FROM v_facturas_por_cobrar f WHERE f.client_id = c.id) AS vence_desde,
    -- Las dos nuevas. Van al final porque CREATE OR REPLACE puede agregar
    -- columnas pero no reordenarlas.
    COALESCE(c.dias_gracia, 0) AS dias_gracia,
    fecha_de_corte(c.id)       AS fecha_corte
FROM clientes c
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.estado = 'activo'
  /**
   * El interruptor. Los dos campos dicen lo mismo —un disparador los mantiene
   * sincronizados desde la 131— y se piden los dos porque una fila importada de
   * afuera podría haber esquivado el disparador, y en ese caso conviene NO
   * cortar: el error que deja a alguien con internet se descubre cobrando; el
   * que lo deja sin internet, con una llamada.
   */
  AND c.aplicar_corte
  AND c.cortar_tras_meses > 0
  AND NOT c.excluir_firewall
  AND c.ip IS NOT NULL AND c.ip <> ''
  AND COALESCE(s.saldo, 0) > 0
  /**
   * Acá está el cambio: pasó su fecha de corte.
   *
   * Es la misma cuenta con la que `v_facturas` marca una factura como `vencida`,
   * a propósito: lo que la oficina ve vencido es exactamente lo que se corta.
   * Antes esto era `meses_de_atraso(c.id) >= c.cortar_tras_meses`, que con el
   * umbral en 1 obligaba a esperar treinta días.
   */
  AND dias_de_atraso(c.id) > COALESCE(c.dias_gracia, 0)
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
  );

COMMENT ON VIEW v_clientes_a_cortar_por_mora IS
    'Abonados activos que pasaron su fecha de corte —vencimiento de la factura más vieja más sus días de gracia— y siguen debiendo. Ya excluye promesas vigentes, exclusiones de firewall, servicio gratis y a los que no tienen IP.';


CREATE OR REPLACE VIEW v_clientes_a_reconectar AS
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
    c.cortar_tras_meses,
    dias_de_atraso(c.id)       AS dias_de_atraso,
    COALESCE(c.dias_gracia, 0) AS dias_gracia
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
      OR dias_de_atraso(c.id) <= COALESCE(c.dias_gracia, 0)
      -- O consiguió una promesa de pago vigente: eso lo devuelve al servicio.
      OR EXISTS (
          SELECT 1 FROM promesas_pago p
           WHERE p.client_id = c.id
             AND p.estado = 'activa'
             AND p.fecha_promesa >= CURRENT_DATE
      )
  )
ORDER BY c.id, b.created_at DESC;

COMMENT ON VIEW v_clientes_a_reconectar IS
    'Cortados por mora que ya no deberían estarlo: cubrieron la factura vieja, volvieron a estar dentro de su fecha de corte, o consiguieron una promesa. Solo los que cortó esta tarea.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Cuándo le toca el corte a cada uno de los que deben:
--   SELECT c.nombre, c.dia_facturacion, c.dias_gracia,
--          fecha_de_corte(c.id) AS se_corta_el,
--          dias_de_atraso(c.id) AS atraso
--     FROM clientes c
--    WHERE c.estado = 'activo' AND fecha_de_corte(c.id) IS NOT NULL
--    ORDER BY se_corta_el;
--
--   -- Y a quién le toca hoy:
--   SELECT nombre, fecha_corte, dias_de_atraso, dias_gracia, saldo
--     FROM v_clientes_a_cortar_por_mora ORDER BY fecha_corte;
