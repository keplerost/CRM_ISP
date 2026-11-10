-- =============================================================================
-- Migración 231: el integrante que sale por su cuenta, y el vehículo sin odómetro
-- =============================================================================
--
-- En TROOPER, Byron muchas veces sale solo en la moto. Hasta acá el vehículo y
-- los kilómetros de una cuadrilla los cargaba SOLO el jefe de grupo (208): tres
-- técnicos en la misma camioneta cargando cada uno sumaban el recorrido tres
-- veces. Pero el que sale aparte va en otro vehículo, y ese uso no quedaba en
-- ningún lado.
--
--   1. jornadas.separado: "hoy salgo por mi cuenta". Con eso, el integrante
--      registra su propio vehículo, aunque su cuadrilla tenga jefe.
--
--   2. vehiculos_sin_odometro: la moto no tiene tablero que marque los
--      kilómetros. Se registra con qué salió y su ingreso, sin km: pedirle un
--      número que no existe sería obligarlo a inventarlo.
--
--      Es una tabla aparte y no una columna de `vehiculos` a propósito:
--      `v_vehiculos` se arma con `v.*`, y una columna nueva en la tabla la
--      desordenaría si alguien vuelve a correr la migración que la crea.
--
-- Idempotente: se puede correr más de una vez.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vehiculos_sin_odometro (
    vehiculo_id UUID PRIMARY KEY REFERENCES vehiculos(id) ON DELETE CASCADE,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE vehiculos_sin_odometro IS
    'Los vehículos cuyo tablero no marca los kilómetros (la moto): la jornada registra el vehículo sin km.';

ALTER TABLE vehiculos_sin_odometro ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vehiculos_sin_odometro_leer ON vehiculos_sin_odometro;
CREATE POLICY vehiculos_sin_odometro_leer ON vehiculos_sin_odometro
    FOR SELECT TO authenticated USING (TRUE);
-- Quien da de alta los vehículos (la misma regla que `vehiculos`).
DROP POLICY IF EXISTS vehiculos_sin_odometro_escritura ON vehiculos_sin_odometro;
CREATE POLICY vehiculos_sin_odometro_escritura ON vehiculos_sin_odometro
    FOR ALL TO authenticated USING (cartera_completa()) WITH CHECK (cartera_completa());
REVOKE ALL ON vehiculos_sin_odometro FROM anon;
GRANT SELECT, INSERT, DELETE ON vehiculos_sin_odometro TO authenticated;

ALTER TABLE jornadas ADD COLUMN IF NOT EXISTS separado BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN jornadas.separado IS
    'El integrante de una cuadrilla que ese día salió por su cuenta: registra su propio vehículo.';

/**
 * La misma regla de la 208, con una excepción: el que sale por su cuenta carga
 * su vehículo. Los que van en la camioneta siguen sin poder (la carga el jefe).
 */
CREATE OR REPLACE FUNCTION controlar_km_jornada()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_jefe TEXT;
BEGIN
    -- La cuadrilla con la que salió, para los reportes. La primera que integra.
    IF NEW.cuadrilla_id IS NULL THEN
        SELECT cuadrilla_id INTO NEW.cuadrilla_id
          FROM cuadrilla_miembros WHERE tecnico_id = NEW.tecnico_id
         ORDER BY (rol = 'lider') DESC LIMIT 1;
    END IF;

    IF (NEW.vehiculo_id IS NOT NULL OR NEW.km_inicio IS NOT NULL OR NEW.km_fin IS NOT NULL)
       AND (TG_OP = 'INSERT'
            OR NEW.vehiculo_id IS DISTINCT FROM OLD.vehiculo_id
            OR NEW.km_inicio  IS DISTINCT FROM OLD.km_inicio
            OR NEW.km_fin     IS DISTINCT FROM OLD.km_fin)
       AND NOT NEW.separado
       AND NOT puede_cargar_km(NEW.tecnico_id, NEW.fecha) THEN
        SELECT t.nombre INTO v_jefe FROM tecnicos t
         WHERE t.id = jefe_de_grupo(NEW.cuadrilla_id, NEW.fecha);
        RAISE EXCEPTION 'El vehículo y los kilómetros los registra el jefe de grupo%. Si hoy salís por tu cuenta, marcalo en Jornada.',
            COALESCE(' (' || v_jefe || ')', '')
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_km_jornada ON jornadas;
CREATE TRIGGER trg_km_jornada
    BEFORE INSERT OR UPDATE ON jornadas
    FOR EACH ROW EXECUTE FUNCTION controlar_km_jornada();


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT j.fecha, t.nombre, v.nombre AS vehiculo, j.separado, j.km_inicio
--     FROM jornadas j JOIN tecnicos t ON t.id = j.tecnico_id
--     LEFT JOIN vehiculos v ON v.id = j.vehiculo_id
--    WHERE j.separado ORDER BY j.fecha DESC;
