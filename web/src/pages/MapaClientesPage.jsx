import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapPin } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '../lib/supabaseClient'
import { Aviso, Card, Cargando, ErrorBanner, Select, Stat } from '../components/ui'

/**
 * Mapa de abonados.
 *
 * Se usa Leaflet directo, sin envoltorio de React: el mapa maneja su propio
 * ciclo de vida y montarlo una vez en un ref evita que cada re-render lo
 * destruya y lo vuelva a crear.
 *
 * Los marcadores se dibujan como círculos de color en vez de con el ícono por
 * defecto: así el estado del cliente se ve de un vistazo y no hay que cargar
 * las imágenes de Leaflet, que con un bundler suelen quedar rotas.
 */

const COLOR_ESTADO = {
  activo: '#10b981',
  cortado: '#ef4444',
  suspendido: '#f59e0b',
  baja: '#64748b',
}

/** La Maná, Cotopaxi: el centro por defecto cuando todavía no hay nadie ubicado. */
const CENTRO_POR_DEFECTO = [-0.9376, -79.227]

export default function MapaClientesPage() {
  const contenedor = useRef(null)
  const mapa = useRef(null)
  const capa = useRef(null)
  const navigate = useNavigate()

  const [clientes, setClientes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('')

  useEffect(() => {
    supabase
      .from('v_clientes_ficha')
      .select('id, nombre, estado, ip, plan, latitud, longitud, saldo, direccion')
      .not('latitud', 'is', null)
      .not('longitud', 'is', null)
      .then(({ data, error: err }) => {
        if (err) setError(err)
        setClientes(data ?? [])
        setCargando(false)
      })
  }, [])

  const visibles = useMemo(
    () => (filtro ? clientes.filter((c) => c.estado === filtro) : clientes),
    [clientes, filtro],
  )

  // El mapa se crea una sola vez.
  useEffect(() => {
    if (mapa.current || !contenedor.current) return

    mapa.current = L.map(contenedor.current).setView(CENTRO_POR_DEFECTO, 13)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(mapa.current)
    capa.current = L.layerGroup().addTo(mapa.current)

    // Leaflet mide el contenedor en el momento de crearse. Si la tarjeta
    // termina de acomodarse un instante después, el mapa queda con las
    // imágenes cortadas hasta que algo lo toca.
    const t = setTimeout(() => mapa.current?.invalidateSize(), 60)

    return () => {
      clearTimeout(t)
      mapa.current?.remove()
      mapa.current = null
    }
  }, [])

  // Los marcadores se rehacen cada vez que cambia lo que hay que mostrar.
  useEffect(() => {
    if (!capa.current) return
    capa.current.clearLayers()
    if (!visibles.length) return

    for (const c of visibles) {
      const marcador = L.circleMarker([Number(c.latitud), Number(c.longitud)], {
        radius: 7,
        color: '#0f172a',
        weight: 1,
        fillColor: COLOR_ESTADO[c.estado] ?? '#64748b',
        fillOpacity: 0.9,
      })

      marcador.bindPopup(
        `<div style="font-family:system-ui;font-size:12px;min-width:170px">
           <b>${c.nombre}</b><br>
           ${c.plan ?? 'sin plan'} · ${c.estado}<br>
           ${c.ip ?? ''}<br>
           ${Number(c.saldo) > 0 ? `<span style="color:#dc2626">debe $${Number(c.saldo).toFixed(2)}</span><br>` : ''}
           <a href="#" data-cliente="${c.id}" style="color:#0284c7">Ver ficha</a>
         </div>`,
      )

      // El popup es HTML suelto: el clic se atiende cuando ya está en pantalla.
      marcador.on('popupopen', (e) => {
        const enlace = e.popup.getElement()?.querySelector('[data-cliente]')
        enlace?.addEventListener('click', (ev) => {
          ev.preventDefault()
          navigate(`/clientes/${c.id}`)
        })
      })

      marcador.addTo(capa.current)
    }

    // Encuadra a todos los que se están mostrando.
    const limites = L.latLngBounds(visibles.map((c) => [Number(c.latitud), Number(c.longitud)]))
    mapa.current?.fitBounds(limites, { padding: [40, 40], maxZoom: 16 })
  }, [visibles, navigate])

  const contar = (estado) => clientes.filter((c) => c.estado === estado).length

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Mapa de clientes</h1>
        <p className="text-sm text-slate-500">
          Cada punto es un abonado con coordenadas cargadas. El color es su estado.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="En el mapa" valor={clientes.length} icon={MapPin} />
        <Stat label="Activos" valor={contar('activo')} color="text-emerald-400" />
        <Stat label="Cortados" valor={contar('cortado')} color="text-red-400" />
        <Stat label="Suspendidos" valor={contar('suspendido')} color="text-amber-400" />
      </div>

      <Card
        title="Ubicaciones"
        icon={MapPin}
        actions={
          <Select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="w-44">
            <option value="">Todos</option>
            <option value="activo">Activos</option>
            <option value="cortado">Cortados</option>
            <option value="suspendido">Suspendidos</option>
            <option value="baja">De baja</option>
          </Select>
        }
      >
        {/*
          El contenedor va SIEMPRE montado, incluso mientras carga.

          El efecto que crea el mapa corre una sola vez, al montar, y lo primero
          que hace es mirar `contenedor.current`. Si en ese momento el div no
          existe —porque estaba del lado del `cargando`— el efecto sale sin
          hacer nada y, al no tener dependencias, no vuelve a correr nunca: el
          mapa no se crea jamás y la pantalla queda en blanco para siempre.

          Por eso el aviso de "cargando" va ARRIBA del contenedor y no en lugar
          de él.
        */}
        <div className="space-y-3">
          {cargando && <Cargando />}

          {!cargando && clientes.length === 0 && (
            <Aviso>
              Todavía no hay clientes con ubicación. Se carga en la ficha de cada uno —
              <b> Clientes → Usuarios → (abrir un cliente) → Resumen → Ubicación</b>—, y ahí mismo
              hay un botón para tomar la ubicación del dispositivo.
            </Aviso>
          )}

          <div
            ref={contenedor}
            className="h-[540px] w-full overflow-hidden rounded-lg border border-slate-800"
          />
        </div>
      </Card>
    </div>
  )
}
