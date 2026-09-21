import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  Camera,
  Check,
  ChevronRight,
  Clock,
  CornerUpLeft,
  MapPin,
  MessageCircle,
  Navigation,
  Phone,
  PlayCircle,
  Radio,
  Trash2,
  Truck,
  User,
  Waves,
  X,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { campoApi } from '../../lib/colaCampo'
import AvisoIncidencia from '../tecnico/AvisoIncidencia'
import { Aviso, Button, Card, Field, Input, Textarea } from '../ui'
import FirmaDigital from './FirmaDigital'
import {
  CHECKLIST,
  ESTADOS,
  FRANJAS,
  PRIORIDADES,
  RADIO_LLEGADA_M,
  TRANSICIONES,
  comprimirImagen,
  distanciaEnMetros,
  duracion,
  enlaceMapa,
  enlaceWhatsapp,
  etiquetaIncidencia,
  haceCuanto,
  ubicacionActual,
} from '../../lib/soporte'

/**
 * La orden de trabajo como la ve el técnico en la calle.
 *
 * Está pensada para un teléfono, con una mano, a veces sin buena señal y con
 * guantes. Por eso:
 *
 *  - Los tres botones que más se usan —llamar, WhatsApp, navegar— van arriba de
 *    todo y ocupan el ancho: son los que se aprietan antes de salir.
 *  - El estado se cambia con un botón grande, no con un desplegable.
 *  - El cierre está abajo, y hasta que no haya firma no se habilita: la firma es
 *    lo que respalda el trabajo, y si se pudiera cerrar sin ella nadie la
 *    pediría.
 */

const fecha = (f) =>
  f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—'

const fechaHora = (f) =>
  f ? new Date(f).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'

function Dato({ etiqueta, valor, mono = false }) {
  if (valor === null || valor === undefined || valor === '') return null
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{etiqueta}</dt>
      <dd className={`truncate text-sm text-slate-200 ${mono ? 'font-mono' : ''}`}>{valor}</dd>
    </div>
  )
}

export default function TicketFicha({ ticket, onCambio, onError }) {
  const confirmar = useConfirmar()
  const [t, setT] = useState(ticket)
  const [guardando, setGuardando] = useState(false)
  const [eventos, setEventos] = useState([])
  const [adjuntos, setAdjuntos] = useState([])
  const [urls, setUrls] = useState({})
  const [subiendo, setSubiendo] = useState(false)

  const [cierre, setCierre] = useState({
    solucion: '',
    material_usado: '',
    firmante_nombre: '',
    firmante_cedula: '',
    firma_b64: null,
    checklist: {},
  })

  const archivoRef = useRef(null)
  const [ubicando, setUbicando] = useState(false)

  useEffect(() => setT(ticket), [ticket])

  const puntos = CHECKLIST[t.tecnologia] ?? CHECKLIST.ftth
  const estado = ESTADOS[t.estado] ?? ESTADOS.abierto
  const cerrado = t.estado === 'resuelto' || t.estado === 'cancelado'

  const recargar = useCallback(async () => {
    const [ev, ad] = await Promise.all([
      supabase
        .from('ticket_eventos')
        .select('*')
        .eq('ticket_id', t.id)
        .order('created_at', { ascending: false }),
      supabase.from('ticket_adjuntos').select('*').eq('ticket_id', t.id).order('created_at'),
    ])
    setEventos(ev.data ?? [])
    setAdjuntos(ad.data ?? [])

    // El bucket es privado: cada foto necesita una URL firmada para poder verse.
    // Duran una hora, que es más de lo que dura abierta esta pantalla.
    const mapa = {}
    for (const a of ad.data ?? []) {
      const { data } = await supabase.storage.from('tickets').createSignedUrl(a.ruta, 3600)
      if (data?.signedUrl) mapa[a.id] = data.signedUrl
    }
    setUrls(mapa)
  }, [t.id])

  useEffect(() => {
    recargar()
  }, [recargar])

  useEffect(() => {
    setCierre((c) => ({
      ...c,
      solucion: t.solucion ?? '',
      material_usado: t.material_usado ?? '',
      firmante_nombre: t.firmante_nombre ?? t.nombre ?? '',
      firmante_cedula: t.firmante_cedula ?? t.identificacion ?? '',
      firma_b64: t.firma_b64 ?? null,
      checklist: t.checklist ?? {},
    }))
  }, [t])

  const wa = enlaceWhatsapp(
    t.telefono_whatsapp || t.telefono,
    `Hola ${String(t.nombre ?? '').split(' ')[0]}, le escribimos por su reporte N° ${t.codigo}.`,
  )

  async function cambiarEstado(nuevo) {
    setGuardando(true)
    onError?.(null)
    try {
      // `cerrado_por` solo cuando de verdad se está cerrando. Ponerlo en cada
      // cambio de estado hacía figurar como "cerrado por" a quien apenas salió
      // hacia el domicilio.
      const campos = {
        estado: nuevo,
        ...(nuevo === 'resuelto' || nuevo === 'cancelado'
          ? { cerrado_por: (await supabase.auth.getUser()).data?.user?.id ?? null }
          : {}),
        ...(nuevo === 'en_ruta' ? { salida_at: new Date().toISOString() } : {}),
      }

      // Por la cola: "salgo para allá" se toca en la puerta del taller y
      // "llegué" en la vereda del cliente. Los dos son lugares donde la señal
      // falta seguido, y son las marcas de tiempo con las que después se mide
      // cuánto tardó una visita.
      const r = await campoApi.actualizarTicket(t.id, campos)

      setT((v) => ({ ...v, ...campos }))
      if (r.encolado) return

      await recargar()
      await onCambio?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Sale hacia el domicilio.
   *
   * Abre el navegador antes de tocar la base: si se hiciera al revés, un
   * problema de red dejaría al técnico mirando una pantalla que no reacciona
   * cuando lo que quiere es arrancar.
   */
  async function irAlDomicilio() {
    const mapa = enlaceMapa(t)
    if (mapa) window.open(mapa, '_blank', 'noopener')
    await cambiarEstado('en_ruta')
  }

  /**
   * Llegó: se confirma con la ubicación del momento.
   *
   * La distancia no bloquea nada. La coordenada del abonado muchas veces se
   * cargó desde la vereda y un GPS bajo techo se va cincuenta metros: negarle
   * iniciar el trabajo a quien está parado en la puerta sería peor que
   * registrar un número raro. Si está lejos se pide confirmación y queda
   * asentado desde dónde marcó.
   */
  async function iniciarTrabajo() {
    setUbicando(true)
    onError?.(null)

    try {
      const pos = await ubicacionActual()

      const metros =
        pos && t.latitud && t.longitud
          ? distanciaEnMetros(
              { lat: Number(t.latitud), lng: Number(t.longitud) },
              { lat: pos.lat, lng: pos.lng },
            )
          : null

      if (metros != null && metros > RADIO_LLEGADA_M) {
        const seguir = await confirmar(
          `Estás a ${metros} m del domicilio del ticket.\n\n` +
            'Puede ser que la coordenada del abonado esté mal cargada. ' +
            '¿Iniciar el trabajo igual? Queda registrado desde dónde marcaste.',
        )
        if (!seguir) return
      }

      if (!pos) {
        const seguir = await confirmar(
          'No se pudo tomar la ubicación del dispositivo.\n\n' +
            '¿Iniciar el trabajo igual? El ticket va a quedar sin confirmación de llegada.',
        )
        if (!seguir) return
      }

      const campos = {
        estado: 'en_proceso',
        llegada_at: new Date().toISOString(),
        llegada_lat: pos?.lat ?? null,
        llegada_lng: pos?.lng ?? null,
        llegada_precision_m: pos?.precision ? Math.round(pos.precision) : null,
        // `cerrado_por` es de quién lo cierra, no de quién llega. Ponerlo acá
        // haría figurar como cerrador a alguien que recién está entrando.
      }

      // Pasa por la cola: llegar al domicilio es justo donde suele no haber
      // señal, y perder la marca de llegada obliga a rehacerla desde la
      // memoria — que es como se llena de horarios inventados.
      const r = await campoApi.actualizarTicket(t.id, campos)

      setT((v) => ({ ...v, ...campos }))
      if (r.encolado) return

      await recargar()
      await onCambio?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setUbicando(false)
    }
  }

  async function subirFotos(e) {
    const archivos = Array.from(e.target.files ?? [])
    if (!archivos.length) return

    setSubiendo(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()

      for (const archivo of archivos) {
        // Se achica antes de subir: el técnico está con datos móviles y una foto
        // de 4 MB del celular a veces no llega.
        const blob = await comprimirImagen(archivo)
        const ruta = `${t.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`

        const { error: errSubida } = await supabase.storage
          .from('tickets')
          .upload(ruta, blob, { contentType: 'image/jpeg' })
        if (errSubida) throw errSubida

        const { error } = await supabase.from('ticket_adjuntos').insert({
          ticket_id: t.id,
          tipo: 'foto',
          ruta,
          created_by: sesion?.user?.id ?? null,
        })
        if (error) throw error
      }

      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setSubiendo(false)
      if (archivoRef.current) archivoRef.current.value = ''
    }
  }

  async function borrarFoto(a) {
    if (!await confirmar('¿Borrar esta foto?')) return
    await supabase.storage.from('tickets').remove([a.ruta])
    await supabase.from('ticket_adjuntos').delete().eq('id', a.id)
    await recargar()
  }

  async function cerrarTicket(e) {
    e.preventDefault()
    if (!cierre.firma_b64) {
      return onError?.(new Error('Falta la firma de conformidad del abonado'))
    }

    setGuardando(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()
      // Un solo botón, con o sin señal. Sin conexión el cierre queda en la cola
      // y sale solo; la franja de arriba dice que falta enviarlo.
      //
      // Es seguro reintentarlo: el historial del ticket lo escribe un
      // disparador guardado por `IF NEW.estado IS DISTINCT FROM OLD.estado`, así
      // que cerrar dos veces no deja dos renglones de cierre.
      const campos = {
        estado: 'resuelto',
        solucion: cierre.solucion?.trim() || null,
        material_usado: cierre.material_usado?.trim() || null,
        checklist: cierre.checklist,
        firma_b64: cierre.firma_b64,
        firmante_nombre: cierre.firmante_nombre?.trim() || null,
        firmante_cedula: cierre.firmante_cedula?.trim() || null,
        cerrado_at: new Date().toISOString(),
        cerrado_por: sesion?.user?.id ?? null,
      }

      const r = await campoApi.actualizarTicket(t.id, campos)

      // La pantalla refleja el cierre en los dos casos: para el técnico el
      // trabajo terminó. Lo que distingue "enviado" de "falta enviar" es la
      // franja de arriba, que no se puede cerrar mientras haya pendientes.
      setT((v) => ({ ...v, ...campos }))
      if (r.encolado) return

      await recargar()
      await onCambio?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const faltan = puntos.filter((p) => !cierre.checklist[p.clave]).length

  return (
    <div className="space-y-4">
      {/* Antes que nada: si la zona del abonado está caída, el problema puede
          no ser del domicilio. Va arriba porque abajo no se lee. */}
      <AvisoIncidencia clientId={t.client_id} />

      {/* ------------------------------------------------ Encabezado */}
      <div className={`rounded-xl border p-4 ${estado.clase}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs opacity-80">TICKET N° {t.codigo}</p>
            <h2 className="truncate text-xl font-bold">{t.nombre}</h2>
            <p className="text-sm opacity-90">{etiquetaIncidencia(t.tipo_incidencia)}</p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="rounded-full bg-black/20 px-3 py-1 text-xs font-bold uppercase">
              {estado.label}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${PRIORIDADES[t.prioridad]?.clase ?? ''}`}
            >
              Prioridad {PRIORIDADES[t.prioridad]?.label ?? t.prioridad}
            </span>
            <span className="text-[11px] uppercase opacity-75">
              {t.tecnologia === 'ftth' ? 'FTTH · Fibra' : 'Wireless · Radio'}
            </span>
          </div>
        </div>

        <p className="mt-3 flex items-center gap-2 text-xs opacity-80">
          <Clock size={13} />
          Abierto {haceCuanto(t.horas_abierto)}
          {t.fecha_visita && (
            <>
              <ChevronRight size={12} />
              Visita {fecha(t.fecha_visita)}
              {t.franja && ` · ${t.franja === 'exacta' ? String(t.hora_visita).slice(0, 5) : FRANJAS[t.franja]}`}
            </>
          )}
        </p>

        {t.visita_atrasada && (
          <p className="mt-2 rounded-lg bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
            La visita estaba para el {fecha(t.fecha_visita)} y sigue sin resolverse.
          </p>
        )}
      </div>

      {/* ------------------------------------------------ Acciones rápidas */}
      <div className="grid grid-cols-3 gap-2">
        <a
          href={t.telefono ? `tel:${t.telefono}` : undefined}
          className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-xs transition ${
            t.telefono
              ? 'border-sky-500/40 bg-sky-500/10 text-sky-200 active:bg-sky-500/20'
              : 'pointer-events-none border-slate-800 text-slate-600'
          }`}
        >
          <Phone size={20} />
          Llamar
        </a>

        <a
          href={wa ?? undefined}
          target="_blank"
          rel="noreferrer"
          className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-xs transition ${
            wa
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 active:bg-emerald-500/20'
              : 'pointer-events-none border-slate-800 text-slate-600'
          }`}
        >
          <MessageCircle size={20} />
          WhatsApp
        </a>

        <a
          href={enlaceMapa(t) ?? undefined}
          target="_blank"
          rel="noreferrer"
          className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-xs transition ${
            enlaceMapa(t)
              ? 'border-violet-500/40 bg-violet-500/10 text-violet-200 active:bg-violet-500/20'
              : 'pointer-events-none border-slate-800 text-slate-600'
          }`}
        >
          <Navigation size={20} />
          Navegar
        </a>
      </div>

      {enlaceMapa(t, 'waze') && (
        <a
          href={enlaceMapa(t, 'waze')}
          target="_blank"
          rel="noreferrer"
          className="block text-center text-[11px] text-slate-500 underline"
        >
          Abrir en Waze
        </a>
      )}

      {/* ------------------------------------------------ Qué sigue
          Un botón grande con lo que toca hacer ahora, y el resto chico abajo.
          El técnico en la calle no tiene que elegir entre cinco opciones: tiene
          que apretar la única que corresponde. */}
      {t.estado === 'asignado' && (
        <Button
          variante="primario"
          icon={Truck}
          onClick={irAlDomicilio}
          cargando={guardando}
          className="w-full py-4 text-base"
        >
          Ir al domicilio
        </Button>
      )}

      {t.estado === 'en_ruta' && (
        <Button
          variante="primario"
          icon={PlayCircle}
          onClick={iniciarTrabajo}
          cargando={ubicando || guardando}
          className="w-full py-4 text-base"
        >
          {ubicando ? 'Confirmando llegada…' : 'Llegué — iniciar trabajo'}
        </Button>
      )}

      {t.estado === 'en_ruta' && (
        <p className="text-center text-[11px] text-slate-500">
          Al iniciar se toma tu ubicación para dejar constancia de que llegaste.
        </p>
      )}

      {/* Los movimientos que no son el camino normal: volver atrás porque se
          equivocó de ticket, o cancelar porque no había nadie. */}
      {TRANSICIONES[t.estado]?.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {TRANSICIONES[t.estado]
            .filter((e) => !(t.estado === 'asignado' && e === 'en_ruta'))
            .filter((e) => !(t.estado === 'en_ruta' && e === 'en_proceso'))
            .map((e) => (
              <Button
                key={e}
                variante="fantasma"
                icon={e === 'cancelado' ? X : CornerUpLeft}
                onClick={() => cambiarEstado(e)}
                cargando={guardando}
                className="text-xs"
              >
                {e === 'cancelado' ? 'Cancelar ticket' : `Volver a ${ESTADOS[e].label.toLowerCase()}`}
              </Button>
            ))}
        </div>
      )}

      {/* ------------------------------------------------ Salida y llegada */}
      {(t.salida_at || t.llegada_at) && (
        <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">Salió</dt>
              <dd className="text-slate-200">{fechaHora(t.salida_at)}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">Llegó</dt>
              <dd className="text-slate-200">
                {t.llegada_at ? fechaHora(t.llegada_at) : <span className="text-amber-400">en camino</span>}
              </dd>
            </div>
            {t.minutos_en_ruta != null && (
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">Viaje</dt>
                <dd className="text-slate-200">{duracion(t.minutos_en_ruta)}</dd>
              </div>
            )}
            {t.llegada_at && t.minutos_en_sitio != null && (
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">En el lugar</dt>
                <dd className="text-slate-200">{duracion(t.minutos_en_sitio)}</dd>
              </div>
            )}
          </dl>

          {t.llegada_at &&
            (t.llegada_distancia_m == null ? (
              <p className="mt-2 text-[11px] text-slate-500">
                Sin confirmación de ubicación: el dispositivo no dio el GPS o el ticket no tiene
                coordenadas cargadas.
              </p>
            ) : (
              <p
                className={`mt-2 text-[11px] ${
                  Number(t.llegada_distancia_m) <= RADIO_LLEGADA_M
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }`}
              >
                {Number(t.llegada_distancia_m) <= RADIO_LLEGADA_M
                  ? `Llegada confirmada a ${t.llegada_distancia_m} m del domicilio`
                  : `Inició el trabajo a ${t.llegada_distancia_m} m del domicilio`}
                {t.llegada_precision_m ? ` · GPS ±${t.llegada_precision_m} m` : ''}
              </p>
            ))}
        </div>
      )}

      {/* ------------------------------------------------ La falla */}
      <Card title="Lo que reporta el abonado">
        <p className="whitespace-pre-wrap text-sm text-slate-200">
          {t.descripcion || <span className="text-slate-500">Sin descripción.</span>}
        </p>
      </Card>

      {/* ------------------------------------------------ Dónde y quién */}
      <Card title="Ubicación y contacto" icon={MapPin}>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Dato etiqueta="Dirección" valor={t.direccion} />
          <Dato etiqueta="Sector / cantón" valor={[t.sector, t.canton].filter(Boolean).join(' · ')} />
          <Dato etiqueta="Referencia" valor={t.referencia} />
          <Dato etiqueta="Cédula / RUC" valor={t.identificacion} mono />
          <Dato etiqueta="Teléfono" valor={t.telefono} mono />
          <Dato etiqueta="WhatsApp" valor={t.telefono_whatsapp} mono />
          <Dato
            etiqueta="Coordenadas"
            valor={t.latitud && t.longitud ? `${t.latitud}, ${t.longitud}` : null}
            mono
          />
          <Dato etiqueta="Asignado a" valor={t.tecnico ?? t.cuadrilla} />
        </dl>
      </Card>

      {/* ------------------------------------------------ Datos técnicos */}
      <Card
        title={t.tecnologia === 'ftth' ? 'Servicio FTTH' : 'Servicio Wireless'}
        icon={t.tecnologia === 'ftth' ? Waves : Radio}
      >
        <dl className="grid gap-3 sm:grid-cols-2">
          {t.tecnologia === 'ftth' ? (
            <>
              <Dato etiqueta="Caja NAP" valor={t.nap} />
              <Dato etiqueta="Puerto" valor={t.puerto_nap} mono />
              <Dato etiqueta="Modelo ONT" valor={t.ont_modelo} />
              <Dato etiqueta="Serie ONT" valor={t.ont_serie} mono />
              <Dato
                etiqueta="Potencia reportada"
                valor={t.potencia_dbm != null ? `${t.potencia_dbm} dBm` : null}
                mono
              />
            </>
          ) : (
            <>
              <Dato etiqueta="Nodo / torre" valor={t.torre} />
              <Dato etiqueta="IP del CPE" valor={t.cpe_ip} mono />
              <Dato etiqueta="Frecuencia" valor={t.frecuencia} mono />
              <Dato
                etiqueta="Señal reportada"
                valor={t.senal_dbm != null ? `${t.senal_dbm} dBm` : null}
                mono
              />
              <Dato etiqueta="Antena" valor={t.antena_modelo} />
            </>
          )}
        </dl>
      </Card>

      {/* ------------------------------------------------ Evidencia */}
      <Card
        title="Fotos del trabajo"
        icon={Camera}
        subtitle="Lectura de potencia, instalación, antes y después"
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {adjuntos.map((a) => (
            <div key={a.id} className="group relative aspect-square overflow-hidden rounded-lg border border-slate-700">
              {urls[a.id] ? (
                <a href={urls[a.id]} target="_blank" rel="noreferrer">
                  <img src={urls[a.id]} alt="" className="h-full w-full object-cover" />
                </a>
              ) : (
                <div className="h-full w-full animate-pulse bg-slate-800" />
              )}
              {!cerrado && (
                <button
                  type="button"
                  onClick={() => borrarFoto(a)}
                  className="absolute right-1 top-1 rounded-md bg-black/60 p-1 text-rose-300 opacity-0 transition group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}

          {!cerrado && (
            <button
              type="button"
              onClick={() => archivoRef.current?.click()}
              disabled={subiendo}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-600 text-xs text-slate-400 transition hover:border-sky-500/60 hover:text-sky-300 disabled:opacity-50"
            >
              <Camera size={20} />
              {subiendo ? 'Subiendo…' : 'Agregar'}
            </button>
          )}
        </div>

        <input
          ref={archivoRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={subirFotos}
          className="hidden"
        />

        {adjuntos.length === 0 && cerrado && (
          <p className="text-sm text-slate-500">Se cerró sin fotos.</p>
        )}
      </Card>

      {/* ------------------------------------------------ Cierre */}
      {t.estado === 'en_proceso' && (
        <Card title="Cerrar el ticket" icon={Check}>
          <form onSubmit={cerrarTicket} className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Verificación antes de irse
              </p>
              {puntos.map((p) => (
                <label
                  key={p.clave}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-700 p-3 text-sm text-slate-200 transition active:bg-slate-800/60"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(cierre.checklist[p.clave])}
                    onChange={(e) =>
                      setCierre((c) => ({
                        ...c,
                        checklist: { ...c.checklist, [p.clave]: e.target.checked },
                      }))
                    }
                    className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500"
                  />
                  {p.label}
                </label>
              ))}

              {faltan > 0 && (
                <p className="text-[11px] text-amber-300">
                  Quedan {faltan} sin marcar. Se puede cerrar igual, pero queda registrado así.
                </p>
              )}
            </div>

            <Field label="Qué se hizo" hint="Lo que el próximo técnico necesita saber">
              <Textarea
                rows={3}
                value={cierre.solucion}
                onChange={(e) => setCierre((c) => ({ ...c, solucion: e.target.value }))}
              />
            </Field>

            <Field label="Material usado" hint="Metros de fibra, conectores, rosetas">
              <Textarea
                rows={2}
                value={cierre.material_usado}
                onChange={(e) => setCierre((c) => ({ ...c, material_usado: e.target.value }))}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Quién firma">
                <Input
                  value={cierre.firmante_nombre}
                  onChange={(e) => setCierre((c) => ({ ...c, firmante_nombre: e.target.value }))}
                />
              </Field>
              <Field label="Cédula de quien firma">
                <Input
                  value={cierre.firmante_cedula}
                  onChange={(e) => setCierre((c) => ({ ...c, firmante_cedula: e.target.value }))}
                />
              </Field>
            </div>

            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">
                Firma de conformidad
              </p>
              <FirmaDigital
                valor={cierre.firma_b64}
                onCambio={(v) => setCierre((c) => ({ ...c, firma_b64: v }))}
              />
            </div>

            {!cierre.firma_b64 && (
              <Aviso tipo="alerta">
                Sin la firma del abonado el ticket no se cierra: es lo que respalda que el trabajo
                se hizo y que quedó conforme.
              </Aviso>
            )}

            <Button
              type="submit"
              variante="primario"
              icon={Check}
              cargando={guardando}
              disabled={!cierre.firma_b64}
              className="w-full"
            >
              Cerrar como resuelto
            </Button>
          </form>
        </Card>
      )}

      {/* ------------------------------------------------ Cerrado */}
      {t.estado === 'resuelto' && (
        <Card title="Cierre" icon={Check}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Dato etiqueta="Resuelto" valor={fechaHora(t.cerrado_at)} />
            <Dato etiqueta="Firmó" valor={[t.firmante_nombre, t.firmante_cedula].filter(Boolean).join(' · ')} />
          </dl>

          {t.solucion && (
            <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-900/60 p-3 text-sm text-slate-200">
              {t.solucion}
            </p>
          )}

          {t.material_usado && (
            <p className="mt-2 text-xs text-slate-400">Material: {t.material_usado}</p>
          )}

          <ul className="mt-3 space-y-1">
            {puntos.map((p) => (
              <li key={p.clave} className="flex items-center gap-2 text-xs">
                {t.checklist?.[p.clave] ? (
                  <Check size={13} className="text-emerald-400" />
                ) : (
                  <X size={13} className="text-slate-600" />
                )}
                <span className={t.checklist?.[p.clave] ? 'text-slate-300' : 'text-slate-600'}>
                  {p.label}
                </span>
              </li>
            ))}
          </ul>

          {t.firma_b64 && (
            <div className="mt-4">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">
                Conformidad del abonado
              </p>
              <img
                src={t.firma_b64}
                alt="Firma del abonado"
                className="w-full max-w-xs rounded-lg border border-slate-700 bg-white"
              />
            </div>
          )}
        </Card>
      )}

      {/* ------------------------------------------------ Historial */}
      <Card title="Historial" icon={User}>
        <ol className="space-y-2">
          {eventos.map((e) => (
            <li key={e.id} className="flex items-start gap-3 text-sm">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  e.estado_nuevo === 'resuelto'
                    ? 'bg-emerald-400'
                    : e.estado_nuevo === 'cancelado'
                      ? 'bg-rose-400'
                      : 'bg-sky-400'
                }`}
              />
              <span className="min-w-0">
                <b className="text-slate-200">{ESTADOS[e.estado_nuevo]?.label ?? e.estado_nuevo}</b>
                {e.estado_anterior && (
                  <span className="text-slate-500"> · venía de {ESTADOS[e.estado_anterior]?.label}</span>
                )}
                <span className="block text-[11px] text-slate-500">
                  {fechaHora(e.created_at)}
                  {e.nota ? ` — ${e.nota}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  )
}
