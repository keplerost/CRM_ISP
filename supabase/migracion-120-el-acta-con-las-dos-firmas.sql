-- =============================================================================
-- Migración 120 — El acta de entrega, firmada por los dos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué faltaba ──
--
-- El acta la firmaba solo quien recibe. Con una sola firma prueba la mitad: que
-- la oficina aceptó unos equipos, pero no que el técnico los entregó. El día
-- que falte una ONT, "yo entregué cinco" y "a mí me llegaron cuatro" siguen sin
-- poder distinguirse.
--
-- Ahora firma el que entrega, al armar el acta, y el que recibe, al aceptarla.
-- Cada uno en su momento y desde su pantalla — que es lo que las hace dos
-- firmas y no un formulario con dos casillas.
--
-- ── Y por qué se borra la función vieja ──
--
-- Porque `CREATE OR REPLACE FUNCTION` reemplaza solo si la lista de argumentos
-- es idéntica. Al sumarle la firma, Postgres crearía una función NUEVA y
-- dejaría viva la de dos parámetros: desde ese momento cualquier llamada
-- fallaría con «function crear_entrega_inventario(...) is not unique».
--
-- Ya pasó con `cerrar_retiro_equipo` en la 115. La misma trampa, dos veces.
-- =============================================================================

ALTER TABLE entregas_inventario
    ADD COLUMN IF NOT EXISTS firma_entrega_b64 TEXT,
    ADD COLUMN IF NOT EXISTS firma_entrega_en  TIMESTAMPTZ;

COMMENT ON COLUMN entregas_inventario.firma_entrega_b64 IS
    'La firma de quien entrega el material, hecha al armar el acta. La otra —la de quien recibe— vive en firma_b64.';


DROP FUNCTION IF EXISTS crear_entrega_inventario(UUID[], TEXT);

/**
 * Crea el acta con los equipos que el técnico lleva a la oficina, y su firma.
 *
 * Solo entran equipos que estén EN SU ALMACÉN: no se puede entregar lo que no
 * se tiene, y sin ese control el sistema aceptaría un acta por un equipo que
 * está instalado en la casa de otro abonado.
 */
CREATE OR REPLACE FUNCTION crear_entrega_inventario(
    p_equipos UUID[],
    p_notas   TEXT DEFAULT NULL,
    p_firma   TEXT DEFAULT NULL
)
RETURNS entregas_inventario
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_legajo  UUID := mi_legajo_id();
    v_tecnico UUID := mi_tecnico_id();
    v_almacen UUID;
    v_acta    entregas_inventario%ROWTYPE;
    v_eq      RECORD;
    v_n       INT := 0;
BEGIN
    IF v_legajo IS NULL THEN
        RAISE EXCEPTION 'No se sabe quién está entregando';
    END IF;

    IF COALESCE(BTRIM(p_firma), '') = '' THEN
        RAISE EXCEPTION 'Falta tu firma: el acta necesita la de quien entrega y la de quien recibe';
    END IF;

    SELECT id INTO v_almacen FROM almacenes WHERE tecnico_id = v_tecnico LIMIT 1;
    IF v_almacen IS NULL THEN
        RAISE EXCEPTION 'No tenés un almacén propio: no hay desde dónde entregar';
    END IF;

    INSERT INTO entregas_inventario (
        entrega_id, almacen_origen, notas, firma_entrega_b64, firma_entrega_en
    )
    VALUES (v_legajo, v_almacen, NULLIF(BTRIM(p_notas), ''), p_firma, NOW())
    RETURNING * INTO v_acta;

    FOR v_eq IN
        SELECT e.id, e.serie, a.nombre AS modelo,
               (SELECT r.id FROM retiros_equipo r
                 WHERE r.equipo_id = e.id AND r.estado = 'recuperado'
                 ORDER BY r.cerrado_en DESC LIMIT 1) AS retiro_id
          FROM equipos e
          LEFT JOIN articulos a ON a.id = e.articulo_id
         WHERE e.id = ANY(COALESCE(p_equipos, '{}'))
           AND e.almacen_id = v_almacen
           AND e.estado = 'en_stock'
    LOOP
        INSERT INTO entrega_items (entrega_id, equipo_id, serie, modelo, retiro_id)
        VALUES (v_acta.id, v_eq.id, v_eq.serie, v_eq.modelo, v_eq.retiro_id);
        v_n := v_n + 1;
    END LOOP;

    IF v_n = 0 THEN
        -- Se borra en vez de dejar un acta vacía: un acta sin equipos es papel
        -- que después alguien tiene que interpretar.
        DELETE FROM entregas_inventario WHERE id = v_acta.id;
        RAISE EXCEPTION 'Ninguno de esos equipos está en tu almacén';
    END IF;

    RETURN v_acta;
END $$;


-- =============================================================================
-- Que la vista la muestre
-- =============================================================================
-- `firmada` pasa a significar "firmada por los dos", que es lo único que hace
-- que un acta valga. Y se agrega el detalle de cada una, para que la pantalla
-- pueda decir cuál falta.
DROP VIEW IF EXISTS v_entregas_inventario;
CREATE VIEW v_entregas_inventario AS
SELECT
    e.id,
    e.numero,
    e.estado,
    e.creado_en,
    e.firmado_en,
    e.firma_entrega_en,
    e.notas,
    (e.firma_entrega_b64 IS NOT NULL) AS firmada_entrega,
    (e.firma_b64 IS NOT NULL)         AS firmada_recepcion,
    (e.firma_entrega_b64 IS NOT NULL AND e.firma_b64 IS NOT NULL) AS firmada,
    TRIM(CONCAT(ue.nombre, ' ', COALESCE(ue.apellido, ''))) AS entrega,
    TRIM(CONCAT(ur.nombre, ' ', COALESCE(ur.apellido, ''))) AS recibe,
    ao.nombre AS almacen_origen,
    ad.nombre AS almacen_destino,
    (SELECT COUNT(*) FROM entrega_items i WHERE i.entrega_id = e.id)::INT AS equipos
FROM entregas_inventario e
LEFT JOIN usuarios_sistema ue ON ue.id = e.entrega_id
LEFT JOIN usuarios_sistema ur ON ur.id = e.recibe_id
LEFT JOIN almacenes ao ON ao.id = e.almacen_origen
LEFT JOIN almacenes ad ON ad.id = e.almacen_destino
WHERE puede_gestionar_retiros() OR e.entrega_id = mi_legajo_id() OR e.recibe_id = mi_legajo_id();

GRANT SELECT ON v_entregas_inventario TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Sin firma tiene que fallar:
--   SELECT crear_entrega_inventario(ARRAY['<equipo>']::UUID[], 'notas');
--
--   -- Y un acta completa tiene las dos:
--   SELECT numero, firmada_entrega, firmada_recepcion, firmada
--     FROM v_entregas_inventario;
