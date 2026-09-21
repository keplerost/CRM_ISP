-- =============================================================================
-- Limpieza de datos de prueba
-- =============================================================================
-- ESTO NO ES UNA MIGRACIÓN. No lleva número a propósito: no forma parte de la
-- cadena y no tiene que correrse en una instalación nueva. Es un script de
-- mantenimiento, para una sola vez, en esta base.
--
-- ── Cómo usarlo ──
--
--   1. Corré la SECCIÓN 1 sola. Es de lectura: te dice qué se va a borrar.
--   2. Revisá la lista. Si algo no tiene que irse, sacá ese bloque del paso 2.
--   3. Corré la SECCIÓN 2. Va dentro de una transacción con su COMMIT al final.
--
-- ── Lo que NO toca, a propósito ──
--
--   · `onus`, `olts`, `routers_mikrotik`, `vlans_olt` — son tu red de verdad.
--     Los ONUs traen los nombres de tus abonados leídos del equipo.
--   · `auditoria_sistema` y `audit_logs` — el registro de lo que pasó no se
--     borra, ni siquiera el de las pruebas. Es lo que permite explicar después
--     por qué hubo una comisión pagada de $2 en agosto.
--   · Los abonados JEFFERSON FABIAN OÑA RIERA y Edison Raul Delgado Loor, el
--     técnico Edison Delgado y el vehículo Mazda: no tienen marca de prueba y
--     pueden ser reales. Si alguno es de prueba, borralo a mano.
--   · Los almacenes: el del técnico lo crea un disparador solo. Borrarlo lo
--     vuelve a crear en cuanto el técnico exista.
--
-- ── Las fotos ──
--
-- Las ocho fotos de la instalación de José Luis se borran de la base, pero los
-- archivos quedan en Storage → bucket `instalaciones`. Hay que borrarlos desde
-- ahí; el SQL no llega a los archivos.
-- =============================================================================


-- =============================================================================
-- SECCIÓN 1 — Qué se va a borrar (solo lectura, corré esto primero)
-- =============================================================================
SELECT 'usuarios_sistema' AS tabla, COUNT(*) AS filas FROM usuarios_sistema WHERE usuario = 'prueba.comisiones'
UNION ALL SELECT 'comision_periodos', COUNT(*) FROM comision_periodos
UNION ALL SELECT 'comision_ventas',   COUNT(*) FROM comision_ventas
UNION ALL SELECT 'prospectos',        COUNT(*) FROM prospectos
          WHERE nombre ILIKE 'DEMO%' OR notas ILIKE '%PRUEBA%'
UNION ALL SELECT 'expedientes',       COUNT(*) FROM expedientes e
          WHERE EXISTS (SELECT 1 FROM prospectos p WHERE p.id = e.prospecto_id
                          AND (p.nombre ILIKE 'DEMO%' OR p.notas ILIKE '%PRUEBA%'))
UNION ALL SELECT 'instalacion_fotos', COUNT(*) FROM instalacion_fotos f
          WHERE EXISTS (SELECT 1 FROM instalaciones i WHERE i.id = f.instalacion_id
                          AND (i.nombre ILIKE 'DEMO%' OR i.nombre ILIKE '%Oña Riera'))
UNION ALL SELECT 'instalaciones',     COUNT(*) FROM instalaciones
          WHERE nombre ILIKE 'DEMO%' OR nombre ILIKE '%Oña Riera'
UNION ALL SELECT 'clientes',          COUNT(*) FROM clientes
          WHERE nombre ILIKE 'DEMO%' OR nombre = 'José Luis Oña Riera'
UNION ALL SELECT 'movimientos_inventario', COUNT(*) FROM movimientos_inventario WHERE motivo ILIKE 'DEMO%'
UNION ALL SELECT 'equipos',           COUNT(*) FROM equipos WHERE serie ILIKE 'DEMO%'
UNION ALL SELECT 'articulos',         COUNT(*) FROM articulos WHERE nombre ILIKE 'DEMO%'
UNION ALL SELECT 'nodos_red (antenas)', COUNT(*) FROM nodos_red WHERE nombre ILIKE 'DEMO%'
UNION ALL SELECT 'puntos_red',        COUNT(*) FROM puntos_red
          WHERE nombre ILIKE 'DEMO%' OR nombre ILIKE '%PRUEBA%'
UNION ALL SELECT 'subredes',          COUNT(*) FROM subredes WHERE nombre ILIKE '%PRUEBA%'
UNION ALL SELECT 'promociones',       COUNT(*) FROM promociones WHERE nombre ILIKE 'DEMO%'
ORDER BY 1;


-- =============================================================================
-- SECCIÓN 2 — El borrado
-- =============================================================================
BEGIN;

-- ── 1. Comisiones ──
-- Primero el período, que apunta al vendedor; después las ventas.
DELETE FROM comision_periodos;
DELETE FROM comision_ventas;
DELETE FROM comision_cohortes;

-- ── 2. Cobranza y expedientes que cuelgan de los prospectos de prueba ──
DELETE FROM cobranza_gestiones g
 WHERE EXISTS (SELECT 1 FROM cobranza_asignaciones a
                WHERE a.id = g.asignacion_id
                  AND EXISTS (SELECT 1 FROM clientes c WHERE c.id = a.cliente_id
                                AND (c.nombre ILIKE 'DEMO%' OR c.nombre = 'José Luis Oña Riera')));

DELETE FROM cobranza_asignaciones a
 WHERE EXISTS (SELECT 1 FROM clientes c WHERE c.id = a.cliente_id
                 AND (c.nombre ILIKE 'DEMO%' OR c.nombre = 'José Luis Oña Riera'));

DELETE FROM expediente_documentos d
 WHERE EXISTS (SELECT 1 FROM expedientes e
                WHERE e.id = d.expediente_id
                  AND EXISTS (SELECT 1 FROM prospectos p WHERE p.id = e.prospecto_id
                                AND (p.nombre ILIKE 'DEMO%' OR p.notas ILIKE '%PRUEBA%')));

DELETE FROM expedientes e
 WHERE EXISTS (SELECT 1 FROM prospectos p WHERE p.id = e.prospecto_id
                 AND (p.nombre ILIKE 'DEMO%' OR p.notas ILIKE '%PRUEBA%'));

-- ── 3. Prospectos ──
DELETE FROM prospecto_actividades a
 WHERE EXISTS (SELECT 1 FROM prospectos p WHERE p.id = a.prospecto_id
                 AND (p.nombre ILIKE 'DEMO%' OR p.notas ILIKE '%PRUEBA%'));

DELETE FROM cotizaciones c
 WHERE EXISTS (SELECT 1 FROM prospectos p WHERE p.id = c.prospecto_id
                 AND (p.nombre ILIKE 'DEMO%' OR p.notas ILIKE '%PRUEBA%'));

DELETE FROM prospectos WHERE nombre ILIKE 'DEMO%' OR notas ILIKE '%PRUEBA%';

-- ── 4. Instalaciones ──
-- Las fotos primero: la fila se borra acá, el archivo hay que sacarlo de Storage.
DELETE FROM instalacion_fotos f
 WHERE EXISTS (SELECT 1 FROM instalaciones i WHERE i.id = f.instalacion_id
                 AND (i.nombre ILIKE 'DEMO%' OR i.nombre ILIKE '%Oña Riera'));

DELETE FROM instalaciones WHERE nombre ILIKE 'DEMO%' OR nombre ILIKE '%Oña Riera';

-- ── 5. Abonados de prueba ──
-- Se sueltan primero los equipos que los referencian, si quedó alguno.
UPDATE equipos SET cliente_id = NULL, instalacion_id = NULL, estado = 'en_stock'
 WHERE EXISTS (SELECT 1 FROM clientes c WHERE c.id = equipos.cliente_id
                 AND (c.nombre ILIKE 'DEMO%' OR c.nombre = 'José Luis Oña Riera'));

DELETE FROM clientes WHERE nombre ILIKE 'DEMO%' OR nombre = 'José Luis Oña Riera';

-- ── 6. El vendedor ficticio ──
DELETE FROM usuarios_sistema WHERE usuario = 'prueba.comisiones';

-- ── 7. Inventario de prueba ──
-- El orden importa: movimientos → existencias → equipos → artículos. Los
-- artículos tienen ON DELETE RESTRICT desde equipos y movimientos.
DELETE FROM movimientos_inventario WHERE motivo ILIKE 'DEMO%';

DELETE FROM movimientos_inventario m
 WHERE EXISTS (SELECT 1 FROM articulos a WHERE a.id = m.articulo_id AND a.nombre ILIKE 'DEMO%');

DELETE FROM existencias e
 WHERE EXISTS (SELECT 1 FROM articulos a WHERE a.id = e.articulo_id AND a.nombre ILIKE 'DEMO%');

DELETE FROM equipos WHERE serie ILIKE 'DEMO%';

DELETE FROM compra_items ci
 WHERE EXISTS (SELECT 1 FROM articulos a WHERE a.id = ci.articulo_id AND a.nombre ILIKE 'DEMO%');

DELETE FROM articulos WHERE nombre ILIKE 'DEMO%';

-- ── 8. Red de prueba: antenas, nodos, NAPs y subredes ──
DELETE FROM nodo_eventos ev
 WHERE EXISTS (SELECT 1 FROM nodos_red n WHERE n.id = ev.nodo_id AND n.nombre ILIKE 'DEMO%');

DELETE FROM nodos_red WHERE nombre ILIKE 'DEMO%';

DELETE FROM puntos_red WHERE nombre ILIKE 'DEMO%' OR nombre ILIKE '%PRUEBA%';

DELETE FROM subredes WHERE nombre ILIKE '%PRUEBA%';

-- ── 9. Promociones de prueba ──
DELETE FROM promocion_planes pp
 WHERE EXISTS (SELECT 1 FROM promociones p WHERE p.id = pp.promocion_id AND p.nombre ILIKE 'DEMO%');

DELETE FROM promociones WHERE nombre ILIKE 'DEMO%';

COMMIT;


-- =============================================================================
-- SECCIÓN 3 — Comprobar que quedó limpio
-- =============================================================================
--   SELECT 'clientes' t, COUNT(*) FROM clientes WHERE nombre ILIKE 'DEMO%'
--   UNION ALL SELECT 'prospectos', COUNT(*) FROM prospectos WHERE nombre ILIKE 'DEMO%'
--   UNION ALL SELECT 'nodos_red',  COUNT(*) FROM nodos_red  WHERE nombre ILIKE 'DEMO%'
--   UNION ALL SELECT 'equipos',    COUNT(*) FROM equipos    WHERE serie  ILIKE 'DEMO%';
--
--   -- Y que el módulo de comisiones siga sano con la base vacía de pruebas:
--   SELECT res_prueba, res_estado, res_casos FROM verificar_comisiones();
