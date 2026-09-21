import { useEffect, useState } from 'react'
import { AlertTriangle, Globe, Network } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { useConfirmar } from '../../lib/confirmar'
import { Button, ErrorBanner, Modal } from '../ui'

/**
 * Cómo sale a internet la ONT: el equivalente a "Update ONU mode" de SmartOLT.
 *
 * ── Lo que se configura acá y lo que NO ──
 *
 * En un MA5800 la WAN se arma con un PERFIL —`ont wan-profile`— que guarda dos
 * cosas y nada más: si la conexión es enrutada o puente, y si hace NAT. Después
 * ese perfil se le vincula a la ONT con `ont wan-config`.
 *
 * La dirección IP, la máscara, el gateway y los DNS de la WAN de servicio NO
 * están en el perfil. Se comprobó leyendo el que dejó otra herramienta:
 *
 *     Connection type : Route
 *     NAT switch      : Enable
 *
 * Esos datos se le mandan a la ONT por TR-069. Son dos transportes —SSH contra
 * la OLT, HTTP contra el ACS— con dos botones de Aplicar, uno para cada mitad:
 * mezclarlos en un solo click escondería cuál de los dos falló cuando algo no
 * aplica, que es información que a alguien parado en la escalera le importa.
 *
 * ── Por qué se ve como SmartOLT y no como el resto del sistema ──
 *
 * Es la misma ventana que "Update ONU mode": mismo orden, mismos campos, los
 * mismos botones de radio. Los que SmartOLT resuelve por OMCI y acá no se
 * pueden tocar —Config method, IP Protocol, WAN IP source, WAN remote
 * access— se ven bloqueados con el motivo al lado, no escondidos: para que se
 * sepa que es una limitación de hoy y no un campo que se perdió.
 *
 * ── Por qué el índice se elige ──
 *
 * Una ONT tiene varias WAN. La de gestión —la que usa TR-069— vive en su propio
 * índice, y pisarla la deja sin ACS: se ve online y no se la puede configurar
 * más. Por eso el índice se muestra y arranca en 1, que es la de servicio.
 */

const MODOS = [
  { valor: 'route', label: 'Routing' },
  { valor: 'bridge', label: 'Bridging' },
]

const MOTIVOS_TR069 = {
  sin_serie: 'Esta ONU no tiene número de serie cargado.',
  sin_acs: 'No hay servidor TR-069 configurado en este sistema.',
  acs_no_responde: 'El servidor TR-069 no respondió. Puede estar caído o sin camino de red.',
  equipo_desconocido:
    'La ONT nunca se reportó al servidor TR-069: revisá el perfil, la IP de gestión, y si levantó la interfaz.',
}

const MODOS_WAN_TR069 = [
  { valor: 'dhcp', label: 'DHCP' },
  { valor: 'estatica', label: 'Static IP' },
  { valor: 'pppoe', label: 'PPPoE' },
]

const CONFIG_METHOD = [
  { valor: 'omci', label: 'OMCI', disabled: true, motivo: 'No implementado: hablar OMCI directo es un desarrollo aparte' },
  { valor: 'tr069', label: 'TR069' },
]

const IP_PROTOCOL = [
  { valor: 'ipv4', label: 'IPv4' },
  { valor: 'dual', label: 'Dual stack IPv4/IPv6', disabled: true, motivo: 'No implementado' },
]

const WAN_IP_SOURCE = [
  { valor: 'pool', label: 'From IP pool', disabled: true, motivo: 'No implementado: no hay pool de direcciones para la WAN de servicio' },
  { valor: 'manual', label: 'Manual IP' },
]

/** Una fila de radio-botones, al estilo del panel de SmartOLT. */
function FilaRadio({ etiqueta, opciones, valor, onChange, nombre }) {
  return (
    <div className="mb-3.5">
      <p className="mb-1.5 text-[13px] font-medium text-slate-700">{etiqueta}</p>
      <div className="flex flex-wrap gap-x-6 gap-y-1.5">
        {opciones.map((o) => (
          <label
            key={o.valor}
            className={`flex items-center gap-1.5 text-[13px] ${
              o.disabled ? 'cursor-not-allowed text-slate-400' : 'cursor-pointer text-slate-700'
            }`}
            title={o.motivo}
          >
            <input
              type="radio"
              name={nombre}
              checked={valor === o.valor}
              disabled={o.disabled}
              onChange={() => onChange?.(o.valor)}
              className="h-3.5 w-3.5 accent-sky-600 disabled:accent-slate-400"
            />
            {o.label}
          </label>
        ))}
      </div>
      {opciones.some((o) => o.disabled && o.motivo && valor !== o.valor) && (
        <p className="mt-1 text-[11px] text-slate-400">
          {opciones.find((o) => o.disabled && o.motivo)?.motivo}
        </p>
      )}
    </div>
  )
}

/** Un desplegable, al estilo del panel de SmartOLT. */
function CampoSelect({ etiqueta, value, onChange, children, disabled, hint }) {
  return (
    <div className="mb-3.5">
      <p className="mb-1.5 text-[13px] font-medium text-slate-700">{etiqueta}</p>
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 outline-none focus:border-sky-500 disabled:bg-slate-100 disabled:text-slate-400"
      >
        {children}
      </select>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

/** Un campo de texto, al estilo del panel de SmartOLT. */
function CampoTexto({ etiqueta, value, onChange, type = 'text', hint }) {
  return (
    <div className="mb-3.5">
      <p className="mb-1.5 text-[13px] font-medium text-slate-700">{etiqueta}</p>
      <input
        type={type}
        value={value}
        onChange={onChange}
        className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 outline-none focus:border-sky-500"
      />
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

export default function ModoWanOnu({ olt, onu, onListo, onCerrar }) {
  const confirmar = useConfirmar()

  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [resultado, setResultado] = useState(null)
  const [guardando, setGuardando] = useState(false)

  // --- El formulario del modo/NAT (OLT) ---
  const [ipIndex, setIpIndex] = useState(1)
  const [profileId, setProfileId] = useState('')
  const [nuevo, setNuevo] = useState(false)
  const [nombre, setNombre] = useState('')
  const [modo, setModo] = useState('route')
  const [nat, setNat] = useState(true)
  const [vlan, setVlan] = useState(onu.vlan ?? '')

  // --- El formulario de TR-069 ---
  const [tr069Modo, setTr069Modo] = useState('dhcp')
  const [tr069Usuario, setTr069Usuario] = useState('')
  const [tr069Clave, setTr069Clave] = useState('')
  const [tr069Ip, setTr069Ip] = useState('')
  const [tr069Mascara, setTr069Mascara] = useState('')
  const [tr069Puerta, setTr069Puerta] = useState('')
  const [tr069Dns1, setTr069Dns1] = useState('')
  const [tr069Dns2, setTr069Dns2] = useState('')
  const [guardandoTr069, setGuardandoTr069] = useState(false)
  const [errorTr069, setErrorTr069] = useState(null)
  const [resultadoTr069, setResultadoTr069] = useState(null)

  useEffect(() => {
    let vivo = true
    api.olt
      .wanOnu(olt.id, onu.onu_id)
      .then((r) => {
        if (!vivo) return
        setDatos(r)
        // Si ya tiene una WAN de servicio, se arranca sobre esa.
        const servicio = (r.conexiones ?? []).find((c) => !/tr069/i.test(c.servicio ?? ''))
        if (servicio?.indice != null) setIpIndex(servicio.indice)

        // Lo que la ONT ya tiene puesto por TR-069, para no arrancar el
        // formulario en blanco sobre un equipo que ya está configurado.
        const wanTr069 = r.tr069?.gestionable ? r.tr069.wan : null
        if (wanTr069?.modo) {
          setTr069Modo(wanTr069.modo)
          setTr069Usuario(wanTr069.usuario ?? '')
          setTr069Ip(wanTr069.ip ?? '')
          setTr069Mascara(wanTr069.mascara ?? '')
          setTr069Puerta(wanTr069.puerta ?? '')
          const [d1, d2] = String(wanTr069.dns ?? '').split(',').map((x) => x.trim())
          setTr069Dns1(d1 ?? '')
          setTr069Dns2(d2 ?? '')
        }
      })
      .catch((e) => vivo && setError(e))
      .finally(() => vivo && setCargando(false))
    return () => {
      vivo = false
    }
  }, [olt.id, onu.onu_id])

  async function guardarTr069() {
    if (
      !(await confirmar({
        titulo: 'Cambiar la WAN por TR-069',
        mensaje:
          `Se le escribe a la ONT ${onu.sn} su conexión de internet (${tr069Modo}). `
          + 'El equipo puede quedarse sin salida unos segundos mientras aplica, y si el ACS no '
          + 'tiene camino hasta él, el pedido queda guardado hasta que la ONT informe.',
        etiquetaAccion: 'Aplicar',
        variante: 'primario',
      }))
    ) {
      return
    }

    setGuardandoTr069(true)
    setErrorTr069(null)
    setResultadoTr069(null)
    try {
      const dns = [tr069Dns1.trim(), tr069Dns2.trim()].filter(Boolean).join(',')
      const r = await api.olt.configurarWanTr069Onu(olt.id, onu.onu_id, {
        modo: tr069Modo,
        usuario: tr069Modo === 'pppoe' ? tr069Usuario.trim() : undefined,
        clave: tr069Modo === 'pppoe' && tr069Clave ? tr069Clave : undefined,
        ip: tr069Modo === 'estatica' ? tr069Ip.trim() : undefined,
        mascara: tr069Modo === 'estatica' ? tr069Mascara.trim() : undefined,
        puerta: tr069Modo === 'estatica' ? tr069Puerta.trim() : undefined,
        dns: tr069Modo === 'estatica' ? dns : undefined,
        vlan: vlan || undefined,
      })
      setTr069Clave('')
      setResultadoTr069(r)
    } catch (e) {
      setErrorTr069(e)
    } finally {
      setGuardandoTr069(false)
    }
  }

  const perfiles = datos?.perfiles ?? []
  const elegido = perfiles.find((p) => String(p.id) === String(profileId))

  /** El primer número de perfil que no esté usado. */
  const primeroLibre = () => {
    const usados = new Set(perfiles.map((p) => p.id))
    for (let i = 0; i <= 255; i += 1) if (!usados.has(i)) return i
    return null
  }

  async function guardar() {
    const queda = nuevo ? `nuevo perfil ${nombre || '(sin nombre)'}` : `perfil ${profileId}`
    if (
      !(await confirmar({
        titulo: 'Cambiar cómo sale a internet esta ONT',
        mensaje:
          `La ONT ${onu.sn} va a quedar con ${queda}, en el índice ${ipIndex}.\n\n`
          + 'Esto cambia el servicio del abonado: si pasa de puente a enrutada deja de '
          + 'entregar la IP que entregaba, y al revés.\n\n'
          + 'Puede quedarse sin internet unos minutos mientras se reconfigura.',
        etiquetaAccion: 'Aplicar',
        variante: 'primario',
      }))
    ) {
      return
    }

    setGuardando(true)
    setError(null)
    setResultado(null)
    try {
      const r = await api.olt.configurarWanOnu(olt.id, onu.onu_id, {
        ip_index: Number(ipIndex),
        ...(nuevo
          ? { perfil: { profileId: primeroLibre(), nombre, tipo: modo, nat } }
          : { profile_id: Number(profileId) }),
      })
      setResultado(r)
      await onListo?.()
    } catch (e) {
      setError(e)
    } finally {
      setGuardando(false)
    }
  }

  async function sacar() {
    if (
      !(await confirmar({
        titulo: 'Sacarle la WAN a esta ONT',
        mensaje:
          `Se quita la configuración de WAN del índice ${ipIndex} en la OLT. El abonado puede `
          + 'quedarse sin internet hasta que se le arme otra.',
        etiquetaAccion: 'Sacar la WAN',
        variante: 'peligro',
      }))
    ) {
      return
    }
    setGuardando(true)
    setError(null)
    try {
      setResultado(
        await api.olt.configurarWanOnu(olt.id, onu.onu_id, {
          sacar: true,
          ip_index: Number(ipIndex),
        }),
      )
      await onListo?.()
    } catch (e) {
      setError(e)
    } finally {
      setGuardando(false)
    }
  }

  const puedeAplicarTr069 =
    datos?.tr069?.gestionable &&
    !(tr069Modo === 'pppoe' && (!tr069Usuario.trim() || !tr069Clave)) &&
    !(tr069Modo === 'estatica' && (!tr069Ip.trim() || !tr069Mascara.trim() || !tr069Puerta.trim()))

  return (
    <Modal abierto titulo="Update ONU mode" onCerrar={onCerrar} ancho="max-w-2xl">
      {/* Panel claro, al estilo SmartOLT, dentro del marco oscuro del sistema. */}
      <div className="-m-5 rounded-b-xl bg-white p-5 text-slate-800">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {cargando && <p className="text-[13px] text-slate-500">Preguntándole al equipo…</p>}

        {datos && !datos.soportado && (
          <p className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            <b>{onu.modelo ?? 'Este modelo'}</b> no declara sus interfaces IP por OMCI: desde la
            OLT no se le puede configurar la WAN. Se configura en la página web del equipo o por
            TR-069.
          </p>
        )}

        <CampoSelect etiqueta="WAN VLAN-ID" value={vlan} disabled onChange={() => {}}>
          <option>{vlan || '—'}</option>
        </CampoSelect>
        <p className="-mt-2.5 mb-3.5 text-[11px] text-slate-400">
          Es la del puerto PON de esta ONT. Después de cambiarla revisá los puertos Ethernet.
        </p>

        <FilaRadio etiqueta="ONU mode" nombre="onu-mode" opciones={MODOS} valor={modo} onChange={setModo} />

        {/*
          El perfil que guarda el modo/NAT en la OLT. SmartOLT no lo muestra
          —lo resuelve solo por dentro— pero acá hace falta elegirlo o crear
          uno: es el precio de no tener esa parte automatizada todavía.
        */}
        <div className="mb-1 rounded border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
            Perfil de la OLT que guarda el modo y el NAT
          </p>
          <CampoSelect
            etiqueta="Perfil"
            value={nuevo ? '__nuevo' : profileId}
            onChange={(e) => {
              if (e.target.value === '__nuevo') {
                setNuevo(true)
                setNombre(`wan_${modo}_vlan${vlan || 'x'}`)
              } else {
                setNuevo(false)
                setProfileId(e.target.value)
              }
            }}
            hint={
              elegido?.vinculos > 0
                ? `Ese perfil ya lo usan ${elegido.vinculos} ONTs. Vincular esta no las toca, pero editarlo sí las cambiaría a todas.`
                : 'Guarda el modo y el NAT. Se comparte entre ONTs.'
            }
          >
            <option value="">— elegí —</option>
            {perfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre} (id {p.id}) · {p.vinculos} ONTs
              </option>
            ))}
            <option value="__nuevo">Crear uno nuevo…</option>
          </CampoSelect>

          {nuevo && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <CampoTexto etiqueta="Nombre del perfil" value={nombre} onChange={(e) => setNombre(e.target.value)} />
              </div>
              <CampoSelect etiqueta="NAT" value={nat ? 'si' : 'no'} onChange={(e) => setNat(e.target.value === 'si')} disabled={modo === 'bridge'}>
                <option value="si">Habilitado</option>
                <option value="no">Deshabilitado</option>
              </CampoSelect>
              <p className="self-end text-[11px] text-slate-400">
                Se va a crear con el número {primeroLibre() ?? '—'}, el primero libre.
              </p>
            </div>
          )}

          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {datos?.conexiones?.length > 0 && (
              <Button variante="peligro" cargando={guardando} onClick={sacar}>
                Sacar la WAN
              </Button>
            )}
            <Button
              variante="primario"
              icon={Network}
              cargando={guardando}
              disabled={(!nuevo && !profileId) || datos?.soportado === false}
              onClick={guardar}
            >
              Aplicar modo/NAT
            </Button>
          </div>
        </div>

        {resultado && (
          <p className="mb-4 mt-2 rounded border border-sky-300 bg-sky-50 px-3 py-2 text-[12px] text-sky-800">
            {resultado.aviso}
            {resultado.comando && <span className="mt-1 block font-mono text-[11px] opacity-70">{resultado.comando}</span>}
          </p>
        )}

        {datos?.conexiones?.length > 0 && (
          <details className="mb-4">
            <summary className="cursor-pointer text-[11px] text-slate-400">
              Ver lo que tiene ahora ({datos.conexiones.length})
            </summary>
            <div className="mt-2 space-y-2">
              {datos.conexiones.map((c) => (
                <div key={c.indice} className="rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">índice {c.indice}</span>
                    <span>{c.servicio}</span>
                    <span className="text-slate-400">
                      {c.tipoConexion} · VLAN {c.vlan} · NAT {c.nat}
                    </span>
                  </div>
                  {c.ipv4 && (
                    <div className="mt-1 font-mono">
                      {c.accesoIpv4} {c.ipv4} / {c.mascara} · gw {c.gateway}
                      {c.dns1 ? ` · dns ${c.dns1}${c.dns2 ? `, ${c.dns2}` : ''}` : ''}
                    </div>
                  )}
                  {/tr069/i.test(c.servicio ?? '') && (
                    <div className="mt-1 flex items-start gap-1.5 text-amber-600">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      Es la de gestión. Pisar este índice deja la ONT sin TR-069.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        <hr className="mb-4 border-slate-200" />

        {/* --- WAN mode: lo que va por TR-069 --- */}
        <FilaRadio
          etiqueta="WAN mode"
          nombre="wan-mode-tr069"
          opciones={MODOS_WAN_TR069}
          valor={tr069Modo}
          onChange={setTr069Modo}
        />

        <FilaRadio etiqueta="Config method" nombre="config-method" opciones={CONFIG_METHOD} valor="tr069" />
        <FilaRadio etiqueta="IP Protocol" nombre="ip-protocol" opciones={IP_PROTOCOL} valor="ipv4" />
        <FilaRadio etiqueta="WAN IP source" nombre="wan-ip-source" opciones={WAN_IP_SOURCE} valor="manual" />

        {!datos?.tr069 ? null : !datos.tr069.gestionable ? (
          <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            {MOTIVOS_TR069[datos.tr069.motivo] ?? 'No se puede llegar a la ONT por TR-069.'}
          </p>
        ) : (
          <>
            {datos.tr069.wan?.estado && (
              <p className="mb-3 text-[11px] text-slate-400">
                Hoy: <span className="font-mono text-slate-600">{datos.tr069.wan.modo}</span>
                {' · '}
                {datos.tr069.wan.estado}
                {datos.tr069.ultimo_contacto
                  ? ` · último contacto ${new Date(datos.tr069.ultimo_contacto).toLocaleString()}`
                  : ''}
              </p>
            )}

            {tr069Modo === 'pppoe' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <CampoTexto etiqueta="Username" value={tr069Usuario} onChange={(e) => setTr069Usuario(e.target.value)} />
                <CampoTexto
                  etiqueta="Password"
                  type="password"
                  value={tr069Clave}
                  onChange={(e) => setTr069Clave(e.target.value)}
                  hint="El equipo nunca la devuelve: hay que volver a escribirla"
                />
              </div>
            )}

            {tr069Modo === 'estatica' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <CampoTexto etiqueta="IPv4 Address" value={tr069Ip} onChange={(e) => setTr069Ip(e.target.value)} />
                <CampoTexto etiqueta="Subnet Mask" value={tr069Mascara} onChange={(e) => setTr069Mascara(e.target.value)} />
                <CampoTexto etiqueta="Default Gateway" value={tr069Puerta} onChange={(e) => setTr069Puerta(e.target.value)} />
                <div />
                <CampoTexto etiqueta="DNS 1" value={tr069Dns1} onChange={(e) => setTr069Dns1(e.target.value)} />
                <CampoTexto etiqueta="DNS 2" value={tr069Dns2} onChange={(e) => setTr069Dns2(e.target.value)} />
              </div>
            )}

            <CampoSelect etiqueta="WAN remote access" value="no" disabled onChange={() => {}} hint="No implementado en este sistema">
              <option>No disponible</option>
            </CampoSelect>

            <ErrorBanner error={errorTr069} onCerrar={() => setErrorTr069(null)} />

            {resultadoTr069 && (
              <p
                className={`mb-2 rounded border px-3 py-2 text-[12px] ${
                  resultadoTr069.aplicado
                    ? 'border-sky-300 bg-sky-50 text-sky-800'
                    : 'border-amber-300 bg-amber-50 text-amber-800'
                }`}
              >
                {resultadoTr069.aviso}
              </p>
            )}
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variante="fantasma" onClick={onCerrar}>
            Close
          </Button>
          <Button
            variante="primario"
            icon={Globe}
            cargando={guardandoTr069}
            disabled={!puedeAplicarTr069}
            onClick={guardarTr069}
          >
            Update
          </Button>
        </div>
      </div>
    </Modal>
  )
}
