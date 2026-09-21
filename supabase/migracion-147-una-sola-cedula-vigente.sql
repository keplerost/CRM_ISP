-- =============================================================================
-- Migración 147 — Una sola cédula vigente
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- Se pueden subir dos cédulas frontales del mismo abonado. Es cómodo mientras
-- se reemplaza una borrosa y es un problema cinco minutos después: quedan las
-- dos y nadie sabe cuál mirar. En una discusión sobre quién firmó el contrato,
-- dos cédulas distintas del mismo campo son peores que ninguna.
--
-- ── Por qué NO alcanza con un índice único ──
--
-- Un índice único haría fallar la subida con "duplicate key", y peor: haría
-- fallar el ALTA. Un abonado puede tener dos órdenes —el alta y un traslado— y
-- si en las dos se subió la cédula, al adoptar los papeles de la segunda el
-- disparador chocaría contra el índice y el alta se caería entera. Un abonado
-- sin dar de alta por una foto repetida es mucho peor que dos fotos.
--
-- ── Lo que se hace en cambio ──
--
-- La cédula nueva REEMPLAZA a la anterior: la vieja queda marcada con fecha y
-- deja de mostrarse. Nunca falla nada y no se pierde nada — el archivo sigue
-- ahí, y si alguien reemplazó la buena por una borrosa se puede volver.
-- =============================================================================

/**
 * Cuándo dejó de ser la vigente.
 *
 * NULL = es la que vale. Con fecha = la reemplazó otra, y se conserva porque el
 * reemplazo puede haber sido un error: alguien sube una foto movida encima de
 * una buena y recién lo nota al mes.
 */
/**
 * `reemplazado_por` apunta a la copia que la sustituyó.
 *
 * ── Por qué la clave foránea va DIFERIDA ──
 *
 * Porque quien marca la vieja es un disparador BEFORE de la nueva, y ahí la
 * nueva todavía no está escrita. Una clave foránea común se verifica al terminar
 * ESA sentencia —el UPDATE de adentro— y rechazaría el apuntador por señalar una
 * fila que aún no existe. Probado: "violates foreign key constraint
 * documentos_reemplazado_por_fkey".
 *
 * Diferida se verifica al cerrar la transacción, cuando las dos filas están.
 */
ALTER TABLE documentos
    ADD COLUMN IF NOT EXISTS reemplazado_en TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reemplazado_por UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'documentos_reemplazado_por_fkey'
    ) THEN
        ALTER TABLE documentos
            ADD CONSTRAINT documentos_reemplazado_por_fkey
            FOREIGN KEY (reemplazado_por) REFERENCES documentos(id) ON DELETE SET NULL
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

COMMENT ON COLUMN documentos.reemplazado_en IS
    'Cuándo dejó de ser la copia vigente. NULL = es la que vale.';


/**
 * Las categorías donde tener dos copias confunde en vez de ayudar.
 *
 * Son las de IDENTIDAD: hay una sola cédula y un solo RUC. El contrato no está
 * —conviven el generado y el escaneo del firmado, y uno por cada renovación— ni
 * el acta de entrega, que hay una por cada equipo entregado.
 */
CREATE OR REPLACE FUNCTION documento_de_identidad(p_categoria TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT p_categoria IN ('cedula_frontal', 'cedula_reverso', 'ruc', 'cedula_representante')
$$;


/**
 * Al subir una identidad nueva, la anterior deja de ser la vigente.
 *
 * ── Por qué BEFORE y no AFTER ──
 *
 * Porque un índice único se verifica al escribir la fila, no al terminar la
 * sentencia. Con un AFTER, el índice rebota el insert antes de que el disparador
 * llegue a marcar la vieja — probado: "duplicate key value violates unique
 * constraint idx_documento_identidad_abonado".
 *
 * `reemplazado_por = NEW.id` funciona igual desde un BEFORE aunque la fila
 * todavía no exista: las claves foráneas SÍ se verifican al final de la
 * sentencia, y para entonces ya está escrita.
 *
 * Se busca por el mismo dueño, sea el abonado o la orden. Un papel puede tener
 * los dos, y entonces se compara por los dos: la cédula que subió el vendedor y
 * la que subió la oficina son la misma cédula del mismo señor.
 */
CREATE OR REPLACE FUNCTION documento_reemplaza_al_anterior()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT documento_de_identidad(NEW.categoria) THEN RETURN NEW; END IF;
    IF NEW.reemplazado_en IS NOT NULL THEN RETURN NEW; END IF;

    UPDATE documentos
       SET reemplazado_en  = NOW(),
           reemplazado_por = NEW.id
     WHERE id <> NEW.id
       AND categoria = NEW.categoria
       AND reemplazado_en IS NULL
       AND (
           (NEW.client_id IS NOT NULL AND client_id = NEW.client_id)
        OR (NEW.instalacion_id IS NOT NULL AND instalacion_id = NEW.instalacion_id)
       );

    RETURN NEW;
END $$;

/**
 * También al ADOPTAR, no solo al subir.
 *
 * Es el caso que se lleva puesto un índice único a secas, y el peor de todos: un
 * abonado con dos órdenes —el alta y un traslado— puede tener la cédula subida
 * en las dos. Cuando la segunda orden consigue su abonado, el disparador de la
 * 145 le completa el `client_id` a sus papeles, y ahí aparece la segunda cédula
 * vigente del mismo señor. Sin esto, el UPDATE rebota contra el índice y **el
 * alta se cae entera**.
 *
 * Probado: "duplicate key value violates unique constraint
 * idx_documento_identidad_abonado".
 *
 * Gana la que llega, que es la más nueva. No hay recursión: el disparador
 * escribe `reemplazado_en`, no `client_id`.
 */
DROP TRIGGER IF EXISTS trg_documento_reemplaza ON documentos;
CREATE TRIGGER trg_documento_reemplaza
    BEFORE INSERT OR UPDATE OF client_id ON documentos
    FOR EACH ROW EXECUTE FUNCTION documento_reemplaza_al_anterior();


-- =============================================================================
-- Los duplicados que ya estén cargados
-- =============================================================================
/**
 * Se deja vigente la más nueva de cada grupo y se marcan las anteriores.
 *
 * Va ANTES de crear los índices, y no es un detalle de orden: sobre una base que
 * ya tenga dos cédulas del mismo abonado, `CREATE UNIQUE INDEX` falla y la
 * migración se corta a la mitad, con la columna agregada y sin la protección.
 */
WITH ordenadas AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY COALESCE(client_id::TEXT, instalacion_id::TEXT), categoria
               ORDER BY created_at DESC, id DESC
           ) AS puesto
      FROM documentos
     WHERE reemplazado_en IS NULL
       AND documento_de_identidad(categoria)
)
UPDATE documentos d
   SET reemplazado_en = NOW()
  FROM ordenadas o
 WHERE d.id = o.id AND o.puesto > 1;


/**
 * Y ahora sí, la restricción.
 *
 * Una sola identidad vigente por abonado y una por orden. Con el disparador de
 * arriba nunca debería saltar; está para el caso en que alguien escriba en la
 * base por fuera de la aplicación, que es exactamente cuando hace falta.
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_documento_identidad_abonado
    ON documentos (client_id, categoria)
    WHERE client_id IS NOT NULL
      AND reemplazado_en IS NULL
      AND categoria IN ('cedula_frontal', 'cedula_reverso', 'ruc', 'cedula_representante');

CREATE UNIQUE INDEX IF NOT EXISTS idx_documento_identidad_orden
    ON documentos (instalacion_id, categoria)
    WHERE instalacion_id IS NOT NULL
      AND client_id IS NULL
      AND reemplazado_en IS NULL
      AND categoria IN ('cedula_frontal', 'cedula_reverso', 'ruc', 'cedula_representante');


-- =============================================================================
-- Que las pantallas vean solo las vigentes
-- =============================================================================
CREATE OR REPLACE VIEW v_documentos_abonado WITH (security_invoker = true) AS
SELECT
    d.id,
    d.client_id,
    d.instalacion_id,
    d.categoria,
    d.nombre,
    d.ruta,
    'documentos'::TEXT AS bucket,
    d.mime,
    d.tamano,
    d.visible_cliente,
    d.created_at,
    FALSE AS solo_lectura
FROM documentos d
WHERE d.client_id IS NOT NULL
  -- Lo único que cambia respecto de la 146.
  AND d.reemplazado_en IS NULL

UNION ALL

SELECT
    f.id,
    i.client_id,
    f.instalacion_id,
    'foto_instalacion'::VARCHAR(30) AS categoria,
    COALESCE(f.descripcion, 'Foto de la instalación (' || f.tipo || ')') AS nombre,
    f.ruta,
    'instalaciones'::TEXT AS bucket,
    NULL::VARCHAR(100) AS mime,
    NULL::BIGINT AS tamano,
    FALSE AS visible_cliente,
    f.created_at,
    TRUE AS solo_lectura
FROM instalacion_fotos f
JOIN instalaciones i ON i.id = f.instalacion_id
WHERE i.client_id IS NOT NULL;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Subir dos cédulas frontales del mismo abonado y ver que queda una:
--   SELECT categoria, nombre, reemplazado_en FROM documentos
--    WHERE client_id = '<id>' AND categoria = 'cedula_frontal'
--    ORDER BY created_at;
--
--   -- Lo que muestra la ficha: solo la vigente.
--   SELECT categoria, nombre FROM v_documentos_abonado WHERE client_id = '<id>';
--
--   -- Y las reemplazadas siguen ahí por si el reemplazo fue un error:
--   SELECT COUNT(*) FROM documentos WHERE reemplazado_en IS NOT NULL;
