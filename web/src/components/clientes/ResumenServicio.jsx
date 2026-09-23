import { Link } from 'react-router-dom'
import { dinero } from '../../lib/formato'
import { Activity, Pencil, Radio, Trash2, Wifi } from 'lucide-react'
import { Aviso, Badge, Button, Card, EnlaceIp } from '../ui'
import Trasladar from './Trasladar'

/**
 * Lo que se ve al entrar a Servicio: el servicio en una fila y el estado de la
 * fibra.
 *
 * El formulario completo aparece recién al tocar Editar. Entrar a la ficha de
 * un abonado para mirar su IP no debería enfrentar a veinte campos editables,
 * donde cualquier tecla suelta cambia un dato de la red.
 */

const mbps = (kbps) => (kbps ? `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps` : '—')
const fecha = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString() : '—')

/** Umbral por debajo del cual la fibra está al límite y el enlace se cae solo. */
export const UMBRAL_RX = -27

/**
 * Cómo se lee el estado que devuelve la OLT.
 *
 * Un corte de luz en la casa y una fibra cortada llegan igual a la OLT: sin
 * señal. Lo que los separa es la causa que anota la OLT —cuando se va la luz la
 * ONU alcanza a mandar su último aviso, el "dying gasp"—, y de ahí sale la
 * diferencia entre mandar un técnico a la fibra o llamar al abonado.
 */
export const ESTADO_ONU = {
  online: { label: 'Online', corto: 'Online', color: 'verde' },
  offline: { label: 'Offline · sin conexión', corto: 'Offline', color: 'gris' },
  los: { label: 'LOS · sin señal en la fibra', corto: 'LOS', color: 'rojo' },
  power_off: {
    label: 'Sin energía en el domicilio',
    corto: 'Sin energía',
    color: 'ambar',
  },
  unknown: { label: 'Desconocido · nunca se midió', corto: 'Desconocido', color: 'gris' },
}

/** Qué hacer con cada causa, dicho para quien atiende el reclamo. */
const QUE_HACER = {
  power_off: 'Se le fue la luz: la ONU avisó antes de apagarse. No hace falta ir.',
  los: 'Sin señal óptica: hay que revisar la fibra o el empalme.',
  desactivada: 'La dieron de baja desde la OLT.',
  reinicio: 'La ONU se reinició.',
  otra: 'Causa no reconocida: mirá el texto que devolvió la OLT.',
}

export default function ResumenServicio({
  cliente,
  onu,
  midiendo,
  onMedir,
  onEditar,
  onEliminar,
  onError,
  onGuardado,
}) {
  const estado = ESTADO_ONU[onu?.estado ?? cliente.onu_estado] ?? ESTADO_ONU.unknown

  const rx = onu?.rx_power_dbm ?? cliente.rx_power_dbm
  const tx = onu?.tx_power_dbm
  const rxBajo = rx != null && Number(rx) < UMBRAL_RX

  return (
    <div className="space-y-4">
      <Card
        title="Servicio de internet"
        icon={Wifi}
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {/* El traslado va junto a Editar y no adentro del formulario: no es
                corregir un dato mal cargado, es abrir un trabajo. */}
            <Trasladar cliente={cliente} onError={onError} onGuardado={onGuardado} />
            <Button variante="primario" icon={Pencil} onClick={onEditar}>
              Editar
            </Button>
            <Button
              variante="fantasma"
              icon={Trash2}
              title="Quitar el servicio de este abonado"
              onClick={onEliminar}
            />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Costo</th>
                <th className="px-3 py-2">IP</th>
                <th className="px-3 py-2">Router</th>
                <th className="px-3 py-2">Instalado</th>
                <th className="px-3 py-2">Dirección</th>
                <th className="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              <tr className="text-slate-300">
                <td className="px-3 py-2 font-medium text-slate-100">
                  {cliente.plan ?? cliente.velocidad_cruda ?? '—'}
                  {cliente.bajada_kbps ? (
                    <span className="block text-[11px] font-normal text-slate-500">
                      {mbps(cliente.bajada_kbps)} / {mbps(cliente.subida_kbps)}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  {dinero(cliente.precio_mensual ?? cliente.plan_precio)}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <EnlaceIp ip={cliente.ip} />
                  {cliente.tipo_conexion && cliente.tipo_conexion !== 'ip' ? (
                    <span className="block text-[11px] uppercase text-sky-400">
                      {cliente.tipo_conexion}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs">{cliente.router ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{fecha(cliente.fecha_instalacion)}</td>
                <td className="px-3 py-2 text-xs">{cliente.direccion ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge color={estado.color}>{estado.corto}</Badge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
          <p>
            Caja NAP: <span className="text-slate-200">{cliente.nap ?? '—'}</span>
            {cliente.puerto_nap ? ` · puerto ${cliente.puerto_nap}` : ''}
          </p>
          <p>
            Conectado a: <span className="text-slate-200">{cliente.conectado_a ?? '—'}</span>
            {cliente.tipo_antena ? ` · ${cliente.tipo_antena}` : ''}
          </p>
          <p>
            IP de administración:{' '}
            <span className="font-mono text-slate-200">{cliente.ip_administracion ?? '—'}</span>
          </p>
        </div>
      </Card>

      <Card
        title="Estado de la ONU"
        subtitle="Potencia óptica y señal"
        icon={Radio}
        actions={
          onu?.olt_id ? (
            <Button variante="secundario" icon={Activity} cargando={midiendo} onClick={onMedir}>
              Medir ahora
            </Button>
          ) : null
        }
      >
        {cliente.onu_serial || onu ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="t-panel p-3">
                <p className="text-[11px] text-slate-500">Estado</p>
                <div className="mt-1.5">
                  <Badge color={estado.color}>{estado.label}</Badge>
                </div>
                {onu?.causa_caida && onu.estado !== 'online' && (
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    {QUE_HACER[onu.causa_caida] ?? ''}
                  </p>
                )}
              </div>

              <div className="t-panel p-3">
                <p className="text-[11px] text-slate-500">Rx de la ONU</p>
                <p
                  className={`mt-1 text-lg font-semibold ${rxBajo ? 'text-red-400' : 'text-emerald-400'}`}
                >
                  {rx != null ? `${Number(rx).toFixed(2)} dBm` : '—'}
                </p>
                <p className="text-[11px] text-slate-500">lo que le llega al abonado</p>
              </div>

              <div className="t-panel p-3">
                <p className="text-[11px] text-slate-500">Tx de la ONU</p>
                <p className="mt-1 text-lg font-semibold text-slate-200">
                  {tx != null ? `${Number(tx).toFixed(2)} dBm` : '—'}
                </p>
                <p className="text-[11px] text-slate-500">lo que recibe la OLT</p>
              </div>

              <div className="t-panel p-3">
                <p className="text-[11px] text-slate-500">Serial / distancia</p>
                <p className="mt-1 break-all font-mono text-xs text-slate-200">
                  {onu?.sn ?? cliente.onu_serial ?? '—'}
                </p>
                <p className="text-[11px] text-slate-500">
                  {onu?.distancia_m != null ? `${onu.distancia_m} m` : 'sin medir'}
                </p>
              </div>
            </div>

            {rxBajo && (
              <Aviso tipo="alerta">
                La potencia está por debajo de {UMBRAL_RX} dBm: la fibra trabaja al límite y el
                servicio se va a cortar solo. Conviene revisar el empalme antes de que el abonado
                llame.
              </Aviso>
            )}

            <p className="text-[11px] text-slate-500">
              Última lectura:{' '}
              {onu?.ultima_lectura ? new Date(onu.ultima_lectura).toLocaleString() : 'nunca'}
              {onu?.puerto != null
                ? ` · puerto ${onu.frame}/${onu.slot}/${onu.puerto}, ONT ${onu.onu_index}`
                : ''}
              {/* El texto crudo de la OLT: los nombres cambian entre versiones
                  y tenerlo permite diagnosticar lo que el mapeo no cubra. */}
              {onu?.ultima_caida ? ` · última caída ${onu.ultima_caida}` : ''}
              {onu?.causa_caida_cruda ? ` (${onu.causa_caida_cruda})` : ''}
            </p>
          </div>
        ) : (
          <Aviso>
            No tiene ONU asociada. Si es un abonado de fibra, se vincula al registrarla desde{' '}
            <Link to="/onus" className="text-sky-400 hover:underline">
              ONUs
            </Link>
            .
          </Aviso>
        )}
      </Card>
    </div>
  )
}
