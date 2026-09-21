import { Navigate } from 'react-router-dom'
import { useAuth } from '../../lib/AuthContext'
import { Cargando } from '../ui'

export default function ProtectedRoute({ children }) {
  const { sesion, cargando } = useAuth()

  if (cargando) return <Cargando texto="Verificando sesión…" />
  if (!sesion) return <Navigate to="/login" replace />
  return children
}
