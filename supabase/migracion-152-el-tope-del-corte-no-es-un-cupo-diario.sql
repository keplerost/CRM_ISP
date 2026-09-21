-- =============================================================================
-- Migración 152 — El tope del corte no es un cupo diario
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- El corte por mora traía un tope de 50 abonados por corrida: un número de
-- prueba disfrazado de configuración.
--
-- Un ISP corta a todos sus morosos en una sola madrugada; eso es lo que hacen
-- WispHub y MikroWISP, y es lo que el negocio necesita. Con 500 morosos y un
-- tope de 50 se cortaban 50 por día, y los otros 450 seguían con servicio diez
-- días.
--
-- Peor: el informe decía "50 cortados" sin mencionar a los 450 que faltaban. El
-- campo que debía avisarlo estaba mal calculado y devolvía cero siempre.
--
-- ── Por qué el tope desaparece en vez de subir ──
--
-- El argumento para tenerlo era el miedo a un error de configuración que cortara
-- el padrón entero. Ese miedo no se sostiene, y las dos razones se comprobaron
-- midiendo, no discutiendo:
--
--   ES REVERSIBLE SOLO. Si el corte salió de una factura mal creada, se anula la
--   factura y `v_clientes_a_reconectar` los devuelve al servicio en la barrida
--   siguiente —quince minutos— sin que nadie toque un router.
--
--   NO ES UN PROBLEMA DE TIEMPO. Medido contra el router de La Maná: 9 ms por
--   corte, unos 7000 por minuto. Cinco mil morosos son 43 segundos.
--
-- El campo sigue existiendo para quien quiera ir despacio los primeros meses.
-- =============================================================================

/**
 * Solo se toca el que quedó en el valor de prueba.
 *
 * Si el ISP puso otro número —30 porque quiere ir despacio, 2000 porque tiene un
 * padrón grande— es una decisión suya.
 */
UPDATE config_tareas
   SET mora_limite = 0
 WHERE id = 1
   AND mora_limite = 50;

COMMENT ON COLUMN config_tareas.mora_limite IS
    'Tope de cortes por corrida. 0 = sin tope, corta a todos los que corresponda. Si se pone un número y se alcanza, el resto queda SIN CORTAR hasta la corrida siguiente: la barrida solo reconecta, no corta.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT mora_automatico, mora_hora, mora_limite FROM config_tareas;
--   -- mora_limite en 0 = corta a todos
--
--   -- Y cuántos habría para cortar hoy:
--   SELECT COUNT(*) FROM v_clientes_a_cortar_por_mora;
