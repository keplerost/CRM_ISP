import { useState } from 'react'
import { AlertTriangle, Ban, HelpCircle, RefreshCw, ShieldAlert, Users } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, ErrorBanner, Select, Stat } from '../ui'
import AdoptarCorte from './AdoptarCorte'

/**
 * Comparar lo que el sistema cree con lo que el router sabe.
 *
 * ── Cuándo se usa ──
 *
 * Después de migrar un padrón, y cada tanto. El sistema cree saber qué IP tiene
 * cada abonado: la que decía el archivo del sistema anterior. El router sabe
 * otra cosa — la que de verdad está configurada. Entre las dos hay diferencias,
 * y cada tipo significa algo distinto para el abonado.
 *
 * ── Por qué solo informa ──
 *
 * Porque "arreglar" esto desde acá es cambiarle la IP a una casa que hoy está
 * andando. A quién se le mueve la dirección lo decide el ISP, no un botón.
 */

/**
 * Los hallazgos, en el orden en que hay que atenderlos.
 *
 * El orden no es estético: el primero es el abonado que paga y no tiene
 * internet, y el último es una curiosidad de inventario. Mostrarlos en otro
 * orden haría que lo urgente aparezca abajo de una lista larga.
 */
const HALLAZGOS = [
  {
    clave: 'en_morosos',
    titulo: 'Activos que el router tiene cortados',
    icono: Ban,
    color: 'text-rose-400',
    porque:
      'Pagan, en el sistema figuran activos y no tienen internet. La IP les quedó en la lista de cortes del sistema anterior. Es la peor de todas porque no da ninguna señal: el que atiende el teléfono va a ver que está todo bien.',
    fila: (f) => (
      <>
        <b className="text-slate-200">{f.nombre}</b>
        <span className="ml-1.5 font-mono text-slate-400">{f.ip}</span>
        <span className="ml-1.5 text-slate-500">en la lista {f.lista}</span>
      </>
    ),
  },
  {
    clave: 'ocupadas_por_otro',
    titulo: 'La IP en el router es de otro',
    icono: Users,
    color: 'text-amber-400',
    porque:
      'Uno de los dos va a quedar sin servicio, y el que llame a reclamar no va a ser necesariamente el que esté mal cargado.',
    fila: (f) => (
      <>
        <b className="text-slate-200">{f.nombre}</b>
        <span className="ml-1.5 font-mono text-slate-400">{f.ip}</span>
        <span className="ml-1.5 text-slate-500">
          en el router figura {f.en_el_router.join(', ')} ({f.fuentes.join(', ')})
        </span>
      </>
    ),
  },
  {
    clave: 'duplicadas',
    titulo: 'Dos abonados con la misma IP',
    icono: AlertTriangle,
    color: 'text-amber-400',
    porque:
      'Vienen del archivo que se importó. Dos equipos con la misma dirección se cortan el servicio entre ellos de a ratos, y eso se persigue durante días.',
    fila: (f) => (
      <>
        <span className="font-mono text-slate-300">{f.ip}</span>
        <span className="ml-1.5 text-slate-400">
          {f.abonados.map((a) => a.nombre).join(' · ')}
        </span>
      </>
    ),
  },
  {
    clave: 'sin_configurar',
    titulo: 'El router no conoce esa IP',
    icono: HelpCircle,
    color: 'text-slate-400',
    porque:
      'O es un abonado que nunca se configuró en el router, o la dirección se inventó al llenar la planilla. Si el abonado tiene servicio, la que está mal es la ficha.',
    fila: (f) => (
      <>
        <b className="text-slate-200">{f.nombre}</b>
        <span className="ml-1.5 font-mono text-slate-400">{f.ip}</span>
        <span className="ml-1.5 text-slate-500">{f.estado}</span>
      </>
    ),
  },
  {
    clave: 'sobran_en_el_router',
    titulo: 'Está en el router y no en el sistema',
    icono: ShieldAlert,
    color: 'text-slate-400',
    porque:
      'O falta importarlo, o es un equipo que nadie registró: una cámara, un enlace, el acceso de alguien.',
    fila: (f) => (
      <>
        <span className="font-mono text-slate-300">{f.ip}</span>
        <span className="ml-1.5 text-slate-400">{f.nombres.join(', ') || 'sin nombre'}</span>
        <span className="ml-1.5 text-slate-600">{f.fuentes.join(', ')}</span>
      </>
    ),
  },
]

export default function ConciliarIps({ routers = [] }) {
  const [routerId, setRouterId] = useState('')
  const [informe, setInforme] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)

  const correr = async () => {
    setCargando(true)
    setError(null)
    setInforme(null)
    try {
      setInforme(await api.ipam.conciliarIps(routerId))
    } catch (e) {
      setError(e)
    } finally {
      setCargando(false)
    }
  }

  const r = informe?.resumen
  const limpio = r && HALLAZGOS.every((h) => r[h.clave] === 0)

  return (
    <Card
      title="Comparar las IPs con el router"
      subtitle="Lo que el sistema cree contra lo que el equipo tiene configurado. No cambia nada."
    >
      <div className="space-y-3 p-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="flex flex-wrap items-end gap-2">
          <Select
            value={routerId}
            onChange={(e) => setRouterId(e.target.value)}
            className="w-64"
          >
            <option value="">Elegí el router…</option>
            {routers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.nombre}
              </option>
            ))}
          </Select>
          <Button
            variante="primario"
            icon={RefreshCw}
            cargando={cargando}
            disabled={!routerId}
            onClick={correr}
          >
            Comparar
          </Button>
        </div>

        {cargando && (
          <p className="text-xs text-slate-500">
            Leyendo el router: secrets, colas, leases y listas. Puede tardar unos segundos.
          </p>
        )}

        {informe && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Abonados con IP" valor={r.abonados_con_ip} />
              <Stat label="IPs en el router" valor={r.ips_en_el_router} />
              <Stat label="Coinciden" valor={r.conformes} color="text-emerald-400" />
              <Stat
                label="Para revisar"
                valor={
                  r.en_morosos + r.ocupadas_por_otro + r.duplicadas + r.sin_configurar
                }
                color={
                  r.en_morosos + r.ocupadas_por_otro + r.duplicadas + r.sin_configurar > 0
                    ? 'text-amber-400'
                    : 'text-emerald-400'
                }
              />
            </div>

            {/* Va antes que todo lo demás, y con el color más fuerte, porque si
                esto está mal el resto del informe es un "está todo bien" falso:
                con el nombre de lista equivocado no se detecta un solo abonado
                cortado, y los cortes que haga el sistema no cortan a nadie. */}
            {informe.corte?.problema && (
              <>
                <Aviso tipo="alerta">
                  <ShieldAlert size={14} className="mr-1 inline" />
                  {informe.corte.problema}
                  {informe.corte.motivos?.length > 0 && (
                    <span className="mt-1 block text-[11px] text-slate-400">
                      Detectadas por sus propias reglas:{' '}
                      {informe.corte.motivos
                        .map((m) => `${m.lista} (${m.motivos.join(' · ')})`)
                        .join(' — ')}
                    </span>
                  )}
                </Aviso>

                {/* Y cómo arreglarlo, acá mismo. Un problema de esta gravedad
                    señalado sin salida se queda señalado. */}
                <AdoptarCorte routerId={routerId} onListo={correr} />
              </>
            )}

            {informe.corte?.coincide && (
              <p className="text-[11px] text-slate-500">
                La lista de cortes configurada —
                <b className="text-slate-400">{informe.corte.configurada}</b>— es la que el router
                usa de verdad.
              </p>
            )}

            {limpio && !informe.corte?.problema && (
              <Aviso>
                Todas las direcciones del sistema coinciden con lo que tiene el router{' '}
                <b>{informe.router}</b>.
              </Aviso>
            )}

            {HALLAZGOS.map((h) => {
              const filas = informe[h.clave] ?? []
              if (!filas.length) return null
              const Icono = h.icono

              return (
                <div key={h.clave} className="rounded-lg border border-slate-800">
                  <div className="border-b border-slate-800 px-3 py-2">
                    <p className={`text-sm font-medium ${h.color}`}>
                      <Icono size={14} className="mr-1.5 inline" />
                      {h.titulo}
                      <Badge color="gris">{filas.length}</Badge>
                    </p>
                    {/* Qué significa cada grupo. Sin esto la pantalla es una
                        lista de IPs, y una lista de IPs no le dice a nadie qué
                        hacer con ellas. */}
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{h.porque}</p>
                  </div>
                  <ul className="max-h-56 overflow-auto px-3 py-2 text-xs">
                    {filas.slice(0, 200).map((f, i) => (
                      <li key={`${f.ip}-${i}`} className="border-b border-slate-800/40 py-1 last:border-0">
                        {h.fila(f)}
                      </li>
                    ))}
                    {filas.length > 200 && (
                      <li className="py-1 text-slate-600">
                        y {filas.length - 200} más. Se muestran las primeras 200.
                      </li>
                    )}
                  </ul>
                </div>
              )
            })}
          </>
        )}
      </div>
    </Card>
  )
}
