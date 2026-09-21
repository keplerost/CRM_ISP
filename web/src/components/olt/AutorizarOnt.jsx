import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Save, Zap } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Cargando, ErrorBanner, Field, Input, Select } from '../ui'

/**
 * Autorizar una ONT que está esperando.
 *
 * El criterio de la pantalla: **lo que el sistema ya sabe, no se pregunta**.
 *
 * La serie, la placa y el puerto los trae el equipo. El nombre, la dirección y
 * el plan salen de la orden de instalación, que se encuentra sola porque el
 * técnico escaneó el QR de esa misma ONT al instalarla. El perfil de servicio
 * se propone por el modelo que reportó la ONT.
 *
 * Queda para tipear lo único que de verdad varía: la VLAN. Todo lo demás está
 * lleno y editable — poder corregirlo no es lo mismo que tener que cargarlo.
 */

/** Sólo lectura: lo dice el equipo y no se discute desde acá. */
function Fijo({ label, valor, hint }) {
  return (
    <Field label={label} hint={hint}>
      <div className="t-card-sm px-3 py-2 text-sm text-slate-300">
        {valor ?? '—'}
      </div>
    </Field>
  )
}

export default function AutorizarOnt({ olt, ont, onListo, onCancelar }) {
  const [datos, setDatos] = useState(null)
  const [form, setForm] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [resultado, setResultado] = useState(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const d = await api.olt.datosAutorizacion(olt.olt_id ?? olt.id, ont.sn)
      setDatos(d)
      setForm({
        lineProfileId: d.sugerido.line_profile_id ?? '',
        srvProfileId: d.sugerido.srv_profile_id ?? '',
        vlan: d.sugerido.vlan ?? '',
        gemport: d.sugerido.gemport ?? 1,
        plan_id: d.sugerido.plan_id ?? '',
        nombre: d.sugerido.nombre ?? '',
        comentario: d.sugerido.comentario ?? '',
        instalacion_id: d.instalacion?.id ?? null,
      })
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [olt, ont.sn])

  useEffect(() => {
    cargar()
  }, [cargar])

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function autorizar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      const r = await api.olt.autorizar(olt.olt_id ?? olt.id, {
        sn: ont.sn,
        slot: ont.slot,
        puerto: ont.puerto,
        ...form,
        vlan: Number(form.vlan),
        gemport: Number(form.gemport) || 1,
      })
      setResultado(r)
      onListo?.()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando texto="Buscando la orden de instalación y los perfiles del equipo…" />

  if (resultado) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
          <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-400" />
          <div>
            <p className="font-medium text-emerald-300">
              ONT autorizada en la placa {resultado.slot} puerto {resultado.puerto}, ONT-ID{' '}
              {resultado.ontId}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">
              {resultado.guardadaEnBase
                ? 'Registrada en el equipo y guardada en el sistema.'
                : 'Registrada en el equipo. No se pudo guardar en el sistema — revisá el detalle.'}
            </p>
          </div>
        </div>

        {resultado.comandos?.length > 0 && (
          <div className="rounded-lg border border-slate-800 bg-black/40 p-3">
            <p className="mb-1 text-[11px] uppercase tracking-wider text-slate-500">
              Lo que se le mandó al equipo
            </p>
            {resultado.comandos.map((c) => (
              <pre key={c} className="whitespace-pre-wrap break-all font-mono text-[11px] text-slate-400">
                {c}
              </pre>
            ))}
          </div>
        )}

        {resultado.ip_gestion && (
          <p className="text-xs text-slate-400">
            IP de gestión configurada sola:{' '}
            <span className="font-mono text-slate-200">{resultado.ip_gestion}</span>
          </p>
        )}

        {resultado.aviso && <Aviso tipo="alerta">{resultado.aviso}</Aviso>}

        {/* Cuando el equipo no acepta configuración remota, esto es lo que el
            técnico tiene que escribir a mano — junto y en el momento en que
            hace falta, no repartido en tres pantallas. */}
        {resultado.ficha_manual && <FichaManual ficha={resultado.ficha_manual} />}
      </div>
    )
  }

  const sinInstalacion = !datos?.instalacion

  return (
    <form onSubmit={autorizar} className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {sinInstalacion ? (
        <Aviso tipo="alerta">
          No hay ninguna orden de instalación con la serie <b>{ont.sn}</b>. El nombre, la dirección
          y el plan hay que cargarlos a mano — o cargar la instalación primero, escaneando el QR de
          este equipo, y volver acá.
        </Aviso>
      ) : (
        <Aviso>
          Datos tomados de la instalación de <b>{datos.instalacion.nombre}</b>
          {datos.instalacion.direccion ? ` · ${datos.instalacion.direccion}` : ''}. Se encontró por
          la serie que escaneó el técnico.
        </Aviso>
      )}

      {/* --- Lo que dice el equipo --- */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Fijo label="OLT" valor={datos.olt?.nombre} />
        <Fijo label="Placa" valor={ont.slot} />
        <Fijo
          label="Puerto"
          valor={ont.puerto}
          hint={
            datos.puerto
              ? `${datos.puerto.ocupados} de ${datos.puerto.capacidad} ONTs · ${datos.puerto.libres} libres`
              : undefined
          }
        />
        <Fijo label="Serie" valor={ont.sn} className="sm:col-span-2" />
        <Fijo label="Modelo detectado" valor={ont.modelo ?? '—'} />
      </div>

      {/* --- Perfiles --- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Line-profile"
          hint="Define la VLAN y los GEM ports. El propuesto es el que usa la mayoría de tus ONTs."
        >
          <Select value={form.lineProfileId} onChange={set('lineProfileId')} required>
            <option value="">— elegí —</option>
            {datos.perfiles.line.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.nombre}
                {p.usos ? ` (${p.usos} ONTs)` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Service-profile"
          hint={
            datos.sugerido.srv_por_modelo
              ? `Propuesto por el modelo que reportó la ONT (${ont.modelo}).`
              : 'No hay uno que coincida con el modelo: elegilo a mano.'
          }
        >
          <Select value={form.srvProfileId} onChange={set('srvProfileId')} required>
            <option value="">— elegí —</option>
            {datos.perfiles.srv.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.nombre}
                {p.usos ? ` (${p.usos} ONTs)` : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* --- Lo que casi siempre hay que tocar --- */}
      <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="VLAN de usuario"
            hint="Es el dato que cambia en cada alta."
          >
            <Input
              type="number"
              value={form.vlan}
              onChange={set('vlan')}
              min={1}
              max={4094}
              required
              autoFocus
            />
          </Field>
          <Field label="GEM port">
            <Input type="number" value={form.gemport} onChange={set('gemport')} min={1} />
          </Field>
          <Field
            label="Plan"
            hint="Define la velocidad: se aplica con las traffic tables del equipo."
          >
            <Select value={form.plan_id} onChange={set('plan_id')}>
              <option value="">— sin plan —</option>
              {datos.planes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre} ({Math.round(p.bajada_kbps / 1000)}/{Math.round(p.subida_kbps / 1000)} Mbps)
                  {p.traffic_table_index == null ? ' — sin índice' : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {form.plan_id &&
          datos.planes.find((p) => p.id === form.plan_id)?.traffic_table_index == null && (
            <p className="mt-2 text-xs text-amber-300">
              Ese plan no tiene índice de traffic table, así que la ONT va a quedar autorizada pero
              sin límite de velocidad aplicado. Se le asigna desde Servicios → Planes.
            </p>
          )}
      </div>

      {/* --- Identificación --- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre" hint={sinInstalacion ? undefined : 'De la orden de instalación'}>
          <Input value={form.nombre} onChange={set('nombre')} required />
        </Field>
        <Field label="Dirección o comentario">
          <Input value={form.comentario} onChange={set('comentario')} />
        </Field>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        El nombre y la dirección van a la descripción de la ONT dentro del equipo, con el mismo
        formato que ya usan tus otras {datos.perfiles.line.find((p) => p.usos > 50)?.usos ?? ''} ONTs.
        Así se sigue leyendo igual desde la CLI y desde cualquier otro sistema.
      </p>

      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-3">
        {onCancelar && (
          <Button type="button" variante="fantasma" onClick={onCancelar}>
            Cancelar
          </Button>
        )}
        <Button type="submit" variante="exito" icon={Save} cargando={guardando}>
          Autorizar
        </Button>
      </div>

      <p className="text-[11px] text-slate-600">
        <Zap size={11} className="mr-1 inline" />
        Esto escribe en la OLT de producción: registra la ONT y le crea su service-port. Es
        reversible —se puede eliminar— pero le da servicio a un abonado real.
      </p>
    </form>
  )
}

/**
 * Lo que hay que cargar a mano en la ONT.
 *
 * Aparece cuando el equipo no acepta TR069. El técnico está en la calle, con la
 * ONT en la mano y el celular en la otra: los datos van grandes, en monoespaciada
 * y con un botón para copiar cada uno, porque tipearlos mirando una pantalla
 * chica es exactamente donde aparece el error.
 */
function FichaManual({ ficha }) {
  const [copiado, setCopiado] = useState(null)

  const copiar = async (texto, cual) => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(cual)
      setTimeout(() => setCopiado(null), 1500)
    } catch {
      // Sin permiso de portapapeles no pasa nada: el valor está a la vista.
    }
  }

  const Dato = ({ etiqueta, valor, cual }) =>
    valor ? (
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 py-1.5 last:border-0">
        <span className="shrink-0 text-[11px] uppercase tracking-wider text-slate-500">
          {etiqueta}
        </span>
        <button
          type="button"
          onClick={() => copiar(valor, cual)}
          title="Copiar"
          className="min-w-0 truncate rounded px-1.5 py-0.5 text-right font-mono text-sm text-slate-100 hover:bg-slate-800"
        >
          {copiado === cual ? '¡copiado!' : valor}
        </button>
      </div>
    ) : null

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <div>
        <p className="text-sm font-semibold text-amber-200">Configurá el equipo a mano</p>
        <p className="mt-0.5 text-xs leading-snug text-amber-200/80">
          Esta ONT no se pudo configurar sola. Entrá a su interfaz web y cargá esto. Tocá cualquier
          valor para copiarlo.
        </p>
      </div>

      <div className="t-card-sm px-3">
        <p className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Internet — WAN en modo {ficha.modo}
        </p>
        <Dato etiqueta="Usuario" valor={ficha.pppoe.usuario} cual="u" />
        <Dato etiqueta="Contraseña" valor={ficha.pppoe.clave} cual="c" />
        <Dato etiqueta="VLAN" valor={ficha.vlan} cual="v" />
      </div>

      <div className="t-card-sm px-3">
        <p className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          WiFi
        </p>
        <Dato etiqueta="Nombre de red" valor={ficha.wifi.ssid} cual="s" />
        <Dato etiqueta="Clave" valor={ficha.wifi.clave} cual="w" />
      </div>

      {ficha.gestion && (
        <div className="t-card-sm px-3">
          <p className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Gestión — opcional, pero con esto el sistema la va a poder alcanzar
          </p>
          <Dato etiqueta="IP" valor={ficha.gestion.ip} cual="gi" />
          <Dato etiqueta="Máscara" valor={ficha.gestion.mascara} cual="gm" />
          <Dato etiqueta="Gateway" valor={ficha.gestion.gateway} cual="gg" />
          <Dato etiqueta="DNS 1" valor={ficha.gestion.dns1} cual="g1" />
          <Dato etiqueta="DNS 2" valor={ficha.gestion.dns2} cual="g2" />
          <Dato etiqueta="VLAN de gestión" valor={ficha.gestion.vlan} cual="gv" />
        </div>
      )}

      {/* Un campo vacío se lee como "no hace falta" y el técnico lo saltea. Lo
          que falta se dice con todas las letras. */}
      {ficha.faltantes?.length > 0 && (
        <Aviso tipo="alerta">
          Falta {ficha.faltantes.join(' y ')}. Completalo en el paso de red de la instalación antes
          de cargar el equipo, o el abonado no va a poder autenticar.
        </Aviso>
      )}

      <p className="text-[11px] leading-snug text-slate-500">
        El nombre y la clave de WiFi ya quedaron guardados en la ficha de la ONU. Si en el equipo
        ponés otros, cambialos también ahí — es lo que el soporte va a leer cuando el abonado llame
        preguntando su clave.
      </p>
    </div>
  )
}
