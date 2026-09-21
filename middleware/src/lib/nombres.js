/**
 * Comparación de nombres de personas.
 *
 * Existe para una sola decisión: ¿este abonado de la base es el mismo que la OLT
 * tiene anotado en la ONT? Y esa decisión tiene consecuencias asimétricas.
 *
 * Equivocarse enlazando significa que la señal de un abonado aparece en la ficha
 * de otro, que un corte por falta de pago le cae al vecino, y que una factura se
 * emite a nombre de quien no contrató. No enlazar, en cambio, solo significa que
 * alguien tiene que mirarlo a mano.
 *
 * Por eso acá NO hay similitud difusa, ni distancia de edición, ni umbrales de
 * parecido. Dos nombres son la misma persona cuando tienen exactamente las
 * mismas palabras; todo lo demás se manda a revisión humana. Es aburrido a
 * propósito.
 */

/**
 * Deja el nombre en su forma comparable.
 *
 * Quita tildes, unifica mayúsculas y convierte cualquier separador en espacio:
 * la OLT guarda "HERRERA_GUAMANI_ENMA" y el sistema "Herrera Guamaní Enma", que
 * son la misma persona escrita por dos manos distintas.
 */
export function normalizarNombre(texto) {
  return (
    String(texto ?? '')
      // La Ñ se aparta ANTES de tocar los acentos. NFD la descompone en N más
      // una tilde combinante, y el filtro de diacríticos la dejaría en N: "PEÑA"
      // pasaría a ser "PENA", que es otro apellido y otra persona.
      .replace(/[ñÑ]/g, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(//g, 'Ñ')
      .toUpperCase()
      // Cualquier separador —guiones bajos de la OLT, puntos, comas— vale lo
      // mismo que un espacio.
      .replace(/[^A-ZÑ0-9]+/g, ' ')
      .trim()
  )
}

/** Las palabras del nombre, ordenadas, para comparar sin importar el orden. */
export function palabrasDe(texto) {
  const n = normalizarNombre(texto)
  if (!n) return []
  return n
    .split(' ')
    // Partículas que unos escriben y otros no: "DE LA CRUZ" y "DELACRUZ".
    .filter((p) => p.length > 1 && !['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y'].includes(p))
    .sort()
}

/**
 * ¿Son la misma persona?
 *
 * Tres niveles, y solo los dos primeros valen para enlazar solo:
 *
 *  - `exacto`   — el mismo texto normalizado.
 *  - `orden`    — las mismas palabras en otro orden. Pasa siempre: un sistema
 *                 guarda "APELLIDO NOMBRE" y el otro "NOMBRE APELLIDO".
 *  - `null`     — cualquier otra cosa, incluido "una es parte de la otra".
 *
 * El tercer caso es el importante: "MORALES" y "MORALES GUAMAN KLEVER" podrían
 * ser la misma persona o dos hermanos. Adivinar ahí es exactamente el error que
 * no se puede cometer.
 */
export function compararNombres(a, b) {
  const na = normalizarNombre(a)
  const nb = normalizarNombre(b)
  if (!na || !nb) return null
  if (na === nb) return 'exacto'

  const pa = palabrasDe(a)
  const pb = palabrasDe(b)
  if (!pa.length || !pb.length) return null
  if (pa.length === pb.length && pa.every((p, i) => p === pb[i])) return 'orden'

  return null
}

/**
 * Busca a una persona en una lista.
 *
 * Devuelve el candidato ÚNICO o nada. Si dos abonados distintos empatan con el
 * mismo nombre —hay homónimos, y en un pueblo son más de los que uno cree— no
 * se elige ninguno: se devuelven los dos para que decida una persona.
 */
export function buscarPersona(nombre, candidatos, obtenerNombre = (c) => c.nombre) {
  const coincidencias = []

  for (const c of candidatos) {
    const como = compararNombres(nombre, obtenerNombre(c))
    if (como) coincidencias.push({ candidato: c, como })
  }

  if (coincidencias.length === 1) return { ...coincidencias[0], ambiguo: false }
  if (coincidencias.length > 1) return { candidato: null, como: null, ambiguo: true, coincidencias }
  return null
}

/**
 * Un texto que pueda viajar a un equipo Huawei sin perder letras.
 *
 * El equipo solo guarda ASCII. Al mandarle "José Luis Oña Riera" tal cual, los
 * caracteres acentuados no se convierten: se pierden. Lo que quedó escrito en la
 * ONT del abonado fue
 *
 *     Jos_Luis_Oa_Riera
 *
 * "Oña" convertido en "Oa" es un apellido que ya no se puede buscar ni
 * reconocer, y el nombre queda así en el equipo hasta que alguien lo reescriba.
 *
 * Acá se transliteran antes de mandarlos: é→e, ñ→n. Es una pérdida, pero es la
 * pérdida legible — "Ona" se lee y se encuentra; "Oa" no.
 *
 * A diferencia de `normalizarNombre`, la Ñ NO se protege: acá el destino no
 * admite la letra, así que convertirla es lo único posible. Aquella otra existe
 * para comparar personas entre sí, donde PEÑA y PENA son dos apellidos
 * distintos y confundirlos sería atribuirle el servicio a otro.
 */
export function aAsciiParaEquipo(texto) {
  return String(texto ?? '')
    .replace(/ñ/g, 'n')
    .replace(/Ñ/g, 'N')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Lo que siga sin ser ASCII imprimible se cambia por un guion bajo en vez de
    // borrarse: una letra que desaparece acorta la palabra sin avisar.
    .replace(/[^\x20-\x7E]/g, '_')
}
