import { useEffect, useState } from 'react'
import { ArrowLeft, Mail, Send } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input } from '../components/ui'

/**
 * El servidor de correo del sistema. Se configura una vez y lo usa todo.
 *
 * Estaba adentro de Facturación, junto a los datos del SRI, porque ahí nació:
 * el primer correo que hubo que mandar fue el comprobante. Pero la casilla no
 * es un detalle de la facturación — por ella salen también los avisos de
 * vencimiento, los de corte y lo que mande Mensajería. Configurarla desde una
 * pantalla de facturas hace creer que solo sirve para facturas, y que cambiarla
 * pone en riesgo la emisión.
 *
 * Es una sola casilla para todo el sistema. Si mañana hay dos ISPs en la misma
 * instalación va a hacer falta una por empresa, pero eso todavía no pasa y
 * adelantarlo solo agrega una pregunta más al que la configura.
 */
export default function ServidorCorreoPage() {
  const [config, setConfig] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)
  const [destino, setDestino] = useState('')
  const [probando, setProbando] = useState(false)
  const [prueba, setPrueba] = useState(null)

  useEffect(() => {
    api.sri
      .config()
      .then((c) => setConfig(c ?? {}))
      .catch(setError)
      .finally(() => setCargando(false))
  }, [])

  const set = (campo) => (e) => {
    setGuardado(false)
    setConfig((c) => ({ ...c, [campo]: e.target.value }))
  }

  /**
   * Se guardan SOLO los campos del correo.
   *
   * El resto de la configuración —RUC, ambiente, secuenciales— se comparte la
   * misma fila, y mandarla entera desde acá significaría pisarla con lo que
   * esta pantalla tenga cargado. Tocar el SMTP no puede cambiar el ambiente del
   * SRI sin que nadie lo pida.
   */
  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setGuardado(false)
    setError(null)
    try {
      const guardadoOk = await api.sri.guardarConfig({
        smtp_host: config.smtp_host ?? '',
        smtp_port: config.smtp_port ?? 587,
        smtp_user: config.smtp_user ?? '',
        // Vacía significa "no la cambies": si se mandara, borraría la guardada
        // cada vez que alguien entra a corregir el puerto.
        ...(config.smtp_pass ? { smtp_pass: config.smtp_pass } : {}),
        email_from: config.email_from ?? '',
        email_from_name: config.email_from_name ?? '',
      })
      setConfig(guardadoOk)
      setGuardado(true)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Prueba con un envío de verdad, no validando credenciales.
   *
   * Autenticarse es una cosa y estar autorizado a enviar desde ese remitente es
   * otra. La segunda solo se ve cuando el correo llega —o cuando rebota—, y es
   * justo la que falla en Gmail y en los dominios con SPF.
   */
  async function probar() {
    const para = destino.trim()
    if (!para) return
    setProbando(true)
    setPrueba(null)
    setError(null)
    try {
      const r = await api.sri.probarSmtp({ para })
      setPrueba(r.destino ?? para)
    } catch (err) {
      setError(err)
    } finally {
      setProbando(false)
    }
  }

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Servidor de correo</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-snug text-slate-500">
          La casilla desde la que el sistema le escribe al abonado. Se configura una vez y la usan
          todos los envíos: la factura con su XML, el aviso de vencimiento, el de corte y lo que
          salga por Mensajería.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <form onSubmit={guardar} className="space-y-4">
        <Card title="Conexión" icon={Mail}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Servidor SMTP" hint="Gmail: smtp.gmail.com">
              <Input value={config?.smtp_host ?? ''} onChange={set('smtp_host')} required />
            </Field>
            <Field label="Puerto" hint="587 con STARTTLS · 465 con TLS directo">
              <Input type="number" value={config?.smtp_port ?? 587} onChange={set('smtp_port')} />
            </Field>
            <Field label="Usuario">
              <Input value={config?.smtp_user ?? ''} onChange={set('smtp_user')} />
            </Field>
            <Field
              label="Contraseña"
              hint={
                config?.tiene_smtp
                  ? 'Ya hay una guardada: dejala vacía para no cambiarla.'
                  : 'En Gmail hace falta una contraseña de aplicación, no la de la cuenta.'
              }
            >
              <Input
                type="password"
                value={config?.smtp_pass ?? ''}
                onChange={set('smtp_pass')}
                placeholder={config?.tiene_smtp ? '••••••••' : ''}
                autoComplete="new-password"
              />
            </Field>
          </div>
        </Card>

        <Card title="Remitente" subtitle="Lo que ve el abonado cuando le llega el correo">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dirección" hint="ej. facturacion@tuisp.com">
              <Input type="email" value={config?.email_from ?? ''} onChange={set('email_from')} />
            </Field>
            <Field label="Nombre" hint="ej. Internet del Valle">
              <Input value={config?.email_from_name ?? ''} onChange={set('email_from_name')} />
            </Field>
          </div>

          {/* Un remitente distinto del usuario SMTP es la causa más común de que
              el correo salga y no llegue: el proveedor lo acepta y el destino lo
              descarta por SPF. Se avisa antes, no después del primer reclamo. */}
          {config?.email_from &&
            config?.smtp_user &&
            config.email_from.toLowerCase() !== config.smtp_user.toLowerCase() && (
              <Aviso tipo="alerta">
                El remitente no es el mismo que el usuario del SMTP. Suele funcionar solo si el
                dominio te autoriza a enviar en su nombre; si no, el correo sale pero termina en
                spam o rebota. Probalo antes de confiarle las facturas.
              </Aviso>
            )}
        </Card>

        {guardado && <Aviso>Configuración guardada.</Aviso>}

        <div className="flex justify-end">
          <Button type="submit" variante="primario" cargando={guardando}>
            Guardar
          </Button>
        </div>
      </form>

      <Card title="Probar" subtitle="Manda un correo de verdad para ver si llega">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Enviar a" className="min-w-64 flex-1">
              <Input
                type="email"
                value={destino}
                onChange={(e) => setDestino(e.target.value)}
                placeholder={config?.email_from || 'tu@correo.com'}
              />
            </Field>
            <Button
              type="button"
              variante="secundario"
              icon={Send}
              cargando={probando}
              disabled={!config?.tiene_smtp || !destino.trim()}
              onClick={probar}
            >
              Enviar prueba
            </Button>
          </div>

          {!config?.tiene_smtp && (
            <p className="text-xs text-slate-500">
              Guardá primero la contraseña para poder probar.
            </p>
          )}

          {prueba && (
            <Aviso>
              Enviado a {prueba}. Que el servidor lo haya aceptado no quiere decir que haya
              llegado: revisá la casilla, y también la carpeta de spam.
            </Aviso>
          )}
        </div>
      </Card>
    </div>
  )
}
