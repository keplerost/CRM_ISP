import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { AlertTriangle, Download, FileUp, Layers, MapPin, Plus, Route, Search, X } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { ETIQUETA, armarKmz, largoRuta } from '../../lib/kmz'
import { Badge, Button, ErrorBanner, Field, Input, Select, Textarea } from '../../components/ui'
import ImportarKmz from '../../components/planta/ImportarKmz'

/**
 * La planta externa en el mapa (migración 234): nodos, postes, cajas NAP,
 * mangas, reservas y cables, con capas, búsqueda, edición, importación de
 * KMZ y exportación para Google Earth.
 *
 * ── Qué tan confiable es lo que se ve ──
 *
 *   · relleno tenue      importado de un KMZ, nadie lo verificó
 *   · relleno lleno      cargado o revisado en la oficina
 *   · borde blanco       verificado en campo (obra o mapeo)
 *   · borde ámbar        tiene algo para revisar
 *   · línea punteada     proyectado (todavía no existe)
 */

const COLOR = {
  nodo: '#dc2626',
  poste: '#94a3b8',
  nap: '#f59e0b',
  manga: '#9333ea',
  reserva: '#0d9488',
  splitter: '#0ea5e9',
  odf: '#334155',
  otro: '#64748b',
}
const RADIO = { nodo: 9, poste: 3, nap: 6, manga: 6, reserva: 5, splitter: 5, odf: 7, otro: 4 }
const CABLE = {
  troncal: { color: '#1d4ed8', peso: 5, label: 'Troncal' },
  feeder: { color: '#2563eb', peso: 4, label: 'Feeder' },
  distribucion: { color: '#16a34a', peso: 3, label: 'Distribución' },
  drop: { color: '#0891b2', peso: 2, label: 'Drop' },
  hilo: { color: '#f97316', peso: 2, label: 'Hilo' },
  otro: { color: '#64748b', peso: 2, label: 'Otro' },
}
const COLOR_HILO = {
  azul: '#2563eb', naranja: '#f97316', verde: '#16a34a', cafe: '#92400e', gris: '#6b7280', blanco: '#e5e7eb',
  rojo: '#dc2626', negro: '#111827', amarillo: '#eab308', violeta: '#7c3aed', rosado: '#ec4899', aqua: '#06b6d4',
  turquesa: '#14b8a6',
}
const VERIF = { importado: 'Importado (sin verificar)', oficina: 'Revisado en oficina', campo: 'Verificado en campo' }
const ESTADO = { existente: 'Existente', proyectado: 'Proyectado', retirado: 'Retirado' }
const CAPAS_INICIALES = {
  ...Object.fromEntries(Object.keys(COLOR).map((t) => [`e:${t}`, true])),
  ...Object.fromEntries(Object.keys(CABLE).map((t) => [`c:${t}`, true])),
  proyectado: true,
  abonados: false,
}
const CENTRO = [-0.93, -79.22]

export default function PlantaExternaPage() {
  const { puede } = usePermisos()
  const edita = puede('red.planta')
  const [elementos, setElementos] = useState(null)
  const [cables, setCables] = useState([])
  const [abonados, setAbonados] = useState([])
  const [importaciones, setImportaciones] = useState([])
  const [error, setError] = useState(null)
  const [capas, setCapas] = useState(CAPAS_INICIALES)
  const [soloRevisar, setSoloRevisar] = useState(false)
  const [base, setBase] = useState('calles')
  const [sel, setSel] = useState(null) // { clase: 'e'|'c', id }
  const [modo, setModo] = useState(null) // { accion: 'punto'|'cable'|'mover'|'ruta', tipo?, id?, puntos? }
  const [busqueda, setBusqueda] = useState('')
  const [panel, setPanel] = useState('capas')
  const [importar, setImportar] = useState(false)

  const recargar = useCallback(async () => {
    const [e, c, a, i] = await Promise.all([
      supabase.from('v_planta_elementos').select('*').neq('estado', 'retirado'),
      supabase.from('planta_cables').select('*').neq('estado', 'retirado'),
      supabase.from('clientes').select('id,nombre,latitud,longitud,nap_id,puerto_nap').not('latitud', 'is', null),
      supabase.from('planta_importaciones').select('*').order('creado_at', { ascending: false }),
    ])
    setError(e.error ?? c.error ?? null)
    setElementos(e.data ?? [])
    setCables(c.data ?? [])
    setAbonados(a.data ?? [])
    setImportaciones(i.data ?? [])
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

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
      calles: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 20, maxNativeZoom: 19 }),
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
    (e) => capas[`e:${e.tipo}`] && (capas.proyectado || e.estado !== 'proyectado') && (!soloRevisar || e.revisar?.length),
    [capas, soloRevisar],
  )
  const visibleC = useCallback(
    (c) => capas[`c:${c.tipo}`] && (capas.proyectado || c.estado !== 'proyectado') && (!soloRevisar || c.revisar?.length),
    [capas, soloRevisar],
  )

  // Dibujar los datos.
  useEffect(() => {
    const g = capaDatos.current
    if (!g || !elementos) return
    g.clearLayers()
    const napPorId = new Map(elementos.filter((e) => e.punto_id).map((e) => [e.punto_id, e]))

    for (const c of cables) {
      if (!visibleC(c)) continue
      const est = CABLE[c.tipo] ?? CABLE.otro
      const elegido = sel?.clase === 'c' && sel.id === c.id
      L.polyline(c.ruta, {
        color: c.tipo === 'hilo' && COLOR_HILO[c.color_hilo] ? COLOR_HILO[c.color_hilo] : est.color,
        weight: est.peso + (elegido ? 3 : 0),
        opacity: c.verificacion === 'importado' ? 0.65 : 0.95,
        dashArray: c.estado === 'proyectado' ? '8 6' : null,
      })
        .bindTooltip(`${c.nombre} · ${est.label}${c.hilos ? ` ${c.hilos}h` : ''} · ${Math.round(c.longitud_m ?? 0)} m`, { sticky: true })
        .on('click', (ev) => {
          L.DomEvent.stopPropagation(ev)
          if (!modoRef.current) setSel({ clase: 'c', id: c.id })
        })
        .addTo(g)
    }

    if (capas.abonados) {
      for (const a of abonados) {
        const nap = a.nap_id ? napPorId.get(a.nap_id) : null
        L.circleMarker([a.latitud, a.longitud], {
          radius: 3,
          color: nap ? '#10b981' : '#ef4444',
          weight: 1,
          fillOpacity: 0.8,
        })
          .bindTooltip(`${a.nombre}${nap ? ` · ${nap.nombre}${a.puerto_nap ? ` p${a.puerto_nap}` : ''}` : ' · sin caja'}`)
          .addTo(g)
        if (nap) L.polyline([[a.latitud, a.longitud], [nap.latitud, nap.longitud]], { color: '#10b981', weight: 1, opacity: 0.5 }).addTo(g)
      }
    }

    for (const e of elementos) {
      if (!visibleE(e)) continue
      const elegido = sel?.clase === 'e' && sel.id === e.id
      const revisar = e.revisar?.length > 0
      L.circleMarker([e.latitud, e.longitud], {
        radius: RADIO[e.tipo] + (elegido ? 3 : 0),
        color: elegido ? '#0f172a' : revisar ? '#f59e0b' : e.verificacion === 'campo' ? '#ffffff' : COLOR[e.tipo],
        weight: elegido ? 3 : revisar || e.verificacion === 'campo' ? 2 : 1,
        fillColor: COLOR[e.tipo],
        fillOpacity: e.verificacion === 'importado' ? 0.45 : 0.95,
        dashArray: e.estado === 'proyectado' ? '3 3' : null,
      })
        .bindTooltip(
          `${e.nombre}${e.tipo === 'nap' && e.capacidad ? ` · ${e.abonados ?? 0}/${e.capacidad}` : ''}${
            e.tipo === 'poste' && e.herraje ? ` · ${e.herraje}` : ''
          }`,
        )
        .on('click', (ev) => {
          L.DomEvent.stopPropagation(ev)
          if (modoRef.current?.accion === 'cable') return clicMapa.current?.(L.latLng(e.latitud, e.longitud), e)
          if (!modoRef.current) setSel({ clase: 'e', id: e.id })
        })
        .addTo(g)
    }
  }, [elementos, cables, abonados, capas, visibleE, visibleC, sel])

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
      })
      if (id) setSel({ clase: 'e', id })
    } else if (m.accion === 'cable' || m.accion === 'ruta') {
      setModo({ ...m, puntos: [...(m.puntos ?? []), p], desde: m.desde ?? (m.puntos?.length ? m.desde : sobre?.id), hasta: sobre?.id ?? null })
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
    })
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.google-earth.kmz' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `planta-externa-${new Date().toISOString().slice(0, 10)}.kmz`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const conteo = (pred) => (elementos ?? []).filter(pred).length

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
                <Button key={t} variante="fantasma" icon={Plus} onClick={() => { setSel(null); setModo({ accion: 'punto', tipo: t }) }}>
                  {ETIQUETA[t]}
                </Button>
              ))}
              <Select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return
                  setSel(null)
                  setModo({ accion: 'cable', tipo: e.target.value, puntos: [] })
                }}
                className="w-auto"
              >
                <option value="">+ Dibujar cable…</option>
                {Object.entries(CABLE).map(([k, c]) => (
                  <option key={k} value={k}>
                    {c.label}
                  </option>
                ))}
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
                    <span className="text-slate-500">· {x.clase === 'e' ? ETIQUETA[x.tipo] : CABLE[x.tipo]?.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {elegido ? (
            <Ficha
              x={elegido}
              clase={sel.clase}
              edita={edita}
              elementos={elementos ?? []}
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
                <div className="space-y-3 text-[12px]">
                  <Grupo titulo="Elementos">
                    {Object.keys(COLOR).map((t) => (
                      <Interruptor
                        key={t}
                        activo={capas[`e:${t}`]}
                        onCambio={(v) => setCapas((c) => ({ ...c, [`e:${t}`]: v }))}
                        muestra={<span className="h-3 w-3 rounded-full" style={{ background: COLOR[t] }} />}
                        etiqueta={`${ETIQUETA[t]} (${conteo((e) => e.tipo === t)})`}
                      />
                    ))}
                  </Grupo>
                  <Grupo titulo="Cables">
                    {Object.entries(CABLE).map(([t, c]) => (
                      <Interruptor
                        key={t}
                        activo={capas[`c:${t}`]}
                        onCambio={(v) => setCapas((x) => ({ ...x, [`c:${t}`]: v }))}
                        muestra={<span className="h-1 w-4 rounded" style={{ background: c.color }} />}
                        etiqueta={`${c.label} (${cables.filter((x) => x.tipo === t).length})`}
                      />
                    ))}
                  </Grupo>
                  <Grupo titulo="Mostrar">
                    <Interruptor activo={capas.proyectado} onCambio={(v) => setCapas((c) => ({ ...c, proyectado: v }))} etiqueta="Proyectado" />
                    <Interruptor
                      activo={capas.abonados}
                      onCambio={(v) => setCapas((c) => ({ ...c, abonados: v }))}
                      etiqueta={`Abonados (${abonados.length}): verde con caja, rojo sin caja`}
                    />
                    <Interruptor activo={soloRevisar} onCambio={setSoloRevisar} etiqueta="Solo lo que hay que revisar" />
                  </Grupo>
                  <p className="text-[11px] leading-snug text-slate-500">
                    Relleno tenue: importado sin verificar. Borde blanco: verificado en campo. Borde ámbar: a revisar. Punteado:
                    proyectado.
                  </p>
                </div>
              ) : (
                <ul className="max-h-[52vh] space-y-1 overflow-y-auto">
                  {!porRevisar.length && <li className="text-[12px] text-slate-500">Nada pendiente.</li>}
                  {porRevisar.map((x) => (
                    <li key={`${x.clase}${x.id}`}>
                      <button type="button" onClick={() => ir(x)} className="w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-slate-800/40">
                        <span className="text-slate-200">{x.nombre}</span>{' '}
                        <span className="text-slate-500">· {x.clase === 'e' ? ETIQUETA[x.tipo] : CABLE[x.tipo]?.label}</span>
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
    </div>
  )
}

const round7 = (x) => Math.round(Number(x) * 1e7) / 1e7

function Grupo({ titulo, children }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{titulo}</p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Interruptor({ activo, onCambio, etiqueta, muestra = null }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-slate-300">
      <input type="checkbox" checked={Boolean(activo)} onChange={(e) => onCambio(e.target.checked)} />
      {muestra}
      {etiqueta}
    </label>
  )
}

/** La ficha de lo elegido, para ver y editar. */
function Ficha({ x, clase, edita, elementos, onCerrar, onCambio, onError, onMover, onRuta }) {
  const [f, setF] = useState(x)
  const [guardando, setGuardando] = useState(false)
  useEffect(() => setF(x), [x])
  const tabla = clase === 'e' ? 'planta_elementos' : 'planta_cables'
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }))
  const n = (v) => (v === '' || v == null ? null : Number(v))

  async function guardar(extra = {}) {
    setGuardando(true)
    const comunes = { nombre: f.nombre?.trim() || x.nombre, estado: f.estado, descripcion: f.descripcion || null, ...extra }
    const fila =
      clase === 'e'
        ? { ...comunes, tipo: f.tipo, capacidad: n(f.capacidad), hilos: n(f.hilos), splitter: f.splitter || null, herraje: f.herraje || null, metros: n(f.metros) }
        : { ...comunes, tipo: f.tipo, hilos: n(f.hilos), color_hilo: f.color_hilo || null }
    const { error } = await supabase.from(tabla).update(fila).eq('id', x.id)
    setGuardando(false)
    if (error) return onError(error)
    onCambio()
  }

  async function borrar() {
    if (!window.confirm(`¿Borrar "${x.nombre}" del mapa?`)) return
    const { error } = await supabase.from(tabla).delete().eq('id', x.id)
    if (error) return onError(error)
    onCerrar()
    onCambio()
  }

  const extremo = (id) => elementos.find((e) => e.id === id)?.nombre

  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] text-slate-500">{clase === 'e' ? ETIQUETA[x.tipo] : `Cable ${CABLE[x.tipo]?.label ?? x.tipo}`}</p>
          <p className="text-[14px] font-semibold text-slate-100">{x.nombre}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge color={x.verificacion === 'campo' ? 'verde' : x.verificacion === 'oficina' ? 'azul' : 'ambar'}>{VERIF[x.verificacion]}</Badge>
            {x.estado !== 'existente' && <Badge color="gris">{ESTADO[x.estado]}</Badge>}
          </div>
        </div>
        <button type="button" onClick={onCerrar} className="text-slate-500" aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>

      {x.revisar?.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 p-2 text-amber-300">
          {x.revisar.map((r) => (
            <p key={r}>• {r}</p>
          ))}
        </div>
      )}

      {clase === 'e' && x.tipo === 'nap' && (
        <p className="text-slate-300">
          {x.abonados ?? 0} abonado(s){x.capacidad ? ` de ${x.capacidad} puertos · ${x.libres} libres` : ''}
          {x.caja && x.caja !== x.nombre?.toUpperCase() && <span className="block text-slate-500">Caja en el sistema: {x.caja}</span>}
        </p>
      )}
      {clase === 'c' && (
        <p className="text-slate-300">
          {Math.round(x.longitud_m ?? 0)} m de ruta
          {(x.desde_id || x.hasta_id) && (
            <span className="block text-slate-500">
              {extremo(x.desde_id) ?? '—'} → {extremo(x.hasta_id) ?? '—'}
            </span>
          )}
        </p>
      )}
      {clase === 'e' && (
        <a
          href={`https://www.google.com/maps?q=${x.latitud},${x.longitud}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-sky-400"
        >
          <MapPin size={12} /> {Number(x.latitud).toFixed(6)}, {Number(x.longitud).toFixed(6)}
        </a>
      )}
      {x.foto_url && (
        <a href={x.foto_url} target="_blank" rel="noreferrer" className="text-sky-400">
          Ver foto del KMZ
        </a>
      )}

      {edita ? (
        <div className="space-y-2">
          <Field label="Nombre (como está rotulado)">
            <Input value={f.nombre ?? ''} onChange={set('nombre')} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Tipo">
              <Select value={f.tipo} onChange={set('tipo')}>
                {Object.entries(clase === 'e' ? ETIQUETA : Object.fromEntries(Object.entries(CABLE).map(([k, c]) => [k, c.label]))).map(
                  ([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Estado">
              <Select value={f.estado} onChange={set('estado')}>
                {Object.entries(ESTADO).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(clase === 'c' || f.tipo === 'manga') && (
              <Field label="Hilos">
                <Input type="number" min="1" value={f.hilos ?? ''} onChange={set('hilos')} />
              </Field>
            )}
            {clase === 'c' && f.tipo === 'hilo' && (
              <Field label="Color del hilo">
                <Select value={f.color_hilo ?? ''} onChange={set('color_hilo')}>
                  <option value="">—</option>
                  {Object.keys(COLOR_HILO).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {clase === 'e' && f.tipo === 'nap' && (
              <Field label="Puertos">
                <Input type="number" min="1" value={f.capacidad ?? ''} onChange={set('capacidad')} />
              </Field>
            )}
            {clase === 'e' && (f.tipo === 'nap' || f.tipo === 'splitter') && (
              <Field label="Splitter">
                <Select value={f.splitter ?? ''} onChange={set('splitter')}>
                  <option value="">—</option>
                  {['1:2', '1:4', '1:8', '1:16', '1:32', '1:64'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {clase === 'e' && f.tipo === 'poste' && (
              <Field label="Herraje">
                <Select value={f.herraje ?? ''} onChange={set('herraje')}>
                  <option value="">—</option>
                  <option value="A">A · anclaje / retención</option>
                  <option value="J">J · suspensión</option>
                </Select>
              </Field>
            )}
            {clase === 'e' && f.tipo === 'reserva' && (
              <Field label="Metros de reserva">
                <Input type="number" min="0" value={f.metros ?? ''} onChange={set('metros')} />
              </Field>
            )}
          </div>
          <Field label="Descripción">
            <Textarea rows={2} value={f.descripcion ?? ''} onChange={set('descripcion')} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variante="primario" cargando={guardando} onClick={() => guardar()}>
              Guardar
            </Button>
            {(x.verificacion === 'importado' || x.revisar?.length > 0) && (
              <Button cargando={guardando} onClick={() => guardar({ verificacion: x.verificacion === 'campo' ? 'campo' : 'oficina', revisar: [] })}>
                Guardar como revisado
              </Button>
            )}
            {clase === 'e' ? (
              <Button variante="fantasma" icon={MapPin} onClick={onMover}>
                Mover
              </Button>
            ) : (
              <Button variante="fantasma" icon={Route} onClick={onRuta}>
                Redibujar ruta
              </Button>
            )}
            <Button variante="fantasma" onClick={borrar}>
              Borrar
            </Button>
          </div>
        </div>
      ) : (
        x.descripcion && <p className="text-slate-400">{x.descripcion}</p>
      )}
    </div>
  )
}
