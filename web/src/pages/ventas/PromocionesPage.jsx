import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BadgePercent,
  CalendarClock,
  Check,
  Gift,
  Pencil,
  Plus,
  Power,
  Tag,
  Wrench,
} from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
} from '../../components/ui'
import BotonTema from '../../components/ventas/BotonTema'
import { useTemaCampo } from '../../lib/temaCampo'
import { usePermisos } from '../../lib/AuthContext'
import { dineroCero as dinero } from '../../lib/formato'
import { paleta } from '../../lib/comercial'
import { ventasApi } from '../../lib/ventas'
import { promocionesApi, TIPOS } from '../../lib/promociones'

/**
 * Promociones.
 *
 * ── Una pantalla, dos lecturas ──
 *
 * El vendedor entra a ver qué puede ofrecer hoy. Quien administra entra a
 * definirlo. Es la misma lista: lo único que cambia es que aparecen los botones
 * de editar y el de crear.
 *
 * Están juntas a propósito. Si la administración viviera en Configuración y el
 * vendedor tuviera su propia vista, serían dos pantallas que hay que mantener
 * sincronizadas, y la primera vez que se desincronicen el vendedor va a estar
 * ofreciendo algo que ya no existe.
 *
 * ── Por qué las vencidas se muestran igual (tachadas) ──
 *
 * Al vendedor no: la vista `v_promociones_vigentes` no se las da. A quien
 * administra sí, porque necesita ver qué se ofreció y con qué resultado —
 * borrarlas de la pantalla haría imposible responder "¿la de Navidad sirvió?".
 */

const VACIA = {
  nombre: '',
  descripcion: '',
  tipo: 'porcentaje',
  valor: '',
  meses_aplica: 3,
  vigente_desde: new Date().toISOString().slice(0, 10),
  vigente_hasta: '',
  color: '#d95926',
  activa: true,
}

const ICONO = {
  porcentaje: BadgePercent,
  meses_gratis: Gift,
  instalacion_gratis: Wrench,
  precio_fijo: Tag,
}

export default function PromocionesPage() {
  const { perfil, puede } = usePermisos()
  const { tema, alternar } = useTemaCampo()
  const C = paleta(tema)

  // Quien puede tocar los precios puede definir promociones. Es la misma
  // decisión: una promo es un precio con fecha.
  const puedeEditar = puede('config.planes')

  const [promos, setPromos] = useState([])
  const [planes, setPlanes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [edicion, setEdicion] = useState(null)
  const [planesSel, setPlanesSel] = useState([])
  const [guardando, setGuardando] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [ps, pl] = await Promise.all([
        // El vendedor no tiene por qué ver las vencidas; quien administra sí.
        puedeEditar ? promocionesApi.todas() : promocionesApi.vigentes(),
        ventasApi.planes(),
      ])
      setPromos(ps)
      setPlanes(pl)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [puedeEditar])

  useEffect(() => {
    recargar()
  }, [recargar])

  const abrir = (promo) => {
    setEdicion(promo ? { ...promo } : { ...VACIA })
    setPlanesSel(promo?.planes ?? [])
  }

  const guardar = async () => {
    if (!edicion.nombre.trim()) return setError(new Error('Ponele un nombre a la promoción'))
    setGuardando(true)
    try {
      await promocionesApi.guardar({ promo: edicion, planes: planesSel }, perfil)
      setEdicion(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const bajar = async (promo) => {
    try {
      await promocionesApi.desactivar(promo)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  const { vivas, terminadas } = useMemo(
    () => ({
      vivas: promos.filter((p) => p.vigente !== false),
      terminadas: promos.filter((p) => p.vigente === false),
    }),
    [promos],
  )

  return (
    <div className="campo campo-fondo -m-6 space-y-4 p-4 md:p-6" data-tema={tema}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="campo-txt flex items-center gap-2 text-xl font-semibold">
            <Gift size={20} style={{ color: C.serie }} />
            Promociones
          </h1>
          <p className="campo-suave text-sm">
            {puedeEditar
              ? 'Lo que el equipo puede ofrecer. Lo que definas acá es lo que van a decir todos.'
              : 'Lo que podés ofrecer hoy. Se aplican solas en el Cotizador — no hace falta calcular nada.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <BotonTema tema={tema} onAlternar={alternar} />
          {puedeEditar && (
            <Button variante="primario" icon={Plus} onClick={() => abrir(null)}>
              Nueva promoción
            </Button>
          )}
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {cargando ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full rounded-2xl" />
          ))}
        </div>
      ) : !promos.length ? (
        <Card>
          <div className="py-10 text-center">
            <Gift size={30} className="campo-tenue mx-auto mb-2" />
            <p className="campo-suave text-sm">
              {puedeEditar
                ? 'Todavía no hay promociones. Creá la primera y va a aparecer en el Cotizador de todo el equipo.'
                : 'No hay promociones vigentes en este momento.'}
            </p>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {vivas.map((p) => (
              <Tarjeta
                key={p.id}
                promo={p}
                planes={planes}
                C={C}
                puedeEditar={puedeEditar}
                onEditar={() => abrir(p)}
                onBajar={() => bajar(p)}
              />
            ))}
          </div>

          {puedeEditar && terminadas.length > 0 && (
            <Card
              title="Terminadas"
              subtitle="No se pueden ofrecer. Quedan para saber cuál funcionó."
            >
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {terminadas.map((p) => (
                  <Tarjeta
                    key={p.id}
                    promo={p}
                    planes={planes}
                    C={C}
                    puedeEditar={puedeEditar}
                    onEditar={() => abrir(p)}
                    onBajar={() => bajar(p)}
                  />
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {!puedeEditar && promos.length > 0 && (
        <Aviso>
          En el <b>Cotizador</b> elegís la promoción y el precio se recalcula solo. Al ganarse la
          venta, el descuento pasa a la ficha del abonado sin que nadie lo cargue a mano.
        </Aviso>
      )}

      {edicion && (
        <Editor
          promo={edicion}
          setPromo={setEdicion}
          planes={planes}
          planesSel={planesSel}
          setPlanesSel={setPlanesSel}
          guardando={guardando}
          onGuardar={guardar}
          onCerrar={() => setEdicion(null)}
        />
      )}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */

function Tarjeta({ promo, planes, C, puedeEditar, onEditar, onBajar }) {
  const Icono = ICONO[promo.tipo] ?? Gift
  const muerta = promo.vigente === false
  const paraPlanes = promo.planes?.length
    ? planes.filter((p) => promo.planes.includes(p.id)).map((p) => p.nombre)
    : null

  return (
    <div
      className="campo-borde relative overflow-hidden rounded-2xl border p-4"
      style={{
        background: muerta ? undefined : `${promo.color}0f`,
        borderColor: muerta ? undefined : `${promo.color}55`,
        opacity: muerta ? 0.6 : 1,
      }}
    >
      {/* La franja de color es lo que hace reconocible una promo de un vistazo:
          el vendedor busca "la naranja", no lee los cuatro títulos. */}
      <div
        className="absolute inset-x-0 top-0 h-1"
        style={{ background: muerta ? '#64748b' : promo.color }}
      />

      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <div
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: `${muerta ? '#64748b' : promo.color}22` }}
          >
            <Icono size={17} style={{ color: muerta ? '#94a3b8' : promo.color }} />
          </div>
          <div>
            <div className={`campo-txt font-semibold ${muerta ? 'line-through' : ''}`}>
              {promo.nombre}
            </div>
            <div className="campo-tenue text-[11px]">{TIPOS[promo.tipo]?.label ?? promo.tipo}</div>
          </div>
        </div>
        {muerta ? (
          <Badge color="gris">{promo.activa ? 'Vencida' : 'De baja'}</Badge>
        ) : promo.dias_restantes != null && promo.dias_restantes <= 7 ? (
          <Badge color="ambar">
            {promo.dias_restantes === 0 ? 'Último día' : `${promo.dias_restantes} días`}
          </Badge>
        ) : (
          <Badge color="verde">Vigente</Badge>
        )}
      </div>

      <div className="campo-txt mt-3 text-2xl font-semibold tabular-nums">
        {resumenCorto(promo)}
      </div>
      {promo.descripcion && (
        <p className="campo-suave mt-1 text-[12px] leading-snug">{promo.descripcion}</p>
      )}

      <div className="campo-tenue mt-3 space-y-1 text-[11px]">
        <div className="flex items-center gap-1.5">
          <CalendarClock size={12} />
          {promo.vigente_hasta
            ? `Se vende hasta el ${fecha(promo.vigente_hasta)}`
            : 'Sin fecha de término'}
        </div>
        <div>
          {paraPlanes ? `Solo: ${paraPlanes.join(', ')}` : 'Aplica a todos los planes'}
        </div>
      </div>

      {/* Cuánto se usó y cuánto cerró. Es la única forma de decidir si se
          renueva o se cambia — sin esto, se renuevan todas por costumbre. */}
      {(promo.cotizada_veces > 0 || promo.ventas_cerradas > 0) && (
        <div className="campo-borde mt-3 flex gap-4 border-t pt-2 text-[11px]">
          <span className="campo-suave">
            <b className="campo-txt tabular-nums">{promo.cotizada_veces}</b> cotizada
            {promo.cotizada_veces === 1 ? '' : 's'}
          </span>
          <span className="campo-suave">
            <b className="tabular-nums" style={{ color: C.bien }}>
              {promo.ventas_cerradas}
            </b>{' '}
            cerrada{promo.ventas_cerradas === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {puedeEditar && (
        <div className="mt-3 flex gap-2">
          <Button variante="fantasma" icon={Pencil} onClick={onEditar}>
            Editar
          </Button>
          {promo.activa && (
            <Button variante="fantasma" icon={Power} onClick={onBajar}>
              Dar de baja
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */

function Editor({
  promo,
  setPromo,
  planes,
  planesSel,
  setPlanesSel,
  guardando,
  onGuardar,
  onCerrar,
}) {
  const tipo = TIPOS[promo.tipo] ?? {}
  const set = (campo) => (e) => setPromo({ ...promo, [campo]: e.target.value })

  const alternarPlan = (id) =>
    setPlanesSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <Modal
      abierto
      titulo={promo.id ? 'Editar promoción' : 'Nueva promoción'}
      onCerrar={onCerrar}
      ancho="max-w-2xl"
    >
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Field label="Nombre" hint="Como lo va a nombrar el equipo: «Promo Navidad».">
            <Input value={promo.nombre} onChange={set('nombre')} placeholder="Promo Navidad" />
          </Field>
          <Field label="Color">
            <input
              type="color"
              value={promo.color}
              onChange={set('color')}
              className="campo-borde h-[38px] w-16 cursor-pointer rounded-lg border bg-transparent p-1"
            />
          </Field>
        </div>

        <Field
          label="Qué se le dice al cliente"
          hint="Sale tal cual en la cotización. Escribilo una vez acá y deja de depender de cómo lo cuente cada uno."
        >
          <Textarea
            rows={2}
            value={promo.descripcion ?? ''}
            onChange={set('descripcion')}
            placeholder="Los primeros 3 meses pagás la mitad."
          />
        </Field>

        <Field label="Qué hace" hint={tipo.ayuda}>
          <Select
            value={promo.tipo}
            onChange={(e) => setPromo({ ...promo, tipo: e.target.value, valor: '' })}
          >
            {Object.entries(TIPOS).map(([k, t]) => (
              <option key={k} value={k}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>

        {promo.tipo !== 'instalacion_gratis' && (
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label={
                promo.tipo === 'porcentaje'
                  ? 'Porcentaje de descuento'
                  : promo.tipo === 'meses_gratis'
                    ? 'Cuántos meses gratis'
                    : 'Precio promocional (con IVA)'
              }
            >
              <Input
                type="number"
                step={promo.tipo === 'meses_gratis' ? '1' : '0.01'}
                value={promo.valor ?? ''}
                onChange={set('valor')}
              />
            </Field>
            {tipo.pideMeses && (
              <Field
                label="Durante cuántos meses"
                hint="Cuánto le dura al cliente. No es lo mismo que hasta cuándo se vende."
              >
                <Input
                  type="number"
                  value={promo.meses_aplica ?? ''}
                  onChange={set('meses_aplica')}
                />
              </Field>
            )}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Se vende desde">
            <Input type="date" value={promo.vigente_desde} onChange={set('vigente_desde')} />
          </Field>
          <Field
            label="Hasta"
            hint="Vacío = sin fecha de término. Con fecha, desaparece sola del Cotizador ese día."
          >
            <Input type="date" value={promo.vigente_hasta ?? ''} onChange={set('vigente_hasta')} />
          </Field>
        </div>

        <Field
          label="Planes"
          hint="Sin marcar ninguno, aplica a todos. Marcá solo si la promo es de un plan puntual."
        >
          <div className="flex flex-wrap gap-2">
            {planes.map((p) => {
              const activo = planesSel.includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => alternarPlan(p.id)}
                  className={`campo-borde flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] ${
                    activo ? 'campo-txt' : 'campo-suave'
                  }`}
                  style={activo ? { borderColor: promo.color, background: `${promo.color}1a` } : undefined}
                >
                  {activo && <Check size={12} />}
                  {p.nombre} · {dinero(p.precio)}
                </button>
              )
            })}
          </div>
        </Field>

        {/* La vista previa muestra la cuenta hecha sobre un plan real. Es el
            control de que el número que se está definiendo es el que se
            pensaba: escribir "precio fijo 18" y ver que el plan de 25 queda en
            18 evita descubrirlo con el cliente adelante. */}
        <VistaPrevia promo={promo} planes={planes} planesSel={planesSel} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variante="fantasma" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variante="primario" cargando={guardando} disabled={guardando} onClick={onGuardar}>
            {promo.id ? 'Guardar cambios' : 'Crear promoción'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function VistaPrevia({ promo, planes, planesSel }) {
  const muestra = planes.filter((p) => !planesSel.length || planesSel.includes(p.id)).slice(0, 3)
  if (!muestra.length) return null

  return (
    <div className="campo-borde rounded-xl border p-3">
      <div className="campo-tenue mb-2 text-[11px] uppercase tracking-wide">
        Así queda la mensualidad
      </div>
      <div className="space-y-1 text-[12px]">
        {muestra.map((p) => {
          const r = aplicarSimple(promo, p.precio)
          return (
            <div key={p.id} className="flex items-center justify-between gap-2">
              <span className="campo-suave">{p.nombre}</span>
              <span className="tabular-nums">
                <span className="campo-tenue line-through">{dinero(p.precio)}</span>{' '}
                <span className="campo-txt font-semibold">{r}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */

const aplicarSimple = (promo, precio) => {
  const v = Number(promo.valor) || 0
  switch (promo.tipo) {
    case 'porcentaje':
      return dinero(precio * (1 - v / 100))
    case 'meses_gratis':
      return `${dinero(0)} los primeros ${v || '—'}`
    case 'precio_fijo':
      return dinero(v)
    default:
      return dinero(precio)
  }
}

const resumenCorto = (p) => {
  const v = Number(p.valor) || 0
  const m = p.meses_aplica
  switch (p.tipo) {
    case 'porcentaje':
      return `${v}% off${m ? ` · ${m} ${m === 1 ? 'mes' : 'meses'}` : ''}`
    case 'meses_gratis':
      return `${v} ${v === 1 ? 'mes' : 'meses'} gratis`
    case 'instalacion_gratis':
      return 'Instalación $0'
    case 'precio_fijo':
      return `${dinero(v)}/mes${m ? ` · ${m} ${m === 1 ? 'mes' : 'meses'}` : ''}`
    default:
      return '—'
  }
}

const fecha = (d) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString('es-EC', { day: '2-digit', month: 'short' }) : '—'
