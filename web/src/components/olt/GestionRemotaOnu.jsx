import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { Button, ErrorBanner, Modal } from '../ui'

/**
 * La gestión remota de una ONT: perfil TR-069 e IP de gestión.
 *
 * ── Por qué las dos cosas en la misma ventana ──
 *
 * Porque no sirven por separado. El perfil dice CON QUÉ ACS habla la ONT; la IP
 * de gestión es POR DÓNDE llega hasta él. Un perfil sin IP no alcanza a nadie, y
 * una IP sin perfil deja la ONT accesible y sin quién la configure.
 *
 * En dos botones distintos, alguien hace la mitad y se va creyendo que terminó.
 *
 * ── Por qué se ve como SmartOLT y no como el resto del sistema ──
 *
 * Es a propósito: quien usa esto viene de mirar la misma ventana en SmartOLT
 * ("Update Management and VoIP IP") todos los días. Mismos campos, mismo
 * orden, mismos controles — para que no haya que aprender una pantalla nueva
 * encima de aprender un sistema nuevo. Los campos que SmartOLT ofrece y acá
 * todavía no se pueden tocar (interfaz por WAN, IP por DHCP, VoIP) se ven
 * IGUAL —el mismo botón de radio— pero bloqueados, con el motivo al lado: así
 * se sabe que no es un olvido, es que ese camino no está construido.
 *
 * ── Qué NO se pregunta ──
 *
 * La máscara, la puerta de enlace y los DNS de la IP de gestión. Salen de la
 * subred de gestión a la que pertenece la IP elegida, que el sistema ya tiene
 * cargada. Un gateway mal tipeado deja la ONT con IP y sin salida: se ve
 * configurada y no responde.
 */

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
      {opciones.some((o) => o.disabled && o.motivo) && (
        <p className="mt-1 text-[11px] text-slate-400">
          {opciones.find((o) => o.disabled && o.motivo)?.motivo}
        </p>
      )}
    </div>
  )
}

/** Un desplegable, al estilo del panel de SmartOLT. */
function CampoSelect({ etiqueta, value, onChange, children, disabled, hint, obligatorio }) {
  return (
    <div className="mb-3.5">
      <p className="mb-1.5 text-[13px] font-medium text-slate-700">
        {etiqueta}
        {obligatorio && <span className="text-rose-600"> *</span>}
      </p>
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

const TR069_INTERFAZ = [
  { valor: 'mgmt', label: 'via Mgmt IP' },
  { valor: 'wan', label: 'via WAN', disabled: true, motivo: 'No implementado en este sistema' },
]

const MGMT_IP_MODE = [
  { valor: 'inactive', label: 'Inactive' },
  { valor: 'static', label: 'Static IP' },
  { valor: 'dhcp', label: 'DHCP' },
]

const ACCESO_REMOTO = [
  { valor: 'no', label: 'No' },
  { valor: 'si', label: 'Sí, desde cualquier lado', disabled: true, motivo: 'No implementado' },
]

const VOIP = [
  { valor: 'off', label: 'Disabled' },
  { valor: 'on', label: 'Enabled (general switch)', disabled: true, motivo: 'VoIP no está implementado en este sistema' },
]

export default function GestionRemotaOnu({ olt, onu, actual, onListo, onCerrar }) {
  const [perfiles, setPerfiles] = useState(null)
  const [pools, setPools] = useState([])
  const [libres, setLibres] = useState(null)

  const [perfil, setPerfil] = useState(actual?.perfilId != null ? String(actual.perfilId) : '')
  const [poolId, setPoolId] = useState('')
  const [mgmtIpMode, setMgmtIpMode] = useState(actual?.ipConfigurada ? 'static' : 'inactive')
  const [ip, setIp] = useState(actual?.ipConfigurada ?? '')

  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [resultado, setResultado] = useState(null)

  /**
   * Los perfiles TR-069 de la OLT de la que cuelga esta ONT.
   *
   * ── Por qué de UNA sola OLT ──
   *
   * El panel general (`api.tr069.perfiles()`) le pregunta a TODAS y agrupa por
   * URL del ACS. Está bien para comparar equipos, pero cada consulta es una
   * sesión SSH de medio minuto: con tres OLTs, el desplegable de esta ventana
   * tardaba más de un minuto en habilitarse, y encima incluía una V-SOL que ni
   * siquiera sabe contestar eso.
   *
   * Acá interesa una sola cosa: qué perfiles tiene el equipo del que cuelga la
   * ONT. Ese número además es propio de cada OLT —el mismo GenieACS puede ser el
   * perfil 2 en una y el 5 en otra— así que preguntarle al equipo correcto no es
   * solo más rápido: es lo único que da el id que hay que mandar.
   */
  useEffect(() => {
    let vivo = true
    api.olt
      .tr069DeLaOlt(olt.id)
      .then((r) => {
        if (!vivo) return
        setPerfiles(
          (r?.perfiles ?? []).map((p) => ({
            nombre: p.nombre,
            url: p.url,
            profileId: p.id,
            onts: p.onts ?? 0,
            enEstaOlt: true,
          })),
        )
      })
      .catch(() => vivo && setPerfiles([]))
    return () => {
      vivo = false
    }
  }, [olt.id])

  /**
   * Los pools de gestión de ESTA OLT.
   *
   * Van por OLT porque cada una suele tener su propia VLAN de administración y
   * su propio bloque. Ofrecer los de otra dejaría la ONT con una dirección que
   * no enruta desde donde está colgada.
   *
   * Puede haber más de uno —una OLT con dos VLANs de gestión, por ejemplo— y
   * antes esta ventana solo miraba el primero sin dejar elegir. Se arranca en
   * el que ya tiene la VLAN configurada, si hay uno.
   */
  useEffect(() => {
    let vivo = true
    supabase
      .from('v_pools_onu')
      .select('*')
      .eq('olt_id', olt.id)
      .then(({ data }) => {
        if (!vivo) return
        const lista = data ?? []
        setPools(lista)
        const elActual = lista.find((p) => p.vlan === actual?.vlanGestion) ?? lista[0]
        if (elActual) setPoolId(elActual.id)
      })
    return () => {
      vivo = false
    }
  }, [olt.id])

  const pool = pools.find((p) => p.id === poolId) ?? pools[0] ?? null

  /**
   * Las direcciones libres del pool.
   *
   * Se muestran las libres MÁS la que la ONT ya tiene puesta: si solo se
   * listaran las libres, el desplegable arrancaría vacío para una ONT que sí
   * tiene IP, y parecería que hay que cambiársela.
   */
  useEffect(() => {
    if (!pool?.id) return
    let vivo = true
    supabase
      .from('ip_addresses')
      .select('ip_address, estado')
      // `v_pools_onu.id` ES el id de la subred: la vista no renombra la clave.
      .eq('subred_id', pool.id)
      .order('ip_address')
      .then(({ data }) => {
        if (!vivo) return
        const lista = (data ?? [])
          .filter((d) => d.estado === 'libre' || d.ip_address === actual?.ipConfigurada)
          .map((d) => d.ip_address)
        setLibres(lista)
      })
    return () => {
      vivo = false
    }
  }, [pool?.id, actual?.ipConfigurada])

  const modoActual = actual?.ipConfigurada ? 'static' : 'inactive'
  const cambioPerfil = perfil !== '' && Number(perfil) !== Number(actual?.perfilId)
  const cambioModoIp = mgmtIpMode !== modoActual
  const cambioIp = mgmtIpMode === 'static' && ip !== '' && ip !== actual?.ipConfigurada
  const puedeAplicarIp =
    mgmtIpMode === 'inactive' ||
    mgmtIpMode === 'dhcp' ||
    (mgmtIpMode === 'static' && Boolean(ip))
  const hayCambio = cambioPerfil || ((cambioModoIp || cambioIp) && puedeAplicarIp)

  async function guardar() {
    setGuardando(true)
    setError(null)
    setResultado(null)
    try {
      const cambiaIp = (cambioModoIp || cambioIp) && puedeAplicarIp
      const r = await api.olt.gestionOnu(olt.id, onu.onu_id, {
        ...(cambioPerfil ? { profile_id: Number(perfil) } : {}),
        ...(cambiaIp && mgmtIpMode === 'static' ? { ip, vlan: pool?.vlan ?? undefined } : {}),
        ...(cambiaIp && mgmtIpMode === 'dhcp' ? { modo: 'dhcp', vlan: pool?.vlan ?? undefined } : {}),
        ...(cambiaIp && mgmtIpMode === 'inactive' ? { modo: 'inactive' } : {}),
      })
      setResultado(r)
      await onListo?.()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal abierto titulo="Update Management and VoIP IP" onCerrar={onCerrar}>
      {/* Panel claro, al estilo SmartOLT, dentro del marco oscuro del sistema. */}
      <div className="-m-5 rounded-b-xl bg-white p-5 text-slate-800">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {/* --- TR069 Profile --- */}
        <p className="mb-2 border-b border-slate-200 pb-1.5 text-[13px] font-semibold text-sky-700">
          TR069 Profile
        </p>

        <CampoSelect
          etiqueta="TR069 Profile"
          value={perfil}
          onChange={(e) => setPerfil(e.target.value)}
          disabled={!perfiles}
        >
          <option value="">{perfiles ? '— sin cambiar —' : 'consultando la OLT…'}</option>
          {(perfiles ?? []).map((p) => (
            <option key={p.url ?? p.nombre} value={p.profileId ?? ''} disabled={!p.enEstaOlt}>
              {p.nombre}
              {p.url ? ` · ${p.url}` : ''}
              {p.enEstaOlt
                ? ` · perfil ${p.profileId}${p.onts ? ` · ${p.onts} ONTs` : ''}`
                : ' · no está creado en esta OLT'}
            </option>
          ))}
        </CampoSelect>

        <FilaRadio
          etiqueta="Tr069 interface"
          nombre="tr069-interfaz"
          opciones={TR069_INTERFAZ}
          valor="mgmt"
        />

        {perfiles?.length === 0 && (
          <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            No hay ningún perfil TR-069 cargado. Se crea en Red → TR-069, apuntando al ACS —el
            GenieACS de ustedes, por ejemplo—. Sin perfil, la ONT queda alcanzable pero nadie la
            configura sola.
          </p>
        )}

        {/* --- Mgmt IP --- */}
        <p className="mb-2 mt-4 border-b border-slate-200 pb-1.5 text-[13px] font-semibold text-sky-700">
          Mgmt IP
        </p>

        <FilaRadio
          etiqueta="Mgmt IP mode"
          nombre="mgmt-ip-mode"
          opciones={MGMT_IP_MODE}
          valor={mgmtIpMode}
          onChange={setMgmtIpMode}
        />
        <FilaRadio
          etiqueta="Allow remote access to Mgmt IP from everywhere"
          nombre="acceso-remoto"
          opciones={ACCESO_REMOTO}
          valor="no"
        />

        {mgmtIpMode === 'inactive' && (
          <p className="mb-3 text-[11px] text-slate-400">
            La ONT queda sin IP de gestión: sigue dando servicio, pero nadie va a poder hablarle
            —ni el ACS, ni este sistema— hasta que se le vuelva a poner una.
          </p>
        )}

        {pools.length > 0 ? (
          <>
            {/*
              Editable solo si hay más de un pool de gestión en esta OLT. Con
              uno solo no hay nada que elegir, y mostrarlo como desplegable
              vacío confundiría más de lo que ayuda.
            */}
            {pools.length > 1 ? (
              <CampoSelect
                etiqueta="Mgmt VLAN-ID"
                value={poolId}
                onChange={(e) => setPoolId(e.target.value)}
              >
                {pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.vlan} · {p.cidr}
                  </option>
                ))}
              </CampoSelect>
            ) : (
              <CampoSelect etiqueta="Mgmt VLAN-ID" value={String(pool?.vlan ?? '')} disabled onChange={() => {}}>
                <option>{pool?.vlan ?? '—'}</option>
              </CampoSelect>
            )}

            {mgmtIpMode === 'static' && (
              <CampoSelect
                etiqueta="Management IP address"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                disabled={!libres}
                hint={libres ? `${libres.length} disponibles en ${pool?.cidr}` : 'buscando libres…'}
              >
                <option value="">— sin cambiar —</option>
                {(libres ?? []).map((x) => (
                  <option key={x} value={x}>
                    {x}
                    {x === actual?.ipConfigurada ? ' · la que tiene ahora' : ''}
                  </option>
                ))}
              </CampoSelect>
            )}
          </>
        ) : (
          <p className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            Esta OLT no tiene ningún pool de gestión cargado, así que no hay de dónde sacar una
            dirección. Se declara en Red → Redes IPv4, marcándolo como pool de gestión de ONUs.
          </p>
        )}

        {mgmtIpMode === 'static' && (
          <p className="mb-4 text-[11px] text-slate-400">
            La máscara, la puerta de enlace y los DNS salen del pool elegido arriba: no se piden
            acá para que nadie los tipee mal.
          </p>
        )}

        {/* --- VoIP service --- */}
        <p className="mb-2 border-b border-slate-200 pb-1.5 text-[13px] font-semibold text-sky-700">
          VoIP service
        </p>
        <FilaRadio etiqueta="VoIP service" nombre="voip" opciones={VOIP} valor="off" />

        {resultado && (
          <p className="mb-2 rounded border border-sky-300 bg-sky-50 px-3 py-2 text-[12px] text-sky-800">
            {resultado.aviso}
            {resultado.ip?.ip && (
              <span className="mt-1 block">
                Quedó en <b>{resultado.ip.ip}</b>
                {resultado.ip.vlan ? ` · VLAN ${resultado.ip.vlan}` : ''}
              </span>
            )}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variante="fantasma" onClick={onCerrar}>
            Close
          </Button>
          <Button
            variante="primario"
            icon={Globe}
            cargando={guardando}
            disabled={!hayCambio}
            onClick={guardar}
          >
            Update
          </Button>
        </div>
      </div>
    </Modal>
  )
}
