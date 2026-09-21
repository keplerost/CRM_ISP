import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Calculator,
  Check,
  Gift,
  MessageCircle,
  Printer,
  Search,
  UserPlus,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Select,
  SkeletonTabla,
  Table,
  Textarea,
} from '../../components/ui'
import BotonTema from '../../components/ventas/BotonTema'
import { useTemaCampo } from '../../lib/temaCampo'
import { usePermisos } from '../../lib/AuthContext'
import { dineroCero as dinero } from '../../lib/formato'
import { paleta } from '../../lib/comercial'
import { enlaceWhatsApp } from '../../lib/telefono'
import { ventasApi } from '../../lib/ventas'
import { personalApi } from '../../lib/personal'
import { promocionesApi, aplicar, aplicaAlPlan } from '../../lib/promociones'
import {
  aWhatsApp,
  conFirma,
  prepararWhatsApp,
  ultimosMensajes,
} from '../../lib/mensajesComerciales'

/**
 * Cotizador.
 *
 * ── Por qué existe aparte de la ficha del prospecto ──
 *
 * Se podía cotizar, pero solo después de cargar a la persona. Y eso no es como
 * pasa: entra uno al local o llama preguntando "¿cuánto sale?", y todavía no es
 * un prospecto — está averiguando.
 *
 * Obligar a cargarlo antes produce dos cosas malas: una base llena de curiosos
 * que nadie va a volver a llamar, o —lo más común— un precio dicho de memoria y
 * anotado en ningún lado. Después el cliente vuelve, otro vendedor le dice otro
 * número, y la venta se cae por eso.
 *
 * Acá se arma el precio primero. Si la persona se interesa, un botón la convierte
 * en prospecto con la cotización ya adentro.
 *
 * ── Qué NO pide ──
 *
 * Cédula, dirección, correo. Pedirle los documentos a alguien que está
 * preguntando un precio es cómo se termina la conversación. Nombre y teléfono
 * alcanzan para poder volver a llamarlo.
 */

const VACIA = {
  nombre: '',
  telefono: '',
  sector: '',
  plan_id: '',
  precio_mensual: 0,
  costo_instalacion: 0,
  costo_equipo: 0,
  descuento: 0,
  promocion_id: '',
  meses_contrato: '',
  validez_dias: 15,
  notas: '',
}

export default function CotizadorPage() {
  const { perfil } = usePermisos()
  const { tema, alternar } = useTemaCampo()
  const navegar = useNavigate()
  const C = paleta(tema)

  const [planes, setPlanes] = useState([])
  const [promos, setPromos] = useState([])
  const [historial, setHistorial] = useState([])
  const [mensajes, setMensajes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [form, setForm] = useState({ ...VACIA })
  const [ultima, setUltima] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [pl, pr, cot, msj] = await Promise.all([
        ventasApi.planes(),
        // Solo las vigentes: la vista no devuelve las vencidas, así que no hay
        // forma de ofrecer una promo que ya terminó ni por descuido.
        promocionesApi.vigentes(),
        supabase.from('v_cotizaciones').select('*').order('creado_en', { ascending: false }).limit(60),
        // Si la migración 83 todavía no corrió, la pantalla funciona igual: la
        // lista de mensajes queda vacía y el resto no se entera.
        ultimosMensajes(20).catch(() => []),
      ])
      setPlanes(pl)
      setPromos(pr)
      setHistorial(cot.data ?? [])
      setMensajes(msj)
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const plan = planes.find((p) => p.id === form.plan_id)

  /**
   * Las promos que sirven para el plan elegido.
   *
   * Se filtra por plan y no se muestran todas en gris porque una promo visible
   * es una promo que alguien va a ofrecer. Si no aplica, no está.
   */
  const promosDelPlan = useMemo(
    () => (form.plan_id ? promos.filter((p) => aplicaAlPlan(p, form.plan_id)) : []),
    [promos, form.plan_id],
  )

  const promo = promos.find((p) => p.id === form.promocion_id) ?? null

  const total = useMemo(() => {
    const n = (v) => Number(v) || 0
    const r = aplicar(promo, {
      mensual: n(form.precio_mensual),
      instalacion: n(form.costo_instalacion),
    })
    // El descuento suelto sigue existiendo y se suma a la promo: es para el caso
    // puntual que se negocia en el momento, no para reemplazarla.
    const primerPago = r.primerMes + r.instalacion + n(form.costo_equipo) - n(form.descuento)
    return { ...r, primerPago: Math.max(0, primerPago) }
  }, [form, promo])

  /**
   * El texto que se le manda al cliente.
   *
   * Se arma acá y no se deja escribir a mano porque es el mensaje que va a salir
   * cincuenta veces por semana: si cada uno lo redacta, cada cliente recibe
   * condiciones distintas de la misma oferta.
   */
  const mensaje = useMemo(() => {
    if (!plan) return ''
    const l = [
      `Hola${form.nombre ? ` ${form.nombre.split(' ')[0]}` : ''}, le paso la cotización:`,
      '',
      `Plan ${plan.nombre}`,
      `Mensualidad: ${dinero(total.mensualNormal)} (IVA incluido)`,
    ]
    if (promo) {
      l.push('', `${promo.nombre}: ${total.descripcion}`)
      if (promo.descripcion) l.push(promo.descripcion)
    }
    if (Number(form.costo_instalacion) > 0)
      l.push(
        total.instalacion === 0
          ? `Instalación: sin costo (normalmente ${dinero(form.costo_instalacion)})`
          : `Instalación: ${dinero(total.instalacion)}`,
      )
    if (Number(form.costo_equipo) > 0) l.push(`Equipo: ${dinero(form.costo_equipo)}`)
    if (Number(form.descuento) > 0) l.push(`Descuento adicional: -${dinero(form.descuento)}`)
    l.push('', `Primer pago: ${dinero(total.primerPago)}`)
    // Cuando hay promo se dicen los dos precios y por cuánto tiempo rige cada
    // uno. Decir solo el promocional es lo que produce el reclamo al cuarto mes.
    if (total.gratis) {
      l.push(
        `Los primeros ${total.meses} ${total.meses === 1 ? 'mes' : 'meses'} no paga mensualidad`,
      )
      l.push(`A partir del mes ${total.meses + 1}: ${dinero(total.mensualNormal)} por mes`)
    } else if (total.meses > 0) {
      l.push(
        `Después: ${dinero(total.mensual)} por mes durante ${total.meses} ${
          total.meses === 1 ? 'mes' : 'meses'
        }`,
      )
      l.push(`A partir del mes ${total.meses + 1}: ${dinero(total.mensualNormal)} por mes`)
    } else {
      l.push(`Después: ${dinero(total.mensualNormal)} por mes`)
    }
    if (form.meses_contrato) l.push(`Permanencia: ${form.meses_contrato} meses`)
    l.push('', `Válida por ${form.validez_dias} días.`)
    if (promo?.vigente_hasta) l.push(`La promoción se toma hasta el ${fecha(promo.vigente_hasta)}.`)
    l.push('Todos los valores incluyen IVA.')
    return l.join('\n')
  }, [plan, form, total, promo])

  const numeroWa = aWhatsApp(form.telefono)

  /**
   * El enlace se calcula acá y el botón es un `<a>` de verdad.
   *
   * La versión obvia —un botón que registra, espera, y después abre WhatsApp—
   * no funciona: el navegador bloquea como popup cualquier ventana que se abre
   * después de un `await`. El clic tiene que abrir el chat en el mismo latido.
   *
   * Así que el registro sale en paralelo, sin esperarlo. No se pierde: la
   * pestaña del sistema sigue viva mientras WhatsApp abre en otra, así que el
   * pedido termina igual.
   */
  const enlaceWa = useMemo(
    () => (numeroWa && mensaje ? enlaceWhatsApp(numeroWa, conFirma(mensaje, perfil)) : null),
    [numeroWa, mensaje, perfil],
  )

  /**
   * Deja anotado el mensaje. Ojo con qué anota: que se PREPARÓ.
   *
   * El envío ocurre en el teléfono del vendedor, fuera del sistema, y él puede
   * cerrar WhatsApp sin apretar enviar. Decir "enviado" sería cómodo y sería
   * mentira, y el día que haya que reclamar "yo le avisé" no probaría nada.
   */
  const anotarMensaje = () => {
    if (!enlaceWa) return
    prepararWhatsApp({
      telefono: form.telefono,
      cuerpo: mensaje,
      perfil,
      cotizacion_id: ultima?.id ?? null,
    })
      .then(async (r) => {
        // El mensaje se manda igual aunque el registro falle: perder la venta
        // porque no se pudo escribir una fila de auditoría sería el peor cambio.
        if (r.error) {
          setError(new Error(`El mensaje se abrió, pero no quedó registrado: ${r.error.message}`))
          return
        }
        setMensajes(await ultimosMensajes(20).catch(() => []))
      })
      .catch((err) => setError(err))
  }

  const guardar = async () => {
    if (!form.plan_id) return setError(new Error('Elegí el plan'))
    if (!form.nombre.trim()) return setError(new Error('Falta el nombre de quien consulta'))

    setGuardando(true)
    try {
      const { data, error: err } = await supabase
        .from('cotizaciones')
        .insert({
          nombre: form.nombre.trim(),
          telefono: form.telefono.trim() || null,
          sector: form.sector.trim() || null,
          plan_id: form.plan_id,
          // El nombre del plan se copia: si mañana se renombra o se retira, la
          // cotización que el cliente tiene en la mano tiene que seguir diciendo
          // lo mismo.
          plan_nombre: plan?.nombre ?? null,
          promocion_id: form.promocion_id || null,
          // Igual que el plan: el nombre se copia. Si la promo se retira, la
          // cotización tiene que seguir diciendo qué se le prometió.
          promocion_nombre: promo?.nombre ?? null,
          // Se guardan los montos EFECTIVOS —lo que se va a cobrar— y no la
          // promo para volver a aplicarla al leer. Si mañana se corrige la
          // promoción, no puede cambiar lo que dice el papel que el cliente ya
          // tiene en la mano.
          precio_mensual: Number(form.precio_mensual) || 0,
          precio_promocional: total.mensual !== total.mensualNormal ? total.mensual : null,
          meses_promocion: total.meses || null,
          primer_mes: total.primerMes,
          costo_instalacion: total.instalacion,
          costo_equipo: Number(form.costo_equipo) || 0,
          descuento: Number(form.descuento) || 0,
          meses_contrato: form.meses_contrato || null,
          validez_dias: Number(form.validez_dias) || 15,
          notas: form.notas.trim() || null,
          estado: 'enviada',
          vendedor_id: perfil?.id ?? null,
          creado_por: perfil?.id ?? null,
        })
        .select()
        .single()
      if (err) throw err

      personalApi.registrar(
        'cotizacion.crear',
        `Cotizó a ${form.nombre} — ${plan?.nombre}${promo ? ` con ${promo.nombre}` : ''}`,
        {
          entidad: 'cotizacion',
          entidad_id: data.id,
        },
      )

      setUltima(data)
      setForm({ ...VACIA })
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const convertir = async (cot) => {
    try {
      const { data, error: err } = await supabase.rpc('convertir_cotizacion_en_prospecto', {
        p_cotizacion: cot.id,
      })
      if (err) throw new Error(err.message.replace(/^.*?:\s*/, ''))
      await recargar()
      navegar(`/ventas/prospectos?p=${data}`)
    } catch (err) {
      setError(err)
    }
  }

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    if (!q) return historial
    return historial.filter((c) =>
      [c.cliente, c.contacto, c.plan_nombre, c.zona, c.promocion_nombre]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }, [historial, busqueda])

  return (
    <div className="campo campo-fondo -m-6 space-y-4 p-4 md:p-6" data-tema={tema}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="campo-txt flex items-center gap-2 text-xl font-semibold">
            <Calculator size={20} style={{ color: C.serie }} />
            Cotizador
          </h1>
          <p className="campo-suave text-sm">
            Armá el precio para alguien que está preguntando. Si se interesa, se convierte en
            prospecto con la cotización adentro.
          </p>
        </div>
        <BotonTema tema={tema} onAlternar={alternar} />
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-3 lg:grid-cols-3">
        {/* ── El formulario ── */}
        <Card title="Nueva cotización" className="lg:col-span-2">
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="¿Quién pregunta?">
                <Input
                  value={form.nombre}
                  onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                  placeholder="Nombre y apellido"
                />
              </Field>
              <Field label="Teléfono" hint="Para poder mandarle la cotización.">
                <Input
                  value={form.telefono}
                  onChange={(e) => setForm({ ...form, telefono: e.target.value })}
                  inputMode="tel"
                />
              </Field>
              <Field label="Sector o barrio">
                <Input
                  value={form.sector}
                  onChange={(e) => setForm({ ...form, sector: e.target.value })}
                />
              </Field>
            </div>

            <Field
              label="Plan"
              hint="Los precios ya incluyen IVA: es lo que el cliente va a pagar. El valor se copia y queda congelado."
            >
              <Select
                value={form.plan_id}
                onChange={(e) => {
                  const p = planes.find((x) => x.id === e.target.value)
                  // Si la promo elegida no aplica al plan nuevo, se suelta. Es
                  // el único caso donde se le saca algo al vendedor sin que lo
                  // pida, y es a propósito: dejarla puesta cotizaría un
                  // descuento que la promoción no cubre.
                  const sigue =
                    form.promocion_id &&
                    promos.some((x) => x.id === form.promocion_id && aplicaAlPlan(x, e.target.value))
                  setForm({
                    ...form,
                    plan_id: e.target.value,
                    precio_mensual: p?.precio ?? 0,
                    promocion_id: sigue ? form.promocion_id : '',
                  })
                }}
              >
                <option value="">— elegí el plan —</option>
                {planes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre} — {dinero(p.precio)}
                  </option>
                ))}
              </Select>
            </Field>

            {/* ── Promociones ──
                Van como botones y no como un desplegable porque son pocas y
                porque la decisión de ofrecerla se toma mirándolas: un <select>
                cerrado esconde justamente lo que hay que recordar usar. */}
            {form.plan_id && promosDelPlan.length > 0 && (
              <Field
                label="Promoción"
                hint="Es opcional. El precio se recalcula solo y queda guardado cuál se usó."
              >
                <div className="flex flex-wrap gap-2">
                  <BotonPromo
                    activo={!form.promocion_id}
                    onClick={() => setForm({ ...form, promocion_id: '' })}
                    color="#64748b"
                  >
                    Sin promoción
                  </BotonPromo>
                  {promosDelPlan.map((p) => (
                    <BotonPromo
                      key={p.id}
                      activo={form.promocion_id === p.id}
                      onClick={() => setForm({ ...form, promocion_id: p.id })}
                      color={p.color}
                      icono
                    >
                      {p.nombre}
                      {p.dias_restantes != null && p.dias_restantes <= 7 && (
                        <span className="campo-tenue ml-1 text-[10px]">
                          · quedan {p.dias_restantes}d
                        </span>
                      )}
                    </BotonPromo>
                  ))}
                </div>
              </Field>
            )}

            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Mensualidad (con IVA)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.precio_mensual}
                  onChange={(e) => setForm({ ...form, precio_mensual: e.target.value })}
                />
              </Field>
              <Field label="Instalación">
                <Input
                  type="number"
                  step="0.01"
                  value={form.costo_instalacion}
                  onChange={(e) => setForm({ ...form, costo_instalacion: e.target.value })}
                />
              </Field>
              <Field label="Equipo">
                <Input
                  type="number"
                  step="0.01"
                  value={form.costo_equipo}
                  onChange={(e) => setForm({ ...form, costo_equipo: e.target.value })}
                />
              </Field>
              <Field label="Descuento">
                <Input
                  type="number"
                  step="0.01"
                  value={form.descuento}
                  onChange={(e) => setForm({ ...form, descuento: e.target.value })}
                />
              </Field>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Permanencia (meses)">
                <Input
                  type="number"
                  value={form.meses_contrato}
                  onChange={(e) => setForm({ ...form, meses_contrato: e.target.value })}
                  placeholder="sin permanencia"
                />
              </Field>
              <Field label="Válida por (días)">
                <Input
                  type="number"
                  value={form.validez_dias}
                  onChange={(e) => setForm({ ...form, validez_dias: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Notas internas" hint="No salen en el mensaje al cliente.">
              <Textarea
                rows={2}
                value={form.notas}
                onChange={(e) => setForm({ ...form, notas: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        {/* ── El resultado, siempre a la vista ── */}
        <div className="space-y-3">
          <Card title="Lo que paga">
            {!plan ? (
              <p className="campo-tenue py-8 text-center text-[13px]">Elegí un plan para ver el total.</p>
            ) : (
              <>
                <div
                  className="rounded-xl border p-3 text-center"
                  style={{ borderColor: `${C.serie}55`, background: `${C.serie}14` }}
                >
                  <div className="campo-tenue text-[11px]">Primer pago · IVA incluido</div>
                  <div className="campo-txt text-3xl font-semibold">{dinero(total.primerPago)}</div>
                  <div className="campo-suave mt-1 text-[12px]">
                    {total.gratis ? (
                      <>
                        {total.meses} {total.meses === 1 ? 'mes' : 'meses'} sin pagar, después{' '}
                        {dinero(total.mensualNormal)} por mes
                      </>
                    ) : total.meses > 0 ? (
                      <>
                        después {dinero(total.mensual)} por {total.meses}{' '}
                        {total.meses === 1 ? 'mes' : 'meses'}, luego{' '}
                        {dinero(total.mensualNormal)}
                      </>
                    ) : (
                      <>después {dinero(total.mensualNormal)} por mes</>
                    )}
                  </div>
                </div>

                {/* El ahorro es el argumento de venta, así que se muestra
                    calculado. Que el vendedor lo estime de cabeza es cómo un
                    "ahorrás como cuarenta" termina siendo veinticinco. */}
                {promo && (
                  <div
                    className="mt-2 flex items-start gap-2 rounded-xl border p-2.5"
                    style={{ borderColor: `${promo.color}55`, background: `${promo.color}14` }}
                  >
                    <Gift size={15} className="mt-0.5 shrink-0" style={{ color: promo.color }} />
                    <div>
                      <div className="campo-txt text-[12px] font-semibold">{promo.nombre}</div>
                      <div className="campo-suave text-[11px]">{total.descripcion}</div>
                      {total.ahorro > 0 && (
                        <div className="text-[11px]" style={{ color: C.bien }}>
                          Se ahorra {dinero(total.ahorro)}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="mt-3 space-y-1 text-[12px]">
                  <Linea etiqueta={`Plan ${plan.nombre}`} valor={dinero(total.mensualNormal)} />
                  {total.mensual !== total.mensualNormal && (
                    <Linea
                      etiqueta="— con la promo"
                      valor={dinero(total.mensual)}
                      color={promo?.color}
                    />
                  )}
                  {plan.iva_valor > 0 && (
                    <Linea
                      etiqueta={`— de eso, IVA ${plan.iva_porcentaje}%`}
                      valor={dinero(plan.iva_valor)}
                    />
                  )}
                  {Number(form.costo_instalacion) > 0 &&
                    (total.instalacion === 0 ? (
                      <Linea etiqueta="Instalación" valor="sin costo" color={C.bien} />
                    ) : (
                      <Linea etiqueta="Instalación" valor={dinero(total.instalacion)} />
                    ))}
                  {Number(form.costo_equipo) > 0 && (
                    <Linea etiqueta="Equipo" valor={dinero(form.costo_equipo)} />
                  )}
                  {total.gratis && (
                    <Linea
                      etiqueta={`Primeros ${total.meses} ${total.meses === 1 ? 'mes' : 'meses'}`}
                      valor="no paga"
                      color={C.bien}
                    />
                  )}
                  {Number(form.descuento) > 0 && (
                    <Linea
                      etiqueta="Descuento adicional"
                      valor={`-${dinero(form.descuento)}`}
                      color={C.bien}
                    />
                  )}
                </div>

                <div className="mt-3 space-y-2">
                  <Button
                    variante="primario"
                    className="w-full py-3"
                    cargando={guardando}
                    disabled={guardando || !form.nombre.trim()}
                    onClick={guardar}
                  >
                    Guardar cotización
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <a
                      href={enlaceWa ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      onClick={anotarMensaje}
                      className={`campo-borde flex items-center justify-center gap-1.5 rounded-lg border py-2.5 text-[13px] ${
                        enlaceWa ? 'campo-suave hover:campo-txt' : 'pointer-events-none opacity-40'
                      }`}
                    >
                      <MessageCircle size={15} /> WhatsApp
                    </a>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="campo-borde campo-suave flex items-center justify-center gap-1.5 rounded-lg border py-2.5 text-[13px]"
                    >
                      <Printer size={15} /> Imprimir
                    </button>
                  </div>
                  {/* Decir exactamente qué hace el botón. Un vendedor que cree
                      que el sistema envía por él no revisa que haya salido. */}
                  <p className="campo-tenue text-[11px]">
                    Abre tu WhatsApp con el texto escrito — lo enviás vos. Queda anotado a quién y
                    qué se le dijo.
                  </p>
                </div>
              </>
            )}
          </Card>

          {ultima && (
            <Aviso>
              Cotización N° <b>{String(ultima.numero).padStart(5, '0')}</b> guardada. Está abajo en
              el historial — desde ahí la podés convertir en prospecto.
            </Aviso>
          )}

          {plan && (
            <Card title="Lo que le llega al cliente" subtitle="Este es el texto exacto del WhatsApp">
              <pre className="campo-suave whitespace-pre-wrap text-[12px] leading-relaxed">
                {conFirma(mensaje, perfil)}
              </pre>
              {/* El mensaje sale de un número que el cliente no tiene agendado.
                  Sin nombre y sin teléfono es un desconocido mandando precios, y
                  así se lo responde: no se lo responde. */}
              {!perfil?.celular && (
                <p className="campo-tenue mt-2 text-[11px]">
                  Tu celular no está cargado en tu ficha, así que el mensaje va sin número de
                  contacto. Pedile a administración que lo cargue en Ajustes → Personal.
                </p>
              )}
            </Card>
          )}
        </div>
      </div>

      {/* ── Historial ── */}
      <Card title="Cotizaciones hechas" subtitle="Quién preguntó, cuánto se le dijo y si se convirtió">
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, teléfono, plan o sector"
            className="pl-9"
          />
        </div>

        {cargando ? (
          <SkeletonTabla filas={5} columnas={6} />
        ) : (
          <Table
            columnas={['N°', 'Cliente', 'Plan', 'Primer pago', 'Mensual', 'Estado', '']}
            filas={visibles}
            vacio="Todavía no se cotizó a nadie."
            renderFila={(c) => (
              <tr key={c.id} className="hover:bg-slate-800/40">
                <td className="campo-tenue px-3 py-2 font-mono text-[12px]">
                  {String(c.numero).padStart(5, '0')}
                </td>
                <td className="px-3 py-2">
                  <div className="campo-txt text-[13px]">{c.cliente}</div>
                  <div className="campo-tenue text-[11px]">
                    {c.contacto ?? 'sin teléfono'}
                    {c.zona ? ` · ${c.zona}` : ''}
                  </div>
                </td>
                <td className="px-3 py-2 text-[12px]">
                  <div className="campo-suave">{c.plan_nombre ?? '—'}</div>
                  {c.promocion_nombre && (
                    <div className="campo-tenue flex items-center gap-1 text-[11px]">
                      <Gift size={11} /> {c.promocion_nombre}
                    </div>
                  )}
                </td>
                <td className="campo-txt px-3 py-2 tabular-nums">{dinero(c.total_primer_pago)}</td>
                <td className="campo-suave px-3 py-2 tabular-nums">{dinero(c.total_mensual)}</td>
                <td className="px-3 py-2">
                  {c.con_prospecto ? (
                    <Badge color="verde">Es prospecto</Badge>
                  ) : c.vencida ? (
                    <Badge color="gris">Vencida</Badge>
                  ) : (
                    <Badge color="azul">Vigente</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {c.con_prospecto ? (
                    <span className="campo-tenue text-[12px]">
                      <Check size={13} className="inline" /> convertida
                    </span>
                  ) : (
                    <Button variante="fantasma" icon={UserPlus} onClick={() => convertir(c)}>
                      Convertir
                    </Button>
                  )}
                </td>
              </tr>
            )}
          />
        )}
        <p className="campo-tenue mt-2 text-[11px]">
          Al convertir, el prospecto nace en la etapa <b>Cotizado</b> —no en "nuevo"— porque ya tiene
          el precio en la mano. El tablero no va a pedir que lo contacten de cero.
        </p>
      </Card>

      {/* ── Los mensajes ──
          RLS decide qué se ve sin que esta pantalla haga nada: el vendedor ve
          los suyos, quien maneja la cartera ve los de todos. */}
      {mensajes.length > 0 && (
        <Card
          title="Mensajes preparados"
          subtitle="Qué se le escribió a quién. El envío lo hace el vendedor desde su teléfono."
        >
          <div className="space-y-1.5">
            {mensajes.map((m) => (
              <div
                key={m.id}
                className="campo-borde flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border px-3 py-2 text-[12px]"
              >
                <span className="campo-txt">{m.prospecto ?? '—'}</span>
                <span className="campo-tenue font-mono text-[11px]">+{m.destino}</span>
                {m.cotizacion_numero && (
                  <span className="campo-tenue text-[11px]">
                    cot. {String(m.cotizacion_numero).padStart(5, '0')}
                  </span>
                )}
                <span className="campo-tenue ml-auto text-[11px]">
                  {m.vendedor ?? '—'} · {new Date(m.creado_en).toLocaleString('es-EC')}
                </span>
                <Badge color={m.estado === 'enviado' ? 'verde' : 'gris'}>
                  {m.estado === 'enviado' ? 'Enviado' : 'Preparado'}
                </Badge>
              </div>
            ))}
          </div>
          <p className="campo-tenue mt-2 text-[11px]">
            Dice <b>preparado</b> y no "enviado" porque el mensaje sale del teléfono del vendedor,
            fuera del sistema: se puede cerrar WhatsApp sin apretar enviar. Cuando se conecte el
            número de la empresa, esos sí van a decir enviado.
          </p>
        </Card>
      )}
    </div>
  )
}

const BotonPromo = ({ activo, onClick, color, icono, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`campo-borde inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[12px] transition ${
      activo ? 'campo-txt font-medium' : 'campo-suave'
    }`}
    style={activo ? { borderColor: color, background: `${color}1f` } : undefined}
  >
    {icono && <Gift size={13} style={{ color }} />}
    {children}
  </button>
)

const fecha = (d) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString('es-EC', { day: '2-digit', month: 'long' }) : ''

const Linea = ({ etiqueta, valor, color }) => (
  <div className="flex justify-between gap-2">
    <span className="campo-suave">{etiqueta}</span>
    <span className="tabular-nums" style={{ color }}>
      <span className={color ? '' : 'campo-txt'}>{valor}</span>
    </span>
  </div>
)
