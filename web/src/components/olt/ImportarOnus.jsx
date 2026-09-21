import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, Download, Check } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Cargando, ErrorBanner, Table } from '../ui'

/**
 * Asistente de importación de ONUs.
 *
 * Dos pasos siempre: primero muestra qué va a pasar, después lo hace. Traer
 * ochenta fichas sin poder mirarlas antes es la clase de operación que se
 * lamenta después, y el paso de revisión cuesta un clic.
 */
export default function ImportarOnus({ olt, onListo }) {
  const [previa, setPrevia] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [aplicando, setAplicando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      try {
        const r = await api.olt.inventario(olt.id)
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

  async function aplicar() {
    setAplicando(true)
    setError(null)
    try {
      const r = await api.olt.importarOnus(olt.id)
      setResultado(r)
      onListo?.()
    } catch (err) {
      setError(err)
    } finally {
      setAplicando(false)
    }
  }

  if (cargando) return <Cargando texto="Leyendo el inventario del equipo…" />

  if (resultado) {
    return (
      <div className="space-y-3">
        <Aviso>
          <b>{resultado.insertadas} ONUs nuevas</b> y {resultado.actualizadas} actualizadas.
          {resultado.sobrantes_no_tocadas > 0 && (
            <>
              {' '}
              Quedaron {resultado.sobrantes_no_tocadas} en la base que el equipo ya no reporta —
              no se tocaron.
            </>
          )}
        </Aviso>
        {resultado.errores?.length > 0 && (
          <Aviso tipo="alerta">
            {resultado.errores.length} fallaron:
            <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
              {resultado.errores.slice(0, 8).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Aviso>
        )}
      </div>
    )
  }

  const nada = previa && !previa.nuevas && !previa.mudadas

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {previa && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['En el equipo', previa.en_el_equipo, 'text-slate-100'],
              ['Nuevas', previa.nuevas, 'text-emerald-400'],
              ['Cambiaron de puerto', previa.mudadas, 'text-amber-400'],
              ['Ya estaban', previa.sin_cambios, 'text-slate-400'],
            ].map(([etiqueta, valor, color]) => (
              <div key={etiqueta} className="t-panel p-3">
                <p className={`text-xl font-semibold ${color}`}>{valor}</p>
                <p className="text-[11px] text-slate-500">{etiqueta}</p>
              </div>
            ))}
          </div>

          {nada ? (
            <Aviso>
              <span className="flex items-center gap-2">
                <Check size={14} />
                La base ya está al día con el equipo.
              </span>
            </Aviso>
          ) : (
            <Aviso>
              Se lee por SNMP en {(previa.ms / 1000).toFixed(1)} s. La descripción que tiene la OLT
              se desarma en nombre, dirección, zona y fecha de alta — mirá abajo cómo queda antes
              de aplicar.
            </Aviso>
          )}

          {previa.muestra_nuevas?.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Se van a dar de alta {previa.nuevas > previa.muestra_nuevas.length && (
                  <span className="font-normal normal-case text-slate-500">
                    (muestra de {previa.muestra_nuevas.length} de {previa.nuevas})
                  </span>
                )}
              </h4>
              <Table
                columnas={['Ubicación', 'Serie', 'Nombre', 'Dirección', 'Estado']}
                filas={previa.muestra_nuevas}
                renderFila={(o) => (
                  <tr key={o.sn} className="text-slate-300">
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{o.donde}</td>
                    <td className="px-3 py-2 font-mono text-xs">{o.sn}</td>
                    <td className="px-3 py-2">
                      <span className="text-slate-100">{o.nombre ?? '—'}</span>
                      {o.alta && <span className="ml-2 text-[10px] text-slate-600">alta {o.alta}</span>}
                      {/* El texto crudo es lo único que permite ver si el
                          desarmado cortó un nombre por la mitad. */}
                      {o.descripcion_cruda && o.descripcion_cruda !== o.nombre && (
                        <p className="mt-0.5 truncate text-[10px] text-slate-600" title={o.descripcion_cruda}>
                          {o.descripcion_cruda}
                        </p>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-xs text-slate-400">
                      {o.direccion ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge color={o.estado === 'online' ? 'verde' : 'gris'}>{o.estado}</Badge>
                    </td>
                  </tr>
                )}
              />
            </div>
          )}

          {previa.muestra_mudadas?.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
                Cambiaron de puerto
              </h4>
              <Table
                columnas={['Serie', 'Estaba en', '', 'Está en', 'Nombre']}
                filas={previa.muestra_mudadas}
                renderFila={(o) => (
                  <tr key={o.sn} className="text-slate-300">
                    <td className="px-3 py-2 font-mono text-xs">{o.sn}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">
                      {o.antes.slot}/{o.antes.puerto}/{o.antes.onu_index}
                    </td>
                    <td className="px-1 py-2">
                      <ArrowRight size={12} className="text-slate-600" />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-amber-300">{o.donde}</td>
                    <td className="px-3 py-2 text-xs">{o.nombre ?? '—'}</td>
                  </tr>
                )}
              />
            </div>
          )}

          {previa.sobrantes?.length > 0 && (
            <Aviso tipo="alerta">
              <span className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  <b>{previa.sobrantes.length} ONUs están en la base y el equipo no las reporta.</b>{' '}
                  No se van a borrar: puede ser un abonado que desenchufó el equipo, y con la fila se
                  iría su ficha entera. Revisalas a mano.
                  <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] opacity-80">
                    {previa.sobrantes.slice(0, 8).map((s) => (
                      <li key={s.sn}>
                        {s.sn} · {s.donde} · {s.nombre ?? 'sin nombre'}
                      </li>
                    ))}
                  </ul>
                </span>
              </span>
            </Aviso>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
            <Button
              variante="primario"
              icon={Download}
              onClick={aplicar}
              cargando={aplicando}
              disabled={nada}
            >
              {nada ? 'No hay nada que importar' : `Importar ${previa.nuevas + previa.mudadas}`}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
