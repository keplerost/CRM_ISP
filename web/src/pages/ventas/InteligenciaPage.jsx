import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Box,
  Lightbulb,
  MapPin,
  Radio,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Badge, Card, Cargando, ErrorBanner, Table } from '../../components/ui'
import BotonTema from '../../components/ventas/BotonTema'
import { useTemaCampo } from '../../lib/temaCampo'
import { dineroCero as dinero } from '../../lib/formato'
import { paleta } from '../../lib/comercial'
import { ORIGENES } from '../../lib/ventas'

/**
 * Inteligencia comercial.
 *
 * ── La pregunta que contesta ──
 *
 * Dónde te están pidiendo servicio y no llegás.
 *
 * Cada verificación de cobertura que da negativo queda guardada con su sector y
 * sus coordenadas. Ese registro se viene acumulando y nadie lo consultaba.
 * Agrupado, deja de ser un historial y pasa a ser un mapa de demanda
 * comprobada: no "creemos que en ese barrio hay mercado", sino "doce personas de
 * ahí preguntaron y les dijimos que no".
 *
 * Es la diferencia entre decidir dónde tender red por intuición y decidirlo por
 * pedidos que ya llegaron.
 *
 * ── Lo que esta pantalla NO hace ──
 *
 * No estima cuánta plata se pierde en las consultas anónimas. Cuando alguien
 * pregunta y no queda cargado como prospecto, no se sabe qué plan habría
 * contratado, y multiplicarlo por un precio promedio daría un número grande y
 * falso. Se cuentan las consultas —que es un hecho— y aparte se suma el valor
 * REAL de los prospectos que sí se cargaron y se perdieron por cobertura.
 */

const CENTRO_POR_DEFECTO = [-0.9376, -79.227]

export default function InteligenciaPage() {
  const { tema, alternar } = useTemaCampo()
  const C = paleta(tema)

  const contenedor = useRef(null)
  const mapa = useRef(null)
  const capa = useRef(null)

  const [datos, setDatos] = useState({ sectores: [], puntos: [], origenes: [], perdidos: [], cajas: [], naps: [] })
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [sectores, puntos, origenes, perdidos, cajas, naps] = await Promise.all([
        supabase.from('v_demanda_por_sector').select('*').order('prioridad', { ascending: false }),
        supabase.from('v_puntos_sin_cobertura').select('*').limit(500),
        supabase.from('v_cierre_por_origen').select('*').order('total', { ascending: false }),
        supabase.from('v_perdidos_recientes').select('*').limit(20),
        supabase.from('v_cajas_al_limite').select('*'),
        // Las cajas que sí tienen lugar, para que el mapa muestre el contraste
        // entre dónde llegamos y dónde nos piden.
        supabase.from('v_cajas_nap').select('nombre, latitud, longitud, libres, llena').not('latitud', 'is', null),
      ])
      if (sectores.error) throw sectores.error
      setDatos({
        sectores: sectores.data ?? [],
        puntos: puntos.data ?? [],
        origenes: origenes.data ?? [],
        perdidos: perdidos.data ?? [],
        cajas: cajas.data ?? [],
        naps: naps.data ?? [],
      })
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
    const bordes = []

    // La red que ya existe, en gris: es el telón de fondo contra el que se lee
    // la demanda. Sin ella, un racimo de puntos rojos no dice si está a una
    // cuadra de la red o a diez kilómetros.
    datos.naps.forEach((n) => {
      const p = [Number(n.latitud), Number(n.longitud)]
      L.circleMarker(p, {
        radius: 5,
        color: n.llena ? '#64748b' : '#0ca30c',
        fillColor: n.llena ? '#64748b' : '#0ca30c',
        fillOpacity: 0.5,
        weight: 1,
      })
        .bindPopup(`<b>${n.nombre}</b><br>${n.llena ? 'llena' : `${n.libres} libres`}`)
        .addTo(capa.current)
      bordes.push(p)
    })

    // La demanda, en rojo y más grande: es lo que se viene a mirar.
    datos.puntos.forEach((x) => {
      const p = [Number(x.latitud), Number(x.longitud)]
      L.circleMarker(p, {
        radius: 8,
        color: x.resultado === 'sin_cobertura' ? '#d03b3b' : '#fab219',
        fillColor: x.resultado === 'sin_cobertura' ? '#d03b3b' : '#fab219',
        fillOpacity: 0.75,
        weight: 2,
      })
        .bindPopup(
          `<b>${x.direccion}</b><br>${x.sector ?? 'sin sector'}<br>` +
            `${x.resultado === 'sin_cobertura' ? 'Sin cobertura' : 'Requiere obra'}` +
            `${x.distancia_m ? ` · lo más cerca a ${x.distancia_m} m` : ''}` +
            `${x.prospecto ? `<br>Prospecto: ${x.prospecto}` : ''}`,
        )
        .addTo(capa.current)
      bordes.push(p)
    })

    if (bordes.length) mapa.current.fitBounds(L.latLngBounds(bordes).pad(0.2))
  }, [datos])

  const total = useMemo(
    () => ({
      consultas: datos.sectores.reduce((t, s) => t + s.sin_cobertura + s.con_obra, 0),
      perdidos: datos.sectores.reduce((t, s) => t + s.prospectos_perdidos, 0),
      valor: datos.sectores.reduce((t, s) => t + Number(s.valor_mensual_perdido || 0), 0),
    }),
    [datos.sectores],
  )

  const sinDatos = !cargando && datos.sectores.length === 0 && datos.puntos.length === 0

  return (
    <div className="campo campo-fondo -m-6 space-y-4 p-4 md:p-6" data-tema={tema}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="campo-txt flex items-center gap-2 text-xl font-semibold">
            <Lightbulb size={20} style={{ color: C.alerta }} />
            Inteligencia comercial
          </h1>
          <p className="campo-suave text-sm">
            Dónde te piden servicio y no llegás, y por dónde se te escapan las ventas.
          </p>
        </div>
        <BotonTema tema={tema} onAlternar={alternar} />
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {sinDatos && (
        <Aviso>
          Todavía no hay consultas de cobertura registradas. Cada vez que alguien use{' '}
          <b>Verificar cobertura</b> y dé negativo, ese pedido se guarda con su sector y aparece
          acá. Es información que se junta sola mientras se trabaja.
        </Aviso>
      )}

      {/* ── Los tres números ── */}
      <div className="grid gap-3 md:grid-cols-3">
        <Metrica
          titulo="Consultas sin cobertura"
          valor={total.consultas}
          nota="Gente que preguntó y se fue"
          icono={MapPin}
          color={C.critico}
        />
        <Metrica
          titulo="Prospectos perdidos por cobertura"
          valor={total.perdidos}
          nota="Llegaron a cargarse y no se pudo"
          icono={TrendingDown}
          color={C.alerta}
        />
        <Metrica
          titulo="Mensualidad que se perdió"
          valor={dinero(total.valor)}
          nota="Solo de los prospectos cargados — las consultas anónimas no se estiman"
          icono={TrendingUp}
          color={C.etapas[0]}
        />
      </div>

      {/* ── El mapa ── */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-4 text-[12px]">
          <span className="campo-txt text-[13px] font-medium">Demanda contra red existente</span>
          <span className="ml-auto flex flex-wrap gap-3">
            <Leyenda color="#d03b3b" texto="Sin cobertura" />
            <Leyenda color="#fab219" texto="Requiere obra" />
            <Leyenda color="#0ca30c" texto="Caja con lugar" />
            <Leyenda color="#64748b" texto="Caja llena" />
          </span>
        </div>
        {cargando && <Cargando texto="Cargando la demanda…" />}
        <div
          ref={contenedor}
          className="h-[440px] w-full overflow-hidden rounded-xl border campo-borde"
        />
        <p className="campo-tenue mt-2 text-[11px]">
          Un racimo rojo pegado a un punto verde es una ampliación de caja. Un racimo rojo lejos de
          todo es una decisión más grande: tender red nueva.
        </p>
      </Card>

      {/* ── Sectores ── */}
      <Card
        title="Dónde conviene tender"
        subtitle="Ordenado por demanda comprobada. Un prospecto perdido pesa el triple que una consulta suelta: llegó a cargarse, o sea que alguien habló con esa persona."
      >
        <Table
          columnas={['Sector', 'Sin cobertura', 'Requiere obra', 'Prospectos perdidos', 'Mensualidad perdida', 'Última consulta']}
          filas={datos.sectores}
          vacio="Sin demanda insatisfecha registrada."
          renderFila={(s) => (
            <tr key={s.sector} className="hover:bg-slate-800/40">
              <td className="px-3 py-2">
                <span className="campo-txt font-medium">{s.sector}</span>
                {s.prioridad >= 5 && (
                  <Badge color="rojo">
                    <span className="ml-0">prioridad</span>
                  </Badge>
                )}
              </td>
              <td className="px-3 py-2 tabular-nums" style={{ color: s.sin_cobertura ? C.critico : undefined }}>
                <span className={s.sin_cobertura ? '' : 'campo-tenue'}>{s.sin_cobertura}</span>
              </td>
              <td className="campo-suave px-3 py-2 tabular-nums">{s.con_obra}</td>
              <td className="campo-suave px-3 py-2 tabular-nums">{s.prospectos_perdidos}</td>
              <td className="campo-txt px-3 py-2 tabular-nums">
                {Number(s.valor_mensual_perdido) > 0 ? dinero(s.valor_mensual_perdido) : '—'}
              </td>
              <td className="campo-tenue px-3 py-2 text-[12px]">
                {s.ultima_consulta ? new Date(s.ultima_consulta).toLocaleDateString('es-EC') : '—'}
              </td>
            </tr>
          )}
        />
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── Cierre por origen ── */}
        <Card
          title="Qué canal cierra mejor"
          subtitle="Sobre los prospectos ya cerrados, no sobre el total: incluir los que están en proceso castiga al canal que trae gente nueva."
        >
          {datos.origenes.length === 0 ? (
            <p className="campo-tenue py-6 text-center text-[13px]">Sin prospectos cargados.</p>
          ) : (
            <div className="space-y-2">
              {datos.origenes.map((o, i) => (
                <div key={o.origen}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-[12px]">
                    <span className="campo-suave truncate">{ORIGENES[o.origen] ?? o.origen}</span>
                    <span className="campo-txt shrink-0 tabular-nums">
                      {o.tasa_cierre != null ? `${o.tasa_cierre}%` : 'sin cerrar aún'}
                      <span className="campo-tenue"> · {o.ganados}/{o.total}</span>
                    </span>
                  </div>
                  <div className="campo-sup h-1.5 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${o.tasa_cierre ?? 0}%`,
                        background: C.etapas[i % C.etapas.length],
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ── Cajas al límite ── */}
        <Card
          title="Cajas por acabarse"
          subtitle="Dónde ampliar antes de que una venta se caiga por falta de boca. Es distinto de dónde no llegamos."
        >
          {datos.cajas.length === 0 ? (
            <p className="campo-tenue py-6 text-center text-[13px]">
              Ninguna caja al límite — o falta cargarles la capacidad.
            </p>
          ) : (
            <div className="space-y-1.5">
              {datos.cajas.map((c) => (
                <div
                  key={c.id}
                  className="campo-borde flex items-center justify-between gap-2 rounded-lg border p-2 text-[13px]"
                >
                  <div className="min-w-0">
                    <div className="campo-txt truncate">{c.nombre}</div>
                    <div className="campo-tenue truncate text-[11px]">
                      {c.direccion ?? c.olt ?? 'sin dirección'}
                    </div>
                  </div>
                  <span
                    className="shrink-0 tabular-nums"
                    style={{ color: c.llena ? C.critico : C.alerta }}
                  >
                    {c.llena ? 'LLENA' : `${c.libres} de ${c.capacidad}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── Por qué se pierden ── */}
      <Card
        title="Ventas perdidas, en palabras"
        subtitle="Los motivos se escriben a mano, así que no se agrupan: 'precio', 'muy caro' y 'no le alcanzaba' son la misma cosa para una persona y tres categorías para una consulta."
      >
        {datos.perdidos.length === 0 ? (
          <p className="campo-tenue py-6 text-center text-[13px]">
            Todavía no se dio ninguna por perdida.
          </p>
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {datos.perdidos.map((p) => (
              <div key={p.id} className="campo-borde rounded-lg border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="campo-txt text-[13px] font-medium">{p.nombre}</span>
                  {p.cobertura === 'no_factible' && <Badge color="rojo">sin cobertura</Badge>}
                  {p.sector && <span className="campo-tenue text-[11px]">{p.sector}</span>}
                  <span className="campo-tenue ml-auto text-[11px]">
                    {new Date(p.perdido_en).toLocaleDateString('es-EC')}
                  </span>
                </div>
                <p className="campo-suave mt-0.5 text-[12px]">{p.motivo_perdida}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Metrica({ titulo, valor, nota, icono: Icono, color }) {
  return (
    <div className="campo-sup campo-borde rounded-xl border p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="campo-suave text-[12px]">{titulo}</span>
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
          style={{ background: `${color}22`, color }}
        >
          <Icono size={18} />
        </span>
      </div>
      <div className="campo-txt mt-1 text-2xl font-semibold tabular-nums">{valor}</div>
      {nota && <p className="campo-tenue mt-1 text-[11px] leading-tight">{nota}</p>}
    </div>
  )
}

const Leyenda = ({ color, texto }) => (
  <span className="flex items-center gap-1.5">
    <i className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
    <span className="campo-suave">{texto}</span>
  </span>
)
