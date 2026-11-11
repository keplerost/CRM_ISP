import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { AlertTriangle, Download, FileUp, Layers, Pencil, Plus, Search, X } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { ETIQUETA, armarKmz, largoRuta } from '../../lib/kmz'
import { DASH, ESTILOS_BASE, esVisible, kmlColor, resolverEstilo } from '../../lib/planta'
import { Button, ErrorBanner, Select } from '../../components/ui'
import ImportarKmz from '../../components/planta/ImportarKmz'
import EditorEstilo from '../../components/planta/EditorEstilo'
import FichaPlanta, { TIPOS_CABLE } from '../../components/planta/FichaPlanta'

/**
 * La planta externa en el mapa (migraciones 234 y 235): nodos, postes, cajas
 * NAP, mangas, reservas y cables, con capas propias, estilos editables,
 * búsqueda, edición, importación de KMZ y exportación para Google Earth.
 *
 * ── El estilo ──
 *
 * Cada cosa se dibuja con lo más específico que tenga: su color o grosor
 * propio, si no el de su capa ("Feeder principal"), si no el de su tipo. Los
 * tres se editan desde esta pantalla (`lib/planta.js`).
 *
 * ── Qué tan confiable es lo que se ve ──
 *
 *   · relleno tenue      importado de un KMZ, nadie lo verificó
 *   · relleno lleno      cargado o revisado en la oficina
 *   · borde verde        verificado en campo (obra o mapeo)
 *   · borde ámbar        tiene algo para revisar
 *   · línea punteada     proyectado (todavía no existe)
 *
 * Todos los puntos llevan un borde blanco fino: los postes de un tendido están
 * justo encima de la línea del cable, y sin ese borde la línea se los comía.
 */

const CENTRO = [-0.93, -79.22]
const TIPOS_E = Object.keys(ETIQUETA)

export default function PlantaExternaPage() {
  const { puede } = usePermisos()
  const edita = puede('red.planta')
  const [elementos, setElementos] = useState(null)
  const [cables, setCables] = useState([])
  const [abonados, setAbonados] = useState([])
  const [importaciones, setImportaciones] = useState([])
  const [capasLista, setCapasLista] = useState([])
  const [estilos, setEstilos] = useState({})
  const [error, setError] = useState(null)
  // Los interruptores: 'e:nap', 'c:troncal', 'k:<capa>', proyectado, abonados.
  const [sw, setSw] = useState({ proyectado: true, abonados: false })
  const [soloRevisar, setSoloRevisar] = useState(false)
  const [base, setBase] = useState('calles')
  const [sel, setSel] = useState(null) // { clase: 'e'|'c', id }
  const [modo, setModo] = useState(null) // { accion: 'punto'|'cable'|'mover'|'ruta', tipo?, id?, puntos? }
  const [busqueda, setBusqueda] = useState('')
  const [panel, setPanel] = useState('capas')
  // El tamaño de los puntos acompaña el zoom: de lejos no tapan, de cerca se tocan.
  const [zoom, setZoom] = useState(14)
  const [importar, setImportar] = useState(false)
  const [editor, setEditor] = useState(null)

  const capas = useMemo(() => new Map(capasLista.map((c) => [c.id, c])), [capasLista])

  const recargar = useCallback(async () => {
    const [e, c, a, i, k, s] = await Promise.all([
      supabase.from('v_planta_elementos').select('*').neq('estado', 'retirado'),
      supabase.from('planta_cables').select('*').neq('estado', 'retirado'),
      supabase.from('clientes').select('id,nombre,latitud,longitud,nap_id,puerto_nap').not('latitud', 'is', null),
      supabase.from('planta_importaciones').select('*').order('creado_at', { ascending: false }),
      // Sin la 235 no hay capas ni estilos: el mapa usa los de siempre.
      supabase.from('planta_capas').select('*').order('orden').order('nombre'),
      supabase.from('planta_estilos').select('*'),
    ])
    setError(e.error ?? c.error ?? null)
    setElementos(e.data ?? [])
    setCables(c.data ?? [])
    setAbonados(a.data ?? [])
    setImportaciones(i.data ?? [])
    setCapasLista(k.error ? [] : (k.data ?? []))
    setEstilos(s.error ? {} : Object.fromEntries((s.data ?? []).map((x) => [x.clave, x])))
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Una capa nueva entra con el interruptor que dice ella.
  useEffect(() => {
    setSw((v) => {
      const n = { ...v }
      for (const c of capasLista) if (n[`k:${c.id}`] === undefined) n[`k:${c.id}`] = c.visible
      return n
    })
  }, [capasLista])

  const estiloDe = useCallback((x, clase) => resolverEstilo(x, clase, { capas, estilos }), [capas, estilos])

  // ── El mapa ──
  const cont = useRef(null)
  const mapa = useRef(null)
  const capaDatos = useRef(null)
  const capaBorrador = useRef(null)
  const bases = useRef({})
  const modoRef = useRef(modo)
  modoRef.current = modo

  useEffect(() => {
    if (mapa.current || !cont.current) return
    const m = L.map(cont.current, { preferCanvas: true }).setView(CENTRO, 14)
    bases.current = {
      calles: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 20,
        maxNativeZoom: 19,
      }),
      satelite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Imágenes © Esri',
        maxZoom: 20,
        maxNativeZoom: 19,
      }),
    }
    bases.current.calles.addTo(m)
    capaDatos.current = L.layerGroup().addTo(m)
    capaBorrador.current = L.layerGroup().addTo(m)
    m.on('click', (ev) => clicMapa.current?.(ev.latlng))
    m.on('dblclick', () => terminarCable.current?.())
    m.doubleClickZoom.disable()
    m.on('zoomend', () => setZoom(m.getZoom()))
    mapa.current = m
    return () => {
      m.remove()
      mapa.current = null
    }
  }, [])

  useEffect(() => {
    const m = mapa.current
    if (!m) return
    for (const [k, t] of Object.entries(bases.current)) {
      if (k === base) t.addTo(m)
      else m.removeLayer(t)
    }
  }, [base])

  // Encuadrar la red la primera vez que llega.
  const encuadrado = useRef(false)
  useEffect(() => {
    if (encuadrado.current || !elementos?.length || !mapa.current) return
    const pts = elementos.filter((e) => !e.revisar?.some((r) => /km del resto/.test(r))).map((e) => [e.latitud, e.longitud])
    if (pts.length) mapa.current.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 })
    encuadrado.current = true
  }, [elementos])

  const visibleE = useCallback(
    (e) => esVisible(e, 'e', sw, capas) && (sw.proyectado || e.estado !== 'proyectado') && (!soloRevisar || e.revisar?.length),
    [sw, capas, soloRevisar],
  )
  const visibleC = useCallback(
    (c) => esVisible(c, 'c', sw, capas) && (sw.proyectado || c.estado !== 'proyectado') && (!soloRevisar || c.revisar?.length),
    [sw, capas, soloRevisar],
  )

  // Dibujar los datos.
  useEffect(() => {
    const g = capaDatos.current
    if (!g || !elementos) return
    g.clearLayers()
    const napPorId = new Map(elementos.filter((e) => e.punto_id).map((e) => [e.punto_id, e]))

    for (const c of cables) {
      if (!visibleC(c)) continue
      const st = estiloDe(c, 'c')
      const elegido = sel?.clase === 'c' && sel.id === c.id
      L.polyline(c.ruta, {
        color: st.color,
        weight: st.tamano + (elegido ? 3 : 0),
        opacity: st.opacidad * (c.verificacion === 'importado' ? 0.8 : 1),
        // Lo proyectado va siempre punteado: es lo que no existe todavía.
        dashArray: c.estado === 'proyectado' && st.linea === 'solida' ? DASH.rayada : DASH[st.linea],
        lineCap: 'round',
      })
        .bindTooltip(`${c.nombre} · ${TIPOS_CABLE[c.tipo]}${c.hilos ? ` ${c.hilos}h` : ''} · ${Math.round(c.longitud_m ?? 0)} m`, {
          sticky: true,
        })
        .on('click', (ev) => {
          L.DomEvent.stopPropagation(ev)
          if (!modoRef.current) setSel({ clase: 'c', id: c.id })
        })
        .addTo(g)
    }

    if (sw.abonados) {
      for (const a of abonados) {
        const nap = a.nap_id ? napPorId.get(a.nap_id) : null
        L.circleMarker([a.latitud, a.longitud], { radius: 3, color: nap ? '#10b981' : '#ef4444', weight: 1, fillOpacity: 0.8 })
          .bindTooltip(`${a.nombre}${nap ? ` · ${nap.nombre}${a.puerto_nap ? ` p${a.puerto_nap}` : ''}` : ' · sin caja'}`)
          .addTo(g)
        if (nap) L.polyline([[a.latitud, a.longitud], [nap.latitud, nap.longitud]], { color: '#10b981', weight: 1, opacity: 0.5 }).addTo(g)
      }
    }

    const ajuste = zoom >= 17 ? 2 : zoom <= 13 ? -1.5 : 0
    for (const e of elementos) {
      if (!visibleE(e)) continue
      const st = estiloDe(e, 'e')
      const elegido = sel?.clase === 'e' && sel.id === e.id
      const revisar = e.revisar?.length > 0
      L.circleMarker([e.latitud, e.longitud], {
        radius: Math.max(2.5, st.tamano + ajuste) + (elegido ? 3 : 0),
        color: elegido ? '#0f172a' : revisar ? '#f59e0b' : e.verificacion === 'campo' ? '#16a34a' : '#ffffff',
        weight: elegido ? 3 : revisar || e.verificacion === 'campo' ? 2.5 : 1.2,
        fillColor: st.color,
        fillOpacity: st.opacidad * (e.verificacion === 'importado' ? 0.75 : 1),
        dashArray: e.estado === 'proyectado' ? '3 3' : null,
      })
        .bindTooltip(
          `${e.nombre}${e.tipo === 'nap' && e.capacidad ? ` · ${e.abonados ?? 0}/${e.capacidad}` : ''}${
            e.tipo === 'poste' && e.herraje ? ` · ${e.herraje}` : ''
          }`,
        )
        .on('click', (ev) => {
          L.DomEvent.stopPropagation(ev)
          if (modoRef.current?.accion === 'cable' || modoRef.current?.accion === 'ruta')
            return clicMapa.current?.(L.latLng(e.latitud, e.longitud), e)
          if (!modoRef.current) setSel({ clase: 'e', id: e.id })
        })
        .addTo(g)
    }
  }, [elementos, cables, abonados, sw.abonados, visibleE, visibleC, sel, zoom, estiloDe])

  // El borrador de lo que se está dibujando.
  useEffect(() => {
    const g = capaBorrador.current
    if (!g) return
    g.clearLayers()
    if (modo?.puntos?.length) {
      L.polyline(modo.puntos, { color: '#0f172a', weight: 3, dashArray: '6 4' }).addTo(g)
      for (const p of modo.puntos) L.circleMarker(p, { radius: 4, color: '#0f172a', fillOpacity: 1 }).addTo(g)
    }
    if (mapa.current) mapa.current.getContainer().style.cursor = modo ? 'crosshair' : ''
  }, [modo])

  // ── Acciones sobre el mapa ──
  const clicMapa = useRef(null)
  const terminarCable = useRef(null)

  async function insertar(tabla, fila) {
    const { data, error: e } = await supabase.from(tabla).insert(fila).select('id').single()
    if (e) {
      setError(e)
      return null
    }
    await recargar()
    return data.id
  }

  clicMapa.current = async (latlng, sobre = null) => {
    const m = modoRef.current
    if (!m) return
    const p = [round7(latlng.lat), round7(latlng.lng)]
    if (m.accion === 'punto') {
      setModo(null)
      const id = await insertar('planta_elementos', {
        tipo: m.tipo,
        nombre: `${ETIQUETA[m.tipo]} nueva`,
        latitud: p[0],
        longitud: p[1],
        capacidad: m.tipo === 'nap' ? 16 : null,
        capa_id: m.capa_id ?? null,
      })
      if (id) setSel({ clase: 'e', id })
    } else if (m.accion === 'cable' || m.accion === 'ruta') {
      const primero = !m.puntos?.length
      setModo({ ...m, puntos: [...(m.puntos ?? []), p], desde: primero ? (sobre?.id ?? null) : m.desde, hasta: sobre?.id ?? null })
    } else if (m.accion === 'mover') {
      setModo(null)
      const { error: e } = await supabase.from('planta_elementos').update({ latitud: p[0], longitud: p[1] }).eq('id', m.id)
      if (e) setError(e)
      recargar()
    }
  }

  terminarCable.current = async () => {
    const m = modoRef.current
    if (!m || (m.accion !== 'cable' && m.accion !== 'ruta')) return
    if ((m.puntos?.length ?? 0) < 2) return setModo(null)
    setModo(null)
    if (m.accion === 'ruta') {
      const { error: e } = await supabase.from('planta_cables').update({ ruta: m.puntos }).eq('id', m.id)
      if (e) setError(e)
      return recargar()
    }
    const id = await insertar('planta_cables', {
      nombre: `Cable nuevo (${Math.round(largoRuta(m.puntos))} m)`,
      tipo: m.tipo ?? 'distribucion',
      hilos: m.tipo === 'drop' ? 2 : 12,
      ruta: m.puntos,
      desde_id: m.desde ?? null,
      hasta_id: m.hasta ?? null,
      capa_id: m.capa_id ?? null,
    })
    if (id) setSel({ clase: 'c', id })
  }

  // ── Lo que se muestra al costado ──
  const elegido = useMemo(() => {
    if (!sel) return null
    return sel.clase === 'e' ? elementos?.find((e) => e.id === sel.id) : cables.find((c) => c.id === sel.id)
  }, [sel, elementos, cables])

  const stats = useMemo(() => {
    const es = elementos ?? []
    const naps = es.filter((e) => e.tipo === 'nap')
    return {
      elementos: es.length,
      naps: naps.length,
      km: cables.filter((c) => c.estado === 'existente').reduce((s, c) => s + Number(c.longitud_m ?? 0), 0) / 1000,
      abonadosEnCaja: naps.reduce((s, n) => s + (n.abonados ?? 0), 0),
      sinVerificar: es.filter((e) => e.verificacion === 'importado').length,
      revisar: es.filter((e) => e.revisar?.length).length + cables.filter((c) => c.revisar?.length).length,
    }
  }, [elementos, cables])

  const resultados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    if (q.length < 2) return []
    return [
      ...(elementos ?? []).filter((e) => e.nombre.toLowerCase().includes(q)).map((e) => ({ ...e, clase: 'e' })),
      ...cables.filter((c) => c.nombre.toLowerCase().includes(q)).map((c) => ({ ...c, clase: 'c' })),
    ].slice(0, 12)
  }, [busqueda, elementos, cables])

  const porRevisar = useMemo(
    () => [
      ...(elementos ?? []).filter((e) => e.revisar?.length).map((e) => ({ ...e, clase: 'e' })),
      ...cables.filter((c) => c.revisar?.length).map((c) => ({ ...c, clase: 'c' })),
    ],
    [elementos, cables],
  )

  function ir(x) {
    setSel({ clase: x.clase, id: x.id })
    const m = mapa.current
    if (!m) return
    if (x.clase === 'e') m.setView([x.latitud, x.longitud], Math.max(m.getZoom(), 18))
    else m.fitBounds(L.latLngBounds(x.ruta), { maxZoom: 18, padding: [40, 40] })
  }

  function exportar() {
    const bytes = armarKmz({
      nombre: `Planta externa ${new Date().toLocaleDateString('es-EC')}`,
      elementos: (elementos ?? []).filter(visibleE),
      cables: cables.filter(visibleC),
      // Lo que se ve en el mapa es lo que se ve en Google Earth.
      estiloDe: (x, clase) => {
        const st = estiloDe(x, clase)
        return { color: kmlColor(st.color, st.opacidad), ancho: st.tamano }
      },
      carpetaDe: (x) => (x.capa_id ? (capas.get(x.capa_id)?.nombre ?? null) : null),
    })
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.google-earth.kmz' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `planta-externa-${new Date().toISOString().slice(0, 10)}.kmz`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const cuantos = (lista, pred) => lista.filter(pred).length
  const muestraTipo = (clave) => {
    const st = { ...ESTILOS_BASE[clave], ...estilos[clave] }
    return clave.startsWith('c:') ? (
      <span className="inline-block w-5 rounded" style={{ height: Math.min(8, Math.max(2, st.tamano)), background: st.color }} />
    ) : (
      <span className="inline-block h-3 w-3 rounded-full border border-white" style={{ background: st.color }} />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Planta externa</h1>
          <p className="text-[12px] text-slate-500">La red física en el mapa: postes, cajas, mangas, reservas y cables.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {edita && (
            <Button icon={FileUp} onClick={() => setImportar(true)}>
              Importar KMZ
            </Button>
          )}
          <Button icon={Download} onClick={exportar} disabled={!elementos?.length}>
            Exportar KMZ
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        {[
          ['Elementos', stats.elementos],
          ['Cajas NAP', stats.naps],
          ['Fibra existente', `${stats.km.toFixed(2)} km`],
          ['Abonados en caja', stats.abonadosEnCaja],
          ['Sin verificar', stats.sinVerificar],
          ['A revisar', stats.revisar],
        ].map(([l, v]) => (
          <div key={l} className="t-card px-3 py-2">
            <p className="text-[11px] text-slate-500">{l}</p>
            <p className="text-base font-bold text-slate-100">{v}</p>
          </div>
        ))}
      </div>

      {edita && (
        <div className="flex flex-wrap items-center gap-2">
          {modo ? (
            <>
              <span className="rounded-lg bg-sky-500/10 px-3 py-1.5 text-[12px] text-sky-300">
                {modo.accion === 'punto' && `Tocá el mapa donde va ${ETIQUETA[modo.tipo].toLowerCase()}.`}
                {modo.accion === 'mover' && 'Tocá el mapa en la nueva ubicación.'}
                {(modo.accion === 'cable' || modo.accion === 'ruta') &&
                  `Tocá cada punto del recorrido (${modo.puntos?.length ?? 0}). Doble clic o "Terminar" para cerrar. Tocar una caja la conecta.`}
              </span>
              {(modo.accion === 'cable' || modo.accion === 'ruta') && (
                <>
                  <Button
                    variante="fantasma"
                    disabled={!modo.puntos?.length}
                    onClick={() => setModo((m) => ({ ...m, puntos: m.puntos.slice(0, -1) }))}
                  >
                    Deshacer punto
                  </Button>
                  <Button variante="primario" onClick={() => terminarCable.current()} disabled={(modo.puntos?.length ?? 0) < 2}>
                    Terminar
                  </Button>
                </>
              )}
              <Button variante="fantasma" icon={X} onClick={() => setModo(null)}>
                Cancelar
              </Button>
            </>
          ) : (
            <>
              <span className="text-[12px] text-slate-500">Agregar:</span>
              {['nap', 'manga', 'poste', 'reserva', 'splitter', 'nodo'].map((t) => (
                <Button
                  key={t}
                  variante="fantasma"
                  icon={Plus}
                  onClick={() => {
                    setSel(null)
                    setModo({ accion: 'punto', tipo: t })
                  }}
                >
                  {ETIQUETA[t]}
                </Button>
              ))}
              <Select
                value=""
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  setSel(null)
                  // "capa:<id>" dibuja directo en esa capa, con su estilo.
                  if (v.startsWith('capa:')) {
                    setModo({ accion: 'cable', tipo: 'troncal', capa_id: v.slice(5), puntos: [] })
                  } else setModo({ accion: 'cable', tipo: v, puntos: [] })
                }}
                className="w-auto"
              >
                <option value="">+ Dibujar cable…</option>
                <optgroup label="Por tipo">
                  {Object.entries(TIPOS_CABLE).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </optgroup>
                {capasLista.some((c) => c.clase === 'cable') && (
                  <optgroup label="En la capa">
                    {capasLista
                      .filter((c) => c.clase === 'cable')
                      .map((c) => (
                        <option key={c.id} value={`capa:${c.id}`}>
                          {c.nombre}
                        </option>
                      ))}
                  </optgroup>
                )}
              </Select>
            </>
          )}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        {/* `isolate`: el selector Calles/Satélite (z-400) no tapa las ventanas. */}
        <div className="t-card relative isolate overflow-hidden">
          <div ref={cont} className="h-[68vh] min-h-[420px] w-full" />
          <div className="absolute right-3 top-3 z-[400] flex overflow-hidden rounded-lg border border-slate-300 bg-white text-[12px] shadow">
            {[
              ['calles', 'Calles'],
              ['satelite', 'Satélite'],
            ].map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setBase(k)}
                className={`px-3 py-1.5 ${base === k ? 'bg-sky-600 text-white' : 'text-slate-700'}`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <aside className="t-card space-y-3 p-3">
          <label className="flex items-center gap-2 rounded-lg border border-slate-700 px-2">
            <Search size={14} className="text-slate-500" />
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar caja, manga, cable…"
              className="w-full bg-transparent py-2 text-[13px] text-slate-100 outline-none"
            />
          </label>
          {resultados.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {resultados.map((x) => (
                <li key={`${x.clase}${x.id}`}>
                  <button type="button" onClick={() => ir(x)} className="w-full rounded px-2 py-1 text-left text-[12px] hover:bg-slate-800/40">
                    <span className="text-slate-200">{x.nombre}</span>{' '}
                    <span className="text-slate-500">· {x.clase === 'e' ? ETIQUETA[x.tipo] : TIPOS_CABLE[x.tipo]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {elegido ? (
            <FichaPlanta
              x={elegido}
              clase={sel.clase}
              edita={edita}
              elementos={elementos ?? []}
              capas={capas}
              estilos={estilos}
              onCerrar={() => setSel(null)}
              onCambio={recargar}
              onError={setError}
              onMover={() => setModo({ accion: 'mover', id: elegido.id })}
              onRuta={() => setModo({ accion: 'ruta', id: elegido.id, puntos: [] })}
            />
          ) : (
            <>
              <div className="flex gap-1 border-b border-slate-800">
                {[
                  ['capas', 'Capas', Layers],
                  ['revisar', `A revisar (${porRevisar.length})`, AlertTriangle],
                ].map(([k, l, I]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setPanel(k)}
                    className={`flex items-center gap-1.5 px-2 py-1.5 text-[12px] font-semibold ${
                      panel === k ? 'border-b-2 border-sky-500 text-sky-400' : 'text-slate-400'
                    }`}
                  >
                    <I size={13} /> {l}
                  </button>
                ))}
              </div>
              {panel === 'capas' ? (
                <div className="max-h-[56vh] space-y-3 overflow-y-auto pr-1 text-[12px]">
                  <Grupo
                    titulo="Mis capas"
                    accion={
                      edita && (
                        <button type="button" onClick={() => setEditor({ capa: { clase: 'cable' } })} className="text-sky-400">
                          + Nueva capa
                        </button>
                      )
                    }
                  >
                    {!capasLista.length && (
                      <p className="text-[11px] text-slate-500">
                        Todavía no hay. Creá, por ejemplo, “Feeder principal” en rojo y grueso, y pasale los cables.
                      </p>
                    )}
                    {capasLista.map((c) => (
                      <Interruptor
                        key={c.id}
                        activo={sw[`k:${c.id}`] !== false}
                        onCambio={(v) => setSw((x) => ({ ...x, [`k:${c.id}`]: v }))}
                        muestra={
                          c.clase === 'cable' ? (
                            <span className="inline-block w-5 rounded" style={{ height: Math.min(8, Math.max(2, c.tamano)), background: c.color }} />
                          ) : (
                            <span className="inline-block h-3 w-3 rounded-full border border-white" style={{ background: c.color }} />
                          )
                        }
                        etiqueta={`${c.nombre} (${cuantos(c.clase === 'cable' ? cables : (elementos ?? []), (x) => x.capa_id === c.id)})`}
                        onEditar={edita ? () => setEditor({ capa: c }) : null}
                      />
                    ))}
                  </Grupo>
                  <Grupo titulo="Puntos por tipo">
                    {TIPOS_E.map((t) => (
                      <Interruptor
                        key={t}
                        activo={sw[`e:${t}`] !== false}
                        onCambio={(v) => setSw((c) => ({ ...c, [`e:${t}`]: v }))}
                        muestra={muestraTipo(`e:${t}`)}
                        etiqueta={`${ETIQUETA[t]} (${cuantos(elementos ?? [], (e) => e.tipo === t && !(e.capa_id && capas.has(e.capa_id)))})`}
                        onEditar={edita ? () => setEditor({ tipo: `e:${t}`, estilo: { ...ESTILOS_BASE[`e:${t}`], ...estilos[`e:${t}`] } }) : null}
                      />
                    ))}
                  </Grupo>
                  <Grupo titulo="Cables por tipo">
                    {Object.entries(TIPOS_CABLE).map(([t, l]) => (
                      <Interruptor
                        key={t}
                        activo={sw[`c:${t}`] !== false}
                        onCambio={(v) => setSw((x) => ({ ...x, [`c:${t}`]: v }))}
                        muestra={muestraTipo(`c:${t}`)}
                        etiqueta={`${l} (${cuantos(cables, (x) => x.tipo === t && !(x.capa_id && capas.has(x.capa_id)))})`}
                        onEditar={edita ? () => setEditor({ tipo: `c:${t}`, estilo: { ...ESTILOS_BASE[`c:${t}`], ...estilos[`c:${t}`] } }) : null}
                      />
                    ))}
                  </Grupo>
                  <Grupo titulo="Mostrar">
                    <Interruptor activo={sw.proyectado} onCambio={(v) => setSw((c) => ({ ...c, proyectado: v }))} etiqueta="Proyectado" />
                    <Interruptor
                      activo={sw.abonados}
                      onCambio={(v) => setSw((c) => ({ ...c, abonados: v }))}
                      etiqueta={`Abonados (${abonados.length}): verde con caja, rojo sin caja`}
                    />
                    <Interruptor activo={soloRevisar} onCambio={setSoloRevisar} etiqueta="Solo lo que hay que revisar" />
                  </Grupo>
                  <p className="text-[11px] leading-snug text-slate-500">
                    Lo que está en una capa se prende y apaga con su capa; el resto, con su tipo. El lápiz cambia color y grosor.
                    Relleno tenue: importado sin verificar. Borde verde: verificado en campo. Borde ámbar: a revisar.
                  </p>
                </div>
              ) : (
                <ul className="max-h-[52vh] space-y-1 overflow-y-auto">
                  {!porRevisar.length && <li className="text-[12px] text-slate-500">Nada pendiente.</li>}
                  {porRevisar.map((x) => (
                    <li key={`${x.clase}${x.id}`}>
                      <button type="button" onClick={() => ir(x)} className="w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-slate-800/40">
                        <span className="text-slate-200">{x.nombre}</span>{' '}
                        <span className="text-slate-500">· {x.clase === 'e' ? ETIQUETA[x.tipo] : TIPOS_CABLE[x.tipo]}</span>
                        <span className="block text-amber-400">{x.revisar.join(' · ')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </aside>
      </div>

      {importar && (
        <ImportarKmz
          abierto
          importaciones={importaciones}
          onCerrar={() => setImportar(false)}
          onImportado={() => {
            encuadrado.current = false
            recargar()
          }}
        />
      )}

      {editor && (
        <EditorEstilo
          objetivo={editor}
          elementos={elementos ?? []}
          cables={cables}
          onCerrar={() => setEditor(null)}
          onGuardado={recargar}
          onError={setError}
        />
      )}
    </div>
  )
}

const round7 = (x) => Math.round(Number(x) * 1e7) / 1e7

function Grupo({ titulo, accion = null, children }) {
  return (
    <div>
      <p className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {titulo}
        {accion && <span className="normal-case tracking-normal">{accion}</span>}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Interruptor({ activo, onCambio, etiqueta, muestra = null, onEditar = null }) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex flex-1 cursor-pointer items-center gap-2 text-slate-300">
        <input type="checkbox" checked={Boolean(activo)} onChange={(e) => onCambio(e.target.checked)} />
        {muestra}
        {etiqueta}
      </label>
      {onEditar && (
        <button type="button" onClick={onEditar} className="text-slate-500 hover:text-sky-400" aria-label="Editar estilo">
          <Pencil size={12} />
        </button>
      )}
    </div>
  )
}
