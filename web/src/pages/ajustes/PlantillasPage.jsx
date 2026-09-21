import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Eye, FileText, Globe, Lock, Mail, MessageSquare, Pencil, Plus, Save, Trash2,
} from 'lucide-react'
import {
  Aviso, Badge, Button, Card, ErrorBanner, Field, Input, Modal, Select, SkeletonTabla, Tabs,
  Textarea,
} from '../../components/ui'
import {
  CATEGORIAS, EJEMPLO, aplicar, marcadoresDe, marcadoresSinValor, plantillasApi,
} from '../../lib/plantillas'
import { api } from '../../lib/apiNetwork'

/**
 * El editor de plantillas.
 *
 * ── Qué se decide acá ──
 *
 * Todo lo que el sistema le dice al abonado, en sus palabras y no en las que
 * vinieron de fábrica. Hasta ahora esos textos vivían en tres lugares —algunos
 * en la base, otros escritos adentro del código, otros en columnas de
 * configuración— y varios directamente no se podían cambiar.
 *
 * ── Por qué la vista previa está al lado y no en otra pantalla ──
 *
 * Porque lo que hay que juzgar al escribir un aviso de corte es cómo suena
 * ENTERO, con el nombre largo de un abonado de verdad y un monto con decimales.
 * Un editor que muestra `{{nombre}}` y `{{saldo}}` deja ver la estructura y
 * esconde lo único que importa: si el mensaje se entiende.
 */

const ICONO = { documento: FileText, correo: Mail, sms: MessageSquare, web: Globe }

export default function PlantillasPage() {
  const [plantillas, setPlantillas] = useState(null)
  const [categoria, setCategoria] = useState('documento')
  const [editando, setEditando] = useState(null)
  const [viendo, setViendo] = useState(null)
  const [error, setError] = useState(null)

  const recargar = () => plantillasApi.listar().then(setPlantillas).catch(setError)

  useEffect(() => {
    recargar()
  }, [])

  const deLaCategoria = useMemo(
    () => (plantillas ?? []).filter((p) => p.categoria === categoria),
    [plantillas, categoria],
  )

  if (error && !plantillas) return <ErrorBanner error={error} onCerrar={() => setError(null)} />
  if (!plantillas) return <SkeletonTabla filas={8} columnas={3} />

  const cat = CATEGORIAS.find((c) => c.clave === categoria)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Editor de plantillas</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Todo lo que el sistema le dice al abonado: documentos, correos, mensajes y páginas web.
          Los <code className="text-slate-400">{'{{marcadores}}'}</code> se reemplazan al enviar.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Tabs
        activa={categoria}
        onCambiar={setCategoria}
        tabs={CATEGORIAS.map((c) => ({
          clave: c.clave,
          label: c.nombre,
          icon: ICONO[c.clave],
          contador: (plantillas ?? []).filter((p) => p.categoria === c.clave).length,
        }))}
      />

      <p className="text-xs leading-snug text-slate-500">{cat?.para}</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {deLaCategoria.map((p) => (
          <Tarjeta
            key={p.id}
            plantilla={p}
            onEditar={() => setEditando(p)}
            onVer={() => setViendo(p)}
          />
        ))}

        {/* Crear una propia solo tiene sentido donde el ISP manda textos suyos.
            Un documento o una página web sin código que la use no se muestra en
            ningún lado, y sería un botón que produce algo invisible. */}
        {['correo', 'sms'].includes(categoria) && (
          <button
            type="button"
            onClick={() =>
              setEditando({
                categoria,
                canal: categoria === 'correo' ? 'email' : 'sms',
                formato: categoria === 'correo' ? 'html' : 'texto',
                nombre: '',
                cuerpo: '',
                activa: true,
                del_sistema: false,
              })
            }
            className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500 hover:border-slate-500 hover:text-slate-300"
          >
            <Plus size={15} className="mr-1.5" />
            Nueva plantilla
          </button>
        )}
      </div>

      {editando && (
        <Editor
          plantilla={editando}
          onCerrar={() => setEditando(null)}
          onGuardado={() => {
            setEditando(null)
            recargar()
          }}
          onError={setError}
        />
      )}

      {viendo && <VistaPrevia plantilla={viendo} onCerrar={() => setViendo(null)} />}
    </div>
  )
}

/** Una plantilla, con sus dos acciones al pasar el mouse. */
function Tarjeta({ plantilla: p, onEditar, onVer }) {
  const sinValor = marcadoresSinValor(`${p.asunto ?? ''} ${p.cuerpo ?? ''}`)

  return (
    <div className="group relative t-card-sm p-3 transition hover:border-slate-600">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-100">{p.nombre}</p>
        {p.del_sistema && (
          <span title="La usa el sistema: se puede editar, no borrar">
            <Lock size={12} className="mt-1 shrink-0 text-slate-600" />
          </span>
        )}
      </div>

      <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-slate-500">
        {p.descripcion || p.cuerpo}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {!p.activa && <Badge color="gris">desactivada</Badge>}
        {p.canal !== 'documento' && p.canal !== 'web' && <Badge color="azul">{p.canal}</Badge>}
        {/* Un marcador sin valor sale crudo en el mensaje: el abonado recibe
            "Estimado {{nombre}}". Se avisa acá y no al enviar. */}
        {sinValor.length > 0 && (
          <Badge color="ambar" title={`Sin valor: ${sinValor.join(', ')}`}>
            {sinValor.length} sin datos
          </Badge>
        )}
      </div>

      {/* Aparecen al pasar el mouse, como pidió el pedido, pero siguen siendo
          alcanzables con el teclado: `focus-within` las mantiene visibles. */}
      <div className="mt-2 flex gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={onEditar}
          title="Editar plantilla"
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
        >
          <Pencil size={11} /> Editar
        </button>
        <button
          type="button"
          onClick={onVer}
          title="Vista previa"
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
        >
          <Eye size={11} /> Vista previa
        </button>
      </div>
    </div>
  )
}

function Editor({ plantilla, onCerrar, onGuardado, onError }) {
  const [form, setForm] = useState(plantilla)
  const [guardando, setGuardando] = useState(false)
  const [borrando, setBorrando] = useState(false)

  const cambiar = (campo, v) => setForm((f) => ({ ...f, [campo]: v }))

  const guardar = async () => {
    setGuardando(true)
    try {
      await plantillasApi.guardar(form)
      onGuardado()
    } catch (e) {
      onError(e)
    } finally {
      setGuardando(false)
    }
  }

  const borrar = async () => {
    setBorrando(true)
    try {
      await plantillasApi.borrar(form.id)
      onGuardado()
    } catch (e) {
      onError(e)
    } finally {
      setBorrando(false)
    }
  }

  const usados = marcadoresDe(`${form.asunto ?? ''} ${form.cuerpo ?? ''}`)
  const sinValor = marcadoresSinValor(`${form.asunto ?? ''} ${form.cuerpo ?? ''}`)
  const esSms = form.categoria === 'sms'
  const largo = (form.cuerpo ?? '').length

  return (
    <Modal abierto titulo={form.nombre || 'Nueva plantilla'} onCerrar={onCerrar} ancho="max-w-4xl">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Nombre">
            <Input value={form.nombre ?? ''} onChange={(e) => cambiar('nombre', e.target.value)} />
          </Field>

          {form.descripcion != null && (
            <Field label="Para qué sirve">
              <Textarea
                rows={2}
                value={form.descripcion ?? ''}
                onChange={(e) => cambiar('descripcion', e.target.value)}
              />
            </Field>
          )}

          {form.categoria !== 'documento' && (
            <Field label="Por dónde se manda">
              <Select value={form.canal} onChange={(e) => cambiar('canal', e.target.value)}>
                {form.categoria === 'web' ? (
                  <option value="web">Página web</option>
                ) : (
                  <>
                    <option value="email">Correo</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="telegram">Telegram</option>
                    <option value="sms">SMS</option>
                    <option value="cualquiera">Cualquiera</option>
                  </>
                )}
              </Select>
            </Field>
          )}

          {(form.categoria === 'correo' || form.categoria === 'web') && (
            <Field label={form.categoria === 'web' ? 'Título de la página' : 'Asunto'}>
              <Input value={form.asunto ?? ''} onChange={(e) => cambiar('asunto', e.target.value)} />
            </Field>
          )}

          <Field
            label="Texto"
            hint={
              esSms
                ? `${largo} caracteres · un SMS son 160; más largo llega partido en dos`
                : 'Los {{marcadores}} se reemplazan al enviar'
            }
          >
            <Textarea
              rows={12}
              value={form.cuerpo ?? ''}
              onChange={(e) => cambiar('cuerpo', e.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          {/* El aviso del SMS largo va acá y no al enviar: al enviar ya se
              cobraron los dos tramos. */}
          {esSms && largo > 160 && (
            <Aviso tipo="alerta">
              <AlertTriangle size={13} className="mr-1 inline" />
              {largo} caracteres: se va a cobrar como {Math.ceil(largo / 160)} mensajes y el abonado
              lo recibe partido.
            </Aviso>
          )}

          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={form.activa !== false}
              onChange={(e) => cambiar('activa', e.target.checked)}
            />
            Activa
          </label>
        </div>

        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-wider text-slate-500">
              Marcadores disponibles
            </p>
            <div className="flex flex-wrap gap-1">
              {Object.keys(EJEMPLO).map((v) => (
                <button
                  key={v}
                  type="button"
                  title={`Ejemplo: ${EJEMPLO[v]}`}
                  onClick={() => cambiar('cuerpo', `${form.cuerpo ?? ''}{{${v}}}`)}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                    usados.includes(v)
                      ? 'border-sky-800 bg-[#F0F9FF] text-sky-300'
                      : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {sinValor.length > 0 && (
            <Aviso tipo="alerta">
              <AlertTriangle size={13} className="mr-1 inline" />
              {sinValor.map((m) => `{{${m}}}`).join(', ')} no tiene con qué llenarse: va a salir tal
              cual en el mensaje.
            </Aviso>
          )}

          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-wider text-slate-500">
              Así lo recibe el abonado
            </p>
            <Render plantilla={form} />
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3">
        <div>
          {form.id && !form.del_sistema && (
            <Button variante="fantasma" icon={Trash2} cargando={borrando} onClick={borrar}>
              Borrar
            </Button>
          )}
          {form.del_sistema && (
            <p className="text-[11px] text-slate-500">
              <Lock size={11} className="mr-1 inline" />
              La usa el sistema: se puede editar y desactivar, no borrar.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button variante="fantasma" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            icon={Save}
            cargando={guardando}
            disabled={!form.nombre || !form.cuerpo}
            onClick={guardar}
          >
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function VistaPrevia({ plantilla, onCerrar }) {
  return (
    <Modal abierto titulo={`Vista previa · ${plantilla.nombre}`} onCerrar={onCerrar} ancho="max-w-2xl">
      <p className="mb-3 text-[11px] text-slate-500">
        Con datos de ejemplo. Así lo va a recibir el abonado.
      </p>
      <Render plantilla={plantilla} />
    </Modal>
  )
}

/**
 * Las plantillas cuyo correo sale como tarjeta.
 *
 * Para estas, mostrar solo el cuerpo engaña: el logo, la tabla de datos, las
 * cuentas y el botón los pone el sistema, así que la previa tiene que pedirle el
 * correo entero al servidor.
 */
const CON_TARJETA = {
  mail_factura_generada: 'nueva',
  mail_aviso_pago_1: 'recordatorio',
  mail_aviso_pago_2: 'vencida',
  mail_aviso_pago_3: 'ultimo',
}

/** El texto con los marcadores ya reemplazados. */
function Render({ plantilla: p }) {
  const asunto = aplicar(p.asunto)
  const cuerpo = aplicar(p.cuerpo)

  const tipo = CON_TARJETA[p.clave]
  if (tipo) return <RenderCorreo plantilla={p} tipo={tipo} />

  return (
    <div className="t-panel p-3">
      {asunto && (
        <p className="mb-2 border-b border-slate-800 pb-2 text-sm font-medium text-slate-100">
          {asunto}
        </p>
      )}

      {p.formato === 'html' ? (
        /**
         * El HTML se muestra renderizado porque es como lo va a ver el abonado.
         *
         * Va en un `iframe` con `sandbox` y no inyectado en la página: aunque el
         * texto lo escriba alguien de la casa, un `<script>` pegado sin querer
         * desde un editor de correo se ejecutaría con la sesión del que está
         * mirando. Adentro del sandbox no puede hacer nada.
         */
        <iframe
          title="Vista previa"
          sandbox=""
          srcDoc={`<style>body{font-family:system-ui,sans-serif;font-size:14px;color:#e2e8f0;background:#020617;margin:0;padding:8px}</style>${cuerpo}`}
          className="h-64 w-full rounded border-0 bg-[#F6F8FB]"
        />
      ) : (
        <pre className="whitespace-pre-wrap font-sans text-sm text-slate-300">{cuerpo}</pre>
      )}
    </div>
  )
}

/**
 * El correo entero, como va a llegarle al abonado.
 *
 * ── Por qué lo arma el servidor y no esta pantalla ──
 *
 * Porque la tarjeta se construye con el logo, las cuentas de pago y el WhatsApp
 * que el ISP tiene cargados, y con el PDF de una factura. Rearmarla en el
 * navegador sería mantener dos versiones del mismo correo, y el día que se
 * separen la previa mostraría algo que no es lo que se envía — que es peor que
 * no tener previa.
 */
function RenderCorreo({ plantilla: p, tipo }) {
  const [previa, setPrevia] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let vigente = true
    setPrevia(null)
    setError(null)

    api.comunicaciones
      .vistaPreviaCorreo({ cuerpo: p.cuerpo, asunto: p.asunto, tipo })
      .then((r) => vigente && setPrevia(r))
      .catch((e) => vigente && setError(e))

    return () => {
      vigente = false
    }
  }, [p.cuerpo, p.asunto, tipo])

  if (error) {
    return (
      <Aviso>
        No se pudo armar la vista previa: {error.message}. El middleware tiene que estar corriendo.
      </Aviso>
    )
  }

  if (!previa) return <p className="p-4 text-sm text-slate-500">Armando el correo…</p>

  return (
    <div className="space-y-2">
      <div className="t-panel p-3">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">Asunto</p>
        <p className="text-sm font-medium text-slate-100">{previa.asunto}</p>
      </div>

      {/*
        Fondo claro y no el de la app: el correo se ve sobre blanco en Gmail, y
        juzgar los colores sobre el fondo oscuro del sistema lleva a elegir mal.
      */}
      <iframe
        title="Vista previa del correo"
        sandbox=""
        srcDoc={previa.html}
        className="h-[520px] w-full rounded-lg border border-slate-800 bg-white"
      />

      <p className="text-[11px] text-slate-500">
        {previa.abonado ? `Con los datos de ${previa.abonado}. ` : ''}
        {previa.adjuntos?.length
          ? `Se adjunta: ${previa.adjuntos.map((a) => `${a.nombre} (${Math.round(a.bytes / 1024)} kB)`).join(', ')}.`
          : 'Sin adjuntos.'}
      </p>
    </div>
  )
}
