import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPinOff, WifiOff } from 'lucide-react'

/**
 * El mapita de las tarjetas del técnico.
 *
 * Sirve para dos cosas con la misma pieza: un punto —la próxima instalación— o
 * una ruta numerada —las paradas del día—.
 *
 * ── Lo que hay que decir de entrada ──
 *
 * Los mapas NO funcionan sin conexión. Las imágenes vienen de un servidor de
 * OpenStreetMap, y el service worker no las precachea: serían cientos de
 * archivos de una zona que no sabemos cuál es hasta que el técnico llega.
 *
 * Por eso, sin señal, en vez de dejar una grilla gris rota se dice qué pasa y
 * se muestra la dirección, que es el dato que de verdad se necesita. Un mapa a
 * medio cargar hace pensar que la app se colgó.
 *
 * ── Por qué es Leaflet directo y no una librería de React ──
 *
 * Porque es lo que ya usa el resto del sistema —el mapa de clientes, el
 * comercial, el de cobertura—. Meter una segunda forma de dibujar mapas
 * significa dos comportamientos distintos para el mismo gesto.
 */

const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

/** Un marcador redondo con número adentro, del color del estado. */
const marcador = (texto, clase) =>
  L.divIcon({
    className: '',
    html: `<span class="grid h-7 w-7 place-items-center rounded-full border-2 border-white text-[11px] font-bold text-white shadow ${clase}">${texto}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })

const COLOR = {
  hecha: 'bg-emerald-500',
  en_curso: 'bg-amber-500',
  en_ruta: 'bg-sky-500',
  reprogramada: 'bg-violet-500',
}

export default function MapaCampo({ puntos = [], alto = 'h-44', conRuta = false }) {
  const contenedor = useRef(null)
  const mapa = useRef(null)
  const [enLinea, setEnLinea] = useState(navigator.onLine)

  useEffect(() => {
    const arriba = () => setEnLinea(true)
    const abajo = () => setEnLinea(false)
    window.addEventListener('online', arriba)
    window.addEventListener('offline', abajo)
    return () => {
      window.removeEventListener('online', arriba)
      window.removeEventListener('offline', abajo)
    }
  }, [])

  const conCoordenadas = puntos.filter(
    (p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)),
  )

  useEffect(() => {
    if (!enLinea || !conCoordenadas.length || !contenedor.current) return

    if (!mapa.current) {
      mapa.current = L.map(contenedor.current, {
        // Sin controles: es una miniatura para ubicarse, no una herramienta de
        // exploración. El zoom con dos dedos sigue andando; lo que se saca son
        // los botones, que en 44 px de alto tapan medio mapa.
        zoomControl: false,
        attributionControl: false,
        // Que el mapa no se arrastre solo cuando el técnico quiere desplazar la
        // página con el dedo encima de la tarjeta.
        dragging: !L.Browser.mobile,
      })
      L.tileLayer(TILES, { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(mapa.current)
    }

    const capa = L.layerGroup().addTo(mapa.current)

    conCoordenadas.forEach((p, i) => {
      L.marker([Number(p.lat), Number(p.lng)], {
        icon: marcador(conRuta ? String(i + 1) : '', COLOR[p.estado] ?? 'bg-sky-600'),
        title: p.titulo ?? '',
      }).addTo(capa)
    })

    // La línea que une las paradas en el orden en que se recorren. No es la ruta
    // real por calles —para eso está el botón "Ubicación", que abre el navegador
    // del teléfono— sino el orden de visita, que es lo que esta tarjeta responde.
    if (conRuta && conCoordenadas.length > 1) {
      L.polyline(
        conCoordenadas.map((p) => [Number(p.lat), Number(p.lng)]),
        { color: '#0284c7', weight: 3, opacity: 0.7, dashArray: '6 6' },
      ).addTo(capa)
    }

    // Con cero puntos, `fitBounds` recibe unos límites inválidos y lanza. El
    // caso existe: una visita cargada sin coordenadas, o un técnico sin nada
    // asignado todavía.
    if (conCoordenadas.length) {
      const limites = L.latLngBounds(conCoordenadas.map((p) => [Number(p.lat), Number(p.lng)]))
      if (conCoordenadas.length === 1) {
        mapa.current.setView(limites.getCenter(), 16)
      } else {
        mapa.current.fitBounds(limites, { padding: [28, 28], maxZoom: 16 })
      }
    }

    // Leaflet mide mal el contenedor cuando la tarjeta se dibuja después que él.
    // Sin esto, el mapa queda con las imágenes cortadas hasta que algo lo toca.
    const t = setTimeout(() => mapa.current?.invalidateSize(), 60)

    return () => {
      clearTimeout(t)
      capa.remove()
    }
  }, [conCoordenadas, conRuta, enLinea])

  useEffect(
    () => () => {
      mapa.current?.remove()
      mapa.current = null
    },
    [],
  )

  if (!conCoordenadas.length) {
    return (
      <Aviso alto={alto} icono={MapPinOff}>
        Sin coordenadas cargadas
      </Aviso>
    )
  }

  if (!enLinea) {
    return (
      <Aviso alto={alto} icono={WifiOff}>
        El mapa necesita conexión
      </Aviso>
    )
  }

  return (
    <div
      ref={contenedor}
      className={`campo-borde w-full overflow-hidden rounded-xl border ${alto}`}
      // El mapa no debe robarle el desplazamiento a la página: en un teléfono,
      // arrastrar el dedo sobre una tarjeta tiene que mover la pantalla.
      style={{ touchAction: 'pan-y' }}
    />
  )
}

const Aviso = ({ alto, icono: Icono, children }) => (
  <div
    className={`campo-borde campo-tenue flex ${alto} w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-[12px]`}
  >
    <Icono size={18} />
    {children}
  </div>
)
