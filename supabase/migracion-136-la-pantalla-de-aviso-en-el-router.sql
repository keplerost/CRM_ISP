-- =============================================================================
-- Migración 136 — La pantalla de aviso, en el router
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que falta para que el aviso previo exista ──
--
-- La 130 dejó calculado a quién le toca ver la pantalla de aviso —los que están
-- por vencer, con su ventana configurable por abonado— y la 129 dejó el
-- interruptor para el que no la quiere ver. Pero nada de eso llega al abonado:
-- su tráfico sigue saliendo a internet normalmente y la página nunca aparece.
--
-- Falta la mitad que vive en el router: meterlo en un address-list que tenga una
-- regla de redirección, y sacarlo cuando deje de corresponder.
--
-- ── Por qué el nombre de la lista es del router y no una constante ──
--
-- Por lo mismo que con la de morosos, y ya nos pasó: el router de La Maná avisa
-- con una lista llamada "Aviso" y el sistema habría escrito en otra. La entrada
-- quedaría en una lista que ninguna regla mira, el abonado no vería nada, y no
-- habría ningún error que lo explique.
-- =============================================================================

ALTER TABLE routers_mikrotik
    /**
     * El address-list del aviso previo.
     *
     * NULL significa que este router no muestra aviso previo. Es lo correcto
     * como valor de fábrica: sin una regla de redirección que actúe sobre esa
     * lista, meter abonados ahí no hace nada — y hacerlo igual dejaría entradas
     * acumulándose en un equipo sin ningún efecto visible.
     */
    ADD COLUMN IF NOT EXISTS lista_aviso VARCHAR(50);

COMMENT ON COLUMN routers_mikrotik.lista_aviso IS
    'Address-list que este router usa para el aviso previo al corte. NULL = no muestra aviso previo. Tiene que existir una regla que redirija esa lista.';


-- =============================================================================
-- Quién entra y quién sale de esa lista
-- =============================================================================
/**
 * Los que hay que PONER en la lista de aviso.
 *
 * Están dentro de su ventana, tienen servicio, deben, su router sabe avisar y
 * todavía no están puestos.
 */
CREATE OR REPLACE VIEW v_aviso_pantalla_a_poner AS
SELECT
    a.cliente_id,
    a.nombre,
    a.ip,
    a.router_id,
    r.lista_aviso,
    a.dias,
    a.saldo
FROM v_avisos_pantalla a
JOIN routers_mikrotik r ON r.id = a.router_id
WHERE r.lista_aviso IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM firewall_bloqueos b
       WHERE b.cliente_id = a.cliente_id
         AND b.activo
         AND b.tipo_accion = 'REDIRECCION_PAGO'
  );

COMMENT ON VIEW v_aviso_pantalla_a_poner IS
    'Abonados que hay que meter en el address-list de aviso previo de su router.';


/**
 * Los que hay que SACAR.
 *
 * ── Por qué se sale por tres motivos distintos ──
 *
 * Pagó —y entonces ya no hay nada de qué avisarle—; se le cortó —y entonces le
 * toca la otra pantalla, no esta—; o se le apagó el aviso en su ficha.
 *
 * El que se cortó importa especialmente: si quedara en las dos listas, la regla
 * que primero coincida decide qué página ve, y bien podría ser la de "su factura
 * está por vencer" cuando ya está sin servicio.
 */
CREATE OR REPLACE VIEW v_aviso_pantalla_a_sacar AS
SELECT
    b.id            AS bloqueo_id,
    b.routeros_id,
    b.lista,
    b.cliente_ip    AS ip,
    b.router_id,
    c.id            AS cliente_id,
    c.nombre,
    c.estado
FROM firewall_bloqueos b
JOIN clientes c ON c.id = b.cliente_id
WHERE b.activo
  AND b.tipo_accion = 'REDIRECCION_PAGO'
  AND NOT EXISTS (
      SELECT 1 FROM v_avisos_pantalla a WHERE a.cliente_id = c.id
  );

COMMENT ON VIEW v_aviso_pantalla_a_sacar IS
    'Abonados que ya no corresponde tener en la lista de aviso: pagaron, se cortaron, o se les apagó el aviso.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Decirle al router con qué lista avisa:
--   UPDATE routers_mikrotik SET lista_aviso = 'Aviso' WHERE nombre = 'FTTH LA MANA';
--
--   -- Y a este abonado, mostrarle la pantalla desde dos días antes:
--   UPDATE clientes SET aviso_pantalla_dias = -2 WHERE codigo = 3;
--
--   SELECT nombre, dias, lista_aviso FROM v_aviso_pantalla_a_poner;
--   SELECT nombre, estado FROM v_aviso_pantalla_a_sacar;
