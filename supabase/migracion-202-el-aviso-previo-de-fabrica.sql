-- =============================================================================
-- Migración 202 — El aviso previo, encendido de fábrica en cada router
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- Hasta ahora `routers_mikrotik.lista_aviso` NULL quería decir "este router no
-- muestra aviso previo", y todos los routers nacían así. El aviso solo existía
-- si alguien se acordaba de escribir una lista a mano.
--
-- Ahora, al configurar el router, el sistema le pone `AVISO_PAGO` y crea sus
-- reglas. Hacen falta dos valores distintos:
--
--   NULL   todavía nadie decidió → al configurar se usa AVISO_PAGO
--   ''     alguien lo apagó a propósito → no se vuelve a encender solo
--
-- Esta migración solo cambia la vista de a quién meter en la lista, para que
-- la cadena vacía cuente como apagado. Encenderlo no le muestra nada a nadie
-- por sí solo: el aviso sale a los abonados con `aviso_pantalla_dias` cargado.
-- =============================================================================

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
WHERE NULLIF(r.lista_aviso, '') IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM firewall_bloqueos b
       WHERE b.cliente_id = a.cliente_id
         AND b.activo
         AND b.tipo_accion = 'REDIRECCION_PAGO'
  );

COMMENT ON VIEW v_aviso_pantalla_a_poner IS
    'Abonados que hay que meter en el address-list de aviso previo de su router. lista_aviso vacía = el router no muestra aviso.';

COMMENT ON COLUMN routers_mikrotik.lista_aviso IS
    'Address-list del aviso previo. NULL = sin decidir (al configurar se usa AVISO_PAGO). Vacía = apagado a propósito.';
