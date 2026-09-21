import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  Archive,
  ArrowLeft,
  CircuitBoard,
  Gauge,
  History,
  Network,
  Pencil,
  Phone,
  Radar,
  Radio,
  Server,
  Settings2,
  Shield,
  Terminal,
  Waves,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { hace } from '../lib/olts'
import { api } from '../lib/apiNetwork'
import OLTForm from '../components/olt/OLTForm'
import OltDetalles from '../components/olt/OltDetalles'
import OltOnus from '../components/olt/OltOnus'
import OltOptica from '../components/olt/OltOptica'
import OltPlacas from '../components/olt/OltPlacas'
import OltPuertos from '../components/olt/OltPuertos'
import OltPerfiles from '../components/olt/OltPerfiles'
import OltUplinks from '../components/olt/OltUplinks'
import OltRelevamiento from '../components/olt/OltRelevamiento'
import OltVlans from '../components/olt/OltVlans'
import OltPoolsIp from '../components/olt/OltPoolsIp'
import OltConsola from '../components/olt/OltConsola'
import OltBackups from '../components/olt/OltBackups'
import OltHistorial from '../components/olt/OltHistorial'
import { Badge, Button, Cargando, ErrorBanner, Modal, Punto, Tabs } from '../components/ui'

/**
 * Ficha de una OLT.
 *
 * Las pestañas que el sistema sabe leer muestran datos; las que no, muestran el
 * relevamiento — que le pregunta al equipo qué comandos acepta y devuelve la
 * salida cruda. Es deliberado: escribir un parser contra la documentación en vez
 * de contra la salida real ya costó horas en este proyecto, y una pestaña que
 * inventa datos es peor que una que admite que todavía no sabe.
 */

const TABS = [
  { clave: 'detalles', label: 'Detalles', icon: Server },
  { clave: 'onus', label: 'ONUs y abonados', icon: Radio },
  { clave: 'optica', label: 'Potencia óptica', icon: Waves },
  { clave: 'placas', label: 'Placas', icon: CircuitBoard },
  { clave: 'puertos', label: 'Puertos PON', icon: Waves },
  { clave: 'uplink', label: 'Uplink', icon: Network },
  { clave: 'vlans', label: 'VLANs', icon: Settings2 },
  { clave: 'pools', label: 'Pools de IP', icon: Network },
  { clave: 'acls', label: 'ACLs remotas', icon: Shield },
  { clave: 'perfiles', label: 'Perfiles', icon: Gauge },
  { clave: 'voip', label: 'VoIP', icon: Phone },
  { clave: 'avanzado', label: 'Avanzado', icon: Radar },
]

/** Las que se resuelven preguntándole al equipo qué entiende. */
const A_RELEVAR = {
  acls: ['ACLs de acceso remoto', 'Desde qué direcciones se permite administrar el equipo.'],
  voip: ['Perfiles de telefonía', 'VoIP sobre las ONUs. Si el equipo no tiene el módulo, va a venir vacío.'],
  avanzado: ['Parámetros avanzados', 'NTP, SNMP, servicios de gestión y quién está conectado.'],
}

export default function OltDetallePage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()

  const [olt, setOlt] = useState(null)
  const [error, setError] = useState(null)
  const [editando, setEditando] = useState(false)
  const [sondeando, setSondeando] = useState(false)

  // La pestaña vive en la URL: al recargar o compartir el link, la pantalla
  // abre donde estabas y no de vuelta en la primera.
  const activa = params.get('tab') ?? 'detalles'
  const panel = params.get('panel')

  const irA = (clave) => setParams({ tab: clave }, { replace: true })
  const abrirPanel = (p) => setParams(p ? { tab: activa, panel: p } : { tab: activa }, { replace: true })

  const cargar = useCallback(async () => {
    const { data, error: err } = await supabase.from('v_olts').select('*').eq('id', id).maybeSingle()
    if (err) return setError(err)
    if (!data) return setError(new Error('Esa OLT no existe o fue eliminada'))
    setOlt(data)
  }, [id])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function sondear() {
    setSondeando(true)
    try {
      await api.olt.estado(id)
      await cargar()
    } catch (err) {
      setError(err)
    } finally {
      setSondeando(false)
    }
  }

  if (error && !olt) {
    return (
      <div className="space-y-4">
        <Link to="/olts">
          <Button variante="primario" icon={ArrowLeft}>
            Volver a la lista de OLTs
          </Button>
        </Link>
        <ErrorBanner error={error} />
      </div>
    )
  }

  if (!olt) return <Cargando texto="Cargando la ficha del equipo…" />

  const relevar = A_RELEVAR[activa]
  const esDetalles = activa === 'detalles'

  return (
    <div className="space-y-5">
      {/* --- Cabecera --- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Link to="/olts">
            <Button variante="primario" icon={ArrowLeft}>
              Volver a la lista
            </Button>
          </Link>
          <div>
            <h1 className="flex items-center gap-2 t-titulo text-lg font-bold text-slate-100">
              <Punto estado={olt.estado} />
              {olt.nombre}
              <Badge color={olt.marca === 'Huawei' ? 'rojo' : 'azul'}>{olt.marca}</Badge>
              {olt.activo === false && <Badge color="ambar">oculta</Badge>}
            </h1>
            <p className="text-xs text-slate-500">
              <span className="font-mono">
                {olt.ip_host}:{olt.puerto_ssh}
              </span>
              {' · '}
              {olt.hw_version ?? 'modelo sin leer'}
              {olt.sw_version ? ` · ${olt.sw_version}` : ''}
              {' · '}
              estado {hace(olt.estado_hace_segundos)}
            </p>
          </div>
        </div>

        <Button onClick={sondear} cargando={sondeando}>
          Probar alcance
        </Button>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Tabs tabs={TABS} activa={activa} onCambiar={irA} />

      {/* Acciones rápidas: SOLO en Detalles.
          Son operaciones sobre el equipo como un todo —su configuración, su
          historial, su consola— y no tienen nada que ver con lo que se está
          mirando en las otras pestañas. Repetirlas en todas ensuciaba la
          pantalla y hacía dudar de a qué se aplicaban. */}
      {esDetalles && (
        <div className="flex flex-wrap gap-2">
          <Button variante="primario" icon={Pencil} onClick={() => setEditando(true)}>
            Editar ajustes
          </Button>
          <Button
            variante={panel === 'historial' ? 'primario' : 'secundario'}
            icon={History}
            onClick={() => abrirPanel(panel === 'historial' ? null : 'historial')}
          >
            Ver historial
          </Button>
          <Button
            variante={panel === 'consola' ? 'primario' : 'exito'}
            icon={Terminal}
            onClick={() => abrirPanel(panel === 'consola' ? null : 'consola')}
          >
            Consola CLI
          </Button>
          <Button
            variante={panel === 'backups' ? 'primario' : 'secundario'}
            icon={Archive}
            onClick={() => abrirPanel(panel === 'backups' ? null : 'backups')}
          >
            Respaldos
          </Button>
        </div>
      )}

      {/* Un panel abierto reemplaza al contenido de Detalles. Cambiar de
          pestaña lo cierra: `irA` reescribe la URL sin el panel. */}
      {esDetalles && panel === 'historial' ? (
        <OltHistorial olt={olt} />
      ) : esDetalles && panel === 'consola' ? (
        <OltConsola olt={olt} />
      ) : esDetalles && panel === 'backups' ? (
        <OltBackups olt={olt} />
      ) : activa === 'detalles' ? (
        <OltDetalles olt={olt} onRecargar={cargar} />
      ) : activa === 'onus' ? (
        <OltOnus olt={olt} />
      ) : activa === 'optica' ? (
        <OltOptica olt={olt} />
      ) : activa === 'placas' ? (
        <OltPlacas olt={olt} />
      ) : activa === 'puertos' ? (
        <OltPuertos olt={olt} />
      ) : activa === 'perfiles' ? (
        <OltPerfiles olt={olt} />
      ) : activa === 'vlans' ? (
        <OltVlans olt={olt} />
      ) : activa === 'pools' ? (
        <OltPoolsIp olt={olt} />
      ) : activa === 'uplink' ? (
        <OltUplinks olt={olt} />
      ) : relevar ? (
        <OltRelevamiento
          key={activa}
          olt={olt}
          area={activa}
          titulo={relevar[0]}
          ayuda={relevar[1]}
        />
      ) : null}

      <Modal
        abierto={editando}
        titulo={`Editar ${olt.nombre}`}
        onCerrar={() => setEditando(false)}
        ancho="max-w-2xl"
      >
        <OLTForm
          olt={olt}
          onCancelar={() => setEditando(false)}
          onGuardado={async (datos) => {
            const { error: err } = await supabase.from('olts').update(datos).eq('id', olt.id)
            if (err) return setError(err)
            setEditando(false)
            await cargar()
          }}
        />
      </Modal>
    </div>
  )
}
