-- =============================================================================
-- Migración 190 — El ingreso, donde está el trabajo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué agrega ──
--
-- La foto de la 188 dice QUIÉN inició y a qué hora. No dice DÓNDE. Con la
-- coordenada al lado, el ingreso se puede contrastar contra el primer trabajo
-- agendado del día: si el técnico marca desde su casa a las siete y su primera
-- instalación está a doce kilómetros, eso se ve.
--
-- ── Se guarda la distancia ya calculada, no solo el punto ──
--
-- Se podría calcular al mirar, con las dos coordenadas. Se guarda igual, y por
-- una razón concreta: la agenda cambia. Si mañana la orden se reprograma, se
-- reasigna a otro técnico o se le corrige la ubicación, el cálculo de hoy daría
-- otro número — y estaríamos juzgando un ingreso de ayer contra un mapa de hoy.
--
-- `primer_trabajo_id` queda anotado por lo mismo: para poder decir contra QUÉ
-- se comparó, y no contra lo que hoy parezca ser el primer trabajo.
--
-- ── Nada de esto bloquea ──
--
-- Es la misma regla que ya tiene `RADIO_LLEGADA_M` en el código, con su comentario:
-- "250 m es holgado a propósito: la coordenada del abonado muchas veces se cargó
-- desde la vereda o desde el poste, y un GPS bajo techo se va cincuenta metros
-- sin esfuerzo. El número no bloquea nada, solo avisa."
--
-- Acá vale igual y con más motivo: el GPS del teléfono puede fallar, el técnico
-- puede no tener señal, y la primera orden del día puede no tener coordenada
-- cargada. En cualquiera de esos casos la jornada se abre igual y la distancia
-- queda en NULL, que significa "no se pudo saber" y NO "estaba lejos".
-- =============================================================================


-- ── 1. Dónde marcó ───────────────────────────────────────────────────────────

ALTER TABLE jornadas ADD COLUMN IF NOT EXISTS lat_ingreso NUMERIC(10, 7);
ALTER TABLE jornadas ADD COLUMN IF NOT EXISTS lng_ingreso NUMERIC(10, 7);
ALTER TABLE jornadas ADD COLUMN IF NOT EXISTS precision_ingreso_m INT;

COMMENT ON COLUMN jornadas.lat_ingreso IS
    'Dónde estaba el teléfono al iniciar la jornada. NULL si el GPS no respondió: la jornada se abre igual.';

COMMENT ON COLUMN jornadas.precision_ingreso_m IS
    'Radio de error que informó el GPS, en metros. Una distancia de 300 m con precisión de 400 m no dice nada, y sin este campo parecería que sí.';


-- ── 2. Contra qué se comparó ─────────────────────────────────────────────────

ALTER TABLE jornadas ADD COLUMN IF NOT EXISTS primer_trabajo_id UUID;
ALTER TABLE jornadas ADD COLUMN IF NOT EXISTS distancia_ingreso_m INT;

COMMENT ON COLUMN jornadas.primer_trabajo_id IS
    'La orden contra la que se midió el ingreso: la primera agendada del día para ese técnico con coordenada cargada. Se anota para saber contra QUÉ se comparó, porque la agenda cambia.';

COMMENT ON COLUMN jornadas.distancia_ingreso_m IS
    'Metros entre el ingreso y esa orden, calculados en el momento. NULL es "no se pudo saber" —sin GPS, sin señal o sin coordenada en la orden— y no "estaba lejos".';

/**
 * Sin llave foránea a `instalaciones`, a propósito.
 *
 * Una orden se puede cancelar y borrar; el registro de la jornada no tiene por
 * qué irse con ella ni impedir que se borre. Lo que importa acá es la distancia
 * que ya quedó anotada — el id es para poder rastrear el origen, no para
 * navegar hacia una fila que quizá ya no está.
 */


-- ── 3. La vista ──────────────────────────────────────────────────────────────

/**
 * Otra vez enumerada una por una.
 *
 * `CREATE OR REPLACE` solo acepta columnas nuevas AL FINAL, así que las
 * diecisiete que ya existían van en su orden exacto y las cinco de esta
 * migración van después. Ver la 189: el `SELECT j.*` original es lo que hizo
 * que la foto no apareciera, porque Postgres expande el comodín una sola vez,
 * al crear la vista.
 */
CREATE OR REPLACE VIEW v_jornadas WITH (security_invoker = true) AS
SELECT
    j.id,
    j.tecnico_id,
    j.fecha,
    j.vehiculo_id,
    j.km_inicio,
    j.km_fin,
    j.inicio_at,
    j.fin_at,
    j.notas,
    j.creado_en,

    t.nombre  AS tecnico,
    v.nombre  AS vehiculo,
    v.placa,
    (j.km_fin - j.km_inicio) AS km_recorridos,
    CASE WHEN j.inicio_at IS NOT NULL AND j.fin_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (j.fin_at - j.inicio_at)) / 60)::INT END AS minutos_jornada,

    j.foto_ingreso,
    j.foto_ingreso_at,

    -- Lo de la 190.
    j.lat_ingreso,
    j.lng_ingreso,
    j.precision_ingreso_m,
    j.primer_trabajo_id,
    j.distancia_ingreso_m
FROM jornadas j
LEFT JOIN tecnicos  t ON t.id = j.tecnico_id
LEFT JOIN vehiculos v ON v.id = j.vehiculo_id;

COMMENT ON VIEW v_jornadas IS
    'La jornada de cada técnico con su vehículo, kilómetros, foto de ingreso y dónde marcó respecto de su primer trabajo. Las columnas se enumeran una por una: con `j.*` la lista queda congelada al crear la vista y el siguiente ALTER TABLE no aparece acá.';
