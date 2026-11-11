import { useState } from 'react'
import { FileUp, Undo2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { ETIQUETA, clasificar, leerPlacemarks, textoKml } from '../../lib/kmz'
import { Aviso, Button, Field, Input, Modal } from '../ui'

/**
 * Importar un KMZ o KML de Google Earth a la planta externa (migración 234).
 *
 * Se lee y se clasifica en el navegador, se muestra lo que va a entrar —con lo
 * que hay que revisar— y recién al confirmar se manda a la base, de una sola
 * vez. Todo entra como "importado": no verificado.
 */
export default function ImportarKmz({ abierto, importaciones = [], onCerrar, onImportado }) {
  const [archivo, setArchivo] = useState(null)
  const [placemarks, setPlacemarks] = useState(null)
  const [unir, setUnir] = useState(true)
  const [vano, setVano] = useState(150)
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [hecho, setHecho] = useState(null)

  const r = placemarks ? clasificar(placemarks, { unirTendidos: unir, vanoMaximo: Number(vano) || 150 }) : null

  async function leer(f) {
    setError(null)
    setHecho(null)
    setArchivo(f)
    setPlacemarks(null)
    if (!f) return
    try {
      const texto = await textoKml(f.name, await f.arrayBuffer())
      setPlacemarks(leerPlacemarks(texto))
    } catch (e) {
      setError(e.message)
    }
  }

  async function importar() {
    setEnviando(true)
    setError(null)
    const { data, error: e } = await supabase.rpc('importar_planta', {
      p_archivo: archivo.name,
      p_elementos: r.elementos,
      p_cables: r.cables,
      p_resumen: r.resumen,
    })
    setEnviando(false)
    if (e) return setError(e.message)
    setHecho(`Listo: entraron ${r.elementos.length} elementos y ${r.cables.length} cables.`)
    setPlacemarks(null)
    setArchivo(null)
    onImportado?.(data)
  }

  async function deshacer(imp) {
    if (!window.confirm(`¿Deshacer la importación de "${imp.archivo}"? Se borra lo que todavía no se verificó.`)) return
    const { data, error: e } = await supabase.rpc('deshacer_importacion_planta', { p_id: imp.id })
    if (e) return setError(e.message)
    setHecho(`Se sacaron ${data.elementos} elementos y ${data.cables} cables. Lo verificado se quedó.`)
    onImportado?.()
  }

  return (
    <Modal abierto={abierto} titulo="Importar KMZ / KML" onCerrar={onCerrar} ancho="max-w-2xl">
      <div className="space-y-4">
        <Aviso>
          Todo entra como <b>importado (sin verificar)</b>. Lo raro —sin nombre, repetido, lejos del resto, rutas armadas
          uniendo postes— queda en “A revisar”. Nada se descarta.
        </Aviso>
        <Field label="Archivo de Google Earth (.kmz o .kml)">
          <Input type="file" accept=".kmz,.kml" onChange={(e) => leer(e.target.files?.[0] ?? null)} />
        </Field>

        {r && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Object.entries(r.resumen.elementos).map(([t, n]) => (
                <div key={t} className="rounded-lg border border-slate-800 p-2 text-center">
                  <p className="text-lg font-bold text-slate-100">{n}</p>
                  <p className="text-[11px] text-slate-500">{ETIQUETA[t]}</p>
                </div>
              ))}
              <div className="rounded-lg border border-slate-800 p-2 text-center">
                <p className="text-lg font-bold text-slate-100">{r.cables.length}</p>
                <p className="text-[11px] text-slate-500">Cables · {(r.resumen.metros / 1000).toFixed(1)} km</p>
              </div>
            </div>
            <label className="flex flex-wrap items-center gap-2 text-[12px] text-slate-300">
              <input type="checkbox" checked={unir} onChange={(e) => setUnir(e.target.checked)} />
              Armar la ruta del cable en las carpetas marcadas poste por poste (A, J…), cortando si dos postes están a
              más de
              <input
                type="number"
                min="30"
                value={vano}
                onChange={(e) => setVano(e.target.value)}
                className="w-16 rounded border border-slate-700 bg-white px-1 text-slate-100"
              />
              m
              {unir && r.resumen.tendidos > 0 && <span className="text-sky-400">({r.resumen.tendidos} tramos)</span>}
            </label>
            {r.resumen.revisar > 0 && (
              <p className="text-[12px] text-amber-400">{r.resumen.revisar} cosas para revisar después de importar.</p>
            )}
            <Button variante="primario" icon={FileUp} cargando={enviando} onClick={importar}>
              Importar
            </Button>
          </div>
        )}

        {error && <p className="text-sm text-rose-400">{error}</p>}
        {hecho && <p className="text-sm text-emerald-400">{hecho}</p>}

        {importaciones.length > 0 && (
          <div className="border-t border-slate-800 pt-3">
            <p className="mb-2 text-xs font-semibold text-slate-400">Importaciones anteriores</p>
            <ul className="space-y-1.5">
              {importaciones.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-[12px]">
                  <span className="flex-1 text-slate-300">
                    {i.archivo} · {new Date(i.creado_at).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' })}
                    {i.deshecha_at && <span className="text-slate-500"> · deshecha</span>}
                  </span>
                  {!i.deshecha_at && (
                    <Button variante="fantasma" icon={Undo2} onClick={() => deshacer(i)}>
                      Deshacer
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
