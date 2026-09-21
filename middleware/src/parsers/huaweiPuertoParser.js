/**
 * Estado de un puerto PON Huawei.
 *
 * `display port state <portid>` dentro de `interface gpon <frame>/<slot>`.
 * Escrito contra la salida real de un MA5800-X7.
 *
 * Todo se busca por su etiqueta y nunca por posición: el equipo intercala
 * saltos de cursor a mitad de la salida y una línea puede aparecer corrida sin
 * que eso signifique nada. Se vio en esta misma salida —"TX power(dBm)" llega
 * precedido de cuarenta espacios— y por eso el patrón no ancla al principio.
 */

const limpiar = (s) =>
  String(s ?? '')
    .replace(/\x1b?\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')

/** Busca "Etiqueta    valor" en cualquier parte de la salida. */
function campo(texto, etiqueta) {
  const escapada = etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = texto.match(new RegExp(`${escapada}\\s{2,}(.+?)\\s*$`, 'im'))
  const v = m?.[1]?.trim()
  return v && v !== '-' ? v : null
}

const num = (v) => {
  if (v == null) return null
  const m = String(v).match(/-?\d+(\.\d+)?/)
  return m ? Number.parseFloat(m[0]) : null
}

/** "2026-07-28 12:37:11-05:00" → ISO, o null si no se puede leer. */
function fecha(v) {
  if (!v) return null
  const m = String(v).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})?/)
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}${m[3] ?? ''}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function parseEstadoPuerto(salida) {
  const t = limpiar(salida)

  const fsp = campo(t, 'F/S/P')
  const estado = campo(t, 'Port state')
  if (!fsp && !estado) return null

  const modulo = campo(t, 'Optical Module status')

  return {
    fsp,
    estado,
    online: /online/i.test(estado ?? ''),

    // La causa y la hora de la última caída son lo que convierte una foto en
    // una historia: un puerto que se cayó tres veces esta semana es un
    // problema aunque ahora esté arriba.
    ultima_caida_causa: campo(t, 'Last down cause'),
    ultima_caida: fecha(campo(t, 'Last down time')),
    ultima_subida: fecha(campo(t, 'Last up time')),

    ancho_banda_kbps: num(campo(t, 'Available bandwidth(Kbps)')),

    // "Inexistent" es la buena noticia. Una ONU rogue transmite fuera de su
    // turno y degrada a TODOS los abonados del puerto — es de las averías más
    // difíciles de encontrar sin esto.
    rogue: campo(t, 'Illegal rogue ONT'),
    rogue_detectada: /exist/i.test(campo(t, 'Illegal rogue ONT') ?? '') &&
      !/inexist/i.test(campo(t, 'Illegal rogue ONT') ?? ''),

    señal: campo(t, 'Signal detect'),
    chipset: campo(t, 'xPON MAC chipset state'),

    modulo: {
      estado: modulo,
      ok: /online|normal/i.test(modulo ?? ''),
      laser: campo(t, 'Laser state'),
      tx_fault: campo(t, 'TX fault'),
      temperatura_c: num(campo(t, 'Temperature(C)')),
      bias_ma: num(campo(t, 'TX Bias current(mA)')),
      voltaje_v: num(campo(t, 'Supply Voltage(V)')),
      tx_dbm: num(campo(t, 'TX power(dBm)')),
      distancia_max_km: num(campo(t, 'Max Distance(Km)')),
      clase: campo(t, 'Module sub-type'),
      longitud_onda_nm: num(campo(t, 'Wave length(nm)')),
      vendor: campo(t, 'Vendor name'),
      modelo: campo(t, 'Vendor PN'),
      serie: campo(t, 'Vendor SN'),
    },
  }
}

/**
 * Qué puertos tienen el auto-find habilitado, según la configuración.
 *
 *     port 0 ont-auto-find enable
 *
 * Sale del respaldo o de `display current-configuration`: no hay un `display`
 * que lo muestre por puerto, y este modelo rechaza los candidatos obvios.
 */
export function parseAutofindPorPuerto(configuracion) {
  const estado = new Map()

  for (const linea of limpiar(configuracion).split('\n')) {
    const m = linea.match(/^\s*port\s+(\d+)\s+ont-auto-find\s+(enable|disable)/i)
    if (m) estado.set(Number(m[1]), /enable/i.test(m[2]))
  }
  return estado
}
