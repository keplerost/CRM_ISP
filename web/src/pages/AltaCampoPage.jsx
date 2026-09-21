import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, CalendarX, Check, CloudOff, MapPin, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { enlaceMapa } from '../lib/soporte'
import { PASOS, TECNOLOGIAS, pasoAlcanzado } from '../lib/instalaciones'
import { usePermisos } from '../lib/AuthContext'
import PasoEquipo from '../components/instalaciones/pasos/PasoEquipo'
import PasoSenal from '../components/instalaciones/pasos/PasoSenal'
import PasoRed from '../components/instalaciones/pasos/PasoRed'
import PasoPruebas from '../components/instalaciones/pasos/PasoPruebas'
import PasoMateriales from '../components/instalaciones/pasos/PasoMateriales'
import PasoCierre from '../components/instalaciones/pasos/PasoCierre'
import { Aviso, Button, Cargando, ErrorBanner } from '../components/ui'
import AvisoIncidencia from '../components/tecnico/AvisoIncidencia'
import NoSePudo from '../components/instalaciones/NoSePudo'
import MarcarLlegada from '../components/instalaciones/MarcarLlegada'

/**
 * Asistente de alta en campo.
 *
 * Va fuera del layout de escritorio a propósito: se usa con una mano, en la
 * vereda, con el sol de frente. Todo el ancho de la pantalla es para el paso
 * actual, y la navegación es un botón grande abajo — donde llega el pulgar.
 *
 * Cada paso guarda contra el servidor apenas termina. El técnico se queda sin
 * señal a mitad del trabajo con una frecuencia que sorprende a quien nunca
 * salió a instalar; cuando vuelve a entrar tiene que retomar donde estaba y no
 * empezar de cero.
 */
export default function AltaCampoPage() {
  const { id } = useParams()
  const navegar = useNavigate()
  const { puede } = usePermisos()

  /**
   * A dónde vuelve al terminar.
   *
   * El asistente lo usan dos personas distintas: el técnico desde el celular y
   * quien administra desde la computadora. Mandarlos al mismo lado deja a uno de
   * los dos en el marco equivocado — y al técnico, en un menú lateral de 240 px
   * que en su teléfono no entra.
   *
   * `instalaciones.ver` es lo que los separa: quien ve TODAS las instalaciones
   * trabaja desde el escritorio; quien solo ve las suyas, desde la calle.
   */
  const volverA = puede('instalaciones.ver') ? '/clientes/instalaciones' : '/campo/ordenes'
  const esDeCampo = volverA === '/campo/ordenes'

  const [orden, setOrden] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [paso, setPaso] = useState(null)
  const [error, setError] = useState(null)
  const [alta, setAlta] = useState(null)
  const [pendienteDeEnviar, setPendienteDeEnviar] = useState(false)
  const [noSePudo, setNoSePudo] = useState(false)
  const [fallida, setFallida] = useState(null)

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_instalaciones')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (err) setError(err)
    setOrden(data ?? null)
    setCargando(false)
    return data
  }, [id])

  useEffect(() => {
    recargar()
  }, [recargar])

  // El paso inicial se calcula una sola vez, y de los datos y no del contador:
  // si el trabajo quedó a medias, el asistente abre donde de verdad se cortó.
  useEffect(() => {
    if (orden && paso == null) setPaso(pasoAlcanzado(orden))
  }, [orden, paso])

  /** Después de guardar, el paso avanza solo: una pantalla menos que tocar. */
  const avanzar = useCallback(async () => {
    await recargar()
    setPaso((p) => Math.min(p + 1, PASOS.length))
  }, [recargar])

  async function finalizado(clientId) {
    setAlta(clientId)
    await recargar()
  }

  /**
   * El cierre quedó en la cola porque no había señal.
   *
   * No se muestra la pantalla de "alta cerrada": el abonado todavía no existe.
   * Lo que se dice es la verdad —quedó guardado y sale solo— y se vuelve al
   * listado, que es lo que el técnico necesita para seguir con el próximo
   * trabajo.
   */
  async function encolado() {
    setPendienteDeEnviar(true)
    await recargar()
  }

  if (cargando) return <Cargando texto="Cargando la orden…" />

  if (!orden) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />
        <Aviso tipo="alerta">No existe esa orden de trabajo.</Aviso>
        <Link to={volverA} className="text-sm text-sky-400 hover:underline">
          Volver a Instalaciones
        </Link>
      </div>
    )
  }

  /* --- La visita quedó sin hacer ------------------------------------------
   *
   * Pantalla propia y en ámbar, distinta de la del alta completada y también de
   * la de "guardado en el teléfono". Son tres finales distintos y el técnico
   * tiene que poder distinguirlos de un vistazo: terminó, falta enviar, o no se
   * pudo. Con el mismo tilde verde para los tres, se va convencido de lo que no
   * pasó.
   */
  if (fallida) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-amber-500/15 text-amber-400">
          <CalendarX size={30} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">
            {fallida.reprogramada_para ? 'Reagendada' : 'Marcada sin hacer'}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {fallida.reprogramada_para
              ? `Quedó para el ${new Date(`${fallida.reprogramada_para}T12:00:00`).toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' })}. Va a aparecer en tu ruta de ese día.`
              : 'La oficina la va a ver como detenida, con el motivo que cargaste, y decide cuándo se retoma.'}
          </p>
          {fallida.encolado && (
            <p className="mt-3 text-[13px] text-amber-300/90">
              Sin señal: quedó guardada en el teléfono y se envía sola.
            </p>
          )}
        </div>
        <Link to={volverA} className="rounded-xl bg-slate-800 py-3 text-sm font-medium text-slate-200">
          Volver a mis trabajos
        </Link>
      </div>
    )
  }

  /* --- El cierre quedó esperando señal ------------------------------------
   *
   * Pantalla propia, y deliberadamente distinta de la de "alta cerrada". La
   * tentación es reusar la del tilde verde y cambiarle el texto: el técnico
   * mira el tilde, no lee, y se va convencido de que el abonado quedó activo.
   *
   * Acá el ícono es una nube tachada y el color es ámbar, no verde. Lo que pasó
   * es bueno —no se perdió nada— pero no está terminado.
   */
  if (pendienteDeEnviar) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-amber-500/15 text-amber-400">
          <CloudOff size={30} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Guardado en el teléfono</h1>
          <p className="mt-2 text-sm text-slate-400">
            No hay señal, así que el alta todavía no llegó al sistema. Se envía sola en cuanto
            vuelva la conexión — no hace falta que hagas nada.
          </p>
          <p className="mt-3 text-[13px] text-amber-300/90">
            El abonado no está activo hasta que se envíe.
          </p>
        </div>
        <Link
          to="/campo"
          className="rounded-xl bg-slate-800 py-3 text-sm font-medium text-slate-200"
        >
          Volver a mis trabajos
        </Link>
      </div>
    )
  }

  // --- Alta cerrada ---------------------------------------------------------
  if (alta || (orden.estado === 'hecha' && orden.client_id)) {
    const clientId = alta ?? orden.client_id
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Check size={32} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Alta completada</h1>
          <p className="mt-2 text-sm text-slate-400">
            {orden.titular} ya es un usuario activo. Su ficha quedó con el plan, la IP y los datos de
            conexión que se configuraron acá.
          </p>
        </div>
        <div className="space-y-2">
          {!esDeCampo && (
            <Button
              variante="primario"
              className="w-full"
              onClick={() => navegar(`/clientes/${clientId}`)}
            >
              Abrir la ficha del abonado
            </Button>
          )}
          <Button className="w-full" onClick={() => navegar(volverA)}>
            Volver a Instalaciones
          </Button>
        </div>
      </div>
    )
  }

  const actual = PASOS.find((p) => p.n === paso) ?? PASOS[0]
  const mapa = enlaceMapa(orden)

  const comunes = { orden, onError: setError }

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950">
      {/* Cabecera fija: quién es y dónde queda, que es lo que el técnico
          necesita a la vista todo el tiempo. */}
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">{orden.titular}</p>
            <p className="truncate text-[11px] text-slate-500">
              {TECNOLOGIAS[orden.tecnologia ?? 'ftth'].label}
              {orden.direccion ? ` · ${orden.direccion}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {mapa && (
              <a
                href={mapa}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                aria-label="Cómo llegar"
              >
                <MapPin size={18} />
              </a>
            )}
            {/* La X sale del asistente. Al técnico lo devuelve a sus órdenes;
                a quien administra, a la ficha completa de la orden — que es de
                donde entró y donde están los datos que el asistente no muestra. */}
            <Link
              to={esDeCampo ? '/campo/ordenes' : `/clientes/instalaciones/${orden.id}`}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              aria-label="Salir del asistente"
            >
              <X size={18} />
            </Link>
          </div>
        </div>

        {/* Los pasos se pueden tocar para volver: revisar la potencia después
            de haber configurado la red es algo que se hace todo el tiempo. */}
        <nav className="mx-auto mt-3 flex max-w-2xl gap-1.5">
          {PASOS.map((p) => {
            const hecho = p.n < paso
            const aqui = p.n === paso
            return (
              <button
                key={p.n}
                type="button"
                onClick={() => setPaso(p.n)}
                className={`flex-1 rounded-full py-1 text-[10px] font-medium transition ${
                  aqui
                    ? 'bg-sky-500/20 text-sky-300'
                    : hecho
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'bg-slate-800/60 text-slate-500'
                }`}
              >
                {p.corto}
              </button>
            )
          })}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 p-4">
        {/* Si la zona de este abonado está caída, se dice antes de cualquier
            paso. En una instalación nueva el aviso rara vez aplica —el cliente
            todavía no está colgado de nada— pero en un traslado o una revisión
            sobre un abonado existente es lo que evita el viaje. */}
        <AvisoIncidencia clientId={orden.client_id} />

        {/* Antes que el primer paso: es lo que se toca al bajar de la
            camioneta, y si queda al final nadie lo marca. Una vez marcado se
            convierte en la constancia de la hora, no en un botón repetible. */}
        <MarcarLlegada orden={orden} onError={setError} onMarcada={recargar} />

        <div>
          <p className="text-[11px] uppercase tracking-wider text-slate-500">
            Paso {actual.n} de {PASOS.length}
          </p>
          <h1 className="t-titulo text-lg font-bold text-slate-100">{actual.titulo}</h1>
        </div>

        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {paso === 1 && <PasoEquipo {...comunes} onGuardado={avanzar} />}
        {paso === 2 && <PasoSenal {...comunes} onGuardado={recargar} />}
        {paso === 3 && <PasoRed {...comunes} onGuardado={recargar} />}
        {paso === 4 && <PasoPruebas {...comunes} onGuardado={recargar} />}
        {paso === 5 && <PasoMateriales {...comunes} onGuardado={recargar} />}
        {paso === 6 && (
          <PasoCierre {...comunes} onFinalizado={finalizado} onEncolado={encolado} />
        )}
      </main>

      {/* Navegación abajo, donde llega el pulgar con el teléfono en una mano. */}
      <footer className="sticky bottom-0 border-t border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-2">
          <Button
            icon={ArrowLeft}
            onClick={() => setPaso((p) => Math.max(1, p - 1))}
            disabled={paso === 1}
            className="flex-1"
          >
            Atrás
          </Button>
          <Button
            variante="primario"
            icon={ArrowRight}
            onClick={() => setPaso((p) => Math.min(PASOS.length, p + 1))}
            disabled={paso === PASOS.length}
            className="flex-1"
          >
            Siguiente
          </Button>
        </div>

        {/* Debajo de la navegación y en texto, no como botón grande: es la
            salida para cuando el trabajo no se puede hacer, no una opción al
            mismo nivel que avanzar. Pero tiene que estar a la vista — si hay
            que buscarla, el técnico llama a la oficina y la orden queda
            colgada, que es como estaba antes. */}
        <div className="mx-auto mt-2 max-w-2xl text-center">
          <button
            type="button"
            onClick={() => setNoSePudo(true)}
            className="text-[12px] text-amber-500/90 underline-offset-2 hover:underline"
          >
            No se pudo hacer el trabajo
          </button>
        </div>
      </footer>

      {noSePudo && (
        <NoSePudo
          orden={orden}
          onCerrar={() => setNoSePudo(false)}
          onError={setError}
          onGuardado={async (r) => {
            setNoSePudo(false)
            setFallida(r)
            await recargar()
          }}
        />
      )}
    </div>
  )
}
