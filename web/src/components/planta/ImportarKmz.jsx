import { useState } from 'react'
import { Download, FileUp, Undo2 } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { ETIQUETA, clasificar, leerPlacemarks, textoKml } from '../../lib/kmz'
import { armarPlantilla, filasAPlacemarks, leerHoja } from '../../lib/hojaPlanta'
import { Aviso, Button, Field, Input, Modal } from '../ui'

/**
 * Importar un KMZ o KML de Google Earth a la planta externa (migración 234),
 * o una planilla de Excel / CSV con coordenadas (con su plantilla para bajar).
 * La planilla se convierte en los mismos placemarks que un KMZ y pasa por la
 * misma clasificación.
 *
 * Se lee y se clasifica en el navegador, se muestra lo que va a entrar —con lo
 * que hay que revisar— y recién al confirmar se manda a la base, de una sola
 * vez. Todo entra como "importado": no verificado.
 */
export default function ImportarKmz({ abierto, importaciones = [], onCerrar, onImportado }) {
  const [archivo, setArchivo] = useState(null)
  const [placemarks, setPlacemarks] = useState(null)
  const [hoja, setHoja] = useState(null) // { filas, nombre } de un Excel / CSV
  const [zonaUtm, setZonaUtm] = useState(17)
  const [sur, setSur] = useState(true)
  const [unir, setUnir] = useState(true)
  const [vano, setVano] = useState(150)
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [hecho, setHecho] = useState(null)

  let lectura = null
  let errorHoja = null
  if (hoja) {
    try {
      lectura = filasAPlacemarks(hoja.filas, { carpeta: hoja.carpeta, zonaUtm: Number(zonaUtm) || 17, sur })
    } catch (e) {
      errorHoja = e.message
    }
  }
  const puntos = hoja ? (lectura?.placemarks.length ? lectura.placemarks : null) : placemarks
  const r = puntos ? clasificar(puntos, { unirTendidos: unir, vanoMaximo: Number(vano) || 150 }) : null

  async function leer(f) {
    setError(null)
    setHecho(null)
    setArchivo(f)
    setPlacemarks(null)
    setHoja(null)
    if (!f) return
    try {
      if (/\.(xlsx|xlsm|xls|csv|txt|tsv)$/i.test(f.name)) {
        const { filas, hoja: nombreHoja } = await leerHoja(f.name, await f.arrayBuffer())
        setHoja({ filas, nombre: nombreHoja, carpeta: f.name.replace(/\.[^.]+$/, '') })
        return
      }
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
    setHoja(null)
    setArchivo(null)
    onImportado?.(data)
  }

  function bajarPlantilla() {
    const blob = new Blob([armarPlantilla()], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'plantilla-posteria.xlsx'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function deshacer(imp) {
    if (!window.confirm(`¿Deshacer la importación de "${imp.archivo}"? Se borra lo que todavía no se verificó.`)) return
    const { data, error: e } = await supabase.rpc('deshacer_importacion_planta', { p_id: imp.id })
    if (e) return setError(e.message)
    setHecho(`Se sacaron ${data.elementos} elementos y ${data.cables} cables. Lo verificado se quedó.`)
    onImportado?.()
  }

  return (
    <Modal abierto={abierto} titulo="Importar KMZ, KML o Excel" onCerrar={onCerrar} ancho="max-w-2xl">
      <div className="space-y-4">
        <Aviso>
          Todo entra como <b>importado (sin verificar)</b>. Lo raro —sin nombre, repetido, lejos del resto, rutas armadas
          uniendo postes— queda en “A revisar”. Nada se descarta.
        </Aviso>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 p-3">
          <p className="flex-1 text-[12px] text-slate-400">
            ¿Tenés los postes en Excel? Bajá la plantilla, llenala (una fila por poste, con latitud y longitud) y subila
            acá. También sirve tu propia planilla si tiene columnas Latitud y Longitud.
          </p>
          <Button variante="secundario" icon={Download} onClick={bajarPlantilla}>
            Descargar plantilla Excel
          </Button>
        </div>
        <Field label="Archivo de Google Earth (.kmz, .kml) o planilla (.xlsx, .csv)">
          <Input
            type="file"
            accept=".kmz,.kml,.xlsx,.xlsm,.csv"
            onChange={(e) => leer(e.target.files?.[0] ?? null)}
          />
        </Field>

        {hoja && errorHoja && <p className="text-sm text-rose-400">{errorHoja}</p>}
        {lectura && (
          <div className="space-y-2 text-[12px]">
            <p className="text-slate-400">
              {hoja.nombre && <>Hoja “{hoja.nombre}” · </>}
              {lectura.placemarks.length} filas con ubicación
              {lectura.encabezado.ignoradas.length > 0 && (
                <> · columnas que no se usan: {lectura.encabezado.ignoradas.join(', ')}</>
              )}
            </p>
            {lectura.usaUtm && (
              <label className="flex flex-wrap items-center gap-2 text-slate-300">
                Coordenadas en UTM: zona
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={zonaUtm}
                  onChange={(e) => setZonaUtm(e.target.value)}
                  className="w-14 rounded border border-slate-700 bg-white px-1 text-slate-100"
                />
                <select
                  value={sur ? 'S' : 'N'}
                  onChange={(e) => setSur(e.target.value === 'S')}
                  className="rounded border border-slate-700 bg-white px-1 text-slate-100"
                >
                  <option value="S">Sur</option>
                  <option value="N">Norte</option>
                </select>
                <span className="text-slate-500">(Ecuador continental: 17 Sur)</span>
              </label>
            )}
            {lectura.sinUbicar.length > 0 && (
              <div className="rounded-lg border border-amber-900/60 p-2 text-amber-400">
                <p className="font-semibold">
                  {lectura.sinUbicar.length} filas no entran porque no tienen coordenadas válidas:
                </p>
                <ul className="mt-1 max-h-28 overflow-y-auto">
                  {lectura.sinUbicar.map((x) => (
                    <li key={x.fila}>
                      Fila {x.fila}
                      {x.nombre && ` (${x.nombre})`}: {x.motivo}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {lectura.placemarks.length === 0 && (
              <p className="text-rose-400">Ninguna fila tiene coordenadas: no hay nada para importar.</p>
            )}
          </div>
        )}

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
