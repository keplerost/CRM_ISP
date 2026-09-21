-- =============================================================================
-- Migración 27 — Salida y llegada del técnico
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 26. Es idempotente.
--
-- Hasta ahora el ticket decía "en ruta" y "en proceso" porque alguien apretó un
-- botón. Eso no distingue al técnico que salió y llegó del que marcó los dos
-- estados desde el taller.
--
-- Con la hora de salida, la de llegada y la ubicación desde donde se inició el
-- trabajo, tres preguntas dejan de tener respuesta de palabra:
--
--   * ¿Cuánto tardó en llegar desde que salió?
--   * ¿Llegó al domicilio o marcó desde otro lado?
--   * ¿Cuánto estuvo trabajando en el lugar?
--
-- La distancia se calcula, no se guarda: si mañana se corrige la coordenada del
-- domicilio, la comparación se corrige sola.
-- =============================================================================

ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS salida_at            TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS llegada_at           TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS llegada_lat          NUMERIC(10,7),
    ADD COLUMN IF NOT EXISTS llegada_lng          NUMERIC(10,7),
    -- Lo que el propio GPS dice que puede errarle. Bajo techo o entre cerros
    -- son 50 metros fáciles, y sin ese dato una llegada correcta parecería
    -- sospechosa.
    ADD COLUMN IF NOT EXISTS llegada_precision_m  NUMERIC(8,1);

COMMENT ON COLUMN tickets.salida_at IS
    'Cuándo el técnico marcó que salía hacia el domicilio.';
COMMENT ON COLUMN tickets.llegada_at IS
    'Cuándo marcó que llegó e inició el trabajo. Con la ubicación de ese momento al lado.';
COMMENT ON COLUMN tickets.llegada_precision_m IS
    'Margen de error que reportó el GPS. Sin esto, una llegada legítima con mala señal parece un fraude.';


-- =============================================================================
-- La vista calcula los tiempos y la distancia
-- =============================================================================
-- Hay que soltarla y rehacerla: se define con `t.*`, y las columnas nuevas se
-- agregan al final de la tabla, lo que correría el orden de las calculadas.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `email`, la cadena siguió y esta versión quedó
     * atrás: la 28 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_tickets'
           AND column_name = 'email'
    ) THEN
        RAISE NOTICE 'v_tickets ya está en su versión de la 28: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_tickets';
    EXECUTE $vista$
CREATE VIEW v_tickets WITH (security_invoker = true) AS
SELECT
    t.*,
    LPAD(t.numero::TEXT, 6, '0')          AS codigo,
    nap.nombre                            AS nap,
    torre.nombre                          AS torre,
    tec.nombre                            AS tecnico,
    tec.telefono                          AS tecnico_telefono,
    cua.nombre                            AS cuadrilla,
    c.nombre                              AS cliente,
    c.plan_id,
    c.estado                              AS estado_cliente,
    EXTRACT(EPOCH FROM (COALESCE(t.cerrado_at, NOW()) - t.created_at)) / 3600 AS horas_abierto,
    (t.estado NOT IN ('resuelto', 'cancelado')
     AND t.fecha_visita IS NOT NULL
     AND t.fecha_visita < CURRENT_DATE)   AS visita_atrasada,
    (SELECT COUNT(*) FROM ticket_adjuntos a WHERE a.ticket_id = t.id) AS adjuntos,

    -- Cuánto tardó en llegar y cuánto estuvo en el lugar.
    EXTRACT(EPOCH FROM (t.llegada_at - t.salida_at)) / 60 AS minutos_en_ruta,
    EXTRACT(EPOCH FROM (COALESCE(t.cerrado_at, NOW()) - t.llegada_at)) / 60 AS minutos_en_sitio,

    -- A cuántos metros del domicilio se inició el trabajo. Haversine a mano:
    -- traer una extensión de geometría para una cuenta de una línea sería
    -- cargar el proyecto con algo que no se usa en ningún otro lado.
    CASE
        WHEN t.llegada_lat IS NOT NULL AND t.latitud IS NOT NULL THEN
            ROUND((6371000 * 2 * ASIN(SQRT(
                POWER(SIN(RADIANS(t.llegada_lat - t.latitud) / 2), 2) +
                COS(RADIANS(t.latitud)) * COS(RADIANS(t.llegada_lat)) *
                POWER(SIN(RADIANS(t.llegada_lng - t.longitud) / 2), 2)
            )))::NUMERIC, 0)
    END AS llegada_distancia_m
FROM tickets t
LEFT JOIN puntos_red nap   ON nap.id   = t.nap_id
LEFT JOIN puntos_red torre ON torre.id = t.torre_id
LEFT JOIN tecnicos tec     ON tec.id   = t.tecnico_id
LEFT JOIN cuadrillas cua   ON cua.id   = t.cuadrilla_id
LEFT JOIN clientes c       ON c.id     = t.client_id
$vista$;
END $guarda$;

COMMENT ON VIEW v_tickets IS
    'Tickets con los nombres resueltos, los tiempos de atención y a qué distancia del domicilio se inició el trabajo.';


-- =============================================================================
-- Las horas se sellan solas
-- =============================================================================
-- Se ponen en la base y no en la pantalla: la hora del celular del técnico se
-- puede cambiar, y "salió 9:00, llegó 9:05" con el trabajo cerrado a las 9:07
-- no se puede sostener frente a un reclamo.
CREATE OR REPLACE FUNCTION ticket_sella_tiempos()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        IF NEW.estado = 'en_ruta' AND NEW.salida_at IS NULL THEN
            NEW.salida_at := NOW();
        END IF;

        IF NEW.estado = 'en_proceso' AND NEW.llegada_at IS NULL THEN
            NEW.llegada_at := NOW();
        END IF;

        -- Volver atrás borra el sello: si el técnico se equivocó de ticket y lo
        -- devuelve a "asignado", dejar la hora vieja haría que el próximo
        -- intento figure con un viaje que no existió.
        IF NEW.estado IN ('abierto', 'asignado') THEN
            NEW.salida_at  := NULL;
            NEW.llegada_at := NULL;
            NEW.llegada_lat := NULL;
            NEW.llegada_lng := NULL;
            NEW.llegada_precision_m := NULL;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ticket_tiempos ON tickets;
CREATE TRIGGER trg_ticket_tiempos
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION ticket_sella_tiempos();
