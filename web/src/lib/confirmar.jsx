import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { Button, DatosEnFicha, Modal } from '../components/ui'

/**
 * El "¿estás seguro?" del sistema, en lugar del cuadro del navegador.
 *
 * ── Por qué se espera en vez de recibir un callback ──
 *
 * El `confirm()` nativo frena la ejecución y devuelve `true` o `false`, así que
 * el código quedaba escrito así:
 *
 *     if (!confirm('¿Borrar la foto?')) return
 *     await borrar()
 *
 * Una ventana de React no puede frenar nada: dibuja, espera un clic, y avisa
 * por un callback. Convertir cada uno de los sesenta y nueve lugares a esa forma
 * significaba partir cada función en dos —lo de antes de preguntar y lo de
 * después— con un estado en el medio para acordarse de sobre qué se preguntaba.
 * Sesenta y nueve oportunidades de equivocarse en código que hoy anda.
 *
 * Con una promesa, la forma de arriba se conserva:
 *
 *     if (!(await confirmar('¿Borrar la foto?'))) return
 *     await borrar()
 *
 * Cambia una línea y no cambia el flujo. La promesa se resuelve cuando la
 * persona elige, que es exactamente lo que hacía el `confirm` nativo — sin
 * congelar la pestaña mientras tanto.
 *
 * ── Por qué hay una sola ventana y no una por pantalla ──
 *
 * Vive en la raíz de la aplicación y se dibuja una vez. Cualquier pantalla la
 * pide con el hook. Así el aspecto, el foco, el Escape y el botón peligroso son
 * los mismos en todos lados, y se cambian en un solo lugar.
 */

const Contexto = createContext(null)

export function ConfirmarProvider({ children }) {
  const [pedido, setPedido] = useState(null)

  /**
   * El `resolve` de la promesa que está esperando.
   *
   * Va en una ref y no en el estado a propósito: si estuviera en el estado,
   * cada dibujado crearía una identidad nueva y el `confirmar` que devuelve el
   * hook cambiaría en cada render, invalidando cualquier `useCallback` que lo
   * tenga como dependencia.
   */
  const resolver = useRef(null)

  const confirmar = useCallback((opciones) => {
    // Se acepta un texto suelto porque la mayoría de los llamados son eso: una
    // sola pregunta. Pedir un objeto para escribir `{ mensaje: '¿Borrar?' }`
    // sería ceremonia sin nada a cambio.
    const cfg = typeof opciones === 'string' ? { mensaje: opciones } : opciones

    return new Promise((resolve) => {
      resolver.current = resolve
      setPedido(cfg)
    })
  }, [])

  const responder = useCallback((respuesta) => {
    setPedido(null)
    resolver.current?.(respuesta)
    resolver.current = null
  }, [])

  return (
    <Contexto.Provider value={confirmar}>
      {children}

      <Modal
        abierto={!!pedido}
        titulo={pedido?.titulo ?? 'Confirmar'}
        // Cerrar con la X o con Escape es decir que no. Cualquier otra cosa
        // dejaría la promesa colgada para siempre y la pantalla trabada.
        onCerrar={() => responder(false)}
      >
        {pedido && (
          <div className="space-y-4">
            <div className="flex gap-3">
              <AlertTriangle
                size={20}
                className={
                  pedido.variante === 'peligro' || !pedido.variante
                    ? 'mt-0.5 flex-none text-amber-400'
                    : 'mt-0.5 flex-none text-sky-400'
                }
              />
              {/* `whitespace-pre-line` porque los mensajes que vienen del
                  `confirm` viejo traen saltos de línea escritos a mano. */}
              <p className="whitespace-pre-line text-sm text-slate-300">{pedido.mensaje}</p>
            </div>

            {pedido.datos?.length > 0 && <DatosEnFicha datos={pedido.datos} />}

            <div className="flex justify-end gap-2 pt-1">
              <Button variante="fantasma" onClick={() => responder(false)}>
                {pedido.etiquetaCancelar ?? 'Cancelar'}
              </Button>
              <Button
                variante={pedido.variante ?? 'peligro'}
                autoFocus
                onClick={() => responder(true)}
              >
                {pedido.etiquetaAccion ?? 'Sí, continuar'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Contexto.Provider>
  )
}

/**
 * Devuelve `confirmar(mensaje | opciones)` → `Promise<boolean>`.
 *
 * Si nadie montó el proveedor, cae al `confirm` del navegador en vez de romper:
 * una pantalla fea es mejor que una acción destructiva que se ejecuta sin
 * preguntar porque el contexto faltaba.
 */
export function useConfirmar() {
  const ctx = useContext(Contexto)
  if (ctx) return ctx

  return (opciones) => {
    const cfg = typeof opciones === 'string' ? { mensaje: opciones } : opciones
    // eslint-disable-next-line no-alert
    return Promise.resolve(window.confirm(cfg.mensaje))
  }
}
