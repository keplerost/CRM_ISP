-- =============================================================================
-- Migración 29 — Los contadores desde donde se mide el consumo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 28. Es idempotente.
--
-- El MikroTik no dice "este abonado bajó 4 GB hoy". Dice "esta cola lleva
-- 812.394.221 bytes desde que se creó". El consumo del día es la diferencia
-- entre dos lecturas, así que hay que guardar la anterior.
--
-- Guardar cada lectura sería una tabla de millones de filas para responder algo
-- que siempre se pregunta por día. Acá queda solo la última: lo acumulado ya
-- está sumado en `consumo_diario`.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consumo_contadores (
    client_id UUID PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,

    -- Lo que marcaba el equipo la última vez que se miró.
    subida_bytes BIGINT NOT NULL DEFAULT 0,
    bajada_bytes BIGINT NOT NULL DEFAULT 0,

    -- De dónde se leyó, para no mezclar un contador de cola con uno de sesión:
    -- son escalas distintas y restarlos daría un salto absurdo.
    origen VARCHAR(40),
    fuente VARCHAR(15) NOT NULL DEFAULT 'mikrotik',

    leido_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE consumo_contadores IS
    'Última lectura cruda de los contadores del equipo. El consumo del día es la diferencia contra esto.';
COMMENT ON COLUMN consumo_contadores.origen IS
    'Qué se leyó: el nombre de la cola o de la sesión. Si cambia, el contador arrancó de cero y no se resta.';


-- =============================================================================
-- Sumar consumo sin pisar lo que ya había
-- =============================================================================
-- El recolector corre varias veces por día. Si hiciera un UPDATE con el total,
-- una corrida tardía borraría lo acumulado por las anteriores; si insertara
-- siempre, habría diez filas del mismo día.
CREATE OR REPLACE FUNCTION sumar_consumo(
    p_client_id UUID,
    p_fecha     DATE,
    p_subida    BIGINT,
    p_bajada    BIGINT,
    p_estado    TEXT DEFAULT 'activo',
    p_fuente    TEXT DEFAULT 'mikrotik'
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO consumo_diario (client_id, fecha, subida_bytes, bajada_bytes, estado_servicio, fuente)
    VALUES (p_client_id, p_fecha, GREATEST(p_subida, 0), GREATEST(p_bajada, 0), p_estado, p_fuente)
    ON CONFLICT (client_id, fecha) DO UPDATE
        SET subida_bytes = consumo_diario.subida_bytes + GREATEST(EXCLUDED.subida_bytes, 0),
            bajada_bytes = consumo_diario.bajada_bytes + GREATEST(EXCLUDED.bajada_bytes, 0),
            -- El estado del día es el peor que tuvo: si estuvo cortado a la
            -- mañana, el día fue de corte aunque a la tarde volviera.
            estado_servicio = CASE
                WHEN 'cortado' IN (consumo_diario.estado_servicio, EXCLUDED.estado_servicio) THEN 'cortado'
                WHEN 'suspendido' IN (consumo_diario.estado_servicio, EXCLUDED.estado_servicio) THEN 'suspendido'
                WHEN 'promesa' IN (consumo_diario.estado_servicio, EXCLUDED.estado_servicio) THEN 'promesa'
                ELSE 'activo'
            END,
            updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sumar_consumo IS
    'Acumula el consumo del día sin pisar lo que ya se había medido. El recolector puede correr las veces que haga falta.';

GRANT EXECUTE ON FUNCTION sumar_consumo(UUID, DATE, BIGINT, BIGINT, TEXT, TEXT) TO authenticated, service_role;

ALTER TABLE consumo_contadores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_all_consumo_contadores ON consumo_contadores;
CREATE POLICY auth_all_consumo_contadores ON consumo_contadores
    FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);
