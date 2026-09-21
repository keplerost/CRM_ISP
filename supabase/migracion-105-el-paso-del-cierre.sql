-- =============================================================================
-- Migración 105 — El paso 6 del alta en campo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El error ──
--
--     new row for relation "instalaciones" violates check constraint
--     "instalaciones_paso_check"
--
-- Aparece al guardar la conformidad, en el último paso del alta en campo.
--
-- ── Por qué pasa ──
--
-- La restricción la puso la 31, cuando el alta tenía cinco pasos: `paso BETWEEN
-- 0 AND 5`. Después el flujo creció —el material se registra antes del cierre— y
-- la app pasó a manejar seis: `pasoAlcanzado()` devuelve 6 cuando la orden ya
-- tiene firma, y `PasoCierre` guarda 6 por la misma razón que explica su
-- comentario:
--
--     "6 desde que el material se registra antes del cierre: dejarlo en 5 haría
--      que una orden ya firmada reabra en el paso de materiales."
--
-- La restricción se quedó en cinco. Cada vez que un técnico firmaba, la base
-- rechazaba la fila.
--
-- ── Por qué no se vio antes ──
--
-- Porque para llegar al cierre hay que pasar por las pruebas de salida, y en
-- esta instalación ninguna orden había llegado tan lejos. El primer alta que
-- completó el circuito se estrelló contra esto — y en el peor momento: la firma
-- es el dato más caro de recuperar de toda la orden, porque exige volver al
-- domicilio del abonado.
--
-- ── Por qué se amplía la restricción y no se cambia la app ──
--
-- Porque el 6 de la app significa algo y el 5 de la base también. `paso` es
-- "hasta dónde llegó el técnico" y llega hasta seis; `finalizar_alta_instalacion`
-- escribe 5 al cerrar, que es "el alta está hecha". Los dos valores conviven sin
-- pisarse: la app navega por los datos —`pasoAlcanzado()` mira la firma, las
-- pruebas, el equipo— y no por este contador.
--
-- Bajar la app a 5 arreglaría el síntoma y devolvería el problema que el 6
-- resuelve: una orden firmada reabriendo en materiales.
-- =============================================================================

ALTER TABLE instalaciones DROP CONSTRAINT IF EXISTS instalaciones_paso_check;

ALTER TABLE instalaciones
    ADD CONSTRAINT instalaciones_paso_check CHECK (paso BETWEEN 0 AND 6);

COMMENT ON COLUMN instalaciones.paso IS
    'Hasta qué paso del alta en campo llegó el técnico, de 0 a 6. El 6 es "firmada": lo escribe el cierre para que una orden ya conformada no reabra en materiales. Al finalizar, la base lo deja en 5, que significa "alta hecha".';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- La restricción nueva:
--   SELECT pg_get_constraintdef(oid)
--     FROM pg_constraint WHERE conname = 'instalaciones_paso_check';
--   -- → CHECK ((paso >= 0) AND (paso <= 6))
--
--   -- Y que el cierre ya no la viole:
--   UPDATE instalaciones SET paso = 6 WHERE id = '<la orden>';
