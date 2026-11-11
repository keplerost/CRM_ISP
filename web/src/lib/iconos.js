/**
 * Los íconos de la planta externa (migración 236): SVG propios, sin archivos
 * ni librerías, para que se vean igual en el mapa, en la leyenda y en el KMZ
 * que se exporta (ahí van como PNG dentro del archivo).
 *
 * No hay una norma única de simbología FTTH: cada operadora tiene su leyenda.
 * Estos siguen las convenciones que más se repiten en los planos de planta
 * externa: la NAP como caja con el triángulo del splitter, la manga como domo
 * o cápsula, la reserva como bobina, la cámara con la X, los herrajes con su
 * letra (A retención, J suspensión).
 *
 * Cada ícono es un dibujo en un lienzo de 32×32 con el color que se elija. El
 * borde blanco los despega del mapa y de la línea del cable.
 */

const ok = (c) => (/^#[0-9A-Fa-f]{6}$/.test(String(c)) ? c : '#64748b')
const B = 'stroke="#ffffff" stroke-width="2" stroke-linejoin="round"'
const T = (letra, c, tam = 15) =>
  `<text x="16" y="21" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="${tam}" fill="${c}">${letra}</text>`

/** clave → { nombre, grupo, dibujo(color) } */
export const ICONOS = {
  // ── Postes y soportes ──
  poste: { nombre: 'Poste', grupo: 'Postes y soportes', d: (c) => `<circle cx="16" cy="16" r="10" fill="${c}" ${B}/><circle cx="16" cy="16" r="3" fill="#fff"/>` },
  poste_hormigon: {
    nombre: 'Poste de hormigón',
    grupo: 'Postes y soportes',
    d: (c) => `<circle cx="16" cy="16" r="11" fill="${c}" ${B}/><circle cx="16" cy="16" r="6" fill="none" stroke="#fff" stroke-width="2"/>`,
  },
  poste_madera: {
    nombre: 'Poste de madera',
    grupo: 'Postes y soportes',
    d: (c) => `<circle cx="16" cy="16" r="11" fill="${c}" ${B}/>${T('M', '#fff', 12)}`,
  },
  poste_metalico: {
    nombre: 'Poste metálico',
    grupo: 'Postes y soportes',
    d: (c) => `<polygon points="16,4 26.4,10 26.4,22 16,28 5.6,22 5.6,10" fill="${c}" ${B}/><circle cx="16" cy="16" r="3" fill="#fff"/>`,
  },
  poste_a: { nombre: 'Poste con herraje A (retención)', grupo: 'Postes y soportes', d: (c) => `<circle cx="16" cy="16" r="11" fill="${c}" ${B}/>${T('A', '#fff')}` },
  poste_j: { nombre: 'Poste con herraje J (suspensión)', grupo: 'Postes y soportes', d: (c) => `<circle cx="16" cy="16" r="11" fill="${c}" ${B}/>${T('J', '#fff')}` },
  retenida: {
    nombre: 'Retenida / tensor',
    grupo: 'Postes y soportes',
    d: (c) => `<circle cx="11" cy="11" r="7" fill="${c}" ${B}/><line x1="15" y1="15" x2="27" y2="27" stroke="#fff" stroke-width="5" stroke-linecap="round"/><line x1="15" y1="15" x2="27" y2="27" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/><line x1="23" y1="28" x2="29" y2="28" stroke="${c}" stroke-width="2.5"/>`,
  },
  torre: {
    nombre: 'Torre',
    grupo: 'Postes y soportes',
    d: (c) => `<polygon points="16,3 26,29 6,29" fill="${c}" ${B}/><path d="M11 21 L21 21 M12.5 15 L19.5 15 M10 27 L16 9 L22 27" stroke="#fff" stroke-width="1.5" fill="none"/>`,
  },
  mastil: {
    nombre: 'Mástil',
    grupo: 'Postes y soportes',
    d: (c) => `<rect x="13" y="4" width="6" height="22" rx="2" fill="${c}" ${B}/><rect x="7" y="25" width="18" height="4" rx="1.5" fill="${c}" ${B}/>`,
  },

  // ── Cajas, empalmes y distribución ──
  nap: {
    nombre: 'Caja NAP',
    grupo: 'Cajas y empalmes',
    d: (c) => `<rect x="4" y="4" width="24" height="24" rx="4" fill="${c}" ${B}/><polygon points="10,10 22,16 10,22" fill="#fff"/>`,
  },
  nap_madre: {
    nombre: 'NAP madre / primaria',
    grupo: 'Cajas y empalmes',
    d: (c) => `<rect x="3" y="3" width="26" height="26" rx="4" fill="${c}" ${B}/><rect x="7" y="7" width="18" height="18" rx="2" fill="none" stroke="#fff" stroke-width="1.8"/><polygon points="11,11 21,16 11,21" fill="#fff"/>`,
  },
  cto: {
    nombre: 'Caja terminal (CTO) con puertos',
    grupo: 'Cajas y empalmes',
    d: (c) =>
      `<rect x="4" y="5" width="24" height="22" rx="3" fill="${c}" ${B}/>` +
      [9, 14, 19, 24]
        .map((x) => `<circle cx="${x - 0.5}" cy="12" r="1.7" fill="#fff"/><circle cx="${x - 0.5}" cy="20" r="1.7" fill="#fff"/>`)
        .join(''),
  },
  manga_domo: {
    nombre: 'Manga tipo domo',
    grupo: 'Cajas y empalmes',
    d: (c) => `<path d="M7 28 V14 a9 9 0 0 1 18 0 V28 Z" fill="${c}" ${B}/><line x1="10" y1="22" x2="22" y2="22" stroke="#fff" stroke-width="2"/>`,
  },
  manga_lineal: {
    nombre: 'Manga lineal',
    grupo: 'Cajas y empalmes',
    d: (c) => `<rect x="2" y="10" width="28" height="12" rx="6" fill="${c}" ${B}/><line x1="9" y1="16" x2="23" y2="16" stroke="#fff" stroke-width="2"/>`,
  },
  empalme: {
    nombre: 'Punto de empalme / fusión',
    grupo: 'Cajas y empalmes',
    d: (c) => `<circle cx="16" cy="16" r="11" fill="${c}" ${B}/><path d="M11 11 L21 21 M21 11 L11 21" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`,
  },
  splitter: { nombre: 'Splitter', grupo: 'Cajas y empalmes', d: (c) => `<polygon points="5,5 28,16 5,27" fill="${c}" ${B}/>` },
  reserva: {
    nombre: 'Reserva de cable (bobina)',
    grupo: 'Cajas y empalmes',
    d: (c) => `<circle cx="16" cy="16" r="11" fill="${c}" ${B}/><circle cx="16" cy="16" r="7" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16" cy="16" r="3" fill="none" stroke="#fff" stroke-width="1.8"/>`,
  },
  fdh: {
    nombre: 'Gabinete / armario (FDH)',
    grupo: 'Cajas y empalmes',
    d: (c) => `<rect x="8" y="3" width="16" height="26" rx="2" fill="${c}" ${B}/><line x1="16" y1="6" x2="16" y2="26" stroke="#fff" stroke-width="1.5"/><circle cx="13.5" cy="16" r="1.3" fill="#fff"/><circle cx="18.5" cy="16" r="1.3" fill="#fff"/>`,
  },
  odf: {
    nombre: 'ODF / distribuidor',
    grupo: 'Cajas y empalmes',
    d: (c) => `<rect x="4" y="5" width="24" height="22" rx="2" fill="${c}" ${B}/><path d="M8 11 H24 M8 16 H24 M8 21 H24" stroke="#fff" stroke-width="2"/>`,
  },

  // ── Nodos y equipos ──
  nodo: {
    nombre: 'Nodo / central',
    grupo: 'Nodos y equipos',
    d: (c) => `<polygon points="16,3 29,13 29,29 3,29 3,13" fill="${c}" ${B}/><rect x="12" y="18" width="8" height="11" fill="#fff"/>`,
  },
  olt: {
    nombre: 'OLT',
    grupo: 'Nodos y equipos',
    d: (c) => `<rect x="3" y="8" width="26" height="16" rx="2" fill="${c}" ${B}/>${[8, 13, 18, 23].map((x) => `<rect x="${x - 1.5}" y="14" width="3" height="4" fill="#fff"/>`).join('')}`,
  },
  antena: {
    nombre: 'Antena / radioenlace',
    grupo: 'Nodos y equipos',
    d: (c) => `<circle cx="16" cy="16" r="12" fill="${c}" ${B}/><path d="M16 26 V14 M11 10 a7 7 0 0 1 10 0 M8 7 a11 11 0 0 1 16 0" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="16" cy="13" r="2" fill="#fff"/>`,
  },
  cliente: {
    nombre: 'Abonado / ONT',
    grupo: 'Nodos y equipos',
    d: (c) => `<polygon points="16,4 28,14 25,14 25,28 7,28 7,14 4,14" fill="${c}" ${B}/><rect x="13" y="19" width="6" height="9" fill="#fff"/>`,
  },
  energia: {
    nombre: 'Energía / fuente',
    grupo: 'Nodos y equipos',
    d: (c) => `<circle cx="16" cy="16" r="12" fill="${c}" ${B}/><polygon points="18,5 9,18 15,18 13,27 23,13 17,13" fill="#fff"/>`,
  },

  // ── Canalización y obra civil ──
  camara: {
    nombre: 'Cámara / pozo',
    grupo: 'Canalización',
    d: (c) => `<rect x="4" y="4" width="24" height="24" rx="2" fill="${c}" ${B}/><path d="M7 7 L25 25 M25 7 L7 25" stroke="#fff" stroke-width="2"/>`,
  },
  subida: {
    nombre: 'Subida / bajante a poste',
    grupo: 'Canalización',
    d: (c) => `<circle cx="16" cy="16" r="12" fill="${c}" ${B}/><path d="M16 24 V9 M10 14 L16 8 L22 14" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  cruce: {
    nombre: 'Cruce de calle',
    grupo: 'Canalización',
    d: (c) => `<rect x="3" y="3" width="26" height="26" rx="13" fill="${c}" ${B}/><path d="M8 12 H24 M8 20 H24" stroke="#fff" stroke-width="2" stroke-dasharray="3 2"/>`,
  },

  // ── Marcas ──
  circulo: { nombre: 'Círculo', grupo: 'Marcas', d: (c) => `<circle cx="16" cy="16" r="10" fill="${c}" ${B}/>` },
  cuadrado: { nombre: 'Cuadrado', grupo: 'Marcas', d: (c) => `<rect x="6" y="6" width="20" height="20" rx="2" fill="${c}" ${B}/>` },
  triangulo: { nombre: 'Triángulo', grupo: 'Marcas', d: (c) => `<polygon points="16,4 29,27 3,27" fill="${c}" ${B}/>` },
  rombo: { nombre: 'Rombo', grupo: 'Marcas', d: (c) => `<polygon points="16,3 29,16 16,29 3,16" fill="${c}" ${B}/>` },
  estrella: {
    nombre: 'Estrella',
    grupo: 'Marcas',
    d: (c) => `<polygon points="16,3 19.8,11.8 29,12.5 22,18.7 24.1,28 16,23.1 7.9,28 10,18.7 3,12.5 12.2,11.8" fill="${c}" ${B}/>`,
  },
  pin: {
    nombre: 'Pin',
    grupo: 'Marcas',
    d: (c) => `<path d="M16 30 C16 30 6 19 6 12 a10 10 0 0 1 20 0 C26 19 16 30 16 30 Z" fill="${c}" ${B}/><circle cx="16" cy="12" r="3.5" fill="#fff"/>`,
  },
  bandera: {
    nombre: 'Bandera (pendiente)',
    grupo: 'Marcas',
    d: (c) => `<line x1="8" y1="3" x2="8" y2="29" stroke="#fff" stroke-width="5" stroke-linecap="round"/><line x1="8" y1="3" x2="8" y2="29" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/><polygon points="9,4 27,9 9,15" fill="${c}" ${B}/>`,
  },
  alerta: {
    nombre: 'Alerta / falla',
    grupo: 'Marcas',
    d: (c) => `<polygon points="16,3 30,28 2,28" fill="${c}" ${B}/><path d="M16 11 V19" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="23.5" r="1.8" fill="#fff"/>`,
  },
}

/** El ícono que lleva cada tipo si nadie eligió otro. */
export const ICONO_POR_TIPO = {
  nodo: 'nodo',
  poste: 'poste',
  nap: 'nap',
  manga: 'manga_domo',
  reserva: 'reserva',
  splitter: 'splitter',
  odf: 'odf',
  otro: 'circulo',
}

/** Los grupos, en orden, para el selector. */
export const GRUPOS_ICONOS = [...new Set(Object.values(ICONOS).map((i) => i.grupo))]

/** El SVG completo de un ícono, del tamaño y color dados. */
export function svgIcono(clave, color, tamano = 24) {
  const i = ICONOS[clave] ?? ICONOS.circulo
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tamano}" height="${tamano}" viewBox="0 0 32 32">${i.d(ok(color))}</svg>`
}

/** Un nombre de archivo estable para el PNG del ícono en el KMZ. */
export const archivoIcono = (clave, color) => `iconos/${clave}-${ok(color).slice(1).toLowerCase()}.png`
