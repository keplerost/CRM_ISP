import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { dineroCero as dinero } from '../../lib/formato'
import { Link } from 'react-router-dom'
import { Check, Plus, Trash2, Wrench, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import BuscadorCliente from '../pagos/BuscadorCliente'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  Field,
  Input,
  Select,
  Stat,
  Table,
  Textarea,
} from '../ui'

/**
 * Visitas al domicilio: el alta, un traslado, una reparación.
 *
 * El mismo componente sirve para la ficha de un cliente y para la agenda
 * general. Con `cliente` muestra las de ese abonado; sin él, las de todos y
 * pide a quién corresponde cada una.
 */

const TIPOS = [
  { valor: 'nueva', label: 'Instalación nueva' },
  { valor: 'traslado', label: 'Traslado' },
  { valor: 'reparacion', label: 'Reparación' },
  { valor: 'revision', label: 'Revisión' },
  { valor: 'retiro', label: 'Retiro de equipos' },
]

const COLOR_ESTADO = {
  // 'prospecto' es el estado inicial desde que Instalaciones también recibe a
  // los que todavía no son abonados (migración 31).
  prospecto: 'gris',
  agendada: 'azul',
  en_curso: 'ambar',
  hecha: 'verde',
  cancelada: 'gris',
}

const hoy = () => new Date().toISOString().slice(0, 10)
const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')

const VACIA = {
  tipo: 'nueva',
  estado: 'agendada',
  /**
   * Cómo llega el servicio a la casa. No es un detalle de la orden: cambia el
   * asistente entero del técnico.
   *
   * En fibra mide potencia óptica y puerto PON, y el segmento de red sale de la
   * OLT. En radio mide señal y CCQ, y el segmento sale del router del nodo.
   *
   * Antes no se preguntaba acá y la base ponía `ftth` por defecto: TODA orden
   * agendada desde la ficha decía fibra, y el técnico de radio se encontraba
   * con una pantalla que le pedía el nivel óptico de una antena.
   */
  tecnologia: 'ftth',
  fecha: hoy(),
  hora: '',
  tecnico: '',
  equipo: '',
  metros_cable: '',
  costo: '',
  direccion: '',
  notas: '',
}

export default function FichaInstalaciones({ cliente = null, onError, onGuardado }) {
  const confirmar = useConfirmar()
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [form, setForm] = useState(VACIA)
  const [destino, setDestino] = useState(cliente)
  const [guardando, setGuardando] = useState(false)
  const [filtro, setFiltro] = useState('')

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const recargar = useCallback(async () => {
    setCargando(true)
    let consulta = supabase.from('v_instalaciones').select('*').order('fecha', { ascending: false })
    if (cliente) consulta = consulta.eq('client_id', cliente.id)
    else if (filtro) consulta = consulta.eq('estado', filtro)

    const { data, error } = await consulta
    if (error) onError?.(error)
    setFilas(data ?? [])
    setCargando(false)
  }, [cliente, filtro, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function crear(e) {
    e.preventDefault()
    const paraQuien = cliente ?? destino
    if (!paraQuien) return onError?.(new Error('Elegí a qué cliente corresponde la visita'))

    setGuardando(true)
    onError?.(null)
    try {
      const { data: sesion } = await supabase.auth.getUser()
      /**
       * Lo que ya decidió la oficina viaja con la orden.
       *
       * ── Por qué esto importa ──
       *
       * Sin estos campos, la instalación toma los valores por defecto de la
       * base: `pppoe`, `fija`, `ftth`. O sea que TODA orden le decía al técnico
       * que el abonado es PPPoE, fuera lo que fuera — y el técnico, parado en la
       * casa del cliente, no tiene cómo saber que eso es un valor por defecto y
       * no una decisión.
       *
       * El tipo de conexión no es algo que se elija en la calle: sale del diseño
       * de la red. El técnico lo confirma o lo corrige, pero tiene que llegar
       * viendo lo que corresponde.
       *
       * Se lee de la ficha y no se pregunta acá: preguntarlo dos veces es una
       * oportunidad más de que las dos respuestas no coincidan.
       */
      /**
       * Se leen de la base y no del objeto que tenemos a mano.
       *
       * `paraQuien` puede venir de la ficha del abonado —que trae todo— o del
       * buscador de la pantalla de instalaciones, que trae lo justo para
       * mostrar un nombre. Confiar en el objeto haría que la herencia funcione
       * desde un lado y desde el otro no, sin ningún error visible: la orden
       * saldría con los valores por defecto y nadie sabría por qué.
       */
      const { data: ficha } = await supabase
        .from('clientes')
        .select('tipo_conexion, tipo_ip, plan_id, router_id')
        .eq('id', paraQuien.id)
        .maybeSingle()

      const { error } = await supabase.from('instalaciones').insert({
        client_id: paraQuien.id,
        tecnologia: form.tecnologia,
        ...(ficha?.tipo_conexion ? { tipo_conexion: ficha.tipo_conexion } : {}),
        ...(ficha?.tipo_ip ? { tipo_ip: ficha.tipo_ip } : {}),
        ...(ficha?.plan_id ? { plan_id: ficha.plan_id } : {}),
        ...(ficha?.router_id ? { router_id: ficha.router_id } : {}),
        tipo: form.tipo,
        estado: form.estado,
        fecha: form.fecha,
        hora: form.hora || null,
        tecnico: form.tecnico.trim() || null,
        equipo: form.equipo.trim() || null,
        metros_cable: form.metros_cable === '' ? null : Number(form.metros_cable),
        costo: form.costo === '' ? 0 : Number(form.costo),
        // Si no se indica otra, se asume el domicilio que ya tiene cargado.
        direccion: form.direccion.trim() || paraQuien.direccion || null,
        notas: form.notas.trim() || null,
        created_by: sesion?.user?.id ?? null,
      })
      if (error) throw error

      setForm(VACIA)
      if (!cliente) setDestino(null)
      await recargar()
      // La visita hecha completa la fecha de instalación y da de alta al
      // cliente: hay que releer su ficha para que la pantalla lo muestre.
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  async function cambiarEstado(i, estado) {
    const { error } = await supabase.from('instalaciones').update({ estado }).eq('id', i.id)
    if (error) return onError?.(error)
    await recargar()
    await onGuardado?.()
  }

  async function eliminar(i) {
    if (!await confirmar(`¿Eliminar la visita del ${fecha(i.fecha)}?`)) return
    const { error } = await supabase.from('instalaciones').delete().eq('id', i.id)
    if (error) onError?.(error)
    else await recargar()
  }

  const pendientes = filas.filter((f) => ['agendada', 'en_curso'].includes(f.estado)).length

  return (
    <div className="space-y-4">
      {!cliente && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Visitas registradas" valor={filas.length} icon={Wrench} />
          <Stat label="Pendientes" valor={pendientes} color="text-amber-400" />
          <Stat
            label="Cobrado en visitas"
            valor={dinero(filas.reduce((s, f) => s + Number(f.costo ?? 0), 0))}
          />
        </div>
      )}

      <Card title={cliente ? 'Agendar una visita' : 'Nueva instalación'} icon={Plus}>
        <form onSubmit={crear} className="space-y-4">
          {!cliente &&
            (destino ? (
              <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
                <span className="text-sm text-slate-100">{destino.nombre}</span>
                <Button type="button" variante="fantasma" icon={X} onClick={() => setDestino(null)}>
                  Cambiar
                </Button>
              </div>
            ) : (
              <BuscadorCliente onElegir={setDestino} autoFocus={false} />
            ))}

          {(cliente || destino) && (
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <Field label="Tipo">
                <Select value={form.tipo} onChange={set('tipo')}>
                  {TIPOS.map((t) => (
                    <option key={t.valor} value={t.valor}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Tecnología"
                hint="Cambia el asistente del técnico: qué mide y de dónde sale la red"
              >
                <Select value={form.tecnologia} onChange={set('tecnologia')}>
                  <option value="ftth">Fibra óptica (FTTH)</option>
                  <option value="wireless">Radioenlace</option>
                </Select>
              </Field>
              <Field label="Estado">
                <Select value={form.estado} onChange={set('estado')}>
                  <option value="agendada">Agendada</option>
                  <option value="en_curso">En curso</option>
                  <option value="hecha">Hecha</option>
                </Select>
              </Field>
              <Field label="Fecha">
                <Input type="date" value={form.fecha} onChange={set('fecha')} required />
              </Field>
              <Field label="Hora">
                <Input type="time" value={form.hora} onChange={set('hora')} />
              </Field>

              <Field label="Técnico">
                <Input value={form.tecnico} onChange={set('tecnico')} placeholder="Quién va" />
              </Field>
              <Field label="Equipo instalado">
                <Input value={form.equipo} onChange={set('equipo')} placeholder="ONU, router…" />
              </Field>
              <Field label="Metros de cable">
                <Input
                  type="number"
                  min={0}
                  value={form.metros_cable}
                  onChange={set('metros_cable')}
                />
              </Field>
              <Field label="Costo cobrado">
                <Input type="number" step="0.01" min={0} value={form.costo} onChange={set('costo')} />
              </Field>

              <Field label="Dirección" className="sm:col-span-2" hint="Vacío = la del cliente">
                <Input value={form.direccion} onChange={set('direccion')} />
              </Field>
              <Field label="Notas" className="sm:col-span-2">
                <Textarea rows={2} value={form.notas} onChange={set('notas')} />
              </Field>

              <div className="flex items-end pb-1 sm:col-span-3 lg:col-span-4">
                <Button type="submit" variante="primario" icon={Plus} cargando={guardando}>
                  Registrar visita
                </Button>
              </div>
            </div>
          )}
        </form>
      </Card>

      <Card
        title={cliente ? 'Historial de visitas' : 'Instalaciones'}
        icon={Wrench}
        actions={
          !cliente && (
            <Select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="w-44">
              <option value="">Todas</option>
              <option value="agendada">Agendadas</option>
              <option value="en_curso">En curso</option>
              <option value="hecha">Hechas</option>
              <option value="cancelada">Canceladas</option>
            </Select>
          )
        }
      >
        {cargando ? (
          <Cargando />
        ) : filas.length === 0 ? (
          <Aviso>Todavía no hay visitas registradas.</Aviso>
        ) : (
          <Table
            columnas={[
              ...(cliente ? [] : ['Cliente']),
              'Fecha',
              'Tipo',
              'Técnico',
              'Equipo',
              'Costo',
              'Estado',
              '',
            ]}
            filas={filas}
            renderFila={(i) => (
              <tr key={i.id} className="text-slate-300">
                {!cliente && (
                  <td className="px-3 py-2">
                    <Link
                      to={`/clientes/${i.client_id}`}
                      className="text-slate-100 hover:text-sky-400 hover:underline"
                    >
                      {i.cliente ?? '—'}
                    </Link>
                  </td>
                )}
                <td className="px-3 py-2 text-xs">
                  {fecha(i.fecha)}
                  {i.hora && <span className="ml-1 text-slate-500">{String(i.hora).slice(0, 5)}</span>}
                </td>
                <td className="px-3 py-2 text-xs capitalize">{i.tipo.replace('_', ' ')}</td>
                <td className="px-3 py-2 text-xs">{i.tecnico ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{i.equipo ?? '—'}</td>
                <td className="px-3 py-2">{dinero(i.costo)}</td>
                <td className="px-3 py-2">
                  <Badge color={COLOR_ESTADO[i.estado] ?? 'gris'}>
                    {i.estado.replace('_', ' ')}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    {['agendada', 'en_curso'].includes(i.estado) && (
                      <>
                        <Button
                          variante="fantasma"
                          icon={Check}
                          title="Marcar como hecha"
                          onClick={() => cambiarEstado(i, 'hecha')}
                        />
                        <Button
                          variante="fantasma"
                          icon={X}
                          title="Cancelar la visita"
                          onClick={() => cambiarEstado(i, 'cancelada')}
                        />
                      </>
                    )}
                    <Button variante="fantasma" icon={Trash2} onClick={() => eliminar(i)} />
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>
    </div>
  )
}
