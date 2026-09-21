import { useEffect, useState } from 'react'
import { ArrowLeft, Building2, Image } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/apiNetwork'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input } from '../components/ui'

/**
 * Los datos de la empresa.
 *
 * Estaban dentro de Facturación, mezclados con el ambiente del SRI y los
 * secuenciales, porque ahí nacieron: el primer lugar donde hizo falta el RUC
 * fue el comprobante. Pero el nombre, la dirección y el logo salen también en
 * el recibo, en el contrato, en el correo y en cada aviso al abonado.
 *
 * Están acá porque son de la empresa, no de la facturación. Y porque quien
 * acaba de comprar el sistema busca "dónde pongo mis datos" — no se le ocurre
 * entrar a Facturación → Configuración para eso.
 *
 * Lo que SÍ se queda en Facturación es lo del SRI: ambiente, establecimiento,
 * punto de emisión y numeración. Eso no son datos de la empresa, son de cómo
 * emite comprobantes.
 */
export default function EmpresaPage() {
  const [config, setConfig] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.sri
      .config()
      .then((c) => setConfig(c ?? {}))
      .catch(setError)
      .finally(() => setCargando(false))
  }, [])

  const set = (campo) => (e) => {
    setGuardado(false)
    setConfig((c) => ({
      ...c,
      [campo]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }))
  }

  /** El logo viaja como data URL: es una sola imagen y evita subir archivos aparte. */
  function cargarLogo(e) {
    const f = e.target.files?.[0]
    if (!f) return

    // Un logo enorme infla cada lectura de la configuración sin mejorar la
    // impresión: en el RIDE entra en dos centímetros.
    if (f.size > 400 * 1024) {
      setError(new Error('El logo pesa más de 400 KB. Con 400×200 alcanza de sobra.'))
      e.target.value = ''
      return
    }

    const lector = new FileReader()
    lector.onload = () => {
      setGuardado(false)
      setConfig((c) => ({ ...c, logo_b64: lector.result }))
    }
    lector.readAsDataURL(f)
  }

  /**
   * Se guardan SOLO los datos de la empresa.
   *
   * Comparten fila con el ambiente del SRI y los secuenciales. Mandar la
   * configuración entera desde acá la pisaría con lo que esta pantalla tenga
   * cargado: corregir un teléfono no puede cambiar el ambiente de pruebas a
   * producción sin que nadie lo pida.
   */
  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setGuardado(false)
    setError(null)
    try {
      const guardadoOk = await api.sri.guardarConfig({
        ruc: config.ruc ?? '',
        razon_social: config.razon_social ?? '',
        nombre_comercial: config.nombre_comercial ?? '',
        dir_matriz: config.dir_matriz ?? '',
        dir_establecimiento: config.dir_establecimiento ?? '',
        telefono: config.telefono ?? '',
        email: config.email ?? '',
        contribuyente_especial: config.contribuyente_especial ?? '',
        obligado_contabilidad: Boolean(config.obligado_contabilidad),
        agente_retencion: config.agente_retencion ?? '',
        logo_b64: config.logo_b64 ?? null,
      })
      setConfig(guardadoOk)
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
        <h1 className="text-lg font-semibold text-slate-100">Empresa</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Quién factura. Estos datos salen impresos en cada factura, en el recibo y en los
          contratos, y son los que el SRI valida contra tu RUC.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <form onSubmit={guardar} className="space-y-4">
        <Card title="Identificación" icon={Building2}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="RUC" hint="13 dígitos">
              <Input value={config?.ruc ?? ''} onChange={set('ruc')} maxLength={13} required />
            </Field>
            <Field label="Razón social" hint="Como figura en el RUC, sin abreviar">
              <Input value={config?.razon_social ?? ''} onChange={set('razon_social')} required />
            </Field>
            <Field
              label="Nombre comercial"
              hint="Con el que te conocen los abonados, si es distinto"
              className="sm:col-span-2"
            >
              <Input value={config?.nombre_comercial ?? ''} onChange={set('nombre_comercial')} />
            </Field>
          </div>
        </Card>

        <Card title="Direcciones y contacto">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dirección de la matriz" className="sm:col-span-2">
              <Input value={config?.dir_matriz ?? ''} onChange={set('dir_matriz')} required />
            </Field>
            <Field
              label="Dirección del establecimiento"
              hint="Solo si es distinta de la matriz"
              className="sm:col-span-2"
            >
              <Input
                value={config?.dir_establecimiento ?? ''}
                onChange={set('dir_establecimiento')}
              />
            </Field>
            <Field label="Teléfono" hint="Sale en el RIDE: es a donde llama el abonado">
              <Input value={config?.telefono ?? ''} onChange={set('telefono')} />
            </Field>
            <Field label="Correo">
              <Input type="email" value={config?.email ?? ''} onChange={set('email')} />
            </Field>
          </div>
        </Card>

        <Card title="Condición tributaria">
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Contribuyente especial" hint="El número de resolución, si te designaron">
                <Input
                  value={config?.contribuyente_especial ?? ''}
                  onChange={set('contribuyente_especial')}
                />
              </Field>
              <Field label="Agente de retención" hint="El número de resolución, si aplica">
                <Input value={config?.agente_retencion ?? ''} onChange={set('agente_retencion')} />
              </Field>
            </div>

            {/* Va impreso en el comprobante y el SRI lo valida: marcarlo mal es
                un rechazo, no un detalle estético. */}
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={Boolean(config?.obligado_contabilidad)}
                onChange={set('obligado_contabilidad')}
                className="accent-sky-500"
              />
              Obligado a llevar contabilidad
            </label>
          </div>
        </Card>

        <Card title="Logo" subtitle="Sale en la factura impresa y en el recibo" icon={Image}>
          <div className="flex flex-wrap items-center gap-6">
            <Field label="Imagen" hint="PNG o JPG, hasta 400 KB. Con 400×200 alcanza.">
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={cargarLogo}
                className="w-full text-xs text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-xs file:text-slate-200"
              />
            </Field>

            {config?.logo_b64 && (
              <div className="space-y-2">
                {/* Sobre blanco a propósito: así se imprime, y un logo blanco
                    sobre fondo oscuro se ve perfecto acá y desaparece en la
                    factura. */}
                <div className="rounded-lg bg-white p-3">
                  <img src={config.logo_b64} alt="Logo" className="max-h-16" />
                </div>
                <button
                  type="button"
                  onClick={() => setConfig((c) => ({ ...c, logo_b64: null }))}
                  className="text-xs text-slate-500 hover:text-rose-400"
                >
                  Quitar
                </button>
              </div>
            )}
          </div>
        </Card>

        {guardado && <Aviso>Datos guardados.</Aviso>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            El ambiente del SRI, el establecimiento y la numeración se configuran en{' '}
            <Link to="/facturacion?t=config" className="text-sky-400 hover:text-sky-300">
              Facturación
            </Link>
            .
          </p>
          <Button type="submit" variante="primario" cargando={guardando}>
            Guardar
          </Button>
        </div>
      </form>
    </div>
  )
}
