import { useState } from 'react'
import { CheckCircle2, ClipboardCopy, Radar, XCircle } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { descargar } from '../../lib/olts'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner } from '../ui'

/**
 * Relevamiento de un área contra el equipo real.
 *
 * Esta pestaña existe por una lección cara: los parsers de ONU se escribieron
 * contra la documentación y hubo que rehacerlos contra la salida real. El
 * MA5800-X7 rechaza `display fan`, `display cpu`, `display memory` y
 * `display alarm active` — cuatro comandos que cualquier manual da por sentados.
 *
 * Así que antes de escribir un parser se le pregunta al equipo qué entiende, y
 * lo que se muestra es la salida cruda, sin resumir. Ese texto es exactamente el
 * material con el que después se escribe el parser de verdad.
 */
export default function OltRelevamiento({ olt, area, titulo, ayuda }) {
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [copiado, setCopiado] = useState(false)

  async function relevar() {
    setCargando(true)
    setError(null)
    setDatos(null)
    try {
      setDatos(await api.olt.relevar(olt.id, area))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }

  const transcripcion = () =>
    [
      `# Relevamiento: ${titulo}`,
      `# Equipo: ${olt.nombre} (${olt.marca} ${olt.hw_version ?? ''} ${olt.sw_version ?? ''})`,
      '',
      ...(datos?.resultados ?? []).map((r) =>
        [`## ${r.comando}`, r.rechazo ? `RECHAZADO: ${r.rechazo}` : '', r.salida, ''].join('\n'),
      ),
    ].join('\n')

  async function copiar() {
    try {
      await navigator.clipboard.writeText(transcripcion())
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      // Sin permiso de portapapeles queda la descarga, que nunca falla.
      descargar(`relevamiento-${area}.txt`, transcripcion(), 'text/plain;charset=utf-8')
    }
  }

  return (
    <Card
      title={titulo}
      subtitle={ayuda}
      icon={Radar}
      actions={
        <div className="flex gap-2">
          {datos && (
            <Button icon={ClipboardCopy} onClick={copiar}>
              {copiado ? 'Copiado' : 'Copiar salida'}
            </Button>
          )}
          <Button variante="primario" icon={Radar} onClick={relevar} cargando={cargando}>
            Preguntar al equipo
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {!datos && !cargando && (
          <Aviso>
            Todavía no hay un lector escrito para esta área en una OLT{' '}
            <b>{olt.marca}</b>. Antes de escribirlo hay que saber qué comandos acepta este modelo
            concreto — inventarlos desde el manual es lo que ya salió caro en este proyecto.
            <br />
            <br />
            Apretá <b>Preguntar al equipo</b>: se prueban varios comandos candidatos y se muestra
            la salida cruda de cada uno. Con ese texto se escribe el parser y esta pestaña pasa a
            mostrar los datos ya ordenados.
          </Aviso>
        )}

        {cargando && <Cargando texto="Probando comandos contra el equipo…" />}

        {datos && (
          <>
            <p className="text-xs text-slate-400">
              {datos.aceptados} de {datos.resultados.length} comandos devolvieron algo en{' '}
              <span className="text-slate-200">{olt.nombre}</span>.
            </p>

            {datos.resultados.map((r) => (
              <div key={r.comando} className="rounded-lg border border-slate-800">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
                  <code className="font-mono text-xs text-slate-200">{r.comando}</code>
                  {r.rechazo ? (
                    <span className="flex items-center gap-1.5">
                      <XCircle size={13} className="text-rose-400" />
                      <Badge color="rojo">rechazado</Badge>
                    </span>
                  ) : r.util ? (
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 size={13} className="text-emerald-400" />
                      <Badge color="verde">{r.lineas} líneas</Badge>
                    </span>
                  ) : (
                    <Badge color="gris">aceptado pero vacío</Badge>
                  )}
                </div>

                {r.rechazo ? (
                  <p className="px-3 py-2 text-xs text-rose-300/80">{r.rechazo}</p>
                ) : (
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-400">
                    {r.salida?.trim() || '(sin salida)'}
                  </pre>
                )}
              </div>
            ))}

            <Aviso tipo="alerta">
              Si alguno trajo la tabla que buscabas, copiá la salida y pedime que escriba el
              lector. Con el texto real a la vista el parser sale bien a la primera; sin él, sale
              dos veces.
            </Aviso>
          </>
        )}
      </div>
    </Card>
  )
}
