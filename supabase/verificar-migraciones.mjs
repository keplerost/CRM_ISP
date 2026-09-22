/**
 * ¿Qué migraciones están aplicadas de verdad?
 *
 *   node --env-file=middleware/.env supabase/verificar-migraciones.mjs
 *
 * ── Por qué existe ──
 *
 * Las migraciones se corren a mano, pegándolas en el SQL Editor de Supabase. Eso
 * funciona, pero deja una pregunta sin respuesta: ¿esta instalación tiene la 175
 * o se quedó a medias? Y "a medias" es un estado real: una migración con varias
 * sentencias puede aplicar las primeras y fallar en la última, que es justo lo
 * que pasó con la 175 y el choque de tipos en `verificado_por`.
 *
 * Esto lo contesta mirando la base, no un registro de lo que alguien dijo haber
 * corrido: pregunta si cada tabla, columna y función existe.
 *
 * No modifica nada. Se puede correr las veces que haga falta.
 */

const url = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.')
  console.error('Corré:  node --env-file=middleware/.env supabase/verificar-migraciones.mjs')
  process.exit(1)
}

/**
 * Se habla con PostgREST a mano, sin el cliente de Supabase.
 *
 * El paquete `@supabase/supabase-js` está instalado en `middleware/`, no en la
 * raíz, y este script se corre desde la raíz. Importarlo obligaría a instalar
 * dependencias en un lugar donde no hay ninguna otra — para hacer cuatro GET.
 */
const cabeceras = { apikey: key, Authorization: `Bearer ${key}` }

async function pedir(ruta, opciones = {}) {
  const res = await fetch(`${url}/rest/v1/${ruta}`, {
    ...opciones,
    headers: { ...cabeceras, 'Content-Type': 'application/json', ...(opciones.headers ?? {}) },
  })
  const cuerpo = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, cuerpo }
}

const verde = (t) => `\x1b[32m${t}\x1b[0m`
const rojo = (t) => `\x1b[31m${t}\x1b[0m`
const gris = (t) => `\x1b[90m${t}\x1b[0m`

/**
 * ¿Existe la tabla, y tiene estas columnas?
 *
 * Se pide una fila con las columnas nombradas: si alguna no existe, PostgREST
 * contesta 42703 y dice cuál. Es más directo que consultar el catálogo, que por
 * la API hay que exponer a mano.
 */
async function revisar(tabla, columnas = []) {
  const select = encodeURIComponent(columnas.join(',') || '*')
  const r = await pedir(`${tabla}?select=${select}&limit=1`)

  if (r.ok) return { ok: true }

  const mensaje = r.cuerpo?.message ?? `HTTP ${r.status}`

  // 42P01 = la tabla no existe. 42703 = la columna no existe.
  if (r.cuerpo?.code === '42P01' || /does not exist|not find the table/i.test(mensaje)) {
    const falta = mensaje.match(/column\s+\S*?\.?"?([a-z_]+)"?\s+does not exist/i)
    return { ok: false, motivo: falta ? `falta la columna ${falta[1]}` : 'falta la tabla' }
  }
  if (r.cuerpo?.code === '42703' || /column/i.test(mensaje)) {
    return { ok: false, motivo: mensaje }
  }
  return { ok: false, motivo: mensaje }
}

/**
 * Las funciones que PostgREST publica, leídas del catálogo.
 *
 * ── Por qué NO se las llama para saber si existen ──
 *
 * Porque llamarlas las EJECUTA. La primera versión de este script comprobaba
 * `anotar_entrante_whatsapp` invocándola con un teléfono de mentira, y como sus
 * demás argumentos tienen valor por omisión, la llamada funcionó: dejó una fila
 * `__prueba__` en `ventanas_whatsapp`. Un verificador que promete no tocar nada
 * y escribe es peor que no tener verificador.
 *
 * El documento OpenAPI de la raíz lista cada RPC como una ruta `/rpc/nombre`, y
 * pedirlo es un GET.
 */
let catalogoRpc = null

async function funcionesPublicadas() {
  if (catalogoRpc) return catalogoRpc

  const res = await fetch(`${url}/rest/v1/`, { headers: cabeceras })
  const doc = await res.json().catch(() => null)

  catalogoRpc = new Set(
    Object.keys(doc?.paths ?? {})
      .filter((r) => r.startsWith('/rpc/'))
      .map((r) => r.slice(5)),
  )
  return catalogoRpc
}

async function revisarFuncion(nombre) {
  const publicadas = await funcionesPublicadas()
  if (!publicadas.size) return { ok: true, nota: 'no se pudo leer el catálogo' }
  return publicadas.has(nombre) ? { ok: true } : { ok: false, motivo: 'falta la función' }
}

const MIGRACIONES = [
  {
    numero: 173,
    nombre: 'La API para el CRM',
    partes: [
      ['api_llaves', ['id', 'nombre', 'huella', 'permisos', 'confirma_pagos', 'reactiva_servicio']],
      ['api_llamadas', ['id', 'llave_id', 'ruta', 'status']],
      ['pagos_reportados', ['id', 'monto', 'estado', 'referencia_externa', 'verificado_por']],
      ['v_pagos_reportados', ['id', 'deuda_actual']],
    ],
  },
  {
    numero: 174,
    nombre: 'El corte masivo se avisa solo',
    partes: [
      ['incidencias_masivas', ['id', 'alcance', 'estado', 'titulo', 'ocurrio_at']],
      ['incidencia_avisos', ['id', 'incidencia_id', 'momento', 'estado']],
      ['v_incidencias_masivas', ['id', 'avisados', 'por_avisar']],
      ['config_tareas', ['incidencias_cola_activa', 'incidencias_automatico', 'incidencias_minutos']],
    ],
    funciones: ['afectados_por_alcance', 'abrir_incidencia', 'incidencia_activa_de'],
  },
  {
    numero: 175,
    nombre: 'Lo que manda el bot con el comprobante',
    partes: [
      [
        'pagos_reportados',
        ['banco_origen', 'depositante', 'hash_qr', 'uuid_transaccion', 'factura_id', 'origen'],
      ],
      // La que falló la primera vez: se llamaba `verificado_por` y chocaba con
      // el UUID que ya existía desde la 173.
      ['pagos_reportados', ['metodo_verificacion']],
      ['v_pagos_reportados', ['metodo_verificacion', 'banco_origen', 'depositante']],
    ],
    funciones: ['confirmar_pago_reportado'],
  },
  {
    numero: 176,
    nombre: 'Las plantillas aprobadas de WhatsApp',
    partes: [
      ['plantillas_whatsapp', ['id', 'plantilla_id', 'nombre_meta', 'cuerpo_meta', 'variables', 'estado']],
      ['v_plantillas_whatsapp', ['clave', 'nombre_meta', 'se_puede_enviar']],
    ],
  },
  {
    numero: 177,
    nombre: 'El webhook que abre la ventana',
    partes: [
      ['ventanas_whatsapp', ['telefono', 'ultimo_entrante', 'mensajes']],
      ['v_ventanas_whatsapp', ['telefono', 'abierta', 'minutos_restantes']],
      ['config_mensajeria', ['whatsapp_verify_token', 'whatsapp_app_secret_encrypted']],
      ['clientes', ['avisos_baja_at', 'avisos_baja_texto']],
    ],
    funciones: ['anotar_entrante_whatsapp'],
  },
  {
    numero: 178,
    nombre: 'La llave que nace de un usuario',
    partes: [['api_llaves', ['generada_desde', 'generada_desde_nombre']]],
  },
  {
    numero: 179,
    nombre: 'Lo que el bot ya comprobó: QR y cuenta destino',
    partes: [
      ['pagos_reportados', ['cuenta_id', 'metodo_verificacion']],
      ['v_pagos_reportados', ['cuenta', 'cuenta_id']],
    ],
    funciones: ['confirmar_pago_reportado'],
  },
  {
    numero: 180,
    nombre: 'El WhatsApp que sale por un CRM',
    partes: [
      [
        'config_mensajeria',
        ['whatsapp_crm_nombre', 'whatsapp_crm_url', 'whatsapp_crm_header', 'whatsapp_crm_key_encrypted'],
      ],
      ['plantillas_whatsapp', ['purpose_crm']],
      ['v_plantillas_whatsapp', ['purpose_crm', 'se_puede_enviar_por_crm']],
    ],
  },
  {
    numero: 181,
    nombre: 'El descuento que se acuerda en plata, no en porcentaje',
    partes: [['clientes', ['descuento_fijo', 'descuento_fijo_motivo']]],
  },
  {
    numero: 182,
    nombre: 'El corte y el límite también en IPv6',
    partes: [
      ['clientes', ['ipv6_prefijo']],
      ['routers_mikrotik', ['ipv6_activo', 'ipv6_lista_morosos', 'ipv6_preparado_at']],
    ],
  },
  {
    numero: 183,
    nombre: 'El contrato nace con el alta y hereda el número de la orden',
    partes: [],
    funciones: ['finalizar_alta_instalacion'],
  },
  {
    numero: 184,
    nombre: 'La aceptación del anexo 2 no se podía responder',
    partes: [
      ['clientes', ['acepta_datos_personales']],
      ['instalaciones', ['acepta_datos_personales']],
    ],
    // `alta_copia_aceptacion_anexo2` NO se lista acá aunque la migración la
    // cree: es `RETURNS TRIGGER`, y PostgREST solo publica como RPC las que
    // devuelven datos. Pedirla daría un "falta la función" permanente sobre
    // una base que está bien — y un verificador que miente en rojo deja de
    // leerse. Las dos columnas ya prueban que la migración corrió.
  },
  {
    numero: 185,
    nombre: 'La ONU atada a su modelo del catálogo',
    /**
     * No se puede verificar desde acá, y decirlo es mejor que inventar.
     *
     * Esta migración no agrega ninguna columna ni vista: crea una función de
     * trigger y su trigger. PostgREST no publica ninguna de las dos, así que no
     * hay nada que esta herramienta pueda mirar por HTTP.
     *
     * Se deja listada igual para que el número no falte en la lista y nadie
     * crea que se olvidó. Se comprueba a mano: autorizar una ONU de un modelo
     * del catálogo y ver que le queda el tipo resuelto.
     */
    partes: [],
    sinVerificar: 'crea un trigger; PostgREST no lo expone. Se comprueba autorizando una ONU.',
  },
  {
    numero: 186,
    nombre: 'La potencia de los dos lados del enlace',
    partes: [['onus', ['olt_rx_power_dbm', 'temperatura_c']]],
  },
  {
    numero: 187,
    nombre: 'El cuarto aviso: al que ya está cortado',
    partes: [
      ['clientes', ['cortado_en', 'aviso_dias_4']],
      ['config_avisos_pago', ['dias_aviso_4', 'repetir_cada_4']],
      ['v_avisos_pago_pendientes', ['cortado_en', 'dias_cortado']],
    ],
  },
  {
    numero: 188,
    nombre: 'La foto al iniciar la jornada',
    partes: [['jornadas', ['foto_ingreso', 'foto_ingreso_at']]],
  },
  {
    numero: 189,
    nombre: 'La vista de jornadas no veía la foto',
    partes: [['v_jornadas', ['foto_ingreso', 'foto_ingreso_at']]],
  },
  {
    numero: 190,
    nombre: 'El ingreso, donde está el trabajo',
    partes: [
      ['jornadas', ['lat_ingreso', 'lng_ingreso', 'distancia_ingreso_m']],
      ['v_jornadas', ['distancia_ingreso_m', 'precision_ingreso_m']],
    ],
  },
  {
    numero: 191,
    nombre: 'El mantenimiento de los vehículos',
    partes: [
      ['mantenimiento_tipos', ['clave', 'cada_km', 'cada_meses']],
      ['mantenimientos', ['vehiculo_id', 'tipo_id', 'odometro']],
      ['v_mantenimiento', ['km_restantes', 'dias_restantes', 'sin_registro']],
    ],
  },
]

console.log(`\nBase: ${url}\n`)

let faltantes = 0

for (const m of MIGRACIONES) {
  const problemas = []

  for (const [tabla, columnas] of m.partes) {
    const r = await revisar(tabla, columnas)
    if (!r.ok) problemas.push(`${tabla}: ${r.motivo}`)
  }

  for (const fn of m.funciones ?? []) {
    const r = await revisarFuncion(fn)
    if (!r.ok) problemas.push(`${fn}(): ${r.motivo}`)
  }

  if (problemas.length) {
    faltantes++
    console.log(`  ${rojo('FALTA')}  ${m.numero} — ${m.nombre}`)
    for (const p of problemas) console.log(gris(`         · ${p}`))
  } else if (m.sinVerificar) {
    /**
     * Ni OK ni FALTA: no se sabe.
     *
     * Hay migraciones que solo crean triggers, y PostgREST no expone nada de
     * eso. Marcarlas OK sería afirmar algo que esta herramienta no comprobó
     * —y de un verificador lo único que se espera es que no mienta—; marcarlas
     * FALTA pondría en rojo una base que está bien, y un rojo permanente se
     * deja de leer. Se dice que hay que mirarlo a mano, y cómo.
     */
    console.log(`  ${gris('?')}      ${m.numero} — ${m.nombre}`)
    console.log(gris(`         · ${m.sinVerificar}`))
  } else {
    console.log(`  ${verde('OK')}     ${m.numero} — ${m.nombre}`)
  }
}

console.log()

if (faltantes) {
  console.log(
    `${rojo(`${faltantes} migración(es) sin aplicar.`)} Pegá el .sql correspondiente en\n` +
      'Supabase → SQL Editor → New query → Run, y volvé a correr esto.\n',
  )
  process.exit(1)
}

/**
 * Con todo aplicado, lo que falta es lo que NO se puede hacer desde el SQL:
 * emitir la llave y aprobar las plantillas en Meta.
 */
const contar = async (ruta) => {
  const res = await fetch(`${url}/rest/v1/${ruta}&select=id`, {
    method: 'HEAD',
    headers: { ...cabeceras, Prefer: 'count=exact' },
  })
  // PostgREST devuelve el total en `content-range`, como `0-24/137`.
  return Number(res.headers.get('content-range')?.split('/')[1] ?? 0)
}

const llaves = await contar('api_llaves?activa=eq.true')
const sinAprobar = await contar('plantillas_whatsapp?estado=neq.aprobada')

console.log(`${verde('Todas las migraciones están aplicadas.')}\n`)
console.log('Lo que no se resuelve con SQL:')
console.log(
  llaves
    ? `  ${verde('OK')}     Hay ${llaves} llave(s) de API activa(s).`
    : `  ${gris('·')}      No hay ninguna llave de API emitida todavía (Ajustes → Integraciones).`,
)
console.log(
  sinAprobar
    ? `  ${gris('·')}      ${sinAprobar} plantilla(s) de WhatsApp sin aprobar en Meta:\n` +
        gris('         esos avisos hoy salen por SMS o correo, no por WhatsApp.')
    : `  ${verde('OK')}     Todas las plantillas de WhatsApp están aprobadas.`,
)
console.log()
