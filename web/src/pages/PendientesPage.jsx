import { useMemo, useState } from 'react'
import { ClipboardList, Plus, Search, X } from 'lucide-react'
import { usePermisos } from '../lib/AuthContext'
import { hoyLocal } from '../lib/soporte'
import { estadoPendiente, etiquetaPendiente } from '../lib/pendientes'
import { Button, Card, ErrorBanner, Input, Modal } from '../components/ui'
import ListaPendientes from '../components/pendientes/ListaPendientes'
import PendienteForm from '../components/pendientes/PendienteForm'
import { usePendientes } from '../components/pendientes/usePendientes'

/**
 * Pendientes: lo administrativo, fuera de Soporte (migración 225).
 *
 * Cambiar el plan, hacer firmar el contrato, pedir la copia de la cédula. Antes
 * se cargaban como tickets y entraban en la ruta del técnico, en el plazo de
 * atención y en el desempeño. Acá no hay ruta ni plazo: hay una casilla.
 */

const sinTildes = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

export default function PendientesPage() {
  const { perfil } = usePermisos()
  const { pendientes, usuarios, error, setError, recargar } = usePendientes()
  const [vista, setVista] = useState('mios')
  const [busqueda, setBusqueda] = useState('')
  const [creando, setCreando] = useState(false)
  const hoy = hoyLocal()

  const lista = pendientes || []
  const mios = (p) => p.asignado_a === perfil?.id || (!p.asignado_a && p.creado_por === perfil?.id)
  const abiertos = lista.filter((p) => !p.hecho_at)

  const cuentas = {
    mios: abiertos.filter(mios).length,
    todos: abiertos.length,
    sin_asignar: abiertos.filter((p) => !p.asignado_a).length,
    hechos: lista.filter((p) => p.hecho_at).length,
  }
  const vencidos = abiertos.filter(mios).filter((p) => estadoPendiente(p, hoy) === 'vencido').length

  const visibles = useMemo(() => {
    const q = sinTildes(busqueda).trim()
    return lista.filter((p) => {
      if (q) {
        const donde = sinTildes([p.nombre, p.identificacion, p.telefono, p.detalle, etiquetaPendiente(p.tipo), p.numero].join(' '))
        return q.split(/\s+/).every((w) => donde.includes(w))
      }
      if (vista === 'hechos') return Boolean(p.hecho_at)
      if (p.hecho_at) return false
      if (vista === 'mios') return mios(p)
      if (vista === 'sin_asignar') return !p.asignado_a
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lista, vista, busqueda, perfil?.id])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-100">
            <ClipboardList className="text-sky-400" /> Pendientes
          </h1>
          <p className="text-sm text-slate-500">
            Lo administrativo con cada abonado: cambio de plan, firma, copia de cédula. No son tickets:
            no van a la ruta del técnico ni cuentan en el desempeño.
          </p>
        </div>
        <Button variante="primario" icon={Plus} onClick={() => setCreando(true)}>
          Nuevo pendiente
        </Button>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {pendientes === false ? (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500">
            Falta correr la migración 225 en la base para usar los pendientes.
          </p>
        </Card>
      ) : (
        <>
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por abonado, cédula, teléfono o lo que hay que hacer"
              className="pl-9 pr-9"
            />
            {busqueda && (
              <button
                type="button"
                onClick={() => setBusqueda('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-500"
                aria-label="Borrar búsqueda"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {[
              ['mios', 'Míos'],
              ['sin_asignar', 'De la oficina'],
              ['todos', 'Todos abiertos'],
              ['hechos', 'Hechos'],
            ].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setVista(v)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition ${
                  vista === v && !busqueda
                    ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {label} <span className="tabular-nums opacity-70">{cuentas[v]}</span>
              </button>
            ))}
          </div>

          {vencidos > 0 && !busqueda && vista === 'mios' && (
            <p className="text-xs text-rose-300">
              {vencidos === 1 ? 'Tenés un pendiente vencido.' : `Tenés ${vencidos} pendientes vencidos.`}
            </p>
          )}

          <Card>
            {pendientes === null ? (
              <p className="p-4 text-sm text-slate-500">Cargando…</p>
            ) : visibles.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                {busqueda
                  ? 'Ningún pendiente coincide, ni abierto ni hecho.'
                  : vista === 'mios'
                    ? 'No tenés pendientes. 🎉'
                    : 'No hay nada acá.'}
              </p>
            ) : (
              <div className="px-4">
                <ListaPendientes pendientes={visibles} usuarios={usuarios} onCambio={recargar} onError={setError} />
              </div>
            )}
          </Card>
        </>
      )}

      <Modal abierto={creando} titulo="Nuevo pendiente" onCerrar={() => setCreando(false)} ancho="max-w-2xl">
        {creando && (
          <PendienteForm
            onError={setError}
            onCancelar={() => setCreando(false)}
            onGuardado={() => {
              setCreando(false)
              recargar()
            }}
          />
        )}
      </Modal>
    </div>
  )
}
