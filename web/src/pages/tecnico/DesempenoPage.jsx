import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Clock,
  Gauge,
  Package,
  Route,
  ThumbsUp,
  TrendingDown,
  TrendingUp,
  Wrench,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { conCache } from '../../lib/cacheLocal'

/**
 * Mi desempeño.
 *
 * ── Contra qué se compara ──
 *
 * Contra el mes anterior del MISMO técnico. No contra los demás.
 *
 * Es la misma decisión que se tomó con el tablero del vendedor: quién rinde
 * cuánto es información de quien dirige, y ponerla en la pantalla de todos
 * convierte el trabajo en un ranking. Un técnico que ve que está tercero no
 * trabaja mejor: agarra los trabajos fáciles.
 *
 * La comparación entre técnicos existe, pero en la pantalla del administrador,
 * y ahí va con el contexto —kilómetros, zona— sin el cual castiga al de la
 * ruta larga.
 *
 * ── Por qué cada número trae su denominador ──
 *
 * "100% puntual" sobre dos trabajos medidos y sobre cuarenta se ven igual y no
 * son lo mismo. Y cuando el denominador es cero, la pantalla no muestra un cero
 * ni un guión mudo: dice QUÉ FALTA HACER para que ese número exista. Un
 * indicador vacío sin explicación se lee como "no sirve" y se deja de mirar.
 */
export default function DesempenoPage() {
  const { perfil } = usePermisos()
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [deCache, setDeCache] = useState(null)

  const recargar = useCallback(async () => {
    try {
      const r = await conCache(`desempeno:${perfil?.id ?? 'anonimo'}`, async () => {
        const { data, error: err } = await supabase
          .from('v_desempeno_tecnico')
          .select('*')
          .order('mes', { ascending: false })
          .limit(12)
        if (err) throw err
        return data ?? []
      })
      setFilas(r.datos)
      setDeCache(r.deCache ? r.minutos : null)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [perfil?.id])

  useEffect(() => {
    recargar()
  }, [recargar])

  const [mes, anterior] = useMemo(() => [filas[0] ?? null, filas[1] ?? null], [filas])

  if (cargando) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="campo-borde campo-sup h-24 animate-pulse rounded-2xl border" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-center">
        <p className="text-[14px] text-rose-300">No se pudo cargar tu desempeño.</p>
        <p className="mt-1 font-mono text-[11px] text-rose-400/70">{error.message}</p>
      </div>
    )
  }

  if (!mes) {
    return (
      <div className="py-16 text-center">
        <Gauge size={28} className="campo-tenue mx-auto mb-2" />
        <p className="campo-suave text-[14px]">Todavía no hay trabajos cerrados este mes.</p>
        <p className="campo-tenue mt-1 text-[12px]">
          Las cifras aparecen solas a medida que cerrás órdenes y tickets.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {deCache != null && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-600">
          Sin conexión. Estás viendo lo guardado hace{' '}
          {deCache < 60 ? `${deCache} min` : `${Math.floor(deCache / 60)} h`}.
        </div>
      )}

      <div className="campo-borde campo-sup rounded-2xl border p-4">
        <p className="campo-tenue text-[11px] font-semibold uppercase tracking-wider">
          {new Date(`${mes.mes}T12:00:00`).toLocaleDateString('es-EC', {
            month: 'long',
            year: 'numeric',
          })}
        </p>
        <p className="campo-txt mt-1 text-3xl font-semibold tabular-nums">
          {mes.trabajos}{' '}
          <span className="campo-suave text-[15px] font-normal">
            {mes.trabajos === 1 ? 'trabajo cerrado' : 'trabajos cerrados'}
          </span>
        </p>
        <p className="campo-tenue mt-0.5 text-[12px]">
          {mes.instalaciones} instalaciones · {mes.tickets} tickets
          {mes.visitas_fallidas > 0 && ` · ${mes.visitas_fallidas} sin poder hacer`}
        </p>
        <Variacion actual={mes.trabajos} previo={anterior?.trabajos} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Tarjeta
          icono={Clock}
          titulo="Puntualidad"
          valor={mes.pct_puntual}
          sufijo="%"
          base={mes.con_hora_y_llegada}
          unidadBase="trabajos con hora y llegada"
          faltante="Marcá la llegada al domicilio para que este número exista."
          previo={anterior?.pct_puntual}
          detalle={
            mes.atraso_mediana != null
              ? mes.atraso_mediana <= 0
                ? `Solés llegar ${Math.abs(mes.atraso_mediana)} min antes`
                : `Atraso habitual: ${mes.atraso_mediana} min`
              : null
          }
        />

        <Tarjeta
          icono={Wrench}
          titulo="Tiempo por trabajo"
          valor={mes.minutos_mediana}
          sufijo=" min"
          base={mes.trabajos}
          unidadBase="trabajos"
          faltante="Marcá la llegada para poder medir cuánto durás adentro."
          previo={anterior?.minutos_mediana}
          // Menos minutos es mejor, así que la flecha se invierte.
          menosEsMejor
          detalle="Mediana, no promedio: un trabajo largo no te mueve el mes."
        />

        <Tarjeta
          icono={ThumbsUp}
          titulo="Señal óptima"
          valor={mes.pct_senal_optima}
          sufijo="%"
          base={mes.con_medicion}
          unidadBase="instalaciones medidas"
          faltante="Se calcula sobre las instalaciones con la potencia cargada."
          previo={anterior?.pct_senal_optima}
          detalle={
            mes.pct_velocidad_ok != null
              ? `${mes.pct_velocidad_ok}% entregó la velocidad del plan (${mes.con_velocidad} medidas)`
              : null
          }
        />

        <Tarjeta
          icono={TrendingDown}
          titulo="Volvieron a llamar"
          valor={mes.pct_reincidencia}
          sufijo="%"
          base={mes.trabajos}
          unidadBase="trabajos"
          faltante="Aparece cuando haya trabajos cerrados."
          previo={anterior?.pct_reincidencia}
          menosEsMejor
          // Se dice con todas las letras qué mide y qué no. Es el indicador más
          // fácil de leer como una acusación, y no lo es.
          detalle={`${mes.trabajos_con_reclamo} cliente(s) llamaron después. Puede ser por el trabajo o por otra cosa.`}
        />

        <Tarjeta
          icono={Package}
          titulo="Cable por instalación"
          valor={mes.metros_por_instalacion}
          sufijo=" m"
          base={mes.instalaciones}
          unidadBase="instalaciones"
          faltante="Descontá el material en el paso 5 para que se mida."
          previo={anterior?.metros_por_instalacion}
          detalle={mes.metros_cable ? `${mes.metros_cable} m en total` : null}
        />

        <Tarjeta
          icono={Route}
          titulo="Kilómetros"
          valor={mes.km_mes}
          sufijo=" km"
          base={mes.dias_con_km}
          unidadBase="días con odómetro cargado"
          faltante="Cargá el kilometraje al salir y al volver."
          previo={anterior?.km_mes}
          detalle={
            mes.km_por_trabajo != null ? `${mes.km_por_trabajo} km por trabajo` : null
          }
        />
      </div>

      <p className="campo-tenue px-1 text-[11px]">
        Estas cifras son tuyas y se comparan con tu propio mes anterior. Salen solas de los
        trabajos que vas cerrando — no hay nada extra que cargar.
      </p>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */

function Tarjeta({
  icono: Icono,
  titulo,
  valor,
  sufijo = '',
  base,
  unidadBase,
  faltante,
  previo,
  detalle,
  menosEsMejor = false,
}) {
  // Sin base no hay número, y se dice qué hacer para que lo haya. Mostrar "0%"
  // sería peor que no mostrar nada: parece un mal resultado cuando lo que pasa
  // es que no se midió.
  const sinDatos = valor == null || !base

  return (
    <div className="campo-borde campo-sup rounded-2xl border p-4">
      <div className="flex items-center gap-2">
        <Icono size={15} className="campo-tenue shrink-0" />
        <p className="campo-suave text-[12px] font-medium">{titulo}</p>
      </div>

      {sinDatos ? (
        <>
          <p className="campo-tenue mt-2 text-2xl font-semibold">—</p>
          <p className="campo-tenue mt-0.5 text-[11px]">{faltante}</p>
        </>
      ) : (
        <>
          <p className="campo-txt mt-1 text-3xl font-semibold tabular-nums">
            {valor}
            <span className="campo-suave text-[15px] font-normal">{sufijo}</span>
          </p>
          {/* El denominador, siempre pegado al número. */}
          <p className="campo-tenue text-[11px]">
            sobre {base} {unidadBase}
          </p>
          <Variacion actual={valor} previo={previo} menosEsMejor={menosEsMejor} />
          {detalle && <p className="campo-tenue mt-1.5 text-[11px]">{detalle}</p>}
        </>
      )}
    </div>
  )
}

/**
 * Contra el mes pasado.
 *
 * Sin mes anterior no se dibuja nada: "sin cambios" sería falso, y una flecha
 * verde en el primer mes no significa nada.
 */
function Variacion({ actual, previo, menosEsMejor = false }) {
  if (previo == null || actual == null || previo === 0) return null
  const dif = Number(actual) - Number(previo)
  if (dif === 0) return null

  const mejora = menosEsMejor ? dif < 0 : dif > 0
  const Flecha = dif > 0 ? TrendingUp : TrendingDown

  return (
    <p
      className={`mt-1 flex items-center gap-1 text-[11px] ${
        mejora ? 'text-emerald-500' : 'text-amber-500'
      }`}
    >
      <Flecha size={12} />
      {dif > 0 ? '+' : ''}
      {Math.round(dif * 10) / 10} contra el mes pasado
    </p>
  )
}
