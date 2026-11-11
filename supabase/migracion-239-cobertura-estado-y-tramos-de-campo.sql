-- =============================================================================
-- Migración 239 — Cobertura, estado de la red y tramos levantados con GPS
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 232 (obras), la 234 (planta externa), la 237 y la 238.
--
-- ── Qué resuelve ──
--
-- 1. COBERTURA. Hasta dónde llega cada caja (`radio_cobertura_m`) y cuántos
--    puertos le quedan: el mapa pinta las zonas donde se puede vender.
--
-- 2. ESTADO DE LA RED. `v_planta_estado`: por caja, cuántas ONUs tiene, cuántas
--    están caídas o en LOS, su potencia promedio, si hay una alerta de
--    potencia degradándose (207) o un corte masivo abierto (174). El mapa la
--    pinta encima de la planta.
--
-- 3. TRAMOS CON GPS. La cuadrilla camina el tendido con el celular y la app
--    va marcando el recorrido; en cada poste toca "A" o "J", en cada reserva
--    pone los metros. Al terminar, `registrar_tramo_obra` lo guarda en la obra
--    y lo pasa al mapa como cable verificado en campo, con sus postes. Si la
--    obra sale de un proyecto (238), entra al proyecto: queda proyectado hasta
--    que se apruebe la obra, como el resto del diseño.
--
--    La cuadrilla no tiene permiso para editar la planta: la función, sí, y
--    solo para las obras que tiene asignadas.
-- =============================================================================


-- =============================================================================
-- 1. Hasta dónde llega una caja
-- =============================================================================
ALTER TABLE planta_optica
    -- La acometida más larga que se tiende desde una caja.
    ADD COLUMN IF NOT EXISTS radio_cobertura_m INT NOT NULL DEFAULT 200
        CHECK (radio_cobertura_m BETWEEN 20 AND 2000);


-- =============================================================================
-- 2. El estado de cada caja
-- =============================================================================
/**
 * Sin `security_invoker` a propósito: las alertas solo las lee quien configura
 * alertas, y el mapa necesita saber que hay una. El filtro va adentro: solo
 * quien edita la planta o ve el monitoreo.
 */
DROP VIEW IF EXISTS v_planta_estado;
CREATE VIEW v_planta_estado AS
SELECT e.id AS elemento_id,
       e.punto_id,
       COALESCE(o.onus, 0)   AS onus,
       COALESCE(o.caidas, 0) AS caidas,
       COALESCE(o.los, 0)    AS los,
       o.rx_promedio,
       o.rx_peor,
       (SELECT COUNT(*)::int FROM alerta_eventos a
         WHERE a.resuelto_en IS NULL AND a.entidad = 'nap' AND a.entidad_id = e.punto_id::text) AS alertas,
       (SELECT COUNT(*)::int FROM incidencias_masivas i
         WHERE i.punto_id = e.punto_id AND i.estado IN ('borrador', 'abierta')) AS cortes
  FROM planta_elementos e
  LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS onus,
             COUNT(*) FILTER (WHERE u.estado IN ('offline', 'los'))::int AS caidas,
             COUNT(*) FILTER (WHERE u.estado = 'los')::int AS los,
             ROUND(AVG(u.rx_power_dbm)::numeric, 2) AS rx_promedio,
             MIN(u.rx_power_dbm) AS rx_peor
        FROM onus u WHERE u.nap_id = e.punto_id
  ) o ON TRUE
 WHERE e.punto_id IS NOT NULL
   AND (gestiona_planta() OR puede_ver_monitoreo());

GRANT SELECT ON v_planta_estado TO authenticated;


-- =============================================================================
-- 3. Los tramos que levanta la cuadrilla
-- =============================================================================
CREATE TABLE IF NOT EXISTS obra_tramos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    obra_id     UUID NOT NULL REFERENCES obras_red(id) ON DELETE CASCADE,
    nombre      VARCHAR(150) NOT NULL,
    tipo        VARCHAR(12) NOT NULL DEFAULT 'distribucion'
                CHECK (tipo IN ('troncal', 'feeder', 'distribucion', 'drop', 'otro')),
    hilos       INT CHECK (hilos IS NULL OR hilos > 0),
    -- [[lat, lng], …] como lo marcó el GPS.
    ruta        JSONB NOT NULL CHECK (jsonb_typeof(ruta) = 'array' AND jsonb_array_length(ruta) >= 2),
    -- [{ tipo: 'poste'|'reserva'|'caja', herraje, metros, lat, lng, nota }]
    marcas      JSONB NOT NULL DEFAULT '[]',
    -- La precisión promedio del GPS: para saber cuánto creerle.
    precision_m NUMERIC(6,1),
    cable_id    UUID REFERENCES planta_cables(id) ON DELETE SET NULL,
    tecnico_id  UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    usuario_id  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    clave       UUID,
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_obra_tramos ON obra_tramos (obra_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_obra_tramos_clave ON obra_tramos (clave) WHERE clave IS NOT NULL;

ALTER TABLE obra_tramos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS obra_tramos_leer ON obra_tramos;
CREATE POLICY obra_tramos_leer ON obra_tramos FOR SELECT TO authenticated USING (ve_obra(obra_id));
REVOKE ALL ON obra_tramos FROM anon;
GRANT SELECT ON obra_tramos TO authenticated;

/**
 * Guarda el tramo y lo pone en el mapa: el cable, y un poste (o reserva) por
 * cada marca. Con la misma `p_clave` no se carga dos veces (el reintento sin
 * señal). Devuelve el id del cable.
 */
CREATE OR REPLACE FUNCTION registrar_tramo_obra(p_obra UUID, p_datos JSONB, p_clave UUID DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    d       JSONB := COALESCE(p_datos, '{}'::jsonb);
    v_obra  obras_red%ROWTYPE;
    v_proy  UUID;
    v_cable UUID;
    v_prev  obra_tramos%ROWTYPE;
    v_nom   TEXT := NULLIF(BTRIM(d->>'nombre'), '');
    m       JSONB;
    n       INT := 0;
BEGIN
    IF p_clave IS NOT NULL THEN
        SELECT * INTO v_prev FROM obra_tramos WHERE clave = p_clave;
        IF FOUND THEN RETURN v_prev.cable_id; END IF;
    END IF;

    v_obra := obra_abierta_para_mi(p_obra);
    IF jsonb_typeof(d->'ruta') <> 'array' OR jsonb_array_length(d->'ruta') < 2 THEN
        RAISE EXCEPTION 'El tramo necesita al menos dos puntos de GPS.';
    END IF;
    IF COALESCE(d->>'tipo', 'distribucion') NOT IN ('troncal', 'feeder', 'distribucion', 'drop', 'otro') THEN
        RAISE EXCEPTION 'Tipo de cable desconocido.';
    END IF;
    v_nom := COALESCE(v_nom, 'Tramo de la obra #' || v_obra.numero);

    -- De un proyecto todavía en obra: entra al diseño, proyectado, y pasa a
    -- existente cuando se apruebe la obra (238).
    SELECT id INTO v_proy FROM planta_proyectos WHERE obra_id = p_obra AND estado = 'en_obra';

    INSERT INTO planta_cables (nombre, tipo, hilos, ruta, estado, verificacion, descripcion, proyecto_id, origen)
    VALUES (LEFT(v_nom, 150), COALESCE(d->>'tipo', 'distribucion'), NULLIF(d->>'hilos', '')::int, d->'ruta',
            CASE WHEN v_proy IS NOT NULL THEN 'proyectado' ELSE 'existente' END, 'campo',
            'Levantado con GPS en la obra #' || v_obra.numero, v_proy,
            jsonb_build_object('obra', v_obra.numero, 'precision_m', d->'precision_m'))
    RETURNING id INTO v_cable;

    FOR m IN SELECT * FROM jsonb_array_elements(COALESCE(d->'marcas', '[]'))
    LOOP
        IF (m->>'lat') IS NULL OR (m->>'lng') IS NULL THEN CONTINUE; END IF;
        n := n + 1;
        INSERT INTO planta_elementos (tipo, nombre, latitud, longitud, estado, verificacion, herraje, metros,
                                      descripcion, proyecto_id, icono)
        VALUES (CASE WHEN m->>'tipo' = 'reserva' THEN 'reserva' ELSE 'poste' END,
                CASE WHEN m->>'tipo' = 'reserva' THEN 'Reserva ' ELSE 'Poste ' END || v_obra.numero || '-' || n,
                (m->>'lat')::numeric, (m->>'lng')::numeric,
                CASE WHEN v_proy IS NOT NULL THEN 'proyectado' ELSE 'existente' END, 'campo',
                NULLIF(m->>'herraje', ''), NULLIF(m->>'metros', '')::numeric,
                NULLIF(BTRIM(m->>'nota'), ''), v_proy,
                CASE m->>'herraje' WHEN 'A' THEN 'poste_a' WHEN 'J' THEN 'poste_j' END);
    END LOOP;

    INSERT INTO obra_tramos (obra_id, nombre, tipo, hilos, ruta, marcas, precision_m, cable_id, tecnico_id, usuario_id, clave)
    VALUES (p_obra, LEFT(v_nom, 150), COALESCE(d->>'tipo', 'distribucion'), NULLIF(d->>'hilos', '')::int,
            d->'ruta', COALESCE(d->'marcas', '[]'), NULLIF(d->>'precision_m', '')::numeric,
            v_cable, mi_tecnico_id(), mi_usuario_id(), p_clave);

    INSERT INTO obra_eventos (obra_id, tipo, texto, usuario_id, tecnico_id)
    VALUES (p_obra, 'nota', format('Tramo levantado con GPS: %s (%s m, %s marcas)', v_nom,
                                   (SELECT ROUND(longitud_m) FROM planta_cables WHERE id = v_cable), n),
            mi_usuario_id(), mi_tecnico_id());

    RETURN v_cable;
END;
$$;

REVOKE ALL ON FUNCTION registrar_tramo_obra(UUID, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION registrar_tramo_obra(UUID, JSONB, UUID) TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT o.numero, t.nombre, ROUND(c.longitud_m) AS m, jsonb_array_length(t.marcas) AS marcas
--     FROM obra_tramos t JOIN obras_red o ON o.id = t.obra_id LEFT JOIN planta_cables c ON c.id = t.cable_id;
