-- =============================================================================
-- Migración 45 — La misma zona escrita de dos formas
-- =============================================================================
-- El filtro de zonas mostraba "Zone 1" con 67 ONUs y "Zone_1" con 8. Es la
-- misma zona: el guion bajo es el separador de la descripción del equipo, no
-- parte del texto, y en un camino de importación se sacaba y en otro no.
--
-- El efecto no era cosmético. Filtrar por zona para ver cuántos abonados se
-- quedaron sin servicio en un corte devolvía 67 y dejaba 8 afuera, sin que nada
-- avisara de que faltaban.
--
-- El parser ya quedó corregido; esto arregla lo que se guardó antes.
-- =============================================================================

UPDATE onus
SET zona = BTRIM(REPLACE(zona, '_', ' '))
WHERE zona LIKE '%\_%';

UPDATE onus
SET direccion = BTRIM(REPLACE(direccion, '_', ' '))
WHERE direccion LIKE '%\_%';

-- Los espacios repetidos que pueda haber dejado un separador doble.
UPDATE onus
SET zona = REGEXP_REPLACE(zona, '\s+', ' ', 'g')
WHERE zona ~ '\s{2,}';
