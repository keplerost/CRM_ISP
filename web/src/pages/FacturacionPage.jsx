import { useEffect, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { Link, useSearchParams } from 'react-router-dom'
import {
  FileText,
  Mail,
  Plus,
  Printer,
  Receipt,
  RefreshCcw,
  RotateCcw,
  Send,
  Settings,
  Trash2,
} from 'lucide-react'
import { useTabla } from '../lib/useTabla'
import { api } from '../lib/apiNetwork'
import CertificadoFirma from '../components/sri/CertificadoFirma'
import CuentasPago from '../components/pagos/CuentasPago'
import PorFacturar from '../components/sri/PorFacturar'
import FacturasDelMes from '../components/sri/FacturasDelMes'
import { usePermisos } from '../lib/AuthContext'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  DatosEnFicha,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Stat,
  Table,
  Textarea,
} from '../components/ui'

const COLOR_ESTADO = {
  BORRADOR: 'gris',
  FIRMADO: 'azul',
  ENVIADO: 'ambar',
  AUTORIZADO: 'verde',
  NO_AUTORIZADO: 'rojo',
  ANULADO: 'rojo',
}

// El permiso de cada pestaña. El cajero emite y reimprime pero no toca el
// certificado de firma ni el ambiente del SRI: son la misma pantalla para el
// dueño del ISP y dos trabajos distintos para quien atiende el mostrador.
const PESTANAS = [
  { id: 'comprobantes', label: 'Comprobantes', icon: Receipt, permiso: 'facturacion.ver' },
  // La bandeja del cierre: cobros del día que todavía no tienen comprobante.
  { id: 'porfacturar', label: 'Por facturar', icon: Send, permiso: 'facturacion.emitir' },
  // Las facturas del sistema que se crean solas cada mes.
  { id: 'mes', label: 'Facturas del mes', icon: Plus, permiso: 'facturacion.ver' },
  { id: 'emitir', label: 'Nueva factura', icon: Plus, permiso: 'facturacion.emitir' },
  { id: 'config', label: 'Configuración', icon: Settings, permiso: 'config.facturacion' },
]

export default function FacturacionPage() {
  // La pestaña sale de la URL para que se pueda enlazar desde afuera —Ajustes
  // manda acá para el SMTP— y para que volver atrás vuelva a donde estabas.
  const [params, setParams] = useSearchParams()
  const { puede } = usePermisos()
  const pedida = params.get('t')

  // Solo las pestañas que este usuario puede abrir. La primera visible es la de
  // arranque: mandarlo siempre a "Comprobantes" dejaría al cajero que solo
  // emite mirando una pantalla vacía cada vez que entra.
  const visibles = PESTANAS.filter((p) => puede(p.permiso))
  const inicial = visibles[0]?.id ?? 'comprobantes'
  const pestana = visibles.some((p) => p.id === pedida) ? pedida : inicial
  const setPestana = (id) => setParams(id === inicial ? {} : { t: id }, { replace: true })
  const [error, setError] = useState(null)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Facturación electrónica</h1>
        <p className="text-xs text-slate-500">Comprobantes del SRI — Ecuador</p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-800 pb-3">
        {visibles.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => {
              setPestana(id)
              setError(null)
            }}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
              pestana === id
                ? 'bg-sky-600/15 font-medium text-sky-300'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {pestana === 'comprobantes' && <Comprobantes onError={setError} />}
      {pestana === 'porfacturar' && <PorFacturar onError={setError} />}
      {pestana === 'mes' && <FacturasDelMes onError={setError} />}
      {pestana === 'emitir' && <Emitir onError={setError} onEmitida={() => setPestana('comprobantes')} />}
      {pestana === 'config' && (
        <div className="space-y-6">
          <Configuracion onError={setError} />
          {/* El certificado se maneja aparte: se sube una vez y se valida solo. */}
          <CertificadoFirma />
          {/* Las cuentas de cobro también son configuración: se cargan una vez y
              después solo se eligen al registrar un pago. */}
          <CuentasPago />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function Comprobantes({ onError }) {
  const confirmar = useConfirmar()
  const { filas, cargando, error, eliminar, recargar, setError } = useTabla(
    'v_electronic_documents',
    { orderBy: 'fecha_emision', ascending: false },
  )
  const [xml, setXml] = useState(null)
  const [trabajando, setTrabajando] = useState(null)
  const [resultado, setResultado] = useState(null)
  const [emisor, setEmisor] = useState(null)
  // El comprobante que se está por reenviar. Null = la ventana no existe.
  const [aEnviar, setAEnviar] = useState(null)
  const [enviando, setEnviando] = useState(false)

  // Hace falta saber si hay correo configurado para decidir si el comprobante
  // sale solo hacia el abonado al autorizarse.
  useEffect(() => {
    api.sri.config().then(setEmisor).catch(() => setEmisor(null))
  }, [])

  /** Firma, envía y consulta la autorización en una sola pasada. */
  async function procesar(doc) {
    const conCorreo = Boolean(emisor?.tiene_smtp && doc.email_comprador)

    if (
      !await confirmar(
        `Se va a firmar y enviar la factura ${doc.numero_comprobante} al SRI.\n\n` +
          `Ambiente: ${doc.ambiente === '2' ? 'PRODUCCIÓN — el comprobante tendrá validez tributaria' : 'pruebas'}\n` +
          (conCorreo
            ? `Al autorizarse se le enviará a ${doc.email_comprador}.\n`
            : '') +
          '\n¿Continuar?',
      )
    )
      return

    setTrabajando(doc.id)
    setResultado(null)
    onError(null)
    try {
      setResultado(await api.sri.procesar(doc.id, { enviar_email: conCorreo }))
      await recargar()
    } catch (err) {
      onError(err)
    } finally {
      setTrabajando(null)
    }
  }

  /**
   * Reenvía el comprobante al comprador.
   *
   * Se puede repetir a propósito: el pedido más común de un abonado es "no me
   * llegó, mandámela de nuevo".
   */
  /**
   * Reenvía el comprobante al comprador.
   *
   * Se puede repetir a propósito: el pedido más común de un abonado es "no me
   * llegó, mandámela de nuevo".
   *
   * ── Por qué el correo se valida antes de mandar ──
   *
   * Porque un comprobante que sale a una dirección con un error de tipeo no
   * rebota a ninguna parte visible: el sistema dice "enviado", el abonado dice
   * que no le llegó, y no hay forma de distinguir eso de un correo en la
   * carpeta de spam. Un `prompt` del navegador no valida nada.
   */
  async function enviarPorCorreo(destino) {
    const doc = aEnviar
    setEnviando(true)
    setResultado(null)
    onError(null)
    try {
      const r = await api.sri.email(doc.id, { para: destino })
      setAEnviar(null)
      setResultado({
        ok: true,
        estadoFinal: doc.estado,
        pasos: [{ paso: 'email', ok: true, nota: `enviado a ${r.destino ?? destino}` }],
        aviso: r.aviso,
      })
      await recargar()
    } catch (err) {
      onError(err)
    } finally {
      setEnviando(false)
    }
  }

  /**
   * Devuelve el número del comprobante a la bolsa de libres.
   *
   * El secuencial se gasta al armar el comprobante. Si nunca salió de acá, el
   * SRI no lo conoce y ese número sigue disponible: recuperarlo evita el hueco
   * en la numeración. El middleware confirma con el SRI antes de liberarlo.
   */
  async function liberarNumero(doc) {
    if (
      !await confirmar(
        `¿Anular ${doc.numero_comprobante} y devolver su número a la bolsa?\n\n` +
          'Solo se puede si el SRI nunca lo recibió — se le va a preguntar antes.\n' +
          'El número lo va a tomar la próxima factura de ese punto de emisión.',
      )
    )
      return

    setTrabajando(doc.id)
    setResultado(null)
    onError(null)
    try {
      const r = await api.sri.liberarNumero(doc.id, { motivo: 'Número recuperado a mano' })
      setResultado({
        ok: true,
        estadoFinal: 'ANULADO',
        pasos: [{ paso: 'número liberado', ok: true, nota: r.aviso }],
      })
      await recargar()
    } catch (err) {
      onError(err)
    } finally {
      setTrabajando(null)
    }
  }

  /** Vuelve a preguntar por un comprobante que quedó en proceso. */
  async function consultar(doc) {
    setTrabajando(doc.id)
    setResultado(null)
    onError(null)
    try {
      const r = await api.sri.autorizacion(doc.id)
      setResultado({ ok: r.autorizado, estadoFinal: r.estado, autorizacion: r, pasos: [] })
      await recargar()
    } catch (err) {
      onError(err)
    } finally {
      setTrabajando(null)
    }
  }

  useEffect(() => {
    if (error) onError(error)
  }, [error, onError])

  const contar = (estado) => filas.filter((d) => d.estado === estado).length
  const total = filas.reduce((s, d) => s + Number(d.importe_total ?? 0), 0)

  async function verXml(doc) {
    try {
      const r = await api.sri.xml(doc.id)
      setXml({ ...r, numero: doc.numero_comprobante })
    } catch (err) {
      onError(err)
    }
  }

  /**
   * Abre el RIDE en otra pestaña.
   *
   * El PDF llega como blob porque el pedido lleva el token en la cabecera. La
   * URL temporal se libera recién después: revocarla enseguida deja la pestaña
   * nueva sin nada que mostrar.
   */
  async function verRide(doc) {
    onError(null)
    try {
      const blob = await api.sri.ride(doc.id)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      onError(err)
    }
  }

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Emitidos" valor={filas.length} icon={Receipt} />
        <Stat label="Autorizados" valor={contar('AUTORIZADO')} color="text-emerald-400" />
        <Stat label="Borradores" valor={contar('BORRADOR')} />
        <Stat label="Total facturado" valor={`$${total.toFixed(2)}`} />
      </div>

      {resultado && (
        <Card title="Resultado del envío al SRI">
          <div className="space-y-3">
            <Aviso tipo={resultado.ok ? 'info' : 'alerta'}>
              {resultado.ok ? (
                <>
                  <b>Comprobante AUTORIZADO.</b>
                  {resultado.autorizacion?.numeroAutorizacion && (
                    <span className="mt-1 block break-all font-mono text-[11px]">
                      N° {resultado.autorizacion.numeroAutorizacion}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <b>Estado: {resultado.estadoFinal}.</b>{' '}
                  {resultado.aviso ?? 'Revisá los mensajes del SRI abajo.'}
                </>
              )}
            </Aviso>

            {resultado.pasos?.length > 0 && (
              <div className="space-y-1">
                {resultado.pasos.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={p.ok ? 'text-emerald-400' : 'text-red-400'}>
                      {p.ok ? '✓' : '✗'}
                    </span>
                    <span className="text-slate-300">{p.paso}</span>
                    {p.estado && <span className="text-slate-500">— {p.estado}</span>}
                    {p.nota && <span className="text-slate-500">({p.nota})</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Los mensajes del SRI son lo único que explica un rechazo. */}
            {[...(resultado.pasos ?? []), { mensajes: resultado.autorizacion?.mensajes }]
              .flatMap((p) => p.mensajes ?? [])
              .map((m, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                >
                  <b>
                    {m.identificador ? `[${m.identificador}] ` : ''}
                    {m.mensaje}
                  </b>
                  {m.informacionAdicional && (
                    <span className="mt-1 block opacity-80">{m.informacionAdicional}</span>
                  )}
                </div>
              ))}
          </div>
        </Card>
      )}

      {filas.length === 0 ? (
        <Aviso>
          Todavía no emitiste ningún comprobante. Empezá por <b>Configuración</b> para cargar el RUC
          del emisor, y después <b>Nueva factura</b>.
        </Aviso>
      ) : (
        <Card title="Comprobantes emitidos" icon={Receipt}>
          <Table
            columnas={['Número', 'Fecha', 'Cliente', 'Identificación', 'Total', 'Estado', '']}
            filas={filas}
            renderFila={(d) => (
              <tr key={d.id} className="text-slate-300">
                <td className="px-3 py-2 font-mono text-xs text-slate-100">
                  {d.numero_comprobante}
                </td>
                <td className="px-3 py-2 text-xs">{d.fecha_emision}</td>
                <td className="px-3 py-2">{d.razon_social_comprador}</td>
                <td className="px-3 py-2 font-mono text-xs">{d.identificacion_comprador}</td>
                <td className="px-3 py-2 font-medium">${Number(d.importe_total).toFixed(2)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <Badge color={COLOR_ESTADO[d.estado] ?? 'gris'}>{d.estado}</Badge>
                    {d.enviado_por_email && (
                      <Mail
                        size={13}
                        className="text-emerald-400"
                        title={`Enviado al comprador${
                          d.fecha_envio_email
                            ? ` el ${new Date(d.fecha_envio_email).toLocaleString()}`
                            : ''
                        }`}
                      />
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button variante="fantasma" icon={FileText} onClick={() => verXml(d)}>
                      XML
                    </Button>
                    <Button
                      variante="fantasma"
                      icon={Printer}
                      title="Representación impresa del comprobante"
                      onClick={() => verRide(d)}
                    >
                      RIDE
                    </Button>
                    {['BORRADOR', 'FIRMADO'].includes(d.estado) && (
                      <Button
                        variante="primario"
                        icon={Send}
                        cargando={trabajando === d.id}
                        onClick={() => procesar(d)}
                      >
                        Enviar al SRI
                      </Button>
                    )}
                    {d.estado === 'AUTORIZADO' && (
                      <Button
                        variante="fantasma"
                        icon={Mail}
                        cargando={trabajando === d.id}
                        title="Envía el XML autorizado y el RIDE al comprador"
                        onClick={() => setAEnviar(d)}
                      >
                        {d.enviado_por_email ? 'Reenviar' : 'Enviar'}
                      </Button>
                    )}
                    {d.estado === 'ENVIADO' && (
                      <Button
                        variante="secundario"
                        icon={RefreshCcw}
                        cargando={trabajando === d.id}
                        onClick={() => consultar(d)}
                      >
                        Consultar
                      </Button>
                    )}
                    {['BORRADOR', 'FIRMADO'].includes(d.estado) && (
                      <Button
                        variante="fantasma"
                        icon={RotateCcw}
                        cargando={trabajando === d.id}
                        title="El SRI nunca lo recibió: recuperar su número"
                        onClick={() => liberarNumero(d)}
                      >
                        Liberar N°
                      </Button>
                    )}
                    {d.estado === 'BORRADOR' && (
                      <Button
                        variante="fantasma"
                        icon={Trash2}
                        title="Solo se pueden borrar los que no se enviaron"
                        onClick={async () => {
                          if (await confirmar(`¿Eliminar el borrador ${d.numero_comprobante}?`))
                            eliminar(d.id).catch(setError)
                        }}
                      />
                    )}
                  </div>
                </td>
              </tr>
            )}
          />
        </Card>
      )}

      <Modal
        abierto={xml !== null}
        titulo={`XML — ${xml?.numero ?? ''}`}
        onCerrar={() => setXml(null)}
        ancho="max-w-4xl"
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs text-slate-400">Clave de acceso</p>
            <p className="break-all font-mono text-xs text-slate-100">{xml?.clave_acceso}</p>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg bg-black/40 p-3 text-[11px] text-slate-300">
            {xml?.xml}
          </pre>
        </div>
      </Modal>

      <EnviarPorCorreo
        doc={aEnviar}
        enviando={enviando}
        onCancelar={() => setAEnviar(null)}
        onEnviar={enviarPorCorreo}
      />
    </div>
  )
}

/**
 * Reenviar el XML y el RIDE.
 *
 * ── Por qué valida el correo y no lo manda y ya ──
 *
 * Porque el error de tipeo en una dirección no vuelve: el servidor acepta el
 * envío, el sistema muestra "enviado", y el abonado sigue esperando. Distinguir
 * eso de un correo que cayó en spam es imposible desde acá. Un aviso antes de
 * mandar cuesta un segundo; rastrear una factura que nunca llegó cuesta la
 * llamada del día siguiente.
 *
 * La comprobación es deliberadamente floja —hay algo, un arroba, un punto
 * después— porque las reglas estrictas de correo rechazan direcciones válidas
 * raras. Alcanza para atrapar lo que de verdad pasa: `gmial.com`, el arroba que
 * falta, el espacio pegado al final.
 */
function EnviarPorCorreo({ doc, enviando, onCancelar, onEnviar }) {
  const [correo, setCorreo] = useState('')

  useEffect(() => {
    if (doc) setCorreo(doc.email_comprador ?? '')
  }, [doc])

  const limpio = correo.trim()
  const valido = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(limpio)
  // No se reta a alguien que todavía no terminó de escribir.
  const avisar = limpio.length > 0 && !valido

  return (
    <Modal abierto={!!doc} titulo="Enviar el comprobante" onCerrar={onCancelar}>
      {doc && (
        <div className="space-y-4">
          <DatosEnFicha
            datos={[
              ['Comprobante', doc.numero ?? doc.secuencial ?? '—'],
              ['Comprador', doc.razon_social_comprador ?? doc.cliente_nombre ?? '—'],
              ['Estado', doc.estado],
              ['En la ficha figura', doc.email_comprador || 'sin correo cargado'],
            ]}
          />

          <Field
            label="Enviar el XML y el RIDE a"
            hint="Se puede mandar cuantas veces haga falta. No cambia el correo de la ficha."
          >
            <Input
              type="email"
              autoFocus
              value={correo}
              onChange={(e) => setCorreo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valido && !enviando) onEnviar(limpio)
              }}
              placeholder="nombre@dominio.com"
            />
          </Field>

          {avisar && (
            <Aviso tipo="alerta">
              Eso no parece una dirección de correo. Revisá el arroba y lo que va
              después del punto.
            </Aviso>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variante="fantasma" onClick={onCancelar}>
              Cancelar
            </Button>
            <Button
              variante="primario"
              icon={Send}
              disabled={!valido}
              cargando={enviando}
              onClick={() => onEnviar(limpio)}
            >
              Enviar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------

const DETALLE_VACIO = {
  codigoPrincipal: '',
  descripcion: '',
  cantidad: 1,
  precioUnitario: '',
  descuento: 0,
  tarifaIva: 15,
  codigoPorcentaje: '4',
}

function Emitir({ onError, onEmitida }) {
  const { filas: clientes } = useTabla('clientes', { orderBy: 'nombre', ascending: true })
  const { filas: planes } = useTabla('planes_velocidad', { orderBy: 'nombre', ascending: true })

  const [clienteId, setClienteId] = useState('')
  const [detalles, setDetalles] = useState([{ ...DETALLE_VACIO }])
  const [totales, setTotales] = useState(null)
  const [emitiendo, setEmitiendo] = useState(false)
  const [resultado, setResultado] = useState(null)

  const cliente = clientes.find((c) => c.id === clienteId)

  // Los totales se recalculan en el backend: la UI muestra exactamente lo mismo
  // que va a viajar en el XML, sin duplicar la aritmética del IVA.
  useEffect(() => {
    const listos = detalles.filter((d) => d.descripcion && d.precioUnitario)
    if (!listos.length) return setTotales(null)

    let vigente = true
    api.sri
      .preview(listos)
      .then((t) => vigente && setTotales(t))
      .catch(() => {})
    return () => {
      vigente = false
    }
  }, [detalles])

  const setDetalle = (i, campo) => (e) =>
    setDetalles((d) => d.map((x, j) => (j === i ? { ...x, [campo]: e.target.value } : x)))

  async function emitir(e) {
    e.preventDefault()
    setEmitiendo(true)
    onError(null)
    try {
      const r = await api.sri.emitirFactura({
        client_id: clienteId,
        detalles: detalles.filter((d) => d.descripcion && d.precioUnitario),
      })
      setResultado(r)
      setDetalles([{ ...DETALLE_VACIO }])
      onEmitida?.()
    } catch (err) {
      onError(err)
    } finally {
      setEmitiendo(false)
    }
  }

  /**
   * Precarga el detalle con el plan del cliente: el caso más común.
   *
   * En la descripción va el nombre del plan tal como está contratado —"PLAN
   * HOME 150 Mbps"—, no un texto genérico con el mes: el período facturado ya
   * se imprime en Información Adicional, y repetirlo acá deja al abonado sin
   * saber qué velocidad está pagando.
   */
  function usarPlanDelCliente() {
    if (!cliente) return

    const plan = planes.find((p) => p.id === cliente.plan_id)

    setDetalles([
      {
        ...DETALLE_VACIO,
        // Sin código propio queda 'INTERNET': es preferible un código genérico
        // a uno vacío, que deja el detalle sin nada que lo identifique.
        codigoPrincipal: plan?.codigo_facturacion || 'INTERNET',
        descripcion: plan?.nombre ?? cliente.velocidad_cruda ?? 'Servicio de internet',
        precioUnitario: cliente.precio_mensual ?? plan?.precio ?? '',
      },
    ])
  }

  return (
    <form onSubmit={emitir} className="space-y-4">
      <Card title="Comprador">
        <div className="grid items-end gap-4 sm:grid-cols-3">
          <Field label="Cliente" className="sm:col-span-2">
            <Select value={clienteId} onChange={(e) => setClienteId(e.target.value)} required>
              <option value="">— elegí un cliente —</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre} {c.identificacion ? `(${c.identificacion})` : '— sin identificación'}
                </option>
              ))}
            </Select>
          </Field>
          <div className="pb-2">
            <Button type="button" onClick={usarPlanDelCliente} disabled={!cliente} className="w-full">
              Usar su plan
            </Button>
          </div>
        </div>

        {cliente && !cliente.identificacion && (
          <div className="mt-3">
            <Aviso tipo="alerta">
              Este cliente no tiene identificación cargada. El SRI la exige — editalo en{' '}
              <b>Clientes</b> antes de facturar.
            </Aviso>
          </div>
        )}
        {cliente && !cliente.email && (
          <div className="mt-3">
            <Aviso tipo="alerta">
              Sin correo no se le puede enviar el comprobante automáticamente.
            </Aviso>
          </div>
        )}
      </Card>

      <Card
        title="Detalle"
        actions={
          <Button
            type="button"
            icon={Plus}
            onClick={() => setDetalles((d) => [...d, { ...DETALLE_VACIO }])}
          >
            Agregar línea
          </Button>
        }
      >
        <div className="space-y-3">
          {detalles.map((d, i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-12">
              <Field label="Código" className="sm:col-span-2">
                <Input value={d.codigoPrincipal} onChange={setDetalle(i, 'codigoPrincipal')} />
              </Field>
              <Field label="Descripción" className="sm:col-span-4">
                <Input value={d.descripcion} onChange={setDetalle(i, 'descripcion')} required />
              </Field>
              <Field label="Cant." className="sm:col-span-1">
                <Input type="number" step="0.01" value={d.cantidad} onChange={setDetalle(i, 'cantidad')} />
              </Field>
              <Field label="P. unitario" className="sm:col-span-2">
                <Input
                  type="number"
                  step="0.01"
                  value={d.precioUnitario}
                  onChange={setDetalle(i, 'precioUnitario')}
                  required
                />
              </Field>
              <Field label="IVA" className="sm:col-span-2">
                <Select
                  value={d.codigoPorcentaje}
                  onChange={(e) => {
                    const codigo = e.target.value
                    const tarifa = codigo === '4' ? 15 : codigo === '2' ? 12 : 0
                    setDetalles((ds) =>
                      ds.map((x, j) =>
                        j === i ? { ...x, codigoPorcentaje: codigo, tarifaIva: tarifa } : x,
                      ),
                    )
                  }}
                >
                  <option value="4">15%</option>
                  <option value="2">12%</option>
                  <option value="0">0%</option>
                  <option value="7">Exento</option>
                  <option value="6">No objeto</option>
                </Select>
              </Field>
              <div className="flex items-end pb-2 sm:col-span-1">
                {detalles.length > 1 && (
                  <Button
                    type="button"
                    variante="fantasma"
                    icon={Trash2}
                    onClick={() => setDetalles((ds) => ds.filter((_, j) => j !== i))}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {totales && (
        <Card title="Totales">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Subtotal" valor={`$${totales.totalSinImpuestos.toFixed(2)}`} />
            <Stat label="Descuento" valor={`$${totales.totalDescuento.toFixed(2)}`} />
            <Stat label="IVA" valor={`$${totales.totalIva.toFixed(2)}`} />
            <Stat
              label="Total"
              valor={`$${totales.importeTotal.toFixed(2)}`}
              color="text-emerald-400"
            />
          </div>
        </Card>
      )}

      {resultado && (
        <Aviso>
          <b>Factura {resultado.documento.establecimiento}-{resultado.documento.punto_emision}-
          {resultado.documento.secuencial} creada.</b>
          <span className="mt-1 block break-all font-mono text-[11px] opacity-80">
            {resultado.documento.clave_acceso}
          </span>
          <span className="mt-1 block">
            Queda en estado BORRADOR. Falta firmarla y enviarla al SRI.
          </span>
        </Aviso>
      )}

      <div className="flex justify-end">
        <Button
          type="submit"
          variante="primario"
          icon={Receipt}
          cargando={emitiendo}
          disabled={!clienteId || !cliente?.identificacion}
        >
          Emitir factura
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------

function Configuracion({ onError }) {
  const [config, setConfig] = useState(null)
  const [plantilla, setPlantilla] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)

  useEffect(() => {
    Promise.all([api.sri.config(), api.sri.catalogos()])
      .then(([c, cat]) => {
        setConfig(c ?? {})
        setPlantilla(cat?.plantilla ?? null)
      })
      .catch(onError)
      .finally(() => setCargando(false))
  }, [onError])

  const set = (campo) => (e) =>
    setConfig((c) => ({
      ...c,
      [campo]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }))

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setGuardado(false)
    onError(null)
    try {
      setConfig(await api.sri.guardarConfig(config))
      setGuardado(true)
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando />

  const enPruebas = (config?.ambiente ?? '1') === '1'

  return (
    <form onSubmit={guardar} className="space-y-4">
      <Aviso tipo={enPruebas ? 'info' : 'alerta'}>
        {enPruebas ? (
          <>
            <b>Ambiente de pruebas.</b> Los comprobantes se emiten contra{' '}
            <code>celcer.sri.gob.ec</code> y <b>no tienen validez tributaria</b>. Es donde hay que
            empezar.
          </>
        ) : (
          <>
            <b>Ambiente de producción.</b> Los comprobantes que emitas tienen validez tributaria y
            no se pueden borrar: solo anular.
          </>
        )}
      </Aviso>

      {/* Los datos de la empresa se mudaron a Ajustes → Empresa. Nacieron acá
          porque el primer lugar donde hizo falta el RUC fue el comprobante,
          pero el nombre y la dirección salen también en el recibo, el contrato
          y cada correo: son de la empresa, no de la facturación.

          Acá queda solo lo del SRI, que sí es de cómo se emite. */}
      <Card title="Emisor">
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            El RUC, la razón social, las direcciones y el logo se cargan en{' '}
            <Link to="/ajustes/empresa" className="text-sky-400 hover:text-sky-300">
              Ajustes → Empresa
            </Link>
            .
          </p>
          <div className="t-card-sm p-3 text-xs">
            <p className="text-slate-300">{config?.razon_social || '(sin razón social)'}</p>
            <p className="font-mono text-slate-500">{config?.ruc || '(sin RUC)'}</p>
          </div>
        </div>
      </Card>

      <Card title="Emisión ante el SRI" subtitle="Cómo se numeran y a dónde se mandan">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ambiente">
            <Select value={config?.ambiente ?? '1'} onChange={set('ambiente')}>
              <option value="1">Pruebas</option>
              <option value="2">Producción</option>
            </Select>
          </Field>
          <Field label="Establecimiento" hint="3 dígitos, como los tiene el SRI">
            <Input
              value={config?.establecimiento ?? '001'}
              onChange={set('establecimiento')}
              maxLength={3}
              placeholder="001"
            />
          </Field>
          <Field label="Punto de emisión" hint="Cada punto lleva su propia numeración">
            <Input
              value={config?.punto_emision ?? '001'}
              onChange={set('punto_emision')}
              maxLength={3}
              placeholder="002"
            />
          </Field>
          <Field
            label="Próximo número de factura"
            hint="Si este punto ya venía facturando con otro sistema, poné el número que sigue. Repetir uno que el SRI ya autorizó hace que rechace el comprobante."
          >
            <Input
              type="number"
              min={1}
              max={999999999}
              value={config?.proximo_secuencial ?? 1}
              onChange={set('proximo_secuencial')}
            />
          </Field>
        </div>
      </Card>

      <Card
        title="RIDE y período facturado"
        subtitle="Lo que ve el abonado en la hoja impresa"
        icon={Printer}
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Día máximo de pago" hint="Del 1 al 28">
              <Input
                type="number"
                min={1}
                max={28}
                value={config?.dia_maximo_pago ?? 5}
                onChange={set('dia_maximo_pago')}
              />
            </Field>
            <Field label="Mes que se factura">
              <Select value={String(config?.meses_desplazado ?? 0)} onChange={set('meses_desplazado')}>
                <option value="0">El mes en curso</option>
                <option value="-1">El mes anterior (vencida)</option>
              </Select>
            </Field>
          </div>


          <Field
            label="Información adicional del comprobante"
            hint="Se resuelve al emitir y queda dentro del XML firmado: cambiarla después no altera lo ya emitido."
          >
            <Textarea
              rows={5}
              value={config?.plantilla_info_adicional ?? ''}
              placeholder={plantilla?.porDefecto ?? ''}
              onChange={set('plantilla_info_adicional')}
            />
          </Field>

          {plantilla?.variables?.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {plantilla.variables.map((v) => (
                <span
                  key={v.clave}
                  title={`${v.que} — ej. ${v.ejemplo}`}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-sky-300"
                >
                  {`{${v.clave}}`}
                </span>
              ))}
            </div>
          )}

          <Aviso>
            Si dejás el texto vacío se usa el de por defecto, que ya incluye el aviso de reclamos
            que exige ARCOTEL.
          </Aviso>
        </div>
      </Card>

      {/* El SMTP se mudó a Ajustes → Servidor de correo. Nació acá porque el
          primer correo que hubo que mandar fue el comprobante, pero por esa
          casilla salen también los avisos de vencimiento y de corte: no es un
          detalle de la facturación. Queda el enlace para el que lo busque donde
          siempre estuvo. */}
      <Card title="Correo al comprador" icon={Mail}>
        <p className="text-sm text-slate-400">
          El XML autorizado y el RIDE salen por la casilla del sistema, que se configura en{' '}
          <Link to="/ajustes/correo" className="text-sky-400 hover:text-sky-300">
            Ajustes → Servidor de correo
          </Link>
          . Es la misma que usan los avisos de vencimiento y de corte.
        </p>
      </Card>

      {guardado && <Aviso>Configuración guardada.</Aviso>}

      <div className="flex justify-end">
        <Button type="submit" variante="primario" cargando={guardando}>
          Guardar configuración
        </Button>
      </div>
    </form>
  )
}
