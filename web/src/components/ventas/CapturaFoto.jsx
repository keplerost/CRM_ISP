import { useRef, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Camera, Check, Eye, Trash2 } from 'lucide-react'
import { Badge, Button } from '../ui'
import { TIPOS_DOCUMENTO, expedientesApi } from '../../lib/expedientes'

/**
 * Una foto del expediente: sacarla, verla, reemplazarla.
 *
 * ── Por qué `capture="environment"` ──
 *
 * Abre la cámara trasera directamente en vez del selector de archivos. En el
 * teléfono, esa diferencia es entre un toque y cuatro — y el vendedor está
 * parado en la vereda con el cliente esperando.
 *
 * En escritorio el atributo se ignora solo y aparece el selector de siempre, así
 * que no hace falta distinguir el dispositivo.
 *
 * ── Por qué no se ve la foto directamente ──
 *
 * El bucket es privado. Para mirarla hace falta una URL firmada que dura cinco
 * minutos, y pedirla queda registrado en la auditoría. Es una cédula: quién la
 * miró y cuándo es parte de lo que hay que poder responder.
 */
export default function CapturaFoto({ expedienteId, tipo, documento, perfil, onCambio, onError }) {
  const confirmar = useConfirmar()
  const archivoRef = useRef(null)
  const [subiendo, setSubiendo] = useState(false)
  const [viendo, setViendo] = useState(null)

  const subir = async (e) => {
    const archivo = e.target.files?.[0]
    if (!archivo) return

    setSubiendo(true)
    onError?.(null)
    try {
      await expedientesApi.subirDocumento({ expedienteId, tipo, archivo, perfil })
      await onCambio?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setSubiendo(false)
      if (archivoRef.current) archivoRef.current.value = ''
    }
  }

  const cargado = !!documento

  return (
    <div
      className={`rounded-xl border p-3 transition ${
        cargado ? 'border-emerald-500/40 bg-emerald-500/10' : 'campo-borde campo-sup'
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="campo-txt text-[13px] font-medium">{TIPOS_DOCUMENTO[tipo]}</span>
        {cargado ? (
          <Badge color={documento.estado === 'validado' ? 'verde' : 'azul'}>
            {documento.estado === 'validado' ? 'Validado' : 'Cargado'}
          </Badge>
        ) : (
          <Badge color="gris">Pendiente</Badge>
        )}
      </div>

      <input
        ref={archivoRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={subir}
        className="hidden"
      />

      {cargado ? (
        <div className="flex gap-2">
          <Button
            variante="fantasma"
            icon={Eye}
            className="flex-1"
            onClick={async () => {
              try {
                setViendo(await expedientesApi.verDocumento(documento.ruta))
              } catch (err) {
                onError?.(err)
              }
            }}
          >
            Ver
          </Button>
          <Button
            variante="fantasma"
            icon={Camera}
            className="flex-1"
            cargando={subiendo}
            onClick={() => archivoRef.current?.click()}
          >
            Repetir
          </Button>
          <Button
            variante="fantasma"
            icon={Trash2}
            onClick={async () => {
              if (!await confirmar('¿Borrar esta foto?')) return
              try {
                await expedientesApi.borrarDocumento(documento)
                await onCambio?.()
              } catch (err) {
                onError?.(err)
              }
            }}
          />
        </div>
      ) : (
        // Botón alto: se aprieta con el pulgar, sin apuntar.
        <button
          type="button"
          onClick={() => archivoRef.current?.click()}
          disabled={subiendo}
          className="campo-acento flex w-full items-center justify-center gap-2 rounded-xl py-4 text-[15px] font-medium transition disabled:opacity-60"
        >
          <Camera size={20} />
          {subiendo ? 'Subiendo…' : 'Tomar foto'}
        </button>
      )}

      {viendo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setViendo(null)}
        >
          <img src={viendo} alt={TIPOS_DOCUMENTO[tipo]} className="max-h-full max-w-full rounded-lg" />
          <button
            type="button"
            className="absolute right-4 top-4 rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-100"
            onClick={() => setViendo(null)}
          >
            Cerrar
          </button>
        </div>
      )}
    </div>
  )
}
