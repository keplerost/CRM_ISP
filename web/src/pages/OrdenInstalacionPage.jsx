import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Ban,
  ClipboardList,
  ExternalLink,
  FileSignature,
  MapPin,
  Phone,
  Printer,
  Smartphone,
  Trash2,
  UserCheck,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../lib/apiNetwork'
import { abrirPdf } from '../lib/pdf'
import { enlaceMapa, enlaceWhatsapp } from '../lib/soporte'
import { ESTADOS, FACTIBILIDAD, TECNOLOGIAS, faltantes } from '../lib/instalaciones'
import DatosContrato from '../components/clientes/DatosContrato'
import DocumentosVenta from '../components/instalaciones/DocumentosVenta'
import FirmaContrato from '../components/contratos/FirmaContrato'
import FactibilidadPanel from '../components/instalaciones/FactibilidadPanel'
import AgendaPanel from '../components/instalaciones/AgendaPanel'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner } from '../components/ui'

/**
 * La orden de trabajo, del lado de la oficina.
 *
 * Todo lo que se decide antes de que alguien salga: si es factible, de dónde
 * cuelga, qué día, quién va y qué se le vendió. El alta propiamente dicha vive
 * en el asistente del celular, que es donde el técnico la ejecuta.
 */

const dato = (v) => v || '—'

export default function OrdenInstalacionPage() {
  const confirmar = useConfirmar()
  const { id } = useParams()
  const navegar = useNavigate()

  const [orden, setOrden] = useState(null)
  // `null` = el formulario del contrato está cerrado.
  const [contrato, setContrato] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_instalaciones')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (err) setError(err)
    setOrden(data ?? null)
    setCargando(false)
  }, [id])

  useEffect(() => {
    recargar()
  }, [recargar])

  async function cambiarEstado(estado) {
    const { error: err } = await supabase.from('instalaciones').update({ estado }).eq('id', id)
    if (err) return setError(err)
    await recargar()
  }

  async function eliminar() {
    if (!await confirmar('¿Eliminar esta orden de trabajo? No se puede deshacer.')) return
    const { error: err } = await supabase.from('instalaciones').delete().eq('id', id)
    if (err) return setError(err)
    navegar('/clientes/instalaciones')
  }

  if (cargando) return <Cargando texto="Cargando la orden…" />
  if (!orden) {
    return (
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />
        <Aviso tipo="alerta">No existe esa orden de trabajo o ya fue eliminada.</Aviso>
        <Link to="/clientes/instalaciones" className="text-sm text-sky-400 hover:underline">
          Volver a Instalaciones
        </Link>
      </div>
    )
  }

  const abierta = ['prospecto', 'agendada', 'en_curso'].includes(orden.estado)
  const pendientes = faltantes(orden)
  const mapa = enlaceMapa(orden)
  const whatsapp = enlaceWhatsapp(orden.telefono_whatsapp ?? orden.telefono, `Hola ${orden.titular ?? ''}`)

  /**
   * Abre el formulario del contrato con lo que haya cargado el vendedor.
   *
   * Es la misma pantalla que la de la ficha del abonado, guardando sobre la
   * orden: las columnas se llaman igual en las dos tablas y al dar de alta
   * viajan solas. Quien sabe si el abonado es adulto mayor es el vendedor, en la
   * puerta de la casa — preguntarlo días después por teléfono no pasa nunca.
   */
  async function abrirFormularioContrato() {
    setError(null)
    try {
      /**
       * TODOS los planes, no solo el de la orden.
       *
       * Antes se traía únicamente el plan ya elegido, y si la orden no tenía
       * ninguno el formulario salía sin el bloque de condiciones técnicas: el
       * contrato terminaba sin nivel de compartición ni velocidades mínimas, que
       * el anexo 1f exige. Con la lista, el vendedor lo elige ahí mismo.
       */
      const [{ data: planes }, { data: prestador }] = await Promise.all([
        supabase
          .from('planes_velocidad')
          .select('id, nombre, precio, bajada_kbps, subida_kbps, comparticion, minima_bajada_kbps, minima_subida_kbps')
          .eq('activo', true)
          .order('precio'),
        supabase
          .from('prestadores')
          .select('arbitraje_por_defecto')
          .eq('predeterminado', true)
          .maybeSingle(),
      ])

      setContrato({
        planes: planes ?? [],
        plan: (planes ?? []).find((p) => p.id === orden.plan_id) ?? null,
        arbitraje: prestador?.arbitraje_por_defecto ?? null,
      })
    } catch (err) {
      setError(err)
    }
  }

  /** Genera el contrato de la orden y lo abre para imprimir y hacer firmar. */
  async function generarContratoDeLaOrden() {
    setContrato(null)
    await recargar()
    await abrirPdf(
      () => api.documentos.contratoArcotel(orden.id, { origen: 'orden' }),
      `contrato-orden-${orden.numero ?? orden.id}.pdf`,
    )
  }

  return (
    <div className="space-y-4">
      <Link
        to="/clientes/instalaciones"
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
      >
        <ArrowLeft size={15} /> Instalaciones
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{dato(orden.titular)}</h1>
          <p className="text-sm text-slate-500">
            {TECNOLOGIAS[orden.tecnologia ?? 'ftth'].label} ·{' '}
            {ESTADOS[orden.estado]?.ayuda ?? orden.estado}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge color={ESTADOS[orden.estado]?.color ?? 'gris'}>
            {ESTADOS[orden.estado]?.label ?? orden.estado}
          </Badge>
          <Badge color={FACTIBILIDAD[orden.factibilidad ?? 'pendiente'].color}>
            {FACTIBILIDAD[orden.factibilidad ?? 'pendiente'].label}
          </Badge>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {orden.estado === 'hecha' && orden.client_id && (
        <Aviso>
          El alta se cerró y el abonado ya está en Usuarios.{' '}
          <Link to={`/clientes/${orden.client_id}`} className="font-medium underline">
            Abrir su ficha
          </Link>
          .
        </Aviso>
      )}

      <Card title="Datos del pedido" icon={ClipboardList}>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Dato etiqueta="Cédula / RUC" valor={orden.cedula} />
          <Dato etiqueta="Teléfono" valor={orden.telefono} />
          <Dato etiqueta="Correo" valor={orden.email} />
          <Dato etiqueta="Dirección" valor={orden.direccion} />
          <Dato etiqueta="Sector" valor={[orden.sector, orden.canton].filter(Boolean).join(', ')} />
          <Dato etiqueta="Referencia" valor={orden.referencia} />
          <Dato etiqueta="Plan" valor={orden.plan} />
          <Dato
            etiqueta="Precio mensual"
            valor={orden.precio_mensual != null ? `$${Number(orden.precio_mensual).toFixed(2)}` : null}
          />
          <Dato
            etiqueta="Día de facturación"
            valor={orden.dia_facturacion ? `Día ${orden.dia_facturacion}` : null}
          />
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          {mapa && (
            <a
              href={mapa}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
            >
              <MapPin size={15} /> Cómo llegar
            </a>
          )}
          {whatsapp && (
            <a
              href={whatsapp}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
            >
              <Phone size={15} /> WhatsApp
            </a>
          )}
          {orden.client_id && (
            <Link
              to={`/clientes/${orden.client_id}`}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
            >
              <UserCheck size={15} /> Ficha del abonado <ExternalLink size={13} />
            </Link>
          )}
          {/*
            La hoja de instalación, con la firma que el abonado dejó en la
            tablet dibujada al pie. Se puede imprimir antes de ir —para llevarla
            en blanco y llenarla a mano— y después, ya con todo cargado.
          */}
          <button
            type="button"
            onClick={() => abrirPdf(() => api.documentos.instalacion(orden.id)).catch(setError)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
          >
            <Printer size={15} /> Hoja de instalación
          </button>

          {/*
            El contrato de adhesión, con los datos que cargó el vendedor.

            Va acá y no solo en la ficha del abonado porque el contrato se firma
            ANTES del alta: pedir que primero exista la ficha invertiría el orden
            real —se daría de alta a alguien que todavía no firmó nada—.
          */}
          <button
            type="button"
            onClick={() => abrirFormularioContrato()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700"
          >
            <FileSignature size={15} /> Contrato para firmar
          </button>
        </div>
      </Card>

      {/*
        Los papeles del cliente van siempre, abierta o cerrada la orden: se
        cargan al vender, pero la cédula que llegó tarde se sube igual y pasa
        sola a la ficha.
      */}
      {/*
        La firma va junto a los papeles y antes de la agenda: el contrato se
        firma antes de que nadie salga a instalar.
      */}
      <FirmaContrato instalacion={orden} onError={setError} />

      <DocumentosVenta instalacion={orden} onError={setError} />

      {abierta && (
        <>
          <FactibilidadPanel instalacion={orden} onError={setError} onGuardado={recargar} />
          <AgendaPanel instalacion={orden} onError={setError} onGuardado={recargar} />
        </>
      )}

      <Card title="Alta en campo" icon={Smartphone}>
        <div className="space-y-4">
          {orden.estado === 'hecha' ? (
            <Aviso>
              El trabajo está cerrado. El detalle de lo que quedó instalado —potencia, parámetros de
              red, pruebas y firma— se conserva en esta orden.
            </Aviso>
          ) : pendientes.length ? (
            <div>
              <p className="mb-2 text-sm text-slate-400">Falta para poder dar de alta:</p>
              <ul className="space-y-1 text-sm text-slate-300">
                {pendientes.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Aviso>Está todo listo: el asistente puede cerrar el alta.</Aviso>
          )}

          {abierta && (
            <Link
              to={`/instalaciones/${orden.id}/alta`}
              className="inline-flex items-center gap-2 rounded-lg border border-sky-500 bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              <Smartphone size={15} /> Abrir el asistente de alta
            </Link>
          )}
        </div>
      </Card>

      {abierta && (
        <div className="flex flex-wrap gap-2">
          <Button icon={Ban} onClick={() => cambiarEstado('cancelada')}>
            Cancelar el trabajo
          </Button>
          <Button variante="peligro" icon={Trash2} onClick={eliminar}>
            Eliminar
          </Button>
        </div>
      )}

      {orden.estado === 'cancelada' && (
        <Button onClick={() => cambiarEstado('prospecto')}>Reabrir como prospecto</Button>
      )}

      {/*
        Lo que el vendedor levanta para el contrato, guardado sobre la orden.
        Al dar de alta viaja solo a la ficha del abonado.
      */}
      {contrato && (
        <DatosContrato
          cliente={orden}
          plan={contrato.plan}
          planes={contrato.planes}
          tabla="instalaciones"
          arbitrajePorDefecto={contrato.arbitraje}
          abierto
          onCerrar={() => setContrato(null)}
          onError={setError}
          onListo={generarContratoDeLaOrden}
        />
      )}
    </div>
  )
}

function Dato({ etiqueta, valor }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-slate-500">{etiqueta}</dt>
      <dd className="text-slate-200">{dato(valor)}</dd>
    </div>
  )
}
