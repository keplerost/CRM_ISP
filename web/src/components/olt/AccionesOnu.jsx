import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Boxes, Gauge, MoveRight, PauseCircle, PlayCircle, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, ErrorBanner, Field, Input, Select } from '../ui'

/**
 * Qué se le puede hacer a una ONT que ya está instalada.
 *
 * Las tres tienen consecuencias distintas y la pantalla lo dice, porque desde
 * afuera se parecen:
 *
 *   cambiar plan  no corta el servicio
 *   suspender     corta, pero vuelve con un clic
 *   dar de baja   irreversible del lado del equipo
 *
 * La diferencia entre suspender y dar de baja es la que más importa: un corte
 * por falta de pago se suspende. Borrarla obliga a instalarla de nuevo cuando
 * el abonado pague.
 */
export default function AccionesOnu({ olt, onu, planes, onListo, onCerrar }) {
  const confirmar = useConfirmar()
  const [plan, setPlan] = useState(onu.plan_id ?? '')
  const [trabajando, setTrabajando] = useState(null)
  const [destino, setDestino] = useState({ slot: onu.slot, puerto: '' })
  const [srvPerfil, setSrvPerfil] = useState(String(onu.srv_profile_olt ?? ''))
  const [linePerfil, setLinePerfil] = useState(String(onu.line_profile_olt ?? ''))

  /**
   * Los perfiles que tiene la OLT, leídos del equipo.
   *
   * No se guardan en la base a propósito: se crean y se borran desde la consola
   * del equipo, y una lista cacheada haría elegir uno que ya no existe. Son
   * veintidós y la consulta tarda menos de un segundo.
   */
  const [perfiles, setPerfiles] = useState(null)

  useEffect(() => {
    let vivo = true
    api.olt
      .perfilesOnt(olt.id)
      .then((p) => vivo && setPerfiles(p))
      // Falla en silencio: no poder listar los perfiles no tiene por qué tapar
      // las otras acciones, que son las que se usan todos los días.
      .catch(() => vivo && setPerfiles({ srv: [], line: [] }))
    return () => {
      vivo = false
    }
  }, [olt.id])

  /** El perfil que le corresponde por su modelo, si la OLT lo tiene. */
  const perfilDelModelo = onu.modelo
    ? (perfiles?.srv ?? []).find(
      (p) => String(p.nombre).toUpperCase() === String(onu.modelo).toUpperCase(),
    )
    : null

  const esDelModelo = (p) => perfilDelModelo && Number(p.id) === Number(perfilDelModelo.id)

  // Habilita el botón solo si de verdad hay algo distinto que aplicar: mandar
  // el mismo perfil corta el servicio unos segundos para nada.
  const hayCambioDePerfil =
    (srvPerfil !== '' && Number(srvPerfil) !== Number(onu.srv_profile_olt))
    || (linePerfil !== '' && Number(linePerfil) !== Number(onu.line_profile_olt))
  const [error, setError] = useState(null)
  const [resultado, setResultado] = useState(null)

  const suspendida = onu.onu_estado === 'unknown'

  async function correr(clave, fn) {
    setTrabajando(clave)
    setError(null)
    setResultado(null)
    try {
      const r = await fn()
      setResultado(r)
      // Se avisa QUÉ acción fue y qué devolvió. La baja hace desaparecer la
      // ficha, y sin saber cuál corrió la pantalla no puede explicar por qué se
      // quedó sin datos.
      onListo?.(clave, r)
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(null)
    }
  }

  const elegido = planes.find((p) => p.id === plan)
  const sinIndice = elegido && elegido.traffic_table_index == null

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {resultado && (
        <Aviso>
          {resultado.desde
            ? `Movida de ${resultado.desde} a ${resultado.hasta}.`
            : resultado.plan
            ? `Plan cambiado a ${resultado.plan} (${resultado.velocidad}) en ${resultado.service_ports?.length ?? 0} service-ports.`
            : resultado.activa === false
              ? resultado.aviso
              : resultado.activa === true
                ? resultado.aviso
                : `ONT ${resultado.sn} dada de baja de ${resultado.donde}.`}
          {resultado.aviso && (resultado.plan || resultado.desde) && (
            <span className="mt-1 block">{resultado.aviso}</span>
          )}
        </Aviso>
      )}

      <div className="t-panel px-4 py-3 text-sm">
        <p className="text-slate-100">{onu.cliente ?? onu.nombre_en_la_olt ?? onu.sn}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          <span className="font-mono">{onu.sn}</span> · placa {onu.slot} puerto {onu.puerto} · ONT{' '}
          {onu.onu_index}
          {onu.plan ? ` · ${onu.plan}` : ' · sin plan'}
        </p>
      </div>

      {/* --- Cambiar el tipo de ONU (los perfiles de la OLT) --- */}
      <div className="rounded-lg border border-slate-800 p-3">
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <Boxes size={13} />
          Tipo de ONU
        </h4>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Perfil de servicio" className="min-w-[220px] flex-1">
            <Select value={srvPerfil} onChange={(e) => setSrvPerfil(e.target.value)}>
              <option value="">— sin cambiar —</option>
              {(perfiles?.srv ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre} (id {p.id})
                  {esDelModelo(p) ? ' · el de este modelo' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Perfil de línea" className="min-w-[220px] flex-1">
            <Select value={linePerfil} onChange={(e) => setLinePerfil(e.target.value)}>
              <option value="">— sin cambiar —</option>
              {(perfiles?.line ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre} (id {p.id})
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variante="primario"
            icon={Boxes}
            cargando={trabajando === 'perfiles'}
            disabled={!hayCambioDePerfil}
            onClick={async () => {
              if (
                !(await confirmar({
                  titulo: 'Cambiar el tipo de ONU',
                  mensaje:
                    'La ONT se reaprovisiona por OMCI y el abonado puede perder el servicio unos '
                    + 'segundos. Su ONT-ID no cambia y no hay que volver a instalarla.',
                  etiquetaAccion: 'Cambiar el perfil',
                }))
              ) {
                return
              }
              await correr('perfiles', () =>
                api.olt.cambiarPerfilesOnu(olt.id, onu.onu_id, {
                  srv_profile_id: srvPerfil !== '' && Number(srvPerfil) !== onu.srv_profile_olt
                    ? Number(srvPerfil)
                    : undefined,
                  line_profile_id: linePerfil !== '' && Number(linePerfil) !== onu.line_profile_olt
                    ? Number(linePerfil)
                    : undefined,
                }),
              )
            }}
          >
            Cambiar
          </Button>
        </div>

        {/*
          Por qué esto existe y cuándo se usa.

          En esta OLT los perfiles de servicio se llaman como los modelos, y al
          autorizar el sistema elige el que coincide. Cuando el modelo todavía no
          tenía perfil propio, la ONT quedó con el genérico de la plantilla: da
          internet, pero puede tener puertos sin habilitar. Acá se corrige, sin
          dar de baja al abonado.
        */}
        <p className="mt-1.5 text-[11px] text-slate-500">
          {onu.modelo ? (
            perfilDelModelo ? (
              Number(onu.srv_profile_olt) === Number(perfilDelModelo.id) ? (
                <>
                  Ya tiene el perfil de su modelo (<b>{onu.modelo}</b>).
                </>
              ) : (
                <span className="text-amber-400">
                  La OLT tiene un perfil llamado <b>{onu.modelo}</b> (id {perfilDelModelo.id}) y
                  esta ONT no lo está usando. Es el que le corresponde.
                </span>
              )
            ) : (
              <>
                La OLT no tiene un perfil llamado <b>{onu.modelo}</b>. Mientras no exista, conviene
                dejarla con uno genérico que le dé servicio.
              </>
            )
          ) : (
            'No se conoce el modelo de esta ONT: resincronizá para traerlo del equipo.'
          )}
        </p>
      </div>

      {/* --- Cambiar plan --- */}
      <div className="rounded-lg border border-slate-800 p-3">
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <Gauge size={13} />
          Cambiar plan
        </h4>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Nuevo plan" className="min-w-[240px] flex-1">
            <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="">— elegí —</option>
              {planes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre} ({Math.round(p.bajada_kbps / 1000)}/{Math.round(p.subida_kbps / 1000)} Mbps)
                  {p.traffic_table_index == null ? ' — sin índice' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variante="primario"
            icon={Gauge}
            cargando={trabajando === 'plan'}
            disabled={!plan || plan === onu.plan_id || sinIndice}
            onClick={() => correr('plan', () => api.olt.cambiarPlanOnu(olt.id, onu.onu_id, plan))}
          >
            Aplicar
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          {sinIndice ? (
            <span className="text-amber-400">
              Ese plan no tiene índice de traffic table: no se puede aplicar en la OLT. Se le
              asigna desde Servicios → Planes.
            </span>
          ) : (
            'No corta el servicio: se modifican las traffic-tables de sus service-ports en vez de rehacerlos.'
          )}
        </p>
      </div>

      {/* --- Suspender --- */}
      <div className="rounded-lg border border-slate-800 p-3">
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          {suspendida ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
          {suspendida ? 'Reactivar' : 'Suspender'}
        </h4>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variante={suspendida ? 'exito' : 'alerta'}
            icon={suspendida ? PlayCircle : PauseCircle}
            cargando={trabajando === 'susp'}
            onClick={() =>
              correr('susp', () => api.olt.suspenderOnu(olt.id, onu.onu_id, suspendida))
            }
          >
            {suspendida ? 'Reactivar servicio' : 'Suspender servicio'}
          </Button>
          <p className="flex-1 text-[11px] leading-snug text-slate-500">
            {suspendida
              ? 'Vuelve a levantar en menos de un minuto.'
              : 'Es lo que corresponde para un corte por falta de pago: la configuración queda intacta y vuelve con un clic.'}
          </p>
        </div>
      </div>

      {/* --- Mover de puerto --- */}
      <div className="rounded-lg border border-slate-800 p-3">
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <MoveRight size={13} />
          Mover a otro puerto
        </h4>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Placa" className="w-24">
            <Input
              type="number"
              value={destino.slot}
              onChange={(e) => setDestino((d) => ({ ...d, slot: e.target.value }))}
              min={0}
            />
          </Field>
          <Field label="Puerto" className="w-24">
            <Input
              type="number"
              value={destino.puerto}
              onChange={(e) => setDestino((d) => ({ ...d, puerto: e.target.value }))}
              min={0}
              max={15}
            />
          </Field>
          <Button
            variante="alerta"
            icon={MoveRight}
            cargando={trabajando === 'mover'}
            disabled={
              destino.puerto === '' ||
              (Number(destino.slot) === onu.slot && Number(destino.puerto) === onu.puerto)
            }
            onClick={async () => {
              if (
                !(await confirmar(
                  `Mover la ONT de ${onu.slot}/${onu.puerto} a ${destino.slot}/${destino.puerto}.\n\n` +
                    'En Huawei no existe "mover": se borra y se vuelve a crear con la misma ' +
                    'configuración. El abonado queda sin servicio unos segundos.\n\n' +
                    'Y esto es solo la parte de software: si la fibra sigue en el puerto viejo, ' +
                    'la ONT no va a levantar.\n\n¿Continuar?',
                ))
              ) {
                return
              }
              correr('mover', () =>
                api.olt.moverOnu(olt.id, onu.onu_id, {
                  slot: Number(destino.slot),
                  puerto: Number(destino.puerto),
                }),
              )
            }}
          >
            Mover
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
          Se borra y se recrea con sus mismos perfiles, descripción, VLANs y velocidad. El ONT-ID
          puede cambiar: en el puerto nuevo se toma el primero libre.
        </p>
      </div>

      {/* --- Baja --- */}
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
        <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-rose-300">
          <Trash2 size={13} />
          Dar de baja
        </h4>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variante="peligro"
            icon={Trash2}
            cargando={trabajando === 'baja'}
            onClick={async () => {
              if (
                !(await confirmar(
                  `Dar de baja la ONT ${onu.sn}${onu.cliente ? ` de ${onu.cliente}` : ''}.\n\n` +
                    'Se borran sus service-ports y la ONT del equipo. Es IRREVERSIBLE: para volver a ' +
                    'darle servicio hay que instalarla de nuevo.\n\n' +
                    'Si es un corte por falta de pago, usá Suspender.\n\n¿Continuar?',
                ))
              ) {
                return
              }
              correr('baja', () => api.olt.darDeBajaOnu(olt.id, onu.onu_id))
            }}
          >
            Dar de baja
          </Button>
          <p className="flex-1 text-[11px] leading-snug text-rose-300/70">
            Irreversible del lado del equipo. La ficha del abonado <b>no se toca</b>: sigue
            existiendo sin ONU, con su historial de pagos y su contrato intactos.
          </p>
        </div>
      </div>

      {onCerrar && (
        <div className="flex justify-end border-t border-slate-800 pt-3">
          <Button variante="fantasma" onClick={onCerrar}>
            Cerrar
          </Button>
        </div>
      )}
    </div>
  )
}
