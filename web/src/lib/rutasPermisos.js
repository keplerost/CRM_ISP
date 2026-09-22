/**
 * Qué permiso hace falta para entrar a cada pantalla.
 *
 * ── Por qué un mapa y no un prop en cada ruta ──
 *
 * La alternativa era envolver las cincuenta rutas de App.jsx en un guardián,
 * una por una. Se descartó por lo que pasa después: cuando alguien agrega la
 * ruta cincuenta y uno, se olvida del envoltorio, y la pantalla nueva queda
 * abierta para todos sin que nada avise. Acá el olvido tiene el efecto opuesto
 * y visible — la ruta no figura en el mapa, cae en el caso por defecto y la
 * decisión de dejarla abierta queda escrita.
 *
 * ── Esto no es la seguridad, es la cortesía ──
 *
 * Ocultar una pantalla no protege el dato: quien sabe escribir la URL igual la
 * pide, y quien abre la consola pide la fila directo. Lo que protege es RLS en
 * Supabase y la verificación del middleware. Esto evita ofrecerle a alguien lo
 * que no va a poder usar, que es un problema distinto y también real.
 */

/**
 * Cada entrada es `[prefijo, permiso]`. El permiso puede ser un arreglo, y ahí
 * alcanza con tener uno: el técnico entra a Instalaciones con
 * `instalaciones.asignadas` aunque no tenga `instalaciones.ver`, porque adentro
 * la pantalla ya le muestra solo lo suyo.
 *
 * `null` es "abierta a cualquiera con sesión".
 */
const RUTAS = [
  ['/', null], // el dashboard lo ve todo el mundo: es la pantalla de entrada

  // Clientes. Las rutas específicas van antes que /clientes porque el mapa
  // resuelve por prefijo más largo, y /clientes/mapa no exige ver la cartera.
  ['/clientes/importar', 'clientes.importar'],
  // El mapa de abonados pide ver la cartera, no ver una ubicación.
  //
  // Estaba pedido con `clientes.ver_ubicacion` y era el mismo agujero que el
  // catálogo de planes tenía para el vendedor: ese permiso existe para que el
  // técnico vea el GPS del cliente al que va, y el cobrador el del moroso que
  // visita — un punto, dentro de una ficha a la que ya tenían derecho. El mapa
  // global es otra cosa: es la base comercial entera, con nombre y estado de
  // cada abonado, exportable de un vistazo.
  ['/clientes/mapa', 'clientes.ver'],
  ['/clientes/instalaciones', ['instalaciones.ver', 'instalaciones.asignadas']],
  ['/clientes/contratos', 'clientes.contratos'],
  ['/clientes', 'clientes.ver'],

  // La bandeja del backoffice va ANTES que /instalaciones: si no, el prefijo
  // más corto la capturaría y se la abriría al técnico.
  ['/instalaciones/nuevas', 'instalaciones.backoffice'],
  // El alta en campo: es lo que hace el técnico parado en la vereda.
  ['/instalaciones', ['instalaciones.completar', 'instalaciones.asignadas']],

  // El inicio del técnico de campo.
  //
  // Tiene que estar acá aunque viva fuera del layout. `PantallaInicial` decide
  // a dónde mandar a cada rol recorriendo esta misma tabla, y una ruta que no
  // figura cae en el comodín de "/" —que no pide permiso— así que mandaba al
  // vendedor y al cajero a la pantalla del técnico, donde rebotaban contra el
  // ConPermiso. El menú y el guardián tienen que leer la misma tabla; en cuanto
  // uno mira otra cosa, aparecen destinos que nadie puede abrir.
  ['/campo', ['instalaciones.asignadas', 'soporte.asignados']],

  // Ventas
  ['/ventas/tablero', 'ventas.dashboard'],
  ['/ventas/prospectos', 'ventas.prospectos'],
  ['/ventas/cobertura', 'ventas.cobertura'],
  ['/ventas/mapa', 'ventas.cobertura'],
  // La cobranza usa el permiso de pagos, no uno de ventas: es cobrar, aunque lo
  // haga quien vendió.
  ['/ventas/cobranza', 'pagos.observaciones'],
  // "Mi comisión" es la pantalla del vendedor sobre lo suyo. Quien tiene
  // `comisiones.ver_todas` también entra —necesita poder ver lo que ve su
  // equipo— pero adentro la pantalla filtra por el legajo de quien mira: no es
  // la comparación del equipo, que vive en Inteligencia comercial.
  ['/ventas/mi-comision', ['comisiones.ver_propias', 'comisiones.ver_todas']],
  // La inteligencia de comisiones es la planilla del canal comercial entero:
  // cuánto cobra cada uno y qué calidad trae. Pide ver todas las comisiones, y
  // va ANTES que '/ventas' para que el prefijo corto no la capture.
  ['/ventas/comisiones', 'comisiones.ver_todas'],
  ['/ventas/cotizador', 'ventas.cotizaciones'],
  // Promociones abre con el permiso de cotizar porque es lo mismo que consultar
  // un precio. Crearlas y editarlas pide `config.planes`, y eso lo resuelve la
  // pantalla adentro: una promo es un precio con fecha, así que la puede definir
  // quien puede tocar los precios.
  ['/ventas/promociones', ['ventas.cotizaciones', 'config.planes']],
  ['/ventas/inteligencia', 'ventas.inteligencia'],
  // Los reportes son agregados, no listas de clientes: alcanza con el permiso
  // de reportes que ya existe.
  ['/ventas/reportes', 'reportes.ver'],
  ['/ventas', ['ventas.dashboard', 'ventas.prospectos', 'ventas.cobertura', 'pagos.observaciones']],

  // Inventario. "Mi almacén" pide el permiso del técnico, no el de bodega: es
  // lo único del módulo que ve alguien que no trabaja en el depósito.
  ['/inventario/mi-almacen', 'inventario.almacen_propio'],
  // Los retiros piden el permiso propio o el de despachar material: quien
  // transfiere equipos a los técnicos es quien recibe los que vuelven. El
  // vendedor no entra acá aunque vea sus propias órdenes desde su cartera.
  ['/inventario/retiros', ['retiros.gestionar', 'inventario.transferir']],
  // Recibir material que devuelve un técnico es lo mismo que despachárselo:
  // quien tiene una cosa tiene la otra.
  ['/inventario/entregas', ['retiros.gestionar', 'inventario.transferir']],
  // Las alertas las configura quien administra: define a qué números sale
  // información de la red y de los abonados.
  ['/ajustes/alertas', ['ajustes.editar', 'nms.ver']],
  ['/ajustes/pagina-corte', ['ajustes.editar']],
  ['/ajustes/plantillas', ['ajustes.editar']],
  // El prestador define con qué datos se firman los contratos: mismo nivel que
  // las plantillas y la página de corte.
  ['/ajustes/prestador', ['ajustes.editar']],
  // Y la firma decide si se pide biometría o alcanza el papel.
  ['/ajustes/firma', ['ajustes.editar']],
  ['/inventario/movimientos', 'inventario.movimientos'],
  ['/inventario/compras', ['inventario.compras', 'inventario.proveedores']],
  ['/inventario/stock', 'inventario.ver'],
  ['/inventario', 'inventario.ver'],

  // Servicios. Los dos hijos se separan a propósito: el vendedor consulta el
  // catálogo para saber qué ofrecer, pero los perfiles de velocidad son las
  // traffic tables de las OLTs y los perfiles PPP de los routers — configuración
  // de red que no tiene nada que hacer en manos de quien vende.
  ['/servicios/velocidades', 'config.planes'],
  ['/servicios/planes', ['ventas.planes', 'config.planes']],
  ['/servicios', ['ventas.planes', 'config.planes']],

  // Finanzas
  ['/pagos', ['pagos.ver', 'pagos.registrar']],
  /**
   * Transacciones es el cierre de caja del ISP ENTERO.
   *
   * Pedía `pagos.ver`, que lo tiene cualquiera que cobre: un punto de recaudación
   * entraba y veía lo que cobraron todos los demás. Lo encontró una prueba desde
   * ese perfil, no una revisión del mapa.
   *
   * Ahora pide el permiso de consolidar. Quien solo cobra tiene su propio resumen
   * en su pantalla de inicio, con lo suyo.
   */
  ['/transacciones', ['finanzas.ver_todos', 'finanzas.transferencias']],

  /**
   * Estas dos no figuraban en el mapa, y eso las dejaba abiertas a cualquiera con
   * sesión — el caso por defecto. Es exactamente el olvido que este archivo
   * describe en su encabezado, cometido dos veces seguidas.
   */
  /**
   * El tablero de quien recauda: lo suyo y nada más.
   *
   * Lo puede abrir cualquiera que cobre —incluido el cajero, que también quiere
   * ver cuánto lleva hoy—. No muestra plata de otros: la vista que lo alimenta
   * filtra por quien está mirando.
   */
  ['/recaudacion', 'pagos.registrar'],
  ['/conciliacion', 'finanzas.conciliacion'],
  ['/arcotel', 'finanzas.reporte_arcotel'],
  ['/estadisticas', ['reportes.ver', 'finanzas.reportes']],
  ['/facturacion', 'facturacion.ver'],

  // Soporte. Técnicos y cuadrillas es gestión de gente, no de tickets: quien
  // decide quién recibe una orden de trabajo está administrando personal.
  ['/soporte/tecnicos', 'usuarios.ver'],
  // La comparación de desempeño la ve quien dirige el campo: quien ve TODAS las
  // instalaciones. Va ANTES que '/soporte' porque el mapa resuelve por prefijo
  // más largo — sin esta línea caería en el permiso de la bandeja de tickets y
  // se le ofrecería al técnico.
  //
  // Aunque escribiera la URL a mano no vería nada ajeno: `v_desempeno_tecnico`
  // lleva `security_invoker`, así que le devuelve solo sus propias filas. Esto
  // es para que el menú no ofrezca lo que no le corresponde.
  ['/soporte/desempeno', 'instalaciones.ver'],
  // Los ingresos del día piden lo mismo que el desempeño: las dos son la
  // pantalla de quien dirige el equipo, no la del técnico sobre lo suyo.
  ['/soporte/jornadas', 'instalaciones.ver'],
  // Los vehículos los administra quien maneja el campo. El técnico los ve desde
  // su jornada, para elegir con cuál sale, pero no los da de alta.
  ['/soporte/vehiculos', 'instalaciones.ver'],
  ['/soporte', ['soporte.ver', 'soporte.asignados']],

  // OLT / GPON
  ['/gpon', 'red.olts_ver'],
  ['/olts', 'red.olts_ver'],
  // El catálogo de modelos de ONT no tiene datos de nadie: es útil para el
  // técnico y no revela nada.
  // El catálogo de modelos de ONT no es una pantalla de consulta: crea y borra
  // tipos. Estaba pedido con `red.onus_ver` —un permiso de LECTURA— y por eso le
  // aparecía al técnico, que podía borrar un modelo del catálogo desde su menú.
  //
  // Va con el permiso de aprovisionar porque es quien de verdad lo usa: el
  // catálogo existe para autorizar una ONU, no para mirarlo.
  ['/onu-types', ['red.onus_aprovisionar', 'red.olts_gestionar']],
  ['/onus/aprovisionar', 'red.onus_aprovisionar'],
  // El listado global de ONUs y las métricas ópticas traen el nombre del
  // abonado de cada equipo: son la cartera por otro camino. Piden ver la red
  // completa, que es lo que el técnico no tiene — él ve la ONT de su trabajo
  // desde la ficha del cliente del ticket.
  ['/onus', 'red.olts_ver'],
  ['/naps', 'red.olts_ver'],
  ['/perfiles', 'red.olts_gestionar'],
  ['/tr069', 'red.olts_ver'],
  ['/metricas', 'red.olts_ver'],

  // Infraestructura
  ['/red/routers', 'red.routers'],
  ['/red', 'red.ipam'],
  ['/mikrotik', 'red.routers'],
  // Va ANTES que '/monitoreo' porque el mapa resuelve por prefijo más largo.
  // Ver la lista de averías alcanza con poder ver el monitoreo; abrirlas —que le
  // escribe a cientos de abonados— lo decide `red.incidencias` adentro.
  ['/monitoreo/incidencias', ['red.monitoreo_ver', 'red.incidencias']],
  ['/monitoreo', 'red.monitoreo'],
  ['/bloqueos', 'red.cortes'],

  // Ajustes. La entrada genérica va última: cualquier sección que no esté
  // listada arriba exige al menos poder tocar la configuración general.
  ['/ajustes/personal', 'usuarios.ver'],
  // Ver el esquema alcanza para entrar; editarlo pide `comisiones.configurar` y
  // lo resuelve la pantalla adentro. Quien aprueba comisiones necesita poder
  // mirar con qué reglas se calcularon.
  // El simulador va ANTES que la configuración porque pide otro permiso: probar
  // escenarios no es definir lo que se paga. Aplicar sí lo es, y ese botón exige
  // `comisiones.configurar` adentro de la pantalla.
  ['/ajustes/comisiones/simulador', ['comisiones.simular', 'comisiones.configurar']],
  ['/ajustes/comisiones', ['comisiones.configurar', 'comisiones.ver_todas']],
  ['/ajustes/licencia', 'config.licencia'],
  // Emitir una llave de API es darle a un sistema de afuera permiso para
  // consultar abonados y, si se marca, para cobrar. Va con su propio permiso y
  // no con `config.general`: quien configura el nombre de la empresa no tiene
  // por qué poder abrirle la puerta al proveedor del CRM.
  ['/ajustes/integraciones', 'config.integraciones'],
  ['/ajustes/crontab', 'config.tareas'],
  // Va ANTES de '/ajustes' por el prefijo más largo. Mismo permiso que la
  // mensajería: una plantilla sin aprobar no manda un mensaje feo, no manda
  // nada, y el abonado no se entera de que le van a cortar.
  ['/ajustes/plantillas-whatsapp', 'config.mensajeria'],
  ['/ajustes/mensajeria', 'config.mensajeria'],
  ['/ajustes/correo', 'config.mensajeria'],
  ['/ajustes', 'config.general'],
]

// Del prefijo más largo al más corto, una vez y no en cada navegación. Sin este
// orden "/clientes" ganaría sobre "/clientes/mapa" y el cobrador —que puede ver
// la ubicación pero no la cartera— se quedaría sin el mapa.
const ORDENADAS = [...RUTAS].sort((a, b) => b[0].length - a[0].length)

const coincide = (ruta, prefijo) =>
  prefijo === '/' ? ruta === '/' : ruta === prefijo || ruta.startsWith(`${prefijo}/`)

/**
 * El permiso que exige una ruta. `null` = abierta.
 *
 * Una ruta que no figura queda abierta a propósito: preferimos que una pantalla
 * nueva se vea de más a que el sistema empiece a negar accesos que nadie
 * configuró. El costo de equivocarse en esa dirección es que alguien vea un
 * botón que no le sirve; en la otra, que no pueda trabajar.
 */
export function permisoDeRuta(ruta) {
  const entrada = ORDENADAS.find(([prefijo]) => coincide(ruta, prefijo))
  return entrada ? entrada[1] : null
}

/** ¿Puede entrar acá? `puede` es el del contexto de sesión. */
export function puedeEntrar(puede, ruta) {
  const permiso = permisoDeRuta(ruta)
  if (!permiso) return true
  return Array.isArray(permiso) ? permiso.some((p) => puede(p)) : puede(permiso)
}
