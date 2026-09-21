/**
 * El catálogo de permisos y las plantillas de rol.
 *
 * Vive en el frente porque el frente es quien dibuja los checkboxes, pero el
 * middleware importa este mismo archivo para validar. Tener dos copias sería
 * peor que tener una en el lugar imperfecto: la copia del servidor se
 * desactualiza y termina autorizando lo que la pantalla ya no ofrece.
 *
 * ── Cómo se lee un permiso ──
 *
 * La clave es `modulo.accion`. El comodín `*` es "todo" y solo lo tiene el
 * Super Administrador; `modulo.*` no existe a propósito — un permiso que se
 * expande solo es un permiso que nadie revisa.
 *
 * ── Rol contra permisos ──
 *
 * El rol NO decide qué puede hacer alguien: decide qué checkboxes vienen
 * marcados al crearlo. Lo que vale después es la lista guardada. La única
 * excepción es quién puede crear a quién, que se resuelve por rol y en el
 * servidor: un Administrador no puede fabricarse un par, aunque le marquen el
 * checkbox de "crear usuarios".
 */

export const TODO = '*'

/**
 * Los permisos, agrupados como se muestran en pantalla.
 *
 * El orden de los grupos es el del menú lateral, no alfabético: quien configura
 * un rol lo hace pensando en las pantallas que esa persona va a abrir.
 */
export const GRUPOS_PERMISOS = [
  {
    clave: 'clientes',
    nombre: 'Clientes',
    permisos: [
      {
        clave: 'clientes.cartera',
        nombre: 'Leer cualquier cliente de la base',
        nota: 'El control de fondo: sin esto, la base de datos misma le niega las filas que no le corresponden. Quitárselo a alguien lo deja viendo solo sus asignaciones, aunque escriba la URL a mano.',
      },
      { clave: 'clientes.ver', nombre: 'Abrir el listado de clientes', nota: 'Es la pantalla. El cajero cobra sin tenerlo: busca por cédula, no navega la cartera.' },
      { clave: 'clientes.crear', nombre: 'Crear clientes' },
      { clave: 'clientes.editar', nombre: 'Editar clientes' },
      { clave: 'clientes.eliminar', nombre: 'Eliminar clientes' },
      { clave: 'clientes.importar', nombre: 'Importar abonados' },
      { clave: 'clientes.ver_contacto', nombre: 'Ver teléfono y correo' },
      { clave: 'clientes.ver_direccion', nombre: 'Ver dirección' },
      { clave: 'clientes.ver_ubicacion', nombre: 'Ver ubicación en el mapa' },
      { clave: 'clientes.contratos', nombre: 'Contratos' },
    ],
  },
  {
    clave: 'facturacion',
    nombre: 'Facturación',
    permisos: [
      { clave: 'facturacion.ver', nombre: 'Consultar facturas' },
      { clave: 'facturacion.emitir', nombre: 'Emitir facturas' },
      { clave: 'facturacion.editar', nombre: 'Editar facturas' },
      { clave: 'facturacion.anular', nombre: 'Anular facturas' },
      { clave: 'facturacion.reimprimir', nombre: 'Reimprimir facturas' },
      { clave: 'facturacion.vencidas', nombre: 'Ver facturas vencidas' },
      { clave: 'facturacion.estado_cuenta', nombre: 'Ver estado de cuenta' },
    ],
  },
  {
    clave: 'pagos',
    nombre: 'Pagos y cobranza',
    permisos: [
      { clave: 'pagos.ver', nombre: 'Ver pagos' },
      { clave: 'pagos.registrar', nombre: 'Registrar pagos' },
      { clave: 'pagos.parcial', nombre: 'Registrar pagos parciales' },
      /**
       * ── Las dos que separan una ventanilla de un punto de recaudación ──
       *
       * El punto de recaudación cobra SOLO en efectivo: la plata se la entregan
       * en la mano. Dejarle elegir "transferencia" abre la puerta a que registre
       * un cobro que nunca entró y se lo lleve la caja — y encima aparecería en
       * la conciliación como un comprobante sin respaldo, mandando a llamar a un
       * abonado que sí pagó.
       *
       * Y el recibo se imprime solo: es lo que se le entrega al cliente ahí
       * mismo. En la ventanilla de la oficina no siempre se imprime —el que paga
       * cinco facturas quiere una sola hoja— así que ahí sigue siendo a pedido.
       */
      {
        clave: 'pagos.otras_formas',
        nombre: 'Cobrar por transferencia, depósito o tarjeta',
        nota: 'Sin esto solo se puede cobrar en efectivo. Es lo que corresponde a un punto de recaudación: la plata se la entregan en la mano.',
      },
      {
        clave: 'pagos.recibo_automatico',
        nombre: 'Imprimir el recibo apenas se cobra',
        nota: 'El comprobante sale solo al terminar el cobro, para entregárselo al cliente.',
      },
      { clave: 'pagos.anular', nombre: 'Anular pagos' },
      { clave: 'pagos.promesas', nombre: 'Registrar promesas y compromisos de pago' },
      { clave: 'pagos.deudores', nombre: 'Ver clientes con deuda' },
      { clave: 'pagos.observaciones', nombre: 'Registrar observaciones de cobranza' },
    ],
  },
  {
    clave: 'finanzas',
    nombre: 'Finanzas',
    permisos: [
      { clave: 'finanzas.dashboard', nombre: 'Dashboard financiero' },
      { clave: 'finanzas.ingresos', nombre: 'Ver y registrar ingresos' },
      { clave: 'finanzas.egresos', nombre: 'Ver y registrar egresos' },
      { clave: 'finanzas.cuentas_cobrar', nombre: 'Cuentas por cobrar' },
      { clave: 'finanzas.transferencias', nombre: 'Ver transferencias' },
      { clave: 'finanzas.reportes', nombre: 'Reportes financieros' },
      { clave: 'finanzas.exportar', nombre: 'Exportar reportes' },
      /**
       * ── Los tres permisos de consolidación ──
       *
       * Son la diferencia entre cobrar y CONSOLIDAR. Quien cobra ve lo suyo;
       * quien consolida ve la caja de todos, cruza el extracto del banco y arma
       * el reporte del regulador.
       *
       * Existen por separado porque se delegan por separado: el contador puede
       * necesitar conciliar sin ver el cierre de cada punto de recaudación.
       *
       * Sin `finanzas.ver_todos`, la pantalla de transacciones y su PDF muestran
       * SOLO lo que cobró quien está mirando. Eso no lo decide la pantalla: lo
       * decide el servidor, porque esconder una columna no protege un dato.
       */
      {
        clave: 'finanzas.ver_todos',
        nombre: 'Ver los cobros de todos los operadores',
        nota: 'Sin esto, Transacciones y su reporte muestran solo lo que cobró uno mismo. Es lo que separa cerrar la caja propia de consolidar la de todos.',
      },
      {
        clave: 'finanzas.conciliacion',
        nombre: 'Conciliación bancaria',
        nota: 'Subir el extracto del banco y cruzarlo contra los cobros.',
      },
      {
        clave: 'finanzas.reporte_arcotel',
        nombre: 'Reporte para ARCOTEL',
        nota: 'Armar y exportar el listado que pide el regulador.',
      },
    ],
  },
  {
    clave: 'ventas',
    nombre: 'Ventas',
    permisos: [
      { clave: 'ventas.dashboard', nombre: 'Ver el dashboard comercial' },
      { clave: 'ventas.prospectos', nombre: 'Crear y editar prospectos' },
      { clave: 'ventas.oportunidades', nombre: 'Gestionar oportunidades' },
      { clave: 'ventas.actividad', nombre: 'Registrar llamadas, visitas y seguimientos' },
      { clave: 'ventas.solicitudes', nombre: 'Crear solicitudes de instalación' },
      { clave: 'ventas.cobertura', nombre: 'Verificar cobertura y ver el mapa comercial' },
      { clave: 'ventas.planes', nombre: 'Consultar planes y precios' },
      { clave: 'ventas.cotizaciones', nombre: 'Generar cotizaciones' },
      {
        clave: 'ventas.inteligencia',
        nombre: 'Inteligencia comercial',
        nota: 'Dónde piden servicio y no llegamos. Es información de expansión: la mira quien decide dónde tender red, no quien vende.',
      },
      {
        clave: 'ventas.equipo',
        nombre: 'Ver el equipo completo y fijar metas',
        nota: 'Sin esto, el vendedor ve solo su propia cartera y su propia meta.',
      },
      {
        clave: 'ventas.validar',
        nombre: 'Aprobar o rechazar solicitudes',
        nota: 'La admisión del abonado. Decide si una venta puede seguir adelante, así que no la tiene quien vende.',
      },
      {
        clave: 'ventas.validacion_sensible',
        nombre: 'Ver el detalle interno de una validación',
        nota: 'El motivo real por el que se aprobó o rechazó. El vendedor solo ve el motivo que se le comunica; esto es lo que hay detrás.',
      },
    ],
  },
  {
    clave: 'soporte',
    nombre: 'Tickets',
    permisos: [
      { clave: 'soporte.ver', nombre: 'Ver todos los tickets' },
      { clave: 'soporte.asignados', nombre: 'Ver sus tickets asignados', nota: 'Es lo mínimo del técnico: solo lo suyo.' },
      { clave: 'soporte.crear', nombre: 'Crear tickets' },
      { clave: 'soporte.asignar', nombre: 'Asignar tickets a técnicos' },
      { clave: 'soporte.estado', nombre: 'Cambiar estados del ticket' },
      { clave: 'soporte.cerrar', nombre: 'Cerrar tickets' },
    ],
  },
  {
    clave: 'instalaciones',
    nombre: 'Instalaciones',
    permisos: [
      { clave: 'instalaciones.ver', nombre: 'Ver todas las instalaciones' },
      { clave: 'instalaciones.asignadas', nombre: 'Ver sus instalaciones asignadas' },
      { clave: 'instalaciones.crear', nombre: 'Crear órdenes de instalación' },
      { clave: 'instalaciones.completar', nombre: 'Completar el alta en campo' },
      { clave: 'instalaciones.materiales', nombre: 'Registrar materiales utilizados' },
      {
        clave: 'instalaciones.backoffice',
        nombre: 'Bandeja de nuevas instalaciones',
        nota: 'Revisar el expediente que mandó el vendedor, validar la cédula, asignar técnico y poner fecha.',
      },
    ],
  },
  {
    clave: 'red',
    nombre: 'Red',
    permisos: [
      { clave: 'red.olts_ver', nombre: 'Ver OLTs y su estado' },
      { clave: 'red.olts_gestionar', nombre: 'Configurar OLTs' },
      { clave: 'red.onus_ver', nombre: 'Ver ONUs y potencias' },
      { clave: 'red.onus_aprovisionar', nombre: 'Autorizar y aprovisionar ONUs' },
      { clave: 'red.routers', nombre: 'Routers MikroTik' },
      { clave: 'red.ipam', nombre: 'Direccionamiento y VLANs' },
      {
        clave: 'red.diagnostico',
        nombre: 'Diagnosticar la conexión de un abonado',
        nota: 'Leer su señal, pinguearlo y reiniciarle la ONT. Es lo que se le habilita al bot para que resuelva "no tengo internet" sin pasar por una persona: solo toca el equipo del abonado que consulta.',
      },
      {
        clave: 'red.incidencias',
        nombre: 'Avisar cortes masivos a los abonados',
        nota: 'Abrir una incidencia le manda un mensaje a todos los afectados —pueden ser cientos— y no se puede desenviar. Va aparte de ver el monitoreo: mirar qué nodos están caídos es una cosa, escribirle a un sector en nombre del ISP es otra.',
      },
      {
        clave: 'red.wifi',
        nombre: 'Cambiar el WiFi del abonado',
        nota: 'El nombre de la red y su clave, por TR-069. Lo usa el soporte y es lo que se le habilita al bot para que resuelva el cambio de contraseña sin pasar por una persona.',
      },
      {
        clave: 'red.monitoreo_ver',
        nombre: 'Ver el estado de la red',
        nota: 'Solo mirar: qué nodos están arriba y cuáles caídos. Es lo que el técnico necesita en campo para saber si la falla es del cliente o de la zona.',
      },
      {
        clave: 'red.monitoreo',
        nombre: 'Monitor de red: configurar y sondear',
        nota: 'Incluye forzar sondeos y dar de alta nodos. Quien solo mira alcanza con el permiso de arriba.',
      },
      { clave: 'red.cortes', nombre: 'Cortes y reconexiones' },
    ],
  },
  {
    clave: 'inventario',
    nombre: 'Inventario y bodega',
    permisos: [
      { clave: 'inventario.ver', nombre: 'Ver el stock' },
      { clave: 'inventario.ingresos', nombre: 'Registrar ingresos de material' },
      { clave: 'inventario.salidas', nombre: 'Registrar salidas de material' },
      { clave: 'inventario.compras', nombre: 'Registrar compras' },
      { clave: 'inventario.proveedores', nombre: 'Gestionar proveedores' },
      { clave: 'inventario.transferir', nombre: 'Transferir material a técnicos' },
      { clave: 'inventario.movimientos', nombre: 'Ver movimientos' },
      { clave: 'inventario.almacen_propio', nombre: 'Ver su almacén personal' },
      {
        clave: 'retiros.gestionar',
        nombre: 'Retiros de equipo a ex abonados',
        nota: 'Abrir, asignar y cerrar las órdenes de recuperación de ONT. El equipo recuperado vuelve al stock; el no recuperado queda registrado como pérdida, sin descontárselo a nadie.',
      },
    ],
  },
  {
    clave: 'reportes',
    nombre: 'Reportes',
    permisos: [
      { clave: 'reportes.ver', nombre: 'Ver reportes y estadísticas' },
      { clave: 'reportes.exportar', nombre: 'Exportar reportes' },
    ],
  },
  {
    clave: 'usuarios',
    nombre: 'Personal',
    permisos: [
      { clave: 'usuarios.ver', nombre: 'Ver el personal' },
      { clave: 'usuarios.crear', nombre: 'Crear usuarios' },
      { clave: 'usuarios.editar', nombre: 'Editar usuarios' },
      { clave: 'usuarios.eliminar', nombre: 'Eliminar usuarios' },
      { clave: 'usuarios.permisos', nombre: 'Configurar permisos' },
      {
        clave: 'usuarios.admins',
        nombre: 'Crear y editar Administradores',
        nota: 'Reservado al Super Administrador: el servidor lo rechaza para cualquier otro rol.',
        soloSuper: true,
      },
    ],
  },
  {
    clave: 'config',
    nombre: 'Configuración',
    permisos: [
      { clave: 'config.general', nombre: 'General y empresa' },
      { clave: 'config.facturacion', nombre: 'Facturación electrónica y SRI' },
      { clave: 'config.mensajeria', nombre: 'Mensajería y correo' },
      { clave: 'config.planes', nombre: 'Servicios, planes y velocidades' },
      { clave: 'config.tareas', nombre: 'Tareas programadas' },
      { clave: 'config.licencia', nombre: 'Licencia' },
      {
        clave: 'config.integraciones',
        nombre: 'Integraciones y llaves de API',
        nota: 'Emitir y revocar las llaves con las que entran el CRM, el bot de WhatsApp y los webhooks de las pasarelas. Quien tiene esto puede darle a un sistema externo permiso para cobrar: va con el mismo cuidado que crear un usuario.',
      },
      {
        clave: 'config.seguridad',
        nombre: 'Configuraciones críticas de seguridad',
        nota: 'Reservado al Super Administrador.',
        soloSuper: true,
      },
    ],
  },
  {
    clave: 'comisiones',
    nombre: 'Comisiones e incentivos',
    permisos: [
      {
        clave: 'comisiones.ver_propias',
        nombre: 'Ver mi comisión y mi progreso',
        nota: 'Lo que necesita el vendedor: sus ventas válidas, su nivel y cuánto le falta para el siguiente. Nunca las de otro.',
      },
      {
        clave: 'comisiones.ver_todas',
        nombre: 'Ver las comisiones de todo el equipo',
        nota: 'Comparar vendedores y ver el costo comercial. Es información financiera del personal: no la tiene quien vende.',
      },
      {
        clave: 'comisiones.configurar',
        nombre: 'Configurar bases, escalones, bonos y reglas',
        nota: 'Define cuánto se le paga a todos. Cada cambio crea una versión nueva y queda en la auditoría.',
      },
      {
        clave: 'comisiones.aprobar',
        nombre: 'Aprobar comisiones de un período cerrado',
      },
      {
        clave: 'comisiones.pagar',
        nombre: 'Marcar comisiones como pagadas',
        nota: 'Separado de aprobar a propósito: conviene que quien autoriza el gasto no sea quien lo ejecuta.',
      },
      {
        clave: 'comisiones.anular',
        nombre: 'Anular una comisión',
        nota: 'Solo con motivo escrito. Una comisión aprobada no se reduce por bajas posteriores: se anula por fraude o error, y queda registrado.',
      },
      {
        clave: 'comisiones.simular',
        nombre: 'Usar el simulador',
        nota: 'Probar porcentajes y escalones sin tocar la configuración real.',
      },
    ],
  },
  {
    clave: 'auditoria',
    nombre: 'Auditoría',
    permisos: [
      { clave: 'auditoria.ver', nombre: 'Ver la auditoría' },
      { clave: 'auditoria.logs', nombre: 'Ver los logs del sistema' },
    ],
  },
]

/** Todas las claves válidas, plano. Lo usa la validación del middleware. */
export const CLAVES_PERMISO = GRUPOS_PERMISOS.flatMap((g) => g.permisos.map((p) => p.clave))

/** Las claves que solo tienen sentido en manos del Super Administrador. */
export const CLAVES_SOLO_SUPER = GRUPOS_PERMISOS.flatMap((g) =>
  g.permisos.filter((p) => p.soloSuper).map((p) => p.clave),
)

const todasDe = (...grupos) =>
  GRUPOS_PERMISOS.filter((g) => grupos.includes(g.clave))
    .flatMap((g) => g.permisos)
    .filter((p) => !p.soloSuper)
    .map((p) => p.clave)

/**
 * Los roles y lo que cada uno trae marcado.
 *
 * `puede` y `noPuede` no son decorativos: son lo que se le muestra al
 * administrador antes de que confirme, para que la elección del rol sea una
 * decisión informada y no un nombre elegido por parecido.
 */
export const ROLES = [
  {
    clave: 'super_admin',
    nombre: 'Super Administrador',
    color: 'rojo',
    resumen: 'Acceso total. Es el único que puede crear, editar o eliminar Administradores.',
    permisos: [TODO],
    puede: ['Todo el sistema', 'Crear y eliminar Administradores', 'Configuración de seguridad', 'Auditoría y logs'],
    noPuede: [],
  },
  {
    clave: 'admin',
    nombre: 'Administrador',
    color: 'ambar',
    resumen: 'Maneja la operación diaria y crea al resto del personal, menos otros Administradores.',
    permisos: [
      ...todasDe('clientes', 'facturacion', 'pagos', 'ventas', 'soporte', 'instalaciones', 'red', 'inventario', 'reportes'),
      'finanzas.dashboard',
      'finanzas.reportes',
      /**
       * El Administrador consolida: es quien cierra la caja de todos y arma lo
       * que se manda afuera. El Super Administrador lo tiene por `TODO`.
       *
       * Cualquier otro perfil los recibe uno por uno desde Gestión de personal,
       * que es como se delega sin regalar el resto del módulo financiero.
       */
      'finanzas.ver_todos',
      'finanzas.conciliacion',
      'finanzas.reporte_arcotel',
      'usuarios.ver',
      'usuarios.crear',
      'usuarios.editar',
      'usuarios.permisos',
      'ventas.equipo',
      'config.general',
      'config.mensajeria',
      'config.planes',
      'config.facturacion',
      // Las llaves del CRM y del bot. Va con el Administrador y no más abajo:
      // emitir una llave que puede cobrar es del mismo peso que crear a un
      // cobrador, y eso ya es suyo.
      'config.integraciones',
      'auditoria.ver',
      // Ve y aprueba lo del equipo, pero NO define cuánto se paga ni marca
      // pagado: esas dos son del Super Administrador hasta que decidas delegarlas.
      'comisiones.ver_todas',
      'comisiones.aprobar',
    ],
    puede: ['Crear técnicos, cobradores, cajeros, vendedores, finanzas y bodega', 'Clientes, inventario, tickets e instalaciones', 'Ver reportes'],
    noPuede: ['Crear otros Administradores ni Super Administradores', 'Modificar a un Super Administrador', 'Tocar la configuración crítica de seguridad'],
  },
  {
    clave: 'finanzas',
    nombre: 'Finanzas',
    color: 'verde',
    resumen: 'Ve el dinero entero: ingresos, egresos, cartera y reportes. No toca la red.',
    permisos: [
      ...todasDe('finanzas'),
      'clientes.cartera',
      'clientes.ver',
      'clientes.ver_contacto',
      'facturacion.ver',
      'facturacion.emitir',
      'facturacion.editar',
      'facturacion.vencidas',
      'facturacion.estado_cuenta',
      'pagos.ver',
      'pagos.registrar',
      'pagos.parcial',
      // Finanzas cobra por donde sea: es quien concilia después.
      'pagos.otras_formas',
      'pagos.promesas',
      'pagos.deudores',
      ...todasDe('reportes'),
    ],
    puede: ['Dashboard financiero, ingresos y egresos', 'Facturar, registrar pagos y promesas', 'Reportes financieros y exportarlos'],
    noPuede: ['Configurar OLTs', 'Gestionar usuarios', 'Aprovisionar servicios', 'Gestionar instalaciones técnicas'],
  },
  {
    clave: 'cobrador',
    nombre: 'Cobrador',
    color: 'ambar',
    resumen: 'Sale a cobrar: ve al moroso, cómo ubicarlo y registra lo que trae.',
    permisos: [
      'clientes.cartera',
      'clientes.ver_contacto',
      'clientes.ver_direccion',
      'clientes.ver_ubicacion',
      'pagos.deudores',
      'pagos.registrar',
      'pagos.parcial',
      'pagos.otras_formas',
      'pagos.promesas',
      'pagos.observaciones',
      'facturacion.ver',
      'facturacion.vencidas',
      'facturacion.estado_cuenta',
    ],
    puede: ['Ver clientes con deuda, su teléfono, dirección y ubicación', 'Registrar pagos y compromisos', 'Consultar facturas vencidas'],
    noPuede: ['Crear o eliminar clientes', 'Crear usuarios', 'Gestionar inventario', 'Tocar la configuración'],
  },
  {
    clave: 'cajero',
    nombre: 'Cajero',
    color: 'azul',
    resumen: 'Atiende la ventanilla: cobra, factura y reimprime.',
    permisos: [
      'clientes.cartera',
      'clientes.ver_contacto',
      'pagos.registrar',
      'pagos.ver',
      'pagos.otras_formas',
      'facturacion.ver',
      'facturacion.emitir',
      'facturacion.reimprimir',
      'facturacion.estado_cuenta',
    ],
    puede: ['Registrar pagos', 'Emitir y reimprimir facturas', 'Consultar el estado de cuenta'],
    noPuede: ['Configurar el sistema', 'Gestionar usuarios', 'Gestionar inventario', 'Aprovisionar servicios'],
  },
  {
    clave: 'recaudacion',
    nombre: 'Punto de recaudación',
    color: 'verde',
    resumen: 'La tienda que cobra el internet: busca al abonado, cobra el total e imprime. Nada más.',
    /**
     * ── Por qué no alcanzaba con el Cajero ──
     *
     * El cajero de la oficina emite facturas, consulta estados de cuenta y puede
     * tomar un abono parcial. Un punto de recaudación hace UNA cosa —cobrar lo
     * que se debe, completo— y todo lo demás que pueda hacer es superficie para
     * equivocarse en un mostrador donde no hay a quién preguntarle.
     *
     * Sin `clientes.ver`: no navega la cartera, la busca. Es la diferencia entre
     * atender a quien llega y poder llevarse el padrón entero del ISP.
     *
     * Sin `pagos.parcial`: no negocia montos. Es la regla que más tienta a
     * saltarse —"solo tengo veinte"— y el resultado es una factura a medio pagar
     * que el abonado cree cancelada y un corte que llega igual.
     */
    permisos: [
      'clientes.cartera',
      'pagos.registrar',
      'pagos.ver',
      'facturacion.reimprimir',
      // Cobra en efectivo y entrega el comprobante: las dos cosas que hace.
      // Sin `pagos.otras_formas`, la pantalla no le ofrece transferencia.
      'pagos.recibo_automatico',
    ],
    puede: [
      'Buscar un abonado por nombre, cédula o contrato',
      'Cobrar el valor completo de lo que debe',
      'Imprimir el comprobante',
      'Ver y exportar lo que él mismo recaudó',
    ],
    noPuede: [
      'Abrir el listado de clientes',
      'Cobrar montos parciales',
      'Editar facturas, nombres ni ningún dato',
      'Ver lo que recaudaron los demás',
    ],
  },
  {
    clave: 'vendedor',
    nombre: 'Vendedor',
    color: 'gris',
    resumen: 'Trabaja el prospecto hasta la solicitud de instalación. No ve plata.',
    // Sin `clientes.ver_ubicacion`: ese permiso abre el mapa de abonados, que
    // es la cartera completa del ISP con nombre y estado de cada uno. El
    // vendedor tiene su propio mapa —el de cobertura—, que no muestra ni un
    // cliente. Dárselo por comodidad sería entregarle la base comercial entera
    // a quien más fácil se la lleva a la competencia.
    // Sin `ventas.equipo`: el vendedor ve su cartera y su meta, no la del
    // resto. Quién vende cuánto es información de quien dirige, y ponerla en la
    // pantalla de todos convierte el tablero en un ranking.
    permisos: [
      // Sin `ventas.planes`: ese permiso solo abre la pantalla de Servicios, y
      // ahí el vendedor no tiene nada que hacer. El plan se elige donde importa
      // —dentro del Cotizador y de la ficha del prospecto— con el catálogo
      // vigente y su precio. Una pantalla más con la misma lista es un lugar
      // extra donde mirar un precio que puede estar desactualizado respecto del
      // que la cotización acaba de congelar.
      ...todasDe('ventas').filter(
        (c) => !['ventas.equipo', 'ventas.inteligencia', 'ventas.planes'].includes(c),
      ),
      'clientes.ver_contacto',
      // Cobrar lo que vendió, dentro de su ventana. Es el único permiso de
      // `pagos` que tiene, y a propósito: registra la GESTIÓN del cobro, no el
      // pago. El dinero lo recibe caja.
      'pagos.observaciones',
      // Su comisión, no la de nadie más. Sin esto el módulo no cumple su
      // objetivo: un incentivo que el vendedor no puede ver no incentiva.
      'comisiones.ver_propias',
    ],
    puede: [
      'Prospectos, oportunidades, llamadas y visitas',
      'Mapa de cobertura: hasta dónde se vende y dónde hay puerto libre',
      'Consultar el catálogo de planes y su precio',
      'Cotizaciones y solicitudes de instalación',
      'Ver su propia comisión, su nivel y cuánto le falta para el siguiente',
    ],
    noPuede: [
      'Ver la cartera de clientes ni su mapa',
      'Editar planes, precios o perfiles de velocidad',
      'Ver reportes financieros ni registrar pagos',
      'Ver la comisión de otro vendedor ni el costo comercial del equipo',
      'Gestionar inventario o configurar el sistema',
    ],
  },
  {
    clave: 'supervisor_ventas',
    nombre: 'Supervisor de ventas',
    color: 'verde',
    resumen: 'Dirige al equipo comercial: metas, embudo y cobranzas. No accede a la base de abonados.',
    // Sin `clientes.cartera`, y es la decisión que define el rol.
    //
    // La versión anterior de este rol —un "Supervisor" que hacía las dos cosas—
    // lo tenía, y eso le daba a un jefe comercial exactamente lo que acabamos de
    // quitarle a los vendedores. Con más motivo para llevárselo, además, porque
    // maneja al equipo entero.
    //
    // Ve el embudo y el rendimiento de su gente. Un dato puntual de un abonado
    // se lo pide a administración, y ese pedido queda registrado.
    permisos: [
      // Igual que el vendedor: el catálogo se consulta desde el Cotizador, no
      // desde una pantalla de configuración de servicios.
      ...todasDe('ventas').filter((c) => c !== 'ventas.planes'),
      'clientes.ver_contacto',
      // Supervisa las cobranzas del equipo, así que abre la bandeja.
      'pagos.observaciones',
      ...todasDe('reportes'),
      // Para poder mirar qué está haciendo su equipo: quién abre cuántas fichas
      // es justamente lo que un jefe de ventas tiene que poder revisar.
      'auditoria.ver',
      // Ve las comisiones del equipo y las aprueba. No define cuánto se paga
      // —eso mueve el costo comercial de la empresa entera— ni marca pagado.
      'comisiones.ver_propias',
      'comisiones.ver_todas',
      'comisiones.aprobar',
      'comisiones.simular',
    ],
    puede: [
      'El tablero comercial del equipo completo, y fijar las metas',
      'Ver los prospectos, cotizaciones y cobranzas de sus vendedores',
      'Reportes comerciales y auditoría del equipo',
      'Ver y aprobar las comisiones del equipo, y simular escenarios',
    ],
    noPuede: [
      'Abrir la base de abonados ni buscar en ella',
      'Asignar técnicos ni tocar instalaciones',
      'Registrar pagos o tocar la red',
    ],
  },
  {
    clave: 'jefe_tecnico',
    nombre: 'Jefe técnico',
    color: 'azul',
    resumen: 'Operaciones: recibe las ventas cerradas, valida el expediente, asigna técnicos y controla la red.',
    permisos: [
      // Con la cartera, y acá sí corresponde: para despachar una cuadrilla hay
      // que ver al abonado, su dirección y su historial de fallas.
      'clientes.cartera',
      'clientes.ver',
      'clientes.ver_contacto',
      'clientes.ver_direccion',
      'clientes.ver_ubicacion',
      ...todasDe('soporte', 'instalaciones', 'reportes'),
      'ventas.inteligencia',
      // Ve el personal porque de ahí elige a quién asignar cada trabajo.
      'usuarios.ver',
      'red.olts_ver',
      'red.onus_ver',
      'red.monitoreo',
      'red.cortes',
      // Despacha material a los técnicos.
      'inventario.ver',
      'inventario.movimientos',
      'inventario.transferir',
      // Manda al técnico a recuperar el equipo del que se fue: es despacho de
      // campo, igual que asignar una instalación.
      'retiros.gestionar',
      'auditoria.ver',
    ],
    puede: [
      'La bandeja de nuevas instalaciones: validar el expediente y asignar técnico',
      'Ver y asignar todos los tickets e instalaciones',
      'Ver el estado de la red y los cortes',
      'Transferir material a los técnicos',
    ],
    noPuede: [
      'Ver el tablero comercial ni las metas de los vendedores',
      'Registrar ni anular pagos',
      'Crear usuarios ni configurar el sistema',
    ],
  },
  {
    clave: 'tecnico',
    nombre: 'Técnico',
    color: 'azul',
    resumen: 'Solo lo suyo: los clientes de sus tickets e instalaciones, y nada más.',
    permisos: [
      'clientes.ver_contacto',
      'clientes.ver_direccion',
      'clientes.ver_ubicacion',
      'soporte.asignados',
      'soporte.estado',
      'soporte.cerrar',
      'instalaciones.asignadas',
      'instalaciones.completar',
      'instalaciones.materiales',
      'red.onus_ver',
      // Ver el estado de la red, sin poder tocarla. Parado en la vereda, saber
      // si el nodo de la zona está caído es la diferencia entre revisar el
      // domicilio durante una hora y avisar que la falla no es de ahí.
      'red.monitoreo_ver',
      'inventario.almacen_propio',
    ],
    puede: [
      'Sus tickets e instalaciones asignadas',
      'Nombre, celular, dirección y GPS del cliente de ese trabajo',
      'Datos de la ONT: serial, MAC, OLT, puerto PON y potencias',
      'Cerrar tickets, completar instalaciones y descargar material de su almacén',
      'Ver si los nodos de la red están arriba o caídos',
    ],
    noPuede: ['Ver la cartera completa de clientes', 'Ver facturación, pagos ni reportes financieros', 'Crear usuarios', 'Modificar configuraciones'],
  },
  {
    clave: 'bodega',
    nombre: 'Bodega / Almacén',
    color: 'ambar',
    resumen: 'Controla el material: lo que entra, lo que sale y lo que se lleva cada técnico.',
    // Sin `inventario.almacen_propio`: ese permiso abre "Mi almacén", que es la
    // pantalla del técnico. A quien atiende el depósito le mostraría una
    // sección que le dice que no está vinculado a ningún técnico — ruido puro.
    permisos: [
      ...todasDe('inventario').filter((c) => c !== 'inventario.almacen_propio'),
      'reportes.ver',
    ],
    puede: ['Ingresos y salidas de inventario', 'Compras y proveedores', 'Control de stock y transferencias a técnicos', 'Ver movimientos'],
    noPuede: ['Ver finanzas', 'Configurar el sistema', 'Gestionar usuarios'],
  },
]

export const buscarRol = (clave) => ROLES.find((r) => r.clave === clave)

/** Los permisos que propone un rol. Devuelve copia: la plantilla no se muta. */
export const permisosDeRol = (clave) => [...(buscarRol(clave)?.permisos ?? [])]

export const nombreRol = (clave) => buscarRol(clave)?.nombre ?? clave

/** El nombre legible de un permiso, para no mostrar `ventas.planes` en pantalla. */
export const nombrePermiso = (clave) => {
  for (const g of GRUPOS_PERMISOS) {
    const p = g.permisos.find((x) => x.clave === clave)
    if (p) return p.nombre
  }
  return clave
}

/**
 * En qué se aparta esta persona del molde de su rol.
 *
 * ── Por qué hace falta mirarlo ──
 *
 * Los permisos se copian del rol al crear al usuario y después viven en su
 * ficha. Eso está bien —hace falta poder ajustar a una persona— pero tiene una
 * consecuencia que no se ve: **cambiar el rol no cambia a quien ya existía**.
 *
 * Pasó de verdad. Se le sacó `ventas.planes` al Vendedor porque esa pantalla no
 * le servía, y la vendedora que ya estaba cargada la siguió viendo durante
 * semanas. El molde decía una cosa y la realidad otra, sin un solo aviso.
 *
 * `de_mas` son los permisos que el rol ya no incluye; `de_menos`, los que
 * propone y esta persona no tiene. Ninguno de los dos es un error por sí mismo
 * —ajustar a alguien es legítimo— pero tienen que estar a la vista para que sea
 * una decisión y no un descuido.
 */
export function diferenciaConElRol(usuario) {
  const p = Array.isArray(usuario?.permisos) ? usuario.permisos : []
  // Con el comodín no hay nada que comparar: puede todo por definición.
  if (p.includes(TODO)) return { de_mas: [], de_menos: [] }
  const molde = permisosDeRol(usuario?.rol)
  if (!molde.length) return { de_mas: [], de_menos: [] }
  return {
    de_mas: p.filter((c) => !molde.includes(c)),
    de_menos: molde.filter((c) => !p.includes(c)),
  }
}

/**
 * ¿Este usuario puede hacer esto?
 *
 * Un usuario inactivo no puede nada, sin importar su lista: desactivar tiene
 * que ser suficiente para cortarle el acceso, si no habría que además vaciarle
 * los permisos y nadie se acuerda de hacerlo.
 */
export function tienePermiso(usuario, clave) {
  if (!usuario || usuario.activo === false) return false
  const lista = usuario.permisos ?? []
  return lista.includes(TODO) || lista.includes(clave)
}

/**
 * Quién puede crear o modificar a quién.
 *
 * Esta es la regla de seguridad del módulo, y la única que no se resuelve por
 * checkbox. Se exporta como función para que la pantalla oculte lo que el
 * servidor va a rechazar igual — y que el servidor rechace es lo que importa.
 */
export function puedeGestionarRol(rolDeQuienGestiona, rolObjetivo) {
  // El Super Administrador NO se crea ni se asigna desde el sistema. Nadie:
  // tampoco otro Super Administrador.
  //
  // Es el dueño de la instalación, no un rol que se reparte. La primera versión
  // dejaba que un Super Administrador creara otro, y eso abría un camino corto
  // y silencioso: alguien que encuentra la sesión abierta se crea un segundo
  // Super Administrador, entra con él y elimina al primero. La verificación del
  // "último Super Administrador activo" no lo frena, porque para entonces ya
  // son dos. El dueño queda afuera de su propio sistema y solo se recupera
  // entrando a la base a mano.
  //
  // El costo de cerrarlo es que sumar un segundo dueño —dos socios, una
  // sucesión— deja de hacerse por pantalla y pasa a ser un SQL deliberado, que
  // está documentado al pie de la migración 66. Es exactamente el tipo de
  // decisión que conviene que cueste.
  if (rolObjetivo === 'super_admin') return false

  if (rolDeQuienGestiona === 'super_admin') return true
  // Un Administrador arma al resto del personal, pero no a sus pares ni a quien
  // está por encima. Si pudiera, el escalón dejaría de existir.
  if (rolDeQuienGestiona === 'admin') return rolObjetivo !== 'admin'
  return false
}

/**
 * ¿Puede tocar este legajo?
 *
 * Separado de `puedeGestionarRol` por el caso propio: cada uno corrige su
 * nombre, su celular y su contraseña sin depender de nadie, y el Super
 * Administrador —a quien ya nadie puede gestionar— tiene que seguir pudiendo
 * hacerlo con el suyo.
 *
 * Ojo: "editar mi legajo" es mis datos, NO mis poderes. El rol y los permisos
 * de uno mismo se ignoran del lado del servidor; si no, cualquier Administrador
 * se marcaría los checkboxes que le falten y el escalón sería decorativo.
 */
export function puedeEditarA(actor, objetivo) {
  if (!actor || !objetivo) return false
  if (actor.id && actor.id === objetivo.id) return true
  return puedeGestionarRol(actor.rol, objetivo.rol)
}

/** Los roles que este usuario puede asignar, para llenar el selector. */
export const rolesAsignablesPor = (rol) => ROLES.filter((r) => puedeGestionarRol(rol, r.clave))
