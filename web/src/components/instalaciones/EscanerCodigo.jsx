import { useEffect, useRef, useState } from 'react'
import { ScanLine, X } from 'lucide-react'
import { Aviso, Button } from '../ui'

/**
 * Lector de QR y código de barras con la cámara del teléfono.
 *
 * Usa `BarcodeDetector`, que viene en el navegador: una librería de escaneo son
 * cientos de kilobytes que el técnico tendría que bajar con datos móviles antes
 * de poder trabajar.
 *
 * No está en todos lados —Safari todavía no lo trae—, así que cuando falta no
 * se rompe nada: el formulario de al lado permite escribir la serie a mano, que
 * es lo que se hacía siempre. El escáner ahorra el error de tipeo, no habilita
 * el trabajo.
 *
 * Dos cosas que importan más que el aspecto:
 *  - La cámara se apaga al desmontar y al encontrar el código. Dejarla prendida
 *    calienta el teléfono y se come la batería del turno.
 *  - Se pide la cámara trasera (`environment`): con la frontal el técnico
 *    tendría que leer la etiqueta de espaldas al equipo.
 */

const SOPORTADO = typeof window !== 'undefined' && 'BarcodeDetector' in window

const FORMATOS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix', 'pdf417']

export default function EscanerCodigo({ onLeer }) {
  const videoRef = useRef(null)
  const flujoRef = useRef(null)
  const buscandoRef = useRef(false)

  const [activo, setActivo] = useState(false)
  const [fallo, setFallo] = useState(null)

  function apagar() {
    buscandoRef.current = false
    flujoRef.current?.getTracks().forEach((t) => t.stop())
    flujoRef.current = null
    setActivo(false)
  }

  // La cámara tiene que apagarse también cuando el técnico se va de la pantalla
  // sin haber escaneado nada.
  useEffect(() => apagar, [])

  async function encender() {
    setFallo(null)

    try {
      const flujo = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      })
      flujoRef.current = flujo
      setActivo(true)

      // El <video> recién existe después de que React pinte con `activo` en
      // true; por eso la asignación va en el microtask siguiente.
      queueMicrotask(async () => {
        const video = videoRef.current
        if (!video) return
        video.srcObject = flujo
        await video.play().catch(() => {})
        buscar()
      })
    } catch (err) {
      setFallo(
        err?.name === 'NotAllowedError'
          ? 'No se dio permiso para usar la cámara. Escribí la serie a mano o habilitá el permiso desde el candado de la barra de direcciones.'
          : `No se pudo abrir la cámara: ${err?.message ?? err}`,
      )
      apagar()
    }
  }

  async function buscar() {
    const detector = new window.BarcodeDetector({ formats: FORMATOS })
    buscandoRef.current = true

    const intentar = async () => {
      if (!buscandoRef.current || !videoRef.current) return

      try {
        const [codigo] = await detector.detect(videoRef.current)
        if (codigo?.rawValue) {
          apagar()
          return onLeer?.(codigo.rawValue)
        }
      } catch {
        // Un cuadro que no se pudo analizar no es un error: se prueba con el
        // siguiente. Cortar acá haría que un reflejo apague el escáner.
      }

      requestAnimationFrame(intentar)
    }

    requestAnimationFrame(intentar)
  }

  if (!SOPORTADO) {
    return (
      <Aviso>
        Este navegador no puede leer códigos con la cámara. Escribí la serie o la MAC a mano —están
        impresas en la etiqueta del equipo, debajo del código.
      </Aviso>
    )
  }

  return (
    <div className="space-y-2">
      {fallo && <Aviso tipo="alerta">{fallo}</Aviso>}

      {activo ? (
        <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-black">
          <video ref={videoRef} playsInline muted className="block max-h-72 w-full object-cover" />

          {/* Marco de puntería: sin una referencia visual la gente acerca
              demasiado el teléfono y el código sale desenfocado. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-40 w-40 rounded-lg border-2 border-sky-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
          </div>

          <button
            type="button"
            onClick={apagar}
            className="absolute right-2 top-2 rounded-full bg-black/60 p-2 text-white"
            aria-label="Cerrar la cámara"
          >
            <X size={16} />
          </button>

          <p className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-2 text-center text-xs text-slate-200">
            Apuntá al código de la etiqueta del equipo
          </p>
        </div>
      ) : (
        <Button type="button" variante="primario" icon={ScanLine} onClick={encender} className="w-full">
          Escanear el código del equipo
        </Button>
      )}
    </div>
  )
}
