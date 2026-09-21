-- =============================================================================
-- Migración 130 — El aviso de nueva factura y el de pantalla
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué falta y por qué es otro aviso ──
--
-- Los tres avisos de la 127 son de COBRANZA: recuerdan una deuda. El de nueva
-- factura es otra cosa — es informativo, se manda una vez cuando se emite, y hay
-- abonados que lo quieren aunque no quieran que les recuerden nada más. Meterlo
-- en el mismo interruptor obligaría a elegir entre recibir los cuatro o ninguno.
--
-- ── El aviso de pantalla, que también es distinto ──
--
-- La 129 dejó `avisos_pantalla` como un sí o un no: si ve o no la página cuando
-- ya está cortado. Falta lo de ANTES: mostrarle una pantalla de aviso mientras
-- todavía tiene servicio, para que se entere antes de quedarse sin internet.
--
-- Eso necesita un número, no un interruptor: desde cuántos días antes se le
-- empieza a mostrar.
-- =============================================================================

ALTER TABLE clientes
    /**
     * Por dónde se le avisa que hay factura nueva.
     *
     * NULL usa lo general; una lista vacía es "no le avises". Se guarda como
     * lista y no como un solo canal porque hay abonados que quieren el correo
     * —que sirve de respaldo escrito— Y el mensaje al teléfono, que es el que
     * de verdad leen.
     */
    ADD COLUMN IF NOT EXISTS aviso_factura_canales TEXT[],

    /**
     * Desde cuántos días antes se le muestra la pantalla de aviso.
     *
     * En días respecto del vencimiento, con el mismo criterio que los demás:
     * negativo es antes. NULL es no mostrarla nunca antes del corte.
     *
     * Es un rango y no un día puntual: la pantalla no es un mensaje que se manda
     * una vez, es un estado que dura. Poniendo 2 días antes, el abonado la ve
     * cada vez que abre el navegador durante esos dos días.
     */
    ADD COLUMN IF NOT EXISTS aviso_pantalla_dias INT;

COMMENT ON COLUMN clientes.aviso_factura_canales IS
    'Canales del aviso de nueva factura. NULL = lo general, lista vacía = no avisar. Es informativo y va aparte de los de cobranza.';

COMMENT ON COLUMN clientes.aviso_pantalla_dias IS
    'Desde cuántos días respecto del vencimiento se le muestra la pantalla de aviso. Negativo es antes. NULL = solo cuando ya está cortado.';


-- =============================================================================
-- A quién le toca ver la pantalla de aviso hoy
-- =============================================================================
/**
 * Los que todavía tienen servicio pero están dentro de su ventana de aviso.
 *
 * ── Por qué es una vista y no una columna que alguien actualiza ──
 *
 * Porque la respuesta cambia sola con el calendario: hoy le toca y pasado
 * mañana ya no, sin que nadie haya tocado nada. Una columna habría que
 * recalcularla todas las noches y quedaría desactualizada el día que esa tarea
 * no corra.
 *
 * ── Para qué sirve ──
 *
 * La página del navegador la consulta para saber si a este abonado le muestra el
 * aviso previo en vez de la página de corte. Y es la lista que hay que empujar
 * al address-list de aviso del router, cuando eso se automatice.
 */
CREATE OR REPLACE VIEW v_avisos_pantalla AS
SELECT
    c.id            AS cliente_id,
    c.nombre,
    c.ip,
    c.router_id,
    c.estado,
    f.fecha_vencimiento,
    (CURRENT_DATE - f.fecha_vencimiento) AS dias,
    c.aviso_pantalla_dias,
    COALESCE(s.saldo, 0) AS saldo
FROM clientes c
JOIN v_saldo_clientes s ON s.client_id = c.id
-- La factura impaga más próxima a vencer: es la que motiva el aviso.
JOIN LATERAL (
    SELECT fc.fecha_vencimiento
      FROM v_facturas_por_cobrar fc
     WHERE fc.client_id = c.id AND fc.fecha_vencimiento IS NOT NULL
     ORDER BY fc.fecha_vencimiento
     LIMIT 1
) f ON TRUE
WHERE c.aviso_pantalla_dias IS NOT NULL
  AND c.avisos_pantalla
  -- Todavía con servicio: al cortado ya le toca la otra página.
  AND c.estado = 'activo'
  AND COALESCE(s.saldo, 0) > 0
  -- Dentro de la ventana: desde el día configurado hasta el vencimiento.
  AND (CURRENT_DATE - f.fecha_vencimiento) >= c.aviso_pantalla_dias;

COMMENT ON VIEW v_avisos_pantalla IS
    'Abonados con servicio que están dentro de su ventana de aviso en pantalla. Cambia sola con el calendario.';


-- =============================================================================
-- Y la ficha que lee la página, para saber cuál mostrar
-- =============================================================================
-- Columnas nuevas AL FINAL: `CREATE OR REPLACE VIEW` sabe agregar al final pero
-- no reordenar, y respetando el orden de la 129 esta no necesita soltar nada.
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
    c.avisos_pantalla,
    c.aviso_pantalla_dias,
    -- Si HOY le toca el aviso previo. La página elige con esto qué plantilla
    -- usar: la de aviso o la de corte.
    EXISTS (SELECT 1 FROM v_avisos_pantalla a WHERE a.cliente_id = c.id) AS en_aviso_previo
FROM clientes c
LEFT JOIN planes_velocidad p ON p.id = c.plan_id
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.ip IS NOT NULL AND c.ip <> '';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Mostrarle la pantalla desde dos días antes de vencer:
--   UPDATE clientes SET aviso_pantalla_dias = -2 WHERE codigo = 3;
--
--   -- A quién le tocaría hoy:
--   SELECT nombre, dias, saldo FROM v_avisos_pantalla;
--
--   -- Y qué página le mostraría el navegador:
--   SELECT nombre, estado, en_aviso_previo FROM v_corte_abonado WHERE ip = '10.0.0.5';
