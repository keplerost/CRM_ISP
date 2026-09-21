import { useEffect, useRef, useState } from 'react'
import { CornerDownLeft, Terminal, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, ErrorBanner, Input } from '../ui'

/**
 * Consola contra la CLI del equipo.
 *
 * Es la escotilla de escape: sirve para probar un comando antes de codificarlo y
 * para resolver lo que el sistema todavía no sabe hacer.
 *
 * Dos avisos que no son decorativos:
 *
 *  - Esto habla con la OLT de producción. Un `undo` mal puesto deja sin servicio
 *    a los abonados de un puerto entero.
 *  - Cada comando viaja por la sesión SSH compartida. Si el comando deja al
 *    equipo dentro de otro contexto (una interfaz, un submenú), las operaciones
 *    que vengan después corren ahí. Por eso conviene salir con `quit` al
 *    terminar.
 */
export default function OltConsola({ olt }) {
  const [comando, setComando] = useState('')
  const [lineas, setLineas] = useState([])
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)
  const [historia, setHistoria] = useState([])
  const [posicion, setPosicion] = useState(-1)
  const finRef = useRef(null)

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lineas])

  async function enviar(e) {
    e?.preventDefault()
    const cmd = comando.trim()
    if (!cmd || enviando) return

    setEnviando(true)
    setError(null)
    setLineas((l) => [...l, { tipo: 'entrada', texto: cmd }])
    setHistoria((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 50))
    setPosicion(-1)
    setComando('')

    try {
      const r = await api.olt.cli(olt.id, [cmd])
      const salida = (r.resultados ?? [])
        .map((x) => (typeof x === 'string' ? x : (x?.salida ?? JSON.stringify(x))))
        .join('\n')
      setLineas((l) => [...l, { tipo: 'salida', texto: salida || '(sin salida)' }])
    } catch (err) {
      setError(err)
      setLineas((l) => [...l, { tipo: 'error', texto: err.message }])
    } finally {
      setEnviando(false)
    }
  }

  /** Flechas arriba/abajo recorren los comandos anteriores, como una terminal. */
  function teclas(e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const nueva = Math.min(posicion + 1, historia.length - 1)
      if (nueva >= 0) {
        setPosicion(nueva)
        setComando(historia[nueva])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const nueva = posicion - 1
      setPosicion(nueva)
      setComando(nueva >= 0 ? historia[nueva] : '')
    }
  }

  return (
    <Card
      title={`Consola · ${olt.nombre}`}
      subtitle={`${olt.marca} en ${olt.ip_host}:${olt.puerto_ssh}`}
      icon={Terminal}
      actions={
        <Button
          variante="fantasma"
          icon={Trash2}
          onClick={() => setLineas([])}
          disabled={!lineas.length}
        >
          Limpiar
        </Button>
      }
    >
      <div className="space-y-3">
        <Aviso tipo="alerta">
          Los comandos van al equipo de producción. La sesión es compartida con el resto del
          sistema: si un comando deja la CLI dentro de otro contexto, lo que se ejecute después
          corre ahí. Conviene salir con <code className="font-mono">quit</code> al terminar.
        </Aviso>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="h-80 overflow-y-auto rounded-lg border border-slate-800 bg-black/50 p-3 font-mono text-[11.5px] leading-relaxed">
          {lineas.length === 0 ? (
            <p className="text-slate-600">
              La salida va a aparecer acá. Probá con{' '}
              <span className="text-slate-400">display version</span> en Huawei o{' '}
              <span className="text-slate-400">show version</span> en V-SOL.
            </p>
          ) : (
            lineas.map((l, i) => (
              <pre
                key={i}
                className={`whitespace-pre-wrap break-words ${
                  l.tipo === 'entrada'
                    ? 'mt-2 text-sky-300'
                    : l.tipo === 'error'
                      ? 'text-rose-400'
                      : 'text-slate-400'
                }`}
              >
                {l.tipo === 'entrada' ? `> ${l.texto}` : l.texto}
              </pre>
            ))
          )}
          <div ref={finRef} />
        </div>

        <form onSubmit={enviar} className="flex gap-2">
          <Input
            value={comando}
            onChange={(e) => setComando(e.target.value)}
            onKeyDown={teclas}
            placeholder="Escribí un comando y presioná Enter — ↑ recorre los anteriores"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            variante="exito"
            icon={CornerDownLeft}
            cargando={enviando}
            disabled={!comando.trim()}
          >
            Ejecutar
          </Button>
        </form>
      </div>
    </Card>
  )
}
