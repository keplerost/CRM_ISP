-- =============================================================================
-- Migración 189 — `v_jornadas` no veía la foto
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── El error ──
--
-- La migración 188 agregó `foto_ingreso` y `foto_ingreso_at` a `jornadas` y dio
-- por sentado que `v_jornadas` las mostraría sola, porque está definida con
-- `SELECT j.*`. Es falso, y la 188 lo dice con todas las letras:
--
--     "v_jornadas no se toca. Está definida con j.*, así que las dos columnas
--      nuevas ya salen por ahí."
--
-- Postgres expande el `*` UNA VEZ, cuando se crea la vista, y guarda la lista
-- de columnas resuelta. Agregar una columna a la tabla después no la agrega a
-- la vista: la vista sigue devolviendo las diez que había el día que se creó.
--
-- Efecto: la pantalla de ingresos leía `foto_ingreso` de `v_jornadas` y recibía
-- `undefined` para todos. Ninguna consulta fallaba —la columna simplemente no
-- estaba— así que se veía como "todavía nadie subió una foto", que es
-- exactamente lo que uno espera ver el primer día. El error podría haber
-- sobrevivido semanas.
--
-- ── Por qué CREATE OR REPLACE y no DROP ──
--
-- `CREATE OR REPLACE VIEW` acepta columnas nuevas AL FINAL, y eso alcanza acá.
-- No acepta reordenar ni renombrar, así que las quince que ya existían van
-- enumeradas en su orden exacto y las dos nuevas van después.
--
-- Se enumeran una por una y no se vuelve a escribir `j.*` a propósito: con el
-- comodín, esta misma migración volvería a congelar una lista que el próximo
-- `ALTER TABLE` dejaría vieja otra vez, y el que la escriba va a creer —con
-- razón, leyendo el código— que no hacía falta tocar nada.
--
-- El `DROP` se evita porque `v_jornadas` la leen tres pantallas: soltarla y
-- recrearla deja una ventana en la que las tres devuelven error.
-- =============================================================================

CREATE OR REPLACE VIEW v_jornadas WITH (security_invoker = true) AS
SELECT
    -- Las diez de `jornadas`, en el orden en que las devolvía `j.*`.
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

    -- Las cinco calculadas, sin cambios.
    t.nombre  AS tecnico,
    v.nombre  AS vehiculo,
    v.placa,
    (j.km_fin - j.km_inicio) AS km_recorridos,
    CASE WHEN j.inicio_at IS NOT NULL AND j.fin_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (j.fin_at - j.inicio_at)) / 60)::INT END AS minutos_jornada,

    -- Lo de la 188, al final: es lo único que CREATE OR REPLACE permite agregar.
    j.foto_ingreso,
    j.foto_ingreso_at
FROM jornadas j
LEFT JOIN tecnicos  t ON t.id = j.tecnico_id
LEFT JOIN vehiculos v ON v.id = j.vehiculo_id;

COMMENT ON VIEW v_jornadas IS
    'La jornada de cada técnico con su vehículo, kilómetros y foto de ingreso. Las columnas se enumeran una por una: con `j.*` la lista queda congelada al crear la vista y el siguiente ALTER TABLE no aparece acá.';
