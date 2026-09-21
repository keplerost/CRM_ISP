import { useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Link } from 'react-router-dom'
import { Antenna, Eye, EyeOff, MapPin, Radio, Router as RouterIcon, Save, Wand2, Wifi } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useTabla } from '../../lib/useTabla'
import { libresDe, perteneceA } from '../../lib/ip'
import { claveSugerida, usuarioSugerido } from '../../lib/instalaciones'
import { api } from '../../lib/apiNetwork'
import ResumenServicio from './ResumenServicio'
import { Aviso, Badge, Button, Card, Field, Input, Select, Textarea } from '../ui'

/**
 * Servicio del abonado.
 *
 * Es la pantalla de la migración: cuando un cliente se pasa de nodo hay que
 * cambiarle el router, la IP, la caja NAP y —si es radioenlace— la antena a la
 * que apunta. Todo eso se edita junto porque se cambia junto.
 *
 * El tipo de conexión lo elige quien carga el servicio, al lado del router: un
 * mismo equipo puede tener unos abonados por PPPoE y otros con IP fija, así que
 * no se puede deducir del router. Los campos de usuario y clave aparecen recién
 * cuando se elige PPPoE o hotspot; mostrarlos siempre invita a llenarlos con
 * datos que no van a ningún lado.
 *
 * La ONU no se edita acá: se registra desde la OLT. Editarla dejaría la base
 * diciendo una cosa y el equipo otra.
 */

/**
 * Qué redes puede usar cada forma de entregar la conexión.
 *
 * ── Por qué importa ──
 *
 * Un pool de PPPoE reparte las direcciones cuando el abonado se autentica: no
 * se le fija ninguna a mano. Una red estática es al revés — se la asigna el
 * operador. Elegir un pool para un abonado de IP directa deja una ficha que
 * parece completa y un cliente que no navega, y eso se descubre con el técnico
 * ya parado en la casa.
 *
 * `nodos` no aparece nunca: son las redes de la infraestructura —enlaces entre
 * equipos, gestión— y ahí no va un abonado.
 */
const REDES_SEGUN_CONEXION = {
  ip: ['estatica', 'cgnat'],
  pppoe: ['pool_pppoe'],
  hotspot: ['pool_pppoe'],
}

const mbps = (kbps) => (kbps ? `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps` : '—')
/** Campos del servicio que se guardan desde este formulario. */
/**
 * Sugerencias para el equipo receptor del abonado.
 *
 * Van como sugerencias y no como lista cerrada a propósito: la columna es texto
 * libre en la base, cada ISP compra lo que consigue, y un desplegable cerrado
 * obliga a elegir "otro" —o a inventar— en cuanto aparece un modelo que no
 * está. Con `datalist` se escribe cualquier cosa y las habituales salen de un
 * clic.
 *
 * Antes esta constante no existía y la pantalla la usaba igual: apretar
 * "Editar" en Servicio tiraba `TIPOS_ANTENA is not defined` y no se podía
 * editar nada de la ficha.
 */
const TIPOS_ANTENA = [
  'LiteBeam 5AC',
  'NanoStation Loco M5',
  'PowerBeam 5AC',
  'NanoBeam 5AC',
  'AirGrid M5',
  'Mikrotik SXT',
  'TP-Link CPE210',
  'TP-Link CPE510',
  'Mimosa C5',
  'ONT (fibra)',
]

const CAMPOS = [
  'router_id',
  'tipo_conexion',
  'plan_id',
  'precio_mensual',
  'descripcion_servicio',
  'excluir_firewall',
  'tipo_ip',
  'red_ipv4',
  'ip',
  'ipv6',
  'ipv6_prefijo',
  'ipv6_duid',
  'mac_address',
  'usuario_ppp',
  'clave_ppp',
  'rutas',
  'nap_id',
  'puerto_nap',
  'conectado_a_id',
  'ip_administracion',
  'tipo_antena',
  'fecha_instalacion',
  'direccion',
  'latitud',
  'longitud',
]

export default function FichaServicio({ cliente, onError, onGuardado }) {
  const confirmar = useConfirmar()
  const { filas: routers } = useTabla('routers_mikrotik', { orderBy: 'nombre', ascending: true })
  const { filas: planes } = useTabla('planes_velocidad', { orderBy: 'nombre', ascending: true })
  const { filas: redes } = useTabla('v_subredes', { orderBy: 'numero', ascending: true })

  // Las direcciones tomadas de la red elegida. Se piden al cambiar de red y no
  // al abrir la ficha: son cientos por red y casi nunca se toca este campo.
  const [ocupadas, setOcupadas] = useState([])

  const [puntos, setPuntos] = useState([])
  const [form, setForm] = useState(() =>
    Object.fromEntries(CAMPOS.map((c) => [c, cliente[c] ?? ''])),
  )
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [verClave, setVerClave] = useState(false)
  const [editando, setEditando] = useState(false)
  const [onu, setOnu] = useState(null)

  const redElegida = redes.find((r) => r.cidr === form.red_ipv4) ?? null

  /**
   * Las redes que tiene sentido ofrecerle a este abonado.
   *
   * La que ya tiene guardada se deja en la lista aunque no corresponda: sacarla
   * la borraría de la ficha sin que nadie lo pida, y una ficha que se modifica
   * sola al abrirla es peor que una mal cargada. Se muestra, y se avisa.
   */
  const redesCompatibles = useMemo(() => {
    const permitidos = REDES_SEGUN_CONEXION[form.tipo_conexion ?? 'ip'] ?? ['estatica', 'cgnat']
    return redes.filter((r) => permitidos.includes(r.tipo) || r.cidr === form.red_ipv4)
  }, [redes, form.tipo_conexion, form.red_ipv4])

  const redNoCorresponde =
    redElegida &&
    !(REDES_SEGUN_CONEXION[form.tipo_conexion ?? 'ip'] ?? []).includes(redElegida.tipo)

  /**
   * Las direcciones ya tomadas de esa red.
   *
   * Se miran dos fuentes porque ninguna alcanza sola: `v_direcciones_ip` tiene
   * lo que el sistema ve en los equipos, y `clientes.ip` lo que alguien cargó a
   * mano. Una IP puede estar en una ficha y todavía no aparecer en el router
   * —se carga el alta antes de ir a instalarla— y proponerla otra vez termina
   * en dos abonados con la misma dirección.
   *
   * El abonado que se está editando se excluye: su propia IP no es un
   * impedimento para dejarle la que ya tiene.
   */
  useEffect(() => {
    if (!redElegida) {
      setOcupadas([])
      return
    }
    let vivo = true
    Promise.all([
      supabase.from('v_direcciones_ip').select('ip_address').eq('subred_id', redElegida.id),
      supabase.from('clientes').select('ip').not('ip', 'is', null).neq('id', cliente.id),
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
  }, [redElegida?.id, cliente.id])

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

  const ipFueraDeRed =
    form.ip && redElegida ? perteneceA(form.ip, redElegida.cidr) === false : false
  const [midiendo, setMidiendo] = useState(false)

  useEffect(() => {
    supabase
      .from('v_puntos_red')
      .select('*')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setPuntos(data ?? []))
  }, [])

  // La ONU se lee entera: el resumen muestra su estado y sus potencias, y para
  // medir en vivo hacen falta la OLT, el puerto y el índice.
  useEffect(() => {
    if (!cliente.onu_id) return setOnu(null)
    supabase
      .from('onus')
      .select('*')
      .eq('id', cliente.onu_id)
      .maybeSingle()
      .then(({ data }) => setOnu(data ?? null))
  }, [cliente.onu_id])

  /**
   * Pide una lectura óptica al equipo, en vivo.
   *
   * Lo cacheado en la base puede ser de hace días; cuando alguien llama porque
   * "anda lento", lo que sirve es la potencia de ahora.
   */
  async function medirAhora() {
    if (!onu?.olt_id) return onError?.(new Error('La ONU no tiene OLT asociada'))

    setMidiendo(true)
    onError?.(null)
    try {
      const m = await api.olt.metricas(onu.olt_id, onu.onu_index, {
        frame: onu.frame,
        slot: onu.slot,
        puerto: onu.puerto,
      })
      setOnu((o) => ({
        ...o,
        // La causa manda sobre el estado: sin ella solo se sabe que no responde.
        estado: m.online
          ? 'online'
          : m.causa === 'power_off'
            ? 'power_off'
            : m.causa === 'los'
              ? 'los'
              : 'offline',
        causa_caida: m.causa ?? null,
        causa_caida_cruda: m.causaCruda ?? null,
        ultima_caida: m.ultimaCaida ?? null,
        rx_power_dbm: m.rxPowerDbm ?? o?.rx_power_dbm,
        tx_power_dbm: m.txPowerDbm ?? o?.tx_power_dbm,
        distancia_m: m.distanciaM ?? o?.distancia_m,
        ultima_lectura: new Date().toISOString(),
      }))
    } catch (err) {
      onError?.(err)
    } finally {
      setMidiendo(false)
    }
  }

  /**
   * Quita el servicio del abonado.
   *
   * Solo limpia los datos de conexión: no borra al cliente, ni sus facturas, ni
   * da de baja la ONU en la OLT. Eso último se hace desde la OLT, porque
   * borrarla acá dejaría el equipo registrado y el puerto ocupado.
   */
  async function eliminarServicio() {
    if (
      !await confirmar(
        `¿Quitar el servicio de ${cliente.nombre}?\n\n` +
          'Se borran plan, router, IP, PPPoE, caja NAP y antena de su ficha.\n' +
          'No se borra el cliente, ni sus facturas, ni la ONU en la OLT.\n\n¿Continuar?',
      )
    )
      return

    setGuardando(true)
    onError?.(null)
    try {
      const vacio = Object.fromEntries(CAMPOS.map((c) => [c, null]))
      // El tipo de conexión no admite NULL: vuelve a su valor por defecto.
      vacio.tipo_conexion = 'ip'
      vacio.tipo_ip = 'fija'

      const { error } = await supabase.from('clientes').update(vacio).eq('id', cliente.id)
      if (error) throw error
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const set = (campo) => (e) => {
    setGuardado(false)
    const valor = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [campo]: valor }))
  }

  // PPPoE y hotspot piden los mismos datos: usuario y clave de acceso.
  const esPppoe = ['pppoe', 'hotspot'].includes(form.tipo_conexion)

  const plan = planes.find((p) => p.id === form.plan_id)
  const napElegida = useMemo(
    () => puntos.find((p) => p.id === form.nap_id),
    [puntos, form.nap_id],
  )

  const cajas = puntos.filter((p) => p.tipo === 'nap')
  const antenas = puntos.filter((p) => ['antena', 'torre'].includes(p.tipo))

  /**
   * Al cambiar de plan, el costo pasa a ser el de ese plan.
   *
   * Se pisa el valor anterior aunque hubiera un precio pactado: si al abonado
   * se lo sube de 50 a 100 megas, el precio viejo ya no corresponde y dejarlo
   * haría que se le siga facturando el plan anterior. Después se puede editar
   * a mano si el acuerdo es otro.
   */
  function elegirPlan(e) {
    const id = e.target.value
    const p = planes.find((x) => x.id === id)
    setGuardado(false)
    setForm((f) => ({
      ...f,
      plan_id: id,
      precio_mensual: p ? String(p.precio) : f.precio_mensual,
    }))
  }

  function ubicacionActual() {
    if (!navigator.geolocation) {
      return onError?.(new Error('Este navegador no puede dar la ubicación.'))
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setForm((f) => ({
          ...f,
          latitud: pos.coords.latitude.toFixed(7),
          longitud: pos.coords.longitude.toFixed(7),
        })),
      (err) => onError?.(new Error(`No se pudo obtener la ubicación: ${err.message}`)),
    )
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    onError?.(null)

    try {
      const cambios = {}
      for (const campo of CAMPOS) {
        cambios[campo] = form[campo] === '' ? null : form[campo]
      }
      for (const campo of ['precio_mensual', 'latitud', 'longitud']) {
        cambios[campo] = cambios[campo] == null ? null : Number(cambios[campo])
      }
      cambios.excluir_firewall = Boolean(form.excluir_firewall)

      // Un servicio que deja de ser PPPoE no puede quedarse con credenciales
      // colgadas: al migrar a IP fija dejan de tener sentido y confunden al
      // técnico que lee la ficha.
      if (!esPppoe) {
        cambios.usuario_ppp = null
        cambios.clave_ppp = null
        cambios.rutas = null
      }

      const { error } = await supabase.from('clientes').update(cambios).eq('id', cliente.id)
      if (error) {
        if (error.code === '23505') {
          throw new Error(
            'Ese puerto de la caja NAP ya está ocupado por otro abonado. Elegí otro puerto.',
          )
        }
        throw error
      }

      setGuardado(true)
      // Se vuelve al resumen: guardar es el final de la edición, y dejar el
      // formulario abierto invita a tocar de más "por las dudas".
      setEditando(false)
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const potencia = Number(cliente.rx_power_dbm)
  const potenciaBaja = !Number.isNaN(potencia) && potencia < -27

  // El resumen es lo que se ve al entrar; el formulario aparece al editar.
  if (!editando) {
    return (
      <ResumenServicio
        cliente={cliente}
        onu={onu}
        midiendo={midiendo}
        onMedir={medirAhora}
        onEditar={() => setEditando(true)}
        onEliminar={eliminarServicio}
        onError={onError}
        onGuardado={onGuardado}
      />
    )
  }

  return (
    <form onSubmit={guardar} className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Conexión ---------------------------------------------------- */}
        <Card title="Servicio de internet" icon={Wifi}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Router">
              <Select value={form.router_id ?? ''} onChange={set('router_id')}>
                <option value="">— sin router —</option>
                {routers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Tipo de conexión"
              hint="Define si se piden usuario y clave de acceso"
            >
              <Select value={form.tipo_conexion || 'ip'} onChange={set('tipo_conexion')}>
                <option value="ip">IPoE (IP directa, fija o por DHCP)</option>
                <option value="pppoe">PPPoE (usuario y clave)</option>
                <option value="hotspot">Hotspot</option>
              </Select>
            </Field>

            <Field label="Perfil de internet (plan)">
              <Select value={form.plan_id ?? ''} onChange={elegirPlan}>
                <option value="">— sin plan —</option>
                {planes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre} ({mbps(p.bajada_kbps)}/{mbps(p.subida_kbps)})
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Costo mensual"
              hint={
                plan && Number(form.precio_mensual) !== Number(plan.precio)
                  ? `El plan cuesta $${Number(plan.precio).toFixed(2)}: este abonado tiene un precio pactado.`
                  : 'Se completa con el precio del plan; se puede cambiar.'
              }
            >
              <Input
                type="number"
                step="0.01"
                min={0}
                value={form.precio_mensual ?? ''}
                onChange={set('precio_mensual')}
              />
            </Field>

            <Field
              label="Descripción para facturación"
              className="sm:col-span-2"
              hint="Lo que sale en el detalle de la factura. Vacío = el nombre del plan."
            >
              <Textarea
                rows={3}
                value={form.descripcion_servicio ?? ''}
                onChange={set('descripcion_servicio')}
                placeholder={plan ? `Servicio de internet — ${plan.nombre}` : ''}
              />
            </Field>

            <div className="sm:col-span-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={Boolean(form.excluir_firewall)}
                  onChange={set('excluir_firewall')}
                  className="accent-sky-500"
                />
                Excluir del corte automático
              </label>
              <p className="mt-1 text-[11px] text-slate-500">
                Para enlaces que no pueden cortarse por mora sin autorización.
              </p>
            </div>
          </div>
        </Card>

        {/* --- Direccionamiento -------------------------------------------- */}
        <Card title="Direccionamiento" icon={RouterIcon}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Tipo de IPv4"
              hint={
                // Igual que en el asistente, "fija" no significa lo mismo en las
                // dos formas de conexión, así que la ayuda cambia con ella.
                form.tipo_ip === 'dinamica'
                  ? 'La dirección la reparte el router. La que figure abajo es informativa.'
                  : esPppoe
                    ? 'La dirección se graba en su usuario PPPoE (remote-address).'
                    : 'Reserva DHCP: hace falta la MAC del equipo, si no queda solo anotada.'
              }
            >
              <Select value={form.tipo_ip ?? 'fija'} onChange={set('tipo_ip')}>
                <option value="fija">Fija{esPppoe ? ' (en su usuario PPPoE)' : ' (reserva DHCP por MAC)'}</option>
                <option value="dinamica">Dinámica (DHCP)</option>
              </Select>
            </Field>
            <Field label="Red IPv4" hint="De las cargadas en Red → Redes IPv4">
              <Select
                value={form.red_ipv4 ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, red_ipv4: e.target.value }))}
              >
                <option value="">— sin definir —</option>
                {redesCompatibles.map((r) => (
                  <option key={r.id} value={r.cidr}>
                    {r.nombre} · {r.cidr} ({r.asignadas ?? 0}/{r.utilizables ?? 0})
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="IPv4"
              hint={
                redElegida
                  ? `${libres.length}${libres.length === 250 ? '+' : ''} libres en ${redElegida.cidr}`
                  : 'La que se le asigna al abonado'
              }
            >
              <div className="flex gap-2">
                {/* Lista abierta y no un <select>: se elige de las libres o se
                    escribe una que el sistema todavía no conoce. */}
                <Input
                  list="ips-libres-ficha"
                  value={form.ip ?? ''}
                  onChange={set('ip')}
                  placeholder={redElegida ? libres[0] : '172.18.2.3'}
                  className="font-mono"
                />
                <datalist id="ips-libres-ficha">
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

            {redNoCorresponde && (
              <div className="sm:col-span-2">
                <Aviso tipo="alerta">
                  <b>{redElegida.nombre}</b> es una red de tipo <b>{redElegida.tipo}</b>, y este
                  abonado está como <b>{form.tipo_conexion ?? 'ip'}</b>. No se corresponden: en un
                  pool de PPPoE la dirección la reparte el servidor al autenticarse, y en una red
                  estática se la asignás vos. Tal como está, el abonado no navega.
                </Aviso>
              </div>
            )}

            {ipFueraDeRed && (
              <div className="sm:col-span-2">
                <Aviso tipo="alerta">
                  <b>{form.ip}</b> no pertenece a {redElegida.cidr}. Una IP fuera del bloque no
                  navega, y eso se descubre recién el día de la instalación.
                </Aviso>
              </div>
            )}
            <Field label="MAC">
              <Input
                value={form.mac_address ?? ''}
                onChange={set('mac_address')}
                placeholder="AA:BB:CC:DD:EE:FF"
                className="font-mono"
              />
            </Field>

            <Field
              label="Prefijo IPv6 delegado"
              hint="Lo que se le entrega al abonado, ej. 2803:1234:5678:1200::/56"
            >
              <Input
                value={form.ipv6_prefijo ?? ''}
                onChange={set('ipv6_prefijo')}
                placeholder="2803:1234:5678:1200::/56"
                className="font-mono"
              />
            </Field>

            {/*
              Es el prefijo y no una dirección lo que se guarda, y no es un
              detalle: al cortar se bloquea el PREFIJO entero. El abonado tiene
              cientos de direcciones adentro y cambia de una a otra sin avisar,
              así que bloquear una sola no corta nada.
            */}
            {form.ipv6_prefijo && !String(form.ipv6_prefijo).includes('/') && (
              <div className="sm:col-span-2">
                <Aviso tipo="alerta">
                  Falta la barra con el tamaño del prefijo —<b>/56</b> o <b>/64</b>—. Sin ella el
                  corte bloquearía una sola dirección y el abonado seguiría navegando con las otras.
                </Aviso>
              </div>
            )}

            <Field label="IPv6 (una dirección suelta)" hint="Opcional, informativa">
              <Input value={form.ipv6 ?? ''} onChange={set('ipv6')} className="font-mono" />
            </Field>
            <Field label="IPv6 DUID" hint="Solo si se fija la dirección en bindings">
              <Input value={form.ipv6_duid ?? ''} onChange={set('ipv6_duid')} className="font-mono" />
            </Field>

            {/* Los campos de PPPoE dependen del router elegido. */}
            {esPppoe && (
              <>
                <Field
                  label="Usuario PPP / HS"
                  className="sm:col-span-2"
                  hint="Generar propone jefferson.ona a partir del nombre, y una clave que se pueda dictar"
                >
                  <div className="flex gap-2">
                    <Input
                      value={form.usuario_ppp ?? ''}
                      onChange={set('usuario_ppp')}
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variante="secundario"
                      icon={Wand2}
                      title="Proponer usuario y contraseña"
                      onClick={() => {
                        /**
                         * Llena los dos de una, y muestra la clave.
                         *
                         * Generar una contraseña oculta no sirve de nada: el
                         * técnico la tiene que leer para cargarla en la ONT, y
                         * si el campo está en puntitos hay que apretar el ojo
                         * igual. Se genera y se muestra.
                         */
                        setForm((f) => ({
                          ...f,
                          usuario_ppp: usuarioSugerido({
                            nombre: cliente.nombre,
                            identificacion: cliente.identificacion,
                          }),
                          clave_ppp: claveSugerida(),
                        }))
                        setVerClave(true)
                      }}
                    >
                      Generar
                    </Button>
                  </div>
                </Field>
                <Field label="Contraseña PPP / HS">
                  <div className="flex gap-2">
                    <Input
                      type={verClave ? 'text' : 'password'}
                      value={form.clave_ppp ?? ''}
                      onChange={set('clave_ppp')}
                      autoComplete="off"
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variante="secundario"
                      icon={verClave ? EyeOff : Eye}
                      onClick={() => setVerClave((v) => !v)}
                      title={verClave ? 'Ocultar' : 'Ver'}
                    />
                  </div>
                </Field>
                <Field label="Rutas" hint="Opcional, ej. 192.168.10.0/24">
                  <Input value={form.rutas ?? ''} onChange={set('rutas')} className="font-mono" />
                </Field>
              </>
            )}

          </div>
        </Card>

        {/* --- Planta externa ---------------------------------------------- */}
        <Card title="Planta externa" icon={Antenna}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Caja NAP">
              <Select value={form.nap_id ?? ''} onChange={set('nap_id')}>
                <option value="">— ninguna —</option>
                {cajas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                    {c.capacidad ? ` (${c.disponibles} libres de ${c.capacidad})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Puerto NAP"
              hint={
                napElegida?.capacidad
                  ? `Del 1 al ${napElegida.capacidad}`
                  : 'El puerto del splitter'
              }
            >
              <Input value={form.puerto_nap ?? ''} onChange={set('puerto_nap')} />
            </Field>

            <Field
              label="Fecha de instalación"
              hint="Se completa sola al marcar la visita como hecha en Instalaciones"
            >
              <Input
                type="date"
                value={form.fecha_instalacion ?? ''}
                onChange={set('fecha_instalacion')}
              />
            </Field>
            <Field label="Dirección del servicio">
              <Input value={form.direccion ?? ''} onChange={set('direccion')} />
            </Field>

            <Field label="Coordenadas" className="sm:col-span-2" hint="Latitud, longitud">
              <div className="flex gap-2">
                <Input
                  value={form.latitud ?? ''}
                  onChange={set('latitud')}
                  placeholder="-0.886148"
                  className="min-w-0"
                />
                <Input
                  value={form.longitud ?? ''}
                  onChange={set('longitud')}
                  placeholder="-79.186616"
                  className="min-w-0"
                />
                <Button
                  type="button"
                  variante="secundario"
                  icon={MapPin}
                  onClick={ubicacionActual}
                  title="Usar la ubicación de este dispositivo"
                />
              </div>
            </Field>

            {cajas.length === 0 && (
              <div className="sm:col-span-2">
                <Aviso>
                  Todavía no hay cajas NAP cargadas. Se administran en{' '}
                  <Link to="/perfiles" className="text-sky-400 hover:underline">
                    Perfiles y planes → Puntos de red
                  </Link>
                  .
                </Aviso>
              </div>
            )}
          </div>
        </Card>

        {/* --- Otros datos -------------------------------------------------- */}
        <Card title="Otros datos — equipo receptor" icon={Radio}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Conectado a" hint="Antena o torre desde la que se lo alimenta">
              <Select value={form.conectado_a_id ?? ''} onChange={set('conectado_a_id')}>
                <option value="">— ninguno —</option>
                {antenas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tipo de antena" hint="El equipo en la casa del abonado">
              <Input
                list="tipos-antena"
                placeholder="LiteBeam 5AC"
                maxLength={50}
                value={form.tipo_antena ?? ''}
                onChange={set('tipo_antena')}
              />
              <datalist id="tipos-antena">
                {TIPOS_ANTENA.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </Field>
            <Field
              label="IP de administración"
              className="sm:col-span-2"
              hint="La de la antena o el equipo del cliente, para poder entrar a configurarlo"
            >
              <Input
                value={form.ip_administracion ?? ''}
                onChange={set('ip_administracion')}
                placeholder="192.168.1.20"
                className="font-mono"
              />
            </Field>

            {/* La ONU es de solo lectura: se da de alta desde la OLT. */}
            <div className="sm:col-span-2 t-panel p-3">
              <p className="mb-2 text-xs font-semibold text-slate-400">Fibra / ONU</p>
              {cliente.onu_serial ? (
                <div className="space-y-1 text-xs text-slate-400">
                  <p>
                    Serial <span className="font-mono text-slate-200">{cliente.onu_serial}</span>{' '}
                    <Badge
                      color={
                        cliente.onu_estado === 'online'
                          ? 'verde'
                          : cliente.onu_estado === 'los'
                            ? 'rojo'
                            : 'gris'
                      }
                    >
                      {cliente.onu_estado ?? 'desconocido'}
                    </Badge>
                  </p>
                  <p>
                    Potencia:{' '}
                    <span className={potenciaBaja ? 'text-red-400' : 'text-slate-200'}>
                      {cliente.rx_power_dbm != null ? `${cliente.rx_power_dbm} dBm` : '—'}
                    </span>
                    {potenciaBaja && ' — por debajo de −27 dBm, la fibra está al límite'}
                  </p>
                  <Link to="/metricas" className="inline-block text-sky-400 hover:underline">
                    Ver métricas en vivo →
                  </Link>
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  Sin ONU asociada. Se vincula al registrarla desde <b>ONUs</b>.
                </p>
              )}
            </div>
          </div>
        </Card>
      </div>

      {guardado && <Aviso>Servicio actualizado.</Aviso>}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variante="fantasma"
          onClick={() => {
            // Se descartan los cambios volviendo al estado guardado: si no, al
            // reabrir el formulario seguirían los valores a medio editar.
            setForm(Object.fromEntries(CAMPOS.map((c) => [c, cliente[c] ?? ''])))
            setGuardado(false)
            setEditando(false)
          }}
        >
          Cancelar
        </Button>
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          Guardar cambios
        </Button>
      </div>
    </form>
  )
}
