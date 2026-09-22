-- =============================================================================
-- Vaciar el sistema para arrancar el sector piloto
-- =============================================================================
-- ESTO NO ES UNA MIGRACIÓN. No lleva número a propósito: no forma parte de la
-- cadena y no tiene que correrse nunca en una instalación nueva. Es un script
-- de una sola vez, para esta base, el día que se arranca el piloto.
--
-- A diferencia de `limpieza-datos-de-prueba.sql` —que borra solo lo marcado
-- como prueba— esto deja la operación y la red en CERO.
--
-- ── Las tres decisiones que definen este script ──
--
--   · La RED se borra entera. Las 92 ONUs, su historial óptico, las 2 OLTs,
--     los 2 routers, VLANs, puertos PON, subredes y direccionamiento. El
--     sector piloto se carga desde cero.
--   · La CONFIGURACIÓN se conserva toda. Plantillas de aviso, cláusulas del
--     contrato de ARCOTEL, planes, esquema de comisiones, config del SRI,
--     cuentas de pago. Es trabajo de semanas y no es "un cliente".
--   · La AUDITORÍA se conserva. No se ve en ninguna pantalla de operación, así
--     que no ensucia el arranque, y es lo que permite explicar después
--     cualquier cosa rara.
--   · El PERSONAL se conserva. Usuarios, técnicos, vehículos y almacenes.
--
-- ── Cómo usarlo ──
--
--   0. HACÉ EL RESPALDO PRIMERO. Ver la sección 0. Esto no se deshace.
--   1. Corré la SECCIÓN 1 sola. Es de lectura: te dice qué se va y qué queda.
--   2. Revisá esos números contra lo que esperás.
--   3. Corré la SECCIÓN 2. Va en una transacción con su COMMIT al final.
--   4. Corré la SECCIÓN 3 para confirmar que quedó en cero.
--
-- ── Por qué un solo TRUNCATE y no muchos DELETE ──
--
-- Todas las tablas van en UNA sola sentencia. No es por elegancia: si alguna
-- tabla que NO está en la lista apunta a una que sí, Postgres se niega y te
-- dice cuál es. Con DELETE sueltos, o con TRUNCATE ... CASCADE, el borrado
-- seguiría adelante y se llevaría puesto algo que queríamos conservar.
--
-- Dicho de otro modo: si esto falla, la base queda intacta y el error nombra
-- exactamente lo que falta agregar.
--
-- Pasó dos veces al escribirlo, y las dos veces el error tenía razón:
-- `sri_secuenciales_libres` apuntaba a `electronic_documents`, y
-- `planes_velocidad` a `olts`. La primera se agregó a la lista; la segunda no
-- podía agregarse sin perder los planes, y por eso las OLTs salen con DELETE.
--
-- ── Lo que el SQL NO alcanza ──
--
-- Los ARCHIVOS. Las fotos de instalación, los adjuntos de tickets, los
-- documentos del expediente, las firmas de contrato y las fotos de jornada se
-- borran de la base, pero los archivos siguen en Storage. Hay que vaciar esos
-- buckets a mano desde el panel de Supabase → Storage:
--
--     instalaciones · tickets · documentos · jornadas
--
-- No es urgente —quedan huérfanos, nadie los ve— pero ocupan lugar.
-- =============================================================================


-- =============================================================================
-- SECCIÓN 0 — El respaldo
-- =============================================================================
-- Esto no se deshace. Antes de correr la sección 2:
--
--   Panel de Supabase → Database → Backups → Create backup
--
-- Si no está disponible en tu plan, desde tu máquina:
--
--   pg_dump "postgresql://postgres:CLAVE@db.PROYECTO.supabase.co:5432/postgres" \
--     --data-only --format=custom --file=antes-del-piloto.dump
--
-- Guardalo fuera del servidor. Vale por si aparece algo que sí hacía falta.
-- =============================================================================


-- =============================================================================
-- SECCIÓN 1 — Qué se va y qué queda (solo lectura, corré esto primero)
-- =============================================================================

SELECT 'SE BORRA' AS destino, 'clientes'             AS tabla, COUNT(*) AS filas FROM clientes
UNION ALL SELECT 'SE BORRA', 'facturas',             COUNT(*) FROM facturas
UNION ALL SELECT 'SE BORRA', 'pagos',                COUNT(*) FROM pagos
UNION ALL SELECT 'SE BORRA', 'instalaciones',        COUNT(*) FROM instalaciones
UNION ALL SELECT 'SE BORRA', 'tickets',              COUNT(*) FROM tickets
UNION ALL SELECT 'SE BORRA', 'prospectos',           COUNT(*) FROM prospectos
UNION ALL SELECT 'SE BORRA', 'contratos',            COUNT(*) FROM contratos
UNION ALL SELECT 'SE BORRA', 'comunicaciones',       COUNT(*) FROM comunicaciones
UNION ALL SELECT 'SE BORRA', 'avisos_pendientes',    COUNT(*) FROM avisos_pendientes
UNION ALL SELECT 'SE BORRA', 'retiros_equipo',       COUNT(*) FROM retiros_equipo
UNION ALL SELECT 'SE BORRA', 'equipos',              COUNT(*) FROM equipos
UNION ALL SELECT 'SE BORRA', 'comision_ventas',      COUNT(*) FROM comision_ventas
UNION ALL SELECT 'SE BORRA', 'jornadas',             COUNT(*) FROM jornadas
UNION ALL SELECT 'SE BORRA', '· red · onus',         COUNT(*) FROM onus
UNION ALL SELECT 'SE BORRA', '· red · onu_optica_historial', COUNT(*) FROM onu_optica_historial
UNION ALL SELECT 'SE BORRA', '· red · olts',         COUNT(*) FROM olts
UNION ALL SELECT 'SE BORRA', '· red · routers_mikrotik', COUNT(*) FROM routers_mikrotik
UNION ALL SELECT 'SE BORRA', '· red · vlans_olt',    COUNT(*) FROM vlans_olt
UNION ALL SELECT 'SE BORRA', '· red · puertos_pon',  COUNT(*) FROM puertos_pon
UNION ALL SELECT 'SE BORRA', '· red · ip_addresses', COUNT(*) FROM ip_addresses
UNION ALL SELECT 'SE BORRA', '· red · subredes',     COUNT(*) FROM subredes
UNION ALL SELECT 'SE BORRA', '· red · comandos_ejecutados', COUNT(*) FROM comandos_ejecutados

UNION ALL SELECT 'QUEDA', 'usuarios_sistema',        COUNT(*) FROM usuarios_sistema
UNION ALL SELECT 'QUEDA', 'tecnicos',                COUNT(*) FROM tecnicos
UNION ALL SELECT 'QUEDA', 'vehiculos',               COUNT(*) FROM vehiculos
UNION ALL SELECT 'QUEDA', 'almacenes',               COUNT(*) FROM almacenes
UNION ALL SELECT 'QUEDA', 'plantillas_mensaje',      COUNT(*) FROM plantillas_mensaje
UNION ALL SELECT 'QUEDA', 'plantillas_whatsapp',     COUNT(*) FROM plantillas_whatsapp
UNION ALL SELECT 'QUEDA', 'clausulas_contrato',      COUNT(*) FROM clausulas_contrato
UNION ALL SELECT 'QUEDA', 'planes_velocidad',        COUNT(*) FROM planes_velocidad
UNION ALL SELECT 'QUEDA', 'tipos_ont',               COUNT(*) FROM tipos_ont
UNION ALL SELECT 'QUEDA', 'cuentas_pago',            COUNT(*) FROM cuentas_pago
UNION ALL SELECT 'QUEDA', 'motivos_baja',            COUNT(*) FROM motivos_baja
UNION ALL SELECT 'QUEDA', 'sri_config',              COUNT(*) FROM sri_config
UNION ALL SELECT 'QUEDA', 'prestadores',             COUNT(*) FROM prestadores
UNION ALL SELECT 'QUEDA', 'licencia',                COUNT(*) FROM licencia
UNION ALL SELECT 'QUEDA', 'auditoria_sistema',       COUNT(*) FROM auditoria_sistema
UNION ALL SELECT 'QUEDA', 'audit_logs',              COUNT(*) FROM audit_logs
ORDER BY 1 DESC, 2;


-- =============================================================================
-- SECCIÓN 2 — El vaciado
-- =============================================================================
-- Una sola sentencia. Si falla, no se borró nada y el mensaje nombra la tabla
-- que falta agregar a la lista.
--
-- RESTART IDENTITY reinicia los contadores de las tablas que usan secuencia,
-- para que el primer registro del piloto sea el 1 y no el 7.

BEGIN;

TRUNCATE

  -- ── Abonados y su ciclo de vida ──
  clientes,
  equipos_cliente,
  contratos,
  firmas_contrato,
  solicitudes_validacion,
  reactivaciones,
  traslados,
  reemplazos_equipo,
  retiros_equipo,
  retiro_intentos,

  -- ── Facturación y cobranza ──
  facturas,
  pagos,
  pagos_reportados,
  promesas_pago,
  cobranza_asignaciones,
  cobranza_gestiones,
  documentos,
  document_items,
  electronic_documents,
  -- Los secuenciales que se liberan al anular un documento. Apunta a
  -- `electronic_documents`, así que TIENE que vaciarse junto con él: es el
  -- pozo de números de documentos que ya no existen.
  sri_secuenciales_libres,
  retencion_items,
  reconexiones_pendientes,

  -- ── Soporte e instalaciones ──
  tickets,
  ticket_eventos,
  ticket_adjuntos,
  instalaciones,
  instalacion_fotos,
  incidencias_masivas,
  incidencia_avisos,

  -- ── Comercial ──
  prospectos,
  prospecto_actividades,
  expedientes,
  expediente_documentos,
  cotizaciones,
  verificaciones_cobertura,
  mensajes_comerciales,
  metas_venta,

  -- ── Comisiones (el movimiento, no el esquema) ──
  comision_ventas,
  comision_periodos,
  comision_cohortes,

  -- ── Mensajería enviada ──
  comunicaciones,
  avisos_pendientes,
  notificaciones,
  alerta_eventos,
  alerta_envios,
  ventanas_whatsapp,

  -- ── Portal del abonado ──
  portal_codigos,
  portal_sesiones,
  portal_solicitudes,

  -- ── Inventario en movimiento (el catálogo queda) ──
  equipos,
  existencias,
  movimientos_inventario,
  entregas_inventario,
  entrega_items,
  compras,
  compra_items,

  -- ── Campo ──
  jornadas,
  mantenimientos,
  cargas_combustible,

  -- ── RED: todo ──
  onus,
  onu_optica_historial,
  onts_esperando,
  onts_preautorizadas,
  autorizacion_presets,
  puertos_pon,
  vlans_olt,
  line_profiles,
  -- `olts` NO va acá. Sale más abajo con DELETE, y la razón está explicada
  -- después del RESTART IDENTITY.
  olt_historial,
  olt_backups,
  olt_escaneos,
  routers_mikrotik,
  plan_routers,
  firewall_bloqueos,
  ip_addresses,
  subredes,
  puntos_red,
  nodos_red,
  nodo_eventos,
  comandos_ejecutados,
  sesiones_conexion,
  consumo_contadores,
  consumo_diario

RESTART IDENTITY;


-- ── Las OLTs, aparte ─────────────────────────────────────────────────────────
--
-- `planes_velocidad.tablas_verificadas_en` apunta a `olts` con ON DELETE SET
-- NULL: guarda en qué equipo se verificaron las tablas de tráfico del plan.
--
-- TRUNCATE no puede vaciar una tabla referenciada por otra que no esté en la
-- misma lista, y no sirve agregar `planes_velocidad` —perderíamos los planes,
-- que son configuración—. TRUNCATE tampoco respeta el ON DELETE SET NULL:
-- lo ignora y falla igual.
--
-- DELETE sí lo respeta. Y a esta altura las OLTs ya no tienen ningún hijo: todo
-- lo que colgaba de ellas —ONUs, puertos, VLANs, historial— se vació arriba. Así
-- que son dos líneas baratas, no un borrado en cascada.
DELETE FROM olts;

-- El SET NULL limpia la referencia al equipo, pero no la fecha. Una marca de
-- "verificado el 3 de marzo" sin decir en qué equipo no significa nada.
UPDATE planes_velocidad
   SET tablas_verificadas_at = NULL
 WHERE tablas_verificadas_at IS NOT NULL;

COMMIT;


-- =============================================================================
-- SI LA SECCIÓN 2 FALLA — qué falta
-- =============================================================================
-- El error dice UNA tabla por vez. Esta consulta las lista TODAS de una:
-- devuelve cada tabla que quedaría fuera del TRUNCATE pero apunta a alguna que
-- sí está adentro. Si devuelve filas, esas tablas hay que agregarlas a la lista
-- (si son operación) o hay que sacar del TRUNCATE lo que apuntan (si no).
--
-- Pegá la lista de tablas de la sección 2 en el VALUES de abajo si la cambiaste.

SELECT DISTINCT
       hijo.relname  AS tabla_que_falta,
       padre.relname AS apunta_a
  FROM pg_constraint c
  JOIN pg_class  hijo  ON hijo.oid  = c.conrelid
  JOIN pg_class  padre ON padre.oid = c.confrelid
  JOIN pg_namespace n  ON n.oid     = hijo.relnamespace
 WHERE c.contype = 'f'
   AND n.nspname = 'public'
   AND padre.relname <> hijo.relname
   AND padre.relname IN (
       SELECT unnest(string_to_array(
         'clientes,equipos_cliente,contratos,firmas_contrato,solicitudes_validacion,'
         'reactivaciones,traslados,reemplazos_equipo,retiros_equipo,retiro_intentos,'
         'facturas,pagos,pagos_reportados,promesas_pago,cobranza_asignaciones,'
         'cobranza_gestiones,documentos,document_items,electronic_documents,'
         'sri_secuenciales_libres,retencion_items,reconexiones_pendientes,tickets,'
         'ticket_eventos,ticket_adjuntos,instalaciones,instalacion_fotos,'
         'incidencias_masivas,incidencia_avisos,prospectos,prospecto_actividades,'
         'expedientes,expediente_documentos,cotizaciones,verificaciones_cobertura,'
         'mensajes_comerciales,metas_venta,comision_ventas,comision_periodos,'
         'comision_cohortes,comunicaciones,avisos_pendientes,notificaciones,'
         'alerta_eventos,alerta_envios,ventanas_whatsapp,portal_codigos,'
         'portal_sesiones,portal_solicitudes,equipos,existencias,'
         'movimientos_inventario,entregas_inventario,entrega_items,compras,'
         'compra_items,jornadas,mantenimientos,cargas_combustible,onus,'
         'onu_optica_historial,onts_esperando,onts_preautorizadas,'
         'autorizacion_presets,puertos_pon,vlans_olt,line_profiles,olts,'
         'olt_historial,olt_backups,olt_escaneos,routers_mikrotik,plan_routers,'
         'firewall_bloqueos,ip_addresses,subredes,puntos_red,nodos_red,'
         'nodo_eventos,comandos_ejecutados,sesiones_conexion,consumo_contadores,'
         'consumo_diario', ',')))
   AND hijo.relname NOT IN (
       SELECT unnest(string_to_array(
         'clientes,equipos_cliente,contratos,firmas_contrato,solicitudes_validacion,'
         'reactivaciones,traslados,reemplazos_equipo,retiros_equipo,retiro_intentos,'
         'facturas,pagos,pagos_reportados,promesas_pago,cobranza_asignaciones,'
         'cobranza_gestiones,documentos,document_items,electronic_documents,'
         'sri_secuenciales_libres,retencion_items,reconexiones_pendientes,tickets,'
         'ticket_eventos,ticket_adjuntos,instalaciones,instalacion_fotos,'
         'incidencias_masivas,incidencia_avisos,prospectos,prospecto_actividades,'
         'expedientes,expediente_documentos,cotizaciones,verificaciones_cobertura,'
         'mensajes_comerciales,metas_venta,comision_ventas,comision_periodos,'
         'comision_cohortes,comunicaciones,avisos_pendientes,notificaciones,'
         'alerta_eventos,alerta_envios,ventanas_whatsapp,portal_codigos,'
         'portal_sesiones,portal_solicitudes,equipos,existencias,'
         'movimientos_inventario,entregas_inventario,entrega_items,compras,'
         'compra_items,jornadas,mantenimientos,cargas_combustible,onus,'
         'onu_optica_historial,onts_esperando,onts_preautorizadas,'
         'autorizacion_presets,puertos_pon,vlans_olt,line_profiles,olts,'
         'olt_historial,olt_backups,olt_escaneos,routers_mikrotik,plan_routers,'
         'firewall_bloqueos,ip_addresses,subredes,puntos_red,nodos_red,'
         'nodo_eventos,comandos_ejecutados,sesiones_conexion,consumo_contadores,'
         'consumo_diario', ',')))
 ORDER BY 1;


-- =============================================================================
-- SECCIÓN 3 — Confirmar
-- =============================================================================
-- Las dos primeras columnas tienen que dar 0. Las otras, lo que había antes.

SELECT
  (SELECT COUNT(*) FROM clientes)          AS clientes,
  (SELECT COUNT(*) FROM onus)              AS onus,
  (SELECT COUNT(*) FROM facturas)          AS facturas,
  (SELECT COUNT(*) FROM olts)              AS olts,
  (SELECT COUNT(*) FROM usuarios_sistema)  AS usuarios_quedan,
  (SELECT COUNT(*) FROM plantillas_mensaje) AS plantillas_quedan,
  (SELECT COUNT(*) FROM planes_velocidad)  AS planes_quedan,
  (SELECT COUNT(*) FROM auditoria_sistema) AS auditoria_queda;


-- =============================================================================
-- OPCIONAL — Reiniciar la numeración de facturas
-- =============================================================================
-- `sri_sequences` guarda en qué número va cada punto de emisión. Se conserva
-- porque es configuración, pero al no haber ninguna factura podés querer que
-- el piloto arranque en 1.
--
-- Mirá primero en qué están:
--
--     SELECT * FROM sri_sequences;
--
-- Y si querés reiniciarlas:
--
--     UPDATE sri_sequences SET secuencial = 0;
--
-- Ojo: esto solo tiene sentido porque no emitís al SRI. Con facturación
-- electrónica real, un secuencial que retrocede choca con lo ya autorizado.
-- =============================================================================
