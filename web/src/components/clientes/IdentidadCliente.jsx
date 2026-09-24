import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  PackageCheck,
  Router as RouterIcon,
  Wallet,
} from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { codigoLargo } from '../../lib/abonados'
import { carteraApi } from '../../lib/cartera'
import { dineroCero as dinero } from '../../lib/formato'
import ConPermiso from '../layout/ConPermiso'
import { Aviso, Badge, Button, Modal, Textarea, EnlaceIp } from '../ui'

/**
 * Quién es este abonado para el sistema, arriba de todo.
 *
 * Son los cuatro datos que se piden por teléfono antes que cualquier otro: en
 * qué estado está y desde cuándo, por qué router sale, con qué número figura en
 * el contrato y con qué clave entra al portal. Ninguno se edita escribiendo —el
 * estado lo mueven los cortes, el router la instalación, el número lo puso la
 * base y la clave se genera—, y por eso van en un bloque de lectura y no como
 * campos del formulario.
 *
 * La fecha del estado es la que contesta "¿desde cuándo está cortado?", que es
 * lo que decide si al abonado se lo llama o se le va a retirar el equipo.
 */

const COLOR = {
  activo: 'verde',
  cortado: 'rojo',
  suspendido: 'ambar',
  baja: 'gris',
}

/**
 * Una fecha SIN hora, como la escribe la base: "2026-09-22".
 *
 * Se parsea con mediodía a propósito. `new Date('2026-09-22')` se interpreta
 * como medianoche UTC, y en Ecuador —cinco horas atrás— eso cae el día
 * anterior: la pausa que vence el 22 se mostraría vencida el 21. Con el
 * mediodía, ningún huso del continente cambia el día.
 */
const soloDia = (f) => {
  if (!f) return null
  const d = new Date(`${String(f).slice(0, 10)}T12:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const fechaHora = (f) => {
  if (!f) return null
  const d = new Date(f)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('es-EC', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function IdentidadCliente({ cliente, promesa, onGuardado, onError }) {
  const confirmar = useConfirmar()
  const [verClave, setVerClave] = useState(false)
  const [generando, setGenerando] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const [saldarAbierto, setSaldarAbierto] = useState(false)

  const desde = fechaHora(cliente.estado_desde)

  async function generar() {
    if (
      cliente.portal_clave &&
      !await confirmar(
        `${cliente.nombre} ya tiene una contraseña. Generar otra deja la anterior sin efecto: si la está usando, deja de entrar hasta que le dictes la nueva.\n\n¿Generar una nueva?`,
      )
    ) {
      return
    }

    setGenerando(true)
    onError?.(null)
    try {
      const r = await api.portalAdmin.fijarClave(cliente.id)
      setVerClave(true)
      await onGuardado?.()
      return r
    } catch (err) {
      onError?.(err)
    } finally {
      setGenerando(false)
    }
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(cliente.portal_clave)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 1500)
    } catch {
      // Sin portapapeles —pasa en http sin certificado— la clave igual se ve.
      setVerClave(true)
    }
  }

  return (
    <div className="mb-4 grid gap-x-6 gap-y-3 t-panel p-3 sm:grid-cols-2">
      {/* Estado y desde cuándo -------------------------------------------- */}
      <Dato etiqueta="Estado">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={COLOR[cliente.estado] ?? 'gris'}>{cliente.estado}</Badge>
          {/* Una promesa de pago no es un estado en la base: es un permiso para
              seguir conectado unos días. Se muestra al lado porque para quien
              atiende cambia la respuesta. */}
          {promesa?.estado === 'activa' && <Badge color="azul">promesa</Badge>}
        </div>
        {desde && (
          <div className="mt-1 text-[11px] text-slate-500">
            {cliente.estado === 'activo' ? 'Activo desde' : `${cliente.estado} desde`} el {desde}
          </div>
        )}

        {/* ── Por qué se lo dio de baja ──

            Va acá, arriba de todo, y no escondido en una pestaña: es lo primero
            que alguien pregunta cuando abre la ficha de un retirado. Sin esto,
            la explicación quedaba escrita en la base y no la veía nadie — y el
            día que el vendedor reclama por su cliente, "está en el sistema" no
            es una respuesta si no se puede leer. */}
        {cliente.estado === 'baja' && (cliente.baja_nota || cliente.baja_en) && (
          <div className="mt-1.5 t-panel p-2">
            <div className="text-[11px] font-medium text-slate-400">
              Retirado{cliente.baja_en ? ` el ${fechaHora(cliente.baja_en)}` : ''}
            </div>
            {cliente.baja_nota && (
              <p className="mt-0.5 text-[11px] leading-snug text-slate-300">{cliente.baja_nota}</p>
            )}
          </div>
        )}
      </Dato>

      {/* La deuda del equipo que no volvió ---------------------------------
          Aparte de la deuda de servicio a propósito: no se factura ni va a
          cobranza —no es una venta— pero tiene que estar a la vista, sobre todo
          el día que esta persona vuelva a pedir servicio. */}
      {Number(cliente.deuda_equipo) > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 sm:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-amber-300">
              <b>Quedó con un equipo sin devolver</b> por {dinero(cliente.deuda_equipo)}
            </div>
            <ConPermiso permiso="clientes.editar" envezDe={null}>
              <Button
                variante="secundario"
                onClick={() => setSaldarAbierto(true)}
                className="py-1 text-xs"
              >
                Devolvió o pagó
              </Button>
            </ConPermiso>
          </div>
          <p className="mt-1 text-[11px] text-amber-400/80">
            No se le factura ni entra a cobranza. Se avisa cuando esta cédula vuelva a aparecer en
            un prospecto.
          </p>
        </div>
      )}

      {/* La pausa, cuando la hay. Va arriba del router porque explica por qué
          ese abonado está sin servicio, y sin eso el estado "suspendido" no
          dice nada. */}
      {cliente.estado === 'suspendido' && (
        <Dato etiqueta="Pausado">
          <div className="text-sm text-slate-200">
            {cliente.suspendido_motivo || 'sin motivo anotado'}
          </div>
          {cliente.suspendido_hasta && (
            <div className="mt-0.5 text-[11px] text-slate-500">
              {/* En el formato del resto de la ficha. La fecha cruda —2026-09-22—
                  obliga a traducir mentalmente justo donde se compara con hoy. */}
              hasta el {soloDia(cliente.suspendido_hasta)}
            </div>
          )}
        </Dato>
      )}

      {/* Router ------------------------------------------------------------ */}
      <Dato etiqueta="Conectado al router">
        <div className="flex items-center gap-1.5 text-sm text-slate-200">
          <RouterIcon size={14} className="shrink-0 text-slate-500" />
          {cliente.router ?? <span className="text-slate-500">sin router asignado</span>}
        </div>
        {cliente.ip && (
          <div className="mt-1 font-mono text-[11px] text-slate-500">
            <EnlaceIp ip={cliente.ip} />
          </div>
        )}
      </Dato>

      {/* El número del abonado --------------------------------------------- */}
      <Dato etiqueta="ID">
        <div className="font-mono text-sm text-slate-100">{codigoLargo(cliente.codigo) || '—'}</div>
        <div className="mt-1 text-[11px] text-slate-500">
          {cliente.numero_orden
            ? `El del contrato. Vino de la orden N° ${cliente.numero_orden}.`
            : 'El del contrato. No cambia nunca.'}
        </div>
      </Dato>

      {/* La clave del portal ----------------------------------------------- */}
      <Dato etiqueta="Contraseña">
        <ConPermiso
          permiso="clientes.editar"
          envezDe={<span className="text-[11px] text-slate-500">Sin permiso para verla.</span>}
        >
          {cliente.portal_clave ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-slate-900 px-2 py-1 font-mono text-sm text-slate-100">
                {verClave ? cliente.portal_clave : '••••••••••'}
              </span>
              <Button
                variante="fantasma"
                icon={verClave ? EyeOff : Eye}
                title={verClave ? 'Ocultar' : 'Ver la contraseña'}
                onClick={() => setVerClave((v) => !v)}
              />
              <Button
                variante="fantasma"
                icon={Copy}
                title={copiado ? 'Copiada' : 'Copiar'}
                onClick={copiar}
              />
              <Button
                variante="fantasma"
                icon={KeyRound}
                title="Generar otra"
                cargando={generando}
                onClick={generar}
              />
            </div>
          ) : (
            <div className="space-y-1">
              <Button
                variante="secundario"
                icon={KeyRound}
                cargando={generando}
                onClick={generar}
                className="py-1 text-xs"
              >
                Generar contraseña
              </Button>
              <div className="text-[11px] text-slate-500">
                {cliente.portal_clave_puesta
                  ? 'La cambió él desde el portal: solo la sabe él.'
                  : 'Todavía no tiene. Se genera y se le dicta.'}
              </div>
            </div>
          )}
        </ConPermiso>
      </Dato>

      <SaldarDeuda
        abierto={saldarAbierto}
        cliente={cliente}
        onCerrar={() => setSaldarAbierto(false)}
        onListo={onGuardado}
        onError={onError}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Saldar la deuda del equipo que no volvió.
 *
 * ── Por qué pregunta QUÉ pasó y no solo confirma ──
 *
 * Porque son dos hechos distintos con consecuencias distintas. Si el abonado
 * trajo la ONT, hay un aparato que tiene que entrar al inventario y alguien
 * debería revisarlo. Si la pagó, entró plata y no hay equipo. Y si es un
 * arreglo comercial —se le perdona para que vuelva a contratar— eso es una
 * decisión de alguien, con nombre.
 *
 * Guardar solo "saldada" haría que dentro de un año las tres se lean igual.
 */
const MOTIVOS_SALDO = [
  {
    clave: 'devolvio',
    label: 'Devolvió el equipo',
    icono: PackageCheck,
    nota: 'Lo trajo a la oficina.',
    aviso: 'El equipo hay que darlo de alta en el inventario aparte: esto solo borra la deuda.',
  },
  {
    clave: 'pago',
    label: 'Pagó el valor',
    icono: Wallet,
    nota: 'En efectivo, en la oficina.',
    aviso: 'El cobro se registra en Pagos como cualquier otro: esto solo borra la deuda.',
  },
  {
    clave: 'otro',
    label: 'Otro arreglo',
    icono: null,
    nota: '',
    aviso: 'Escribí qué se acordó y con quién. Es lo que va a explicar esta decisión más adelante.',
  },
]

function SaldarDeuda({ abierto, cliente, onCerrar, onListo, onError }) {
  const [motivo, setMotivo] = useState('devolvio')
  const [nota, setNota] = useState(MOTIVOS_SALDO[0].nota)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    if (abierto) {
      setMotivo('devolvio')
      setNota(MOTIVOS_SALDO[0].nota)
    }
  }, [abierto])

  const elegir = (m) => {
    setMotivo(m.clave)
    // Se reemplaza la nota solo si era la sugerida: lo que la persona escribió
    // no se pisa por tocar otro botón.
    setNota((n) => (MOTIVOS_SALDO.some((x) => x.nota === n) || !n.trim() ? m.nota : n))
  }

  const elegido = MOTIVOS_SALDO.find((m) => m.clave === motivo)

  async function guardar() {
    setGuardando(true)
    onError?.(null)
    try {
      await carteraApi.saldarDeudaEquipo(cliente.id, `${elegido.label}: ${nota}`.trim())
      onCerrar()
      await onListo?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal abierto={abierto} titulo="Saldar la deuda del equipo" onCerrar={onCerrar}>
      <div className="space-y-4">
        <div className="t-panel p-3">
          <div className="text-xs text-slate-400">{cliente.nombre}</div>
          <div className="mt-0.5 text-2xl font-semibold text-amber-400">
            {dinero(cliente.deuda_equipo)}
          </div>
          <div className="text-[11px] text-slate-500">
            Es el valor del equipo que no volvió. Al saldarla, deja de avisarse cuando esta cédula
            aparezca en un prospecto nuevo.
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs text-slate-400">¿Qué pasó?</p>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {MOTIVOS_SALDO.map((m) => (
              <button
                key={m.clave}
                type="button"
                onClick={() => elegir(m)}
                className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs transition ${
                  motivo === m.clave
                    ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {m.icono && <m.icono size={14} />}
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <label className="block text-xs text-slate-400">
          Detalle
          <Textarea
            rows={2}
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Quién lo trajo, con quién se acordó…"
            className="mt-1"
          />
        </label>

        {elegido?.aviso && <Aviso>{elegido.aviso}</Aviso>}

        <p className="text-[11px] text-slate-500">
          Queda registrado en la auditoría con tu nombre y la fecha: es plata, y alguien decidió
          borrarla.
        </p>

        <div className="flex justify-end gap-2">
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            onClick={guardar}
            cargando={guardando}
            disabled={!nota.trim()}
          >
            Saldar {dinero(cliente.deuda_equipo)}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

const Dato = ({ etiqueta, children }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wide text-slate-500">{etiqueta}</div>
    <div className="mt-0.5">{children}</div>
  </div>
)
