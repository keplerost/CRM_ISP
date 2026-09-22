import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Gauge, LogOut, Map, Monitor, Phone, Route, Shield, User, Wrench } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth, usePermisos } from '../../lib/AuthContext'
import { nombreRol } from '../../lib/permisos'
import { APPS_MAPA, useMapaPreferido } from '../../lib/mapaPreferido'
import { OPTICA, RADIO } from '../../lib/instalaciones'
import EstadoSinConexion from '../../components/tecnico/EstadoSinConexion'

/**
 * El perfil del técnico.
 *
 * ── Qué hace acá dentro ──
 *
 * Tres cosas que el técnico necesita resolver solo, en la calle, sin llamar a
 * la oficina: saber con qué números lo están midiendo, salir de la sesión si
 * presta el teléfono, y ver de un vistazo qué puede y qué no.
 *
 * Los umbrales están a la vista y en modo lectura. Es información suya —es el
 * estándar contra el que se juzga su trabajo— y no poder verlos convierte el
 * semáforo en algo arbitrario. Cambiarlos no puede: la migración 84 no le da
 * política de escritura, así que ni siquiera hay un botón que después falle.
 */
export default function PerfilPage() {
  const { perfil } = usePermisos()
  const { cerrarSesion } = useAuth()
  const [almacen, setAlmacen] = useState(null)

  useEffect(() => {
    if (!perfil?.tecnico_id) return
    supabase
      .from('almacenes')
      .select('nombre')
      .eq('tecnico_id', perfil.tecnico_id)
      .maybeSingle()
      .then(({ data }) => setAlmacen(data?.nombre ?? null))
  }, [perfil?.tecnico_id])

  const iniciales = `${perfil?.nombre?.[0] ?? ''}${perfil?.apellido?.[0] ?? ''}`.toUpperCase()

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <section className="t-card p-4 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-sky-600/20 text-xl font-semibold text-sky-300">
          {iniciales || <User size={26} />}
        </div>
        <p className="mt-2 text-[17px] font-semibold text-slate-100">
          {`${perfil?.nombre ?? ''} ${perfil?.apellido ?? ''}`.trim() || 'Sin nombre'}
        </p>
        <p className="text-[12px] text-slate-500">{nombreRol(perfil?.rol)}</p>

        <div className="mt-3 space-y-1 text-left text-[13px]">
          <Dato icono={Phone} label="Celular" valor={perfil?.celular} />
          <Dato icono={User} label="Usuario" valor={perfil?.usuario} />
          <Dato
            icono={Wrench}
            label="Almacén"
            valor={almacen}
            // Sin almacén no puede descontar material, y eso se descubre en
            // medio de una instalación si no se dice acá.
            aviso={perfil?.tecnico_id && !almacen ? 'Pedí que te creen el almacén' : null}
          />
        </div>
      </section>

      {/* Antes de los umbrales: es lo que hay que poder comprobar ANTES de
          salir a una zona sin cobertura, no después. */}
      <EstadoSinConexion />

      <section className="t-card p-4">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          <Shield size={12} /> Con qué se mide tu trabajo
        </p>
        <div className="space-y-1.5 text-[12px]">
          <Umbral
            titulo="Fibra"
            texto={`Óptimo entre ${OPTICA.saturado} y ${OPTICA.optimo} dBm · atenuado por debajo de ${OPTICA.limite} dBm`}
          />
          <Umbral
            titulo="Radio"
            texto={`Óptimo sobre ${RADIO.optimo} dBm con más de ${RADIO.ccqMinimo}% de CCQ · malo bajo ${RADIO.limite} dBm`}
          />
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          Los define la empresa. Si cambian, esta pantalla y el semáforo cambian juntos.
        </p>
      </section>

      <ElegirMapa />

      <section className="t-card p-2">
        <Link
          to="/campo/jornada"
          className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-slate-300 active:bg-slate-800"
        >
          <Route size={17} className="text-slate-500" />
          Mi jornada y combustible
        </Link>
        <Link
          to="/campo/desempeno"
          className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-slate-300 active:bg-slate-800"
        >
          <Gauge size={17} className="text-slate-500" />
          Mi desempeño
        </Link>
        {/* La app de escritorio sigue existiendo y a veces hace falta: una
            pantalla grande para revisar una orden vieja. No se esconde. */}
        <Link
          // Con el parámetro, porque desde un teléfono "/" rebota de vuelta a
          // la app de campo. Sin él, este botón no haría nada.
          to="/?escritorio=1"
          className="flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] text-slate-300 active:bg-slate-800"
        >
          <Monitor size={17} className="text-slate-500" />
          Ver la versión de escritorio
        </Link>
        <button
          type="button"
          onClick={cerrarSesion}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[14px] text-rose-400 active:bg-slate-800"
        >
          <LogOut size={17} />
          Cerrar sesión
        </button>
      </section>
    </div>
  )
}

const Dato = ({ icono: Icono, label, valor, aviso }) => (
  <div className="flex items-center gap-2 t-panel px-3 py-2">
    <Icono size={14} className="shrink-0 text-slate-600" />
    <span className="text-slate-500">{label}</span>
    <span className="ml-auto text-right text-slate-200">
      {valor ?? <span className="text-slate-600">—</span>}
      {aviso && <span className="block text-[10px] text-amber-400">{aviso}</span>}
    </span>
  </div>
)

const Umbral = ({ titulo, texto }) => (
  <div className="t-panel px-3 py-2">
    <p className="text-slate-300">{titulo}</p>
    <p className="text-[11px] text-slate-500">{texto}</p>
  </div>
)

/**
 * Con qué aplicación abre las direcciones.
 *
 * Va en Perfil y no al lado de cada botón "Llegar" porque se elige una vez y
 * después se olvida: agregarle un menú a la acción más repetida del día son
 * cuarenta toques por semana para elegir siempre lo mismo.
 */
function ElegirMapa() {
  const { app, setApp } = useMapaPreferido()

  /**
   * `geo:` lo ignora iOS.
   *
   * En iPhone, "Preguntar cada vez" no abre nada — y un botón que no hace nada
   * es peor que no tener la opción. Se detecta por el navegador, que para esto
   * alcanza: lo que se decide no es una función crítica, es si mostrar una
   * tercera opción.
   */
  const esIOS =
    typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)

  const opciones = APPS_MAPA.filter((a) => !(a.soloAndroid && esIOS))

  return (
    <section className="t-card p-4">
      <p className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Map size={12} /> Abrir direcciones con
      </p>
      <p className="mb-3 text-[11px] leading-snug text-slate-500">
        Vale para este teléfono. El botón "Llegar" de todas las pantallas lo respeta.
      </p>

      <div className="grid gap-2">
        {opciones.map((o) => (
          <button
            key={o.clave}
            type="button"
            onClick={() => setApp(o.clave)}
            aria-pressed={app === o.clave}
            className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-[14px] transition ${
              app === o.clave
                ? 'bg-[#F0F9FF] font-semibold text-sky-400'
                : 'bg-slate-800 text-slate-300 active:bg-slate-700'
            }`}
          >
            {o.label}
            {app === o.clave && <span className="text-[11px]">elegido</span>}
          </button>
        ))}
      </div>

      {app === 'sistema' && (
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          El teléfono va a mostrar su propia lista con las aplicaciones de mapas que tengas
          instaladas.
        </p>
      )}
    </section>
  )
}
