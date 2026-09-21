import { useCallback, useEffect, useMemo, useState } from 'react'
import { History, Terminal } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Card, Select, Field } from '../ui'

/**
 * Qué se le hizo a este abonado y quién lo hizo.
 *
 * Es la pantalla que se abre cuando alguien dice "yo no autoricé ese cambio de
 * plan" o "a mí nadie me cortó". Muestra dos cosas juntas porque en el momento
 * del reclamo son la misma pregunta: los cambios de datos —que registran los
 * disparadores de la base— y los comandos que se dispararon contra sus equipos.
 *
 * Se lee y no se edita. Un registro de auditoría que se puede corregir no sirve
 * como registro de auditoría, y la política de la base solo permite leerlo.
 */

const ENTIDADES = {
  facturas: 'Factura',
  pagos: 'Cobro',
  promesas_pago: 'Promesa de pago',
  clientes: 'Ficha del cliente',
  comunicaciones: 'Mensaje',
  comandos_ejecutados: 'Comando',
  // Las acciones con nombre propio no son "un cambio de campo": son una
  // decisión que alguien tomó, y por eso se muestran con su frase entera.
  accion: 'Acción',
}

const ACCIONES = {
  crear: { label: 'Creó', clase: 'text-emerald-400' },
  modificar: { label: 'Modificó', clase: 'text-sky-400' },
  eliminar: { label: 'Eliminó', clase: 'text-rose-400' },
  accion: { label: '', clase: 'text-amber-400' },
}

// Los nombres técnicos no se le muestran a nadie: "plan_id" no dice nada en el
// mostrador, "Plan" sí.
const CAMPOS = {
  ip: 'IP',
  plan_id: 'Plan',
  estado: 'Estado',
  precio_mensual: 'Precio mensual',
  usuario_ppp: 'Usuario PPPoE',
  clave_ppp: 'Clave PPPoE',
  nap_id: 'Caja NAP',
  puerto_nap: 'Puerto',
  conectado_a_id: 'Conectado a',
  tipo_conexion: 'Tipo de conexión',
  modalidad_pago: 'Modalidad de pago',
  dia_facturacion: 'Día de pago',
  aplicar_corte: 'Aplicar corte',
  factura_electronica: 'Factura electrónica',
  descuento_tipo: 'Descuento de ley',
  descuento_porcentaje: 'Porcentaje de descuento',
  promo_porcentaje: 'Promoción',
  promo_meses: 'Meses de promoción',
  total: 'Total',
  monto: 'Monto',
  anulada: 'Anulada',
  anulado: 'Anulado',
}

const fechaHora = (f) =>
  f ? new Date(f).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' }) : '—'

/** Un valor como se lee en el mostrador, no como lo guarda la base. */
function valor(v) {
  if (v === null || v === undefined) return '—'
  if (v === true) return 'sí'
  if (v === false) return 'no'
  const s = String(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

export default function FichaAuditoria({ cliente, onError }) {
  const [logs, setLogs] = useState([])
  const [comandos, setComandos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [filtro, setFiltro] = useState('todo')

  const recargar = useCallback(async () => {
    setCargando(true)

    /*
     * ── Por qué se leen DOS registros de auditoría ──
     *
     * Porque el sistema tiene dos y guardan cosas distintas:
     *
     *   `audit_logs`        los cambios de campo, que anotan los disparadores
     *                       de la base: cambió el plan, cambió la IP.
     *   `auditoria_sistema` las acciones con nombre propio: dio de baja al
     *                       abonado, saldó su deuda de equipo, aprobó un pago.
     *
     * Esta pestaña leía solo el primero, así que la baja de un abonado —con su
     * motivo— y el saldado de su deuda no aparecían en su propia ficha. Había
     * que ir a Ajustes → Personal a buscarlos, que es el lugar equivocado para
     * responderle a un vendedor que pregunta por SU cliente.
     */
    const [a, c, sis] = await Promise.all([
      supabase
        .from('v_audit_logs')
        .select('*')
        .eq('client_id', cliente.id)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('comandos_ejecutados')
        .select('*')
        .eq('client_id', cliente.id)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('auditoria_sistema')
        .select('*')
        .eq('entidad', 'cliente')
        .eq('entidad_id', cliente.id)
        .order('creado_en', { ascending: false })
        .limit(100),
    ])

    if (a.error) onError?.(a.error)

    /*
     * Se normalizan al mismo molde y se ordenan juntos. Dos listas separadas
     * obligarían a leer dos veces y a cruzar las horas en la cabeza, que es
     * justo lo que no se puede hacer con un cliente enojado del otro lado.
     */
    const acciones = (sis.data ?? []).map((x) => ({
      id: `sis-${x.id}`,
      created_at: x.creado_en,
      entidad: 'accion',
      accion: 'accion',
      titulo: x.descripcion,
      actor_email: x.usuario_nombre,
      actor_rol: x.usuario_rol,
      ip: x.ip,
      campos: [],
    }))

    setLogs(
      [...(a.data ?? []), ...acciones].sort(
        (x, y) => new Date(y.created_at) - new Date(x.created_at),
      ),
    )
    setComandos(c.data ?? [])
    setCargando(false)
  }, [cliente.id, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  const visibles = useMemo(
    () => (filtro === 'todo' ? logs : logs.filter((l) => l.entidad === filtro)),
    [logs, filtro],
  )

  return (
    <div className="space-y-4">
      <Card
        title="Registro de actividad"
        icon={History}
        subtitle="Quién cambió qué, cuándo y desde dónde"
      >
        <div className="mb-4 max-w-xs">
          <Field label="Filtrar por">
            <Select value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              <option value="todo">Todo</option>
              {Object.entries(ENTIDADES).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {cargando ? (
          <p className="text-sm text-slate-500">Cargando…</p>
        ) : !visibles.length ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Sin movimientos registrados{filtro !== 'todo' ? ' de ese tipo' : ''}.
          </p>
        ) : (
          <ol className="space-y-2">
            {visibles.map((l) => {
              const accion = ACCIONES[l.accion] ?? ACCIONES.modificar
              const campos = l.campos ?? []

              return (
                <li key={l.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    {l.titulo ? (
                      <span className="text-amber-300">{l.titulo}</span>
                    ) : (
                      <>
                        <b className={accion.clase}>{accion.label}</b>
                        <span className="text-slate-300">
                          {ENTIDADES[l.entidad] ?? l.entidad}
                        </span>
                      </>
                    )}
                    <span className="ml-auto text-[11px] text-slate-500">
                      {fechaHora(l.created_at)}
                    </span>
                  </div>

                  {/* El antes y el después, campo por campo: sin eso "modificó
                      la ficha" no responde nada de lo que se pregunta. */}
                  {l.accion === 'modificar' && campos.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {campos.map((c) => (
                        <li key={c} className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span className="text-slate-500">{CAMPOS[c] ?? c}:</span>
                          <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-rose-300 line-through">
                            {valor(l.antes?.[c])}
                          </span>
                          <span className="text-slate-600">→</span>
                          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">
                            {valor(l.despues?.[c])}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                    <span>
                      {l.actor_email ? (
                        <b className="text-slate-400">{l.actor_email}</b>
                      ) : (
                        <span className="text-slate-500">sistema</span>
                      )}
                    </span>
                    {l.ip_origen && <span>desde {l.ip_origen}</span>}
                  </p>
                </li>
              )
            })}
          </ol>
        )}
      </Card>

      <Card
        title="Comandos ejecutados"
        icon={Terminal}
        subtitle="Lo que se disparó contra sus equipos"
      >
        {!comandos.length ? (
          <p className="py-6 text-center text-sm text-slate-500">
            No se ejecutó ningún comando sobre este abonado.
          </p>
        ) : (
          <ul className="space-y-2">
            {comandos.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-sm"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${c.exito ? 'bg-emerald-400' : 'bg-rose-400'}`}
                />
                <b className="font-mono text-xs text-slate-200">{c.comando}</b>
                <span className="text-[11px] text-slate-500">
                  {c.destino_nombre ?? c.destino_tipo}
                </span>
                {c.duracion_ms != null && (
                  <span className="text-[11px] text-slate-600">{c.duracion_ms} ms</span>
                )}
                <span className="ml-auto text-[11px] text-slate-500">{fechaHora(c.created_at)}</span>

                {c.error && (
                  <p className="w-full rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
                    {c.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
