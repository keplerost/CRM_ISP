import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Check, Copy, MessageSquare, ShieldAlert } from 'lucide-react'

import { api } from '../../lib/apiNetwork'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Textarea,
} from '../../components/ui'

/**
 * Las plantillas aprobadas de WhatsApp.
 *
 * ── Lo que esta pantalla tiene que dejar claro ──
 *
 * Que mientras una plantilla no diga **Aprobada**, ese aviso NO sale por
 * WhatsApp. No sale mal: no sale. Es la única pantalla del sistema donde un
 * estado en gris significa que un abonado no se va a enterar de que le van a
 * cortar el servicio.
 *
 * Por eso el texto de Meta está siempre a un clic de copiar: el trabajo real es
 * ir al Administrador de WhatsApp, pegar ese texto, esperar la aprobación y
 * volver acá a marcarla. Cuanto menos fricción tenga ese ida y vuelta, menos
 * plantillas quedan a medias.
 */

const ESTADOS = [
  ['borrador', 'Sin registrar', 'gris'],
  ['enviada', 'En revisión de Meta', 'ambar'],
  ['aprobada', 'Aprobada', 'verde'],
  ['rechazada', 'Rechazada', 'rojo'],
  ['pausada', 'Pausada por Meta', 'rojo'],
]

const colorDe = (estado) => ESTADOS.find((e) => e[0] === estado)?.[2] ?? 'gris'
const nombreDe = (estado) => ESTADOS.find((e) => e[0] === estado)?.[1] ?? estado

export default function PlantillasWhatsappPage() {
  const [filas, setFilas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [editando, setEditando] = useState(null)
  const [copiada, setCopiada] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      setFilas(await api.plantillasWhatsapp.listar())
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function cambiarEstado(fila, estado) {
    setError(null)
    try {
      const r = await api.plantillasWhatsapp.guardar(fila.id, { estado })
      if (r.aviso) setError(new Error(r.aviso))
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const aprobadas = filas.filter((f) => f.se_puede_enviar).length
  const faltan = filas.filter((f) => !f.se_puede_enviar && f.plantilla_activa)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/ajustes" className="text-slate-400 hover:text-slate-100">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Plantillas de WhatsApp</h1>
          <p className="text-xs text-slate-500">
            {aprobadas} de {filas.length} aprobadas en Meta.
          </p>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Aviso tipo={faltan.length ? 'alerta' : 'info'}>
        <ShieldAlert size={14} className="mr-1 inline" />
        WhatsApp solo entrega <b>texto libre</b> dentro de las 24 horas siguientes al último
        mensaje del abonado. Los avisos automáticos —factura, recordatorios, corte— caen siempre
        fuera de esa ventana: nadie le escribe al ISP para que le avisen que se le vence la
        factura.{' '}
        {faltan.length > 0 ? (
          <>
            Hay <b>{faltan.length}</b> {faltan.length === 1 ? 'aviso' : 'avisos'} que hoy{' '}
            <b>no salen por WhatsApp</b> y se caen al SMS o al correo.
          </>
        ) : (
          'Todas las plantillas activas están aprobadas.'
        )}
      </Aviso>

      <Card title="Plantillas del sistema" icon={MessageSquare}>
        {cargando ? (
          <Cargando />
        ) : (
          <Table
            columnas={['Aviso', 'Nombre en Meta', 'En el CRM', 'Texto aprobado', 'Variables', 'Estado', '']}
            filas={filas}
            vacio="Falta correr la migración 176."
            renderFila={(f) => (
              <tr key={f.id} className="align-top text-slate-300">
                <td className="px-3 py-2">
                  <span className="block text-slate-100">{f.nombre_interno}</span>
                  <span className="text-[11px] text-slate-500">{f.descripcion}</span>
                </td>
                <td className="px-3 py-2">
                  <code className="font-mono text-[11px] text-sky-300">{f.nombre_meta}</code>
                  <span className="mt-0.5 block text-[11px] text-slate-500">
                    {f.idioma} · {f.categoria}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {/*
                    Cómo se llama del lado del CRM externo. Es lo único que hace
                    falta para esa vía: la aprobación la maneja el proveedor, no
                    nosotros — por eso no tiene estado.
                  */}
                  {f.purpose_crm ? (
                    <code className="font-mono text-[11px] text-emerald-300">{f.purpose_crm}</code>
                  ) : (
                    <span className="text-[11px] text-slate-600">sin cargar</span>
                  )}
                </td>
                <td className="max-w-md px-3 py-2">
                  <p className="text-[12px] leading-snug text-slate-300">{f.cuerpo_meta}</p>
                  <Button
                    variante="fantasma"
                    icon={copiada === f.id ? Check : Copy}
                    className="mt-1 !px-2 !py-1 !text-[11px]"
                    onClick={() => {
                      navigator.clipboard.writeText(f.cuerpo_meta)
                      setCopiada(f.id)
                    }}
                  >
                    {copiada === f.id ? 'Copiado' : 'Copiar'}
                  </Button>
                </td>
                <td className="px-3 py-2">
                  {f.variables?.length ? (
                    <ol className="space-y-0.5 text-[11px] text-slate-400">
                      {f.variables.map((v, i) => (
                        <li key={v}>
                          <span className="font-mono text-slate-500">{`{{${i + 1}}}`}</span> = {v}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <span className="text-[11px] text-slate-600">sin variables</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge color={colorDe(f.estado)}>{nombreDe(f.estado)}</Badge>
                  {f.motivo_rechazo && (
                    <span className="mt-1 block text-[11px] text-red-400">{f.motivo_rechazo}</span>
                  )}
                  {!f.plantilla_activa && (
                    <span className="mt-1 block text-[11px] text-slate-500">
                      El aviso está desactivado
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col items-end gap-1">
                    {f.estado !== 'aprobada' && (
                      <Button
                        variante="primario"
                        icon={Check}
                        className="!px-2 !py-1 !text-[11px]"
                        onClick={() => cambiarEstado(f, 'aprobada')}
                      >
                        Ya la aprobaron
                      </Button>
                    )}
                    {f.estado === 'borrador' && (
                      <Button
                        variante="fantasma"
                        className="!px-2 !py-1 !text-[11px]"
                        onClick={() => cambiarEstado(f, 'enviada')}
                      >
                        La mandé a revisar
                      </Button>
                    )}
                    {f.estado === 'aprobada' && (
                      <Button
                        variante="fantasma"
                        className="!px-2 !py-1 !text-[11px]"
                        onClick={() => cambiarEstado(f, 'pausada')}
                      >
                        Meta la pausó
                      </Button>
                    )}
                    <Button
                      variante="fantasma"
                      className="!px-2 !py-1 !text-[11px]"
                      onClick={() => setEditando({ ...f })}
                    >
                      Editar
                    </Button>
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <Card title="Cómo se registra una plantilla" icon={AlertTriangle}>
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-400">
          <li>
            Entrá al <b>Administrador de WhatsApp</b> de Meta → Herramientas de la cuenta →
            Plantillas de mensajes → <b>Crear plantilla</b>.
          </li>
          <li>
            Categoría <b>Utilidad</b>. Nunca Marketing: una marca de spam en una plantilla de
            marketing le baja la calificación de calidad al número entero, y con la calificación en
            rojo Meta reduce el límite de envíos y termina pausando plantillas.
          </li>
          <li>
            Nombre e idioma: los de la columna <b>Nombre en Meta</b>, tal cual.
          </li>
          <li>
            Pegá el texto de la columna <b>Texto aprobado</b> con el botón Copiar, y cargá los
            ejemplos que Meta pide para cada <code className="font-mono">{'{{n}}'}</code>.
          </li>
          <li>
            Cuando Meta la apruebe —suele tardar minutos— volvé acá y apretá{' '}
            <b>Ya la aprobaron</b>. Hasta ese momento el aviso sale por SMS o correo, no por
            WhatsApp.
          </li>
        </ol>
      </Card>

      <EditarPlantilla
        editando={editando}
        setEditando={setEditando}
        onGuardado={recargar}
        onError={setError}
      />
    </div>
  )
}

function EditarPlantilla({ editando, setEditando, onGuardado, onError }) {
  const [revision, setRevision] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setEditando((x) => ({ ...x, [campo]: e.target.value }))

  // Se revisa contra las reglas de Meta mientras se escribe. Descubrir que
  // empieza con una variable después de pegarla allá cuesta una vuelta entera.
  useEffect(() => {
    if (!editando?.cuerpo_meta) return setRevision(null)

    const t = setTimeout(() => {
      api.plantillasWhatsapp
        .revisar(editando.cuerpo_meta, editando.variables ?? [])
        .then((r) => setRevision({ ok: r.ok, texto: r.motivo ?? `Usa ${r.variables_en_el_texto} variable(s).` }))
        .catch((err) => setRevision({ ok: false, texto: err.message }))
    }, 400)

    return () => clearTimeout(t)
  }, [editando?.cuerpo_meta, editando?.variables])

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    onError(null)
    try {
      const r = await api.plantillasWhatsapp.guardar(editando.id, {
        nombre_meta: editando.nombre_meta,
        idioma: editando.idioma,
        categoria: editando.categoria,
        cuerpo_meta: editando.cuerpo_meta,
        variables: editando.variables ?? [],
        sid_twilio: editando.sid_twilio ?? null,
        notas: editando.notas ?? null,
      })
      setEditando(null)
      if (r.aviso) onError(new Error(r.aviso))
      await onGuardado()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal
      abierto={Boolean(editando)}
      titulo="Editar la plantilla de Meta"
      onCerrar={() => setEditando(null)}
      ancho="max-w-2xl"
    >
      {editando && (
        <form onSubmit={guardar} className="space-y-4">
          <Aviso tipo="alerta">
            Si cambiás el texto, el nombre o el orden de las variables, la plantilla vuelve a{' '}
            <b>borrador</b>: lo que vale es lo que Meta aprobó, no lo que dice esta base. Hay que
            registrarla de nuevo allá.
          </Aviso>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Nombre en Meta" hint="Minúsculas, números y guion bajo.">
              <Input value={editando.nombre_meta} onChange={set('nombre_meta')} />
            </Field>
            <Field label="Idioma">
              <Input value={editando.idioma} onChange={set('idioma')} placeholder="es" />
            </Field>
            <Field label="Categoría">
              <Select value={editando.categoria} onChange={set('categoria')}>
                <option value="UTILITY">Utilidad</option>
                <option value="MARKETING">Marketing</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Texto aprobado"
            hint="Con {{1}}, {{2}}… No puede empezar ni terminar con una variable, ni llevar dos seguidas."
          >
            <Textarea rows={4} value={editando.cuerpo_meta} onChange={set('cuerpo_meta')} />
          </Field>

          {revision && (
            <p
              className={`text-[12px] leading-snug ${revision.ok ? 'text-emerald-400' : 'text-amber-300'}`}
            >
              {revision.ok ? '✓ ' : '⚠ '}
              {revision.texto}
            </p>
          )}

          <Field
            label="Qué variable va en cada posición"
            hint="Separadas por coma, en orden. Es lo único que conecta {{saldo}} con {{2}}: cambiar el orden sin volver a registrar pondría el saldo donde va la fecha."
          >
            <Input
              value={(editando.variables ?? []).join(', ')}
              onChange={(e) =>
                setEditando({
                  ...editando,
                  variables: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                })
              }
              placeholder="periodo, total, fecha_vencimiento"
            />
          </Field>

          <Field
            label="Nombre del aviso en el CRM externo"
            hint="Solo si mandás WhatsApp por un CRM. Es cómo se llama esta plantilla del lado de ellos —su `purpose`—. Vacío = por esa vía este aviso no sale."
          >
            <Input
              value={editando.purpose_crm ?? ''}
              onChange={set('purpose_crm')}
              placeholder="dunning_suspension"
            />
          </Field>

          <Field
            label="ContentSid de Twilio"
            hint="Solo si mandás WhatsApp por Twilio: allá la misma plantilla tiene otro identificador. Vacío = por Twilio no se manda."
          >
            <Input value={editando.sid_twilio ?? ''} onChange={set('sid_twilio')} placeholder="HX…" />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variante="fantasma" type="button" onClick={() => setEditando(null)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
