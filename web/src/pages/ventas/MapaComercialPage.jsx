import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Map as MapIcon } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Aviso, Card, Cargando, ErrorBanner, Select, Stat } from '../../components/ui'
import { usePermisos } from '../../lib/AuthContext'
import { dineroCero as dinero } from '../../lib/formato'
import { comercialApi } from '../../lib/comercial'
import { ESTADOS_ABIERTOS, etiquetaEstado } from '../../lib/ventas'

/**
 * Mapa comercial.
 *
 * ── Qué pregunta contesta que ninguna lista contesta ──
 *
 * Dónde está la venta respecto de la red. Un prospecto a cuarenta metros de una
 * caja con puertos libres y otro a dos kilómetros de todo se ven idénticos en
 * una tabla, y son dos negocios completamente distintos. Puestos sobre el mismo
 * plano al lado de las cajas, la diferencia se ve sin leer un solo número.
 *
 * También muestra dónde NO hay que gastar esfuerzo: un sector lleno de puntos
 * rojos —cajas llenas— es donde el vendedor está prometiendo instalaciones que
 * después se traban tres semanas.
 *
 * ── Las capas ──
 *
 * Seis, y cada una se puede apagar. Todas juntas son ilegibles y esa es la
 * razón de los interruptores: se prende la pregunta que se está haciendo hoy.
 * Los prospectos calientes van aparte de los tibios porque son la capa que se
 * mira sola la mayoría de las veces.
 */

const CENTRO_POR_DEFECTO = [-0.9376, -79.227]

// Los colores de las capas. Los de estado —cajas llenas, prospecto caliente—
// salen de la paleta de estado y no de la de series: nunca son "una capa más".
const COLOR = {
  caliente: '#d03b3b',
  prospecto: '#3987e5',
  cliente: '#199e70',
  instalacion: '#fab219',
  cajaLibre: '#0ca30c',
  cajaJusta: '#fab219',
  cajaLlena: '#d03b3b',
}

const CAPAS = [
  { clave: 'calientes', label: 'Prospectos calientes', color: COLOR.caliente },
  { clave: 'prospectos', label: 'Prospectos', color: COLOR.prospecto },
  { clave: 'clientes', label: 'Clientes', color: COLOR.cliente },
  { clave: 'instalaciones', label: 'Instalaciones pendientes', color: COLOR.instalacion },
  { clave: 'cajas', label: 'Cajas NAP', color: COLOR.cajaLibre },
  { clave: 'zonas', label: 'Zonas de cobertura', color: '#0ea5e9' },
]

const colorCaja = (c) => {
  if (!c.activo) return '#64748b'
  if (c.llena) return COLOR.cajaLlena
  if (c.libres != null && c.libres <= 2) return COLOR.cajaJusta
  return COLOR.cajaLibre
}

export default function MapaComercialPage() {
  const { puede } = usePermisos()
  const contenedor = useRef(null)
  const mapa = useRef(null)
  const capa = useRef(null)

  const [datos, setDatos] = useState({
    prospectos: [],
    clientes: [],
    cajas: [],
    zonas: [],
    instalaciones: [],
  })
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [visibles, setVisibles] = useState(
    Object.fromEntries(CAPAS.map((c) => [c.clave, true])),
  )
  const [filtroVendedor, setFiltroVendedor] = useState('')
  const [filtroSector, setFiltroSector] = useState('')
  const [filtroEstado, setFiltroEstado] = useState('')

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setDatos(await comercialApi.mapa())
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Los desplegables salen de lo que hay cargado, no de una lista fija: filtrar
  // por un sector que nadie usa es un callejón sin salida.
  const vendedores = useMemo(
    () =>
      [...new Map(datos.prospectos.filter((p) => p.vendedor).map((p) => [p.vendedor_id, p.vendedor])).entries()],
    [datos.prospectos],
  )
  const sectores = useMemo(
    () => [...new Set(datos.prospectos.map((p) => p.sector).filter(Boolean))].sort(),
    [datos.prospectos],
  )

  const prospectosFiltrados = useMemo(
    () =>
      datos.prospectos.filter((p) => {
        if (filtroVendedor && p.vendedor_id !== filtroVendedor) return false
        if (filtroSector && p.sector !== filtroSector) return false
        if (filtroEstado === 'abiertos' && !ESTADOS_ABIERTOS.includes(p.estado)) return false
        if (filtroEstado && filtroEstado !== 'abiertos' && p.estado !== filtroEstado) return false
        return true
      }),
    [datos.prospectos, filtroVendedor, filtroSector, filtroEstado],
  )

  // El mapa se monta una vez. Reconstruirlo en cada render perdería el zoom
  // cada vez que alguien toca un filtro, que es todo el tiempo.
  useEffect(() => {
    if (mapa.current || !contenedor.current) return
    mapa.current = L.map(contenedor.current).setView(CENTRO_POR_DEFECTO, 13)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(mapa.current)
    capa.current = L.layerGroup().addTo(mapa.current)
  }, [])

  useEffect(() => {
    if (!capa.current) return
    capa.current.clearLayers()
    const puntos = []

    const marcar = (lat, lng, color, popup, radio = 6) => {
      const punto = [Number(lat), Number(lng)]
      L.circleMarker(punto, {
        radius: radio,
        color,
        fillColor: color,
        fillOpacity: 0.85,
        // El anillo de 2 px sobre la superficie separa marcas que se pisan: sin
        // él, dos prospectos en la misma manzana se leen como uno más grande.
        weight: 2,
      })
        .bindPopup(popup)
        .addTo(capa.current)
      puntos.push(punto)
    }

    if (visibles.zonas) {
      datos.zonas.forEach((z) => {
        if (z.tipo === 'circulo' && z.centro_lat != null) {
          const centro = [Number(z.centro_lat), Number(z.centro_lng)]
          L.circle(centro, {
            radius: Number(z.radio_m),
            color: z.color,
            fillColor: z.color,
            fillOpacity: 0.1,
            weight: 2,
          })
            .bindPopup(`<b>${z.nombre}</b><br>${z.tecnologia}`)
            .addTo(capa.current)
          puntos.push(centro)
        } else if (z.tipo === 'poligono' && Array.isArray(z.poligono)) {
          const vertices = z.poligono.map((v) => [Number(v[0]), Number(v[1])])
          L.polygon(vertices, {
            color: z.color,
            fillColor: z.color,
            fillOpacity: 0.1,
            weight: 2,
          })
            .bindPopup(`<b>${z.nombre}</b>`)
            .addTo(capa.current)
          puntos.push(...vertices)
        }
      })
    }

    if (visibles.cajas) {
      datos.cajas.forEach((c) =>
        marcar(
          c.latitud,
          c.longitud,
          colorCaja(c),
          `<b>${c.nombre}</b><br>${
            c.capacidad == null ? 'capacidad sin cargar' : `${c.libres} de ${c.capacidad} libres`
          }`,
          5,
        ),
      )
    }

    if (visibles.clientes) {
      datos.clientes.forEach((c) =>
        marcar(c.latitud, c.longitud, COLOR.cliente, `<b>${c.nombre}</b><br>${c.plan ?? ''}`, 4),
      )
    }

    if (visibles.instalaciones) {
      datos.instalaciones.forEach((i) =>
        marcar(
          i.latitud,
          i.longitud,
          COLOR.instalacion,
          `<b>${i.titular}</b><br>Instalación ${i.estado}${i.fecha ? ` · ${i.fecha}` : ''}`,
        ),
      )
    }

    prospectosFiltrados.forEach((p) => {
      const caliente = p.puntaje >= 60 && ESTADOS_ABIERTOS.includes(p.estado)
      if (caliente && !visibles.calientes) return
      if (!caliente && !visibles.prospectos) return
      marcar(
        p.latitud,
        p.longitud,
        caliente ? COLOR.caliente : COLOR.prospecto,
        `<b>${p.nombre}</b><br>${etiquetaEstado(p.estado).label} · ${p.puntaje}/100` +
          `${p.plan ? `<br>${p.plan}` : ''}${p.vendedor ? `<br>${p.vendedor}` : ''}`,
        caliente ? 8 : 6,
      )
    })

    if (puntos.length) mapa.current.fitBounds(L.latLngBounds(puntos).pad(0.15))
  }, [datos, visibles, prospectosFiltrados])

  const calientes = prospectosFiltrados.filter(
    (p) => p.puntaje >= 60 && ESTADOS_ABIERTOS.includes(p.estado),
  ).length
  const enJuego = prospectosFiltrados
    .filter((p) => ESTADOS_ABIERTOS.includes(p.estado))
    .reduce((t, p) => t + Number(p.valor_mensual || 0), 0)

  const sinUbicar = datos.prospectos.length === 0

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
          <MapIcon size={20} className="text-sky-400" />
          Mapa comercial
        </h1>
        <p className="text-sm text-slate-400">
          Dónde está cada venta respecto de la red: prospectos, cajas con lugar y trabajos ya
          agendados sobre el mismo plano.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Prospectos en el mapa" valor={prospectosFiltrados.length} />
        <Stat label="Calientes" valor={calientes} color="text-red-400" />
        <Stat label="En juego" valor={dinero(enJuego)} color="text-sky-400" />
        <Stat
          label="Cajas con lugar"
          valor={datos.cajas.filter((c) => c.activo && !c.llena).length}
          color="text-emerald-400"
        />
      </div>

      {sinUbicar && !cargando && (
        <Aviso>
          Ningún prospecto tiene coordenadas todavía. Cargalas al dar de alta el prospecto o desde
          la verificación de cobertura, y van a empezar a aparecer acá.
        </Aviso>
      )}

      <Card>
        {/* Los filtros van en una sola fila arriba del mapa, no repartidos. */}
        <div className="mb-3 flex flex-wrap gap-2">
          {puede('ventas.equipo') && (
            <Select
              value={filtroVendedor}
              onChange={(e) => setFiltroVendedor(e.target.value)}
              className="w-44"
            >
              <option value="">Todos los vendedores</option>
              {vendedores.map(([id, nombre]) => (
                <option key={id} value={id}>
                  {nombre}
                </option>
              ))}
            </Select>
          )}
          <Select
            value={filtroSector}
            onChange={(e) => setFiltroSector(e.target.value)}
            className="w-44"
          >
            <option value="">Todos los sectores</option>
            {sectores.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select
            value={filtroEstado}
            onChange={(e) => setFiltroEstado(e.target.value)}
            className="w-44"
          >
            <option value="">Cualquier estado</option>
            <option value="abiertos">Solo los abiertos</option>
            {['nuevo', 'contactado', 'cotizado', 'negociacion', 'ganado', 'perdido'].map((e) => (
              <option key={e} value={e}>
                {etiquetaEstado(e).label}
              </option>
            ))}
          </Select>
        </div>

        {/* Los interruptores de capa hacen de leyenda: el color de cada capa
            está al lado de su nombre, así que nada depende del color solo. */}
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-800 pt-3">
          {CAPAS.map((c) => (
            <label key={c.clave} className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={visibles[c.clave]}
                onChange={(e) => setVisibles({ ...visibles, [c.clave]: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500"
              />
              <i
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: c.color }}
              />
              <span className="text-slate-300">{c.label}</span>
            </label>
          ))}
        </div>

        {cargando && <Cargando texto="Cargando el mapa…" />}
        <div
          ref={contenedor}
          className="h-[560px] w-full overflow-hidden rounded-xl border border-slate-800"
        />
        <p className="mt-2 text-[11px] text-slate-500">
          Las cajas NAP se pintan por ocupación: verde con lugar, ámbar quedan pocas, rojo llena.
          Prometer sobre una roja es lo que traba una instalación tres semanas.
        </p>
      </Card>
    </div>
  )
}
