import { useState } from 'react'
import { Globe } from 'lucide-react'
import { useTabla } from '../lib/useTabla'
import { api } from '../lib/apiNetwork'
import BloqueosManager from '../components/mikrotik/BloqueosManager'
import { Aviso, Button, Card, Cargando, ErrorBanner, Field, Input, Select } from '../components/ui'

export default function BloqueosPage() {
  const { filas: routers, cargando } = useTabla('routers_mikrotik')
  const [routerId, setRouterId] = useState('')
  const [destino, setDestino] = useState('')
  const [error, setError] = useState(null)
  const [resultado, setResultado] = useState(null)
  const [enviando, setEnviando] = useState(false)

  const router = routers.find((r) => r.id === routerId)

  async function crearRedireccion(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    setResultado(null)
    try {
      setResultado(await api.mikrotik.redireccionPago(routerId, { destino }))
    } catch (err) {
      setError(err)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Cortes y morosos</h1>
        <p className="text-xs text-slate-500">
          Suspensión de servicio y redirección a la página de aviso de pago
        </p>
      </div>

      <Card title="Router">
        {cargando ? (
          <Cargando />
        ) : routers.length === 0 ? (
          <Aviso tipo="alerta">
            No hay routers cargados. Registrá uno en la sección <b>MikroTik</b>.
          </Aviso>
        ) : (
          <Field label="Router">
            <Select value={routerId} onChange={(e) => setRouterId(e.target.value)}>
              <option value="">— elegí un router —</option>
              {routers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nombre} ({r.ip_host})
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Card>

      {router && (
        <>
          <BloqueosManager router={router} />

          <Card
            title="Redirección de pago"
            subtitle="Manda el tráfico HTTP de los morosos a una página local de aviso"
            icon={Globe}
          >
            <div className="space-y-4">
              <ErrorBanner error={error} onCerrar={() => setError(null)} />

              <form onSubmit={crearRedireccion} className="grid items-end gap-3 sm:grid-cols-3">
                <Field
                  label="IP del servidor de aviso"
                  hint="Donde está publicada la página de pago"
                  className="sm:col-span-2"
                >
                  <Input
                    value={destino}
                    onChange={(e) => setDestino(e.target.value)}
                    placeholder="10.0.0.2"
                    required
                  />
                </Field>
                <div className="pb-2">
                  <Button type="submit" variante="primario" cargando={enviando} className="w-full">
                    Crear regla NAT
                  </Button>
                </div>
              </form>

              {resultado && (
                <Aviso>
                  {resultado.mensaje}. Solo afecta el HTTP en claro (puerto 80): el tráfico HTTPS no
                  se puede redirigir sin romper el certificado, así que el cliente verá un error de
                  conexión en los sitios HTTPS.
                </Aviso>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
