import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Boxes,
  Cable,
  Cpu,
  FileCode2,
  Gauge,
  Network,
  RefreshCw,
  RotateCw,
  Router,
  Send,
  Settings2,
  Signal,
  Undo2,
  User,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { dbm, nivel } from '../../lib/optica'
import { hace } from '../../lib/olts'
import AccionesOnu from '../../components/olt/AccionesOnu'
import GestionRemotaOnu from '../../components/olt/GestionRemotaOnu'
import ModoWanOnu from '../../components/olt/ModoWanOnu'
import HistorialOptico from '../../components/olt/HistorialOptico'
import TraficoVivo from '../../components/olt/TraficoVivo'
import PuertosOnt from '../../components/olt/PuertosOnt'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Modal,
  Table,
} from '../../components/ui'

/**
 * La ficha de una ONU.
 *
 * Está dividida en dos a propósito: lo que tenemos guardado y lo que dice el
 * equipo ahora. Mezclarlos en un solo bloque haría imposible la pregunta que
 * importa cuando algo no cuadra —¿esto lo tiene configurado el equipo, o es lo
 * que nosotros creemos que tiene?— y esa diferencia es justamente la que
 * aparece cuando alguien cambió algo por la CLI.
 *
 * Lo del equipo se lee en vivo y puede fallar: la ONT está apagada, no hay
 * sesión libre. Eso no tumba la pantalla, se muestra lo guardado con el motivo.
 */
export default function OnuDetallePage() {
  const confirmar = useConfirmar()
  const { id } = useParams()
  const [fila, setFila] = useState(null)
  // Las características del modelo, con su foto. Se resuelven por el texto que
  // reportó el equipo: el vínculo explícito casi nunca está puesto.
  const [tipo, setTipo] = useState(null)
  // Si la primera carga terminó. Sin esto no hay forma de distinguir "todavía no
  // llegó" de "ya no existe", y una ONU recién dada de baja dejaba la pantalla
  // diciendo "Cargando…" para siempre.
  const [cargado, setCargado] = useState(false)
  const [dadaDeBaja, setDadaDeBaja] = useState(null)
  const [ficha, setFicha] = useState(null)
  const [error, setError] = useState(null)
  const [leyendo, setLeyendo] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [trabajando, setTrabajando] = useState(null)
  const [acciones, setAcciones] = useState(false)
  const [planes, setPlanes] = useState([])
  const [configActiva, setConfigActiva] = useState(null)
  const [software, setSoftware] = useState(null)
  const [tr069, setTr069] = useState(null)
  const [gestion, setGestion] = useState(false)
  const [modoWan, setModoWan] = useState(false)
  const [wan, setWan] = useState(null)

  const cargarBase = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_onus_clientes')
      .select('*')
      .eq('onu_id', id)
      .maybeSingle()
    setCargado(true)
    if (err) return setError(err)

    /**
     * Lo óptico que la vista no trae, leído de la tabla.
     *
     * `v_onus_clientes` enumera sus columnas una por una, así que agregar una a
     * `onus` NO la agrega a la vista: la migración corre, el middleware la
     * escribe, y la pantalla sigue leyendo `undefined`. Ya nos pasó con la
     * aceptación del anexo 2 en el contrato.
     *
     * Se lee de la tabla en vez de rehacer la vista —que además une con
     * clientes— porque es una consulta más contra tres campos, y recrear una
     * vista de casi cincuenta columnas para sumar dos es mucho más riesgoso.
     */
    const { data: extra } = await supabase
      .from('onus')
      .select('olt_rx_power_dbm, temperatura_c, distancia_m')
      .eq('id', id)
      .maybeSingle()

    setFila(extra ? { ...data, ...extra } : data)

    // Falla en silencio: no saber el modelo no tiene por qué romper la ficha.
    supabase
      .from('v_onu_tipo')
      .select('*')
      .eq('onu_id', id)
      .maybeSingle()
      .then(({ data: t }) => setTipo(t?.tipo_id ? t : null))
  }, [id])

  useEffect(() => {
    cargarBase()
    supabase
      .from('planes_velocidad')
      .select('*')
      .order('bajada_kbps')
      .then(({ data }) => setPlanes(data ?? []))
  }, [cargarBase])

  /** Preguntarle al equipo cuesta una sesión SSH, así que va con su botón. */
  async function preguntarAlEquipo() {
    if (!fila) return
    setLeyendo(true)
    setError(null)
    try {
      setFicha(await api.olt.fichaOnu(fila.olt_id, id))
    } catch (err) {
      setError(err)
    } finally {
      setLeyendo(false)
    }
  }

  async function correr(clave, fn) {
    setTrabajando(clave)
    setError(null)
    setResultado(null)
    try {
      setResultado(await fn())
      await cargarBase()
    } catch (err) {
      setError(err)
    } finally {
      setTrabajando(null)
    }
  }

  if (!fila) {
    if (error) return <ErrorBanner error={error} />
    if (!cargado) return <Cargando texto="Cargando la ONU…" />

    // La ficha ya no existe. El caso normal es que se acabe de dar de baja: se
    // muestra el resultado en vez de dejar la pantalla girando.
    return (
      <div className="space-y-4">
        <Link to="/olt/onus" className="inline-flex items-center gap-1 text-sm text-slate-400">
          <ArrowLeft size={15} /> Volver a las ONUs
        </Link>
        <Card>
          <div className="space-y-2 p-4">
            <p className="text-sm font-semibold text-slate-100">
              {dadaDeBaja ? 'La ONU se dio de baja' : 'Esta ONU ya no existe'}
            </p>
            {dadaDeBaja ? (
              <>
                <p className="text-xs text-slate-400">
                  {dadaDeBaja.sn} · {dadaDeBaja.donde}
                  {dadaDeBaja.nombre ? ` · ${dadaDeBaja.nombre}` : ''}
                </p>
                {dadaDeBaja.service_ports_borrados?.length > 0 && (
                  <p className="text-xs text-slate-500">
                    Se borraron {dadaDeBaja.service_ports_borrados.length} service-ports:{' '}
                    {dadaDeBaja.service_ports_borrados.join(', ')}
                  </p>
                )}
                <p className="text-xs text-slate-400">{dadaDeBaja.aviso}</p>
              </>
            ) : (
              <p className="text-xs text-slate-400">
                La borró alguien más, o el enlace es viejo. La ficha del abonado, si la tenía, sigue
                existiendo.
              </p>
            )}
          </div>
        </Card>
      </div>
    )
  }

  const n = nivel(fila.rx_power_dbm)

  /**
   * La WAN de SERVICIO, que es la que le importa al abonado.
   *
   * Se descarta la de TR-069 —la de gestión— porque su IP es la del pool de
   * administración, no la que el cliente usa para navegar. Mostrarla en
   * "Dirección IPv4" haría que soporte le dicte al abonado una dirección de la
   * red de gestión.
   */
  const wanServicio = (wan?.conexiones ?? []).find((c) => !/tr069/i.test(c.servicio ?? '')) ?? null
  const equipo = ficha?.equipo
  const optica = ficha?.optica

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* --- Encabezado --- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/onus" className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-sky-300">
            <ArrowLeft size={12} /> ONUs
          </Link>
          <h1 className="truncate text-xl font-semibold text-slate-100">
            {fila.cliente ?? fila.nombre_en_la_olt ?? fila.sn}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-mono">{fila.sn}</span>
            <span className="font-mono">{fila.ruta_onu}</span>
            <Link to={`/olts/${fila.olt_id}`} className="hover:text-sky-300">
              {fila.olt}
            </Link>
            {fila.senal_baja && <Badge color="rojo">señal baja</Badge>}
            {fila.sin_abonado && <Badge color="azul">sin ficha de abonado</Badge>}
          </p>
        </div>
        {/* Consultas: solo leen del equipo. */}
        <div className="flex flex-wrap gap-2">
          <Button icon={Signal} cargando={leyendo} onClick={preguntarAlEquipo}>
            Ver estado
          </Button>
          <Button
            icon={Cpu}
            cargando={trabajando === 'sw'}
            onClick={() =>
              correr('sw', async () => {
                setSoftware(await api.olt.softwareOnu(fila.olt_id, id))
                return null
              })
            }
          >
            Software
          </Button>
          {/*
            TR-069, que hasta ahora no se veía por ningún lado.

            El dato estaba: la OLT lo sabe y el middleware lo lee desde la 
            migración que trajo los perfiles. Pero como la ficha no lo mostraba,
            un alta correcta parecía incompleta —"no se habilitó el TR069"— y
            había que ir a otra herramienta para comprobar que sí.
          */}
          <Button
            icon={Network}
            cargando={trabajando === 'wan'}
            disabled={fila.onu_index == null}
            onClick={() =>
              correr('wan', async () => {
                setWan(await api.olt.wanOnu(fila.olt_id, id))
                return null
              })
            }
          >
            WAN
          </Button>
          <Button
            icon={Router}
            cargando={trabajando === 'tr069'}
            disabled={fila.onu_index == null}
            onClick={() =>
              correr('tr069', async () => {
                setTr069(
                  await api.tr069.ont({
                    oltId: fila.olt_id,
                    frame: fila.frame ?? 0,
                    slot: fila.slot,
                    puerto: fila.puerto,
                    onuId: fila.onu_index,
                  }),
                )
                return null
              })
            }
          >
            TR-069
          </Button>
          <Button
            icon={FileCode2}
            cargando={trabajando === 'cfg'}
            onClick={() =>
              correr('cfg', async () => {
                setConfigActiva(await api.olt.configActivaOnu(fila.olt_id, id))
                return null
              })
            }
          >
            Configuración activa
          </Button>
          <Button
            icon={RefreshCw}
            cargando={trabajando === 'ficha'}
            onClick={() => correr('ficha', () => api.olt.actualizarFichaOnu(fila.olt_id, id))}
          >
            Actualizar ficha
          </Button>
          <Button variante="primario" icon={Settings2} onClick={() => setAcciones(true)}>
            Acciones
          </Button>
        </div>
      </div>

      {/* --- Lo que ESCRIBE en la ONT ---
          Separado de las consultas de arriba a propósito: las tres cortan el
          servicio y la de fábrica además borra el wifi del abonado. Mezcladas
          con los botones de leer, tarde o temprano alguien aprieta la que no
          era mientras diagnostica. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-amber-300/80">
          Sobre el equipo del abonado
        </span>
        <Button
          variante="alerta"
          icon={Send}
          cargando={trabajando === 'reprov'}
          onClick={async () => {
            if (
              !(await confirmar(
                `Reenviarle la configuración a la ONT de ${fila.cliente ?? fila.sn}.\n\n` +
                  'Sirve cuando la configuración por TR069 no llegó a aplicarse: la ONT figura ' +
                  'online pero al abonado le falta el servicio.\n\n' +
                  'La ONT se reasocia y pierde el servicio unos segundos.\n\n¿Continuar?',
              ))
            ) {
              return
            }
            correr('reprov', () => api.olt.reprovisionarOnu(fila.olt_id, id))
          }}
        >
          Reenviar configuración
        </Button>
        <Button
          variante="alerta"
          icon={RotateCw}
          cargando={trabajando === 'reiniciar'}
          onClick={async () => {
            if (
              !(await confirmar(
                `Reiniciar la ONT de ${fila.cliente ?? fila.sn}.\n\n` +
                  'Es lo primero que se prueba cuando el equipo quedó inhibido o anda lento con ' +
                  'la señal óptica bien.\n\n' +
                  'Se queda sin servicio un par de minutos.\n\n¿Continuar?',
              ))
            ) {
              return
            }
            correr('reiniciar', () => api.olt.reiniciarOnu(fila.olt_id, id))
          }}
        >
          Reiniciar
        </Button>
        <Button
          variante="peligro"
          icon={Undo2}
          cargando={trabajando === 'fabrica'}
          onClick={async () => {
            if (
              !(await confirmar(
                `Restaurar de fábrica la ONT de ${fila.cliente ?? fila.sn}.\n\n` +
                  'BORRA todo lo que el abonado configuró adentro del equipo: el nombre y la ' +
                  'clave del wifi, los reenvíos de puertos, todo.\n\n' +
                  'El internet vuelve solo —la OLT le reaplica el servicio— pero el wifi queda ' +
                  'con la clave de fábrica y no se le va a conectar ningún teléfono de la casa ' +
                  'hasta que alguien lo reconfigure.\n\n¿Continuar?',
              ))
            ) {
              return
            }
            correr('fabrica', () => api.olt.restaurarFabricaOnu(fila.olt_id, id))
          }}
        >
          Restaurar de fábrica
        </Button>
        <p className="w-full text-[11px] leading-snug text-amber-300/60">
          Las tres cortan el servicio. Restaurar de fábrica además deja al abonado sin su wifi:
          el internet vuelve, su red de la casa no.
        </p>
      </div>

      {resultado && (
        <Aviso tipo={resultado.sin_cambios ? 'info' : 'alerta'}>
          {resultado.diferencias ? (
            resultado.sin_cambios ? (
              <>
                Se releyó del equipo y <b>no cambió nada</b>: lo guardado coincide con lo que
                tiene configurado.
              </>
            ) : (
              <>
                <b>El equipo tenía otra cosa.</b> Se actualizó:
                <ul className="mt-1 space-y-0.5">
                  {resultado.diferencias.map((d) => (
                    <li key={d.campo} className="text-xs">
                      {d.campo}: <span className="line-through opacity-60">{String(d.antes ?? '—')}</span>{' '}
                      → <b>{String(d.ahora)}</b>
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : (
            resultado.aviso ?? 'Listo.'
          )}
        </Aviso>
      )}

      {/*
        La identificación de la ONT, de un vistazo.

        ── Por qué al principio y en dos columnas ──

        Porque son dos preguntas distintas y quien abre esta pantalla trae una
        de las dos: "¿cuál es este equipo y dónde está colgado?" —a la
        izquierda— o "¿cómo está ahora?" —a la derecha—. Antes había que
        recorrer una lista larga mezclando las dos, y los datos que identifican
        al equipo (la ruta gpon, el SN, el ONT-ID) estaban repartidos en
        renglones sueltos.

        La ruta `gpon-onu_0/6/9:17` es la que se pega en la consola de la OLT,
        así que se muestra armada y en monoespaciada para poder copiarla.
      */}
      <Card title="La ONT" icon={Boxes}>
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <dl className="divide-y divide-slate-800/70 text-sm">
            <D k="OLT">
              <Link to={`/olts/${fila.olt_id}`} className="text-sky-300 hover:text-sky-200">
                {fila.olt}
              </Link>
            </D>
            <D k="Placa / Puerto">
              {fila.slot != null ? `${fila.slot} / ${fila.puerto}` : null}
            </D>
            <D k="ONU">
              <span className="font-mono text-xs">{fila.ruta_onu}</span>
            </D>
            <D k="Serie">
              <span className="font-mono text-xs">{fila.sn}</span>
            </D>
            <D k="Tipo de ONU">
              {fila.modelo ? (
                <button
                  type="button"
                  onClick={() => setAcciones(true)}
                  className="text-left text-sky-300 hover:text-sky-200"
                >
                  {fila.modelo}
                  {fila.srv_profile_olt != null ? ` · perfil ${fila.srv_profile_olt}` : ''}
                </button>
              ) : null}
            </D>
            <D k="Nombre en la OLT">{fila.nombre_en_la_olt}</D>
            <D k="Dirección">{fila.direccion}</D>
            <D k="Autorizada">{fila.autorizada_at}</D>
          </dl>

          <div className="space-y-1">
            {/*
              La foto del equipo, arriba de todo.

              Va antes que el estado y no al final porque es lo que ubica a quien
              atiende: antes de leer un solo número ya sabe de qué aparato le
              están hablando, cuántos puertos tiene y dónde busca las luces el
              abonado por teléfono. Al final de la lista cumplía la mitad de esa
              función, porque para entonces ya leyó todo.
            */}
            {tipo?.imagen_url && (
              <div className="mb-3 flex justify-center">
                <img
                  src={tipo.imagen_url}
                  alt={fila.modelo ?? 'ONT'}
                  className="h-28 max-w-full object-contain"
                />
              </div>
            )}

            <dl className="divide-y divide-slate-800/70 text-sm">
              <D k="Estado">
                {fila.onu_estado ? (
                  <span className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        fila.onu_estado === 'online' ? 'bg-emerald-400' : 'bg-slate-600'
                      }`}
                    />
                    {fila.onu_estado === 'online' ? 'En línea' : fila.onu_estado}
                    {fila.ultima_lectura && (
                      <span className="text-[11px] text-slate-500">
                        {/*
                          `hace()` toma SEGUNDOS, no una fecha. Pasarle el
                          timestamp devolvía "hace NaN d", que es peor que no
                          mostrar nada: parece un dato y no lo es.
                        */}
                        ({hace(Math.floor((Date.now() - new Date(fila.ultima_lectura)) / 1000))})
                      </span>
                    )}
                  </span>
                ) : null}
              </D>
              {/*
                Los DOS sentidos del enlace, que es como se diagnostica.

                A la izquierda lo que recibe la ONT; a la derecha lo que la OLT
                recibe desde ella. Si el primero está bien y el segundo mal, el
                problema es de subida —láser flojo, conector sucio del lado del
                abonado— y eso no se ve mirando un solo número.

                La distancia va al lado porque ubica la rotura: si dice 8465 m y
                el plano dice 2 km, el empalme está donde no se creía.
              */}
              <D k="Señal ONU / OLT">
                {fila.rx_power_dbm != null ? (
                  <span className="flex items-center gap-2">
                    <span className={`inline-block h-2 w-2 rounded-full ${n.punto}`} />
                    <span>
                      {dbm(fila.rx_power_dbm)}
                      {' / '}
                      {fila.olt_rx_power_dbm != null ? dbm(fila.olt_rx_power_dbm) : '—'}
                      {fila.distancia_m != null && (
                        <span className="text-slate-500"> ({fila.distancia_m} m)</span>
                      )}
                    </span>
                  </span>
                ) : null}
              </D>
              <D k="VLAN">{fila.vlan}</D>
              <D k="Perfil de línea">{fila.line_profile_olt}</D>
              <D k="Plan">
                {fila.plan
                  ? `${fila.plan} (${Math.round((fila.bajada_kbps ?? 0) / 1000)}/${Math.round((fila.subida_kbps ?? 0) / 1000)} Mbps)`
                  : null}
              </D>
              {/*
                TR-069 se consulta al equipo, así que no está hasta que alguien
                aprieta el botón. Se muestra el renglón igual, diciendo cómo
                traerlo: dejarlo afuera haría pensar que la ONT no lo tiene.
              */}
              <D k="Gestión remota">
                <button
                  type="button"
                  onClick={() => setGestion(true)}
                  className="text-left text-sky-300 hover:text-sky-200"
                >
                  {tr069 ? (
                    <>
                      {tr069.perfilNombre ?? 'sin perfil'}
                      {tr069.ipConfigurada ? ` · ${tr069.ipConfigurada}` : ''}
                      {tr069.vlanGestion ? ` · VLAN ${tr069.vlanGestion}` : ''}
                    </>
                  ) : (
                    'Configurar TR-069 e IP de gestión'
                  )}
                </button>
              </D>

              {/*
                Las tres filas que cierran la comparación: en qué modo sale la
                ONT, cómo obtuvo su dirección y cuál es.

                Salen de `display ont wan-info`, que no todos los modelos
                contestan. Cuando el modelo no sabe, se dice —"no lo informa"—
                en vez de dejar el hueco: un renglón vacío se lee como "no
                tiene WAN", y es otra cosa.
              */}
              <D k="Modo de la ONU">
                <button
                  type="button"
                  onClick={() => setModoWan(true)}
                  className="text-left text-sky-300 hover:text-sky-200"
                >
                  {wanServicio
                    ? `${/bridge/i.test(wanServicio.tipoConexion ?? '') ? 'Puente' : 'Enrutada'} · WAN VLAN ${wanServicio.vlan ?? '—'}`
                    : wan && !wan.soportado
                      ? 'El modelo no lo informa · configurar'
                      : 'Configurar cómo sale a internet'}
                </button>
              </D>
              <D k="Modo de configuración">
                {wanServicio
                  ? `${wanServicio.accesoIpv4 ?? '—'}${wanServicio.servicio ? ` (${wanServicio.servicio})` : ''}`
                  : null}
              </D>
              <D k="Dirección IPv4">
                {wanServicio?.ipv4 ? (
                  <span className="font-mono text-xs">{wanServicio.ipv4}</span>
                ) : null}
              </D>
              <D k="VLANs de la ONT">
                {wan?.conexiones?.length
                  ? [...new Set(wan.conexiones.map((c) => c.vlan).filter(Boolean))].join(', ')
                  : fila.vlan}
              </D>
            </dl>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* --- Lo guardado --- */}
        <div className="space-y-4">
          <Card title="Lo que tenemos guardado" icon={User}>
            <dl className="divide-y divide-slate-800/70 text-sm">
              <D k="Abonado">
                {fila.client_id ? (
                  <Link to={`/clientes/${fila.client_id}`} className="text-sky-300 hover:text-sky-200">
                    {fila.cliente}
                  </Link>
                ) : (
                  <span className="text-slate-400">
                    {fila.nombre_en_la_olt ?? 'sin nombre'}{' '}
                    <span className="text-[11px] text-amber-400">
                      — no tiene ficha en el sistema: hay servicio dado y nadie a quien facturarle
                    </span>
                  </span>
                )}
              </D>
              <D k="Dirección">{fila.direccion}</D>
              <D k="Contacto">{fila.contacto}</D>
              <D k="Plan">
                {fila.plan ? `${fila.plan} (${Math.round((fila.bajada_kbps ?? 0) / 1000)}/${Math.round((fila.subida_kbps ?? 0) / 1000)} Mbps)` : null}
              </D>
              <D k="Zona">{fila.zona}</D>
              <D k="Caja / ODB">{fila.odb}</D>
              <D k="VLAN">{fila.vlan}</D>
              {/* El modelo con su foto. Se carga una sola vez por tipo y se ve
                  en todos los abonados que lo tengan: el que atiende un reclamo
                  sabe de qué aparato le están hablando antes de salir. */}
              <D k="Modelo">
                {fila.modelo ? (
                  <span className="flex flex-wrap items-center gap-2">
                    {tipo?.imagen_url && (
                      <img
                        src={tipo.imagen_url}
                        alt={fila.modelo}
                        className="h-12 rounded border border-slate-800 bg-slate-900 object-contain px-1"
                      />
                    )}
                    <span>
                      {fila.modelo}
                      {tipo && (
                        <span className="block text-[11px] text-slate-500">
                          {tipo.marca}
                          {tipo.puertos_ethernet ? ` · ${tipo.puertos_ethernet} Ethernet` : ''}
                          {tipo.wifi_ssids ? ` · ${tipo.wifi_ssids} WiFi` : ' · sin WiFi'}
                          {tipo.puertos_fxs ? ` · ${tipo.puertos_fxs} VoIP` : ''}
                          {tipo.catv ? ' · CATV' : ''}
                          {tipo.soporta_tr069 === false ? ' · se configura a mano' : ''}
                        </span>
                      )}
                    </span>
                  </span>
                ) : null}
              </D>

              {/* Lo que el técnico va a necesitar dictarle al abonado. Está acá
                  porque es la consulta más frecuente del soporte. */}
              {(fila.ssid || fila.clave_wifi) && (
                <D k="WiFi configurado">
                  <span className="font-mono text-sm">{fila.ssid}</span>
                  {fila.clave_wifi && (
                    <span className="ml-2 font-mono text-sm text-slate-400">{fila.clave_wifi}</span>
                  )}
                  {fila.configurada_por && (
                    <span className="block text-[11px] text-slate-500">
                      {fila.configurada_por === 'tr069'
                        ? 'configurado por el sistema'
                        : 'cargado a mano por el técnico'}
                    </span>
                  )}
                </D>
              )}
              <D k="Perfiles">
                {fila.line_profile_olt != null || fila.srv_profile_olt != null
                  ? `línea ${fila.line_profile_olt ?? '—'} · servicio ${fila.srv_profile_olt ?? '—'}${fila.srv_profile_nombre ? ` (${fila.srv_profile_nombre})` : ''}`
                  : null}
              </D>
              <D k="Fecha de alta">{fila.autorizada_at}</D>
              <D k="Descripción en la OLT">
                {fila.descripcion_olt && (
                  <span className="break-all font-mono text-xs">{fila.descripcion_olt}</span>
                )}
              </D>
              <D k="Ficha leída">
                {fila.ficha_leida_at ? (
                  <span>
                    {new Date(fila.ficha_leida_at).toLocaleString('es-EC')}
                    <span className="ml-2 text-[11px] text-slate-600">
                      hace {hace(Math.round((Date.now() - new Date(fila.ficha_leida_at)) / 1000))}
                    </span>
                  </span>
                ) : (
                  <span className="text-amber-400">
                    nunca — resincronizá para traer modelo, VLAN y perfiles del equipo
                  </span>
                )}
              </D>
            </dl>
          </Card>

          {/* --- Lo que dice el equipo --- */}
          <Card
            title="Lo que dice el equipo"
            subtitle="Se lee en vivo por SSH. No se guarda solo: para eso está Resincronizar."
            icon={Signal}
          >
            {!ficha ? (
              <p className="py-6 text-center text-sm text-slate-500">
                Todavía no se le preguntó.{' '}
                <button
                  type="button"
                  onClick={preguntarAlEquipo}
                  className="text-sky-400 hover:text-sky-300"
                >
                  Preguntarle ahora
                </button>
                <span className="mt-1 block text-[11px] text-slate-600">
                  Cuesta una sesión SSH contra la OLT, por eso no se hace al abrir.
                </span>
              </p>
            ) : (
              <div className="space-y-4">
                {ficha.problemas?.length > 0 && (
                  <Aviso tipo="alerta">
                    No se pudo leer todo: {ficha.problemas.join(' · ')}
                  </Aviso>
                )}

                {equipo && (
                  <dl className="divide-y divide-slate-800/70 text-sm">
                    <D k="Estado">{equipo.estado}</D>
                    <D k="Autenticación">{equipo.autenticacion}</D>
                    <D k="Gestión">{equipo.gestion}</D>
                    <D k="Perfil de línea">
                      {equipo.lineProfileId != null
                        ? `${equipo.lineProfileId} · ${equipo.lineProfileNombre ?? ''}`
                        : null}
                    </D>
                    <D k="Perfil de servicio">
                      {equipo.srvProfileId != null
                        ? `${equipo.srvProfileId} · ${equipo.srvProfileNombre ?? ''}`
                        : null}
                    </D>
                    <D k="Descripción">
                      {equipo.descripcion && (
                        <span className="break-all font-mono text-xs">{equipo.descripcion}</span>
                      )}
                    </D>
                  </dl>
                )}

                {equipo?.servicePorts?.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <Gauge size={13} />
                      Service-ports
                    </h4>
                    <Table
                      columnas={['Índice', 'VLAN', 'Gemport', 'Bajada', 'Subida', 'Estado']}
                      filas={equipo.servicePorts}
                      renderFila={(s) => (
                        <tr key={s.indice} className="text-slate-300">
                          <td className="px-3 py-1.5 font-mono text-xs">{s.indice}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{s.vlan}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{s.gemport}</td>
                          {/* Las traffic-tables van cruzadas respecto de las
                              columnas RX/TX del equipo. Acá ya vienen derechas. */}
                          <td className="px-3 py-1.5 text-xs">
                            {s.ttSalida == null ? (
                              <span className="text-slate-600">sin límite</span>
                            ) : (
                              `tabla ${s.ttSalida}`
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-xs">
                            {s.ttEntrada == null ? (
                              <span className="text-slate-600">sin límite</span>
                            ) : (
                              `tabla ${s.ttEntrada}`
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-xs">
                            <Badge color={s.estado === 'up' ? 'verde' : 'gris'}>{s.estado}</Badge>
                          </td>
                        </tr>
                      )}
                    />
                    <p className="mt-1 text-[11px] leading-snug text-slate-500">
                      El de la VLAN 999 es el de gestión, igual para todos. El otro es el que le da
                      internet al abonado.
                    </p>
                  </div>
                )}

                {optica && (
                  <dl className="divide-y divide-slate-800/70 text-sm">
                    <D k="Señal de bajada (RX)">{dbm(optica.rx_power_dbm)}</D>
                    <D k="Señal de subida (TX)">{dbm(optica.tx_power_dbm)}</D>
                    <D k="La ve la OLT a">{dbm(optica.olt_rx_power_dbm)}</D>
                    <D k="Distancia">{optica.distancia_m != null ? `${optica.distancia_m} m` : null}</D>
                    <D k="Modelo">{optica.modelo}</D>
                    <D k="Versión de software">{optica.version_sw}</D>
                    <D k="Última caída">{optica.ultima_caida}</D>
                    <D k="Causa">{optica.causa_cruda ?? optica.causa}</D>
                  </dl>
                )}
                {ficha.optica === null && (
                  <p className="text-[11px] leading-snug text-slate-500">
                    Sin lectura óptica. Es una consulta OMCI en vivo: con la ONT caída, el equipo no
                    la puede contestar. Eso no significa que la señal sea cero.
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>

        {/* --- Columna derecha --- */}
        <div className="space-y-4">
          <Card title="Señal" icon={Signal}>
            <div className="flex items-baseline gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${n.punto}`} />
              <span className="text-3xl font-semibold text-slate-100">{dbm(fila.rx_power_dbm)}</span>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {fila.ultima_lectura
                ? `Última lectura ${new Date(fila.ultima_lectura).toLocaleString('es-EC')}`
                : 'Nunca se le leyó la potencia'}
            </p>
            {fila.rx_power_dbm != null && (
              <div className="mt-3">
                <HistorialOptico onuId={fila.onu_id} />
              </div>
            )}
          </Card>

          <Card title="Puertos de la ONT" icon={Cable}>
            <PuertosOnt oltId={fila.olt_id} onuId={fila.onu_id} />
          </Card>

          <Card title="Consumo">
            <TraficoVivo oltId={fila.olt_id} onuId={fila.onu_id} />
          </Card>

          <Card title="Estado del enlace">
            <dl className="divide-y divide-slate-800/70 text-sm">
              <D k="Estado">{fila.onu_estado}</D>
              <D k="Causa de la caída">{fila.causa_caida_cruda ?? fila.causa_caida}</D>
              <D k="Última caída">{fila.ultima_caida}</D>
              <D k="Distancia">{fila.distancia_m != null ? `${fila.distancia_m} m` : null}</D>
            </dl>
          </Card>
        </div>
      </div>

      {tr069 && (
        <Card title="Gestión remota (TR-069)" icon={Router}>
          <dl className="divide-y divide-slate-800/70 text-sm">
            <D k="Perfil">
              {tr069.perfilNombre
                ? `${tr069.perfilNombre}${tr069.perfilId != null ? ` (id ${tr069.perfilId})` : ''}`
                : null}
            </D>
            <D k="Gestión">
              {tr069.gestionHabilitada === true
                ? 'Habilitada'
                : tr069.gestionHabilitada === false
                  ? 'Apagada'
                  : null}
            </D>
            <D k="IP de gestión">{tr069.ipConfigurada}</D>
            <D k="IP que responde">{tr069.ipViva}</D>
            <D k="VLAN de gestión">{tr069.vlanGestion}</D>
            <D k="Puerta de enlace">{tr069.gateway}</D>
            <D k="MACs en la VLAN de gestión">
              {tr069.macsEnGestion != null ? String(tr069.macsEnGestion) : null}
            </D>
          </dl>

          {/*
            El diagnóstico que trae el middleware, cuando lo trae.

            Dice cosas que el listado de arriba no explica —por ejemplo que la
            configuración esté completa pero la OLT no le tenga MACs aprendidas,
            que no condena a nadie porque esa tabla envejece cuando la ONT está
            callada—. Sin este texto, un cero en "MACs" se lee como una falla.
          */}
          {tr069.diagnostico?.motivo && (
            <div className="mt-3">
              <Aviso tipo={tr069.gestionHabilitada ? 'info' : 'alerta'}>
                {tr069.diagnostico.motivo}
              </Aviso>
            </div>
          )}
        </Card>
      )}

      {software && (
        <Card title="Software y hardware de la ONT" icon={Cpu}>
          <dl className="divide-y divide-slate-800/70 text-sm">
            <D k="Modelo">{software.modelo}</D>
            <D k="Fabricante">{software.vendorId}</D>
            <D k="Versión de hardware">{software.versionHardware}</D>
            <D k="Versión de firmware">{software.versionSoftware}</D>
            <D k="MAC">{software.mac}</D>
            <D k="Serie del fabricante">{software.equipoSn}</D>
          </dl>
          <p className="mt-2 text-[11px] text-slate-500">
            Leído en vivo por OMCI. Con la ONT caída el equipo no lo puede contestar.
          </p>
        </Card>
      )}

      {configActiva && (
        <Card
          title="Configuración activa"
          subtitle="Lo que el equipo tiene en ejecución para esta ONT, ahora mismo"
          icon={FileCode2}
        >
          <pre className="overflow-x-auto t-panel p-3 text-[11px] leading-relaxed text-slate-300">
            {configActiva.texto || 'El equipo no devolvió configuración para esta ONT.'}
          </pre>
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            Es la configuración acotada a esta ONT, no la del equipo entero. Las contraseñas van
            tapadas: la línea del TR069 lleva la clave del servidor de gestión.
          </p>
        </Card>
      )}

      <Modal
        abierto={acciones}
        titulo={`Acciones · ${fila.sn}`}
        onCerrar={() => setAcciones(false)}
        ancho="max-w-2xl"
      >
        <AccionesOnu
          olt={{ id: fila.olt_id, nombre: fila.olt }}
          onu={fila}
          planes={planes}
          onListo={(accion, r) => {
            if (accion === 'baja') {
              setDadaDeBaja(r)
              setAcciones(false)
            }
            return cargarBase()
          }}
          onCerrar={() => setAcciones(false)}
        />
      </Modal>

      {gestion && (
        <GestionRemotaOnu
          olt={{ id: fila.olt_id, nombre: fila.olt }}
          onu={fila}
          actual={tr069}
          onListo={async () => {
            // Se relee del equipo en vez de confiar en lo que devolvió el
            // cambio: si la OLT aplicó algo distinto, hay que verlo acá.
            setTr069(
              await api.tr069
                .ont({
                  oltId: fila.olt_id,
                  frame: fila.frame ?? 0,
                  slot: fila.slot,
                  puerto: fila.puerto,
                  onuId: fila.onu_index,
                })
                .catch(() => null),
            )
            return cargarBase()
          }}
          onCerrar={() => setGestion(false)}
        />
      )}

      {modoWan && (
        <ModoWanOnu
          olt={{ id: fila.olt_id, nombre: fila.olt }}
          onu={fila}
          onListo={async () => {
            // Se relee del equipo: lo que quedó manda sobre lo que se pidió.
            setWan(await api.olt.wanOnu(fila.olt_id, id).catch(() => null))
            return cargarBase()
          }}
          onCerrar={() => setModoWan(false)}
        />
      )}
    </div>
  )
}

/** Una fila clave/valor. El hueco se muestra como hueco: no se inventa nada. */
function D({ k, children }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 py-1.5">
      <dt className="w-44 shrink-0 text-xs text-slate-500">{k}</dt>
      <dd className="min-w-0 flex-1 text-slate-200">
        {children || <span className="text-slate-600">—</span>}
      </dd>
    </div>
  )
}
