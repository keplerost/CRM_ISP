import { useState } from 'react'
import { Check, Globe, Power, ShieldAlert } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { useConfirmar } from '../../lib/confirmar'
import { Aviso, Badge, Button, Card, ErrorBanner } from '../ui'

/**
 * Dejar este router listo para cortar y limitar en IPv6.
 *
 * ── Qué problema resuelve ──
 *
 * El sistema corta metiendo la IP del moroso en un `address-list` de
 * `/ip/firewall`. Eso es IPv4 y nada más. Un abonado con IPv6 andando queda
 * cortado en v4 y **sigue navegando por v6** —Google, YouTube, Facebook y
 * Netflix responden por IPv6— así que para él no cambia casi nada, mientras el
 * sistema anota el corte como hecho.
 *
 * ── Por qué es opcional ──
 *
 * La mayoría de los ISP todavía no entrega IPv6. Con el interruptor apagado el
 * sistema no lee ni escribe nada en `/ipv6/`, exactamente como venía
 * funcionando. Se enciende por router y solo cuando ese equipo ya entrega IPv6
 * de verdad.
 *
 * ── Sirve igual para fibra y para radioenlace ──
 *
 * Son reglas de capa 3 en el MikroTik: no miran la OLT, ni la ONU, ni el tipo
 * de conexión del abonado.
 */
export default function PrepararIpv6({ router, onCambio }) {
  const confirmar = useConfirmar()
  const [plan, setPlan] = useState(null)
  const [hecho, setHecho] = useState(null)
  const [error, setError] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [verScript, setVerScript] = useState(false)

  const revisar = async () => {
    setTrabajando(true)
    setError(null)
    setHecho(null)
    try {
      setPlan(await api.mikrotik.revisarIpv6(router.id))
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  const aplicar = async () => {
    setTrabajando(true)
    setError(null)
    try {
      setHecho(await api.mikrotik.prepararIpv6(router.id, { encender: true }))
      await onCambio?.()
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  const apagar = async () => {
    if (
      !(await confirmar({
        titulo: 'Dejar de usar IPv6 en este router',
        mensaje:
          'El sistema va a volver a cortar y limitar solo en IPv4. Las reglas quedan en el equipo, ' +
          'inactivas, así que volver a encenderlo no requiere tocar nada.\n\n' +
          'Ojo: si este router ya entrega IPv6 a los abonados, los morosos van a poder navegar por v6.',
        etiquetaAccion: 'Dejar de usar IPv6',
      }))
    ) {
      return
    }
    setTrabajando(true)
    try {
      setHecho(await api.mikrotik.apagarIpv6(router.id))
      setPlan(null)
      await onCambio?.()
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(false)
    }
  }

  return (
    <Card
      title="Corte y límite en IPv6"
      icon={Globe}
      subtitle="Opcional. Solo hace falta si este router ya le entrega IPv6 a los abonados."
      actions={
        router.ipv6_activo ? (
          <Badge color="verde">Encendido</Badge>
        ) : (
          <Badge color="gris">Apagado</Badge>
        )
      }
    >
      <div className="space-y-3">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {!router.ipv6_activo && !plan && !hecho && (
          <Aviso>
            Con esto apagado, el sistema corta y limita <b>solo en IPv4</b>. Si este equipo ya
            entrega IPv6, el moroso queda bloqueado en v4 y sigue navegando por v6 — que es por
            donde responden YouTube, Netflix y casi todo lo grande.
          </Aviso>
        )}

        {hecho && (
          <Aviso tipo={hecho.ipv6_activo === false ? 'alerta' : 'exito'}>
            {hecho.mensaje ?? hecho.aviso}
            {hecho.aviso && hecho.mensaje && <div className="mt-1 text-xs">{hecho.aviso}</div>}
          </Aviso>
        )}

        {plan && !plan.soportaIpv6 && (
          <Aviso tipo="alerta">
            <ShieldAlert size={14} className="mr-1 inline" />
            <b>{router.nombre}</b> no responde en IPv6. {plan.sugerencia}
            <div className="mt-1 font-mono text-[11px] opacity-70">{plan.motivo}</div>
          </Aviso>
        )}

        {plan?.soportaIpv6 && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs">
            <div className="mb-2 text-slate-400">
              Lista de corte: <b className="font-mono text-slate-200">{plan.lista}</b>
              {plan.cortadosAhora > 0 && ` · ${plan.cortadosAhora} bloqueado(s) ahora`}
            </div>
            {plan.reglas.map((r) => (
              <div key={r.comentario} className="flex gap-2 py-1">
                <span className={r.existe ? 'text-emerald-400' : 'text-amber-400'}>
                  {r.existe ? '✓' : '·'}
                </span>
                <span className="text-slate-300">
                  <span className="font-mono">{r.campo}</span> — {r.porque}
                </span>
              </div>
            ))}
            {plan.listo && (
              <p className="mt-2 text-emerald-400">Ya está todo puesto en el equipo.</p>
            )}
          </div>
        )}

        {plan && (
          <div>
            <button
              type="button"
              onClick={() => setVerScript((v) => !v)}
              className="text-xs text-sky-400 hover:underline"
            >
              {verScript ? 'Ocultar' : 'Ver'} el script que se va a aplicar
            </button>
            {verScript && (
              /* Se muestra para poder leerlo antes, y para poder pegarlo a mano
                 el día que haya que hacerlo sin el sistema. */
              <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed text-slate-300">
                {plan.script}
              </pre>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={revisar} cargando={trabajando} icon={Globe}>
            Revisar el equipo
          </Button>

          {plan?.soportaIpv6 && !plan.listo && (
            <Button variante="primario" icon={Check} cargando={trabajando} onClick={aplicar}>
              Dejar las reglas puestas y encender
            </Button>
          )}

          {plan?.soportaIpv6 && plan.listo && !router.ipv6_activo && (
            <Button variante="primario" icon={Power} cargando={trabajando} onClick={aplicar}>
              Encender IPv6 para este router
            </Button>
          )}

          {router.ipv6_activo && (
            <Button variante="fantasma" icon={Power} cargando={trabajando} onClick={apagar}>
              Dejar de usar IPv6
            </Button>
          )}
        </div>

        <p className="text-[11px] text-slate-500">
          Encendido, cada corte por mora bloquea también el prefijo IPv6 del abonado, y la cola de
          velocidad limita las dos versiones juntas. Para eso, cada cliente necesita su prefijo
          cargado en <b>Ficha → Servicio → Direccionamiento</b>.
        </p>
      </div>
    </Card>
  )
}
