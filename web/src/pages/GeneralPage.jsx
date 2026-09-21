import { useEffect, useState } from 'react'
import { ArrowLeft, Image, Settings } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/apiNetwork'
import { configurarMoneda } from '../lib/formato'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input } from '../components/ui'

/**
 * La marca del sistema.
 *
 * Es lo primero que quiere cambiar un ISP que acaba de comprar el sistema: no
 * quiere que sus técnicos entren todos los días a una pantalla con el nombre
 * del proveedor.
 *
 * Distinto de Empresa: aquello es lo que sale impreso en la factura y lo valida
 * el SRI. Esto es lo que se ve en pantalla, y puede ser otra cosa.
 */
export default function GeneralPage() {
  const [form, setForm] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.general
      .config()
      .then(setForm)
      .catch(setError)
      .finally(() => setCargando(false))
  }, [])

  const set = (campo) => (e) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: e.target.value }))
  }

  function cargarLogo(e) {
    const f = e.target.files?.[0]
    if (!f) return

    // El logo viaja en cada carga del login, y el login lo abre gente desde el
    // celular con datos móviles.
    if (f.size > 300 * 1024) {
      setError(new Error('El logo pesa más de 300 KB. Con 200×200 alcanza.'))
      e.target.value = ''
      return
    }

    const lector = new FileReader()
    lector.onload = () => {
      setGuardado(false)
      setForm((x) => ({ ...x, logo_b64: lector.result }))
    }
    lector.readAsDataURL(f)
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setGuardado(false)
    setError(null)
    try {
      const r = await api.general.guardar(form)
      setForm(r)
      // Se aplica en el acto: sin esto, los montos seguirían con el símbolo
      // viejo hasta recargar, y quien acaba de cambiarlo pensaría que no anduvo.
      configurarMoneda(r.moneda_simbolo)
      document.title = `${r.nombre_sistema} — ${r.lema ?? ''}`.trim().replace(/—\s*$/, '')
      setGuardado(true)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando />

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">General</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Cómo se ve el sistema por dentro: el nombre y el logo que ven quienes lo usan todos los
          días.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <form onSubmit={guardar} className="space-y-4">
        <Card title="Identidad" icon={Settings}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre del sistema" hint="Se ve al entrar y en la pestaña del navegador">
              <Input
                value={form?.nombre_sistema ?? ''}
                onChange={set('nombre_sistema')}
                maxLength={60}
              />
            </Field>
            <Field
              label="Lema"
              hint="Debajo del nombre. Sirve para distinguir producción de pruebas."
            >
              <Input value={form?.lema ?? ''} onChange={set('lema')} maxLength={80} />
            </Field>
          </div>
        </Card>

        <Card title="Logo" subtitle="El de la pantalla de entrada" icon={Image}>
          <div className="flex flex-wrap items-center gap-6">
            <Field label="Imagen" hint="PNG o JPG, hasta 300 KB. Cuadrado se ve mejor.">
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={cargarLogo}
                className="w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:text-slate-200"
              />
            </Field>

            {form?.logo_b64 && (
              <div className="space-y-2">
                <img
                  src={form.logo_b64}
                  alt="Logo"
                  className="max-h-16 rounded-lg border border-slate-800 p-1"
                />
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, logo_b64: null }))}
                  className="text-xs text-slate-500 hover:text-rose-400"
                >
                  Quitar
                </button>
              </div>
            )}
          </div>
          <Aviso>
            Este logo es el de la pantalla. El que sale impreso en la factura se carga en{' '}
            <Link to="/ajustes/empresa" className="text-sky-400 hover:text-sky-300">
              Empresa
            </Link>
            : suele ser otro, porque uno se ve sobre fondo oscuro y el otro sobre papel blanco.
          </Aviso>
        </Card>

        <Card title="Moneda">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Símbolo" hint="Lo que se imprime antes del monto">
              <Input
                value={form?.moneda_simbolo ?? '$'}
                onChange={set('moneda_simbolo')}
                maxLength={5}
                className="w-24"
              />
            </Field>
            <Field label="Código" hint="Para las pasarelas de pago, que lo piden así">
              <Input
                value={form?.moneda_codigo ?? 'USD'}
                onChange={set('moneda_codigo')}
                maxLength={3}
                className="w-24"
              />
            </Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Ejemplo: <span className="text-slate-300">{form?.moneda_simbolo ?? '$'}25.00</span>
          </p>
        </Card>

        {guardado && <Aviso>Guardado. El nombre se ve al volver a entrar.</Aviso>}

        <div className="flex justify-end">
          <Button type="submit" variante="primario" cargando={guardando}>
            Guardar
          </Button>
        </div>
      </form>
    </div>
  )
}
