import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { CheckCircle2, HelpCircle, MapPin, Plus, Radio, Trash2, XCircle } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Stat,
  Table,
  Textarea,
} from '../../components/ui'
import ConPermiso from '../../components/layout/ConPermiso'
import { usePermisos } from '../../lib/AuthContext'
import { comercialApi } from '../../lib/comercial'
import { ventasApi } from '../../lib/ventas'

/**
 * Verificación de cobertura.
 *
 * ── De dónde sale la respuesta ──
 *
 * No de una estimación ni de un dibujo: de `cobertura_cercana`, la función que
 * existe desde la migración 31 y que recorre las cajas y torres reales
 * calculando distancia y puertos libres. Y descuenta los puertos que ya
 * reservaron instalaciones agendadas — sin ese descuento, dos ventas del mismo
 * día se prometen sobre la misma caja y la segunda se entera en la vereda.
 *
 * ── Por qué se guarda cada consulta ──
 *
 * La misma dirección puede dar "sin cobertura" en marzo y "disponible" en julio
 * porque se tendió la manzana. El historial es lo que permite volver a llamar a
 * los que se les dijo que no: es una lista de ventas que ya preguntaron.
 */

const CENTRO_POR_DEFECTO = [-0.9376, -79.227]

export const RESULTADOS = {
  disponible: { label: 'DISPONIBLE', color: 'verde', icono: CheckCircle2, ayuda: 'Hay caja cerca con puerto libre. Se instala esta semana.' },
  con_obra: { label: 'DISPONIBLE CON OBRA', color: 'ambar', icono: HelpCircle, ayuda: 'Llega, pero hay que tender. Lo aprueba red, no ventas.' },
  requiere_verificacion: { label: 'REQUIERE VERIFICACIÓN', color: 'ambar', icono: HelpCircle, ayuda: 'Hay red cerca pero sin lugar confirmado. Que lo mire alguien de red.' },
  sin_cobertura: { label: 'SIN COBERTURA', color: 'rojo', icono: XCircle, ayuda: 'No hay nada al alcance desde este punto.' },
}

const VACIA = {
  nombre: '',
  telefono: '',
  direccion: '',
  sector: '',
  referencia: '',
  latitud: '',
  longitud: '',
  tecnologia: 'ftth',
  notas: '',
}

const ZONA_VACIA = {
  nombre: '',
  tipo: 'circulo',
  tecnologia: 'ftth',
  centro_lat: '',
  centro_lng: '',
  radio_m: 500,
  color: '#0ea5e9',
  activa: true,
  notas: '',
}

export default function CoberturaPage() {
  const confirmar = useConfirmar()
  const { perfil } = usePermisos()
  const contenedor = useRef(null)
  const mapa = useRef(null)
  const marcador = useRef(null)

  const [consulta, setConsulta] = useState({ ...VACIA })
  const [resultado, setResultado] = useState(null)
  const [verificando, setVerificando] = useState(false)
  const [historial, setHistorial] = useState([])
  const [zonas, setZonas] = useState([])
  const [error, setError] = useState(null)
  const [editandoZona, setEditandoZona] = useState(null)

  const recargar = useCallback(async () => {
    try {
      const [h, c] = await Promise.all([comercialApi.verificaciones(50), ventasApi.cobertura()])
      setHistorial(h)
      setZonas(c.zonas)
    } catch (err) {
      setError(err)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Un mapa chico solo para elegir el punto. Escribir coordenadas a mano es lo
  // que nadie hace: se pincha la casa y listo.
  useEffect(() => {
    if (mapa.current || !contenedor.current) return
    mapa.current = L.map(contenedor.current).setView(CENTRO_POR_DEFECTO, 14)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(mapa.current)

    mapa.current.on('click', (e) => {
      const lat = e.latlng.lat.toFixed(7)
      const lng = e.latlng.lng.toFixed(7)
      setConsulta((c) => ({ ...c, latitud: lat, longitud: lng }))
      setResultado(null)
      if (marcador.current) marcador.current.remove()
      marcador.current = L.circleMarker(e.latlng, {
        radius: 8,
        color: '#3987e5',
        fillColor: '#3987e5',
        fillOpacity: 0.9,
        weight: 2,
      }).addTo(mapa.current)
    })
  }, [])

  const verificar = async () => {
    if (!consulta.latitud || !consulta.longitud) {
      return setError(new Error('Marcá el punto en el mapa o escribí las coordenadas'))
    }
    setVerificando(true)
    setError(null)
    try {
      setResultado(
        await comercialApi.verificar({
          lat: Number(consulta.latitud),
          lng: Number(consulta.longitud),
          tecnologia: consulta.tecnologia,
        }),
      )
    } catch (err) {
      setError(err)
    } finally {
      setVerificando(false)
    }
  }

  /**
   * De la verificación al prospecto, en un paso.
   *
   * Es el flujo real: alguien llama preguntando si le llega, se verifica, y si
   * llega hay que cargarlo antes de que corte. Sin esto había que ir a
   * Prospectos y reescribir a mano la dirección, el sector y —lo peor— las
   * coordenadas, que nadie transcribe. El resultado era un prospecto sin punto
   * en el mapa, o sea invisible justo en la pantalla que dice si está cerca de
   * una caja con lugar.
   *
   * El vocabulario de cobertura se traduce acá: la verificación habla en
   * DISPONIBLE / SIN COBERTURA y el prospecto en el de `instalaciones`, para que
   * al ganarse el valor pase sin traducir.
   */
  const A_COBERTURA_PROSPECTO = {
    disponible: 'factible',
    con_obra: 'con_obra',
    requiere_verificacion: 'pendiente',
    sin_cobertura: 'no_factible',
  }

  const guardar = async ({ conProspecto = false } = {}) => {
    if (!consulta.direccion.trim()) {
      return setError(new Error('Falta la dirección: sin ella la consulta no sirve para volver a llamar'))
    }
    try {
      const m = resultado?.mejor

      // El prospecto primero, para poder dejarlo referenciado en la
      // verificación. Al revés habría que actualizarla después, y si eso falla
      // queda una consulta huérfana que nadie relaciona con la venta.
      let prospectoId = null
      if (conProspecto) {
        // Sin nombre no se puede crear: un prospecto llamado como su propia
        // dirección es imposible de buscar y de saludar por teléfono.
        if (!consulta.nombre.trim()) {
          return setError(new Error('Para crear el prospecto hace falta el nombre de quien consultó'))
        }
        const p = await ventasApi.guardar({
          nombre: consulta.nombre.trim(),
          direccion: consulta.direccion.trim(),
          telefono: consulta.telefono || null,
          sector: consulta.sector || null,
          referencia: consulta.referencia || null,
          latitud: Number(consulta.latitud),
          longitud: Number(consulta.longitud),
          cobertura: A_COBERTURA_PROSPECTO[resultado?.resultado] ?? 'pendiente',
          nap_id: m?.id ?? null,
          distancia_nodo_m: m?.distancia_m ?? null,
          origen: 'llamada',
          estado: 'nuevo',
          vendedor_id: perfil?.id ?? null,
          creado_por: perfil?.id ?? null,
          notas: consulta.notas || null,
        })
        prospectoId = p.id
      }

      await comercialApi.guardarVerificacion({
        prospecto_id: prospectoId,
        direccion: consulta.direccion.trim(),
        sector: consulta.sector || null,
        referencia: consulta.referencia || null,
        latitud: Number(consulta.latitud),
        longitud: Number(consulta.longitud),
        tecnologia: consulta.tecnologia,
        notas: consulta.notas || null,
        resultado: resultado?.resultado ?? 'requiere_verificacion',
        nap_id: m?.id ?? null,
        distancia_m: m?.distancia_m ?? null,
        capacidad: m?.capacidad ?? null,
        disponibles: m?.disponibles ?? null,
        verificado_por: perfil?.id ?? null,
      })
      setConsulta({ ...VACIA })
      setResultado(null)
      if (marcador.current) marcador.current.remove()
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const R = resultado ? RESULTADOS[resultado.resultado] : null

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
          <Radio size={20} className="text-sky-400" />
          Verificación de cobertura
        </h1>
        <p className="text-sm text-slate-400">
          ¿Llega el servicio a esta dirección? La respuesta sale de las cajas reales y sus puertos
          libres, no de una estimación.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Consultar una dirección" icon={MapPin}>
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Quién consulta" hint="Hace falta solo si vas a cargarlo como prospecto.">
                <Input
                  value={consulta.nombre}
                  onChange={(e) => setConsulta({ ...consulta, nombre: e.target.value })}
                />
              </Field>
              <Field label="Teléfono">
                <Input
                  value={consulta.telefono}
                  onChange={(e) => setConsulta({ ...consulta, telefono: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Dirección">
              <Input
                value={consulta.direccion}
                onChange={(e) => setConsulta({ ...consulta, direccion: e.target.value })}
                placeholder="Av. 19 de Mayo y García Moreno"
              />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Sector o barrio">
                <Input
                  value={consulta.sector}
                  onChange={(e) => setConsulta({ ...consulta, sector: e.target.value })}
                />
              </Field>
              <Field label="Tecnología">
                <Select
                  value={consulta.tecnologia}
                  onChange={(e) => {
                    setConsulta({ ...consulta, tecnologia: e.target.value })
                    setResultado(null)
                  }}
                >
                  <option value="ftth">Fibra</option>
                  <option value="wireless">Radio</option>
                </Select>
              </Field>
              <Field label="Latitud">
                <Input
                  value={consulta.latitud}
                  onChange={(e) => setConsulta({ ...consulta, latitud: e.target.value })}
                />
              </Field>
              <Field label="Longitud">
                <Input
                  value={consulta.longitud}
                  onChange={(e) => setConsulta({ ...consulta, longitud: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Referencia" hint="Cómo llegar: es lo único que sirve donde no hay nomenclatura.">
              <Input
                value={consulta.referencia}
                onChange={(e) => setConsulta({ ...consulta, referencia: e.target.value })}
              />
            </Field>

            <Button
              variante="primario"
              onClick={verificar}
              cargando={verificando}
              disabled={verificando}
              className="w-full"
            >
              Verificar cobertura
            </Button>

            {R && (
              <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                {/* El resultado va con icono Y texto: el color solo no alcanza,
                    y este es justo el dato del que depende una promesa. */}
                <div className="flex items-center gap-2">
                  <R.icono
                    size={20}
                    className={
                      R.color === 'verde'
                        ? 'text-emerald-400'
                        : R.color === 'rojo'
                          ? 'text-red-400'
                          : 'text-amber-400'
                    }
                  />
                  <span className="text-[15px] font-semibold text-slate-100">{R.label}</span>
                </div>
                <p className="text-[12px] text-slate-400">{R.ayuda}</p>

                {resultado.cercanas.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">
                      Lo más cercano
                    </p>
                    {resultado.cercanas.slice(0, 3).map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/60 px-2 py-1.5 text-[12px]"
                      >
                        <span className="text-slate-200">{c.nombre}</span>
                        <span className="tabular-nums text-slate-400">
                          {c.distancia_m} m ·{' '}
                          {c.disponibles == null ? 'capacidad sin cargar' : `${c.disponibles} libres`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <Field label="Notas">
                  <Textarea
                    rows={2}
                    value={consulta.notas}
                    onChange={(e) => setConsulta({ ...consulta, notas: e.target.value })}
                  />
                </Field>
                {/* Dos salidas, porque son dos situaciones. El que preguntó y
                    cortó deja solo la consulta; el que se interesó se carga
                    como prospecto ahí mismo, con las coordenadas y la caja ya
                    puestas — que es lo que después lo hace aparecer en el mapa
                    comercial y en el tablero. */}
                <div className="grid gap-2 md:grid-cols-2">
                  <Button onClick={() => guardar()}>Solo guardar la consulta</Button>
                  <Button variante="primario" onClick={() => guardar({ conProspecto: true })}>
                    Guardar y crear prospecto
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card title="Marcá el punto" subtitle="Hacé clic sobre la casa">
          <div
            ref={contenedor}
            className="h-[440px] w-full overflow-hidden rounded-xl border border-slate-800"
          />
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Object.entries(RESULTADOS).map(([k, v]) => (
          <Stat
            key={k}
            label={v.label}
            valor={historial.filter((h) => h.resultado === k).length}
            color={
              v.color === 'verde'
                ? 'text-emerald-400'
                : v.color === 'rojo'
                  ? 'text-red-400'
                  : 'text-amber-400'
            }
          />
        ))}
      </div>

      <Card
        title="Consultas anteriores"
        subtitle="Los que dieron negativo hace meses pueden estar disponibles hoy: es una lista para volver a llamar"
      >
        <Table
          columnas={['Fecha', 'Dirección', 'Sector', 'Resultado', 'Caja más cercana']}
          filas={historial}
          vacio="Todavía no se verificó ninguna dirección."
          renderFila={(h) => (
            <tr key={h.id} className="hover:bg-slate-800/40">
              <td className="whitespace-nowrap px-3 py-2 text-[12px] text-slate-400">
                {new Date(h.creado_en).toLocaleDateString('es-EC')}
              </td>
              <td className="px-3 py-2 text-slate-200">{h.direccion}</td>
              <td className="px-3 py-2 text-[12px] text-slate-400">{h.sector ?? '—'}</td>
              <td className="px-3 py-2">
                <Badge color={RESULTADOS[h.resultado]?.color ?? 'gris'}>
                  {RESULTADOS[h.resultado]?.label ?? h.resultado}
                </Badge>
              </td>
              <td className="px-3 py-2 text-[12px] tabular-nums text-slate-400">
                {h.distancia_m != null ? `${h.distancia_m} m` : '—'}
                {h.disponibles != null ? ` · ${h.disponibles} libres` : ''}
              </td>
            </tr>
          )}
        />
      </Card>

      {/* Las zonas dibujadas: hasta dónde se promete, más allá de lo tendido */}
      <Card
        title="Zonas de cobertura"
        subtitle="Hasta dónde se vende. Las cajas dicen dónde hay puerto libre hoy; esto, hasta dónde se promete."
        actions={
          <ConPermiso permiso="config.planes" envezDe={null}>
            <Button icon={Plus} onClick={() => setEditandoZona({ ...ZONA_VACIA })}>
              Nueva zona
            </Button>
          </ConPermiso>
        }
      >
        {zonas.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">Sin zonas cargadas.</p>
        ) : (
          <div className="space-y-1.5">
            {zonas.map((z) => (
              <div
                key={z.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-[13px]"
              >
                <div className="flex items-center gap-2">
                  <i
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: z.color }}
                  />
                  <span className="text-slate-200">{z.nombre}</span>
                  <Badge color="gris">{z.tecnologia}</Badge>
                  {z.tipo === 'circulo' && (
                    <span className="text-[11px] text-slate-500">radio {z.radio_m} m</span>
                  )}
                </div>
                <ConPermiso permiso="config.planes" envezDe={null}>
                  <Button
                    variante="fantasma"
                    icon={Trash2}
                    onClick={async () => {
                      if (!await confirmar(`¿Eliminar la zona ${z.nombre}?`)) return
                      try {
                        await ventasApi.eliminarZona(z.id)
                        await recargar()
                      } catch (err) {
                        setError(err)
                      }
                    }}
                  />
                </ConPermiso>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        abierto={!!editandoZona}
        titulo="Nueva zona de cobertura"
        onCerrar={() => setEditandoZona(null)}
      >
        {editandoZona && (
          <div className="space-y-3">
            <Aviso>
              Usá las coordenadas del punto que marcaste arriba, o escribí otras. El radio se dibuja
              en el mapa comercial.
            </Aviso>
            <Field label="Nombre">
              <Input
                value={editandoZona.nombre}
                onChange={(e) => setEditandoZona({ ...editandoZona, nombre: e.target.value })}
              />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Latitud">
                <Input
                  value={editandoZona.centro_lat || consulta.latitud}
                  onChange={(e) => setEditandoZona({ ...editandoZona, centro_lat: e.target.value })}
                />
              </Field>
              <Field label="Longitud">
                <Input
                  value={editandoZona.centro_lng || consulta.longitud}
                  onChange={(e) => setEditandoZona({ ...editandoZona, centro_lng: e.target.value })}
                />
              </Field>
              <Field label="Radio (metros)">
                <Input
                  type="number"
                  value={editandoZona.radio_m}
                  onChange={(e) => setEditandoZona({ ...editandoZona, radio_m: e.target.value })}
                />
              </Field>
              <Field label="Tecnología">
                <Select
                  value={editandoZona.tecnologia}
                  onChange={(e) => setEditandoZona({ ...editandoZona, tecnologia: e.target.value })}
                >
                  <option value="ftth">Fibra</option>
                  <option value="wireless">Radio</option>
                  <option value="ambas">Las dos</option>
                </Select>
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setEditandoZona(null)}>
                Cancelar
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await ventasApi.guardarZona({
                      ...editandoZona,
                      centro_lat: Number(editandoZona.centro_lat || consulta.latitud),
                      centro_lng: Number(editandoZona.centro_lng || consulta.longitud),
                      radio_m: Number(editandoZona.radio_m),
                    })
                    setEditandoZona(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Guardar zona
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
