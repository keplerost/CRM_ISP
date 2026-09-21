import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../lib/confirmar'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpDown,
  Eye,
  EyeOff,
  FileDown,
  Network,
  Plus,
  RefreshCw,
  ScanSearch,
  Trash2,
} from 'lucide-react'
import { useTabla } from '../lib/useTabla'
import { api } from '../lib/apiNetwork'
import { aCsv, descargar, eliminarOlt, guardarOlt, hace } from '../lib/olts'
import OLTForm from '../components/olt/OLTForm'
import Inconsistencias from '../components/olt/Inconsistencias'
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Modal,
  Punto,
  SkeletonTabla,
  Table,
} from '../components/ui'

/**
 * Listado de OLTs.
 *
 * Se lee de `v_olts`, que trae el estado de alcance cacheado y los contadores de
 * ONUs. El puntito verde no consulta al equipo cuando se pinta: consulta cuando
 * se aprieta "Actualizar estado", y mientras tanto muestra de cuándo es el dato.
 * Un verde de hace tres horas no es un verde.
 */
export default function OLTPage() {
  const confirmar = useConfirmar()
  const navegar = useNavigate()
  const { filas: olts, cargando, error, recargar, insertar, setError } = useTabla('v_olts', {
    orderBy: 'numero',
    ascending: true,
  })

  const [enFormulario, setEnFormulario] = useState(null)
  const [orden, setOrden] = useState({ campo: 'numero', asc: true })
  const [sondeando, setSondeando] = useState(false)
  const [auditando, setAuditando] = useState(false)
  const [auditoria, setAuditoria] = useState(null)

  // Al entrar se refresca solo una vez: es barato (un TCP por equipo, en
  // paralelo) y evita que la pantalla abra siempre en gris.
  const sondear = useCallback(async () => {
    setSondeando(true)
    try {
      await api.olt.estados()
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setSondeando(false)
    }
  }, [recargar, setError])

  useEffect(() => {
    sondear()
    // Solo al montar: repetirlo con cada recarga de la tabla sería un bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ordenadas = useMemo(() => {
    const copia = [...olts]
    copia.sort((a, b) => {
      const x = a[orden.campo]
      const y = b[orden.campo]
      if (x == null) return 1
      if (y == null) return -1
      const cmp = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'es')
      return orden.asc ? cmp : -cmp
    })
    return copia
  }, [olts, orden])

  const ordenarPor = (campo) =>
    setOrden((o) => ({ campo, asc: o.campo === campo ? !o.asc : true }))

  async function alternarActiva(olt) {
    try {
      await guardarOlt(olt.id, { activo: !olt.activo })
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  async function borrar(olt) {
    const aviso = olt.onus_total
      ? `La OLT "${olt.nombre}" tiene ${olt.onus_total} ONUs registradas que se van a borrar con ella.\n\n¿Seguro?`
      : `¿Eliminar la OLT "${olt.nombre}"?`
    if (!await confirmar(aviso)) return
    try {
      await eliminarOlt(olt.id)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  async function auditar() {
    setAuditando(true)
    setAuditoria(null)
    try {
      setAuditoria(await api.olt.inconsistencias())
    } catch (err) {
      setError(err)
    } finally {
      setAuditando(false)
    }
  }

  function exportar() {
    const sello = new Date().toISOString().slice(0, 10)
    descargar(`olts-${sello}.csv`, aCsv(ordenadas))
  }

  const Encabezado = ({ campo, children }) => (
    <button
      type="button"
      onClick={() => ordenarPor(campo)}
      className={`inline-flex items-center gap-1 transition hover:text-slate-300 ${
        orden.campo === campo ? 'text-sky-300' : ''
      }`}
    >
      {children}
      <ArrowUpDown size={11} className={orden.campo === campo ? '' : 'opacity-40'} />
    </button>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">OLTs</h1>
          <p className="text-xs text-slate-500">
            {olts.length} equipos GPON · {olts.filter((o) => o.estado === 'online').length} en línea
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variante="primario" icon={Plus} onClick={() => setEnFormulario({})}>
            Agregar OLT
          </Button>
          <Button variante="exito" icon={FileDown} onClick={exportar} disabled={!olts.length}>
            Exportar lista
          </Button>
          <Button variante="alerta" icon={ScanSearch} onClick={auditar} cargando={auditando}>
            Buscar inconsistencias
          </Button>
          <Button icon={RefreshCw} onClick={sondear} cargando={sondeando}>
            Actualizar estado
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {auditoria && <Inconsistencias datos={auditoria} onCerrar={() => setAuditoria(null)} />}

      <Card title="Equipos registrados" icon={Network}>
        {cargando ? (
          <SkeletonTabla filas={4} columnas={7} />
        ) : (
          <Table
            columnas={[
              '',
              <Encabezado key="id" campo="numero">
                ID
              </Encabezado>,
              'Estado',
              <Encabezado key="nombre" campo="nombre">
                Nombre
              </Encabezado>,
              <Encabezado key="ip" campo="ip_host">
                IP de la OLT
              </Encabezado>,
              'TCP',
              'UDP',
              'Hardware',
              'Software',
              'ONUs',
              '',
            ]}
            filas={ordenadas}
            vacio="Todavía no hay ninguna OLT cargada."
            renderFila={(olt) => (
              <tr
                key={olt.id}
                className={`text-slate-300 ${olt.activo === false ? 'opacity-50' : ''}`}
              >
                <td className="px-3 py-2">
                  <Button variante="primario" onClick={() => navegar(`/olts/${olt.id}`)}>
                    Ver
                  </Button>
                </td>

                <td className="px-3 py-2 font-mono text-xs text-slate-500">{olt.numero}</td>

                <td className="px-3 py-2">
                  <span className="flex items-center gap-2">
                    <Punto
                      estado={olt.estado}
                      titulo={
                        olt.estado === 'online'
                          ? `Responde en ${olt.estado_latencia_ms} ms`
                          : olt.estado_detalle || 'Sin consultar'
                      }
                    />
                    <span className="text-[11px] text-slate-500">
                      {hace(olt.estado_hace_segundos)}
                    </span>
                  </span>
                </td>

                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => navegar(`/olts/${olt.id}`)}
                    className="font-medium text-slate-100 hover:text-sky-300"
                  >
                    {olt.nombre}
                  </button>
                  <span className="ml-2">
                    <Badge color={olt.marca === 'Huawei' ? 'rojo' : 'azul'}>{olt.marca}</Badge>
                  </span>
                  {olt.via_vpn && <span className="ml-1 text-[10px] text-slate-500">VPN</span>}
                </td>

                <td className="px-3 py-2 font-mono text-xs">{olt.ip_host}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-400">{olt.puerto_ssh}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-400">{olt.snmp_puerto}</td>

                {/* Un guion no es lo mismo que un vacío: dice "nunca se leyó del
                    equipo", que es accionable. */}
                <td className="px-3 py-2 text-xs">
                  {olt.hw_version ?? <span className="text-slate-600">sin leer</span>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {olt.sw_version ?? <span className="text-slate-600">sin leer</span>}
                </td>

                <td className="px-3 py-2 text-xs">
                  {olt.onus_total
                    ? `${olt.onus_online}/${olt.onus_total}`
                    : <span className="text-slate-600">—</span>}
                </td>

                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      variante="fantasma"
                      icon={olt.activo === false ? EyeOff : Eye}
                      title={
                        olt.activo === false
                          ? 'Está oculta: no se sondea ni entra en operaciones automáticas. Click para reactivar.'
                          : 'Ocultar: deja de sondearse y sale de las operaciones automáticas.'
                      }
                      onClick={() => alternarActiva(olt)}
                    />
                    <Button
                      variante="fantasma"
                      icon={Trash2}
                      title="Eliminar"
                      className="text-red-400 hover:bg-red-500/10"
                      onClick={() => borrar(olt)}
                    />
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <Modal
        abierto={enFormulario !== null}
        titulo="Registrar OLT"
        onCerrar={() => setEnFormulario(null)}
        ancho="max-w-2xl"
      >
        <OLTForm
          olt={null}
          onCancelar={() => setEnFormulario(null)}
          onGuardado={async (datos) => {
            await insertar(datos)
            setEnFormulario(null)
          }}
        />
      </Modal>
    </div>
  )
}
