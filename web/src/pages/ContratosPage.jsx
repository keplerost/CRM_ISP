import { useState } from 'react'
import FichaContratos from '../components/clientes/FichaContratos'
import { ErrorBanner } from '../components/ui'

/** Contratos de todos los abonados. */
export default function ContratosPage() {
  const [error, setError] = useState(null)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Contratos</h1>
        <p className="text-sm text-slate-500">
          Qué firmó cada abonado, por cuánto y hasta cuándo.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <FichaContratos onError={setError} />
    </div>
  )
}
