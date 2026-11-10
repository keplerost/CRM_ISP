import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlarmClock, Save, Timer } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { duracion } from '../../lib/alertas'
import { Button, Card, ErrorBanner, Input } from '../ui'

/**
 * Los plazos de atención (migración 219), en dos piezas para el tablero de
 * Desempeño del equipo:
 *
 *   PendientesConPlazo  los trabajos que esperan al técnico, el más urgente
 *                       primero. Es lo que se mira a la mañana para repartir.
 *   PlazosPorTipo       en cuántas horas hay que llegar según el tipo. Lo edita
 *                       quien asigna; el resto lo ve.
 *
 * Sin la migración las vistas no existen: las dos piezas se ocultan en vez de
 * mostrar un error que nadie de la oficina puede resolver.
 */

const faltaPara = (vence, ahora) => Math.round((new Date(vence) - ahora) / 60000)

/** Cuánto falta, o cuánto se pasó, con el color que dice si hay que moverse. */
function Vencimiento({ vence, ahora }) {
  const min = faltaPara(vence, ahora)
  const clase =
    min <= 0
      ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
      : min <= 60
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
        : 'bg-slate-500/10 text-slate-300 border-slate-500/30'
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${clase}`}>
      {min <= 0 ? `vencido hace ${duracion(-min)}` : `vence en ${duracion(min)}`}
    </span>
  )
}

export function PendientesConPlazo() {
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)
  const [ahora, setAhora] = useState(() => new Date())

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_plazos_trabajo')
      // Todo: la cuadrilla llega con la 220 y así la lista no se cae si todavía
      // no se corrió.
      .select('*')
      .eq('pendiente', true)
      .order('vence_at', { ascending: true })
      .limit(50)
    if (err) {
      // Sin la migración 219 no hay nada que mostrar todavía.
      if (/does not exist|schema cache/i.test(err.message)) return setFilas(false)
      setError(err)
    }
    setFilas(data ?? [])
    setAhora(new Date())
  }, [])

  useEffect(() => {
    recargar()
    // Cada minuto: "vence en 5 min" que no se mueve es peor que no decir nada.
    const t = setInterval(recargar, 60_000)
    return () => clearInterval(t)
  }, [recargar])

  // null: cargando. false: falta la migración 219.
  if (!filas) return null

  const vencidos = filas.filter((f) => faltaPara(f.vence_at, ahora) <= 0).length

  return (
    <Card
      title="Esperando al técnico"
      subtitle={
        filas.length === 0
          ? 'No hay trabajos esperando'
          : `${filas.length} trabajos${vencidos ? ` · ${vencidos} fuera de plazo` : ''}, el más urgente primero`
      }
      icon={AlarmClock}
    >
      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      {filas.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 pr-4 font-medium">Plazo</th>
                <th className="pb-2 pr-4 font-medium">Trabajo</th>
                <th className="pb-2 pr-4 font-medium">Abonado</th>
                <th className="pb-2 pr-4 font-medium">Técnico</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={`${f.clase}-${f.id}`} className="border-t border-slate-800">
                  <td className="py-2 pr-4">
                    <Vencimiento vence={f.vence_at} ahora={ahora} />
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4">
                    <Link
                      to={f.clase === 'ticket' ? `/soporte/${f.id}` : `/clientes/instalaciones/${f.id}`}
                      className="text-slate-100 hover:text-sky-400 hover:underline"
                    >
                      {f.clase === 'ticket' ? 'Ticket' : 'Instalación'}
                      {f.numero ? ` N° ${f.numero}` : ''}
                    </Link>
                    <p className="text-[11px] text-slate-500">{f.tipo_nombre}</p>
                  </td>
                  <td className="py-2 pr-4 text-slate-300">
                    {f.cliente ?? '—'}
                    {f.zona && <p className="text-[11px] text-slate-500">{f.zona}</p>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4">
                    {f.tecnico || f.cuadrilla ? (
                      <span className="text-slate-300">
                        {f.tecnico ?? `Cuadrilla ${f.cuadrilla}`}
                        {f.cuadrilla_integrantes && !f.tecnico && (
                          <span className="block text-[11px] text-slate-500">
                            {f.cuadrilla_integrantes}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="font-medium text-rose-300">Sin asignar</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function PlazosPorTipo() {
  const { puede } = usePermisos()
  const editable = puede('soporte.asignar') || puede('ajustes.editar')

  const [plazos, setPlazos] = useState(null)
  const [borrador, setBorrador] = useState({})
  const [guardando, setGuardando] = useState(null)
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('plazos_atencion')
      .select('clave, nombre, horas')
      .order('orden')
    if (err) {
      if (/does not exist|schema cache/i.test(err.message)) return setPlazos([])
      setError(err)
    }
    setPlazos(data ?? [])
    setBorrador({})
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const cambiados = useMemo(
    () =>
      Object.entries(borrador).filter(([clave, v]) => {
        const actual = plazos?.find((p) => p.clave === clave)
        return actual && v !== '' && Number(v) !== Number(actual.horas)
      }),
    [borrador, plazos],
  )

  async function guardar() {
    setError(null)
    for (const [clave, v] of cambiados) {
      const horas = Number(v)
      if (!(horas > 0 && horas <= 720)) {
        setError(new Error('Cada plazo tiene que estar entre 0,5 y 720 horas (30 días).'))
        return
      }
    }
    setGuardando(true)
    for (const [clave, v] of cambiados) {
      const { error: err } = await supabase
        .from('plazos_atencion')
        .update({ horas: Number(v), actualizado_en: new Date().toISOString() })
        .eq('clave', clave)
      if (err) {
        setError(err)
        break
      }
    }
    setGuardando(false)
    recargar()
  }

  if (!plazos || plazos.length === 0) return null

  return (
    <Card
      title="Plazos por tipo de trabajo"
      subtitle="En cuántas horas desde que se registra tiene que llegar el técnico"
      icon={Timer}
      actions={
        editable && (
          <Button
            variante="primario"
            icon={Save}
            disabled={cambiados.length === 0 || guardando}
            onClick={guardar}
          >
            {guardando ? 'Guardando…' : 'Guardar'}
          </Button>
        )
      }
    >
      <ErrorBanner error={error} onCerrar={() => setError(null)} />
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {plazos.map((p) => (
          <label key={p.clave} className="flex items-center justify-between gap-3 border-b border-slate-800 py-1.5">
            <span className="text-sm text-slate-300">{p.nombre}</span>
            {editable ? (
              <span className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={0.5}
                  max={720}
                  step={0.5}
                  value={borrador[p.clave] ?? p.horas}
                  onChange={(e) => setBorrador((b) => ({ ...b, [p.clave]: e.target.value }))}
                  className="w-20 text-right"
                />
                <span className="text-xs text-slate-500">h</span>
              </span>
            ) : (
              <span className="tabular-nums text-sm text-slate-100">{Number(p.horas)} h</span>
            )}
          </label>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-slate-500">
        El aviso por Telegram o WhatsApp sale antes de que venza: cuántos minutos antes, y en qué
        horario, se ajusta en Ajustes → Alertas, regla “Plazo de atención”.
      </p>
    </Card>
  )
}
