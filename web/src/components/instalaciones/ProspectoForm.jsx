import { useState } from 'react'
import { Crosshair, UserPlus, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { ubicacionActual } from '../../lib/soporte'
import { TECNOLOGIAS, TIPOS } from '../../lib/instalaciones'
import BuscadorCliente from '../pagos/BuscadorCliente'
import { Aviso, Button, Card, Field, Input, Select, Textarea } from '../ui'
import AntecedentesAbonado from '../ventas/AntecedentesAbonado'

/**
 * Alta de un trabajo nuevo.
 *
 * Cubre los dos casos con el mismo formulario porque son el mismo trámite: el
 * que llama pidiendo internet por primera vez —un prospecto, que todavía no
 * existe en ningún lado— y el abonado que ya está y pide un traslado.
 *
 * La diferencia está en de dónde salen los datos: el prospecto los dicta por
 * teléfono, y el cliente existente los trae de su ficha. Pedirlos de nuevo
 * sería invitar a que queden dos direcciones distintas para la misma casa.
 */

const hoy = () => new Date().toISOString().slice(0, 10)

const VACIO = {
  tipo: 'nueva',
  tecnologia: 'ftth',
  nombre: '',
  tipo_identificacion: '05',
  identificacion: '',
  telefono: '',
  telefono_whatsapp: '',
  email: '',
  direccion: '',
  referencia: '',
  sector: '',
  canton: '',
  latitud: '',
  longitud: '',
  fecha: hoy(),
  notas: '',
}

export default function ProspectoForm({ onError, onCreado }) {
  const [form, setForm] = useState(VACIO)
  const [cliente, setCliente] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [ubicando, setUbicando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  /** Un cliente existente completa el formulario con lo que ya está cargado. */
  function elegirCliente(c) {
    setCliente(c)
    setForm((f) => ({
      ...f,
      tipo: 'traslado',
      nombre: c.nombre ?? '',
      identificacion: c.identificacion ?? '',
      telefono: c.telefono ?? c.telefono_movil ?? '',
      email: c.email ?? '',
      direccion: c.direccion ?? '',
      latitud: c.latitud ?? '',
      longitud: c.longitud ?? '',
    }))
  }

  async function tomarUbicacion() {
    setUbicando(true)
    const punto = await ubicacionActual()
    setUbicando(false)

    if (!punto) {
      return onError?.(
        Object.assign(new Error('No se pudo obtener la ubicación'), {
          hint: 'El navegador la pide por permiso y solo la da sobre HTTPS o en localhost.',
        }),
      )
    }
    setForm((f) => ({ ...f, latitud: punto.lat.toFixed(7), longitud: punto.lng.toFixed(7) }))
  }

  async function crear(e) {
    e.preventDefault()
    if (!form.nombre.trim()) return onError?.(new Error('Falta el nombre de quien pide el servicio'))

    setGuardando(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()
      const numero = (v) => (v === '' || v == null ? null : Number(v))
      const texto = (v) => (String(v ?? '').trim() || null)

      const { data, error } = await supabase
        .from('instalaciones')
        .insert({
          client_id: cliente?.id ?? null,
          tipo: form.tipo,
          // Arranca como prospecto aunque ya tenga fecha tentativa: pasa a
          // "agendada" recién cuando se sabe que es factible y hay quién vaya.
          estado: 'prospecto',
          tecnologia: form.tecnologia,
          fecha: form.fecha,

          nombre: form.nombre.trim(),
          tipo_identificacion: form.tipo_identificacion,
          identificacion: texto(form.identificacion),
          telefono: texto(form.telefono),
          telefono_whatsapp: texto(form.telefono_whatsapp) ?? texto(form.telefono),
          email: texto(form.email),

          direccion: texto(form.direccion),
          referencia: texto(form.referencia),
          sector: texto(form.sector),
          canton: texto(form.canton),
          latitud: numero(form.latitud),
          longitud: numero(form.longitud),

          // El tipo de conexión por defecto depende de la tecnología: en fibra
          // casi siempre es PPPoE y en radio, IP administrada desde el router.
          tipo_conexion: form.tecnologia === 'ftth' ? 'pppoe' : 'ip',

          notas: texto(form.notas),
          created_by: sesion?.user?.id ?? null,
        })
        .select('*')
        .single()

      if (error) throw error

      setForm(VACIO)
      setCliente(null)
      await onCreado?.(data)
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Card
      title="Nuevo trabajo"
      subtitle="Los datos que se toman al recibir el pedido. La factibilidad y la agenda se completan después."
      icon={UserPlus}
    >
      <form onSubmit={crear} className="space-y-4">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          {cliente ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-100">{cliente.nombre}</p>
                <p className="text-[11px] text-slate-500">
                  Abonado ya cargado: el trabajo se suma a su ficha.
                </p>
              </div>
              <Button type="button" variante="fantasma" icon={X} onClick={() => setCliente(null)}>
                Quitar
              </Button>
            </div>
          ) : (
            <>
              <p className="mb-2 text-[11px] text-slate-500">
                Si ya es abonado, buscalo acá y el formulario se completa solo. Para alguien nuevo,
                dejá esto vacío.
              </p>
              <BuscadorCliente onElegir={elegirCliente} autoFocus={false} />
            </>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Tipo de trabajo">
            <Select value={form.tipo} onChange={set('tipo')}>
              {TIPOS.map((t) => (
                <option key={t.valor} value={t.valor}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Tecnología" hint={`Se instala una ${TECNOLOGIAS[form.tecnologia].equipo}`}>
            <Select value={form.tecnologia} onChange={set('tecnologia')}>
              {Object.entries(TECNOLOGIAS).map(([valor, t]) => (
                <option key={valor} value={valor}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Nombres y apellidos" className="sm:col-span-2">
            <Input
              value={form.nombre}
              onChange={set('nombre')}
              placeholder="Jefferson Fabián Oña Riera"
              required
            />
          </Field>

          <Field label="Tipo de documento">
            <Select value={form.tipo_identificacion} onChange={set('tipo_identificacion')}>
              <option value="05">Cédula</option>
              <option value="04">RUC</option>
              <option value="06">Pasaporte</option>
            </Select>
          </Field>

          <Field label="Cédula / RUC">
            <Input
              value={form.identificacion}
              onChange={set('identificacion')}
              inputMode="numeric"
              placeholder="1712345678"
            />
          </Field>

          {/* Si esa identificación ya fue abonada, se dice acá mismo — sobre
              todo si quedó con un equipo sin devolver. Avisa, no bloquea. */}
          <AntecedentesAbonado identificacion={form.identificacion} />

          <Field label="Teléfono">
            <Input value={form.telefono} onChange={set('telefono')} inputMode="tel" placeholder="0991234567" />
          </Field>

          <Field label="WhatsApp" hint="Vacío = el mismo teléfono">
            <Input
              value={form.telefono_whatsapp}
              onChange={set('telefono_whatsapp')}
              inputMode="tel"
            />
          </Field>

          <Field label="Correo" className="sm:col-span-2">
            <Input type="email" value={form.email} onChange={set('email')} />
          </Field>

          <Field label="Fecha del pedido">
            <Input type="date" value={form.fecha} onChange={set('fecha')} required />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Dirección" className="sm:col-span-2">
            <Input value={form.direccion} onChange={set('direccion')} placeholder="Calle y número" />
          </Field>

          <Field label="Sector / barrio">
            <Input value={form.sector} onChange={set('sector')} />
          </Field>

          <Field label="Cantón">
            <Input value={form.canton} onChange={set('canton')} />
          </Field>

          <Field
            label="Referencia"
            className="sm:col-span-2"
            hint="Cómo se reconoce la casa. En un barrio sin nomenclatura es lo único que sirve."
          >
            <Input value={form.referencia} onChange={set('referencia')} placeholder="Portón verde, frente a la cancha" />
          </Field>

          <Field label="Latitud">
            <Input value={form.latitud} onChange={set('latitud')} placeholder="-0.1806" inputMode="decimal" />
          </Field>

          <Field label="Longitud">
            <Input value={form.longitud} onChange={set('longitud')} placeholder="-78.4678" inputMode="decimal" />
          </Field>
        </div>

        <Button type="button" icon={Crosshair} onClick={tomarUbicacion} cargando={ubicando}>
          Tomar ubicación del dispositivo
        </Button>

        {!form.latitud && (
          <Aviso>
            Sin coordenadas no se puede validar la cobertura: la factibilidad se calcula por
            distancia a las cajas y torres cargadas.
          </Aviso>
        )}

        <Field label="Notas">
          <Textarea rows={2} value={form.notas} onChange={set('notas')} placeholder="Qué pidió, por dónde entró el pedido…" />
        </Field>

        <Button type="submit" variante="primario" icon={UserPlus} cargando={guardando}>
          Registrar pedido
        </Button>
      </form>
    </Card>
  )
}
