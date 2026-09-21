import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpFromLine, Copy, RefreshCw, Settings2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import EditarVlansUplink from './EditarVlansUplink'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Modal, Table } from '../ui'

/**
 * Puertos de subida de la OLT.
 *
 * La pregunta que contesta: **¿esta VLAN llega al router?**
 *
 * Es la causa de una avería que engaña mucho. Un abonado nuevo queda con su ONT
 * online, su service-port creado y su potencia perfecta — y no navega. Todo el
 * lado GPON dice que está bien porque el problema está acá arriba: la VLAN de
 * ese cliente no está en el troncal. Sin esta pantalla se busca en el lado
 * equivocado durante horas.
 */

/** Marca las VLANs sueltas fuera de los rangos grandes: suelen ser las nuevas. */
function Vlans({ p }) {
  if (p.vlans == null) {
    return (
      <span className="text-xs text-rose-300" title={p.error_vlans}>
        no se pudo leer
      </span>
    )
  }
  if (!p.vlans.length) {
    return <span className="text-xs text-slate-600">ninguna</span>
  }

  return (
    <div className="min-w-[180px]">
      <p className="font-mono text-xs text-slate-200">
        <span className="text-slate-500">Trunk: </span>
        {p.rangos}
      </p>
      <p className="mt-0.5 text-[10px] text-slate-500">
        {p.vlans.length} VLANs
        {p.nativa != null && ` · nativa ${p.nativa}`}
        {!p.completa && (
          <span className="ml-1 text-amber-400">
            · el equipo declara {p.total}, se leyeron {p.vlans.length}
          </span>
        )}
      </p>
    </div>
  )
}

export default function OltUplinks({ olt }) {
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [copiado, setCopiado] = useState(null)
  const [editando, setEditando] = useState(null)

  const leer = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.olt.uplinks(olt.id))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [olt.id])

  useEffect(() => {
    leer()
  }, [leer])

  async function copiar(p) {
    try {
      await navigator.clipboard.writeText(p.rangos ?? '')
      setCopiado(`${p.slot}/${p.puerto}`)
      setTimeout(() => setCopiado(null), 2000)
    } catch {
      // Sin permiso de portapapeles no pasa nada: la lista está a la vista.
    }
  }

  const filas = (datos?.placas ?? []).flatMap((pl) =>
    pl.puertos.map((p) => ({ ...p, slot: pl.slot, placa: pl.placa })),
  )

  // Las VLANs que existen en un puerto y no en otro: si el troncal está
  // duplicado, deberían coincidir.
  const activos = filas.filter((p) => p.online && p.vlans?.length)
  const dispares =
    activos.length > 1 &&
    activos.some((p) => p.vlans.join(',') !== activos[0].vlans.join(','))

  const modal = (
    <Modal
      abierto={editando !== null}
      titulo={`VLANs del troncal 0/${editando?.slot}/${editando?.puerto}`}
      onCerrar={() => setEditando(null)}
      ancho="max-w-2xl"
    >
      {editando && (
        <EditarVlansUplink
          olt={olt}
          puerto={editando}
          onListo={leer}
          onCerrar={() => setEditando(null)}
        />
      )}
    </Modal>
  )

  return (
    <>
    {modal}
    <Card
      title="Puertos de subida"
      subtitle={
        datos
          ? `${filas.length} puertos en ${datos.placas.length} placas de control`
          : 'Los GE/10GE que conectan la OLT con el resto de la red'
      }
      icon={ArrowUpFromLine}
      actions={
        <Button variante="primario" icon={RefreshCw} onClick={leer} cargando={cargando}>
          Actualizar
        </Button>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {cargando && !datos && (
          <Cargando texto="Leyendo los puertos y sus VLANs… un comando por puerto" />
        )}

        {datos && (
          <>
            {Array.isArray(datos.agregados) && datos.agregados.length === 0 && (
              <p className="text-[11px] text-slate-500">
                Sin agregado de enlaces (LAG/Eth-Trunk) configurado en este equipo. Cada puerto de
                subida trabaja por su cuenta.
              </p>
            )}

            {dispares && (
              <Aviso tipo="alerta">
                <span className="flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Los puertos activos <b>no llevan las mismas VLANs</b>. Si son troncales
                    redundantes deberían coincidir: al caerse uno, los clientes de las VLANs que
                    solo estaban ahí se quedan sin salida.
                  </span>
                </span>
              </Aviso>
            )}

            <Table
              columnas={[
                'Puerto',
                'Tipo',
                'Admin',
                'Enlace',
                'Velocidad',
                'VLAN nativa',
                'VLANs del troncal',
                '',
              ]}
              filas={filas}
              vacio="No se encontraron puertos de subida."
              renderFila={(p) => (
                <tr key={`${p.slot}/${p.puerto}`} className="text-slate-300">
                  <td className="px-3 py-2">
                    <span className="font-mono text-sm text-slate-100">
                      0/{p.slot}/{p.puerto}
                    </span>
                    <span className="block text-[10px] text-slate-600">{p.placa}</span>
                  </td>

                  <td className="px-3 py-2 text-xs">
                    {p.tipo}
                    <span className="block text-[10px] text-slate-500">
                      {/* "absence" es que no hay SFP puesto: el puerto está
                          libre, no fallado. */}
                      {p.tiene_sfp ? `SFP (${p.optico})` : 'sin SFP'}
                    </span>
                  </td>

                  <td className="px-3 py-2">
                    <Badge color={p.habilitado ? 'verde' : 'gris'}>
                      {p.habilitado ? 'habilitado' : p.admin}
                    </Badge>
                  </td>

                  <td className="px-3 py-2">
                    <Badge color={p.online ? 'verde' : 'rojo'}>{p.enlace}</Badge>
                  </td>

                  <td className="px-3 py-2 text-xs">
                    {p.online ? (
                      `${p.velocidad_mbps >= 1000 ? `${p.velocidad_mbps / 1000}G` : `${p.velocidad_mbps}M`} ${p.duplex}`
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>

                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{p.vlan_nativa}</td>

                  <td className="px-3 py-2">
                    <Vlans p={p} />
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {p.vlans?.length > 0 && (
                        <Button
                          variante="fantasma"
                          icon={Copy}
                          title="Copiar la lista de VLANs"
                          onClick={() => copiar(p)}
                        >
                          {copiado === `${p.slot}/${p.puerto}` ? 'copiado' : ''}
                        </Button>
                      )}
                      <Button
                        variante="fantasma"
                        icon={Settings2}
                        title="Agregar o quitar VLANs del troncal"
                        onClick={() => setEditando(p)}
                      />
                    </div>
                  </td>
                </tr>
              )}
            />

            <p className="text-[11px] leading-relaxed text-slate-500">
              Las VLANs se muestran agrupadas en rangos —<span className="font-mono">200-232</span>{' '}
              en vez de treinta y tres números— porque así se ve de un vistazo si falta alguna en el
              medio. Un rango partido como{' '}
              <span className="font-mono text-amber-400">200-215, 217-232</span> salta a la vista;
              en una lista plana, no.
            </p>
          </>
        )}
      </div>
    </Card>
    </>
  )
}
