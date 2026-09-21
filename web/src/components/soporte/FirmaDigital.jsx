import { useEffect, useRef, useState } from 'react'
import { Eraser, PenLine } from 'lucide-react'
import { Button } from '../ui'

/**
 * Firma de conformidad del abonado, en la pantalla del celular.
 *
 * Es lo que respalda que el trabajo se hizo y que el cliente lo dio por bueno.
 * Se dibuja con el dedo, así que hay dos cosas que importan más que el aspecto:
 *
 *  - `touch-action: none` en el lienzo. Sin eso el navegador interpreta el
 *    trazo como un scroll y la página se mueve mientras la persona firma.
 *  - El lienzo se dimensiona en píxeles reales del dispositivo. Si se deja el
 *    tamaño CSS, en un teléfono con pantalla densa la firma sale pixelada.
 */
export default function FirmaDigital({ valor, onCambio, alto = 180 }) {
  const lienzoRef = useRef(null)
  const dibujando = useRef(false)
  const [vacio, setVacio] = useState(!valor)

  useEffect(() => {
    const lienzo = lienzoRef.current
    if (!lienzo) return

    const dpr = window.devicePixelRatio || 1
    const ancho = lienzo.parentElement.clientWidth

    lienzo.width = ancho * dpr
    lienzo.height = alto * dpr
    lienzo.style.width = `${ancho}px`
    lienzo.style.height = `${alto}px`

    const ctx = lienzo.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#0f172a'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, ancho, alto)

    // Una firma ya guardada se vuelve a pintar: al reabrir el ticket tiene que
    // estar, no un recuadro en blanco que invite a firmar de nuevo.
    if (valor) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, ancho, alto)
      img.src = valor
      setVacio(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alto])

  const punto = (e) => {
    const r = lienzoRef.current.getBoundingClientRect()
    const t = e.touches?.[0] ?? e
    return { x: t.clientX - r.left, y: t.clientY - r.top }
  }

  function empezar(e) {
    e.preventDefault()
    dibujando.current = true
    const ctx = lienzoRef.current.getContext('2d')
    const { x, y } = punto(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function mover(e) {
    if (!dibujando.current) return
    e.preventDefault()
    const ctx = lienzoRef.current.getContext('2d')
    const { x, y } = punto(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    if (vacio) setVacio(false)
  }

  function terminar() {
    if (!dibujando.current) return
    dibujando.current = false
    // JPEG con fondo blanco: una firma en PNG con transparencia se pierde sobre
    // el papel oscuro del PDF, y pesa el triple.
    onCambio?.(lienzoRef.current.toDataURL('image/jpeg', 0.8))
  }

  function borrar() {
    const lienzo = lienzoRef.current
    const ctx = lienzo.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, lienzo.width / dpr, lienzo.height / dpr)
    setVacio(true)
    onCambio?.(null)
  }

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-lg border border-slate-600 bg-white">
        <canvas
          ref={lienzoRef}
          className="block w-full touch-none"
          onMouseDown={empezar}
          onMouseMove={mover}
          onMouseUp={terminar}
          onMouseLeave={terminar}
          onTouchStart={empezar}
          onTouchMove={mover}
          onTouchEnd={terminar}
        />
        {vacio && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-400">
            <PenLine size={16} /> Firme con el dedo
          </span>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="button" variante="fantasma" icon={Eraser} onClick={borrar} disabled={vacio}>
          Borrar y repetir
        </Button>
      </div>
    </div>
  )
}
