import { useCallback, useEffect, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Badge, Button, Card, ErrorBanner, SkeletonTabla, Table } from '../ui'

/**
 * Historial de cambios de la OLT.
 *
 * Contesta la pregunta que siempre llega tarde: "esto andaba el viernes, ¿qué se
 * tocó?". Lo escribe un trigger en la base y no el código de cada endpoint —si
 * dependiera de que cada uno se acuerde, el primero que se agregue olvidándolo
 * deja sin rastro justamente el cambio que después nadie va a poder explicar.
 *
 * El sondeo de alcance no se registra: reescribe el estado cada pocos minutos y
 * ahogaría en ruido los cambios que sí hizo una persona.
 */

/** Los nombres de columna no se leen; lo que se lee es qué significan. */
const ETIQUETAS = {
  nombre: 'Nombre',
  ip_host: 'IP de gestión',
  puerto_ssh: 'Puerto TCP',
  usuario: 'Usuario de acceso',
  password_encrypted: 'Contraseña de acceso',
  enable_password_encrypted: 'Contraseña de enable',
  snmp_ro_encrypted: 'Comunidad SNMP de lectura',
  snmp_rw_encrypted: 'Comunidad SNMP de escritura',
  snmp_puerto: 'Puerto SNMP',
  snmp_trap: 'Escucha de traps',
  iptv: 'Módulo IPTV',
  via_vpn: 'Acceso por VPN',
  hw_version: 'Versión de hardware',
  sw_version: 'Versión de software',
  pon_tipos: 'Tipos PON',
  ntp_servers: 'Servidores NTP',
  tr069_perfil: 'Perfil TR069',
  tr069_interfaz: 'Interfaz TR069',
  activo: 'Activa',
  marca: 'Marca',
  notas: 'Notas',
}

const valor = (v) => {
  if (v === null || v === undefined || v === '') return <span className="text-slate-600">vacío</span>
  if (v === 'true') return 'sí'
  if (v === 'false') return 'no'
  return v
}

export default function OltHistorial({ olt }) {
  const [eventos, setEventos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const r = await api.olt.historial(olt.id)
      setEventos(r.eventos ?? [])
    } catch (err) {
      setError(err)
      setEventos([])
    } finally {
      setCargando(false)
    }
  }, [olt.id])

  useEffect(() => {
    cargar()
  }, [cargar])

  return (
    <Card
      title="Historial de cambios"
      subtitle={eventos ? `${eventos.length} eventos registrados` : ''}
      icon={History}
      actions={
        <Button icon={RefreshCw} onClick={cargar} cargando={cargando}>
          Actualizar
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {!eventos ? (
          <SkeletonTabla filas={5} columnas={5} />
        ) : (
          <Table
            columnas={['Cuándo', 'Acción', 'Qué', 'Antes', 'Después', 'Quién']}
            filas={eventos}
            vacio="Sin cambios registrados. El historial empieza a llenarse desde la primera modificación."
            renderFila={(e) => (
              <tr key={e.id} className="text-slate-300">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                  {new Date(e.created_at).toLocaleString('es-EC')}
                </td>
                <td className="px-3 py-2">
                  <Badge color={e.accion === 'alta' ? 'verde' : 'gris'}>{e.accion}</Badge>
                </td>
                <td className="px-3 py-2 text-sm">{ETIQUETAS[e.campo] ?? e.campo}</td>
                <td className="max-w-[180px] truncate px-3 py-2 text-xs text-slate-500">
                  {valor(e.valor_antes)}
                </td>
                <td className="max-w-[180px] truncate px-3 py-2 text-xs text-slate-200">
                  {valor(e.valor_despues)}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{e.quien}</td>
              </tr>
            )}
          />
        )}
      </div>
    </Card>
  )
}
