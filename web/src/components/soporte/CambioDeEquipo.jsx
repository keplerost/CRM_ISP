import { useCallback, useEffect, useMemo, useState } from 'react'
import { Replace, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { Button, Field, Select, Textarea, Aviso, Modal } from '../ui'
import { usePermisos } from '../../lib/AuthContext'
import { inventarioApi } from '../../lib/inventario'
import { reemplazosApi, MOTIVOS, DESTINOS } from '../../lib/reemplazos'

/**
 * Cambiar la ONT de un abonado, desde el ticket.
 *
 * ── Por qué la serie se elige de una lista y no se escribe ──
 *
 * Porque escrita se equivoca. Un dígito de más en "HWTC304D1BB2" y el sistema
 * descuenta del stock un equipo que está en la camioneta de otro técnico, o uno
 * que no existe. La lista sale del almacén de quien está mirando la pantalla:
 * si el equipo no está ahí, no se puede elegir. La función de la base valida lo
 * mismo del lado del servidor — esto es para que no haya que llegar hasta ahí.
 *
 * ── Por qué el paso de la OLT se muestra aparte ──
 *
 * Son dos resultados distintos y el técnico necesita saber cuál falló. Si el
 * inventario se registró y la OLT no contestó, el equipo ya está instalado en
 * la casa y lo que falta es reintentar el aprovisionamiento — no volver a
 * cargar el cambio, que descontaría una segunda ONT.
 *
 * ── Por qué no funciona sin internet ──
 *
 * El resto del módulo de campo sí: se guarda en el teléfono y sube después. Acá
 * no tendría sentido. El paso de la OLT necesita hablar con el equipo AHORA —el
 * abonado está sin servicio hasta que se autorice la ONT nueva— y encolarlo
 * dejaría al técnico irse creyendo que quedó andando.
 */
export default function CambioDeEquipo({ ticket, instalacionId, onCambio, onError }) {
  const { perfil } = usePermisos()

  const [abierto, setAbierto] = useState(false)
  const [almacen, setAlmacen] = useState(null)
  const [equipos, setEquipos] = useState([])
  const [cargando, setCargando] = useState(false)

  const [serie, setSerie] = useState('')
  const [motivo, setMotivo] = useState('quemado')
  const [destino, setDestino] = useState('averiado')
  const [detalle, setDetalle] = useState('')

  const [paso, setPaso] = useState(null) // 'inventario' | 'olt'
  const [resultado, setResultado] = useState(null)
  const [reemplazoId, setReemplazoId] = useState(null)
  const [fallaOlt, setFallaOlt] = useState(null)

  const enLinea = typeof navigator === 'undefined' || navigator.onLine

  const cargar = useCallback(async () => {
    if (!perfil?.tecnico_id) return
    setCargando(true)
    try {
      const mio = await inventarioApi.miAlmacen(perfil.tecnico_id)
      setAlmacen(mio)
      if (mio) {
        const eq = await inventarioApi.equipos({ almacenId: mio.id })
        // Solo ONTs, y solo las que de verdad se pueden instalar. Una averiada
        // en el listado es un cambio de equipo que termina en otro reclamo.
        setEquipos(eq.filter((q) => q.categoria === 'ont' && q.estado === 'en_stock'))
      }
    } catch (err) {
      onError?.(err)
    } finally {
      setCargando(false)
    }
  }, [perfil, onError])

  useEffect(() => {
    if (abierto) cargar()
  }, [abierto, cargar])

  const elegido = useMemo(
    () => equipos.find((q) => String(q.serie) === serie) ?? null,
    [equipos, serie],
  )

  const clienteId = ticket?.client_id ?? null

  /** Paso 2, aislado: se reintenta solo, sin volver a mover inventario. */
  const aprovisionar = async (id) => {
    setPaso('olt')
    setFallaOlt(null)
    try {
      const r = await reemplazosApi.aprovisionar(id)
      setResultado(r)
      onCambio?.()
      return true
    } catch (err) {
      setFallaOlt(err)
      return false
    } finally {
      setPaso(null)
    }
  }

  const confirmar = async () => {
    if (!clienteId) {
      onError?.(new Error('Este ticket no tiene abonado asociado, así que no se sabe a quién se le cambia el equipo.'))
      return
    }
    setPaso('inventario')
    try {
      const id = await reemplazosApi.registrar({
        clienteId,
        serieNueva: serie,
        motivo,
        destino,
        detalle,
        ticketId: ticket.id,
        instalacionId: instalacionId ?? null,
      })
      setReemplazoId(id)
      setPaso(null)
      await aprovisionar(id)
    } catch (err) {
      setPaso(null)
      onError?.(err)
    }
  }

  const cerrar = () => {
    setAbierto(false)
    setResultado(null)
    setFallaOlt(null)
    setReemplazoId(null)
    setSerie('')
    setDetalle('')
  }

  // Sin almacén propio esto no aplica: quien mira el ticket desde la oficina no
  // tiene equipos en la mano. Se dibuja igual el botón para el técnico que
  // todavía no está vinculado, porque el mensaje de por qué no puede es útil.
  if (!perfil?.tecnico_id) return null

  return (
    <>
      <Button variante="secundario" icon={Replace} onClick={() => setAbierto(true)}>
        Cambiar la ONT
      </Button>

      <Modal abierto={abierto} titulo="Cambiar el equipo del abonado" onCerrar={cerrar}>
        {/* Ya terminado ------------------------------------------------- */}
        {resultado ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-400" />
              <div className="text-sm">
                <p className="font-medium text-emerald-200">
                  {resultado.ya_estaba ? 'Ese cambio ya estaba aprovisionado.' : 'Equipo cambiado y ONT autorizada.'}
                </p>
                <p className="mt-1 text-slate-300">
                  Quedó en el puerto {resultado.puerto} de la placa {resultado.slot ?? 0}, con el
                  mismo perfil y la misma VLAN que tenía la anterior.
                </p>
                {resultado.ip_gestion && (
                  <p className="mt-1 text-slate-400">Gestión: {resultado.ip_gestion}</p>
                )}
              </div>
            </div>

            {resultado.aviso && <Aviso tipo="alerta">{resultado.aviso}</Aviso>}

            {/* La ficha manual: cuando el ACS no pudo configurar la ONT sola, es
                lo que el técnico tiene que escribirle al equipo ahí mismo. */}
            {resultado.ficha_manual && (
              <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-sm">
                <p className="font-medium text-slate-200">Configurar a mano</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                  <dt className="text-slate-500">VLAN</dt>
                  <dd className="text-slate-200">{resultado.ficha_manual.vlan}</dd>
                  <dt className="text-slate-500">Usuario PPPoE</dt>
                  <dd className="font-mono text-slate-200">{resultado.ficha_manual.pppoe?.usuario ?? '—'}</dd>
                  <dt className="text-slate-500">Clave PPPoE</dt>
                  <dd className="font-mono text-slate-200">{resultado.ficha_manual.pppoe?.clave ?? '—'}</dd>
                  <dt className="text-slate-500">SSID</dt>
                  <dd className="font-mono text-slate-200">{resultado.ficha_manual.wifi?.ssid ?? '—'}</dd>
                  <dt className="text-slate-500">Clave WiFi</dt>
                  <dd className="font-mono text-slate-200">{resultado.ficha_manual.wifi?.clave ?? '—'}</dd>
                </dl>
              </div>
            )}

            <Button variante="primario" onClick={cerrar} className="w-full">
              Listo
            </Button>
          </div>
        ) : fallaOlt ? (
          /* Inventario sí, OLT no ---------------------------------------- */
          <div className="space-y-3">
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
              <div className="text-sm">
                <p className="font-medium text-amber-200">
                  {fallaOlt.sin_respuesta || fallaOlt.status === 503
                    ? 'El cambio quedó registrado, pero la OLT no contestó.'
                    : 'El cambio quedó registrado, pero la OLT todavía no está.'}
                </p>
                <p className="mt-1 text-slate-300">{fallaOlt.message}</p>
                {fallaOlt.hint && <p className="mt-1 text-slate-400">{fallaOlt.hint}</p>}
                <p className="mt-2 text-slate-400">
                  El equipo ya figura instalado y descontado de tu almacén:{' '}
                  <b>no vuelvas a cargar el cambio</b>, se descontaría una segunda ONT. Reintentá
                  acá.
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                variante="primario"
                icon={RefreshCw}
                cargando={paso === 'olt'}
                onClick={() => aprovisionar(reemplazoId)}
                className="flex-1"
              >
                Reintentar
              </Button>
              <Button onClick={cerrar} disabled={paso === 'olt'}>
                Después
              </Button>
            </div>
            <p className="text-[12px] text-slate-500">
              Si te vas sin resolverlo, el abonado queda sin servicio y el cambio aparece en la cola
              de la oficina para que lo cierren desde la pantalla de la OLT.
            </p>
          </div>
        ) : (
          /* El formulario ------------------------------------------------ */
          <div className="space-y-3">
            {!enLinea && (
              <Aviso tipo="alerta">
                Esto necesita internet: hay que autorizar la ONT nueva en la OLT y no se puede
                dejar para después — el abonado queda sin servicio hasta que se haga.
              </Aviso>
            )}

            {!clienteId && (
              <Aviso tipo="alerta">
                Este ticket no está asociado a ningún abonado, así que no se sabe a quién se le
                cambia el equipo.
              </Aviso>
            )}

            {cargando ? (
              <p className="text-sm text-slate-500">Buscando ONTs en tu almacén…</p>
            ) : !almacen ? (
              <Aviso tipo="alerta">
                No tenés un almacén asignado. Pedí que te vinculen uno para poder descontar
                equipos.
              </Aviso>
            ) : !equipos.length ? (
              <Aviso tipo="alerta">
                No hay ONTs en stock en tu almacén ({almacen.nombre}). Pedí la transferencia antes
                de instalar.
              </Aviso>
            ) : (
              <Field
                label="ONT nueva"
                hint={`De tu almacén: ${almacen.nombre}. Si el equipo que tenés en la mano no está acá, todavía no te lo transfirieron.`}
              >
                <Select value={serie} onChange={(e) => setSerie(e.target.value)}>
                  <option value="">Elegí la serie…</option>
                  {equipos.map((q) => (
                    <option key={q.id} value={q.serie}>
                      {q.serie} — {q.articulo}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="Qué le pasó a la anterior">
              <Select value={motivo} onChange={(e) => setMotivo(e.target.value)}>
                {Object.entries(MOTIVOS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Qué hacés con la anterior" hint={DESTINOS[destino]?.ayuda}>
              <Select value={destino} onChange={(e) => setDestino(e.target.value)}>
                {Object.entries(DESTINOS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Detalle" hint="Opcional. Lo que un compañero necesitaría saber si vuelve a este domicilio.">
              <Textarea
                rows={2}
                value={detalle}
                onChange={(e) => setDetalle(e.target.value)}
                placeholder="Ej: la casa ya tuvo dos equipos quemados, no hay descargador"
              />
            </Field>

            <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-2.5 text-[12px] text-slate-400">
              La ONT nueva se autoriza en el mismo puerto y con el mismo perfil que tenía la
              anterior. No hay nada de red que elegir acá.
            </div>

            <div className="flex gap-2">
              <Button
                variante="primario"
                icon={Replace}
                cargando={!!paso}
                onClick={confirmar}
                disabled={!serie || !clienteId || !enLinea}
                className="flex-1"
              >
                {paso === 'inventario'
                  ? 'Registrando el cambio…'
                  : paso === 'olt'
                    ? 'Autorizando en la OLT…'
                    : 'Cambiar el equipo'}
              </Button>
              <Button onClick={cerrar} disabled={!!paso}>
                Cancelar
              </Button>
            </div>

            {elegido && (
              <p className="text-center text-[12px] text-slate-500">
                Se va a descontar {elegido.articulo} · {elegido.serie}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
