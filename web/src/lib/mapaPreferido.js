import { useCallback, useEffect, useState } from 'react'

/**
 * Con qué aplicación abre el técnico las direcciones.
 *
 * ── Por qué una preferencia y no un menú cada vez ──
 *
 * Porque "Llegar" es el botón que más se aprieta en el día: una vez por parada,
 * más las que se vuelve a mirar en el camino. Agregarle un menú de dos opciones
 * a la acción más repetida son cuarenta toques por semana para elegir siempre
 * lo mismo.
 *
 * Se elige una vez, en Perfil, y todos los botones del sistema lo respetan.
 *
 * ── Por qué se guarda en el dispositivo y no en el legajo ──
 *
 * Es el mismo razonamiento que el tema de campo, y está escrito allá:
 *
 *     "El contexto no es la persona: es el aparato y dónde está parado."
 *
 * El técnico puede tener Waze en su celular y no tenerlo en la tablet de la
 * oficina. Una preferencia que viajara con la persona le abriría en la tablet
 * una aplicación que no está instalada, y ahí el botón no hace nada.
 */

const CLAVE = 'mapa-preferido'

/**
 * Las opciones.
 *
 * ── `sistema` es la que sirve para CUALQUIER aplicación ──
 *
 * No abre una app concreta: usa el esquema `geo:`, y Android le pregunta al
 * teléfono cuáles tiene instaladas. Ahí entran maps.me, OsmAnd, Organic Maps,
 * Petal Maps — todas, sin que el sistema tenga que conocerlas.
 *
 * Esa es la razón por la que NO se agregan una por una. Cada aplicación tiene
 * su propio esquema de enlace, algunos sin documentar y varios que cambian
 * entre versiones; mantener esa lista es una carrera que se pierde, y el día
 * que un técnico instale la que no está, el sistema no tiene respuesta. `geo:`
 * las cubre todas, incluidas las que todavía no existen.
 *
 * Lo único que no cubre es iPhone, que lo ignora. Por eso Google queda de
 * fábrica y esta opción no se ofrece ahí.
 *
 * ── Y no pregunta para siempre ──
 *
 * En el selector de Android hay un botón "Siempre". Quien lo toca elige una
 * sola vez, a nivel del teléfono, y no vuelve a ver la pregunta. Es lo mismo
 * que elegir acá, pero alcanzando a las aplicaciones que esta lista no nombra.
 */
export const APPS_MAPA = [
  {
    clave: 'google',
    label: 'Google Maps',
    nota: 'Abre igual aunque no la tengas instalada.',
  },
  { clave: 'waze', label: 'Waze' },
  {
    clave: 'sistema',
    label: 'La que yo elija en el teléfono',
    nota: 'Te muestra todas las que tengas: maps.me, OsmAnd, la que uses. Si tocás «Siempre», deja de preguntar.',
    soloAndroid: true,
  },
]

const VALIDAS = APPS_MAPA.map((a) => a.clave)

/**
 * Arranca en Google Maps.
 *
 * No se deduce de lo que el teléfono tenga instalado: el navegador no puede
 * saberlo, y probar a abrir para ver si funciona deja al técnico mirando una
 * pantalla en blanco cuando no está. Google Maps abre en el navegador aunque la
 * aplicación no esté, así que es la única que nunca falla.
 */
function inicial() {
  try {
    const g = localStorage.getItem(CLAVE)
    return VALIDAS.includes(g) ? g : 'google'
  } catch {
    // Modo privado en algunos navegadores tira al leer. No es motivo para que
    // la pantalla no cargue.
    return 'google'
  }
}

export function useMapaPreferido() {
  const [app, setAppEstado] = useState(inicial)

  useEffect(() => {
    try {
      localStorage.setItem(CLAVE, app)
    } catch {
      /* si no se puede guardar, la elección vale para esta sesión igual */
    }
  }, [app])

  const setApp = useCallback((v) => {
    if (VALIDAS.includes(v)) setAppEstado(v)
  }, [])

  return { app, setApp }
}

/** Para leerlo fuera de un componente, sin montar el hook. */
export const mapaPreferido = () => inicial()
