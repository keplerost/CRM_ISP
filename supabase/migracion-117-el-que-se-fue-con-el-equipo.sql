-- =============================================================================
-- Migración 117 — Un motivo de baja para el que se fue con el equipo puesto
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Por qué falta uno ──
--
-- Al cerrar la primera ficha de verdad quedó a la vista un hueco en el catálogo.
-- El caso más común de todos —el abonado se mudó, no avisó, y la ONT se fue con
-- él— no tenía dónde encajar:
--
--   «Mudanza fuera de cobertura»  no le cuenta al vendedor, pero suena a que
--                                 avisó y se fue de la zona. No es el caso.
--   «Abandono temprano»           le cuenta, pero no dice nada del equipo.
--
-- Y la diferencia importa porque estos motivos deciden dos cosas distintas: qué
-- se lee en la ficha dentro de un año, y si la pérdida le cuenta al vendedor en
-- la calidad de su cohorte —que es plata de su bono—.
--
-- ── Por qué SÍ le cuenta al vendedor ──
--
-- Porque la calidad de la cohorte mide una sola cosa: cuántos de los que trajo
-- siguen siendo abonados a los noventa días. Un cliente que se fue del domicilio
-- a los cuatro meses sin avisar es exactamente eso, se haya llevado el equipo o
-- no.
--
-- Lo del equipo se cuenta aparte, en el valor perdido de la cartera. Sumarlo
-- también a la calidad sería castigar dos veces el mismo hecho.
--
-- Si en la práctica resulta injusto, es una línea: `afecta_calidad = FALSE`.
-- =============================================================================

INSERT INTO motivos_baja (nombre, afecta_calidad, orden, activo)
VALUES ('Se mudó sin avisar y no devolvió el equipo', TRUE, 6, TRUE)
ON CONFLICT (nombre) DO UPDATE
   SET afecta_calidad = EXCLUDED.afecta_calidad,
       activo = TRUE;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, afecta_calidad FROM motivos_baja WHERE activo ORDER BY orden;
--
--   -- Y el efecto de elegir uno u otro, sobre un abonado ya dado de baja:
--   SELECT calidad_estado, calidad_motivo FROM comision_ventas WHERE cliente_id = '<id>';
