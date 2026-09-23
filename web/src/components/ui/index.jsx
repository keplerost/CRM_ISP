import { useEffect, useState } from 'react'
import { AlertTriangle, Info, Loader2, X, CheckCircle2 } from 'lucide-react'

/**
 * Primitivas de UI compartidas. Tailwind puro, sin librería de componentes.
 *
 * ── Por qué este archivo es el primero del rediseño ──
 *
 * Lo usan casi las cuarenta pantallas del sistema. El remapeo de paleta de
 * `tema.css` ya dejó todo en claro, pero "claro" no es lo mismo que "con el
 * tema": la tarjeta blanca de radio 18 con su sombra de dos capas, el badge sin
 * borde, la franja de marca del KPI y el encabezado con barrita solo aparecen
 * si estos componentes los usan.
 *
 * Cambiar acá es lo que hace que el sistema entero se vea como el panel nuevo
 * sin tocar las pantallas una por una.
 *
 * Las APIs no cambiaron: mismos nombres, mismos props, mismos valores
 * aceptados. Lo único que se tocó es cómo se dibujan.
 */

/**
 * `desbordable` deja salir lo que flota por fuera de la tarjeta.
 *
 * El recorte existe por el radio: sin él, el encabezado con su línea inferior
 * se sale de las esquinas redondeadas. Pero recorta TODO, y una tarjeta que
 * contiene un buscador con panel de resultados lo corta justo en su borde de
 * abajo — se ve el encabezado del panel y ninguna de las filas.
 *
 * Por eso es una decisión de quien usa la tarjeta y no del tema: solo las
 * pocas que contienen algo flotante lo piden, y las demás conservan el recorte
 * que necesitan.
 */
export function Card({
  title,
  subtitle,
  icon: Icon,
  actions,
  children,
  className = '',
  desbordable = false,
}) {
  return (
    <section className={`t-card ${desbordable ? '' : 'overflow-hidden'} ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-[rgba(15,23,42,0.06)] px-4 pt-4 pb-3 sm:px-6 sm:pt-5 sm:pb-4">
          <div className="flex min-w-0 items-center gap-3">
            {/* La barrita vertical de marca. Es `aria-hidden` porque no dice
                nada que el título no diga ya: quien escucha la pantalla no
                necesita enterarse de que hay una raya celeste. */}
            <span
              className="h-5 w-1 shrink-0 rounded-full bg-gradient-to-b from-sky-700 to-sky-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2 className="t-titulo flex items-center gap-2 text-sm font-bold text-slate-100">
                {Icon && <Icon size={15} className="text-sky-400" />}
                {title}
              </h2>
              {subtitle && <p className="mt-0.5 text-[11.5px] text-slate-500">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {/* 24 px por lado son casi el 14% de una pantalla de 360: en el teléfono
          ese relleno se le saca directamente al contenido. */}
      <div className="p-4 sm:p-6">{children}</div>
    </section>
  )
}

/**
 * El primario lleva el degradado de marca; el resto son neutros.
 *
 * Un solo color de marca para todo lo que no es un estado: si el botón de
 * guardar fuera verde y el de borrar rojo, el verde dejaría de significar "en
 * línea" y el rojo "crítico", que es lo que de verdad hay que poder leer de un
 * vistazo en una pantalla de red.
 *
 * `peligro` sí es rojo, y es la excepción correcta: ahí el color ES el estado
 * de lo que va a pasar.
 */
const VARIANTES = {
  primario:
    'bg-gradient-to-r from-sky-700 to-sky-500 hover:from-sky-800 hover:to-sky-600 text-white border-transparent shadow-[0_6px_16px_-6px_rgba(3,105,161,0.6)]',
  secundario: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border-slate-700',
  peligro: 'bg-red-600 hover:bg-red-700 text-white border-transparent',
  fantasma: 'bg-transparent hover:bg-slate-800 text-slate-300 border-transparent',
  exito: 'bg-emerald-600 hover:bg-emerald-700 text-white border-transparent',
  alerta: 'bg-amber-500 hover:bg-amber-600 text-[#0F172A] border-amber-500',
}

export function Button({
  children,
  variante = 'secundario',
  icon: Icon,
  cargando = false,
  className = '',
  ...props
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || cargando}
      className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition
        disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTES[variante]} ${className}`}
    >
      {cargando ? <Loader2 size={15} className="animate-spin" /> : Icon && <Icon size={15} />}
      {children}
    </button>
  )
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-semibold text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-600">{hint}</span>}
    </label>
  )
}

/* Fondo blanco y no gris: un campo de formulario tiene que parecer un hueco
   donde escribir, y sobre una tarjeta blanca eso se consigue con el borde, no
   con el relleno. */
const ESTILO_CAMPO =
  'w-full rounded-xl border border-slate-700 bg-white px-3 py-2 text-sm text-slate-100 ' +
  'placeholder:text-slate-600 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20'

export const Input = (props) => <input {...props} className={`${ESTILO_CAMPO} ${props.className || ''}`} />

export const Textarea = (props) => (
  <textarea {...props} className={`${ESTILO_CAMPO} ${props.className || ''}`} />
)

export const Select = ({ children, ...props }) => (
  <select {...props} className={`${ESTILO_CAMPO} ${props.className || ''}`}>
    {children}
  </select>
)

/**
 * Badges sin borde: fondo suave y texto del color.
 *
 * El borde de la versión anterior servía sobre fondo oscuro, donde un relleno
 * al 15% casi no se distingue del panel. Sobre blanco sobra: el fondo suave ya
 * recorta la pastilla, y el borde solo agrega ruido cuando hay cinco en una
 * fila de tabla.
 *
 * Y siempre con texto, nunca solo color. Un estado que se distingue únicamente
 * por el color no existe para quien no distingue ese color —ni para nadie
 * mirando el celular al sol.
 */
const COLORES_BADGE = {
  verde: 't-badge-ok',
  rojo: 't-badge-critico',
  ambar: 't-badge-aviso',
  azul: 't-badge-marca',
  gris: 't-badge-neutro',
}

export const Badge = ({ color = 'gris', children }) => (
  <span className={`t-badge ${COLORES_BADGE[color]}`}>{children}</span>
)

/**
 * Una IP que se abre en el navegador.
 *
 * Entrar al equipo del abonado es de las cosas que más se repiten en el día, y
 * hasta ahora eran cuatro clics: abrir la ficha, ir a Servicio, leer la
 * dirección y tipearla en otra pestaña. Ahora es uno.
 *
 * Tres decisiones, todas por algo:
 *
 *   · Se abre en pestaña nueva. El equipo puede tardar o no responder, y no
 *     puede costar perder la pantalla donde se estaba trabajando.
 *   · `stopPropagation`, porque estas direcciones viven dentro de filas que a
 *     su vez llevan a la ficha del abonado. Sin esto, un clic haría las dos
 *     cosas y la pestaña nueva quedaría tapada por una navegación.
 *   · Si el texto no es una IPv4, se muestra igual pero sin enlace. Un enlace
 *     a "—" o a "pendiente" solo sirve para dar error.
 *
 * `rel="noopener"` no es decorativo: sin él, la página que se abre puede
 * manipular la que la abrió a través de `window.opener`.
 */
export function EnlaceIp({ ip, puerto, esquema = 'http', className = '' }) {
  const texto = String(ip ?? '').trim()
  const esIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(texto)

  if (!esIpv4) return <span className={className}>{ip ?? '—'}</span>

  const destino = `${esquema}://${texto}${puerto ? `:${puerto}` : ''}`

  return (
    <a
      href={destino}
      target="_blank"
      rel="noopener noreferrer"
      title={`Abrir ${destino} en una pestaña nueva`}
      onClick={(e) => e.stopPropagation()}
      className={`underline decoration-dotted underline-offset-2 hover:text-sky-400 ${className}`}
    >
      {texto}
    </a>
  )
}

/** Badge de estado de una ONU/ONT. */
export function EstadoBadge({ estado }) {
  const mapa = {
    online: ['verde', 'online'],
    offline: ['gris', 'offline'],
    los: ['rojo', 'LOS'],
  }
  const [color, texto] = mapa[String(estado).toLowerCase()] ?? ['gris', estado || 'desconocido']
  return <Badge color={color}>{texto}</Badge>
}

export function Table({ columnas, filas, vacio = 'Sin datos', renderFila, bajoEncabezado }) {
  return (
    <div className="overflow-x-auto">
      <table className="t-tabla min-w-[600px]">
        <thead>
          <tr>
            {/* La clave va por posición: una columna puede ser JSX (un botón de
                ordenar) o venir vacía, y en los dos casos usarla como clave da
                duplicados. Las columnas no se reordenan, así que el índice es
                estable. */}
            {columnas.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
          {/* Una segunda fila de encabezado, para quien la necesite: la usa el
              listado de abonados para poner una casilla de búsqueda debajo de
              cada columna. Va acá y no como filas normales para que quede
              pegada al encabezado y no se mezcle con los datos. */}
          {bajoEncabezado && <tr className="bg-slate-800/40">{bajoEncabezado}</tr>}
        </thead>
        <tbody>
          {filas.length === 0 ? (
            <tr>
              <td colSpan={columnas.length} className="px-3 py-8 text-center text-slate-500">
                {vacio}
              </td>
            </tr>
          ) : (
            filas.map(renderFila)
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Banner de error. Muestra el `hint` del middleware, que es donde va la pista
 * accionable (REST API no habilitada, credenciales mal, equipo inalcanzable...).
 */
export function ErrorBanner({ error, onCerrar }) {
  if (!error) return null
  const mensaje = error.message || String(error)

  return (
    <div className="flex items-start gap-3 rounded-xl bg-[#FEF2F2] px-4 py-3 text-sm">
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-red-400">{mensaje}</p>
        {error.hint && <p className="mt-1 text-xs text-red-300">{error.hint}</p>}
        {error.detalle && (
          <pre className="t-dato mt-2 max-h-32 overflow-auto rounded-lg bg-white/70 p-2 text-[11px] text-red-300">
            {error.detalle}
          </pre>
        )}
      </div>
      {onCerrar && (
        <button onClick={onCerrar} className="shrink-0 text-red-400 hover:text-red-200">
          <X size={16} />
        </button>
      )}
    </div>
  )
}

export function Aviso({ children, tipo = 'info' }) {
  const estilos = {
    info: 'bg-[#F0F9FF] text-sky-200',
    alerta: 'bg-[#FFFBEB] text-amber-300',
    exito: 'bg-[#ECFDF5] text-emerald-300',
  }
  const Icono = { alerta: AlertTriangle, exito: CheckCircle2 }[tipo] ?? Info
  return (
    <div className={`flex items-start gap-3 rounded-xl px-4 py-3 text-sm ${estilos[tipo]}`}>
      <Icono size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export const Cargando = ({ texto = 'Cargando…' }) => (
  <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
    <Loader2 size={16} className="animate-spin" />
    {texto}
  </div>
)

export function Modal({ abierto, titulo, onCerrar, children, ancho = 'max-w-lg' }) {
  if (!abierto) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(15,23,42,0.45)] p-4 pt-16 backdrop-blur-[2px]"
      onClick={onCerrar}
    >
      <div
        className={`t-card w-full ${ancho} overflow-hidden shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-[rgba(15,23,42,0.06)] px-6 py-4">
          <h3 className="t-titulo text-sm font-bold text-slate-100">{titulo}</h3>
          <button
            onClick={onCerrar}
            aria-label="Cerrar"
            className="rounded-lg p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-100"
          >
            <X size={18} />
          </button>
        </header>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

/**
 * Pedir el motivo antes de una acción que no se deshace.
 *
 * ── Por qué es un componente y no una ventana por pantalla ──
 *
 * Anular un cobro, rechazar un pago reportado, revocar una llave y cancelar una
 * incidencia son la misma conversación: mostrar qué se está por hacer, sobre
 * qué, y pedir por qué. Seis copias de esa ventana significan que el día que
 * haya que agregar un motivo frecuente o volver el campo obligatorio, hay que
 * acordarse de las seis — y la que se olvide queda distinta sin que nadie lo
 * note hasta que alguien la usa.
 *
 * ── Por qué el motivo se guarda acá adentro ──
 *
 * Para que quien la usa no tenga que llevar ese estado. Cada pantalla abre y
 * recibe el texto ya escrito; no necesita un `useState` para algo que solo vive
 * mientras la ventana está abierta.
 *
 * @param datos          pares [etiqueta, valor] con lo que hay que mirar antes de decidir
 * @param sugerencias    motivos frecuentes; se eligen con un clic y se pueden editar
 * @param advertencia    qué va a pasar de verdad, si no es obvio
 * @param onConfirmar    recibe el motivo ya recortado
 */
export function PedirMotivo({
  abierto,
  titulo,
  etiquetaAccion = 'Confirmar',
  variante = 'peligro',
  icon,
  datos = [],
  sugerencias = [],
  advertencia = null,
  ayuda = 'Queda guardado y es lo que se le contesta al abonado si pregunta.',
  cargando = false,
  onCancelar,
  onConfirmar,
  children = null,
}) {
  const [motivo, setMotivo] = useState('')

  // Se vacía al abrir y no al cerrar: si se limpiara al cerrar, un error de red
  // que deja la ventana abierta borraría lo que la persona acaba de escribir.
  useEffect(() => {
    if (abierto) setMotivo('')
  }, [abierto])

  const listo = motivo.trim().length > 0

  return (
    <Modal abierto={abierto} titulo={titulo} onCerrar={onCancelar}>
      <div className="space-y-4">
        {datos.length > 0 && <DatosEnFicha datos={datos} />}

        {advertencia && <Aviso tipo="alerta">{advertencia}</Aviso>}

        {children}

        {sugerencias.length > 0 && (
          <div>
            <span className="mb-2 block text-xs font-semibold text-slate-400">
              Motivos frecuentes
            </span>
            <div className="flex flex-wrap gap-2">
              {sugerencias.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMotivo(m)}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition ${
                    motivo === m
                      ? 'bg-[#F0F9FF] text-sky-400'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-slate-100'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="Motivo" hint={ayuda}>
          <Textarea
            rows={3}
            autoFocus
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={
              sugerencias.length ? 'Elegí uno de arriba o escribí el tuyo…' : 'Escribí el motivo…'
            }
          />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button variante="fantasma" onClick={onCancelar}>
            Cancelar
          </Button>
          <Button
            variante={variante}
            icon={icon}
            // Sin motivo no se ejecuta. Un "Sin motivo indicado" guardado en la
            // base no le sirve a nadie dentro de tres meses.
            disabled={!listo}
            cargando={cargando}
            onClick={() => onConfirmar(motivo.trim())}
          >
            {etiquetaAccion}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** La ficha de datos de las ventanas de decisión: dos columnas, valor a la derecha. */
export function DatosEnFicha({ datos }) {
  return (
    <div className="rounded-xl bg-slate-800/60 p-3.5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {datos.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="t-dato text-right font-semibold text-slate-200">{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * Pestañas.
 *
 * `activa` y `onCambiar` viven afuera para que la pestaña abierta pueda
 * sincronizarse con la URL: al recargar o al compartir un link, la pantalla
 * tiene que abrir donde estabas y no volver a la primera.
 */
export function Tabs({ tabs, activa, onCambiar }) {
  return (
    <div className="overflow-x-auto border-b border-[rgba(15,23,42,0.06)]">
      <nav className="flex min-w-max gap-1">
        {tabs.map((t) => {
          const esta = t.clave === activa
          return (
            <button
              key={t.clave}
              type="button"
              onClick={() => onCambiar(t.clave)}
              className={`relative whitespace-nowrap px-4 py-2.5 text-[13px] font-semibold transition ${
                esta ? 'text-sky-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="flex items-center gap-2">
                {t.icon && <t.icon size={14} />}
                {t.label}
                {t.contador != null && (
                  <span className="t-dato rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {t.contador}
                  </span>
                )}
              </span>
              {esta && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-gradient-to-r from-sky-700 to-sky-400" />
              )}
            </button>
          )
        })}
      </nav>
    </div>
  )
}

/**
 * Esqueleto de carga.
 *
 * Se prefiere al spinner cuando ya se sabe qué forma va a tener el contenido:
 * dibuja el hueco del tamaño correcto y la pantalla no salta cuando llegan los
 * datos.
 */
export const Skeleton = ({ className = 'h-4 w-full' }) => (
  <div className={`animate-pulse rounded-lg bg-slate-800 ${className}`} />
)

export const SkeletonTabla = ({ filas = 5, columnas = 4 }) => (
  <div className="space-y-2">
    {Array.from({ length: filas }, (_, f) => (
      <div key={f} className="flex gap-3">
        {Array.from({ length: columnas }, (_, c) => (
          <Skeleton key={c} className={`h-8 ${c === 0 ? 'w-16' : 'flex-1'}`} />
        ))}
      </div>
    ))}
  </div>
)

/**
 * Punto de estado.
 *
 * Distingue tres cosas, no dos: "responde", "no responde" y "nadie preguntó
 * todavía". Pintar de rojo un equipo que simplemente no se consultó manda a
 * revisar una torre que está perfecta.
 */
export function Punto({ estado, titulo }) {
  const estilos = {
    online: 'bg-emerald-500',
    offline: 'bg-rose-500',
    desconocido: 'bg-slate-600',
  }
  return (
    <span
      title={titulo ?? estado}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${estilos[estado] ?? estilos.desconocido}`}
    />
  )
}

/**
 * Tarjeta de métrica del Dashboard.
 *
 * Franja de marca de 3px arriba, número grande en Sora con cifras tabulares.
 * Lo tabular no es un detalle: sin eso el ancho del número cambia con cada
 * actualización en vivo y la fila entera de KPIs se mueve sola.
 */
export function Stat({ label, valor, sub, icon: Icon, color = 'text-sky-400' }) {
  return (
    <div className="t-card relative overflow-hidden p-5">
      <span className="t-stripe" aria-hidden="true" />
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-400">{label}</span>
        {Icon && <Icon size={16} className={color} />}
      </div>
      <p className="t-kpi-valor mt-3">{valor}</p>
      {sub && <p className="mt-1.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  )
}
