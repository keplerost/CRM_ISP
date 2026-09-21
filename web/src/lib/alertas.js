/**
 * Los textos de las alertas.
 *
 * ── Por qué esto es un módulo con pruebas ──
 *
 * Porque lo va a leer una persona en el teléfono, muchas veces de noche y con
 * una mano. Un mensaje que no dice DÓNDE es una salida al pedo; uno que no dice
 * CUÁNTOS no deja decidir si hay que ir ahora o mañana.
 *
 * Sin imports a propósito, igual que `comisionesCalculo.js` y `abonados.js`: se
 * prueba con el mismo runner, sin navegador y sin base.
 */

/** El símbolo dice la gravedad antes que la primera palabra. */
const ICONO = {
  corte_grupo: '🔴',
  ont_caida: '⚠️',
  potencia_critica: '🟡',
  degradacion: '🟡',
}

const hora = (f) => {
  if (!f) return ''
  const d = new Date(f)
  if (Number.isNaN(d.getTime())) return ''
  const dd = (n) => String(n).padStart(2, '0')
  return `${dd(d.getHours())}:${dd(d.getMinutes())}`
}

/** "hace 12 minutos", "hace 2 h". Es lo que dice si vale la pena salir ahora. */
export function haceCuanto(desde, ahora = new Date()) {
  if (!desde) return ''
  const min = Math.max(0, Math.floor((ahora - new Date(desde)) / 60000))
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `hace ${h} h`
  return `hace ${Math.floor(h / 24)} d`
}

/**
 * El texto de un evento.
 *
 * ── La diferencia que hace útil a esta herramienta ──
 *
 * Un corte agrupado dice "es la red": se manda uno solo y se nombra la caja.
 * Una ONT sola dice "mirá a este abonado": puede ser una mudanza o un equipo
 * que se está yendo, y por eso lleva el nombre, el código y la zona — los tres
 * datos con los que alguien puede llamar sin abrir el sistema.
 */
export function textoAlerta(evento, ahora = new Date()) {
  const e = evento ?? {}
  const icono = ICONO[e.regla] ?? '⚠️'

  if (e.resuelto) {
    return `✅ ${e.etiqueta ?? 'Servicio'} — se restableció (${hora(new Date())})`
  }

  if (e.regla === 'corte_grupo') {
    return [
      `${icono} CORTE — ${e.etiqueta ?? 'zona sin identificar'}`,
      `${e.abonados ?? 0} abonados sin señal desde las ${hora(e.empezo_en)} (${haceCuanto(e.empezo_en, ahora)})`,
      e.zona ? `Zona: ${e.zona}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (e.regla === 'ont_caida') {
    const d = e.detalle ?? {}
    /*
     * El código solo existe si el abonado tiene ficha en el sistema. Cuando no
     * la tiene —la ONT está en la OLT y el CRM todavía no la alcanzó— se manda
     * el número de serie en su lugar: es lo único con lo que alguien puede
     * encontrar ese equipo. Sin uno de los dos, el aviso nombra a una persona
     * que después no se puede buscar en ningún lado.
     */
    const identidad = d.codigo != null ? ` (${String(d.codigo).padStart(6, '0')})` : ''

    return [
      `${icono} Sin señal — ${e.etiqueta ?? 'abonado'}${identidad}`,
      `Desde las ${hora(e.empezo_en)} (${haceCuanto(e.empezo_en, ahora)}). Su caja está normal.`,
      // La dirección va antes que la zona: es con lo que se llega a la puerta.
      d.direccion ? `📍 ${d.direccion}` : null,
      e.zona ? `Zona: ${e.zona}` : null,
      d.telefono ? `Tel: ${d.telefono}` : null,
      d.codigo == null && d.sn ? `SN: ${d.sn}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (e.regla === 'potencia_critica') {
    const rx = e.detalle?.rx_dbm
    return [
      `${icono} Señal crítica — ${e.etiqueta ?? 'abonado'}`,
      rx != null ? `${rx} dBm. Todavía navega, pero se va a cortar.` : 'Por debajo del umbral.',
      e.zona ? `Zona: ${e.zona}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (e.regla === 'degradacion') {
    return [
      `${icono} Señal bajando — ${e.etiqueta ?? 'abonado'}`,
      e.detalle?.desde != null && e.detalle?.hasta != null
        ? `De ${e.detalle.desde} a ${e.detalle.hasta} dBm en los últimos días.`
        : 'La potencia viene cayendo.',
    ]
      .filter(Boolean)
      .join('\n')
  }

  return `${icono} ${e.nombre ?? e.regla ?? 'Alerta'} — ${e.etiqueta ?? ''}`.trim()
}

/**
 * ¿Este destino tiene que recibir este evento?
 *
 * Tres filtros que se suman, y ninguno es adorno:
 *
 *   TIPOS   El técnico de campo no necesita que le suene una degradación de
 *           señal que se arregla la semana que viene.
 *   ZONAS   Ni un corte en la otra punta de la cobertura.
 *   HORARIO Y a las cuatro de la mañana, solo lo que amerita levantarse.
 *
 * Vacío significa "todo": es el valor con el que se crea un destino nuevo, y es
 * el que no sorprende a nadie.
 */
export function leCorresponde(destino, evento, ahora = new Date()) {
  const d = destino ?? {}
  if (d.activo === false) return false

  const tipos = d.tipos ?? []
  if (tipos.length && !tipos.includes(evento?.regla)) return false

  const zonas = d.zonas ?? []
  if (zonas.length) {
    // Sin zona en el evento no se descarta: un corte de una caja sin zona
    // cargada es exactamente el que no hay que perderse.
    if (evento?.zona && !zonas.includes(evento.zona)) return false
  }

  return enHorario(d, ahora)
}

/**
 * Si estamos dentro de la franja del destino.
 *
 * Contempla las que cruzan la medianoche —20:00 a 07:00 es la guardia
 * nocturna—, que con una comparación simple quedarían siempre en falso.
 */
export function enHorario({ desde_hora, hasta_hora } = {}, ahora = new Date()) {
  if (!desde_hora || !hasta_hora) return true

  const min = (t) => {
    const [h, m] = String(t).split(':').map(Number)
    return h * 60 + (m || 0)
  }
  const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes()
  const d = min(desde_hora)
  const h = min(hasta_hora)

  return d <= h ? ahoraMin >= d && ahoraMin <= h : ahoraMin >= d || ahoraMin <= h
}

/** Cómo se lee cada regla en la pantalla de ajustes. */
export const UNIDAD_UMBRAL = {
  ont_caida: null,
  corte_grupo: 'abonados de la misma caja',
  potencia_critica: 'dBm',
  degradacion: 'dBm de caída',
}
