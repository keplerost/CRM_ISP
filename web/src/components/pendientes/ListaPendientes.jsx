import { useState } from 'react'
import { CheckCircle2, Circle, Lock, Pencil, Phone, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { useConfirmar } from '../../lib/confirmar'
import { hoyLocal } from '../../lib/soporte'
import { estadoPendiente, etiquetaPendiente, ordenarPendientes } from '../../lib/pendientes'
import { Modal } from '../ui'
import PendienteForm from './PendienteForm'

/**
 * Una lista de pendientes con su casilla.
 *
 * Tildar es UN toque: es lo que más se hace y no puede costar una pantalla.
 * Quién y cuándo lo pone la base (migración 225).
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

export const nombreDe = (u) => (u ? `${u.nombre ?? ''} ${u.apellido ?? ''}`.trim() : null)

export default function ListaPendientes({ pendientes = [], usuarios = new Map(), onCambio, onError, compacto = false }) {
  const { perfil } = usePermisos()
  const confirmar = useConfirmar()
  const [editando, setEditando] = useState(null)
  const hoy = hoyLocal()

  async function tildar(p) {
    const { error } = await supabase
      .from('pendientes')
      .update({ hecho_at: p.hecho_at ? null : new Date().toISOString() })
      .eq('id', p.id)
    if (error) return onError?.(error)
    onCambio?.()
  }

  async function borrar(p) {
    const ok = await confirmar({
      titulo: 'Borrar el pendiente',
      mensaje: `¿Borrar "${etiquetaPendiente(p.tipo, p.tipo_otro)} · ${p.nombre}"? Si ya se hizo, mejor tildalo: queda el registro.`,
      etiquetaAccion: 'Borrar',
    })
    if (!ok) return
    const { error } = await supabase.from('pendientes').delete().eq('id', p.id)
    if (error) return onError?.(error)
    onCambio?.()
  }

  if (!pendientes.length) return null

  return (
    <>
      <ul className="divide-y divide-slate-800">
        {ordenarPendientes(pendientes, hoy).map((p) => {
          const est = estadoPendiente(p, hoy)
          const hecho = est === 'hecho'
          const asignado = nombreDe(usuarios.get(p.asignado_a))
          const propio = p.creado_por === perfil?.id
          return (
            <li key={p.id} className="flex items-start gap-3 py-2.5">
              <button
                type="button"
                onClick={() => tildar(p)}
                className={`mt-0.5 shrink-0 ${hecho ? 'text-emerald-400' : 'text-slate-500 hover:text-sky-400'}`}
                aria-label={hecho ? 'Marcar como no hecho' : 'Marcar como hecho'}
              >
                {hecho ? <CheckCircle2 size={20} /> : <Circle size={20} />}
              </button>

              <div className="min-w-0 flex-1">
                <p className={`text-sm ${hecho ? 'text-slate-500 line-through' : 'text-slate-100'}`}>
                  <b>{etiquetaPendiente(p.tipo, p.tipo_otro)}</b>
                  {!compacto && <> · {p.nombre}</>}
                  {p.privado && <Lock size={12} className="ml-1 inline text-slate-500" />}
                </p>
                {p.detalle && <p className="text-xs text-slate-400">{p.detalle}</p>}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                  <span className={`rounded-full border px-2 py-0.5 ${CHIP[est]}`}>
                    {hecho
                      ? `Hecho ${fecha(p.hecho_at)}${p.hecho_por ? ` · ${nombreDe(usuarios.get(p.hecho_por)) ?? ''}` : ''}`
                      : est === 'vencido'
                        ? `Venció el ${fecha(p.vence_el)}`
                        : est === 'hoy'
                          ? 'Para hoy'
                          : est === 'proximo'
                            ? `Para el ${fecha(p.vence_el)}`
                            : 'Sin fecha'}
                  </span>
                  {!hecho && <span>{asignado ? `Le toca a ${asignado}` : 'Cualquiera de la oficina'}</span>}
                  {p.telefono && !compacto && (
                    <a href={`tel:${String(p.telefono).split(/[,/ ]/)[0]}`} className="inline-flex items-center gap-0.5 text-sky-400">
                      <Phone size={11} /> {p.telefono}
                    </a>
                  )}
                  <span>N° {p.numero}</span>
                </p>
              </div>

              {!hecho && (
                <button
                  type="button"
                  onClick={() => setEditando(p)}
                  className="shrink-0 p-1 text-slate-500 hover:text-slate-200"
                  aria-label="Editar"
                >
                  <Pencil size={14} />
                </button>
              )}
              {propio && (
                <button
                  type="button"
                  onClick={() => borrar(p)}
                  className="shrink-0 p-1 text-slate-600 hover:text-rose-400"
                  aria-label="Borrar"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          )
        })}
      </ul>

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
