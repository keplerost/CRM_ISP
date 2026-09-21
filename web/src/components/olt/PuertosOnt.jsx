import { useState } from 'react'
import { AlertTriangle, Cable, Phone } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, ErrorBanner, Table } from '../ui'

/**
 * Los puertos de adentro de la ONT del abonado.
 *
 * Es la pantalla que contesta el reclamo más común: "no me anda internet" con
 * la fibra perfecta. Si los cuatro puertos están caídos, el problema está del
 * router para adentro y no hay nada que revisar en la red — y eso se sabe desde
 * acá, sin mandar a nadie.
 */
export default function PuertosOnt({ oltId, onuId }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [leyendo, setLeyendo] = useState(false)

  async function leer() {
    setLeyendo(true)
    setError(null)
    try {
      setDatos(await api.olt.puertosOnu(oltId, onuId))
    } catch (err) {
      setError(err)
    } finally {
      setLeyendo(false)
    }
  }

  const r = datos?.resumen

  return (
    <div className="space-y-3">
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {!datos ? (
        <div className="py-4 text-center">
          <Button icon={Cable} cargando={leyendo} onClick={leer}>
            Ver los puertos de la ONT
          </Button>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
            Se le pregunta al equipo en vivo. Con la ONT caída no puede contestar.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">
              {r.ethernet_conectados} de {r.ethernet_total} puertos con algo enchufado
              {r.telefonos > 0 && ` · ${r.telefonos_registrados} de ${r.telefonos} teléfonos registrados`}
            </span>
            <Button variante="fantasma" cargando={leyendo} onClick={leer}>
              Volver a leer
            </Button>
          </div>

          {r.ninguno_conectado && (
            <Aviso tipo="alerta">
              <b>No hay nada enchufado en ningún puerto.</b> Si el abonado reclama que no tiene
              internet, el problema está de su router para adentro — o usa solo wifi, que también
              es normal. En cualquier caso no hay nada que revisar en la red.
            </Aviso>
          )}

          {r.con_bucle?.length > 0 && (
            <Aviso tipo="alerta">
              <b>Cable en bucle</b> en el puerto {r.con_bucle.join(', ')}. Es un cable de la casa
              enchufado en dos bocas del mismo equipo: tira abajo la red del abonado y a veces
              satura el puerto PON entero.
            </Aviso>
          )}

          {r.telefonos_con_problema?.length > 0 && (
            <Aviso tipo="alerta">
              <b>El teléfono no está registrado.</b>{' '}
              {r.telefonos_con_problema.map((t) => `puerto ${t.puerto}: ${t.estado}`).join(' · ')}.
              Desde afuera se ve igual que uno que funciona: la ONT está online y el puerto existe,
              pero la línea no llegó a registrarse.
            </Aviso>
          )}

          {datos.problemas?.length > 0 && (
            <Aviso tipo="alerta">No se pudo leer todo: {datos.problemas.join(' · ')}</Aviso>
          )}

          {datos.ethernet.length > 0 && (
            <div>
              <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <Cable size={13} />
                Puertos ethernet
              </h4>
              <Table
                columnas={['Puerto', 'Tipo', 'Estado', 'Velocidad', 'Duplex', 'Bucle']}
                filas={datos.ethernet}
                renderFila={(p) => (
                  <tr key={p.puerto} className="text-slate-300">
                    <td className="px-3 py-1.5 font-mono text-xs">eth {p.puerto}</td>
                    <td className="px-3 py-1.5 text-xs">{p.tipo}</td>
                    <td className="px-3 py-1.5">
                      <Badge color={p.conectado ? 'verde' : 'gris'}>
                        {p.conectado ? 'conectado' : 'sin nada'}
                      </Badge>
                    </td>
                    {/* Un puerto caído no tiene velocidad cero: no tiene
                        velocidad. Mostrar 0 haría pensar que hay algo enchufado
                        andando mal. */}
                    <td className="px-3 py-1.5 text-xs">
                      {p.velocidad_mbps == null ? (
                        <span className="text-slate-600">—</span>
                      ) : (
                        `${p.velocidad_mbps} Mbps`
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {p.duplex ?? <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {p.bucle ? (
                        <span className="flex items-center gap-1 text-rose-300">
                          <AlertTriangle size={11} /> {p.anillo}
                        </span>
                      ) : (
                        <span className="text-slate-600">no</span>
                      )}
                    </td>
                  </tr>
                )}
              />
            </div>
          )}

          {datos.telefonia.length > 0 && (
            <div>
              <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <Phone size={13} />
                Teléfono
              </h4>
              <Table
                columnas={['Puerto', 'Físico', 'Gancho', 'Registro', 'Códec']}
                filas={datos.telefonia}
                renderFila={(p) => (
                  <tr key={p.puerto} className="text-slate-300">
                    <td className="px-3 py-1.5 font-mono text-xs">pots {p.puerto}</td>
                    <td className="px-3 py-1.5 text-xs">{p.estado_fisico}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {p.gancho}
                      {/^offhook$/i.test(p.gancho ?? '') && (
                        <span className="ml-1 text-[11px] text-amber-400">
                          descolgado
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      <Badge color={p.registrado ? 'verde' : 'rojo'}>{p.registro}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-xs">{p.codec}</td>
                  </tr>
                )}
              />
            </div>
          )}

          {datos.ethernet.length === 0 && datos.telefonia.length === 0 && (
            <p className="py-4 text-center text-sm text-slate-500">
              El equipo no devolvió puertos. Suele pasar con la ONT caída: son consultas OMCI en
              vivo.
            </p>
          )}
        </>
      )}
    </div>
  )
}
