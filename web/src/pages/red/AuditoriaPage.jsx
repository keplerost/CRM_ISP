import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Radar, ScanSearch, ShieldCheck } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { TIPOS_SUBRED } from '../../lib/red'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Field, Select, Table } from '../../components/ui'

/**
 * Auditoría de subred.
 *
 * Contesta una pregunta que ninguna otra pantalla contesta: qué hay conectado
 * que nadie registró. Un vecino enganchado, un equipo de pruebas que quedó
 * puesto, un abonado dado de baja que sigue navegando.
 *
 * El barrido pasivo viene por defecto a propósito: lee la tabla ARP del router
 * y no genera un solo paquete hacia los abonados. El activo recorre el rango
 * dirección por dirección —encuentra también lo que está callado— pero es
 * tráfico real contra la red de producción, así que se pide.
 */
export default function AuditoriaPage() {
  const [subredes, setSubredes] = useState([])
  const [subredId, setSubredId] = useState('')
  const [modo, setModo] = useState('arp')
  const [escaneando, setEscaneando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(true)

  const recargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('v_subredes')
      .select('*')
      .eq('activo', true)
      .order('cidr')
    if (err) setError(err)
    setSubredes(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const subred = subredes.find((s) => s.id === subredId)

  async function escanear() {
    if (!subredId) return setError(new Error('Elegí qué subred auditar'))

    setEscaneando(true)
    setError(null)
    setResultado(null)
    try {
      setResultado(await api.ipam.escanear(subredId, { modo }))
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setEscaneando(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Auditoría de subred</h1>
        <p className="text-sm text-slate-500">
          Qué está conectado de verdad, contra lo que el sistema tiene registrado.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card title="Barrido" icon={Radar}>
        {cargando ? (
          <Cargando />
        ) : subredes.length === 0 ? (
          <Aviso>
            No hay subredes cargadas. Se registran en{' '}
            <Link to="/red/redes" className="font-medium underline">
              Redes IPv4
            </Link>
            : sin un bloque contra el cual comparar, un escaneo devuelve una lista de IPs sin
            significado.
          </Aviso>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Subred">
                <Select value={subredId} onChange={(e) => setSubredId(e.target.value)}>
                  <option value="">Elegir…</option>
                  {subredes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nombre} — {s.cidr}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Tipo de barrido"
                hint={
                  modo === 'arp'
                    ? 'Lee la tabla ARP del router. Instantáneo y sin tocar la red.'
                    : 'Recorre el rango dirección por dirección. Encuentra lo callado, pero tarda y genera tráfico.'
                }
              >
                <Select value={modo} onChange={(e) => setModo(e.target.value)}>
                  <option value="arp">Pasivo (tabla ARP)</option>
                  <option value="scan">Activo (ARP ping sweep)</option>
                </Select>
              </Field>
            </div>

            {subred && !subred.router_id && (
              <Aviso tipo="alerta">
                {subred.nombre} no tiene router asignado. Sin eso no hay desde dónde barrer: el
                servidor no está en esa red.
              </Aviso>
            )}

            {modo === 'scan' && (
              <Aviso tipo="alerta">
                El barrido activo manda paquetes a cada dirección del bloque desde el router de
                producción. En una red cargada conviene correrlo fuera del horario pico.
              </Aviso>
            )}

            <Button
              variante="primario"
              icon={ScanSearch}
              onClick={escanear}
              cargando={escaneando}
              disabled={!subredId || !subred?.router_id}
            >
              {escaneando ? 'Barriendo…' : 'Escanear'}
            </Button>
          </div>
        )}
      </Card>

      {resultado && (
        <>
          <Aviso tipo={resultado.sin_autorizar.length ? 'alerta' : 'info'}>
            {resultado.mensaje}
            <span className="mt-1 block text-xs opacity-80">
              {resultado.vistos} equipos respondieron en {resultado.cidr} desde {resultado.router}.
              {resultado.aviso ? ` ${resultado.aviso}` : ''}
            </span>
          </Aviso>

          <Card
            title="Sin autorizar"
            subtitle="Conectadas y sin dueño en el sistema"
            icon={AlertTriangle}
          >
            {resultado.sin_autorizar.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-emerald-300">
                <ShieldCheck size={16} />
                Todo lo que está conectado está registrado.
              </p>
            ) : (
              <Table
                columnas={['Dirección', 'MAC', '']}
                filas={resultado.sin_autorizar}
                renderFila={(d) => (
                  <tr key={d.ip} className="text-slate-300">
                    <td className="px-3 py-2 font-mono text-sm text-slate-100">{d.ip}</td>
                    <td className="px-3 py-2 font-mono text-xs">{d.mac ?? '—'}</td>
                    <td className="px-3 py-2">
                      <Badge color="rojo">sin registrar</Badge>
                    </td>
                  </tr>
                )}
              />
            )}

            <p className="mt-3 text-xs text-slate-500">
              Quedaron guardadas en el mapa de la subred, marcadas en rojo, para que el hallazgo sea
              trabajo pendiente y no una pantalla que se cierra y se olvida.
            </p>
          </Card>

          {resultado.declaradas_sin_respuesta.length > 0 && (
            <Card title="Asignadas que no contestaron" icon={AlertTriangle}>
              <p className="mb-3 text-sm text-slate-400">
                Tienen dueño en el sistema pero no respondieron. Pueden ser bajas que nadie liberó
                —y esas direcciones están reservadas para nadie— o equipos apagados en este momento.
              </p>
              <div className="flex flex-wrap gap-2">
                {resultado.declaradas_sin_respuesta.map((ip) => (
                  <span
                    key={ip}
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-300"
                  >
                    {ip}
                  </span>
                ))}
              </div>
              {resultado.modo === 'arp' && (
                <p className="mt-3 text-xs text-slate-500">
                  Con el barrido pasivo, un equipo prendido pero callado no aparece. Antes de dar de
                  baja una dirección, confirmalo con el barrido activo.
                </p>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  )
}
