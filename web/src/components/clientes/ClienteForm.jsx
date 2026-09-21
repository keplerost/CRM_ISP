import { useEffect, useMemo, useState } from 'react'
import { Save, Wand2 } from 'lucide-react'
import { useTabla } from '../../lib/useTabla'
import { supabase } from '../../lib/supabaseClient'
import { libresDe, perteneceA } from '../../lib/ip'
import { claveSugerida, usuarioSugerido } from '../../lib/instalaciones'
import { Aviso, Button, ErrorBanner, Field, Input, Select } from '../ui'

/**
 * Alta y edición de un cliente.
 *
 * Los datos de red (IP, PPPoE) vienen del router al importar. Los fiscales
 * —identificación, correo, dirección— no están en el MikroTik y hay que
 * cargarlos: sin identificación no se le puede emitir un comprobante.
 */

const TIPOS_ID = [
  { codigo: '05', label: 'Cédula' },
  { codigo: '04', label: 'RUC' },
  { codigo: '06', label: 'Pasaporte' },
  { codigo: '07', label: 'Consumidor final' },
  { codigo: '08', label: 'Identificación del exterior' },
]

const VACIO = {
  nombre: '',
  tipo_identificacion: '05',
  identificacion: '',
  email: '',
  telefono: '',
  direccion: '',
  tipo_conexion: 'ip',
  ip: '',
  red_ipv4: '',
  usuario_ppp: '',
  clave_ppp: '',
  velocidad_cruda: '',
  precio_mensual: '',
  dia_facturacion: '',
  router_id: '',
  plan_id: '',
  estado: 'activo',
}

const desdeFila = (c) => ({
  ...VACIO,
  ...Object.fromEntries(Object.entries(c).filter(([, v]) => v != null)),
})

/** 51200 → "50 Mbps". Es como el operador piensa la velocidad, no en kbps. */
/**
 * En el alta solo se ofrecen las redes de IP asignada a mano.
 *
 * Es la contracara del formulario: acá se carga una IP en un campo, y eso solo
 * tiene sentido en una red estática o de CGNAT. En un pool de PPPoE la
 * dirección la reparte el servidor cuando el abonado se autentica, así que
 * elegir una acá sería cargar un dato que el equipo va a ignorar.
 *
 * `nodos` queda afuera siempre: son redes de infraestructura, no de abonados.
 */
const REDES_DEL_ALTA = ['estatica', 'cgnat']

const mbps = (kbps) => (kbps ? `${Math.round(kbps / 1000)} Mbps` : '—')

/** Longitud esperada según el tipo: cédula 10, RUC 13. */
const LARGO_ESPERADO = { '05': 10, '04': 13 }

export default function ClienteForm({ cliente = null, onGuardado, onCancelar }) {
  const editando = Boolean(cliente)
  const { filas: routers } = useTabla('routers_mikrotik')
  const { filas: planes } = useTabla('planes_velocidad', { orderBy: 'nombre', ascending: true })
  const { filas: redes } = useTabla('v_subredes', { orderBy: 'numero', ascending: true })

  // Las direcciones ya tomadas de la red elegida. Se piden al cambiar de red y
  // no al abrir: son cientos por red y casi siempre se usa una sola.
  const [ocupadas, setOcupadas] = useState([])

  const [form, setForm] = useState(() => (cliente ? desdeFila(cliente) : VACIO))
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  // Hotspot se comporta como PPPoE para esto: los dos piden usuario y clave.
  const esPppoe = ['pppoe', 'hotspot'].includes(form.tipo_conexion)

  const redElegida = redes.find((r) => r.cidr === form.red_ipv4) ?? null
  const planElegido = planes.find((p) => p.id === form.plan_id) ?? null

  /**
   * Al cambiar de red se traen las direcciones que ya están tomadas.
   *
   * Se miran dos fuentes porque ninguna alcanza sola: `v_direcciones_ip` tiene
   * lo que el sistema ve en los equipos, y `clientes.ip` lo que alguien cargó a
   * mano. Una IP puede estar en la ficha de un abonado y todavía no aparecer en
   * el router —el alta se carga antes de ir a instalarla— y proponerla otra vez
   * termina en dos abonados con la misma dirección.
   */
  useEffect(() => {
    if (!redElegida) {
      setOcupadas([])
      return
    }
    let vivo = true
    Promise.all([
      supabase.from('v_direcciones_ip').select('ip_address').eq('subred_id', redElegida.id),
      supabase.from('clientes').select('ip').not('ip', 'is', null),
    ]).then(([a, b]) => {
      if (!vivo) return
      setOcupadas([
        ...(a.data ?? []).map((x) => x.ip_address),
        ...(b.data ?? []).map((x) => x.ip),
      ])
    })
    return () => {
      vivo = false
    }
  }, [redElegida?.id])

  const libres = useMemo(
    () =>
      redElegida
        ? // El gateway va como una dirección ocupada más: es la del router, y
          // proponérsela a un abonado deja a los dos peleando por la misma IP
          // —el cliente sin internet y, según el equipo, el segmento entero—.
          libresDe(redElegida.cidr, [...ocupadas, redElegida.gateway].filter(Boolean))
        : [],
    [redElegida?.cidr, redElegida?.gateway, ocupadas],
  )

  // `null` cuando no hay red elegida o la IP está vacía: no hay nada que objetar.
  const ipFueraDeRed =
    form.ip && redElegida ? perteneceA(form.ip, redElegida.cidr) === false : false

  const precioDistinto =
    planElegido &&
    form.precio_mensual !== '' &&
    Math.abs(Number(form.precio_mensual) - Number(planElegido.precio)) > 0.005

  const largo = LARGO_ESPERADO[form.tipo_identificacion]
  const idIncompleta =
    largo && form.identificacion && form.identificacion.replace(/\D/g, '').length !== largo

  async function guardar(e) {
    e.preventDefault()
    setError(null)

    /**
     * Sin plan no se da de alta.
     *
     * Un abonado sin plan no es un abonado incompleto: es uno que después no
     * tiene velocidad para aplicar en el router, ni perfil PPPoE, y que en los
     * informes figura sin plan para siempre. El problema aparece semanas
     * después, cuando ya nadie recuerda ese alta.
     *
     * Se valida acá y no solo con el `required` del navegador porque las fichas
     * viejas pueden venir sin plan, y al editarlas el formulario tiene que
     * pedirlo igual.
     */
    if (!form.plan_id) {
      setError(new Error('Elegí un plan. Sin plan no se le puede aplicar velocidad ni facturar el precio de lista.'))
      return
    }

    setGuardando(true)
    try {
      await onGuardado({
        nombre: form.nombre,
        tipo_identificacion: form.tipo_identificacion,
        identificacion: form.identificacion || null,
        email: form.email || null,
        telefono: form.telefono || null,
        direccion: form.direccion || null,
        tipo_conexion: form.tipo_conexion || 'ip',
        /**
         * Los datos de la otra forma de conexión no se guardan.
         *
         * Un abonado IPoE con usuario PPPoE cargado —o al revés— es una ficha
         * que parece completa y no funciona: la velocidad se aplica en el lugar
         * equivocado y nadie entiende por qué. Se guarda solo lo que corresponde
         * a lo que se eligió.
         */
        ip: esPppoe ? null : form.ip || null,
        red_ipv4: esPppoe ? null : form.red_ipv4 || null,
        usuario_ppp: esPppoe ? form.usuario_ppp || null : null,
        clave_ppp: esPppoe ? form.clave_ppp || null : null,
        velocidad_cruda: form.velocidad_cruda || null,
        precio_mensual: form.precio_mensual ? Number(form.precio_mensual) : null,
        dia_facturacion: form.dia_facturacion ? Number(form.dia_facturacion) : null,
        router_id: form.router_id || null,
        plan_id: form.plan_id || null,
        estado: form.estado,
      })
      if (!editando) setForm(VACIO)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre o razón social" className="sm:col-span-2">
          <Input value={form.nombre} onChange={set('nombre')} placeholder="JUAN PÉREZ" required />
        </Field>

        <Field label="Tipo de identificación">
          <Select value={form.tipo_identificacion} onChange={set('tipo_identificacion')}>
            {TIPOS_ID.map((t) => (
              <option key={t.codigo} value={t.codigo}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Identificación"
          hint={largo ? `${largo} dígitos` : 'Requerida para facturar'}
        >
          <Input
            value={form.identificacion}
            onChange={set('identificacion')}
            placeholder={form.tipo_identificacion === '04' ? '1790012345001' : '1712345678'}
          />
        </Field>

        <Field label="Correo" hint="Ahí se envía la factura electrónica">
          <Input type="email" value={form.email} onChange={set('email')} />
        </Field>

        <Field label="Teléfono">
          <Input value={form.telefono} onChange={set('telefono')} />
        </Field>

        <Field label="Dirección" className="sm:col-span-2">
          <Input value={form.direccion} onChange={set('direccion')} />
        </Field>
      </div>

      {idIncompleta && (
        <Aviso tipo="alerta">
          La {form.tipo_identificacion === '04' ? 'RUC' : 'cédula'} debería tener {largo} dígitos y
          tiene {form.identificacion.replace(/\D/g, '').length}. El SRI rechaza el comprobante si no
          coincide.
        </Aviso>
      )}

      <div className="border-t border-slate-800 pt-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Servicio
        </p>

        {precioDistinto && (
          <div className="mb-3">
            <Aviso tipo="alerta">
              {planElegido.nombre} cuesta <b>${planElegido.precio}</b> y estás poniendo{' '}
              <b>${form.precio_mensual}</b>. Se le va a facturar lo que pusiste. Si es un acuerdo,
              dejalo escrito en Facturación → Descuento acordado.
            </Aviso>
          </div>
        )}

        {!esPppoe && ipFueraDeRed && (
          <div className="mb-3">
            <Aviso tipo="alerta">
              <b>{form.ip}</b> no pertenece a {redElegida.cidr}. Revisá la red o la dirección: una
              IP fuera del bloque no navega y el problema aparece recién en la instalación.
            </Aviso>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label="Tipo de conexión"
            hint="Define qué datos hacen falta abajo"
          >
            <Select value={form.tipo_conexion} onChange={set('tipo_conexion')}>
              <option value="ip">IPoE (IP directa, fija o por DHCP)</option>
              <option value="pppoe">PPPoE (usuario y clave)</option>
              <option value="hotspot">Hotspot</option>
            </Select>
          </Field>

          <Field label="Router">
            <Select value={form.router_id} onChange={set('router_id')}>
              <option value="">— sin asignar —</option>
              {routers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nombre}
                </option>
              ))}
            </Select>
          </Field>

          {!esPppoe && (
            <>
              {/* Solo en IPoE: en PPPoE la direccion la reparte el servidor al autenticarse. */}
          <Field label="Red IPv4" hint="De las cargadas en Red → Redes IPv4">
            <Select
              value={form.red_ipv4}
              onChange={(e) => setForm((f) => ({ ...f, red_ipv4: e.target.value, ip: '' }))}
            >
              <option value="">— sin definir —</option>
              {redes
                .filter((r) => REDES_DEL_ALTA.includes(r.tipo))
                .map((r) => (
                  <option key={r.id} value={r.cidr}>
                    {r.nombre} · {r.cidr} ({r.asignadas ?? 0}/{r.utilizables ?? 0})
                  </option>
                ))}
            </Select>
          </Field>

          <Field
            label="IP"
            hint={
              redElegida
                ? `${libres.length}${libres.length === 250 ? '+' : ''} libres en ${redElegida.cidr}`
                : 'Elegí una red para ver las libres'
            }
          >
            <div className="flex gap-2">
              {/* `list` y no un <select> cerrado: se puede elegir de la lista o
                  escribir una dirección que el sistema todavía no conoce —una
                  reservada a mano, por ejemplo—. */}
              <Input
                list="ips-libres"
                value={form.ip}
                onChange={set('ip')}
                placeholder={redElegida ? libres[0] : '172.16.10.5'}
                className="font-mono"
              />
              <datalist id="ips-libres">
                {libres.map((ip) => (
                  <option key={ip} value={ip} />
                ))}
              </datalist>
              <Button
                type="button"
                variante="secundario"
                icon={Wand2}
                title="Poner la primera dirección libre de esta red"
                disabled={!libres.length}
                onClick={() => setForm((f) => ({ ...f, ip: libres[0] }))}
              >
                Sugerir
              </Button>
            </div>
          </Field>

            </>
          )}
          {esPppoe && (
            <>
              {/* Solo en PPPoE y Hotspot: en IPoE no hay usuario que autenticar. */}
          <Field
            label="Usuario PPPoE"
            hint="Generar lo propone a partir del nombre"
          >
            <div className="flex gap-2">
              <Input
                value={form.usuario_ppp}
                onChange={set('usuario_ppp')}
                className="font-mono"
              />
              <Button
                type="button"
                variante="secundario"
                icon={Wand2}
                title="Proponer usuario y contraseña"
                disabled={!form.nombre.trim()}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    usuario_ppp: usuarioSugerido({
                      nombre: f.nombre,
                      identificacion: f.identificacion,
                    }),
                    clave_ppp: claveSugerida(),
                  }))
                }
              >
                Generar
              </Button>
            </div>
          </Field>

          {/*
            La clave va al lado y a la vista.
            Una contraseña PPPoE no es un secreto que se protege del que está
            sentado acá: es un dato que el técnico tiene que leer para cargarlo
            en la ONT. Ocultarla solo agrega un clic.
          */}
          <Field label="Contraseña PPPoE">
            <Input
              value={form.clave_ppp}
              onChange={set('clave_ppp')}
              autoComplete="off"
              className="font-mono"
            />
          </Field>

            </>
          )}
          <Field label="Plan *" hint="De él salen la velocidad y el precio">
            <Select
              value={form.plan_id}
              required
              onChange={(e) => {
                const id = e.target.value
                const p = planes.find((x) => x.id === id)
                setForm((f) => ({
                  ...f,
                  plan_id: id,
                  // El precio se completa con el del plan, salvo que alguien ya
                  // haya escrito uno: ahí manda lo que se acordó con el abonado.
                  precio_mensual: f.precio_mensual === '' && p ? String(p.precio) : f.precio_mensual,
                }))
              }}
            >
              <option value="">— elegir —</option>
              {planes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre} — {mbps(p.bajada_kbps)} — ${p.precio}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Precio mensual" hint="Sin IVA. Se completa con el del plan">
            <Input
              type="number"
              step="0.01"
              value={form.precio_mensual}
              onChange={set('precio_mensual')}
            />
          </Field>

          <Field label="Día de facturación" hint="1 a 28">
            <Input
              type="number"
              min={1}
              max={28}
              value={form.dia_facturacion}
              onChange={set('dia_facturacion')}
            />
          </Field>

          <Field label="Estado">
            <Select value={form.estado} onChange={set('estado')}>
              <option value="activo">activo</option>
              <option value="cortado">cortado</option>
              <option value="suspendido">suspendido</option>
              <option value="baja">baja</option>
            </Select>
          </Field>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="flex justify-end gap-2">
        {onCancelar && (
          <Button type="button" variante="fantasma" onClick={onCancelar}>
            Cancelar
          </Button>
        )}
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          {editando ? 'Guardar cambios' : 'Crear cliente'}
        </Button>
      </div>
    </form>
  )
}
