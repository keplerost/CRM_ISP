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
 * `sistema` no abre una aplicación concreta: usa el esquema `geo:`, que en
 * Android hace que el teléfono muestre su propio selector con las que tenga
 * instaladas. Es la opción correcta para quien usa varias — y la que NO
 * funciona en iPhone, que ignora `geo:`. Por eso no es la opción por defecto y
 * la pantalla lo aclara donde se elige.
 */
export const APPS_MAPA = [
  { clave: 'google', label: 'Google Maps' },
  { clave: 'waze', label: 'Waze' },
  { clave: 'sistema', label: 'Preguntar cada vez', soloAndroid: true },
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
