/**
 * Siembra datos de prueba coherentes en el ambiente de PRUEBA.
 *
 *   node --env-file=middleware/.env.prueba supabase/sembrar-datos-de-prueba.mjs
 *   node --env-file=middleware/.env.prueba supabase/sembrar-datos-de-prueba.mjs --limpiar
 *
 * ── Por qué datos armados y no unos cuantos abonados al azar ──
 *
 * Porque lo que hay que probar no es que la pantalla dibuje una lista: es la
 * cobranza. Y la cobranza se rompe en los casos de borde —el que pagó la mitad,
 * el que debe dos meses, el que está cortado— que nunca aparecen si uno carga
 * tres abonados a mano y les pone todo bien.
 *
 * Cada abonado de acá representa un caso que se comporta distinto:
 *
 *   UNO     al día                    no le pasa nada
 *   DOS     una factura vencida       entra en cobranza
 *   TRES    dos vencidas, CORTADO     el caso del corte y la reconexión
 *   CUATRO  factura del mes al día    no tiene que entrar en cobranza
 *   CINCO   pagó la mitad             `monto` distinto de `total_factura`
 *   SEIS    de baja                   no tiene que aparecer en ningún lado
 *
 * El quinto es el que más vale: si el bot le lee al abonado el total de la
 * factura en vez de lo que falta, le cobra dos veces lo que ya entregó. Sin un
 * caso así en la base, ese error no se ve hasta que un cliente reclama.
 *
 * ── Los nombres y las cédulas son feos a propósito ──
 *
 * "PRUEBA UNO" y `99900001` se reconocen de un vistazo. Si algún día uno de
 * estos aparece en una pantalla de producción, se tiene que notar en el acto —
 * un "Juan Pérez" de prueba pasa desapercibido para siempre.
 */

import { readFileSync } from 'node:fs'
import { encrypt } from '../middleware/src/lib/crypto.js'

const URL_BASE = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
const LLAVE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL_BASE || !LLAVE) {
  console.error(`
Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.

  node --env-file=middleware/.env.prueba supabase/sembrar-datos-de-prueba.mjs
`)
  process.exit(1)
}

/**
 * El freno.
 *
 * Este script escribe abonados y facturas. Contra la base que factura, eso no
 * es "datos de prueba": es basura en el cierre de caja y en el reporte de
 * ARCOTEL, mezclada con lo real y sin forma fácil de distinguirla después.
 */
try {
  const env = readFileSync('middleware/.env', 'utf8')
  const m = env.match(/SUPABASE_URL\s*=\s*https:\/\/([a-z0-9]+)\.supabase\.co/i)
  if (m && URL_BASE.includes(m[1])) {
    console.error(`
  ALTO. Estás apuntando a "${m[1]}", que es el proyecto de PRODUCCIÓN.

  Este script crea abonados y facturas. Usá middleware/.env.prueba.
`)
    process.exit(1)
  }
} catch {
  console.warn('  (no pude leer middleware/.env para verificar que no sea producción)\n')
}

const cabeceras = {
  apikey: LLAVE,
  Authorization: `Bearer ${LLAVE}`,
  'Content-Type': 'application/json',
}

async function api(ruta, opciones = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    ...opciones,
    headers: { ...cabeceras, ...(opciones.headers ?? {}) },
  })
  const texto = await r.text()
  if (!r.ok) throw new Error(`${ruta} → ${r.status} ${texto.slice(0, 220)}`)
  return texto ? JSON.parse(texto) : null
}

const insertar = (tabla, filas) =>
  api(tabla, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(filas),
  })

const borrar = (tabla, filtro) => api(`${tabla}?${filtro}`, { method: 'DELETE' })

/** Fechas relativas a hoy, para que los vencimientos siempre tengan sentido. */
const dia = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// Todo lo sembrado lleva esta marca: es lo que permite borrarlo después sin
// tocar nada que alguien haya cargado a mano.
const MARCA = 'sembrado-prueba'

// =============================================================================
// Limpiar
// =============================================================================

async function limpiar() {
  console.log('Borrando lo sembrado antes...\n')

  const clientes = await api(`clientes?select=id&notas=eq.${MARCA}`)
  const ids = clientes.map((c) => c.id)

  if (ids.length) {
    const lista = `(${ids.join(',')})`
    // El orden importa: los pagos cuelgan de las facturas y las facturas del
    // abonado. Al revés, las claves foráneas frenan el borrado.
    await borrar('instalaciones', `client_id=in.${lista}`)
    await borrar('pagos', `client_id=in.${lista}`)
    await borrar('facturas', `client_id=in.${lista}`)
    await borrar('clientes', `id=in.${lista}`)
    console.log(`  ${ids.length} abonados de prueba borrados, con sus facturas y pagos`)
  } else {
    console.log('  no había abonados sembrados')
  }

  await borrar('ip_addresses', `descripcion=eq.${MARCA}`)
  await borrar('subredes', `notas=eq.${MARCA}`)
  await borrar('puntos_red', `notas=eq.${MARCA}`)
  await borrar('routers_mikrotik', `nombre=like.PRUEBA*`)
  await borrar('planes_velocidad', `descripcion=eq.${MARCA}`)
  await borrar('cuentas_pago', `titular=eq.${MARCA}`)
  console.log('  planes y cuentas de prueba borrados\n')
}

// =============================================================================
// El usuario para entrar
// =============================================================================

/**
 * Sin esto la base queda perfecta y no se puede entrar.
 *
 * -- Por que `permisos: ['*']` y no basta con el rol --
 *
 * El rol no otorga permisos por si solo: `tienePermiso` mira la lista, y un
 * Super Administrador con la lista vacia no puede hacer NADA. El sintoma es
 * desconcertante -entras bien y despues todo contesta 403- asi que se siembra
 * con el comodin.
 *
 * -- Por que no lo borra `--limpiar` --
 *
 * Porque es la llave de la casa, no un dato de prueba. Borrarlo dejaria el
 * ambiente inaccesible justo despues de limpiarlo, que es cuando mas se usa.
 */
const USUARIO = { email: 'prueba@smartolt.local', clave: 'Prueba2026!', usuario: 'prueba' }

async function asegurarUsuario() {
  const [ya] = await api(`usuarios_sistema?select=id,permisos&usuario=eq.${USUARIO.usuario}`)

  if (ya) {
    if (!(ya.permisos ?? []).includes('*')) {
      await api(`usuarios_sistema?id=eq.${ya.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ permisos: ['*'] }),
      })
      console.log('  usuario existente: se le repusieron los permisos')
    } else {
      console.log('  usuario ya estaba, con permisos completos')
    }
    return
  }

  const r = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: cabeceras,
    body: JSON.stringify({
      email: USUARIO.email,
      password: USUARIO.clave,
      email_confirm: true,
      user_metadata: { full_name: 'PRUEBA Administrador' },
    }),
  })
  const creado = await r.json()
  if (!r.ok) throw new Error(`auth -> ${r.status} ${JSON.stringify(creado).slice(0, 180)}`)

  await insertar('usuarios_sistema', [
    {
      auth_id: creado.id,
      nombre: 'PRUEBA',
      apellido: 'Administrador',
      usuario: USUARIO.usuario,
      email: USUARIO.email,
      rol: 'super_admin',
      activo: true,
      todas_las_zonas: true,
      dos_factores: false,
      permisos: ['*'],
    },
  ])
  console.log(`  usuario creado: ${USUARIO.usuario} / ${USUARIO.clave}`)
}

// =============================================================================
// Sembrar
// =============================================================================

async function sembrar() {
  console.log(`Sembrando en ${URL_BASE}\n`)

  await asegurarUsuario()

  // ── Planes ────────────────────────────────────────────────────────────────
  const planes = await insertar('planes_velocidad', [
    { nombre: 'PRUEBA BÁSICO 50', bajada_kbps: 51200, subida_kbps: 51200, precio: 17.39, categoria: 'residencial', activo: true, descripcion: MARCA },
    { nombre: 'PRUEBA HOME 150', bajada_kbps: 153600, subida_kbps: 153600, precio: 20.09, categoria: 'residencial', activo: true, descripcion: MARCA },
    { nombre: 'PRUEBA PRO 300', bajada_kbps: 307200, subida_kbps: 307200, precio: 30.36, categoria: 'corporativo', activo: true, descripcion: MARCA },
  ])
  console.log(`  ${planes.length} planes`)

  // ── Cuentas de cobro ──────────────────────────────────────────────────────
  //
  // El número de la cuenta bancaria importa: es contra lo que el sistema
  // resuelve el `cuenta_destino` que manda el bot con el comprobante. Sin una
  // cuenta cargada, todo pago informado se rechaza con CUENTA_DESCONOCIDA.
  //
  // Las dos filas llevan las MISMAS claves aunque una no use `banco` ni
  // `numero`: PostgREST rechaza un lote donde los objetos difieren, con un
  // "All object keys must match" que no dice cuál es el que sobra.
  const cuentas = await insertar('cuentas_pago', [
    { nombre: 'PRUEBA Caja efectivo', tipo: 'efectivo', banco: null, numero: null, activa: true, titular: MARCA },
    { nombre: 'PRUEBA Pichincha Corriente', tipo: 'banco', banco: 'Banco Pichincha', numero: '2100999999', activa: true, titular: MARCA },
  ])
  console.log(`  ${cuentas.length} cuentas de cobro`)

  // ── Routers ───────────────────────────────────────────────────────────────
  //
  // Sin ninguno cargado, el desplegable de router sale vacío en el alta y en la
  // ficha de servicio: no se puede terminar de configurar a un abonado.
  //
  // ── Son de mentira, y tienen que notarse ──
  //
  // La IP es de un rango de documentación (192.0.2.0/24, reservado por la RFC
  // 5737 justo para esto) así que no existe en ninguna red real y nada la va a
  // alcanzar por accidente. La contraseña se cifra igual que las de verdad
  // —el sistema no sabe leerla de otra forma— pero no abre nada.
  //
  // Sirven para llenar desplegables y probar pantallas. Cualquier operación
  // contra el equipo va a fallar con un timeout, y está bien que así sea.
  const routers = await insertar('routers_mikrotik', [
    {
      nombre: 'PRUEBA Nodo Centro',
      ip_host: '192.0.2.10',
      puerto_api: 8728,
      modo_api: 'binaria',
      usuario: 'prueba',
      password_encrypted: encrypt('no-conecta-a-ningun-lado'),
      activo: true,
      lista_morosos: 'CORTE_MOROSOS',
    },
    {
      nombre: 'PRUEBA Nodo Norte',
      ip_host: '192.0.2.11',
      puerto_api: 8728,
      modo_api: 'binaria',
      usuario: 'prueba',
      password_encrypted: encrypt('no-conecta-a-ningun-lado'),
      activo: true,
      lista_morosos: 'CORTE_MOROSOS',
    },
  ])
  console.log(`  ${routers.length} routers (de mentira, para llenar desplegables)`)

  // ── Redes IPv4 ────────────────────────────────────────────────────────────
  //
  // Sin redes cargadas, el desplegable del alta sale vacío y el botón de
  // sugerir IP no tiene de dónde sacar nada: media pantalla no se puede probar.
  //
  // Se siembran las dos formas, porque el sistema las filtra según el tipo de
  // conexión del abonado: una estática para los IPoE y un pool para los PPPoE.
  // Con una sola no se ve que el filtro funciona.
  /**
   * Las torres, y una red por torre.
   *
   * ── Por qué varias y no una ──
   *
   * Con una sola red no se ve el problema real: un ISP con diez torres tiene
   * diez sectores, y el técnico parado en una escalera no elige "10.90.3.0/24",
   * elige "Torre La Maná". El desplegable existe para eso, y con un solo
   * elemento no se puede probar que ordene ni que muestre el sector.
   */
  /**
   * Diez torres con su red, como las tiene un WISP de verdad.
   *
   * -- Por que diez y no dos --
   *
   * Con dos, el desplegable de sector se ve bien y no prueba nada. El problema
   * aparece a partir de la sexta o septima: hay que poder encontrar la torre
   * entre muchas, ver cual esta por llenarse, y distinguir las de un router de
   * las del otro. Un ISP con diez torres es el caso que motivo la pantalla.
   *
   * -- Como se reparten --
   *
   * Ocho entregan por IP directa, que es lo habitual en radioenlace, y dos por
   * PPPoE: hay ISP que autentican tambien en radio, y el desplegable tiene que
   * filtrar bien en los dos casos.
   *
   * Los gateways alternan entre .1 y .254 a proposito: son las dos costumbres,
   * y el sugeridor de IP tiene que saltear el gateway sea cual sea.
   */
  const SECTORES = [
    { torre: 'Torre La Mana Centro', bloque: '10.80.1.0/24', gw: '10.80.1.1', vlan: 101, tipo: 'estatica', router: 0 },
    { torre: 'Torre El Carmen', bloque: '10.80.2.0/24', gw: '10.80.2.254', vlan: 102, tipo: 'estatica', router: 0 },
    { torre: 'Torre Guasaganda', bloque: '10.80.3.0/24', gw: '10.80.3.1', vlan: 103, tipo: 'estatica', router: 0 },
    { torre: 'Torre Pucayacu', bloque: '10.80.4.0/24', gw: '10.80.4.254', vlan: 104, tipo: 'estatica', router: 0 },
    { torre: 'Torre Estero Hondo', bloque: '10.80.5.0/24', gw: '10.80.5.1', vlan: 105, tipo: 'estatica', router: 0 },
    { torre: 'Torre El Triunfo', bloque: '10.80.6.0/24', gw: '10.80.6.254', vlan: 106, tipo: 'estatica', router: 1 },
    { torre: 'Torre San Pablo', bloque: '10.80.7.0/24', gw: '10.80.7.1', vlan: 107, tipo: 'estatica', router: 1 },
    { torre: 'Torre Zapotal', bloque: '10.80.8.0/24', gw: '10.80.8.254', vlan: 108, tipo: 'estatica', router: 1 },
    { torre: 'Torre Manguila', bloque: '10.80.9.0/24', gw: '10.80.9.254', vlan: 109, tipo: 'pool_pppoe', router: 1 },
    { torre: 'Torre Chipe', bloque: '10.80.10.0/24', gw: '10.80.10.254', vlan: 110, tipo: 'pool_pppoe', router: 1 },
  ]

  const torres = await insertar(
    'puntos_red',
    SECTORES.map((x) => ({ nombre: x.torre, tipo: 'torre', capacidad: null, notas: MARCA })),
  )
  console.log(`  ${torres.length} torres`)

  const porTorre = Object.fromEntries(torres.map((t) => [t.nombre, t.id]))

  const redes = await insertar('subredes', [
    // Las dos de fibra: sin torre, porque en fibra el segmento sale de la OLT y
    // el puerto PON. Ponerles una torre confundiria al tecnico de fibra, que
    // hoy no elige nada porque el sistema ya se lo resuelve.
    {
      nombre: 'PRUEBA FTTH ESTATICA',
      cidr: '10.90.1.0/24',
      tipo: 'estatica',
      router_id: routers[0].id,
      punto_id: null,
      // Gateway en .1 a proposito: es el caso donde el sugeridor tiene que
      // saltear la primera direccion.
      gateway: '10.90.1.1',
      vlan: 100,
      notas: MARCA,
    },
    {
      nombre: 'PRUEBA FTTH POOL PPPOE',
      cidr: '10.90.2.0/24',
      tipo: 'pool_pppoe',
      router_id: routers[0].id,
      punto_id: null,
      gateway: '10.90.2.254',
      vlan: 200,
      notas: MARCA,
    },
    // Y una por torre.
    ...SECTORES.map((x) => ({
      nombre: x.torre.replace('Torre ', 'Sector '),
      cidr: x.bloque,
      tipo: x.tipo,
      router_id: routers[x.router].id,
      punto_id: porTorre[x.torre],
      gateway: x.gw,
      vlan: x.vlan,
      notas: MARCA,
    })),
  ])
  console.log(`  ${redes.length} redes IPv4`)

  const redEstatica = redes.find((r) => r.tipo === 'estatica')

  const basico = planes.find((p) => p.nombre.includes('BÁSICO'))
  const home = planes.find((p) => p.nombre.includes('HOME'))
  const banco = cuentas.find((c) => c.tipo === 'banco')

  // ── Abonados ──────────────────────────────────────────────────────────────
  const comun = {
    tipo_identificacion: '05',
    estado: 'activo',
    origen: 'manual',
    dia_facturacion: 5,
    modalidad_pago: 'postpago',
    notas: MARCA,
    ciudad: 'La Maná',
    provincia: 'Cotopaxi',
  }

  /**
   * Las tres formas de entregar la conexión, repartidas.
   *
   * ── Por qué no todos iguales ──
   *
   * Con los seis en PPPoE, media pantalla no se puede probar: los campos de red
   * e IP nunca aparecen, el botón de sugerir dirección no se ve, y una orden de
   * instalación siempre muestra lo mismo. Los errores que viven en el cruce
   * —una red de pool elegida para un abonado IPoE, un usuario PPPoE en una
   * ficha de IP directa— no se pueden reproducir.
   *
   * Cada combinación existe por algo:
   *
   *   pppoe + dinamica   lo más común en fibra: el pool reparte
   *   pppoe + fija       la IP va grabada en el secret del abonado
   *   ip + fija          IPoE con reserva DHCP por MAC, típico de radioenlace
   *   ip + dinamica      IPoE con DHCP suelto
   */
  const conexion = (tipo, ip) => ({ tipo_conexion: tipo, tipo_ip: ip })

  /**
   * Coordenadas repartidas alrededor de La Mana.
   *
   * No es adorno: el mapa de clientes solo dibuja a los que las tienen, y sin
   * ninguno cargado no hay forma de ver si la pantalla funciona. Estan
   * separadas unas cuadras entre si para que el encuadre automatico tenga algo
   * que encuadrar en vez de un solo punto.
   */
  const punto = (i) => ({
    latitud: Number((-0.9417 + i * 0.004).toFixed(6)),
    longitud: Number((-79.22 + i * 0.005).toFixed(6)),
  })

  /**
   * Los seis llevan EXACTAMENTE las mismas claves, aunque a la mitad le
   * correspondan en null.
   *
   * PostgREST rechaza un lote donde los objetos difieren, con un
   * "All object keys must match" que no dice cuál es el que sobra. Es la
   * segunda vez que este archivo tropieza con eso.
   */
  const abonados = await insertar('clientes', [
    { ...comun, nombre: 'PRUEBA UNO al dia', identificacion: '99900001', red_ipv4: '10.80.1.0/24', ip: '10.80.1.2', ...conexion('ip', 'fija'), usuario_ppp: null, clave_ppp: null, ...punto(1), telefono: '0990000001', direccion: 'Calle Falsa 1', plan_id: home.id, precio_mensual: 20.09 },
    { ...comun, nombre: 'PRUEBA DOS una vencida', identificacion: '99900002', red_ipv4: null, ip: null, ...conexion('pppoe', 'dinamica'), usuario_ppp: 'prueba.dos', clave_ppp: 'K7QDMXR4', ...punto(2), telefono: '0990000002', direccion: 'Calle Falsa 2', plan_id: home.id, precio_mensual: 20.09 },
    { ...comun, nombre: 'PRUEBA TRES cortado', identificacion: '99900003', red_ipv4: null, ip: null, ...conexion('pppoe', 'dinamica'), usuario_ppp: 'prueba.tres', clave_ppp: 'M4PQRT82', ...punto(3), telefono: '0990000003', direccion: 'Calle Falsa 3', plan_id: basico.id, precio_mensual: 17.39, estado: 'cortado' },
    { ...comun, nombre: 'PRUEBA CUATRO del mes', identificacion: '99900004', red_ipv4: '10.80.2.0/24', ip: '10.80.2.5', ...conexion('ip', 'dinamica'), usuario_ppp: null, clave_ppp: null, ...punto(4), telefono: '0990000004', direccion: 'Calle Falsa 4', plan_id: home.id, precio_mensual: 20.09 },
    { ...comun, nombre: 'PRUEBA CINCO pago parcial', identificacion: '99900005', red_ipv4: null, ip: null, ...conexion('pppoe', 'fija'), usuario_ppp: 'prueba.cinco', clave_ppp: 'X9JKDW53', ...punto(5), telefono: '0990000005', direccion: 'Calle Falsa 5', plan_id: home.id, precio_mensual: 20.09 },
    { ...comun, nombre: 'PRUEBA SEIS de baja', identificacion: '99900006', red_ipv4: '10.80.3.0/24', ip: '10.80.3.7', ...conexion('ip', 'fija'), usuario_ppp: null, clave_ppp: null, ...punto(6), telefono: '0990000006', direccion: 'Calle Falsa 6', plan_id: basico.id, precio_mensual: 17.39, estado: 'baja' },
  ])
  console.log(`  ${abonados.length} abonados`)

  /**
   * Un sector con varias direcciones tomadas.
   *
   * Con todos los sectores en 254 libres, el numero no dice nada y no se puede
   * ver si el desplegable ayuda a elegir. Con uno casi lleno, si: es la
   * situacion en la que el tecnico tiene que darse cuenta ANTES de pedir la
   * direccion, no despues.
   */
  const ocupadas = await insertar(
    'ip_addresses',
    Array.from({ length: 240 }, (_, n) => ({
      subred_id: redes.find((r) => r.cidr === '10.80.4.0/24').id,
      ip_address: `10.80.4.${n + 10}`,
      estado: 'asignada',
      origen: 'manual',
      descripcion: MARCA,
    })),
  )
  console.log(`  ${ocupadas.length} direcciones tomadas en Sector Pucayacu (para verlo casi lleno)`)

  const de = (n) => abonados.find((c) => c.nombre.includes(n))

  /** Una factura de servicio, con el IVA de Ecuador ya separado. */
  const factura = (cliente, { vence, subtotal = 17.47, mes }) => {
    const impuesto = Number((subtotal * 0.15).toFixed(2))
    return {
      client_id: cliente.id,
      cliente_nombre: cliente.nombre,
      tipo: 'servicios',
      concepto: `Servicio de internet — ${mes}`,
      fecha_emision: vence,
      fecha_vencimiento: vence,
      subtotal,
      impuesto,
      total: Number((subtotal + impuesto).toFixed(2)),
      origen: 'sistema',
    }
  }

  const facturas = await insertar('facturas', [
    // DOS: una vencida hace 20 días
    factura(de('DOS'), { vence: dia(-20), mes: 'mes pasado' }),
    // TRES: dos vencidas — es el que justifica el corte
    factura(de('TRES'), { vence: dia(-50), subtotal: 15.12, mes: 'hace dos meses' }),
    factura(de('TRES'), { vence: dia(-20), subtotal: 15.12, mes: 'mes pasado' }),
    // CUATRO: la del mes, todavía no vence
    factura(de('CUATRO'), { vence: dia(+8), mes: 'este mes' }),
    // CINCO: vencida, y abajo se le aplica un pago parcial
    factura(de('CINCO'), { vence: dia(-12), mes: 'mes pasado' }),
  ])
  console.log(`  ${facturas.length} facturas`)

  // ── Órdenes de instalación ────────────────────────────────────────────────
  //
  // Una de cada tecnología, para poder abrir el asistente del técnico sin tener
  // que agendarla a mano cada vez que se vuelve a sembrar. Son el camino más
  // largo del sistema y el que más se rompe al tocar otra cosa.
  const ordenes = await insertar('instalaciones', [
    {
      client_id: de('UNO').id,
      tipo: 'nueva',
      estado: 'agendada',
      fecha: dia(0),
      tecnologia: 'wireless',
      tipo_conexion: 'ip',
      tipo_ip: 'fija',
      router_id: routers[0].id,
      plan_id: home.id,
      direccion: de('UNO').direccion,
      notas: MARCA,
    },
    {
      client_id: de('DOS').id,
      tipo: 'nueva',
      estado: 'agendada',
      fecha: dia(0),
      tecnologia: 'ftth',
      tipo_conexion: 'pppoe',
      tipo_ip: 'dinamica',
      router_id: routers[0].id,
      plan_id: home.id,
      direccion: de('DOS').direccion,
      notas: MARCA,
    },
  ])
  console.log(`  ${ordenes.length} órdenes de instalación (una de radio, una de fibra)`)

  // ── El pago parcial ───────────────────────────────────────────────────────
  //
  // Es el caso que más se rompe: la factura de CINCO es de 20.09 y entregó
  // 10.00, así que debe 10.09. Un sistema que le lea el total le va a cobrar
  // 20.09 otra vez.
  const suya = facturas.find((f) => f.client_id === de('CINCO').id)
  await insertar('pagos', [
    {
      client_id: de('CINCO').id,
      factura_id: suya.id,
      cuenta_id: banco.id,
      monto: 10.0,
      forma_pago: 'transferencia',
      fecha_pago: dia(-3),
      n_transaccion: 'PRUEBA-PARCIAL-001',
    },
  ])
  console.log('  1 pago parcial (CINCO entregó 10.00 de 20.09)')

  // ── Resumen ───────────────────────────────────────────────────────────────
  const saldos = await api('v_saldo_clientes?select=nombre,identificacion,estado,saldo,facturas_pendientes&order=identificacion')
  const mios = saldos.filter((s) => String(s.identificacion ?? '').startsWith('999000'))

  console.log('\n  Así quedó:\n')
  console.log('    identificación  abonado                       estado     debe   facturas')
  console.log('    ' + '─'.repeat(74))
  for (const s of mios) {
    console.log(
      `    ${String(s.identificacion).padEnd(15)} ${String(s.nombre).padEnd(29)} ` +
        `${String(s.estado).padEnd(10)} ${String(s.saldo ?? 0).padStart(6)}   ${s.facturas_pendientes ?? 0}`,
    )
  }

  /**
   * Los links, armados aparte.
   *
   * Meter un `.join('\n')` adentro del template de abajo obliga a escapar el
   * salto de linea dentro de otro template, y eso es exactamente donde este
   * archivo se rompio dos veces. Se arma antes, en una variable.
   */
  const lineasDeOrdenes = ordenes
    .map((o) => `    ${o.tecnologia === 'wireless' ? 'radio' : 'fibra'}  N${'°'}${o.numero}  /instalaciones/${o.id}/alta`)
    // El salto se pide por su codigo para no tener que escaparlo adentro de
    // un template anidado: ahi es donde este archivo se rompio tres veces.
    .join(String.fromCharCode(10))

  console.log(`
  Para probar la API:
    GET /api/v1/cliente/consultar-deuda?cedula=99900002   → una vencida
    GET /api/v1/cliente/consultar-deuda?cedula=99900005   → debe 10.09, no 20.09
    GET /api/v1/cliente/consultar-deuda?cedula=99900003   → cortado, dos vencidas

  Asistente del técnico:
${lineasDeOrdenes}

  Para entrar:  usuario ${USUARIO.usuario}  ·  clave ${USUARIO.clave}

  Para borrarlo todo:
    node --env-file=middleware/.env.prueba supabase/sembrar-datos-de-prueba.mjs --limpiar
`)
}

// =============================================================================

const limpiarSolo = process.argv.includes('--limpiar')

try {
  await limpiar()
  if (!limpiarSolo) await sembrar()
} catch (err) {
  console.error(`\n  Falló: ${err.message}\n`)
  process.exit(1)
}
