import { useState } from 'react'
import { Check, Cpu, KeyRound, Pencil, RefreshCw, Server, X } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { guardarOlt, TR069_INTERFACES, hace } from '../../lib/olts'
import SaludOlt from './SaludOlt'
import { Aviso, Badge, Button, Card, ErrorBanner, Input, Punto, Select } from '../ui'

/**
 * Pestaña "Detalles": todo lo que define a la OLT, en clave/valor.
 *
 * Las credenciales se muestran como "cargada" o "sin cargar" y nunca en claro.
 * El sistema cifra en un solo sentido a propósito: si existiera la vuelta,
 * cualquier sesión válida podría llevarse las claves de todos los equipos.
 */

function Fila({ etiqueta, children, ayuda }) {
  return (
    <tr className="border-b border-slate-800/70 last:border-0">
      <td className="w-[45%] px-3 py-2.5 align-top">
        <span className="text-xs text-slate-400">{etiqueta}</span>
        {ayuda && <p className="mt-0.5 text-[10px] leading-snug text-slate-600">{ayuda}</p>}
      </td>
      <td className="px-3 py-2.5 align-top text-sm text-slate-100">{children}</td>
    </tr>
  )
}

const Si = ({ v, si = 'Sí', no = 'No' }) => (
  <Badge color={v ? 'verde' : 'gris'}>{v ? si : no}</Badge>
)

/**
 * Estado de una credencial guardada.
 *
 * Dice si está cargada, jamás qué dice. Distinguir "cargada" de "vacía" es lo
 * que hace falta para operar: un campo vacío explica por qué la conexión falla,
 * y para eso no hace falta ver el valor.
 */
const Secreto = ({ cargado }) => (
  <span className="flex items-center gap-2">
    <span className="font-mono text-slate-500">••••••••</span>
    {cargado ? (
      <Badge color="verde">cargada</Badge>
    ) : (
      <Badge color="ambar">sin cargar</Badge>
    )}
  </span>
)

/** Campo editable en el lugar, sin abrir el formulario entero. */
function Editable({ valor, placeholder, onGuardar, children, tipo = 'texto', opciones }) {
  const [editando, setEditando] = useState(false)
  const [borrador, setBorrador] = useState(valor ?? '')
  const [guardando, setGuardando] = useState(false)

  async function confirmar() {
    setGuardando(true)
    try {
      await onGuardar(borrador.trim() === '' ? null : borrador.trim())
      setEditando(false)
    } finally {
      setGuardando(false)
    }
  }

  if (!editando) {
    return (
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0">{children}</span>
        <button
          type="button"
          onClick={() => {
            setBorrador(valor ?? '')
            setEditando(true)
          }}
          className="shrink-0 text-slate-500 hover:text-sky-300"
          title="Editar"
        >
          <Pencil size={13} />
        </button>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1.5">
      {tipo === 'select' ? (
        <Select value={borrador ?? ''} onChange={(e) => setBorrador(e.target.value)}>
          {opciones.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          autoFocus
          value={borrador ?? ''}
          placeholder={placeholder}
          onChange={(e) => setBorrador(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirmar()
            if (e.key === 'Escape') setEditando(false)
          }}
        />
      )}
      <Button variante="primario" icon={Check} onClick={confirmar} cargando={guardando} />
      <Button variante="fantasma" icon={X} onClick={() => setEditando(false)} />
    </span>
  )
}

export default function OltDetalles({ olt, onRecargar }) {
  const [error, setError] = useState(null)
  const [leyendo, setLeyendo] = useState(false)
  const [detectando, setDetectando] = useState(false)
  const [aviso, setAviso] = useState(null)

  async function detectarComunidad() {
    setDetectando(true)
    setError(null)
    setAviso(null)
    try {
      const r = await api.olt.detectarComunidad(olt.id)
      setAviso(
        `Comunidad de ${r.tipo} guardada cifrada (${r.caracteres} caracteres). No se muestra el valor.`,
      )
      await onRecargar()
    } catch (err) {
      setError(err)
    } finally {
      setDetectando(false)
    }
  }

  const cambiar = async (cambios) => {
    try {
      await guardarOlt(olt.id, cambios)
      await onRecargar()
    } catch (err) {
      setError(err)
    }
  }

  async function leerVersiones() {
    setLeyendo(true)
    setError(null)
    try {
      await api.olt.versiones(olt.id)
      await onRecargar()
    } catch (err) {
      setError(err)
    } finally {
      setLeyendo(false)
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      {aviso && <Aviso>{aviso}</Aviso>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* --- Panel izquierdo: los ajustes --- */}
        <Card title="Configuración del equipo" icon={Server}>
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2 text-left font-medium">Parámetro</th>
                <th className="px-3 py-2 text-left font-medium">Valor</th>
              </tr>
            </thead>
            <tbody>
              <Fila etiqueta="Nombre">
                <Editable valor={olt.nombre} onGuardar={(v) => cambiar({ nombre: v })}>
                  {olt.nombre}
                </Editable>
              </Fila>

              <Fila etiqueta="IP de gestión">
                <Editable valor={olt.ip_host} onGuardar={(v) => cambiar({ ip_host: v })}>
                  <span className="font-mono text-xs">{olt.ip_host}</span>
                </Editable>
              </Fila>

              <Fila
                etiqueta="Se llega por túnel VPN"
                ayuda="Cambia el diagnóstico cuando no responde: primero se mira el túnel."
              >
                <button type="button" onClick={() => cambiar({ via_vpn: !olt.via_vpn })}>
                  <Si v={olt.via_vpn} />
                </button>
              </Fila>

              <Fila etiqueta="Puerto TCP (telnet/SSH)">
                <Editable
                  valor={String(olt.puerto_ssh ?? '')}
                  onGuardar={(v) => cambiar({ puerto_ssh: Number(v) || 22 })}
                >
                  <span className="font-mono text-xs">{olt.puerto_ssh}</span>
                </Editable>
              </Fila>

              <Fila etiqueta="Usuario de acceso">
                <span className="font-mono text-xs">{olt.usuario}</span>
              </Fila>

              <Fila
                etiqueta="Contraseña de acceso"
                ayuda="Se guarda cifrada y no se puede volver a mostrar. Para cambiarla, usá «Editar ajustes»."
              >
                <Secreto cargado />
              </Fila>

              <Fila etiqueta="Contraseña de enable">
                <Secreto cargado={olt.tiene_enable} />
              </Fila>

              <Fila
                etiqueta="Comunidad SNMP de solo lectura"
                ayuda="Es la que usa la lectura masiva de potencia óptica y el inventario de ONUs."
              >
                <span className="flex flex-wrap items-center gap-2">
                  <Secreto cargado={olt.tiene_snmp_ro} />
                  {/* Se la pide al propio equipo: así no hay que copiarla,
                      mandarla por chat ni tipearla. Del equipo a la columna
                      cifrada, sin pasar por ninguna pantalla. */}
                  <Button
                    variante="fantasma"
                    icon={KeyRound}
                    onClick={detectarComunidad}
                    cargando={detectando}
                    title="Se la lee del equipo y se guarda cifrada. El valor no se muestra."
                    className="text-xs"
                  >
                    Detectar del equipo
                  </Button>
                </span>
              </Fila>

              <Fila etiqueta="Comunidad SNMP de lectura/escritura">
                <Secreto cargado={olt.tiene_snmp_rw} />
              </Fila>

              <Fila etiqueta="Puerto UDP (SNMP)">
                <Editable
                  valor={String(olt.snmp_puerto ?? '')}
                  onGuardar={(v) => cambiar({ snmp_puerto: Number(v) || 161 })}
                >
                  <span className="font-mono text-xs">{olt.snmp_puerto}</span>
                </Editable>
              </Fila>

              <Fila etiqueta="Escucha de traps SNMP">
                <button type="button" onClick={() => cambiar({ snmp_trap: !olt.snmp_trap })}>
                  <Si v={olt.snmp_trap} si="Activada" no="Desactivada" />
                </button>
              </Fila>

              <Fila etiqueta="Módulo IPTV">
                <button type="button" onClick={() => cambiar({ iptv: !olt.iptv })}>
                  <Si v={olt.iptv} si="Activado" no="Desactivado" />
                </button>
              </Fila>

              <Fila
                etiqueta="Versión de hardware"
                ayuda={
                  olt.versiones_at
                    ? `Leída del equipo ${hace(Math.floor((Date.now() - new Date(olt.versiones_at)) / 1000))}`
                    : 'Nunca se leyó del equipo'
                }
              >
                {olt.hw_version ?? <span className="text-slate-600">sin leer</span>}
              </Fila>

              <Fila etiqueta="Versión de software">
                {olt.sw_version ?? <span className="text-slate-600">sin leer</span>}
              </Fila>

              <Fila etiqueta="Tipos PON soportados">
                {olt.pon_tipos ?? <span className="text-slate-600">sin leer</span>}
              </Fila>

              <Fila
                etiqueta="Servidores NTP"
                ayuda="Separados por coma. Sin esto el reloj se corre y los eventos dejan de poder cruzarse."
              >
                <Editable
                  valor={olt.ntp_servers}
                  placeholder="200.1.1.1, 200.1.1.2"
                  onGuardar={(v) => cambiar({ ntp_servers: v })}
                >
                  {olt.ntp_servers ? (
                    <span className="font-mono text-xs">{olt.ntp_servers}</span>
                  ) : (
                    <span className="text-amber-400/80">sin configurar</span>
                  )}
                </Editable>
              </Fila>

              <Fila etiqueta="Perfil TR069">
                <Editable
                  valor={olt.tr069_perfil}
                  placeholder="Nombre del perfil"
                  onGuardar={(v) => cambiar({ tr069_perfil: v })}
                >
                  {olt.tr069_perfil ?? <span className="text-slate-600">ninguno</span>}
                </Editable>
              </Fila>

              <Fila etiqueta="Interfaz TR069 de la ONU">
                <Editable
                  tipo="select"
                  valor={olt.tr069_interfaz ?? 'mgmt_ip'}
                  opciones={Object.entries(TR069_INTERFACES).map(([v, o]) => [v, o.label])}
                  onGuardar={(v) => cambiar({ tr069_interfaz: v })}
                >
                  {TR069_INTERFACES[olt.tr069_interfaz ?? 'mgmt_ip']?.label}
                </Editable>
              </Fila>

              <Fila etiqueta="Notas">
                <Editable
                  valor={olt.notas}
                  placeholder="Ubicación, contacto del sitio, particularidades…"
                  onGuardar={(v) => cambiar({ notas: v })}
                >
                  {olt.notas ?? <span className="text-slate-600">—</span>}
                </Editable>
              </Fila>
            </tbody>
          </table>
        </Card>

        {/* --- Panel derecho: identidad y telemetría --- */}
        <div className="space-y-4">
          <Card title="Equipo" icon={Cpu}>
            <div className="space-y-3">
              <div
                className={`rounded-lg border px-4 py-3 ${
                  olt.marca === 'Huawei'
                    ? 'border-rose-500/30 bg-rose-500/5'
                    : 'border-sky-500/30 bg-sky-500/5'
                }`}
              >
                <p
                  className={`text-lg font-bold tracking-tight ${
                    olt.marca === 'Huawei' ? 'text-rose-300' : 'text-sky-300'
                  }`}
                >
                  {olt.marca}
                </p>
                <p className="text-xs text-slate-400">{olt.hw_version ?? 'modelo sin leer'}</p>
              </div>

              <div className="flex items-center justify-between t-panel px-3 py-2">
                <span className="flex items-center gap-2 text-xs text-slate-400">
                  <Punto estado={olt.estado} />
                  {olt.estado === 'online'
                    ? `Responde en ${olt.estado_latencia_ms} ms`
                    : olt.estado === 'offline'
                      ? 'No responde'
                      : 'Sin consultar'}
                </span>
                <span className="text-[11px] text-slate-600">{hace(olt.estado_hace_segundos)}</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="t-panel px-2 py-2">
                  <p className="t-titulo text-lg font-bold text-slate-100">{olt.onus_total ?? 0}</p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">ONUs</p>
                </div>
                <div className="t-panel px-2 py-2">
                  <p className="text-lg font-semibold text-emerald-400">{olt.onus_online ?? 0}</p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">en línea</p>
                </div>
              </div>

              <Button
                icon={RefreshCw}
                onClick={leerVersiones}
                cargando={leyendo}
                className="w-full"
              >
                Leer modelo y firmware del equipo
              </Button>
              <p className="text-[11px] leading-snug text-slate-500">
                Abre una sesión y pregunta la versión. Es lo que después permite detectar que
                alguien actualizó el firmware por fuera del sistema.
              </p>
            </div>
          </Card>

          {/* La telemetría no se pide sola: son nueve comandos por la CLI y
              tarda una media docena de segundos larga. */}
          <SaludOlt olt={olt} auto={false} />
        </div>
      </div>
    </div>
  )
}
