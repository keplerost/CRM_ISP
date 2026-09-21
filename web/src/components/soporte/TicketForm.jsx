import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  MapPin,
  Radio,
  Save,
  Search,
  User,
  Wrench,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Button, Field, Input, Select, Textarea } from '../ui'
import { FRANJAS, INCIDENCIAS } from '../../lib/soporte'

/**
 * Alta de un ticket, en cuatro pasos.
 *
 * Se parte en pasos porque quien lo llena está con el abonado al teléfono: una
 * pantalla con treinta campos hace que se salteen los importantes. Cada paso es
 * una pregunta que el que atiende ya está haciendo igual —quién sos, dónde
 * vivís, qué tenés, qué te pasa— así que el formulario sigue la conversación.
 *
 * Solo el paso 1 tiene campos obligatorios: un reclamo entra aunque no se sepa
 * la potencia ni el modelo de la ONT. Poner trabas al registro hace que el
 * reclamo termine en un papel.
 */

const PASOS = [
  { titulo: 'Cliente', icon: User, ayuda: 'Quién reclama y cómo ubicarlo' },
  { titulo: 'Ubicación', icon: MapPin, ayuda: 'A dónde tiene que ir el técnico' },
  { titulo: 'Datos técnicos', icon: Radio, ayuda: 'Qué tiene instalado' },
  { titulo: 'Diagnóstico', icon: Wrench, ayuda: 'Qué le pasa y cuándo se va' },
]

const VACIO = {
  client_id: null,
  identificacion: '',
  nombre: '',
  telefono: '',
  telefono_whatsapp: '',
  email: '',
  direccion: '',
  referencia: '',
  sector: '',
  canton: '',
  latitud: '',
  longitud: '',
  tecnologia: 'ftth',
  nap_id: '',
  puerto_nap: '',
  ont_modelo: '',
  ont_serie: '',
  potencia_dbm: '',
  torre_id: '',
  cpe_ip: '',
  frecuencia: '',
  senal_dbm: '',
  antena_modelo: '',
  tipo_incidencia: 'sin_internet',
  descripcion: '',
  prioridad: 'media',
  fecha_visita: '',
  franja: 'manana',
  hora_visita: '',
  tecnico_id: '',
  cuadrilla_id: '',
}

const soloNumero = (v) => (v === '' || v === null ? null : Number(v))
const soloTexto = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim())

export default function TicketForm({ onCreado, onCancelar, onError, clienteInicial = null }) {
  const [paso, setPaso] = useState(0)
  const [form, setForm] = useState(VACIO)
  const [guardando, setGuardando] = useState(false)

  const [busqueda, setBusqueda] = useState('')
  const [encontrados, setEncontrados] = useState([])
  const [buscando, setBuscando] = useState(false)

  const [puntos, setPuntos] = useState([])
  const [tecnicos, setTecnicos] = useState([])
  const [cuadrillas, setCuadrillas] = useState([])

  const set = (campo) => (e) =>
    setForm((f) => ({ ...f, [campo]: e.target.value }))

  useEffect(() => {
    async function cargar() {
      const [p, t, c] = await Promise.all([
        supabase.from('puntos_red').select('id, nombre, tipo').eq('activo', true).order('nombre'),
        supabase.from('tecnicos').select('id, nombre, especialidad').eq('activo', true).order('nombre'),
        supabase.from('cuadrillas').select('id, nombre, zona').eq('activo', true).order('nombre'),
      ])
      setPuntos(p.data ?? [])
      setTecnicos(t.data ?? [])
      setCuadrillas(c.data ?? [])
    }
    cargar()
  }, [])

  // Si se abrió desde la ficha de un abonado, ya viene todo cargado: nadie
  // tiene que volver a tipear lo que el sistema ya sabe.
  useEffect(() => {
    if (clienteInicial) tomarCliente(clienteInicial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteInicial?.id])

  const napsFtth = useMemo(() => puntos.filter((p) => p.tipo === 'nap'), [puntos])
  const torres = useMemo(
    () => puntos.filter((p) => p.tipo === 'torre' || p.tipo === 'antena'),
    [puntos],
  )

  const incidencias = useMemo(
    () => INCIDENCIAS.filter((i) => !i.tecnologia || i.tecnologia === form.tecnologia),
    [form.tecnologia],
  )

  async function buscarCliente(e) {
    e?.preventDefault()
    const q = busqueda.trim()
    if (q.length < 3) return

    setBuscando(true)
    const { data } = await supabase
      .from('v_clientes_ficha')
      .select(
        'id, nombre, identificacion, telefono, telefono_movil, email, direccion, latitud, longitud, ' +
          'tipo_conexion, nap_id, puerto_nap, conectado_a_id, ip_administracion, tipo_antena, ' +
          'onu_serial, rx_power_dbm, saldo',
      )
      .or(`nombre.ilike.%${q}%,identificacion.ilike.%${q}%,ip.ilike.%${q}%`)
      .limit(8)

    setEncontrados(data ?? [])
    setBuscando(false)
  }

  /** Copia del abonado todo lo que el técnico va a necesitar. */
  function tomarCliente(c) {
    // Un abonado por radio se detecta por cómo está conectado, no por lo que
    // elija quien atiende: el que llama no sabe si tiene fibra o antena.
    const wireless = c.tipo_conexion === 'wireless' || Boolean(c.conectado_a_id)

    setForm((f) => ({
      ...f,
      client_id: c.id,
      identificacion: c.identificacion ?? '',
      nombre: c.nombre ?? '',
      telefono: c.telefono ?? '',
      telefono_whatsapp: c.telefono_movil ?? c.telefono ?? '',
      email: c.email ?? '',
      direccion: c.direccion ?? '',
      latitud: c.latitud ?? '',
      longitud: c.longitud ?? '',
      tecnologia: wireless ? 'wireless' : 'ftth',
      nap_id: c.nap_id ?? '',
      puerto_nap: c.puerto_nap ?? '',
      ont_serie: c.onu_serial ?? '',
      potencia_dbm: c.rx_power_dbm ?? '',
      torre_id: c.conectado_a_id ?? '',
      cpe_ip: c.ip_administracion ?? '',
      antena_modelo: c.tipo_antena ?? '',
    }))
    setEncontrados([])
    setBusqueda('')
  }

  const puedeSeguir = paso > 0 || form.nombre.trim().length > 2

  async function guardar(e) {
    e.preventDefault()
    if (!form.nombre.trim()) return onError?.(new Error('Falta el nombre de quien reclama'))

    setGuardando(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()

      const fila = {
        client_id: form.client_id || null,
        identificacion: soloTexto(form.identificacion),
        nombre: form.nombre.trim(),
        telefono: soloTexto(form.telefono),
        telefono_whatsapp: soloTexto(form.telefono_whatsapp),
        email: soloTexto(form.email),
        direccion: soloTexto(form.direccion),
        referencia: soloTexto(form.referencia),
        sector: soloTexto(form.sector),
        canton: soloTexto(form.canton),
        latitud: soloNumero(form.latitud),
        longitud: soloNumero(form.longitud),
        tecnologia: form.tecnologia,
        tipo_incidencia: form.tipo_incidencia,
        descripcion: soloTexto(form.descripcion),
        prioridad: form.prioridad,
        fecha_visita: form.fecha_visita || null,
        franja: form.franja || null,
        hora_visita: form.franja === 'exacta' ? form.hora_visita || null : null,
        tecnico_id: form.tecnico_id || null,
        cuadrilla_id: form.cuadrilla_id || null,
        // Asignado desde el arranque si ya se decidió quién va: obliga a menos
        // clics y el estado dice la verdad.
        estado: form.tecnico_id || form.cuadrilla_id ? 'asignado' : 'abierto',
        created_by: sesion?.user?.id ?? null,
        // Solo los campos de la tecnología elegida: guardar los otros dejaría
        // datos de fibra en un ticket de radio.
        ...(form.tecnologia === 'ftth'
          ? {
              nap_id: form.nap_id || null,
              puerto_nap: soloTexto(form.puerto_nap),
              ont_modelo: soloTexto(form.ont_modelo),
              ont_serie: soloTexto(form.ont_serie),
              potencia_dbm: soloNumero(form.potencia_dbm),
            }
          : {
              torre_id: form.torre_id || null,
              cpe_ip: soloTexto(form.cpe_ip),
              frecuencia: soloTexto(form.frecuencia),
              senal_dbm: soloNumero(form.senal_dbm),
              antena_modelo: soloTexto(form.antena_modelo),
            }),
      }

      const { data, error } = await supabase.from('tickets').insert(fila).select().single()
      if (error) throw error

      onCreado?.(data)
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  function ubicacionActual() {
    if (!navigator.geolocation) return onError?.(new Error('Este dispositivo no da la ubicación'))
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setForm((f) => ({
          ...f,
          latitud: pos.coords.latitude.toFixed(7),
          longitud: pos.coords.longitude.toFixed(7),
        })),
      (err) => onError?.(new Error(`No se pudo tomar la ubicación: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  return (
    <form onSubmit={guardar} className="space-y-5">
      {/* Barra de pasos: en el celular se ven solo los números, en escritorio
          el nombre también. */}
      <ol className="flex items-center gap-1 sm:gap-2">
        {PASOS.map((p, i) => {
          const hecho = i < paso
          const actual = i === paso
          return (
            <li key={p.titulo} className="flex flex-1 items-center gap-1 sm:gap-2">
              <button
                type="button"
                onClick={() => (i <= paso || puedeSeguir) && setPaso(i)}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-2 text-left text-xs transition sm:px-3 ${
                  actual
                    ? 'border-sky-500/50 bg-sky-500/10 text-sky-200'
                    : hecho
                      ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300'
                      : 'border-slate-700 text-slate-500 hover:border-slate-600'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    actual ? 'bg-sky-500 text-white' : hecho ? 'bg-emerald-500 text-white' : 'bg-slate-700'
                  }`}
                >
                  {hecho ? <Check size={13} /> : i + 1}
                </span>
                <span className="hidden truncate sm:block">
                  <b className="block">{p.titulo}</b>
                  <span className="text-[10px] text-slate-500">{p.ayuda}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      {/* ---------------------------------------------------- Paso 1 */}
      {paso === 0 && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && buscarCliente(e)}
                placeholder="Buscar por cédula, nombre o IP…"
              />
              <Button
                type="button"
                variante="secundario"
                icon={Search}
                onClick={buscarCliente}
                cargando={buscando}
              >
                Buscar
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Si ya es abonado, al elegirlo se completan la dirección y los datos del servicio.
            </p>

            {encontrados.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-800 rounded-lg border border-slate-700">
                {encontrados.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => tomarCliente(c)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-800/60"
                    >
                      <span className="min-w-0">
                        <b className="block truncate text-slate-200">{c.nombre}</b>
                        <span className="text-[11px] text-slate-500">
                          {c.identificacion ?? 'sin cédula'} · {c.direccion ?? 'sin dirección'}
                        </span>
                      </span>
                      {Number(c.saldo) > 0.005 && (
                        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                          debe ${Number(c.saldo).toFixed(2)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {form.client_id && (
            <Aviso>
              Ticket vinculado al abonado <b>{form.nombre}</b>. Va a aparecer en su ficha.
            </Aviso>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cédula / RUC">
              <Input value={form.identificacion} onChange={set('identificacion')} />
            </Field>
            <Field label="Nombre completo" hint="Es lo único obligatorio">
              <Input value={form.nombre} onChange={set('nombre')} required />
            </Field>
            <Field label="Teléfono principal">
              <Input type="tel" value={form.telefono} onChange={set('telefono')} />
            </Field>
            <Field label="WhatsApp" hint="Por acá se le avisa cuando el técnico sale">
              <Input
                type="tel"
                value={form.telefono_whatsapp}
                onChange={set('telefono_whatsapp')}
              />
            </Field>
            <Field label="Email" className="sm:col-span-2" hint="Para mandarle el acta de cierre">
              <Input type="email" value={form.email} onChange={set('email')} />
            </Field>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- Paso 2 */}
      {paso === 1 && (
        <div className="space-y-4">
          <Field label="Dirección" className="sm:col-span-2">
            <Input value={form.direccion} onChange={set('direccion')} placeholder="Calle principal y transversal, número" />
          </Field>

          <Field
            label="Referencia del domicilio"
            hint="Lo que se ve desde la calle: el color de la casa, el negocio de la esquina"
          >
            <Textarea rows={2} value={form.referencia} onChange={set('referencia')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sector / barrio">
              <Input value={form.sector} onChange={set('sector')} />
            </Field>
            <Field label="Cantón">
              <Input value={form.canton} onChange={set('canton')} />
            </Field>
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Latitud">
                <Input value={form.latitud} onChange={set('latitud')} placeholder="-0.9312500" />
              </Field>
              <Field label="Longitud">
                <Input value={form.longitud} onChange={set('longitud')} placeholder="-78.6155000" />
              </Field>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variante="secundario" icon={MapPin} onClick={ubicacionActual}>
                Usar mi ubicación
              </Button>
              {form.latitud && form.longitud && (
                <a
                  href={`https://www.google.com/maps?q=${form.latitud},${form.longitud}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Ver en el mapa
                </a>
              )}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Con coordenadas el técnico navega al punto exacto. Sin ellas tiene que preguntar en
              el barrio.
            </p>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- Paso 3 */}
      {paso === 2 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {[
              { valor: 'ftth', label: 'FTTH — Fibra', detalle: 'NAP, puerto, ONT, potencia' },
              { valor: 'wireless', label: 'Wireless — Radio', detalle: 'Torre, CPE, señal, antena' },
            ].map((t) => (
              <button
                key={t.valor}
                type="button"
                onClick={() => setForm((f) => ({ ...f, tecnologia: t.valor }))}
                className={`rounded-lg border p-3 text-left transition ${
                  form.tecnologia === t.valor
                    ? 'border-sky-500/60 bg-sky-500/10 text-sky-200'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                <b className="block text-sm">{t.label}</b>
                <span className="text-[11px] text-slate-500">{t.detalle}</span>
              </button>
            ))}
          </div>

          {form.tecnologia === 'ftth' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Caja NAP">
                <Select value={form.nap_id} onChange={set('nap_id')}>
                  <option value="">— sin definir —</option>
                  {napsFtth.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Puerto">
                <Input value={form.puerto_nap} onChange={set('puerto_nap')} />
              </Field>
              <Field label="Modelo de ONT">
                <Input value={form.ont_modelo} onChange={set('ont_modelo')} placeholder="HG8145V5" />
              </Field>
              <Field label="Serie de ONT">
                <Input value={form.ont_serie} onChange={set('ont_serie')} />
              </Field>
              <Field label="Potencia (dBm)" hint="La que se leyó al reportar la falla">
                <Input
                  type="number"
                  step="0.01"
                  value={form.potencia_dbm}
                  onChange={set('potencia_dbm')}
                  placeholder="-24.50"
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nodo / torre">
                <Select value={form.torre_id} onChange={set('torre_id')}>
                  <option value="">— sin definir —</option>
                  {torres.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="IP del CPE">
                <Input value={form.cpe_ip} onChange={set('cpe_ip')} placeholder="10.10.0.25" />
              </Field>
              <Field label="Frecuencia">
                <Input value={form.frecuencia} onChange={set('frecuencia')} placeholder="5180 MHz" />
              </Field>
              <Field label="Señal (dBm)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.senal_dbm}
                  onChange={set('senal_dbm')}
                  placeholder="-65"
                />
              </Field>
              <Field label="Modelo de antena">
                <Input value={form.antena_modelo} onChange={set('antena_modelo')} placeholder="LiteBeam 5AC" />
              </Field>
            </div>
          )}
        </div>
      )}

      {/* ---------------------------------------------------- Paso 4 */}
      {paso === 3 && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tipo de incidencia">
              <Select value={form.tipo_incidencia} onChange={set('tipo_incidencia')}>
                {incidencias.map((i) => (
                  <option key={i.valor} value={i.valor}>
                    {i.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Prioridad">
              <div className="flex gap-2">
                {[
                  { v: 'alta', label: 'Alta', clase: 'border-rose-500/60 bg-rose-500/15 text-rose-200' },
                  { v: 'media', label: 'Media', clase: 'border-amber-500/60 bg-amber-500/15 text-amber-200' },
                  { v: 'baja', label: 'Baja', clase: 'border-slate-500/60 bg-slate-500/15 text-slate-200' },
                ].map((p) => (
                  <button
                    key={p.v}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, prioridad: p.v }))}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm transition ${
                      form.prioridad === p.v ? p.clase : 'border-slate-700 text-slate-400'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <Field
            label="Qué reporta el abonado"
            hint="Con las palabras del cliente: al técnico le sirve más que un diagnóstico apurado"
          >
            <Textarea rows={3} value={form.descripcion} onChange={set('descripcion')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Fecha de visita">
              <Input type="date" value={form.fecha_visita} onChange={set('fecha_visita')} />
            </Field>
            <Field label="Franja horaria">
              <Select value={form.franja} onChange={set('franja')}>
                {Object.entries(FRANJAS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            {form.franja === 'exacta' && (
              <Field label="Hora">
                <Input type="time" value={form.hora_visita} onChange={set('hora_visita')} />
              </Field>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Técnico" hint="O dejalo sin asignar y se decide después">
              <Select
                value={form.tecnico_id}
                onChange={(e) => setForm((f) => ({ ...f, tecnico_id: e.target.value, cuadrilla_id: '' }))}
              >
                <option value="">— sin asignar —</option>
                {tecnicos
                  .filter((t) => t.especialidad === 'ambas' || t.especialidad === form.tecnologia)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
              </Select>
            </Field>

            <Field label="O cuadrilla">
              <Select
                value={form.cuadrilla_id}
                onChange={(e) => setForm((f) => ({ ...f, cuadrilla_id: e.target.value, tecnico_id: '' }))}
              >
                <option value="">— sin asignar —</option>
                {cuadrillas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                    {c.zona ? ` · ${c.zona}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {(form.tecnico_id || form.cuadrilla_id) && (
            <Aviso>El ticket nace <b>asignado</b>: ya tiene a quién le toca.</Aviso>
          )}
        </div>
      )}

      {/* ---------------------------------------------------- Navegación */}
      <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-4">
        <Button
          type="button"
          variante="fantasma"
          icon={ArrowLeft}
          onClick={() => (paso === 0 ? onCancelar?.() : setPaso((p) => p - 1))}
        >
          {paso === 0 ? 'Cancelar' : 'Atrás'}
        </Button>

        <div className="flex gap-2">
          {paso < PASOS.length - 1 ? (
            <>
              {paso > 0 && (
                <Button type="submit" variante="secundario" icon={Save} cargando={guardando}>
                  Guardar así
                </Button>
              )}
              <Button
                type="button"
                variante="primario"
                icon={ArrowRight}
                onClick={() => setPaso((p) => p + 1)}
                disabled={!puedeSeguir}
              >
                Siguiente
              </Button>
            </>
          ) : (
            <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
              Crear ticket
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
