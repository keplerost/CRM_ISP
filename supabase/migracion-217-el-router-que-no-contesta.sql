-- =============================================================================
-- Migración 217 — El router que no contesta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- El monitoreo sondea los nodos DESDE el router: el servidor le pide al router
-- que haga ping. Eso sirve para las torres y las antenas, pero deja al router
-- sin vigilar: si se cae, no hay quién haga el ping, sus nodos quedan "sin
-- datos" y no sale ningún aviso. Con un solo router, la caída que más importa
-- es la única que el sistema no avisa.
--
-- Ahora el servidor, en cada pasada del monitoreo, prueba la API de cada router
-- activo. Si no contesta varias veces seguidas, lo da por caído y avisa por el
-- mismo canal que los nodos; cuando vuelve, avisa la recuperación.
--
-- ── Las tres reglas contra los avisos falsos ──
--
-- 1. Gracia al arrancar: en los primeros minutos después de un reinicio del
--    servidor no se cuenta ninguna falla. La VPN puede tardar en levantar.
-- 2. Varias fallas seguidas: una sola no alcanza. Un corte de segundos no
--    despierta a nadie.
-- 3. El estado vive acá, en la base: un reinicio no lo pierde, así que no se
--    vuelve a avisar lo que ya se avisó ni se arranca en "desconocido".
--
-- ── Lo que el aviso NO puede distinguir ──
--
-- Desde el servidor, "se cayó el router" y "se cayó la VPN o el internet del
-- servidor" se ven igual. El aviso dice lo que se sabe: que no hay conexión.
-- =============================================================================


-- =============================================================================
-- 1. El estado de la conexión, en cada router
-- =============================================================================
ALTER TABLE routers_mikrotik
    ADD COLUMN IF NOT EXISTS conexion_estado   VARCHAR(12) NOT NULL DEFAULT 'up'
        CHECK (conexion_estado IN ('up', 'down')),
    -- Fallas seguidas desde la última respuesta. Vuelve a cero cuando contesta.
    ADD COLUMN IF NOT EXISTS conexion_fallas   INT NOT NULL DEFAULT 0,
    -- La primera falla de la racha actual. Vuelve a NULL cuando contesta.
    ADD COLUMN IF NOT EXISTS conexion_falla_en TIMESTAMP WITH TIME ZONE,
    -- Desde cuándo está en el estado actual. En 'down', es la primera falla de
    -- la racha y no la que lo confirmó: es la hora que importa.
    ADD COLUMN IF NOT EXISTS conexion_desde    TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS conexion_chequeo  TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS conexion_detalle  TEXT;

COMMENT ON COLUMN routers_mikrotik.conexion_estado IS
    'Si el servidor llega a la API del router. ''down'' solo después de varias fallas seguidas y fuera de la gracia de arranque.';
COMMENT ON COLUMN routers_mikrotik.conexion_fallas IS
    'Fallas seguidas desde la última respuesta. Al llegar al umbral de config_tareas.nms_router_fallas pasa a ''down''.';
COMMENT ON COLUMN routers_mikrotik.conexion_desde IS
    'Desde cuándo está en el estado actual. En ''down'', la hora de la primera falla de la racha.';


-- =============================================================================
-- 2. Los dos tiempos, en Ajustes → Tareas programadas
-- =============================================================================
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS nms_router_fallas  INT NOT NULL DEFAULT 3
        CHECK (nms_router_fallas BETWEEN 1 AND 20),
    ADD COLUMN IF NOT EXISTS nms_gracia_minutos INT NOT NULL DEFAULT 5
        CHECK (nms_gracia_minutos BETWEEN 1 AND 60);

COMMENT ON COLUMN config_tareas.nms_router_fallas IS
    'Cuántas pasadas seguidas sin respuesta de la API hacen falta para avisar que un router se cayó.';
COMMENT ON COLUMN config_tareas.nms_gracia_minutos IS
    'Minutos después de arrancar el servidor en los que no se cuenta ninguna falla: la VPN puede tardar en levantar.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, ip_host, conexion_estado, conexion_fallas, conexion_falla_en, conexion_desde,
--          conexion_chequeo, conexion_detalle
--     FROM routers_mikrotik;
--
--   SELECT nms_router_fallas, nms_gracia_minutos FROM config_tareas;
