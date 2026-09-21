import { useEffect, useState } from 'react'
import { CheckCircle2, Gauge, PlayCircle, TriangleAlert } from 'lucide-react'
import { api } from '../../../lib/apiNetwork'
import { supabase } from '../../../lib/supabaseClient'
import { PRUEBAS, conUnidad, semaforoPruebas } from '../../../lib/instalaciones'
import { Aviso, Button } from '../../ui'

/**
 * Paso 4 — la prueba de salida.
 *
 * Es lo que separa "quedó conectado" de "anda". El ping sale del router del
 * nodo hacia el equipo recién instalado: prueba que el abonado responde dentro
 * de la red, que es lo que se puede afirmar desde acá.
 *
 * La medición de ancho de banda necesita un bandwidth-server del otro lado, que
 * una ONT común no tiene. Cuando no contesta, se informa y se sigue: bloquear
 * el cierre por una prueba que el equipo del cliente no puede responder dejaría
 * trabajos terminados sin poder cerrarse, y el técnico ya se fue.
 */

function Resultado({ etiqueta, valor, detalle, color = 'text-slate-100' }) {
  return (
    <div className="t-panel p-4 text-center">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{valor}</p>
      {detalle && <p className="mt-1 text-[11px] text-slate-500">{detalle}</p>}
    </div>
  )
}

export default function PasoPruebas({ orden, onError, onGuardado }) {
  const [corriendo, setCorriendo] = useState(false)
  const [r, setR] = useState(null)

  const pingOk = r?.ok ?? orden.ping_ok
  const ms = r?.ping?.ms_promedio ?? orden.ping_ms
  const perdida = r?.ping?.perdida ?? orden.ping_perdida
  const bajada = r?.velocidad?.bajada_mbps ?? orden.test_bajada_mbps
  const subida = r?.velocidad?.subida_mbps ?? orden.test_subida_mbps

  /**
   * La velocidad contratada, para poder juzgar la medida.
   *
   * 45 Mbps es excelente en un plan de 50 y es la mitad de lo vendido en uno de
   * 100, así que sin el plan no se puede decir si la entrega está bien.
   *
   * Se busca aparte porque `v_instalaciones` trae el NOMBRE del plan, no su
   * velocidad — se comprobó contra la base antes de escribir esto, después de
   * casi mandar una consulta a columnas que no existen.
   */
  const [planMbps, setPlanMbps] = useState(null)
  useEffect(() => {
    if (!orden.plan_id) return
    let vivo = true
    supabase
      .from('v_planes')
      .select('bajada_mbps')
      .eq('id', orden.plan_id)
      .maybeSingle()
      .then(({ data }) => vivo && setPlanMbps(Number(data?.bajada_mbps) || null))
    return () => {
      vivo = false
    }
  }, [orden.plan_id])
  const color = semaforoPruebas(
    { ping_ms: ms, ping_perdida: perdida, test_bajada_mbps: bajada },
    planMbps,
  )

  async function correr() {
    setCorriendo(true)
    onError?.(null)

    try {
      const salida = await api.instalaciones.pruebas(orden.id)
      setR(salida)
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setCorriendo(false)
    }
  }

  return (
    <div className="space-y-4">
      <Aviso>
        Se hace un ping desde el router del nodo hacia {orden.ip ?? 'el equipo del abonado'} y, si el
        equipo lo permite, una medición de velocidad del enlace.
      </Aviso>

      <Button
        variante="primario"
        icon={PlayCircle}
        onClick={correr}
        cargando={corriendo}
        className="w-full"
      >
        {orden.pruebas_at ? 'Volver a probar' : 'Ejecutar las pruebas'}
      </Button>

      {/* El veredicto, antes de los números.
          Sin esto, el paso guardaba ping y velocidad y no decía si estaban
          bien: un técnico anotaba 45 Mbps en un plan de 100 y se iba. Los
          umbrales salen de `parametros_tecnicos`, no del código. */}
      <Veredicto
        color={color}
        planMbps={planMbps}
        bajada={bajada}
        ms={ms}
        perdida={perdida}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Resultado
          etiqueta="Respuesta"
          valor={pingOk == null ? '—' : pingOk ? 'Responde' : 'Sin respuesta'}
          detalle={perdida != null ? `${perdida}% de pérdida` : null}
          color={pingOk == null ? 'text-slate-100' : pingOk ? 'text-emerald-400' : 'text-rose-400'}
        />
        <Resultado etiqueta="Latencia" valor={conUnidad(ms, 'ms', 1)} />
        <Resultado
          etiqueta="Velocidad"
          valor={bajada == null ? '—' : `${bajada} Mbps`}
          detalle={subida != null ? `${subida} Mbps de subida` : null}
        />
      </div>

      {r?.mensaje && (
        <Aviso tipo={r.ok ? 'info' : 'alerta'}>{r.mensaje}</Aviso>
      )}

      {r?.velocidad?.aviso && (
        <p className="flex items-start gap-2 text-xs text-slate-500">
          <Gauge size={14} className="mt-0.5 shrink-0" />
          {r.velocidad.aviso}
        </p>
      )}

      {pingOk === false && (
        <Aviso tipo="alerta">
          El equipo no está tomando la configuración. Revisá que el usuario y la clave estén bien
          cargados en {orden.tecnologia === 'wireless' ? 'el CPE' : 'la ONT'}, o que el equipo tenga
          DHCP activado del lado WAN.
        </Aviso>
      )}

      {orden.pruebas_at && (
        <p className="text-xs text-slate-500">
          Última prueba: {new Date(orden.pruebas_at).toLocaleString()}
        </p>
      )}
    </div>
  )
}

/**
 * Óptimo, advertencia o fuera de rango.
 *
 * Dice POR QUÉ, no solo el color. "Fuera de rango" a secas obliga al técnico a
 * adivinar si el problema es la latencia, la pérdida o la velocidad, y a
 * adivinar mal: vuelve a apretar el botón esperando otro resultado.
 */
function Veredicto({ color, planMbps, bajada, ms, perdida }) {
  if (!color) return null

  const V = {
    verde: {
      clase: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
      icono: CheckCircle2,
      titulo: 'Óptimo',
    },
    ambar: {
      clase: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      icono: TriangleAlert,
      titulo: 'Advertencia',
    },
    rojo: {
      clase: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
      icono: TriangleAlert,
      titulo: 'Fuera de rango',
    },
  }[color]

  const motivos = []
  if (ms != null && ms > PRUEBAS.pingLimiteMs) motivos.push(`la latencia supera ${PRUEBAS.pingLimiteMs} ms`)
  else if (ms != null && ms > PRUEBAS.pingBuenoMs) motivos.push(`la latencia pasa de ${PRUEBAS.pingBuenoMs} ms`)
  if (perdida != null && perdida > PRUEBAS.perdidaMaximaPct)
    motivos.push(`pierde ${perdida}% de los paquetes`)
  if (planMbps && bajada != null && bajada < (planMbps * PRUEBAS.velocidadMinimaPct) / 100)
    motivos.push(
      `entrega ${bajada} de ${planMbps} Mbps (mínimo ${PRUEBAS.velocidadMinimaPct}%)`,
    )

  return (
    <div className={`flex items-start gap-2.5 rounded-xl border p-3 ${V.clase}`}>
      <V.icono size={18} className="mt-0.5 shrink-0" />
      <div>
        <p className="text-[14px] font-semibold">{V.titulo}</p>
        <p className="mt-0.5 text-[12px] opacity-90">
          {motivos.length ? motivos.join(' · ') : 'La entrega cumple con los parámetros de la empresa.'}
        </p>
        {/* Sin el plan cargado no se puede juzgar la velocidad, y hay que
            decirlo: un verde que solo miró el ping no es un verde completo. */}
        {!planMbps && bajada != null && (
          <p className="mt-0.5 text-[11px] opacity-70">
            La orden no tiene el plan cargado: solo se evaluó la latencia.
          </p>
        )}
      </div>
    </div>
  )
}
