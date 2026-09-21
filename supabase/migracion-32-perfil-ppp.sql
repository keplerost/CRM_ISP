-- =============================================================================
-- Migración 32 — Qué perfil PPP le corresponde a cada plan
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 31. Es idempotente.
--
-- En PPPoE la velocidad no la pone una cola: la pone el perfil PPP con el que
-- se crea el secret. Hasta ahora el alta en campo usaba el NOMBRE del plan como
-- nombre de perfil, dando por hecho que coincidían.
--
-- No coinciden, y probándolo contra el router de producción quedó claro por
-- qué: los planes de la base se llaman PLAN_30M, PLAN_50M, PLAN_100M y los
-- perfiles del equipo "PLAN HOME 150Mbps", "PLAN PRO 300Mbps",
-- "PLAN_500_MEGAS". El alta caía al perfil por defecto —avisando, pero
-- cayendo—, y el abonado quedaba conectado y sin límite de velocidad.
--
-- Que sean dos campos distintos no es redundancia: el plan es lo que se le
-- vende y se le factura al cliente, y el perfil es cómo se llama esa velocidad
-- adentro del router. Cambiarle el nombre comercial a un plan no puede
-- reconfigurar la red, y renombrar un perfil en el equipo no puede cambiar lo
-- que dice la factura.
-- =============================================================================

ALTER TABLE planes_velocidad
    ADD COLUMN IF NOT EXISTS perfil_ppp VARCHAR(100);

COMMENT ON COLUMN planes_velocidad.perfil_ppp IS
    'Nombre EXACTO del perfil en /ppp/profile del MikroTik. Es lo que aplica la velocidad en PPPoE. Vacío = se prueba con el nombre del plan, que es lo que se hacía antes de esta columna.';


-- =============================================================================
-- La columna arranca vacía a propósito
-- =============================================================================
-- No se completa con el nombre del plan. Adivinar que "PLAN_100M" equivale a
-- "PLAN PRO 300Mbps" por parecido de texto es exactamente el tipo de suposición
-- que dejó a los abonados sin límite de velocidad; y rellenarla con un valor
-- que no existe en el equipo haría que la pantalla muestre como configurado
-- algo que no lo está.
--
-- Vacía, el alta se comporta igual que hasta ahora —prueba con el nombre del
-- plan y cae al perfil por defecto avisando—, así que nada se rompe mientras se
-- completa. La lista de perfiles reales del router se elige en
-- Perfiles y planes → Planes de velocidad.
