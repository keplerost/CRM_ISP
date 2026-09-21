import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { AlertTriangle, ArrowRight, Link2, UserPlus } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Cargando, ErrorBanner, Table } from '../ui'

/**
 * Asistente de enlace entre ONTs y abonados.
 *
 * Enlazar y crear son dos botones distintos a propósito: enlazar es reversible y
 * barato, dar de alta ochenta fichas de abonado no lo es.
 *
 * Lo ambiguo nunca se resuelve solo. Elegir entre dos homónimos significa que la
 * señal de uno aparece en la ficha del otro y que un corte por falta de pago le
 * cae al vecino.
 */
export default function EnlazarAbonados({ olt, onListo }) {
  const confirmar = useConfirmar()
  const [previa, setPrevia] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [trabajando, setTrabajando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      try {
        const r = await api.olt.abonados(olt.id)
        if (vivo) setPrevia(r)
      } catch (err) {
        if (vivo) setError(err)
      } finally {
        if (vivo) setCargando(false)
      }
    })()
    return () => {
      vivo = false
    }
  }, [olt.id])

  async function aplicar(crear) {
    if (
      crear &&
      !await confirmar(
        `Se van a crear ${previa.a_crear} fichas de abonado.\n\n` +
          'Salen SIN plan y SIN identificación porque el equipo no los sabe: hasta que se los ' +
          'cargues no se les puede facturar ni aplicar velocidad.\n\n¿Continuar?',
      )
    ) {
      return
    }

    setTrabajando(true)
    setError(null)
    try {
      setResultado(await api.olt.enlazarAbonados(olt.id, { crear }))
      onListo?.()
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  if (cargando) return <Cargando texto="Comparando las ONTs con los abonados…" />

  if (resultado) {
    return (
      <div className="space-y-3">
        <Aviso>
          <b>{resultado.enlazados} enlaces</b> hechos
          {resultado.creados > 0 && <> y <b>{resultado.creados} fichas creadas</b></>}.
          {resultado.ambiguas_sin_tocar > 0 && (
            <> Quedaron {resultado.ambiguas_sin_tocar} para revisar a mano.</>
          )}
        </Aviso>
        {resultado.aviso && <Aviso tipo="alerta">{resultado.aviso}</Aviso>}
        {resultado.errores?.length > 0 && (
          <Aviso tipo="alerta">
            <ul className="space-y-0.5 font-mono text-[11px]">
              {resultado.errores.slice(0, 8).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Aviso>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {previa && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Ya enlazadas', previa.ya_enlazadas, 'text-slate-400'],
              ['Se pueden enlazar', previa.a_enlazar, 'text-emerald-400'],
              ['Para revisar', previa.ambiguas, 'text-amber-400'],
              ['Sin ficha', previa.a_crear, 'text-sky-400'],
            ].map(([etiqueta, valor, color]) => (
              <div key={etiqueta} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <p className={`text-xl font-semibold ${color}`}>{valor}</p>
                <p className="text-[11px] text-slate-500">{etiqueta}</p>
              </div>
            ))}
          </div>

          <Aviso>
            Dos nombres se consideran la misma persona cuando tienen <b>exactamente las mismas
            palabras</b>, en cualquier orden. No hay parecidos ni aproximaciones: «MORALES» no se
            enlaza con «MORALES GUAMAN KLEVER», y «PEÑA» no es «PENA». Equivocarse acá hace que un
            corte le caiga al vecino.
          </Aviso>

          {previa.enlaces?.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-400">
                Se van a enlazar
              </h4>
              <Table
                columnas={['Ubicación', 'Nombre en la OLT', '', 'Abonado', 'Coincidencia']}
                filas={previa.enlaces}
                renderFila={(e) => (
                  <tr key={e.sn} className="text-slate-300">
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{e.donde}</td>
                    <td className="px-3 py-2 text-xs">{e.nombre_en_la_olt}</td>
                    <td className="px-1 py-2">
                      <ArrowRight size={12} className="text-slate-600" />
                    </td>
                    <td className="px-3 py-2 text-slate-100">{e.cliente}</td>
                    <td className="px-3 py-2">
                      <Badge color={e.coincidencia === 'exacto' ? 'verde' : 'azul'}>
                        {e.coincidencia === 'exacto' ? 'idéntico' : 'mismas palabras'}
                      </Badge>
                    </td>
                  </tr>
                )}
              />
            </div>
          )}

          {previa.revisar?.length > 0 && (
            <div>
              <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
                <AlertTriangle size={13} />
                Hay que decidir a mano
              </h4>
              <Table
                columnas={['Ubicación', 'Nombre en la OLT', 'Por qué', 'Candidatos']}
                filas={previa.revisar}
                renderFila={(r) => (
                  <tr key={r.sn} className="text-slate-300">
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.donde}</td>
                    <td className="px-3 py-2 text-xs">{r.nombre_en_la_olt}</td>
                    <td className="px-3 py-2 text-xs text-amber-300/80">{r.motivo}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.candidatos?.map((c) => (
                        <div key={c.id}>
                          {c.nombre}
                          {c.identificacion && (
                            <span className="ml-1 text-slate-600">· {c.identificacion}</span>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              />
            </div>
          )}

          {previa.sin_abonado?.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-sky-400">
                Sin ficha de abonado
                {previa.a_crear > previa.sin_abonado.length && (
                  <span className="font-normal normal-case text-slate-500">
                    {' '}
                    (muestra de {previa.sin_abonado.length} de {previa.a_crear})
                  </span>
                )}
              </h4>
              <Table
                columnas={['Ubicación', 'Serie', 'Nombre en la OLT', 'Por qué']}
                filas={previa.sin_abonado}
                renderFila={(s) => (
                  <tr key={s.sn} className="text-slate-300">
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{s.donde}</td>
                    <td className="px-3 py-2 font-mono text-xs">{s.sn}</td>
                    <td className="px-3 py-2 text-xs text-slate-100">{s.nombre_en_la_olt ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{s.motivo}</td>
                  </tr>
                )}
              />
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-3">
            <Button
              variante="primario"
              icon={Link2}
              onClick={() => aplicar(false)}
              cargando={trabajando}
              disabled={!previa.a_enlazar}
            >
              Enlazar {previa.a_enlazar || ''}
            </Button>
            <Button
              variante="exito"
              icon={UserPlus}
              onClick={() => aplicar(true)}
              cargando={trabajando}
              disabled={!previa.a_crear && !previa.a_enlazar}
            >
              Enlazar y crear {previa.a_crear} fichas
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
