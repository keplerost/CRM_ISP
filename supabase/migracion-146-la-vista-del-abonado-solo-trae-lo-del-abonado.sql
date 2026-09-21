-- =============================================================================
-- Migración 146 — La vista del abonado solo trae lo del abonado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que se vio al probar ──
--
-- `v_documentos_abonado` incluía también los papeles que todavía no tienen
-- abonado: los que el vendedor acaba de subir a una orden.
--
-- En la pantalla no se notaba, porque la ficha filtra por el id del abonado y
-- `NULL` no iguala a nada. Pero la vista se llama "documentos del abonado" y
-- devolvía filas sin abonado, así que el primero que escriba
--
--     SELECT * FROM v_documentos_abonado
--
-- para contar papeles o para armar un reporte se lleva de más las cédulas de
-- ventas que todavía no se instalaron. Es la clase de error que no falla: da un
-- número equivocado.
--
-- Para ver los papeles de una orden se consulta `documentos` por su
-- `instalacion_id`, que es lo que hace la pantalla de la venta.
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
-- Lo único que cambia respecto de la 145.
WHERE d.client_id IS NOT NULL

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
    'Papeles de un ABONADO y fotos de su instalación, con el bucket de cada uno. Los papeles de una venta sin alta se consultan en `documentos` por instalacion_id.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- No puede haber ninguna fila sin abonado:
--   SELECT COUNT(*) FROM v_documentos_abonado WHERE client_id IS NULL;
--   -- tiene que dar 0
