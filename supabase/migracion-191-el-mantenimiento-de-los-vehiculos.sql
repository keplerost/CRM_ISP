-- =============================================================================
-- Migración 191 — El mantenimiento de los vehículos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── El problema ──
--
-- "Se olvidan cuándo cambiar el aceite." Y es esperable: el que maneja no
-- lleva la cuenta de los kilómetros de un motor, lleva la cuenta de los
-- trabajos que tiene que hacer. El olvido no se arregla pidiéndole que se
-- acuerde mejor; se arregla avisándole en el único momento del día en que ya
-- está mirando el tablero — cuando abre la jornada.
--
-- ── Por qué el odómetro NO se mueve de `jornadas` ──
--
-- Se evaluó sacarlo a una tabla propia. Es la respuesta equivocada: `v_vehiculos`
-- ya deriva el odómetro actual de ahí —`MAX(km_fin, km_inicio)`— y de eso sale
-- toda la predicción de combustible que ya funciona. Moverlo la rompería, y
-- además le agregaría al técnico una segunda carga diaria, que va a cumplir
-- peor que la que ya hace.
--
-- El número está bien donde está. Lo que falta es esta capa, que lo lee.
--
-- ── Por qué dos criterios y no solo kilómetros ──
--
-- El aceite y los filtros van por kilómetros. La revisión técnica y la
-- matrícula van por FECHA, y no les importa si el vehículo se usó. Un sistema
-- que solo contara kilómetros dejaría vencer la matrícula de la camioneta que
-- estuvo tres meses parada.
--
-- Cada tipo puede tener uno de los dos, o los dos. Con los dos, vence el que
-- llegue primero — que es como funciona en el taller.
-- =============================================================================


-- ── 1. Qué se le hace a un vehículo ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mantenimiento_tipos (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clave      VARCHAR(40) UNIQUE NOT NULL,
    nombre     VARCHAR(80) NOT NULL,

    /**
     * El intervalo por defecto. Cualquiera de los dos puede ser NULL, pero no
     * los dos: un tipo sin intervalo no se puede vencer y no avisaría nunca —
     * quedaría en la lista dando la impresión de que se está controlando.
     */
    cada_km    INT CHECK (cada_km IS NULL OR cada_km > 0),
    cada_meses INT CHECK (cada_meses IS NULL OR cada_meses > 0),

    orden      INT NOT NULL DEFAULT 100,
    activo     BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT mantenimiento_tipos_intervalo
        CHECK (cada_km IS NOT NULL OR cada_meses IS NOT NULL)
);

COMMENT ON TABLE mantenimiento_tipos IS
    'El catálogo de servicios: aceite, filtros, revisión. Con su intervalo por defecto, en kilómetros, en meses o en los dos.';

/**
 * Los tres que se usan hoy. `ON CONFLICT DO NOTHING`: si el ISP ya ajustó los
 * intervalos, no se los pisamos al volver a correr esto.
 *
 * Los números son un punto de partida razonable, no una recomendación técnica:
 * el intervalo real lo dice el manual del vehículo y el aceite que se use. Se
 * editan desde la pantalla.
 */
INSERT INTO mantenimiento_tipos (clave, nombre, cada_km, cada_meses, orden)
VALUES
    ('aceite',   'Cambio de aceite',              5000,  6,  10),
    ('filtros',  'Filtros (aire, aceite, combustible)', 10000, 12, 20),
    ('revision', 'Revisión técnica / matrícula',  NULL,  12, 30)
ON CONFLICT (clave) DO NOTHING;


-- ── 2. El intervalo de ESTE vehículo, cuando difiere ─────────────────────────

/**
 * Una moto y una camioneta no cambian el aceite cada los mismos kilómetros.
 *
 * La alternativa era poner el intervalo en el tipo y listo, y obligar a crear
 * "aceite moto" y "aceite camioneta" como tipos distintos. Se descartó: el día
 * que entre el tercer vehículo, el catálogo se llena de variantes del mismo
 * servicio y la pantalla de "qué le falta a cada uno" deja de poder agruparlos.
 *
 * Acá solo se guardan las excepciones. Sin fila, manda el valor del tipo.
 */
CREATE TABLE IF NOT EXISTS mantenimiento_intervalos (
    vehiculo_id UUID NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
    tipo_id     UUID NOT NULL REFERENCES mantenimiento_tipos(id) ON DELETE CASCADE,
    cada_km     INT CHECK (cada_km IS NULL OR cada_km > 0),
    cada_meses  INT CHECK (cada_meses IS NULL OR cada_meses > 0),

    PRIMARY KEY (vehiculo_id, tipo_id),
    CONSTRAINT mantenimiento_intervalos_alguno
        CHECK (cada_km IS NOT NULL OR cada_meses IS NOT NULL)
);


-- ── 3. Lo que ya se hizo ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mantenimientos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehiculo_id UUID NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
    tipo_id     UUID NOT NULL REFERENCES mantenimiento_tipos(id) ON DELETE RESTRICT,

    fecha       DATE NOT NULL DEFAULT CURRENT_DATE,

    /**
     * El odómetro del día que se hizo, y por qué es obligatorio para los que
     * van por kilómetros: sin él no hay contra qué contar los 5.000 siguientes.
     * Para la matrícula no hace falta, y por eso la columna admite NULL.
     */
    odometro    INT CHECK (odometro IS NULL OR odometro >= 0),

    costo       NUMERIC(10, 2) CHECK (costo IS NULL OR costo >= 0),
    taller      VARCHAR(100),
    nota        TEXT,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mantenimientos_vehiculo_idx
    ON mantenimientos (vehiculo_id, tipo_id, fecha DESC);

COMMENT ON TABLE mantenimientos IS
    'Cada servicio hecho: cuándo, con qué odómetro y cuánto costó. El último de cada tipo es contra el que se cuenta el próximo.';


-- ── 4. Qué le falta a cada vehículo ──────────────────────────────────────────

/**
 * Una fila por vehículo y tipo activo, con lo que falta.
 *
 * ── Por qué los NULL son distintos de los ceros ──
 *
 * `km_restantes` en NULL no es "le toca ya": es "todavía no se puede saber",
 * porque ese tipo no va por kilómetros, o porque nunca se registró uno y no hay
 * desde dónde contar. Mezclarlo con el cero pondría en rojo a todos los
 * vehículos el día que se estrena la pantalla, y nadie volvería a mirarla.
 *
 * ── Por qué vence el que llegue primero ──
 *
 * Un tipo con los dos intervalos —aceite cada 5.000 km o cada 6 meses— vence
 * con el primero que se cumpla. Es como funciona en el taller: el aceite se
 * degrada con el tiempo aunque el vehículo no se use.
 */
CREATE OR REPLACE VIEW v_mantenimiento WITH (security_invoker = true) AS
WITH ultimo AS (
    SELECT DISTINCT ON (vehiculo_id, tipo_id)
           vehiculo_id, tipo_id, fecha, odometro
      FROM mantenimientos
     ORDER BY vehiculo_id, tipo_id, fecha DESC, creado_en DESC
),
odometro_hoy AS (
    SELECT vehiculo_id, MAX(GREATEST(COALESCE(km_fin, 0), COALESCE(km_inicio, 0))) AS km
      FROM jornadas WHERE vehiculo_id IS NOT NULL GROUP BY vehiculo_id
)
SELECT
    v.id                                   AS vehiculo_id,
    v.nombre                               AS vehiculo,
    v.placa,
    t.id                                   AS tipo_id,
    t.clave,
    t.nombre                               AS tipo,
    t.orden,

    -- El intervalo efectivo: el del vehículo si lo tiene, si no el del tipo.
    COALESCE(i.cada_km, t.cada_km)         AS cada_km,
    COALESCE(i.cada_meses, t.cada_meses)   AS cada_meses,

    u.fecha                                AS ultimo_el,
    u.odometro                             AS ultimo_odometro,
    o.km                                   AS odometro_actual,

    -- Cuántos kilómetros faltan. NULL si el tipo no va por km o si nunca se
    -- hizo uno con odómetro anotado.
    CASE
        WHEN COALESCE(i.cada_km, t.cada_km) IS NULL THEN NULL
        WHEN u.odometro IS NULL OR o.km IS NULL     THEN NULL
        ELSE (u.odometro + COALESCE(i.cada_km, t.cada_km)) - o.km
    END                                    AS km_restantes,

    -- Cuántos días faltan. NULL si el tipo no va por fecha o si nunca se hizo.
    CASE
        WHEN COALESCE(i.cada_meses, t.cada_meses) IS NULL THEN NULL
        WHEN u.fecha IS NULL                              THEN NULL
        ELSE (u.fecha + (COALESCE(i.cada_meses, t.cada_meses) || ' months')::INTERVAL)::DATE
             - CURRENT_DATE
    END                                    AS dias_restantes,

    -- Nunca se le hizo: no está vencido, está sin registrar. Son cosas
    -- distintas y la pantalla las muestra distinto.
    (u.fecha IS NULL)                      AS sin_registro
FROM vehiculos v
CROSS JOIN mantenimiento_tipos t
LEFT JOIN mantenimiento_intervalos i ON i.vehiculo_id = v.id AND i.tipo_id = t.id
LEFT JOIN ultimo u                   ON u.vehiculo_id = v.id AND u.tipo_id = t.id
LEFT JOIN odometro_hoy o             ON o.vehiculo_id = v.id
WHERE v.activo AND t.activo;

COMMENT ON VIEW v_mantenimiento IS
    'Qué le falta a cada vehículo activo, por tipo de servicio. km_restantes y dias_restantes en NULL significan "no se puede saber", no "le toca ya".';


-- ── 5. Permisos ──────────────────────────────────────────────────────────────

ALTER TABLE mantenimiento_tipos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mantenimiento_intervalos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mantenimientos            ENABLE ROW LEVEL SECURITY;

/**
 * Lectura para cualquiera con sesión, escritura también.
 *
 * Es el mismo criterio que ya tienen `vehiculos` y `jornadas`: quién puede
 * ABRIR la pantalla lo decide el permiso de la ruta. Acá no se protege un dato
 * sensible —son kilómetros de una camioneta— y una política más estricta
 * dejaría al técnico sin poder registrar el cambio de aceite que acaba de
 * hacer, que es justo lo que se quiere que registre.
 */
DROP POLICY IF EXISTS auth_all_mantenimiento_tipos ON mantenimiento_tipos;
CREATE POLICY auth_all_mantenimiento_tipos ON mantenimiento_tipos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS auth_all_mantenimiento_intervalos ON mantenimiento_intervalos;
CREATE POLICY auth_all_mantenimiento_intervalos ON mantenimiento_intervalos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS auth_all_mantenimientos ON mantenimientos;
CREATE POLICY auth_all_mantenimientos ON mantenimientos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
