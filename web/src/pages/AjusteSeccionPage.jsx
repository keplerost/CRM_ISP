import { ArrowLeft, HardHat } from 'lucide-react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Aviso, Card } from '../components/ui'
import { buscarAjuste } from '../lib/ajustes'

/**
 * La ficha de una sección de Ajustes que todavía no se construyó.
 *
 * Dice tres cosas, en este orden:
 *
 *   QUÉ VA A HACER — para que quien la abre sepa si lo que busca va a estar acá
 *   o tiene que buscarlo en otro lado.
 *
 *   DÓNDE ESTÁ HOY — varias de estas ya funcionan, solo que se configuran desde
 *   otra pantalla o desde el middleware. Sin decirlo, alguien se queda esperando
 *   algo que ya podía hacer.
 *
 *   QUE NO ESTÁ LISTA — claro y arriba, no en letra chica. Que la pantalla abra
 *   no debe hacer creer que la función existe.
 */
export default function AjusteSeccionPage() {
  const { slug } = useParams()
  const seccion = buscarAjuste(slug)

  // Un slug inventado no es una pantalla vacía: es que alguien tocó la URL o
  // quedó un enlace viejo. Vuelve al tablero, que sí existe.
  if (!seccion) return <Navigate to="/ajustes" replace />

  // Las que ya tienen módulo no deben quedar atrapadas acá si alguien llega por
  // la URL vieja: se las manda a donde de verdad viven.
  if (seccion.a) return <Navigate to={seccion.a} replace />

  const Icono = seccion.icono

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-full border border-slate-700 text-slate-400">
          <Icono size={20} />
        </span>
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">{seccion.nombre}</h1>
          <p className="flex items-center gap-1.5 text-xs text-amber-400">
            <HardHat size={13} /> Todavía no está construida
          </p>
        </div>
      </div>

      <Card>
        <div className="space-y-4 p-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Para qué va a servir</p>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-300">{seccion.para}</p>
          </div>

          {/* Solo aparece cuando de verdad hay otro lugar. Un "no disponible"
              genérico no le sirve a nadie. */}
          {seccion.mientras && <Aviso>{seccion.mientras}</Aviso>}
        </div>
      </Card>
    </div>
  )
}
