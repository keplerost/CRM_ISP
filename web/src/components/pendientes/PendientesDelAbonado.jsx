import { useState } from 'react'
import { ClipboardList, Plus } from 'lucide-react'
import { esDelMismoAbonado } from '../../lib/pendientes'
import { Modal } from '../ui'
import ListaPendientes from './ListaPendientes'
import PendienteForm from './PendienteForm'
import { usePendientes } from './usePendientes'

/**
 * Los pendientes de UN abonado: en su ficha y en sus tickets.
 *
 * En el ticket es lo que permite aprovechar la visita: el técnico que va por
 * la lentitud ve que falta la firma del contrato, la consigue y la tilda ahí
 * mismo. Sin esto, alguien tenía que volver otro día solo por la firma.
 *
 * Casi todos los abonados no tienen ficha acá (siguen en MikroWISP): se
 * reconocen por la ficha, la cédula o el nombre completo.
 *
 * @param abonado  { client_id, identificacion, nombre }
 * @param cliente  la ficha, si la hay: habilita "Agregar" con los datos puestos
 */
export default function PendientesDelAbonado({ abonado, cliente = null, conAgregar = false, onError }) {
  const clave = `${abonado?.client_id ?? ''}|${abonado?.identificacion ?? ''}|${abonado?.nombre ?? ''}`
  const { pendientes, usuarios, recargar } = usePendientes({
    filtro: (q) => q.is('hecho_at', null),
    clave,
  })
  const [creando, setCreando] = useState(false)

  if (pendientes === false || pendientes === null) return null
  const suyos = pendientes.filter((p) => esDelMismoAbonado(p, abonado ?? {}))
  if (!suyos.length && !conAgregar) return null

  return (
    <section className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-300">
          <ClipboardList size={14} />
          {suyos.length
            ? `Este abonado tiene ${suyos.length === 1 ? 'un pendiente' : `${suyos.length} pendientes`}`
            : 'Pendientes administrativos'}
        </p>
        {conAgregar && (
          <button
            type="button"
            onClick={() => setCreando(true)}
            className="inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300"
          >
            <Plus size={13} /> Agregar
          </button>
        )}
      </div>
      {suyos.length > 0 ? (
        <>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Si podés resolverlo en esta visita, abrilo y marcalo como realizado: queda registrado quién y cuándo.
          </p>
          <ListaPendientes pendientes={suyos} usuarios={usuarios} onCambio={recargar} onError={onError} compacto />
        </>
      ) : (
        <p className="mt-1 text-[11px] text-slate-500">
          Cambio de plan, firma, copia de cédula: lo que hay que hacer con este abonado que no es un
          reclamo.
        </p>
      )}

      <Modal abierto={creando} titulo="Nuevo pendiente" onCerrar={() => setCreando(false)} ancho="max-w-2xl">
        {creando && (
          <PendienteForm
            cliente={cliente}
            onError={onError}
            onCancelar={() => setCreando(false)}
            onGuardado={() => {
              setCreando(false)
              recargar()
            }}
          />
        )}
      </Modal>
    </section>
  )
}
