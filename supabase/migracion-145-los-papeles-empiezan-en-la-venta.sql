-- =============================================================================
-- Migración 145 — Los papeles del abonado empiezan en la venta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- La cédula la ve el vendedor, en la casa del cliente, el día que vende. La
-- ficha del abonado no existe hasta el alta, que es días después. Hoy la única
-- pantalla que permite subir una cédula es la de esa ficha.
--
-- El resultado es el que se ve en la base: `documentos` en cero. No porque nadie
-- tenga la cédula, sino porque cuando alguien la tiene todavía no hay dónde
-- ponerla, y cuando hay dónde ponerla ya nadie la tiene a mano.
--
-- ── Lo que cambia ──
--
-- Un documento puede colgar de la ORDEN o del ABONADO. El vendedor sube la
-- cédula a la orden; al dar de alta, esos papeles pasan a la ficha solos.
--
-- ── Por qué NO se toca `instalacion_fotos` ──
--
-- Las fotos que toma el técnico —la caja NAP, el cable, la potencia— viven en
-- otro bucket y sirven para otra cosa: son el respaldo técnico del trabajo, no
-- los papeles del abonado. Copiarlas a `documentos` duplicaría cada archivo en
-- dos lugares para que después alguien borre uno y crea que borró los dos.
--
-- La ficha las va a MOSTRAR, leyéndolas de donde están.
-- =============================================================================

/**
 * Un documento cuelga de un abonado, de una orden, o de los dos.
 *
 * De los dos es el caso normal después del alta: el papel se subió a la orden y
 * ahora también pertenece a la ficha. Conservar de cuál orden vino no es un
 * detalle: es lo que permite saber quién lo subió y en qué visita.
 */
ALTER TABLE documentos
    ADD COLUMN IF NOT EXISTS instalacion_id UUID REFERENCES instalaciones(id) ON DELETE CASCADE;

-- El cliente deja de ser obligatorio: cuando el vendedor sube la cédula todavía
-- no hay ficha a la cual atarla.
ALTER TABLE documentos ALTER COLUMN client_id DROP NOT NULL;

/**
 * Pero un documento sin dueño no sirve para nada.
 *
 * Sin esta comprobación, un error en el código dejaría archivos huérfanos que no
 * aparecen en ninguna pantalla y que nadie sabe que están ocupando lugar.
 */
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documentos_tiene_dueno_check') THEN
        ALTER TABLE documentos ADD CONSTRAINT documentos_tiene_dueno_check
            CHECK (client_id IS NOT NULL OR instalacion_id IS NOT NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documentos_instalacion
    ON documentos (instalacion_id, categoria) WHERE instalacion_id IS NOT NULL;


-- =============================================================================
-- Las categorías que faltaban
-- =============================================================================
/**
 * Se agregan tres que aparecen en toda venta y no tenían dónde ir.
 *
 *   AUTORIZACIÓN  Cuando quien firma no es el titular. Sin este papel, el
 *                 contrato lo firmó alguien que no figura en él.
 *   RUC           Del abonado empresa, que es lo que pide su factura.
 *   REPRESENTANTE La cédula de quien firma por la empresa.
 *
 * Se hace con DROP + ADD del CHECK y no con un tipo nuevo: la restricción no
 * tiene nada colgando y rehacerla es más simple que migrar la columna.
 */
ALTER TABLE documentos DROP CONSTRAINT IF EXISTS documentos_categoria_check;

ALTER TABLE documentos ADD CONSTRAINT documentos_categoria_check
    CHECK (categoria IN (
        'cedula_frontal', 'cedula_reverso', 'contrato', 'acta_entrega',
        'planilla_servicio', 'foto_instalacion',
        'autorizacion', 'ruc', 'cedula_representante',
        'otro'
    ));


-- =============================================================================
-- Que los papeles de la venta pasen a la ficha
-- =============================================================================
/**
 * Al cerrar la orden, sus documentos adoptan al abonado.
 *
 * No se copian ni se mueven: se les completa el `client_id`. El archivo sigue
 * siendo el mismo y sigue sabiendo de qué orden vino — así, si dentro de un año
 * alguien pregunta quién subió esa cédula, la respuesta está.
 *
 * Va en su propio disparador y no dentro de `instalacion_actualiza_cliente`
 * porque aquel solo corre para altas y traslados: un retiro también tiene
 * papeles, y también son del abonado.
 */
CREATE OR REPLACE FUNCTION documentos_pasan_al_abonado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.client_id IS NULL THEN RETURN NEW; END IF;

    UPDATE documentos
       SET client_id = NEW.client_id
     WHERE instalacion_id = NEW.id
       AND client_id IS NULL;

    RETURN NEW;
END $$;

/**
 * Se dispara cuando la orden CONSIGUE su abonado, no cuando se cierra.
 *
 * Son dos momentos distintos: el alta crea la ficha y recién ahí hay a quién
 * atar los papeles. Esperar al cierre dejaría la cédula sin dueño durante todo
 * el trabajo, que es justo cuando la oficina la va a buscar.
 */
DROP TRIGGER IF EXISTS trg_documentos_al_abonado ON instalaciones;
CREATE TRIGGER trg_documentos_al_abonado
    AFTER INSERT OR UPDATE OF client_id ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION documentos_pasan_al_abonado();


-- =============================================================================
-- Lo que la ficha necesita mostrar
-- =============================================================================
/**
 * Los papeles de un abonado, vengan de donde vengan, más las fotos del técnico.
 *
 * Las fotos se listan pero NO se copian: siguen viviendo en el bucket de
 * instalaciones. La vista dice de qué bucket es cada fila para que la pantalla
 * pida la URL firmada donde corresponde.
 */
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

UNION ALL

/**
 * Las fotos del trabajo, como si fueran de la categoría "foto_instalacion".
 *
 * `solo_lectura` las marca: se borran desde la orden, que es su lugar. Dejar
 * borrarlas desde la ficha haría desaparecer el respaldo técnico del trabajo
 * desde una pantalla donde nadie espera esa consecuencia.
 */
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

COMMENT ON VIEW v_documentos_abonado IS
    'Papeles del abonado y fotos de su instalación, con el bucket de cada uno. Las fotos son de solo lectura: se administran desde la orden.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Subir una cédula a una orden sin abonado y ver que queda sin dueño:
--   SELECT categoria, client_id, instalacion_id FROM documentos
--    WHERE instalacion_id IS NOT NULL;
--
--   -- Y que al dar de alta la adopte:
--   SELECT d.categoria, c.nombre
--     FROM documentos d JOIN clientes c ON c.id = d.client_id
--    WHERE d.instalacion_id IS NOT NULL;
--
--   -- Todo lo del abonado, papeles y fotos juntos:
--   SELECT categoria, nombre, bucket, solo_lectura
--     FROM v_documentos_abonado WHERE client_id = '<id>';
