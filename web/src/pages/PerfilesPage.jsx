import { Link } from 'react-router-dom'
import TiposONTManager from '../components/olt/TiposONTManager'
import LineProfileForm from '../components/olt/LineProfileForm'
import PuntosRed from '../components/olt/PuntosRed'
import { Aviso } from '../components/ui'

/**
 * Catálogo técnico de la planta externa.
 *
 * Los planes de velocidad ya no están acá: se movieron a Servicios → Planes de
 * internet, porque un plan es a la vez un producto comercial —con su precio y
 * su IVA— y una configuración de red. Tenerlo en dos pantallas garantizaba que
 * tarde o temprano dijeran cosas distintas.
 */
export default function PerfilesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Perfiles y puntos de red</h1>
        <p className="text-xs text-slate-500">
          Catálogo de ONTs, perfiles de línea (VLAN) y cajas NAP
        </p>
      </div>

      <Aviso>
        Los planes de velocidad se administran en{' '}
        <Link to="/servicios/planes" className="font-medium underline">
          Servicios → Planes de internet
        </Link>
        , junto con su precio, su IVA y los routers donde se ofrecen.
      </Aviso>

      <LineProfileForm />
      <PuntosRed />
      <TiposONTManager />
    </div>
  )
}
