import { useCallback, useEffect, useState } from 'react'

/**
 * El tema de las pantallas de campo: claro para el sol, oscuro para el resto.
 *
 * ── Por qué se guarda en el dispositivo y no en el usuario ──
 *
 * La primera idea fue guardarlo en el legajo, para que "siga a la persona". Es
 * la respuesta equivocada: el mismo vendedor usa el celular en la vereda al
 * mediodía y la computadora en la oficina a las siete. Si la preferencia
 * viajara con él, poner el teléfono en claro le pondría también la pantalla del
 * escritorio en blanco — que es justo donde no hace falta y donde molesta.
 *
 * El contexto no es la persona: es el aparato y dónde está parado. Por eso vive
 * en `localStorage`, y cada dispositivo recuerda el suyo.
 *
 * Efecto secundario útil: no hay ida y vuelta al servidor, así que el cambio es
 * instantáneo. Alguien que sale al sol y no ve nada aprieta el botón y ve —no
 * espera a que responda una API con la pantalla en negro.
 */

const CLAVE = 'tema-campo'

/**
 * Arranca en oscuro.
 *
 * Se evaluó deducirlo de `prefers-color-scheme` del sistema. Se descartó: esa
 * preferencia dice si a la persona le gusta el modo oscuro, no si está bajo el
 * sol. Un teléfono en modo oscuro al mediodía necesita la pantalla clara igual,
 * y adivinarlo mal en el arranque es peor que dejar que lo elija.
 */
/**
 * ...salvo que la pantalla diga otra cosa.
 *
 * El tablero del técnico arranca en claro: se usa afuera, y una pantalla oscura
 * al sol del mediodía no se lee. El del vendedor sigue arrancando en oscuro,
 * que es como se diseñó.
 *
 * Lo guardado siempre gana sobre el valor de arranque: en cuanto alguien elige,
 * su elección vale para todas las pantallas de campo de ese dispositivo. El
 * parámetro solo decide qué mostrar la primera vez.
 */
const inicial = (porDefecto) => {
  try {
    const guardado = localStorage.getItem(CLAVE)
    if (guardado === 'claro' || guardado === 'oscuro') return guardado
    return porDefecto
  } catch {
    // Modo privado en algunos navegadores tira al leer. No es motivo para que
    // la pantalla no cargue.
    return porDefecto
  }
}

export function useTemaCampo(porDefecto = 'oscuro') {
  const [tema, setTema] = useState(() => inicial(porDefecto))

  useEffect(() => {
    try {
      localStorage.setItem(CLAVE, tema)
    } catch {
      /* si no se puede guardar, la elección vale para esta sesión igual */
    }
  }, [tema])

  const alternar = useCallback(() => setTema((t) => (t === 'claro' ? 'oscuro' : 'claro')), [])

  return { tema, alternar, esClaro: tema === 'claro' }
}
