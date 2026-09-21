import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Check, Radio, SlidersHorizontal, Waypoints } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Badge, Card, Cargando, ErrorBanner, Table } from '../../components/ui'

/**
 * Dónde se limita el ancho de banda de cada abonado.
 *
 * No es una configuración: es una regla de la red que hay que saber para no
 * buscar el límite en el equipo equivocado. Esta pantalla la escribe y, sobre
 * todo, muestra quién NO la está cumpliendo — que es el único motivo para tener
 * una pantalla en vez de un párrafo en el manual.
 *
 *   PPPoE      El caudal se limita en la OLT, con la traffic table del plan. El
 *              perfil PPP del router se crea sin rate-limit.
 *
 *   IP fija    El límite lo pone la Simple Queue del MikroTik, una por abonado.
 *
 * Lo que decide es el `tipo_conexion` del abonado y no la tecnología con la que
 * le llega el servicio: un sector de fibra administrado con IPv4 fija se limita
 * en el MikroTik igual que un radioenlace.
 */

/**
 * Lo que decide dónde se limita a un abonado es su `tipo_conexion`, NO la
 * tecnología con la que le llega el servicio.
 *
 * Parece un matiz y no lo es: un sector de fibra administrado con IPv4 fija se
 * limita en el MikroTik igual que un radioenlace, y llamarle "la regla de FTTH"
 * a lo de PPPoE hace buscar el límite en el equipo equivocado.
 */
const REGLAS = [
  {
    clave: 'pppoe',
    icono: Waypoints,
    titulo: 'Abonados por PPPoE',
    donde: 'En la OLT',
    detalle:
      'El caudal sobre la fibra lo controla la traffic table del plan. El perfil PPP del router se crea sin rate-limit: un límite ahí competiría con la OLT.',
    nota: 'Es lo habitual en FTTH con autenticación PPPoE.',
    aplica: 'Servicios → Planes → Aplicar en OLT',
    ruta: '/servicios/planes',
  },
  {
    clave: 'ip',
    icono: Radio,
    titulo: 'Abonados con IP fija',
    donde: 'En el MikroTik',
    detalle:
      'El límite es la Simple Queue del abonado, con su caudal garantizado, su ráfaga y su prioridad.',
    nota: 'Vale para radioenlace y también para los sectores de fibra que se administran con IPv4 fija.',
    aplica: 'Servicios → Planes → A los clientes',
    ruta: '/servicios/planes',
  },
]

export default function ShapingPage() {
  const [clientes, setClientes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_clientes_ficha')
      .select('id, nombre, estado, tipo_conexion, plan, plan_id, onu_id, router_id, ip')
      .neq('estado', 'baja')

    if (err) setError(err)
    setClientes(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Se agrupa por tipo de conexión y no por tecnología: un abonado de fibra
  // con IP fija se limita como uno de radio, y contarlo del otro lado haría que
  // los números de esta pantalla no coincidan con lo que se aplica.
  const porPppoe = clientes.filter((c) => c.tipo_conexion === 'pppoe')
  const porIpFija = clientes.filter((c) => c.tipo_conexion !== 'pppoe')

  /**
   * Quién queda sin límite en ningún lado.
   *
   * Un abonado sin plan no tiene de dónde sacar la velocidad, y uno de radio
   * sin IP no tiene a qué apuntarle la cola. En los dos casos el resultado es
   * el mismo: navega sin tope y nadie se entera hasta que satura el nodo.
   */
  const sinLimite = clientes.filter((c) => !c.plan_id || (c.tipo_conexion !== 'pppoe' && !c.ip))

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Regla de shaping</h1>
        <p className="text-sm text-slate-500">
          Dónde se limita el ancho de banda según cómo se conecta cada abonado.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid gap-4 lg:grid-cols-2">
        {REGLAS.map((r) => {
          const Icono = r.icono
          const cuantos = r.clave === 'pppoe' ? porPppoe.length : porIpFija.length

          return (
            <Card key={r.clave} title={r.titulo} icon={Icono}>
              <div className="space-y-3">
                <p className="text-2xl font-semibold text-slate-100">{r.donde}</p>
                <p className="text-sm text-slate-400">{r.detalle}</p>
                <p className="text-xs text-slate-500">{r.nota}</p>

                <div className="flex items-center justify-between border-t border-slate-800 pt-3">
                  <span className="text-sm text-slate-300">
                    {cuantos} {cuantos === 1 ? 'abonado' : 'abonados'}
                  </span>
                  <Link to={r.ruta} className="text-xs text-sky-400 hover:underline">
                    {r.aplica}
                  </Link>
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      <Aviso>
        Lo que decide dónde se limita a un abonado es <b>cómo conecta</b>, no con qué tecnología le
        llega el servicio. Un sector de fibra administrado con IPv4 fija se limita en el MikroTik
        igual que un radioenlace: alcanza con dejarle <b>Tipo de conexión: IP</b> en su ficha de
        servicio, y el mismo plan comercial le sirve sin duplicarlo.
      </Aviso>

      <Aviso>
        La consecuencia práctica: cambiar un plan de PPPoE se resuelve en un solo lugar —la traffic
        table de la OLT— mientras que con IP fija hay que reescribir la cola de cada abonado, una
        por una. Por eso “A los clientes” existe solo para el segundo caso.
      </Aviso>

      <Card
        title="Abonados sin límite aplicable"
        subtitle="No se les puede aplicar shaping en ningún lado"
        icon={AlertTriangle}
      >
        {cargando ? (
          <Cargando />
        ) : sinLimite.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <Check size={16} />
            Todos los abonados activos tienen con qué limitarse.
          </p>
        ) : (
          <Table
            columnas={['Abonado', 'Conexión', 'Plan', 'Qué falta']}
            filas={sinLimite}
            renderFila={(c) => (
              <tr key={c.id} className="text-slate-300">
                <td className="px-3 py-2">
                  <Link
                    to={`/clientes/${c.id}`}
                    className="text-slate-100 hover:text-sky-400 hover:underline"
                  >
                    {c.nombre}
                  </Link>
                </td>
                <td className="px-3 py-2 text-xs">
                  {c.tipo_conexion === 'pppoe' ? 'PPPoE' : 'IP fija'}
                </td>
                <td className="px-3 py-2 text-xs">{c.plan ?? <span className="text-slate-600">—</span>}</td>
                <td className="px-3 py-2">
                  <Badge color="ambar">
                    {!c.plan_id ? 'Sin plan asignado' : 'Sin IP para la cola'}
                  </Badge>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <p className="flex items-start gap-2 text-xs text-slate-500">
        <SlidersHorizontal size={14} className="mt-0.5 shrink-0" />
        Esta pantalla no configura nada: describe la regla y señala a quién no se le está aplicando.
        Los cambios se hacen en Servicios → Planes de internet, y el tipo de conexión de cada
        abonado en su ficha de servicio.
      </p>
    </div>
  )
}
