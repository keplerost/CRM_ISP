-- =============================================================================
-- Migración 185 — La ONU atada a su modelo del catálogo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué está desconectado hoy ──
--
-- `onus.modelo` guarda el TEXTO que reportó la ONT —"GN256VH"— y `tipos_ont` es
-- el catálogo con lo que el ISP sabe de ese modelo: marca, cuántos puertos
-- Ethernet, si tiene WiFi, si soporta TR-069, su foto.
--
-- Los dos existen y NO se hablan. `onus.tipo_ont_id` solo se llena cuando
-- alguien aprovisiona a mano desde la pantalla de la OLT y lo elige del
-- desplegable; el alta en campo, la importación y la sincronización dejan la
-- columna en NULL.
--
-- La consecuencia se ve en la ficha del abonado: dice "GN256VH · Genérica ·
-- 4 Ethernet · sin WiFi", y si alguien corrige la marca en Tipos de ONU la
-- ficha no se entera. Peor: parece que el sistema "no deja editar", cuando lo
-- que pasa es que está mirando otra fila.
--
-- ── Por qué un disparador y no arreglar el código ──
--
-- Porque son varios los caminos que escriben en `onus` —el alta del técnico, el
-- aprovisionamiento manual, la importación, la resincronización con la OLT— y
-- cada uno tendría que acordarse de resolver el modelo. El que se agregue el año
-- que viene se va a olvidar.
--
-- Acá el enlace se hace donde el dato entra, una sola vez, para todos.
-- =============================================================================


-- =============================================================================
-- 1. Resolver el modelo cuando la ONU se guarda
-- =============================================================================
CREATE OR REPLACE FUNCTION onu_resuelve_su_modelo()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    /**
     * Solo si no lo eligieron a mano.
     *
     * Quien lo seleccionó desde la pantalla sabe algo que el texto de la ONT no
     * dice —dos modelos que se reportan igual, una revisión distinta— y
     * pisárselo sería descartar la única información buena que hay.
     */
    IF NEW.tipo_ont_id IS NULL AND NEW.modelo IS NOT NULL THEN
        SELECT t.id INTO NEW.tipo_ont_id
          FROM tipos_ont t
         WHERE UPPER(TRIM(t.modelo)) = UPPER(TRIM(NEW.modelo))
         LIMIT 1;
    END IF;

    /**
     * Si el modelo cambió, el enlace viejo deja de valer.
     *
     * Pasa al reemplazar el equipo del abonado conservando su fila: la ONT nueva
     * reporta otro modelo y el catálogo seguiría apuntando al aparato anterior.
     * Se vuelve a resolver, y si el nuevo no está en el catálogo queda NULL —que
     * es honesto— en vez de mentir con el viejo.
     */
    IF TG_OP = 'UPDATE'
       AND NEW.modelo IS DISTINCT FROM OLD.modelo
       AND NEW.tipo_ont_id IS NOT DISTINCT FROM OLD.tipo_ont_id THEN
        SELECT t.id INTO NEW.tipo_ont_id
          FROM tipos_ont t
         WHERE UPPER(TRIM(t.modelo)) = UPPER(TRIM(NEW.modelo))
         LIMIT 1;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_onu_resuelve_modelo ON onus;
CREATE TRIGGER trg_onu_resuelve_modelo
    BEFORE INSERT OR UPDATE OF modelo, tipo_ont_id ON onus
    FOR EACH ROW
    EXECUTE FUNCTION onu_resuelve_su_modelo();

COMMENT ON FUNCTION onu_resuelve_su_modelo IS
    'Ata cada ONU a su fila de tipos_ont por el texto del modelo. No pisa el que se eligio a mano.';


-- =============================================================================
-- 2. Las que ya están cargadas
-- =============================================================================
-- El disparador solo actúa cuando la fila se toca. Sin esto, las ONUs que ya
-- existen siguen sin enlace hasta que alguien las edite.
UPDATE onus o
   SET tipo_ont_id = t.id
  FROM tipos_ont t
 WHERE o.tipo_ont_id IS NULL
   AND o.modelo IS NOT NULL
   AND UPPER(TRIM(t.modelo)) = UPPER(TRIM(o.modelo));


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Cuántas quedaron atadas y cuántas no:
--   SELECT
--       COUNT(*) FILTER (WHERE tipo_ont_id IS NOT NULL) AS con_modelo,
--       COUNT(*) FILTER (WHERE tipo_ont_id IS NULL AND modelo IS NOT NULL) AS sin_catalogar,
--       COUNT(*) FILTER (WHERE modelo IS NULL) AS sin_modelo
--     FROM onus;
--
--   -- Los modelos que la OLT reporta y el catálogo no tiene. Cada uno es un
--   -- "Tipo de ONU" que conviene dar de alta:
--   SELECT DISTINCT o.modelo, COUNT(*) AS cuantas
--     FROM onus o
--    WHERE o.tipo_ont_id IS NULL AND o.modelo IS NOT NULL
--    GROUP BY o.modelo
--    ORDER BY cuantas DESC;
