import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, KeyRound, LineChart, ListChecks, PackagePlus, Search, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { dbm, nivel } from '../../lib/optica'
import { hace } from '../../lib/olts'
import HistorialOptico from './HistorialOptico'
import { Aviso, Badge, Button, Card, ErrorBanner, SkeletonTabla, Table } from '../ui'

/**
 * Lo que hay detrás de cada tarjeta del tablero.
 *
 * Cada número de arriba es una pregunta a medio hacer: "19 con señal baja" no
 * sirve hasta saber cuáles y de qué abonado son. Esto lo completa.
 *
 * La consulta se arma según la tarjeta y se pide recién al abrirla: cargar las
 * cuatro listas de entrada sería traer casi todas las ONUs para mostrar una.
 */

const CONSULTAS = {
  online: {
    titulo: 'ONTs en línea',
    ayuda: 'Con servicio en este momento, según la última lectura del equipo.',
    filtrar: (q) => q.eq('onu_estado', 'online'),
    orden: { columna: 'rx_power_dbm', asc: true },
  },
  caidas: {
    titulo: 'ONTs caídas',
    ayuda:
      'Sin servicio. La causa —sin luz, corte de fibra, apagada— solo se sabe leyendo la óptica de cada una por la CLI; el inventario por SNMP no la trae.',
    filtrar: (q) => q.neq('onu_estado', 'online'),
    orden: { columna: 'slot', asc: true },
  },
  senal: {
    titulo: 'ONTs con señal baja',
    ayuda:
      'Por debajo de −24 dBm. Si varias son del mismo puerto, el problema es la fibra o el módulo óptico y no los equipos de los abonados.',
    filtrar: (q) => q.lt('rx_power_dbm', -24),
    orden: { columna: 'rx_power_dbm', asc: true },
    // El número de hoy no dice si esto viene bajando, y esa es la diferencia
    // entre una visita programada y una urgencia de madrugada.
    conTendencia: true,
    siVacio: true,
  },
}

function Lista({ tipo }) {
  const def = CONSULTAS[tipo]
  const [filas, setFilas] = useState(null)
  const [error, setError] = useState(null)
  const [tendencias, setTendencias] = useState(new Map())
  const [abierta, setAbierta] = useState(null)
  const [sinAlertas, setSinAlertas] = useState(false)

  const cargar = useCallback(async () => {
    let q = supabase.from('v_onus_clientes').select('*')
    q = def.filtrar(q)
    const { data, error: err } = await q
      .order(def.orden.columna, { ascending: def.orden.asc })
      .limit(300)

    if (err) return setError(err)

    let filas = data ?? []

    // Ninguna bajo el umbral es una buena noticia, pero una tarjeta vacía no
    // sirve para nada. Se muestran igual las peores: son las que hay que
    // vigilar, y con la tendencia al lado se ve cuál se está yendo.
    if (!filas.length && def.siVacio) {
      const { data: peores } = await supabase
        .from('v_onus_clientes')
        .select('*')
        .not('rx_power_dbm', 'is', null)
        .order('rx_power_dbm', { ascending: true })
        .limit(15)
      filas = peores ?? []
      setSinAlertas(true)
    }

    setFilas(filas)
    const data2 = filas

    // La tendencia se pide en UNA consulta para toda la lista, no una por fila:
    // con trescientas ONTs serían trescientas idas y vueltas.
    if (def.conTendencia && data2.length) {
      const { data: t } = await supabase
        .from('v_onu_optica_tendencia')
        .select('onu_id, delta_db, tendencia, muestras')
        .in(
          'onu_id',
          data2.map((d) => d.onu_id),
        )
      if (t) setTendencias(new Map(t.map((x) => [x.onu_id, x])))
    }
  }, [def])

  useEffect(() => {
    cargar()
  }, [cargar])

  if (error) return <ErrorBanner error={error} />
  if (!filas) return <SkeletonTabla filas={5} columnas={5} />

  // Cuántas por puerto: es lo que delata una causa común.
  const porPuerto = new Map()
  for (const f of filas) {
    const k = `${f.olt} · ${f.slot}/${f.puerto}`
    porPuerto.set(k, (porPuerto.get(k) ?? 0) + 1)
  }
  const concentradas = [...porPuerto.entries()].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1])

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-slate-500">{def.ayuda}</p>

      {sinAlertas && (
        <Aviso>
          <b>Ninguna ONT por debajo de −24 dBm.</b> Se muestran las de peor señal igual: son las
          que conviene mirar de vez en cuando. La columna de tendencia dice si alguna viene
          bajando, que es lo que avisa antes de que corte.
        </Aviso>
      )}

      {concentradas.length > 0 && (
        <Aviso tipo="alerta">
          Se concentran en pocos puertos:{' '}
          {concentradas
            .slice(0, 4)
            .map(([k, n]) => `${k} (${n})`)
            .join(' · ')}
          . Eso apunta a una causa común, no a {filas.length} problemas distintos.
        </Aviso>
      )}

      <Table
        columnas={
          def.conTendencia
            ? ['OLT', 'Ubicación', 'Serie', 'Abonado', 'Señal', 'Tendencia', '']
            : ['OLT', 'Ubicación', 'Serie', 'Abonado', 'Señal', 'Estado']
        }
        filas={filas}
        vacio="Ninguna."
        renderFila={(o) => {
          const n = nivel(o.rx_power_dbm)
          const t = tendencias.get(o.onu_id)
          const esta = abierta === o.onu_id

          return [
            <tr key={o.onu_id} className={`text-slate-300 ${esta ? 'bg-slate-800/40' : ''}`}>
              <td className="px-3 py-2 text-xs text-slate-400">{o.olt}</td>
              <td className="px-3 py-2 font-mono text-xs text-slate-500">
                {o.slot}/{o.puerto}/{o.onu_index}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{o.sn}</td>
              <td className="px-3 py-2 text-sm">
                {o.client_id ? (
                  <Link to={`/clientes/${o.client_id}`} className="text-slate-100 hover:text-sky-300">
                    {o.cliente}
                  </Link>
                ) : (
                  <span className="text-slate-400">
                    {o.nombre_en_la_olt ?? '—'} <Badge color="azul">sin ficha</Badge>
                  </span>
                )}
              </td>
              <td className={`px-3 py-2 text-xs ${n.punto === 'bg-rose-500' ? 'text-rose-300' : ''}`}>
                {dbm(o.rx_power_dbm)}
              </td>

              {def.conTendencia ? (
                <>
                  <td className="px-3 py-2 text-xs">
                    {!t || t.tendencia === 'sin_datos' ? (
                      <span className="text-slate-600">sin datos</span>
                    ) : (
                      <span
                        className={
                          t.tendencia === 'empeorando'
                            ? 'text-rose-300'
                            : t.tendencia === 'mejorando'
                              ? 'text-emerald-300'
                              : 'text-slate-400'
                        }
                        title={`${t.muestras} lecturas`}
                      >
                        {t.delta_db > 0 ? '+' : ''}
                        {Number(t.delta_db).toFixed(1)} dB
                        {t.tendencia === 'empeorando' && ' ↓'}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setAbierta(esta ? null : o.onu_id)}
                      className="flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300"
                    >
                      <LineChart size={13} />
                      {esta ? 'ocultar' : 'historial'}
                    </button>
                  </td>
                </>
              ) : (
                <td className="px-3 py-2">
                  <Badge color={o.onu_estado === 'online' ? 'verde' : 'gris'}>{o.onu_estado}</Badge>
                </td>
              )}
            </tr>,

            esta && (
              <tr key={`${o.onu_id}-historial`}>
                <td colSpan={7} className="bg-[#F6F8FB] px-3 py-3">
                  <HistorialOptico
                    onuId={o.onu_id}
                    nombre={o.cliente ?? o.nombre_en_la_olt ?? o.sn}
                  />
                </td>
              </tr>
            ),
          ]
        }}
      />

      {filas.length === 300 && (
        <p className="text-[11px] text-slate-600">
          Se muestran las primeras 300. Usá los filtros de la pestaña ONUs de cada OLT para el
          listado completo.
        </p>
      )}
    </div>
  )
}

function Esperando({ esperando, onBuscar, buscando, onAutorizar, onVer, onPlantillas, onCargarOnu }) {
  if (!esperando?.olts?.length) {
    return (
      <div className="space-y-3">
        <Aviso>
          Estas ONTs están conectadas a la fibra pero nadie las autorizó todavía: el equipo las ve
          y no les da servicio. El barrido corre solo cada pocos minutos; acá se muestra lo último
          que encontró.
        </Aviso>
        <Button variante="primario" icon={Search} onClick={onBuscar} cargando={buscando}>
          Escanear ahora
        </Button>
      </div>
    )
  }

  // Agrupado por OLT: es como se recorre una planta en la realidad, y deja ver
  // de un vistazo cuáles se consultaron bien y cuáles no.
  const porOlt = new Map()
  for (const o of esperando.olts ?? []) porOlt.set(o.olt_id, { ...o, onts: [] })
  for (const o of esperando.onts) {
    if (porOlt.has(o.olt_id)) porOlt.get(o.olt_id).onts.push(o)
  }
  const grupos = [...porOlt.values()]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs leading-relaxed text-slate-500">
          SNMP dice en qué puertos hay candidatas y la CLI confirma solo esos: el registro del
          equipo conserva ONTs que ya salieron de la cola, así que sin confirmar mostraría equipos
          que no están.
        </p>
        <Button icon={Search} onClick={onBuscar} cargando={buscando}>
          Escanear ahora
        </Button>
      </div>

      {grupos.map((g) => (
        <div key={g.olt_id} className="rounded-lg border border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
            <span className="flex items-center gap-2">
              <Link to={`/olts/${g.olt_id}`} className="text-sm text-slate-100 hover:text-sky-300">
                {g.numero ? `${g.numero} · ` : ''}
                {g.olt}
              </Link>
              {!g.tiene_snmp ? (
                <Badge color="gris">sin SNMP</Badge>
              ) : g.error ? (
                <Badge color="rojo">no se pudo consultar</Badge>
              ) : g.onts.length ? (
                <Badge color="azul">
                  {g.onts.length} esperando
                </Badge>
              ) : (
                <Badge color="verde">sin ONTs nuevas</Badge>
              )}
            </span>
            <span className="text-[11px] text-slate-600">
              {!g.tiene_snmp
                ? 'sin comunidad SNMP cargada'
                : g.error
                  ? g.error
                  : g.at
                    ? `escaneada ${hace(g.hace)} · ${g.puertos ?? 0} puertos${g.descartadas ? ` · ${g.descartadas} descartadas` : ''} · ${((g.ms ?? 0) / 1000).toFixed(1)} s`
                    : 'nunca escaneada'}
            </span>
          </div>

          {g.onts.length > 0 && (
            <Table
              columnas={['Ubicación', 'Serie', 'Modelo', 'Detectada', '']}
              filas={g.onts}
              renderFila={(o, i) => (
                <tr key={`${o.sn}-${i}`} className="text-slate-300">
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">
                    placa {o.slot} · puerto {o.puerto}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-100">{o.sn}</td>
                  <td className="px-3 py-2 text-xs">{o.modelo ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {o.detectada
                      ? new Date(o.detectada).toLocaleString('es-EC')
                      : 'no informada'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variante="fantasma"
                        icon={Eye}
                        onClick={() => onVer?.({ ...o, olt_id: g.olt_id, olt: g.olt })}
                      >
                        Ver ONU
                      </Button>
                      <Button
                        variante="exito"
                        icon={KeyRound}
                        onClick={() => onAutorizar?.({ ...o, olt_id: g.olt_id, olt: g.olt })}
                      >
                        Autorizar
                      </Button>
                    </div>
                  </td>
                </tr>
              )}
            />
          )}
        </div>
      ))}

      {esperando.onts.length > 0 && (
        <p className="text-[11px] text-slate-500">
          Se autorizan desde la OLT correspondiente, en su pestaña de ONUs.
        </p>
      )}

      {/* Lo mismo que ofrece SmartOLT debajo de la lista, y por el mismo motivo:
          son las dos cosas que uno quiere hacer justo después de mirar la cola. */}
      <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-3">
        <Button icon={ListChecks} onClick={onPlantillas}>
          Plantillas de autorización
        </Button>
        <Button variante="exito" icon={PackagePlus} onClick={onCargarOnu}>
          Cargar ONU para autorizar después
        </Button>
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        Cargando la serie antes de instalar, el técnico conecta y la ONT entra sola en el barrido
        siguiente: no hace falta que nadie esté mirando la pantalla en ese momento.
      </p>
    </div>
  )
}

export default function DetalleTarjeta({
  tipo,
  esperando,
  onCerrar,
  onBuscar,
  buscando,
  onAutorizar,
  onVer,
  onPlantillas,
  onCargarOnu,
}) {
  const titulo = tipo === 'esperando' ? 'Esperando autorización' : CONSULTAS[tipo]?.titulo

  return (
    <Card
      title={titulo}
      actions={
        <Button variante="fantasma" icon={X} onClick={onCerrar}>
          Cerrar
        </Button>
      }
    >
      {tipo === 'esperando' ? (
        <Esperando
          esperando={esperando}
          onBuscar={onBuscar}
          buscando={buscando}
          onAutorizar={onAutorizar}
          onVer={onVer}
          onPlantillas={onPlantillas}
          onCargarOnu={onCargarOnu}
        />
      ) : (
        <Lista tipo={tipo} />
      )}
    </Card>
  )
}
