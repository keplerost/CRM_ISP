import { useState } from 'react'
import { Activity, KeyRound, RefreshCw } from 'lucide-react'
import { api } from '../../../lib/apiNetwork'
import { COLOR_SEMAFORO, OPTICA, RADIO, conUnidad, semaforoDe } from '../../../lib/instalaciones'
import { Aviso, Button, Field, Input, Select } from '../../ui'

/**
 * Paso 2 — cómo llegó la señal.
 *
 * El técnico aprieta un botón y el sistema le pregunta a la OLT o al router del
 * sector, en vivo. No se escribe a mano: el valor que respalda una instalación
 * tiene que venir del equipo que mide, no de lo que alguien leyó en la pantalla
 * de la ONT y transcribió.
 *
 * El semáforo existe porque el número solo no dice nada a quien recién empieza.
 * -26 dBm y -28 dBm se parecen; uno se puede cerrar y el otro se va a caer el
 * primer día de lluvia.
 */

/** Un valor grande y legible a un brazo de distancia, colgado de una escalera. */
function Medicion({ etiqueta, valor, color = 'text-slate-100' }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-center">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{valor}</p>
    </div>
  )
}

export default function PasoSenal({ orden, onError, onGuardado }) {
  const [midiendo, setMidiendo] = useState(false)
  const [resultado, setResultado] = useState(null)
  // Cuando la orden no dice de qué OLT cuelga, se pregunta acá mismo en vez de
  // mandar al técnico a otra pantalla: está en la calle, arriba de una escalera,
  // con la caja abierta.
  const [oltsAElegir, setOltsAElegir] = useState(null)
  const [oltElegida, setOltElegida] = useState('')
  // La ONT llegó pero todavía no está dada de alta. Es el estado normal de una
  // instalación nueva justo cuando el técnico mide, así que se resuelve acá y
  // no mandándolo a otra pantalla.
  const [porAutorizar, setPorAutorizar] = useState(null)
  const [preset, setPreset] = useState('')
  const [vlan, setVlan] = useState('')
  const [autorizando, setAutorizando] = useState(false)

  const esFibra = orden.tecnologia !== 'wireless'
  // El semáforo sale de la respuesta recién medida si la hay, y si no de lo que
  // quedó guardado: al volver al paso, el técnico tiene que ver su lectura.
  const semaforo = resultado?.semaforo ?? semaforoDe(orden)
  // Con respaldo: un semáforo que el front no conozca tiene que verse neutro,
  // no tumbar la pantalla en la que el técnico está trabajando.
  const color = COLOR_SEMAFORO[semaforo] ?? COLOR_SEMAFORO.gris

  async function medir(oltId) {
    setMidiendo(true)
    onError?.(null)

    try {
      const r = await api.instalaciones.lectura(orden.id, oltId ? { olt_id: oltId } : {})
      setResultado(r)
      setOltsAElegir(null)
      setPorAutorizar(null)
      await onGuardado?.()
    } catch (err) {
      // El middleware contesta 409 con el motivo cuando el equipo no aparece:
      // no es un fallo del sistema sino un hallazgo del trabajo, y se muestra
      // como tal en vez de como un error rojo suelto.
      if (err.puede_autorizar) {
        // Buena noticia disfrazada de error: la fibra llegó y la OLT ve la ONT.
        // Solo falta darla de alta, y eso se hace desde acá.
        setResultado({ semaforo: 'ambar', mensaje: err.message, hint: err.hint, encontrada: true })
        setPorAutorizar(err)
        const porDefecto = err.presets?.find((p) => p.predeterminado) ?? err.presets?.[0]
        setPreset(porDefecto?.id ?? '')
        /**
         * Manda la VLAN DEL PUERTO, no la de la plantilla.
         *
         * Las plantillas son globales —"Residencial FTTH · VLAN 200" vale para
         * todo el parque—, pero cuando el ISP reparte una VLAN por puerto PON
         * la plantilla acierta en uno y falla en los otros quince. La ONT del
         * puerto 9 autorizada en la VLAN 200 queda navegando igual, con una IP
         * del pool que no le toca, y nadie se entera hasta que alguien busca
         * por qué el puerto 9 tiene direcciones del bloque del 0.
         */
        setVlan(err.puerto_pon?.vlan ?? porDefecto?.vlan ?? '')
      } else if (err.sin_respuesta || err.status === 503) {
        // El equipo no contestó. Eso NO es rojo: rojo es "medí y está mal", y
        // acá no se midió nada. Pintarlo rojo manda al técnico a revisar
        // conectores por un problema que está del otro lado.
        setResultado({ semaforo: 'gris', mensaje: err.message, hint: err.hint, encontrada: false })
      } else if (err.status === 409) {
        setResultado({ semaforo: 'rojo', mensaje: err.message, hint: err.hint, encontrada: false })
      } else if (err.olts?.length) {
        // Falta la OLT y el error trae cuáles hay: se ofrecen en vez de dejar
        // al técnico leyendo una instrucción que no puede cumplir desde acá.
        setOltsAElegir(err.olts)
        setOltElegida(err.olts.length === 1 ? err.olts[0].id : '')
      } else {
        onError?.(err)
      }
    } finally {
      setMidiendo(false)
    }
  }

  return (
    <div className="space-y-4">
      <Aviso>
        {esFibra
          ? `Se le pregunta a la OLT por la ONT ${orden.equipo_sn ?? ''}: potencia recibida y estado del registro.`
          : `Se le pregunta al router del sector por el CPE ${orden.equipo_mac ?? ''}: señal y calidad del enlace (CCQ).`}
      </Aviso>

      <Button
        variante="primario"
        icon={midiendo ? RefreshCw : Activity}
        onClick={() => medir()}
        cargando={midiendo}
        className="w-full"
      >
        {orden.lectura_at ? 'Volver a medir' : 'Consultar señal ahora'}
      </Button>

      {oltsAElegir && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-sm font-semibold text-amber-200">Esta orden no tiene OLT asignada</p>
          <p className="text-xs leading-snug text-amber-200/80">
            Normalmente sale sola de la caja NAP que se elige al validar la factibilidad. Elegila
            acá para medir ahora: queda guardada en la orden y no se vuelve a preguntar.
          </p>
          <Select value={oltElegida} onChange={(e) => setOltElegida(e.target.value)}>
            <option value="">— elegí la OLT —</option>
            {oltsAElegir.map((o) => (
              <option key={o.id} value={o.id}>
                {o.numero ? `${o.numero} · ` : ''}
                {o.nombre}
              </option>
            ))}
          </Select>
          <Button
            variante="primario"
            icon={Activity}
            disabled={!oltElegida}
            cargando={midiendo}
            onClick={() => medir(oltElegida)}
            className="w-full"
          >
            Medir con esta OLT
          </Button>
        </div>
      )}

      {porAutorizar && (
        <div className="space-y-3 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3">
          <div>
            <p className="text-sm font-semibold text-sky-200">La fibra llegó bien</p>
            <p className="mt-0.5 text-xs leading-snug text-sky-200/80">
              La OLT ve la ONT en el puerto PON {porAutorizar.puerto}. Falta darla de alta: se hace
              desde acá y terminás.
            </p>
          </div>

          {/* Lo que el sistema ya sabe. El técnico no reescribe nada de esto:
              sale de la orden de trabajo, que es donde tiene que estar. */}
          <dl className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs">
            <Dato k="Abonado" v={porAutorizar.sabido?.nombre} />
            <Dato k="Dirección" v={porAutorizar.sabido?.direccion} />
            <Dato k="Plan" v={porAutorizar.sabido?.plan} />
            <Dato k="Serie" v={orden.equipo_sn} mono />
            {porAutorizar.perfil_servicio && (
              <Dato
                k="Modelo"
                v={
                  porAutorizar.perfil_servicio.por_modelo
                    ? `${porAutorizar.perfil_servicio.modelo} · perfil propio`
                    : `${porAutorizar.perfil_servicio.modelo} · sin perfil propio`
                }
              />
            )}
          </dl>

          {/*
            El modelo no tiene perfil en la OLT.

            No frena el alta: el abonado se conecta con el perfil genérico de la
            plantilla y navega. Lo que puede faltarle son los puertos que ese
            perfil no habilita —una FXS, un SSID—. Se dice acá para que el
            técnico no se vaya creyendo que quedó todo redondo.
          */}
          {porAutorizar.perfil_servicio && !porAutorizar.perfil_servicio.por_modelo && (
            <Aviso tipo="alerta">
              La OLT no tiene un perfil de servicio llamado{' '}
              <b>{porAutorizar.perfil_servicio.modelo}</b>. La ONT se va a autorizar con el
              genérico de la plantilla: va a navegar, pero puede quedarle algún puerto sin
              habilitar. Después conviene crear el perfil con el nombre del modelo y reprovisionar.
            </Aviso>
          )}

          <Field
            label="Plantilla"
            hint={
              porAutorizar.puerto_pon?.vlan != null
                ? 'trae los perfiles de la OLT · la VLAN la manda el puerto'
                : 'trae los perfiles y la VLAN'
            }
          >
            <Select
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value)
                const p = porAutorizar.presets?.find((x) => x.id === e.target.value)
                /**
                 * Elegir plantilla NO pisa la VLAN del puerto.
                 *
                 * Antes sí: al tocar el desplegable, el campo saltaba de la 209
                 * a la 200 de la plantilla, sin que se viera. La plantilla es
                 * global —los perfiles de línea y de servicio son los mismos
                 * para todo el parque— pero la VLAN es de ESTE puerto PON.
                 *
                 * Cuando no se sabe cuál le toca al puerto sí se usa la de la
                 * plantilla, que es mejor que dejar el campo vacío.
                 */
                setVlan(porAutorizar.puerto_pon?.vlan ?? p?.vlan ?? '')
              }}
            >
              <option value="">— sin plantilla —</option>
              {(porAutorizar.presets ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                  {/*
                    La VLAN de la plantilla solo se muestra cuando de verdad se
                    va a usar. Con una VLAN por puerto PON, leer "· VLAN 200" al
                    lado del nombre hacía creer que la ONT iba a quedar ahí,
                    cuando el campo de abajo —que es el que manda— decía 209.
                  */}
                  {porAutorizar.puerto_pon?.vlan == null && p.vlan ? ` · VLAN ${p.vlan}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="VLAN"
            hint={
              vlan
                ? (porAutorizar.puerto_pon?.vlan != null
                  && Number(vlan) === Number(porAutorizar.puerto_pon.vlan)
                  ? `la del puerto ${porAutorizar.puerto_pon.slot}/${porAutorizar.puerto_pon.puerto}`
                  + (porAutorizar.puerto_pon.cidr ? ` · ${porAutorizar.puerto_pon.cidr}` : '')
                  : null)
                : 'sin VLAN la ONT queda conectada y sin internet'
            }
          >
            <Input
              type="number"
              value={vlan}
              onChange={(e) => setVlan(e.target.value)}
              placeholder={porAutorizar.puerto_pon?.vlan ?? '200'}
            />
          </Field>

          {/*
            La plantilla dice una VLAN y el puerto usa otra.

            No se bloquea: puede ser deliberado —un abonado corporativo en su
            propia VLAN— y el técnico está en la calle. Pero tiene que verlo,
            porque autorizar en la VLAN equivocada NO deja al abonado sin
            internet: lo deja navegando por el lado que no es, que es mucho más
            difícil de encontrar después.
          */}
          {porAutorizar.puerto_pon?.vlan != null
            && vlan !== ''
            && Number(vlan) !== Number(porAutorizar.puerto_pon.vlan) && (
            <Aviso tipo="alerta">
              El puerto PON {porAutorizar.puerto_pon.slot}/{porAutorizar.puerto_pon.puerto} usa la{' '}
              <b>VLAN {porAutorizar.puerto_pon.vlan}</b>
              {porAutorizar.puerto_pon.subred ? ` (${porAutorizar.puerto_pon.subred})` : ''}, y vas
              a autorizar en la <b>VLAN {vlan}</b>. Si no es a propósito, la ONT va a tomar una IP
              del bloque de otro puerto.
            </Aviso>
          )}

          {(porAutorizar.presets ?? []).length === 0 && (
            <Aviso tipo="alerta">
              No hay ninguna plantilla cargada. Se puede autorizar escribiendo la VLAN, pero
              conviene armar una desde el tablero para no tener que acordarse en cada alta.
            </Aviso>
          )}

          <Button
            variante="exito"
            icon={KeyRound}
            cargando={autorizando}
            disabled={!vlan}
            className="w-full"
            onClick={async () => {
              setAutorizando(true)
              onError?.(null)
              try {
                const r = await api.instalaciones.autorizar(orden.id, {
                  preset_id: preset || undefined,
                  vlan: Number(vlan),
                })
                setPorAutorizar(null)
                setResultado({
                  semaforo: 'ambar',
                  mensaje: `ONT autorizada en el puerto ${r.puerto}, ONT-ID ${r.ont_id}.`,
                  // En un traslado, lo que pasó con el domicilio viejo va
                  // ANTES de "esperá y volvé a medir": si quedó una ONT colgada
                  // allá, es lo único de esta pantalla que necesita a alguien.
                  hint: [r.traslado?.aviso, r.siguiente].filter(Boolean).join(' · '),
                  encontrada: true,
                })
                await onGuardado?.()
              } catch (err) {
                onError?.(err)
              } finally {
                setAutorizando(false)
              }
            }}
          >
            Autorizar esta ONT
          </Button>
        </div>
      )}

      {semaforo && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${color.clase}`}>
          <p className="font-semibold">{color.label}</p>
          <p className="mt-1">{resultado?.mensaje ?? 'Lectura guardada de esta instalación.'}</p>
          {resultado?.hint && <p className="mt-1 text-xs opacity-80">{resultado.hint}</p>}
        </div>
      )}

      {esFibra ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Medicion
            etiqueta="Potencia RX"
            valor={conUnidad(resultado?.rx_power_dbm ?? orden.rx_power_dbm, 'dBm', 2)}
          />
          <Medicion
            etiqueta="Potencia TX"
            valor={conUnidad(resultado?.tx_power_dbm ?? orden.tx_power_dbm, 'dBm', 2)}
          />
          <Medicion etiqueta="Puerto PON" valor={resultado?.puerto ?? orden.puerto_pon ?? '—'} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Medicion etiqueta="Señal" valor={conUnidad(resultado?.senal_dbm ?? orden.senal_dbm, 'dBm', 0)} />
          <Medicion etiqueta="CCQ" valor={conUnidad(resultado?.ccq ?? orden.ccq, '%', 0)} />
          <Medicion etiqueta="Tasa TX" valor={resultado?.tasa_tx ?? '—'} />
        </div>
      )}

      <p className="text-xs text-slate-500">
        {esFibra
          ? `Óptimo entre ${OPTICA.saturado} y ${OPTICA.optimo} dBm · atenuado por debajo de ${OPTICA.limite} dBm.`
          : `Óptimo por encima de ${RADIO.optimo} dBm con más de ${RADIO.ccqMinimo}% de CCQ · malo por debajo de ${RADIO.limite} dBm.`}
      </p>

      {semaforo === 'rojo' && (
        <Aviso tipo="alerta">
          Con este valor el servicio se va a caer. Corregí la instalación —conectores, empalmes,
          alineación de la antena— y volvé a medir antes de seguir. Cerrar así es garantizar un
          reclamo esta semana.
        </Aviso>
      )}

      {orden.lectura_at && (
        <p className="text-xs text-slate-500">
          Última lectura: {new Date(orden.lectura_at).toLocaleString()}
        </p>
      )}
    </div>
  )
}

/** Una fila de "esto ya lo sabe el sistema". El hueco se muestra como hueco. */
function Dato({ k, v, mono }) {
  return (
    <div className="flex gap-2 py-0.5">
      <dt className="w-20 shrink-0 text-slate-500">{k}</dt>
      <dd className={`min-w-0 flex-1 text-slate-200 ${mono ? 'font-mono' : ''}`}>
        {v || <span className="text-slate-600">—</span>}
      </dd>
    </div>
  )
}
