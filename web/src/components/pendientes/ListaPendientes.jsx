import { useState } from 'react'
import { Check, CheckCircle2, ChevronRight, Circle, Lock, Pencil, Phone, RotateCcw, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { useConfirmar } from '../../lib/confirmar'
import { hoyLocal } from '../../lib/soporte'
import { estadoPendiente, etiquetaPendiente, ordenarPendientes } from '../../lib/pendientes'
import { Button, Modal, Textarea } from '../ui'
import PendienteForm from './PendienteForm'

/**
 * Una lista de pendientes.
 *
 * ── Por qué marcarlo hecho no es un toque ──
 *
 * La primera versión tenía una casilla en cada fila: un toque y quedaba hecho.
 * Era rápido, y por eso mismo se marcaban sin querer —tocando la fila para
 * verla, o al bajar con el dedo— y el pendiente desaparecía de "Míos" sin que
 * nadie lo hubiera hecho.
 *
 * Ahora tocar la fila ABRE el pendiente, y adentro está el botón "Marcar como
 * realizado", con lugar para anotar qué se hizo. Y uno hecho se puede volver a
 * abrir con "Deshacer". Quién y cuándo lo pone la base (migración 225).
 */

const CHIP = {
  vencido: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  hoy: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  proximo: 'border-slate-600 text-slate-300',
  sin_fecha: 'border-slate-700 text-slate-500',
  hecho: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
}

const fecha = (f) =>
  new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-EC', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })

const fechaHora = (f) =>
  new Date(f).toLocaleString('es-EC', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export const nombreDe = (u) => (u ? `${u.nombre ?? ''} ${u.apellido ?? ''}`.trim() : null)

function textoEstado(p, est, usuarios) {
  if (est === 'hecho') {
    return `Hecho ${fecha(p.hecho_at)}${p.hecho_por ? ` · ${nombreDe(usuarios.get(p.hecho_por)) ?? ''}` : ''}`
  }
  if (est === 'vencido') return `Venció el ${fecha(p.vence_el)}`
  if (est === 'hoy') return 'Para hoy'
  if (est === 'proximo') return `Para el ${fecha(p.vence_el)}`
  return 'Sin fecha'
}

export default function ListaPendientes({ pendientes = [], usuarios = new Map(), onCambio, onError, compacto = false }) {
  const { perfil } = usePermisos()
  const confirmar = useConfirmar()
  const [viendo, setViendo] = useState(null)
  const [editando, setEditando] = useState(null)
  const [nota, setNota] = useState('')
  const [guardando, setGuardando] = useState(false)
  const hoy = hoyLocal()

  const abrir = (p) => {
    setViendo(p)
    setNota(p.nota_cierre ?? '')
  }

  async function marcar(p, hecho) {
    setGuardando(true)
    const { error } = await supabase
      .from('pendientes')
      .update(
        hecho
          ? { hecho_at: new Date().toISOString(), nota_cierre: nota.trim() || null }
          : { hecho_at: null, nota_cierre: null },
      )
      .eq('id', p.id)
    setGuardando(false)
    if (error) return onError?.(error)
    setViendo(null)
    onCambio?.()
  }

  async function borrar(p) {
    const ok = await confirmar({
      titulo: 'Borrar el pendiente',
      mensaje: `¿Borrar "${etiquetaPendiente(p.tipo, p.tipo_otro)} · ${p.nombre}"? Si ya se hizo, mejor marcalo como realizado: queda el registro.`,
      etiquetaAccion: 'Borrar',
    })
    if (!ok) return
    const { error } = await supabase.from('pendientes').delete().eq('id', p.id)
    if (error) return onError?.(error)
    setViendo(null)
    onCambio?.()
  }

  if (!pendientes.length) return null

  const v = viendo
  const vEst = v ? estadoPendiente(v, hoy) : null
  const vHecho = vEst === 'hecho'

  return (
    <>
      <ul className="divide-y divide-slate-800">
        {ordenarPendientes(pendientes, hoy).map((p) => {
          const est = estadoPendiente(p, hoy)
          const hecho = est === 'hecho'
          const asignado = nombreDe(usuarios.get(p.asignado_a))
          return (
            <li key={p.id}>
              {/* Toda la fila abre el pendiente. El círculo solo dice cómo está:
                  ya no lo marca. */}
              <button
                type="button"
                onClick={() => abrir(p)}
                className="flex w-full items-start gap-3 py-2.5 text-left hover:bg-slate-800/30"
              >
                <span className={`mt-0.5 shrink-0 ${hecho ? 'text-emerald-400' : 'text-slate-600'}`} aria-hidden="true">
                  {hecho ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                </span>

                <span className="min-w-0 flex-1">
                  <span className={`block text-sm ${hecho ? 'text-slate-500 line-through' : 'text-slate-100'}`}>
                    <b>{etiquetaPendiente(p.tipo, p.tipo_otro)}</b>
                    {!compacto && <> · {p.nombre}</>}
                    {p.privado && <Lock size={12} className="ml-1 inline text-slate-500" />}
                  </span>
                  {p.detalle && <span className="block text-xs text-slate-400">{p.detalle}</span>}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                    <span className={`rounded-full border px-2 py-0.5 ${CHIP[est]}`}>{textoEstado(p, est, usuarios)}</span>
                    {!hecho && <span>{asignado ? `Le toca a ${asignado}` : 'Cualquiera de la oficina'}</span>}
                    <span>N° {p.numero}</span>
                  </span>
                </span>

                <ChevronRight size={16} className="mt-1 shrink-0 text-slate-600" />
              </button>
            </li>
          )
        })}
      </ul>

      {/* ── El pendiente abierto ── */}
      <Modal
        abierto={Boolean(v)}
        titulo={v ? `Pendiente N° ${v.numero}` : ''}
        onCerrar={() => setViendo(null)}
        ancho="max-w-xl"
      >
        {v && (
          <div className="space-y-4">
            <div>
              <p className="text-base font-semibold text-slate-100">
                {etiquetaPendiente(v.tipo, v.tipo_otro)}
                {v.privado && <Lock size={13} className="ml-1 inline text-slate-500" />}
              </p>
              <p className="text-sm text-slate-300">{v.nombre}</p>
              <p className="text-xs text-slate-500">
                {v.identificacion ? `C.I. ${v.identificacion}` : 'sin cédula'}
                {v.telefono && (
                  <>
                    {' · '}
                    <a href={`tel:${String(v.telefono).split(/[,/ ]/)[0]}`} className="inline-flex items-center gap-0.5 text-sky-400">
                      <Phone size={11} /> {v.telefono}
                    </a>
                  </>
                )}
              </p>
            </div>

            {v.detalle && <p className="rounded-lg bg-slate-800/40 p-3 text-sm text-slate-300">{v.detalle}</p>}

            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-slate-500">Estado</dt>
                <dd>
                  <span className={`rounded-full border px-2 py-0.5 ${CHIP[vEst]}`}>{textoEstado(v, vEst, usuarios)}</span>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Le toca a</dt>
                <dd className="text-slate-300">{nombreDe(usuarios.get(v.asignado_a)) ?? 'Cualquiera de la oficina'}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Lo pidió</dt>
                <dd className="text-slate-300">
                  {nombreDe(usuarios.get(v.creado_por)) ?? '—'} · {fechaHora(v.created_at)}
                </dd>
              </div>
              {vHecho && (
                <div>
                  <dt className="text-slate-500">Lo hizo</dt>
                  <dd className="text-slate-300">
                    {nombreDe(usuarios.get(v.hecho_por)) ?? '—'} · {fechaHora(v.hecho_at)}
                  </dd>
                </div>
              )}
            </dl>

            {vHecho ? (
              <>
                {v.nota_cierre && (
                  <p className="text-xs text-slate-400">
                    <b className="text-slate-300">Qué se hizo:</b> {v.nota_cierre}
                  </p>
                )}
                <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-3">
                  <Button variante="fantasma" onClick={() => setViendo(null)}>
                    Cerrar
                  </Button>
                  {/* Para el que lo marcó sin querer, o el trámite que se cayó
                      después: vuelve a "Míos" como estaba. */}
                  <Button icon={RotateCcw} cargando={guardando} onClick={() => marcar(v, false)}>
                    Deshacer: volver a pendiente
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label className="block text-xs text-slate-400">
                  ¿Qué se hizo? <span className="text-slate-600">(opcional)</span>
                  <Textarea
                    rows={2}
                    value={nota}
                    onChange={(e) => setNota(e.target.value)}
                    placeholder="Ej.: firmó el contrato, quedó en el plan de $23.10"
                    className="mt-1"
                  />
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-3">
                  <div className="flex gap-1">
                    <Button
                      variante="fantasma"
                      icon={Pencil}
                      onClick={() => {
                        setEditando(v)
                        setViendo(null)
                      }}
                    >
                      Editar
                    </Button>
                    {v.creado_por === perfil?.id && (
                      <Button variante="fantasma" icon={Trash2} onClick={() => borrar(v)}>
                        Borrar
                      </Button>
                    )}
                  </div>
                  <Button variante="primario" icon={Check} cargando={guardando} onClick={() => marcar(v, true)}>
                    Marcar como realizado
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      <Modal abierto={Boolean(editando)} titulo="Editar pendiente" onCerrar={() => setEditando(null)} ancho="max-w-2xl">
        {editando && (
          <PendienteForm
            inicial={editando}
            onError={onError}
            onCancelar={() => setEditando(null)}
            onGuardado={() => {
              setEditando(null)
              onCambio?.()
            }}
          />
        )}
      </Modal>
    </>
  )
}
