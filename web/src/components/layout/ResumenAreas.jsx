import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Briefcase, ChevronDown, Wrench } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Skeleton } from '../ui'
import { usePermisos } from '../../lib/AuthContext'

/**
 * Las dos áreas, desde arriba.
 *
 * ── Qué problema resuelve ──
 *
 * Quien dirige no vive en ningún módulo: entra, quiere saber si hay algo raro y
 * recién ahí decide dónde meterse. Hasta ahora el Dashboard solo contaba la red
 * —OLTs, routers, ONUs— y para enterarse de cuántas ventas hubo hoy había que
 * abrir el tablero del vendedor, que es la agenda de otra persona.
 *
 * ── Por qué cada número se abre ──
 *
 * Porque "4 ventas hoy" invita inmediatamente a la pregunta "¿de quién?", y si
 * para contestarla hay que salir de la pantalla, abrir un módulo y filtrar por
 * fecha, el número deja de servir para decidir y queda como adorno. Un clic
 * muestra los nombres acá mismo; el enlace al módulo sigue estando para cuando
 * haga falta trabajar sobre eso.
 *
 * Los detalles vienen en la misma consulta que los totales. Traer "hoy" son
 * unas pocas filas, así que pedirlas dos veces —una para contar y otra para
 * listar— sería más lento y podría mostrar dos números distintos si algo cambia
 * en el medio.
 *
 * ── Por qué no aparece para todos ──
 *
 * Un vendedor no necesita el resumen del área técnica y un técnico no necesita
 * el de ventas: los dos tienen su propia pantalla, más detallada, que es donde
 * trabajan. Esto es para quien mira las dos.
 */
export default function ResumenAreas() {
  const { puede } = usePermisos()
  const [d, setD] = useState(null)
  const [abierto, setAbierto] = useState(null)

  const cargar = useCallback(async () => {
    // La fecha, en hora local. `toISOString()` da UTC, y en Ecuador eso hace que
    // después de las 19:00 el sistema empiece a contar el día siguiente — ya nos
    // pasó una vez y el síntoma es un tablero en cero a la tarde.
    const hoy = new Date()
    const iso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(
      hoy.getDate(),
    ).padStart(2, '0')}`
    const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).toISOString()

    const [ventas, movimiento, expedientes, ordenes, jornadas, criticas] = await Promise.all([
      // Una venta es un prospecto GANADO. No una cotización enviada ni un
      // prospecto cargado: es cuando la persona dijo que sí.
      supabase
        .from('v_prospectos')
        .select('id, nombre, vendedor, vendedor_id, valor_mensual, plan')
        .eq('estado', 'ganado')
        .gte('ganado_en', desde),

      supabase
        .from('v_prospectos')
        .select('id, nombre, vendedor, vendedor_id, estado')
        .gte('actualizado_en', desde),

      // Ventas cerradas que todavía no pueden convertirse en orden de trabajo.
      // Es el cuello de botella real del área comercial: la venta está hecha y
      // el técnico no puede salir.
      supabase
        .from('v_expedientes')
        .select(
          'id, cliente, ok_datos, ok_cedula_frontal, ok_cedula_posterior, ok_fotos, ok_ubicacion, ok_plan, ok_contrato, ok_firma',
        )
        .eq('completo', false),

      supabase
        .from('v_instalaciones')
        .select('id, numero, cliente, nombre, tecnico_nombre, estado, hora')
        .eq('fecha', iso)
        .in('estado', ['agendada', 'en_curso']),

      // Jornada abierta = arrancó y no cerró. Es quién está trabajando ahora,
      // no quién tiene turno asignado.
      supabase
        .from('v_jornadas')
        .select('id, tecnico, tecnico_id, vehiculo, placa, inicio_at')
        .is('fin_at', null)
        .gte('inicio_at', desde),

      // Nodos caídos por sí mismos. Los que se cayeron porque se cayó su padre
      // no se cuentan: son el mismo problema contado diez veces.
      //
      // `not(... is true)` y no `eq(..., false)`: la vista deja `por_el_padre`
      // en NULL —no en `false`— cuando el nodo se cayó solo, así que comparar
      // con `false` no contaba ninguna. Con una torre caída arrastrando dos APs,
      // el tablero decía "0 incidencias críticas" con el sector sin servicio.
      supabase
        .from('v_estado_red')
        .select('id, nombre, minutos_asi, clientes_afectados')
        .eq('estado', 'down')
        .not('por_el_padre', 'is', true),
    ])

    // Un dato que no se pudo leer queda en `null`, no en cero: "0 incidencias
    // críticas" y "no pude consultarlo" son cosas muy distintas para quien
    // decide si sale a la calle.
    const filas = (r) => (r.error ? null : (r.data ?? []))
    setD({
      ventas: filas(ventas),
      movimiento: filas(movimiento),
      expedientes: filas(expedientes),
      ordenes: filas(ordenes),
      jornadas: filas(jornadas),
      criticas: filas(criticas),
    })
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  /** Quién movió algo hoy, con cuánto. Se agrupa acá y no en la base: son diez filas. */
  const porVendedor = useMemo(() => {
    if (!d?.movimiento) return null
    const mapa = new Map()
    for (const p of d.movimiento) {
      const clave = p.vendedor_id ?? 'sin'
      const y = mapa.get(clave) ?? { nombre: p.vendedor ?? 'Sin vendedor', gestionados: 0, ganados: 0 }
      y.gestionados++
      if (p.estado === 'ganado') y.ganados++
      mapa.set(clave, y)
    }
    return [...mapa.values()].sort((a, b) => b.ganados - a.ganados || b.gestionados - a.gestionados)
  }, [d])

  const veComercial = puede('ventas.prospectos') || puede('ventas.dashboard')
  const veTecnica = puede('instalaciones.ver') || puede('soporte.ver')
  if (!veComercial || !veTecnica) return null

  const alternar = (k) => setAbierto((a) => (a === k ? null : k))

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Area
        titulo="Área comercial"
        icon={Briefcase}
        color="text-sky-400"
        borde="border-sky-500/30"
        a="/ventas/prospectos"
        enlace="Ver área comercial"
        cargando={!d}
        abierto={abierto}
        onAbrir={alternar}
        partes={[
          {
            clave: 'ventas',
            valor: d?.ventas?.length,
            label: 'ventas hoy',
            vacio: 'Todavía no se cerró ninguna venta hoy.',
            filas: d?.ventas?.map((v) => ({
              principal: v.nombre,
              secundario: v.vendedor ?? 'sin vendedor asignado',
              extra: v.plan,
            })),
          },
          {
            clave: 'movimiento',
            valor: porVendedor?.length,
            label: 'vendedores con movimiento',
            vacio: 'Nadie tocó un prospecto hoy.',
            filas: porVendedor?.map((v) => ({
              principal: v.nombre,
              secundario: `${v.gestionados} prospecto${v.gestionados === 1 ? '' : 's'} gestionado${
                v.gestionados === 1 ? '' : 's'
              }`,
              extra: v.ganados ? `${v.ganados} cerrada${v.ganados === 1 ? '' : 's'}` : null,
            })),
          },
          {
            clave: 'expedientes',
            valor: d?.expedientes?.length,
            label: 'expedientes sin completar',
            // Una venta cerrada que no puede convertirse en orden es plata
            // parada, no un pendiente administrativo.
            alerta: (d?.expedientes?.length ?? 0) > 0,
            vacio: 'Todos los expedientes están completos.',
            filas: d?.expedientes?.map((e) => ({
              principal: e.cliente,
              secundario: falta(e),
            })),
          },
        ]}
      />

      <Area
        titulo="Área técnica"
        icon={Wrench}
        color="text-emerald-400"
        borde="border-emerald-500/30"
        a="/clientes/instalaciones"
        enlace="Ver área técnica"
        cargando={!d}
        abierto={abierto}
        onAbrir={alternar}
        partes={[
          {
            clave: 'ordenes',
            valor: d?.ordenes?.length,
            label: 'órdenes hoy',
            vacio: 'No hay órdenes agendadas para hoy.',
            filas: d?.ordenes?.map((o) => ({
              principal: `${o.numero ? `#${o.numero} · ` : ''}${o.cliente ?? o.nombre ?? 'sin nombre'}`,
              secundario: o.tecnico_nombre ?? 'sin técnico asignado',
              extra: o.estado === 'en_curso' ? 'en curso' : (o.hora?.slice(0, 5) ?? null),
            })),
          },
          {
            clave: 'jornadas',
            valor: d?.jornadas?.length,
            label: 'técnicos en campo',
            vacio: 'Nadie abrió jornada hoy.',
            filas: d?.jornadas?.map((j) => ({
              principal: j.tecnico ?? 'sin nombre',
              secundario: j.vehiculo ? `${j.vehiculo}${j.placa ? ` · ${j.placa}` : ''}` : 'sin vehículo',
              extra: j.inicio_at ? `desde ${new Date(j.inicio_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : null,
            })),
          },
          {
            clave: 'criticas',
            valor: d?.criticas?.length,
            label: 'incidencias críticas',
            alerta: (d?.criticas?.length ?? 0) > 0,
            vacio: 'La red está en orden.',
            filas: d?.criticas?.map((n) => ({
              principal: n.nombre,
              secundario: n.clientes_afectados
                ? `${n.clientes_afectados} cliente${n.clientes_afectados === 1 ? '' : 's'} afectado${
                    n.clientes_afectados === 1 ? '' : 's'
                  }`
                : 'sin clientes colgados',
              extra: duracion(n.minutos_asi),
            })),
          },
        ]}
      />
    </div>
  )
}

/** Qué le falta a un expediente. Se nombra lo que falta, no lo que hay. */
function falta(e) {
  const pendientes = [
    !e.ok_datos && 'datos',
    (!e.ok_cedula_frontal || !e.ok_cedula_posterior) && 'cédula',
    !e.ok_fotos && 'fotos',
    !e.ok_ubicacion && 'ubicación',
    !e.ok_plan && 'plan',
    !e.ok_contrato && 'contrato',
    !e.ok_firma && 'firma',
  ].filter(Boolean)
  return pendientes.length ? `falta ${pendientes.join(', ')}` : 'completo'
}

function duracion(minutos) {
  if (minutos == null) return null
  // Un reloj del servidor unos segundos adelantado no puede imprimir "hace -3m".
  if (minutos < 1) return 'recién'
  if (minutos < 60) return `hace ${minutos} min`
  const h = Math.floor(minutos / 60)
  return h < 24 ? `hace ${h}h` : `hace ${Math.floor(h / 24)} días`
}

function Area({ titulo, icon: Icon, color, borde, a, enlace, partes, cargando, abierto, onAbrir }) {
  const parteAbierta = partes.find((p) => p.clave === abierto)

  return (
    <div className={`rounded-xl border bg-slate-900/40 p-4 ${borde}`}>
      <div className="flex items-center gap-2">
        <Icon size={17} className={color} />
        <h2 className="text-sm font-semibold text-slate-100">{titulo}</h2>
        <Link
          to={a}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-slate-500 transition hover:text-slate-200"
        >
          {enlace} <ArrowRight size={13} />
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-x-5 gap-y-2">
        {partes.map((p) => {
          const activo = abierto === p.clave
          return (
            <button
              key={p.clave}
              type="button"
              // Un número que no se pudo leer no se puede abrir: no hay nada
              // detrás y un panel vacío se lee como "no hay", que es distinto.
              disabled={cargando || p.valor == null}
              onClick={() => onAbrir(p.clave)}
              className={`-mx-1 min-w-0 rounded-lg px-1 text-left transition disabled:cursor-default ${
                activo ? 'bg-slate-800/70' : 'hover:bg-slate-800/40'
              }`}
            >
              {cargando ? (
                <Skeleton className="h-7 w-10" />
              ) : (
                <p
                  className={`text-2xl font-semibold ${
                    p.valor == null
                      ? 'text-slate-600'
                      : p.alerta
                        ? 'text-amber-400'
                        : 'text-slate-100'
                  }`}
                >
                  {p.valor ?? '—'}
                </p>
              )}
              <p className="flex items-center gap-1 text-[11px] leading-tight text-slate-500">
                {p.label}
                {p.valor != null && !cargando && (
                  <ChevronDown
                    size={11}
                    className={`transition ${activo ? 'rotate-180 text-slate-300' : 'text-slate-600'}`}
                  />
                )}
              </p>
            </button>
          )
        })}
      </div>

      {parteAbierta && (
        <ul className="mt-3 space-y-1.5 border-t border-slate-800 pt-3">
          {parteAbierta.filas?.length ? (
            parteAbierta.filas.map((f, i) => (
              <li key={i} className="flex items-baseline gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-slate-200">{f.principal}</span>
                <span className="shrink-0 text-[11px] text-slate-500">{f.secundario}</span>
                {f.extra && (
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {f.extra}
                  </span>
                )}
              </li>
            ))
          ) : (
            <li className="text-[12px] text-slate-500">{parteAbierta.vacio}</li>
          )}
        </ul>
      )}
    </div>
  )
}
