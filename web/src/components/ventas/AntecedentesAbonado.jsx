import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { dineroCero as dinero } from '../../lib/formato'

/**
 * Lo que hay que saber antes de darle servicio a alguien que ya fue abonado.
 *
 * ── Por qué existe ──
 *
 * Alguien se va sin devolver la ONT, se le da de baja, y seis meses después
 * vuelve a pedir servicio. Sin esto nadie se entera: la ficha vieja quedó
 * cerrada, el vendedor carga un prospecto nuevo con la misma cédula, y se le
 * instala otro equipo a quien todavía tiene el anterior.
 *
 * ── Por qué avisa y no bloquea ──
 *
 * Porque un bloqueo duro lo saltea alguien cargando la ficha con otro nombre, y
 * ahí se pierde el rastro por completo. El vendedor decide igual que antes; lo
 * único que cambia es que decide sabiendo.
 *
 * ── Por qué no dice "moroso" ni nada parecido ──
 *
 * Porque muchas veces no lo es. Puede haber devuelto el equipo en la oficina y
 * nadie lo anotó, puede haberse mudado por trabajo, puede ser un homónimo. El
 * texto dice lo que pasó y deja la conclusión a quien está hablando con la
 * persona.
 */
export default function AntecedentesAbonado({ identificacion }) {
  const [antecedentes, setAntecedentes] = useState([])

  useEffect(() => {
    const ident = String(identificacion ?? '').trim()

    // Menos de seis dígitos es alguien todavía escribiendo, no una cédula.
    // Consultar en cada tecla sería una consulta por letra.
    if (ident.length < 6) {
      setAntecedentes([])
      return
    }

    let vigente = true
    const t = setTimeout(() => {
      supabase
        .from('v_antecedentes_abonado')
        .select('*')
        .eq('identificacion', ident)
        .then(({ data }) => vigente && setAntecedentes(data ?? []))
    }, 400)

    return () => {
      vigente = false
      clearTimeout(t)
    }
  }, [identificacion])

  if (antecedentes.length === 0) return null

  const conDeuda = antecedentes.filter((a) => Number(a.deuda_equipo) > 0)
  const total = conDeuda.reduce((s, a) => s + Number(a.deuda_equipo), 0)

  return (
    <div
      className={`rounded-lg border p-3 sm:col-span-2 ${
        conDeuda.length
          ? 'border-amber-500/40 bg-amber-500/10'
          : 'border-slate-700 bg-slate-900/40'
      }`}
    >
      <div className="flex items-start gap-2">
        <TriangleAlert
          size={15}
          className={`mt-0.5 shrink-0 ${conDeuda.length ? 'text-amber-400' : 'text-slate-500'}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-200">
            Esta identificación ya tuvo servicio
          </p>

          <div className="mt-1 space-y-1">
            {antecedentes.map((a) => (
              <div key={a.cliente_id} className="text-[11px] leading-snug text-slate-400">
                <span className="text-slate-300">{a.nombre}</span>
                {a.codigo != null && (
                  <span className="text-slate-600"> · {String(a.codigo).padStart(6, '0')}</span>
                )}
                {' — '}
                {a.estado === 'baja'
                  ? `retirado${a.baja_en ? ` el ${String(a.baja_en).slice(0, 10)}` : ''}`
                  : `hoy figura como ${a.estado}`}
                {a.motivo_baja ? ` (${a.motivo_baja})` : ''}
                {Number(a.deuda_equipo) > 0 && (
                  <span className="font-medium text-amber-400">
                    {' '}
                    · quedó con un equipo sin devolver por {dinero(a.deuda_equipo)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {conDeuda.length > 0 && (
            <p className="mt-1.5 text-[11px] text-amber-300">
              Antes de instalarle otro equipo, conviene preguntar por el anterior
              {total > 0 ? ` (${dinero(total)})` : ''}. Si lo devuelve o lo paga, se salda desde su
              ficha y este aviso desaparece.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
