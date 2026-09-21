-- =============================================================================
-- Migración 47 — La velocidad se limita por sentido, no con un solo número
-- =============================================================================
-- Un plan guardaba UN índice de traffic table y se usaba para las dos
-- direcciones. El equipo necesita dos, y sus tablas vienen justamente en pares:
--
--     12 SMARTOLT-PLAN_BASICO-DOWN     13 SMARTOLT-PLAN_BASICO-UP
--     14 SMARTOLT-PLAN_HOME-UP         15 SMARTOLT-PLAN_HOME-DOWN
--     16 SMARTOLT-PLAN_PRO-DOWN        17 SMARTOLT-PLAN_PRO-UP
--
-- Con un solo número no se puede expresar un plan asimétrico —100 de bajada y
-- 10 de subida— que es la forma de casi todos los planes residenciales. Al
-- aplicarlo, el abonado quedaba con el límite de bajada también en la subida.
--
-- Se descubrió dando de alta a un abonado real: el service-port quedó con la
-- tabla 10 en los dos sentidos, mientras el resto de la red usa 10/11.
-- =============================================================================

ALTER TABLE planes_velocidad
    -- Qué tabla del equipo limita cada sentido. Los nombres son los del
    -- comando, no los de la calle: "inbound" es lo que SUBE el abonado y
    -- "outbound" lo que BAJA.
    ADD COLUMN IF NOT EXISTS traffic_table_subida INT,
    ADD COLUMN IF NOT EXISTS traffic_table_bajada INT,

    -- Cuándo se comprobó contra el equipo que esos índices existen de verdad.
    --
    -- Hace falta porque dos de los tres planes cargados apuntaban a tablas
    -- inexistentes —la 30 y la 50, puestas con el número del plan en vez del
    -- índice real— y nadie se enteró: el error solo aparece al dar de alta a
    -- alguien, cuando el equipo rechaza el service-port y la ONT queda
    -- registrada sin pasar tráfico.
    ADD COLUMN IF NOT EXISTS tablas_verificadas_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tablas_verificadas_en UUID REFERENCES olts(id) ON DELETE SET NULL;

-- Lo que ya había se copia a los dos sentidos: es exactamente lo que el sistema
-- venía haciendo. No se inventa un valor mejor — si estaba mal, sigue mal y la
-- verificación lo va a marcar.
UPDATE planes_velocidad
SET traffic_table_subida = traffic_table_index,
    traffic_table_bajada = traffic_table_index
WHERE traffic_table_index IS NOT NULL
  AND traffic_table_subida IS NULL
  AND traffic_table_bajada IS NULL;

COMMENT ON COLUMN planes_velocidad.traffic_table_subida IS
    'Índice de traffic table del equipo para lo que SUBE el abonado ("inbound" en el comando).';

COMMENT ON COLUMN planes_velocidad.traffic_table_bajada IS
    'Índice para lo que BAJA ("outbound"). Separado de la subida porque casi todos los planes son asimétricos.';

COMMENT ON COLUMN planes_velocidad.tablas_verificadas_at IS
    'Cuándo se comprobó contra la OLT que esos índices existen. Sin verificar, un alta puede fallar dejando la ONT registrada y sin tráfico.';

COMMENT ON COLUMN planes_velocidad.traffic_table_index IS
    'OBSOLETA: quedó para no romper lo que la leía. La velocidad se define con traffic_table_subida y traffic_table_bajada.';
