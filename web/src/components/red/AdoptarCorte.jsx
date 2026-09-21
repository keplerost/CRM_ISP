import { useState } from 'react'
import { AlertTriangle, Check, ShieldAlert } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, ErrorBanner, Modal } from '../ui'

/**
 * Elegir cómo se hace cargo el sistema del corte que ya existe en el router.
 *
 * ── Por qué esto no es un botón ──
 *
 * Porque hay dos salidas y no son equivalentes, y la diferencia no está en lo
 * que se toca sino en lo que le pasa al abonado. Adoptar la lista del router es
 * un campo en una ficha. Migrar todo a la nuestra es clonar y apagar reglas del
 * firewall de un equipo con gente conectada.
 *
 * Un botón que hiciera "lo correcto" tendría que elegir por el ISP entre esas
 * dos cosas, y esa elección depende de si piensa apagar el sistema anterior la
 * semana que viene o el año que viene.
 */
export default function AdoptarCorte({ routerId, onListo }) {
  const [plan, setPlan] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [aplicando, setAplicando] = useState(null)
  const [hecho, setHecho] = useState(null)
  const [error, setError] = useState(null)
  const [confirmando, setConfirmando] = useState(null)

  const mirar = async () => {
    setCargando(true)
    setError(null)
    setHecho(null)
    try {
      setPlan(await api.ipam.planCorte(routerId))
    } catch (e) {
      setError(e)
    } finally {
      setCargando(false)
    }
  }

  const aplicar = async (modo) => {
    setAplicando(modo)
    setError(null)
    try {
      const r = await api.ipam.adoptarCorte(routerId, { modo, confirmar: modo === 'migrar' })
      setHecho(r)
      setPlan(null)
      setConfirmando(null)
      onListo?.()
    } catch (e) {
      setError(e)
    } finally {
      setAplicando(null)
    }
  }

  return (
    <div className="space-y-3">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {hecho && (
        <Aviso>
          <Check size={14} className="mr-1 inline text-emerald-400" />
          {hecho.hecho}
        </Aviso>
      )}

      {!plan && !hecho && (
        <Button icon={ShieldAlert} cargando={cargando} onClick={mirar} className="py-1.5 text-xs">
          Ver cómo arreglar el corte
        </Button>
      )}

      {plan && (
        <div className="space-y-3 rounded-lg border border-slate-800 p-3">
          <p className="text-xs text-slate-400">
            El sistema corta con <b className="font-mono text-slate-200">{plan.configurada}</b> y el
            router corta con <b className="font-mono text-slate-200">{plan.principal}</b>, que tiene{' '}
            <b className="text-slate-200">{plan.direcciones.en_el_router}</b> direcciones adentro.
          </p>

          {plan.advertencias.map((a) => (
            <Aviso key={a} tipo="alerta">
              <AlertTriangle size={13} className="mr-1 inline" />
              {a}
            </Aviso>
          ))}

          <div className="grid gap-3 lg:grid-cols-2">
            {plan.opciones.map((o) => (
              <div
                key={o.modo}
                className={`rounded-lg border p-3 ${
                  o.riesgo === 'ninguno'
                    ? 'border-emerald-900/60 bg-[#ECFDF5]'
                    : 'border-amber-900/60 bg-[#FFFBEB]'
                }`}
              >
                <p className="text-sm font-medium text-slate-100">{o.titulo}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{o.que_hace}</p>

                <ul className="mt-2 space-y-1 text-[11px] leading-snug text-slate-400">
                  {o.resultado.map((x) => (
                    <li key={x}>· {x}</li>
                  ))}
                </ul>

                <p
                  className={`mt-2 text-[11px] leading-snug ${
                    o.riesgo === 'ninguno' ? 'text-emerald-500' : 'text-amber-500'
                  }`}
                >
                  {o.riesgo === 'ninguno' ? 'Sin riesgo: no se toca el router.' : o.riesgo}
                </p>

                <Button
                  variante={o.riesgo === 'ninguno' ? 'primario' : 'fantasma'}
                  cargando={aplicando === o.modo}
                  onClick={() => (o.modo === 'migrar' ? setConfirmando(o) : aplicar(o.modo))}
                  className="mt-3 w-full py-1.5 text-xs"
                >
                  {o.modo === 'adoptar' ? `Usar "${plan.principal}"` : `Migrar a "${plan.configurada}"`}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Migrar pide una confirmación aparte. No es formalidad: del otro lado
          hay 240 abonados y un firewall en producción. */}
      <Modal
        abierto={!!confirmando}
        titulo="Migrar el corte a la lista del sistema"
        onCerrar={() => setConfirmando(null)}
      >
        <div className="space-y-3 text-sm">
          <p className="text-slate-300">Esto va a hacer, en este orden:</p>
          <ol className="space-y-1.5 text-xs text-slate-400">
            <li>
              <Badge color="gris">1</Badge> Copiar {plan?.direcciones.a_copiar} direcciones de{' '}
              <b className="font-mono">{plan?.principal}</b> a{' '}
              <b className="font-mono">{plan?.configurada}</b>.
            </li>
            <li>
              <Badge color="gris">2</Badge> Clonar {plan?.reglas.length} reglas del firewall
              apuntando a la lista nueva, cada una en el mismo lugar de la cadena.
            </li>
            <li>
              <Badge color="gris">3</Badge> Apagar las {plan?.reglas.length} reglas viejas.
            </li>
          </ol>

          <Aviso tipo="alerta">
            <AlertTriangle size={13} className="mr-1 inline" />
            Se toca el firewall de un router con abonados conectados. Hacelo con el respaldo del
            router ya hecho y fuera de hora pico. Las reglas viejas quedan apagadas, no borradas:
            volver atrás es encenderlas y apagar las nuevas.
          </Aviso>

          <div className="flex justify-end gap-2">
            <Button variante="fantasma" onClick={() => setConfirmando(null)}>
              No, todavía no
            </Button>
            <Button
              variante="peligro"
              cargando={aplicando === 'migrar'}
              onClick={() => aplicar('migrar')}
            >
              Sí, migrar el corte
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
