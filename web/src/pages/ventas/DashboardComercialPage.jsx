import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  ClipboardList,
  Clock,
  DollarSign,
  Eye,
  FileSignature,
  Flame,
  Lightbulb,
  MessageCircle,
  Phone,
  Plus,
  Target,
  TrendingUp,
  Trophy,
  Wallet,
  Wrench,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button, ErrorBanner, Field, Input, Modal, Aviso } from '../../components/ui'
import ConPermiso from '../../components/layout/ConPermiso'
import BotonTema from '../../components/ventas/BotonTema'
import { usePermisos } from '../../lib/AuthContext'
import { useTemaCampo } from '../../lib/temaCampo'
import { dineroCero as dinero } from '../../lib/formato'
import { enlaceWhatsApp } from '../../lib/telefono'
import { conFirma, prepararWhatsApp } from '../../lib/mensajesComerciales'
import {
  avatar,
  comercialApi,
  logros,
  loQueHayQueHacer,
  paleta,
  proyeccionDelMes,
  saludo,
} from '../../lib/comercial'
import { ESTADOS, ESTADOS_ABIERTOS, ORIGENES, etiquetaEstado } from '../../lib/ventas'
import { loQueFalta } from '../../lib/expedientes'

/**
 * Tablero comercial.
 *
 * ── El orden de lectura ──
 *
 * De arriba abajo se lee como una frase: cómo voy · qué tengo en juego · qué
 * hago ahora · dónde está trabado el embudo · qué me espera esta semana.
 *
 * Las acciones van arriba de los gráficos a propósito. Un tablero que abre con
 * un gráfico obliga a interpretar antes de actuar, y esto se mira entre dos
 * llamadas, no para analizar.
 *
 * ── Todo es dato real ──
 *
 * Ningún número está inventado ni redondeado para que quede lindo. El puntaje
 * viene con sus motivos, la proyección dice explícitamente que es "si seguís
 * así", y la comisión sale del porcentaje que esté configurado — si es cero, la
 * tarjeta lo dice en vez de mostrar un monto que nadie prometió.
 */

const CONSEJOS = [
  'Los mejores vendedores no esperan oportunidades: las crean.',
  'Un prospecto que no se llama en 48 horas ya está hablando con otro.',
  'La objeción del precio casi nunca es sobre el precio.',
  'Cerrá el día dejando agendado el primer llamado de mañana.',
  'Al que dijo que no hace seis meses, hoy quizás le llegue la fibra.',
]

export default function DashboardComercialPage() {
  const { puede, perfil } = usePermisos()
  const { tema, alternar } = useTemaCampo()
  const veElEquipo = puede('ventas.equipo')
  const C = paleta(tema)

  const [datos, setDatos] = useState({
    prospectos: [], seguimientos: [], equipo: [], cobros: [], expedientes: [], racha: 0,
  })
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [editandoMeta, setEditandoMeta] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setDatos(await comercialApi.tablero({ vendedorId: veElEquipo ? null : perfil?.id }))
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [veElEquipo, perfil])

  useEffect(() => {
    recargar()
  }, [recargar])

  const { prospectos, seguimientos, equipo, cobros, expedientes, racha } = datos
  const mio = useMemo(() => equipo.find((e) => e.vendedor_id === perfil?.id) ?? null, [equipo, perfil])

  // ── Los números del mes ──
  const abiertos = useMemo(
    () => prospectos.filter((p) => ESTADOS_ABIERTOS.includes(p.estado)),
    [prospectos],
  )
  const calientes = useMemo(
    () => abiertos.filter((p) => p.puntaje >= 60).sort((a, b) => b.puntaje - a.puntaje),
    [abiertos],
  )
  const enJuego = abiertos.reduce((t, p) => t + Number(p.valor_mensual || 0), 0)

  const altas = Number(mio?.altas_mes ?? 0)
  const monto = Number(mio?.monto_mes ?? 0)
  // La comisión sale del motor desde la migración 102: son las ventas que
  // cumplieron todos los requisitos, con el escalón alcanzado. Ya no es un
  // porcentaje sobre lo que se marcó como ganado.
  const comision = Number(mio?.comision_mes ?? 0)
  const comisionVentas = Number(mio?.comision_ventas ?? 0)
  const comisionPendientes = Number(mio?.comision_pendientes ?? 0)
  const metaAltas = Number(mio?.meta_altas ?? 0)
  const metaMonto = Number(mio?.meta_monto ?? 0)
  const altasPrevio = Number(mio?.altas_mes_pasado ?? 0)
  const montoPrevio = Number(mio?.monto_mes_pasado ?? 0)

  const proy = proyeccionDelMes(altas)
  const acciones = useMemo(
    () => loQueHayQueHacer(prospectos, seguimientos, cobros, expedientes),
    [prospectos, seguimientos, cobros, expedientes],
  )

  const prospectosDelMes = useMemo(() => {
    const m = new Date().getMonth()
    return prospectos.filter((p) => new Date(p.creado_en).getMonth() === m).length
  }, [prospectos])

  // ── El embudo, por temperatura ──
  const porTemperatura = useMemo(() => {
    const b = { Calientes: 0, Tibias: 0, Frías: 0 }
    abiertos.forEach((p) => {
      const v = Number(p.valor_mensual || 0)
      if (p.puntaje >= 60) b.Calientes += v
      else if (p.puntaje >= 35) b.Tibias += v
      else b.Frías += v
    })
    return [
      { nombre: 'Calientes', valor: b.Calientes, color: C.caliente },
      { nombre: 'Tibias', valor: b.Tibias, color: C.etapas[3] },
      { nombre: 'Frías', valor: b.Frías, color: C.etapas[0] },
    ].filter((x) => x.valor > 0)
  }, [abiertos, C])

  const pipeline = useMemo(
    () =>
      ['nuevo', 'contactado', 'cotizado', 'negociacion', 'ganado'].map((e, i) => ({
        clave: e,
        etapa: etiquetaEstado(e).label,
        n: prospectos.filter((p) => p.estado === e).length,
        color: e === 'ganado' ? C.bien : C.etapas[i],
      })),
    [prospectos, C],
  )

  const porOrigen = useMemo(() => {
    const cuenta = {}
    prospectos.forEach((p) => {
      cuenta[p.origen] = (cuenta[p.origen] ?? 0) + 1
    })
    const total = prospectos.length || 1
    return Object.entries(cuenta)
      .map(([k, n], i) => ({
        origen: ORIGENES[k] ?? k,
        n,
        pct: Math.round((n / total) * 100),
        color: C.etapas[i % C.etapas.length],
      }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
  }, [prospectos, C])

  const misLogros = logros({ altas, meta: metaAltas, racha, prospectosDelMes })
  const consejo = CONSEJOS[new Date().getDate() % CONSEJOS.length]

  const seguimientosHoy = seguimientos
    .filter((s) => s.programado_para)
    .sort((a, b) => new Date(a.programado_para) - new Date(b.programado_para))
    .slice(0, 4)

  const contratosPendientes = expedientes.filter((e) => e.ok_contrato && !e.ok_firma)
  const expedientesIncompletos = expedientes.filter((e) => !e.completo)

  if (error) return <ErrorBanner error={error} onCerrar={() => setError(null)} />

  return (
    <div className="campo campo-fondo -m-6 space-y-4 p-4 md:p-6" data-tema={tema}>
      {/* ── Saludo ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="campo-txt text-2xl font-semibold">
            {saludo(perfil?.nombre)} <span className="ml-1">👋</span>
          </h1>
          <p className="campo-suave text-sm">Acá tenés tu resumen comercial de hoy.</p>
        </div>
        <div className="flex items-center gap-2">
          <BotonTema tema={tema} onAlternar={alternar} />
          <ConPermiso permiso="ventas.equipo" envezDe={null}>
            <Button
              onClick={() =>
                setEditandoMeta({ vendedorId: perfil?.id ?? null, meta_altas: metaAltas, meta_monto: metaMonto })
              }
            >
              Fijar meta
            </Button>
          </ConPermiso>
          <Link to="/ventas/prospectos">
            <Button variante="primario" icon={Plus}>
              Nuevo prospecto
            </Button>
          </Link>
        </div>
      </div>

      {/* ── Las cinco métricas ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metrica
          titulo="Ventas del mes"
          valor={altas}
          sufijo={metaAltas > 0 ? `de ${metaAltas}` : null}
          icono={DollarSign}
          color={C.bien}
          delta={variacion(altas, altasPrevio)}
        />
        <Metrica
          titulo="Meta mensual"
          valor={metaAltas || '—'}
          sufijo={metaAltas ? 'instalaciones' : null}
          icono={Target}
          color={C.etapas[0]}
          progreso={metaAltas > 0 ? Math.min(100, Math.round((altas / metaAltas) * 100)) : null}
          nota={metaAltas > 0 ? null : 'Sin fijar'}
        />
        <Metrica
          titulo="Facturación nueva"
          valor={dinero(monto)}
          icono={TrendingUp}
          color={C.etapas[0]}
          delta={variacion(monto, montoPrevio)}
        />
        {/* Enlaza a "Mi comisión": acá va el número, allá el detalle de qué
            venta cuenta, qué le falta a cada una y cuánto falta para el
            escalón siguiente. */}
        <Link to="/ventas/mi-comision" className="block">
          <Metrica
            titulo="Comisión proyectada"
            valor={comision > 0 ? dinero(comision) : '—'}
            icono={Wallet}
            color={C.etapas[5]}
            nota={
              comisionVentas > 0
                ? `${comisionVentas} ${comisionVentas === 1 ? 'venta válida' : 'ventas válidas'}` +
                  (mio?.comision_nivel ? ` · ${mio.comision_nivel} ${mio.comision_nivel_pct} %` : '')
                : comisionPendientes > 0
                  ? `${comisionPendientes} esperando el primer pago`
                  : 'Ninguna venta cumplió los requisitos todavía'
            }
          />
        </Link>
        <Metrica
          titulo="Oportunidades calientes"
          valor={calientes.length}
          icono={Flame}
          color={C.caliente}
          nota={`${dinero(porTemperatura.find((t) => t.nombre === 'Calientes')?.valor ?? 0)} en juego`}
        />
      </div>

      {/* ── Fila 1: a quién llamar · dinero · proyección · mi día ── */}
      <div className="grid gap-3 lg:grid-cols-4">
        <Panel
          titulo="Oportunidades que podés cerrar hoy"
          subtitulo="Ordenadas por puntaje de conversión"
          icono={Target}
          color={C.etapas[0]}
          className="lg:col-span-2"
          pie={{ texto: 'Ver todas las oportunidades', a: '/ventas/prospectos' }}
        >
          {calientes.length === 0 ? (
            <Vacio texto={cargando ? 'Cargando…' : 'Todavía no hay prospectos con puntaje alto.'} />
          ) : (
            <div className="space-y-1.5">
              {calientes.slice(0, 4).map((p) => {
                const av = avatar(p.nombre, tema)
                return (
                  <div
                    key={p.id}
                    className="campo-borde flex items-center gap-3 rounded-lg border p-2"
                  >
                    <Avatar av={av} />
                    <div className="min-w-0 flex-1">
                      <div className="campo-txt truncate text-[13px] font-medium">{p.nombre}</div>
                      <div className="campo-tenue truncate text-[11px]">
                        {p.telefono ?? 'sin teléfono'}
                        {p.plan ? ` · ${p.plan}` : ''}
                      </div>
                    </div>
                    <Puntaje valor={p.puntaje} color={C.bien} />
                    <div className="flex shrink-0 gap-1">
                      <IconoAccion href={p.telefono ? `tel:${p.telefono}` : null} Icono={Phone} />
                      <IconoAccion
                        href={enlaceWhatsApp(p.telefono, saludoInicial(p, perfil))}
                        Icono={MessageCircle}
                        // El registro sale en paralelo, sin esperarlo: una
                        // ventana abierta después de un `await` la bloquea el
                        // navegador como popup.
                        onClick={() =>
                          prepararWhatsApp({
                            telefono: p.telefono,
                            cuerpo: saludoInicial(p, perfil),
                            perfil,
                            prospecto_id: p.id,
                            firmar: false,
                          }).catch(() => {})
                        }
                      />
                      <IconoAccion a={`/ventas/prospectos?p=${p.id}`} Icono={Eye} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Panel>

        <Panel
          titulo="Dinero en juego"
          subtitulo="Valor de tus oportunidades abiertas"
          icono={DollarSign}
          color={C.bien}
        >
          {porTemperatura.length === 0 ? (
            <Vacio texto="Sin oportunidades abiertas." />
          ) : (
            <>
              <div className="relative">
                <ResponsiveContainer width="100%" height={150}>
                  <PieChart>
                    <Pie
                      data={porTemperatura}
                      dataKey="valor"
                      nameKey="nombre"
                      innerRadius={45}
                      outerRadius={68}
                      // 2px de separación entre porciones: sin eso, dos colores
                      // contiguos se leen como uno solo.
                      paddingAngle={2}
                      stroke="none"
                    >
                      {porTemperatura.map((t) => (
                        <Cell key={t.nombre} fill={t.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<Globo formato={dinero} />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="campo-txt text-lg font-semibold">{dinero(enJuego)}</span>
                  <span className="campo-tenue text-[10px]">mensual potencial</span>
                </div>
              </div>
              {/* Leyenda con nombre y monto: el color no comunica solo. */}
              <div className="mt-2 space-y-1">
                {porTemperatura.map((t) => (
                  <div key={t.nombre} className="flex items-center gap-2 text-[12px]">
                    <i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color }} />
                    <span className="campo-suave flex-1">{t.nombre}</span>
                    <span className="campo-txt tabular-nums">{dinero(t.valor)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel titulo="Si seguís este ritmo" subtitulo="No es una promesa: es una regla de tres" icono={TrendingUp} color={C.etapas[2]}>
          <div className="campo-sup campo-borde rounded-xl border p-3 text-center">
            <div className="campo-tenue text-[11px]">Terminarías el mes en</div>
            <div className="campo-txt text-3xl font-semibold">{proy.proyectado}</div>
            <div className="campo-tenue text-[11px]">instalaciones</div>
          </div>
          {metaAltas > 0 && (
            <p className="mt-2 text-center text-[12px] campo-suave">
              {proy.proyectado >= metaAltas ? (
                <span style={{ color: C.bien }}>Vas a alcanzar la meta</span>
              ) : (
                <>
                  Te faltarían{' '}
                  <b className="campo-txt">{metaAltas - proy.proyectado}</b> ventas
                </>
              )}
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-center">
            <div>
              <div className="campo-txt text-lg font-semibold tabular-nums">
                {proy.ritmo.toFixed(2)}
              </div>
              <div className="campo-tenue text-[10px]">ventas por día</div>
            </div>
            <div>
              <div className="campo-txt text-lg font-semibold tabular-nums">{proy.restantes}</div>
              <div className="campo-tenue text-[10px]">días restantes</div>
            </div>
          </div>
        </Panel>

        <Panel
          titulo="Mi día"
          icono={CalendarListo}
          color={C.alerta}
          insignia={acciones.filter((a) => a.urgencia === 0).length || null}
          pie={{ texto: 'Ver todo lo pendiente', a: '/ventas/prospectos' }}
        >
          <div className="space-y-1">
            <Renglon icono={Clock} texto="Seguimientos para hoy" n={seguimientos.filter((s) => esHoy(s.programado_para)).length} color={C.etapas[0]} />
            <Renglon icono={AlertTriangle} texto="Seguimientos vencidos" n={seguimientos.filter((s) => vencido(s.programado_para)).length} color={C.critico} />
            <Renglon icono={Wallet} texto="Cobros por gestionar" n={cobros.length} color={C.alerta} a="/ventas/cobranza" />
            <Renglon icono={FileSignature} texto="Contratos pendientes de firma" n={contratosPendientes.length} color={C.etapas[5]} />
            <Renglon icono={ClipboardList} texto="Expedientes incompletos" n={expedientesIncompletos.length} color={C.etapas[1]} />
            <Renglon icono={Wrench} texto="Instalaciones en proceso" n={expedientes.filter((e) => e.estado === 'enviado').length} color={C.etapas[2]} />
            <Renglon icono={CalendarClock} texto="Promesas de pago para hoy" n={cobros.filter((c) => esHoy(c.promesa_fecha)).length} color={C.caliente} />
          </div>
        </Panel>
      </div>

      {/* ── Fila 2: embudo · origen · ranking ── */}
      <div className="grid gap-3 lg:grid-cols-4">
        <Panel
          titulo="Pipeline comercial"
          subtitulo="Tus oportunidades por etapa"
          icono={Target}
          color={C.etapas[0]}
          className="lg:col-span-2"
          pie={{ texto: 'Ver el embudo completo', a: '/ventas/prospectos' }}
        >
          <div className="grid grid-cols-5 gap-1.5">
            {pipeline.map((e) => (
              <Link
                key={e.clave}
                to={`/ventas/prospectos`}
                className="rounded-lg border p-2 text-center transition hover:opacity-80"
                style={{ borderColor: `${e.color}55`, background: `${e.color}18` }}
              >
                <div className="campo-txt text-xl font-semibold tabular-nums">{e.n}</div>
                <div className="campo-suave truncate text-[10px]">{e.etapa}</div>
              </Link>
            ))}
          </div>
          <p className="campo-tenue mt-2 text-[11px]">
            Total {prospectos.length} prospectos · {abiertos.length} abiertos
          </p>
        </Panel>

        <Panel titulo="De dónde llegan" subtitulo="Origen de tus prospectos" icono={TrendingUp} color={C.etapas[1]}>
          {porOrigen.length === 0 ? (
            <Vacio texto="Sin prospectos cargados." />
          ) : (
            <div className="space-y-2">
              {porOrigen.map((o) => (
                <div key={o.origen}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-[12px]">
                    <span className="campo-suave truncate">{o.origen}</span>
                    <span className="campo-txt shrink-0 tabular-nums">
                      {o.pct}% ({o.n})
                    </span>
                  </div>
                  <div className="campo-sup h-1.5 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${o.pct}%`, background: o.color }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <ConPermiso
          permiso="ventas.equipo"
          envezDe={
            <Panel titulo="Mis logros" icono={Trophy} color={C.alerta}>
              <Logros items={misLogros} />
            </Panel>
          }
        >
          <Panel titulo="Ranking del equipo" subtitulo="Ventas de este mes" icono={Trophy} color={C.alerta}>
            {equipo.length === 0 ? (
              <Vacio texto="Sin vendedores cargados." />
            ) : (
              <div className="space-y-1.5">
                {[...equipo]
                  .sort((a, b) => b.altas_mes - a.altas_mes)
                  .slice(0, 5)
                  .map((v, i) => {
                    const av = avatar(v.vendedor, tema)
                    return (
                      <div key={v.vendedor_id} className="flex items-center gap-2">
                        <span className="campo-tenue w-4 text-center text-[12px] tabular-nums">
                          {i + 1}
                        </span>
                        <Avatar av={av} chico />
                        <span className="campo-txt min-w-0 flex-1 truncate text-[13px]">
                          {v.vendedor}
                        </span>
                        <span className="campo-suave shrink-0 text-[12px] tabular-nums">
                          {v.altas_mes} {v.altas_mes === 1 ? 'venta' : 'ventas'}
                        </span>
                      </div>
                    )
                  })}
              </div>
            )}
          </Panel>
        </ConPermiso>
      </div>

      {/* ── Fila 3: las cuatro listas del día ── */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel titulo="Próximos seguimientos" icono={CalendarClock} color={C.etapas[0]} pie={{ texto: 'Ver la agenda', a: '/ventas/prospectos' }}>
          {seguimientosHoy.length === 0 ? (
            <Vacio texto="Nada agendado." />
          ) : (
            seguimientosHoy.map((s) => (
              <div key={s.id} className="flex gap-2 py-1.5">
                <span className="campo-tenue shrink-0 text-[12px] tabular-nums">
                  {new Date(s.programado_para).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <div className="min-w-0">
                  <div className="campo-txt truncate text-[13px]">{s.prospecto}</div>
                  <div className="campo-tenue truncate text-[11px]">{s.proxima_accion ?? s.tipo}</div>
                </div>
              </div>
            ))
          )}
        </Panel>

        <Panel titulo="Cobros por gestionar" icono={Wallet} color={C.alerta} pie={{ texto: 'Ver todos los cobros', a: '/ventas/cobranza' }}>
          {cobros.length === 0 ? (
            <Vacio texto="Sin cobros asignados." />
          ) : (
            cobros.slice(0, 4).map((c) => (
              <div key={c.asignacion_id} className="flex items-center gap-2 py-1.5">
                <Avatar av={avatar(c.cliente, tema)} chico />
                <div className="min-w-0 flex-1">
                  <div className="campo-txt truncate text-[13px]">{c.cliente}</div>
                  <div className="text-[11px]" style={{ color: c.dias_atraso >= 15 ? C.critico : undefined }}>
                    <span className={c.dias_atraso >= 15 ? '' : 'campo-tenue'}>
                      {c.dias_atraso} días de atraso
                    </span>
                  </div>
                </div>
                <IconoAccion href={c.telefono ? `tel:${c.telefono}` : null} Icono={Phone} />
              </div>
            ))
          )}
        </Panel>

        <Panel titulo="Contratos pendientes" icono={FileSignature} color={C.etapas[5]}>
          {contratosPendientes.length === 0 ? (
            <Vacio texto="Ninguno esperando firma." />
          ) : (
            contratosPendientes.slice(0, 4).map((e) => (
              <Link key={e.id} to={`/ventas/expediente/${e.id}`} className="flex items-center justify-between gap-2 py-1.5">
                <span className="campo-txt min-w-0 truncate text-[13px]">{e.cliente}</span>
                <span className="shrink-0 text-[11px]" style={{ color: C.alerta }}>
                  Pendiente de firma
                </span>
              </Link>
            ))
          )}
        </Panel>

        <Panel titulo="Expedientes incompletos" icono={ClipboardList} color={C.etapas[1]}>
          {expedientesIncompletos.length === 0 ? (
            <Vacio texto="Todos completos." />
          ) : (
            expedientesIncompletos.slice(0, 4).map((e) => (
              <Link key={e.id} to={`/ventas/expediente/${e.id}`} className="block py-1.5">
                <div className="campo-txt truncate text-[13px]">{e.cliente}</div>
                <div className="campo-tenue truncate text-[11px]">
                  Falta: {loQueFalta(e).slice(0, 2).join(', ')}
                </div>
              </Link>
            ))
          )}
        </Panel>
      </div>

      {/* ── Pie: consejo y racha ── */}
      <div className="campo-sup campo-borde flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
        <div className="flex items-start gap-2">
          <Lightbulb size={18} style={{ color: C.alerta }} className="mt-0.5 shrink-0" />
          <div>
            <div className="campo-txt text-[13px] font-medium">Consejo del día</div>
            <p className="campo-suave text-[12px]">{consejo}</p>
          </div>
        </div>
        {racha > 0 && (
          <div className="flex items-center gap-2 text-[13px]" style={{ color: C.caliente }}>
            <Flame size={18} />
            <span>
              {racha} {racha === 1 ? 'día' : 'días'} seguidos vendiendo
            </span>
          </div>
        )}
      </div>

      <Modal
        abierto={!!editandoMeta}
        titulo="Meta de este mes"
        onCerrar={() => setEditandoMeta(null)}
      >
        {editandoMeta && (
          <div className="space-y-3">
            <Aviso>
              Sin meta, el tablero no puede responder "cuánto me falta" ni proyectar el cierre del
              mes.
            </Aviso>
            <Field label="Altas (clientes nuevos)">
              <Input
                type="number"
                value={editandoMeta.meta_altas}
                onChange={(e) => setEditandoMeta({ ...editandoMeta, meta_altas: e.target.value })}
              />
            </Field>
            <Field label="Monto (mensualidad sumada)">
              <Input
                type="number"
                step="0.01"
                value={editandoMeta.meta_monto}
                onChange={(e) => setEditandoMeta({ ...editandoMeta, meta_monto: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setEditandoMeta(null)}>
                Cancelar
              </Button>
              <Button
                onClick={async () => {
                  try {
                    await comercialApi.guardarMeta(editandoMeta)
                    setEditandoMeta(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Guardar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Las piezas
// ---------------------------------------------------------------------------

/**
 * Tarjeta de métrica.
 *
 * El ícono va en una pastilla del color de la métrica y no suelto: es lo que
 * permite distinguir cinco tarjetas de un vistazo sin leer los títulos. El color
 * nunca comunica solo — el título siempre está.
 */
function Metrica({ titulo, valor, sufijo, icono: Icono, color, delta, progreso, nota }) {
  return (
    <div className="campo-sup campo-borde rounded-xl border p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="campo-suave text-[12px]">{titulo}</span>
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
          style={{ background: `${color}22`, color }}
        >
          <Icono size={18} />
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="campo-txt text-2xl font-semibold tabular-nums">{valor}</span>
        {sufijo && <span className="campo-tenue text-[12px]">{sufijo}</span>}
      </div>

      {progreso != null && (
        <div className="campo-fondo mt-2 h-1.5 overflow-hidden rounded-full">
          <div className="h-full rounded-full" style={{ width: `${progreso}%`, background: color }} />
        </div>
      )}
      {progreso != null && <p className="campo-tenue mt-1 text-[11px]">{progreso}% completado</p>}

      {delta && (
        <p className="mt-1 text-[11px]" style={{ color: delta.sube ? '#0ca30c' : '#d03b3b' }}>
          {delta.sube ? '▲' : '▼'} {delta.texto} vs mes pasado
        </p>
      )}
      {nota && <p className="campo-tenue mt-1 text-[11px]">{nota}</p>}
    </div>
  )
}

function Panel({ titulo, subtitulo, icono: Icono, color, insignia, children, className = '', pie }) {
  return (
    <section className={`campo-sup campo-borde flex flex-col rounded-xl border p-3 ${className}`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          {Icono && <Icono size={16} style={{ color }} className="mt-0.5 shrink-0" />}
          <div>
            <h2 className="campo-txt text-[13px] font-semibold">{titulo}</h2>
            {subtitulo && <p className="campo-tenue text-[11px]">{subtitulo}</p>}
          </div>
        </div>
        {insignia != null && (
          <span
            className="grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold text-white"
            style={{ background: '#d03b3b' }}
          >
            {insignia}
          </span>
        )}
      </div>

      <div className="flex-1">{children}</div>

      {pie && (
        <Link
          to={pie.a}
          className="mt-2 flex items-center gap-1 text-[12px] transition hover:gap-2"
          style={{ color: '#3987e5' }}
        >
          {pie.texto} <ArrowRight size={13} />
        </Link>
      )}
    </section>
  )
}

const Avatar = ({ av, chico }) => (
  <span
    className={`grid shrink-0 place-items-center rounded-full font-semibold text-white ${
      chico ? 'h-7 w-7 text-[10px]' : 'h-9 w-9 text-[12px]'
    }`}
    style={{ background: av.color }}
  >
    {av.iniciales}
  </span>
)

/** El puntaje, en una pastilla. El número va escrito: el color solo lo refuerza. */
const Puntaje = ({ valor, color }) => (
  <span
    className="grid h-8 w-8 shrink-0 place-items-center rounded-full border text-[12px] font-semibold tabular-nums"
    style={{ borderColor: color, color }}
  >
    {valor}
  </span>
)

const IconoAccion = ({ href, a, Icono, onClick }) => {
  const clase =
    'campo-borde grid h-8 w-8 place-items-center rounded-lg border campo-suave transition hover:campo-txt'
  if (a) return <Link to={a} className={clase}><Icono size={14} /></Link>
  return (
    <a
      href={href ?? undefined}
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel="noreferrer"
      onClick={onClick}
      className={`${clase} ${href ? '' : 'pointer-events-none opacity-30'}`}
    >
      <Icono size={14} />
    </a>
  )
}

const Renglon = ({ icono: Icono, texto, n, color, a }) => {
  const cuerpo = (
    <div className="flex items-center gap-2 py-1">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded" style={{ background: `${color}22`, color }}>
        <Icono size={13} />
      </span>
      <span className="campo-suave min-w-0 flex-1 truncate text-[12px]">{texto}</span>
      <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${n > 0 ? 'campo-txt' : 'campo-tenue'}`}>
        {n}
      </span>
    </div>
  )
  return a ? <Link to={a}>{cuerpo}</Link> : cuerpo
}

const Logros = ({ items }) => (
  <div className="grid grid-cols-2 gap-2">
    {items.map((l) => (
      <div
        key={l.clave}
        className="rounded-lg border p-2 text-center"
        style={{
          borderColor: l.logrado ? `${l.color}66` : 'transparent',
          background: l.logrado ? `${l.color}18` : 'transparent',
          opacity: l.logrado ? 1 : 0.45,
        }}
        title={l.ayuda}
      >
        <Trophy size={18} style={{ color: l.color }} className="mx-auto" />
        <div className="campo-txt mt-1 truncate text-[11px] font-medium">{l.nombre}</div>
        <div className="campo-tenue truncate text-[10px]">{l.ayuda}</div>
      </div>
    ))}
  </div>
)

const Vacio = ({ texto }) => (
  <p className="campo-tenue py-6 text-center text-[12px]">{texto}</p>
)

function Globo({ active, payload, formato = (v) => v }) {
  if (!active || !payload?.length) return null
  return (
    <div className="t-card-sm px-2.5 py-1.5 text-[12px] text-slate-100 shadow-lg">
      {payload[0].name}: {formato(payload[0].value)}
    </div>
  )
}

// ── Ayudas ──
const CalendarListo = CalendarClock

const esHoy = (f) => !!f && new Date(f).toDateString() === new Date().toDateString()
const vencido = (f) => !!f && new Date(f) < new Date() && !esHoy(f)

/**
 * La variación contra el mes pasado.
 *
 * Sin base no se muestra nada. "+100%" partiendo de cero es cierto y no dice
 * nada, y "—%" hace dudar de todo el tablero.
 */
function variacion(actual, previo) {
  if (!previo) return null
  const pct = Math.round(((actual - previo) / previo) * 100)
  if (pct === 0) return null
  return { sube: pct > 0, texto: `${Math.abs(pct)}%` }
}

/**
 * El primer mensaje a un prospecto del tablero.
 *
 * Antes abría el chat en blanco. Eso deja al vendedor escribiendo el saludo de
 * cero cincuenta veces por día, y —lo que importa más— el sistema no se entera
 * de que hubo contacto: el prospecto sigue figurando como "sin tocar" aunque se
 * le haya escrito tres veces.
 *
 * Ahora lleva un saludo corto y firmado. Corto a propósito: es el primer
 * contacto, no la cotización. Mandarle el precio a alguien que todavía no dijo
 * qué necesita es cómo se pierde la conversación en el primer mensaje.
 */
function saludoInicial(p, perfil) {
  const nombre = String(p.nombre ?? '').split(' ')[0]
  return conFirma(
    `Hola${nombre ? ` ${nombre}` : ''}, ¿cómo está? Le escribo por la consulta de internet que nos dejó. ¿Le queda cómodo que le cuente las opciones por acá?`,
    perfil,
  )
}
