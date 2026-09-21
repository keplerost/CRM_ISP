import { useState } from 'react'
import { AlertTriangle, Download, Save, Waves } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { descargar } from '../../lib/olts'
import { NIVELES, dbm, nivel, nivelDe, porPuerto, UMBRAL_DBM } from '../../lib/optica'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner } from '../ui'

/**
 * Mapa de potencia óptica de toda la OLT.
 *
 * Se lee por SNMP en un solo recorrido: por CLI habría que abrir una
 * conversación por abonado y con mil ONTs eso no termina nunca.
 *
 * El agrupado por puerto no es decorativo. Cuando se cae un módulo óptico o se
 * daña un tramo de fibra, la señal baja de TODOS los abonados de ese puerto a la
 * vez — y desde la ficha de cada uno parece un problema distinto. Acá se ve que
 * son quince reclamos con una sola causa.
 */
export default function OltOptica({ olt }) {
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [completo, setCompleto] = useState(false)
  const [guardado, setGuardado] = useState(null)

  async function leer({ guardar = false } = {}) {
    setCargando(true)
    setError(null)
    setGuardado(null)
    try {
      const r = await api.olt.potencias(olt.id, { completo, guardar })
      setDatos(r)
      if (guardar) setGuardado(`${r.guardadas} lecturas guardadas en las fichas.`)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }

  function exportar() {
    const filas = [
      ['slot', 'puerto', 'ont', 'rx_dbm', 'tx_dbm', 'temperatura_c', 'voltaje_v', 'bias_ma'].join(';'),
      ...datos.onts.map((o) =>
        [o.slot, o.puerto, o.ontId, o.rx_dbm, o.tx_dbm, o.temperatura_c, o.voltaje_v, o.bias_ma]
          .map((v) => (v == null ? '' : v))
          .join(';'),
      ),
    ]
    descargar(`optica-${olt.nombre.replace(/\W+/g, '_')}.csv`, `﻿${filas.join('\r\n')}`)
  }

  const puertos = datos ? porPuerto(datos.onts) : []

  return (
    <Card
      title="Potencia óptica"
      subtitle={
        datos
          ? `${datos.onts.length} ONTs leídas en ${(datos.ms / 1000).toFixed(1)} s`
          : 'Se lee de todas las ONTs de una sola vez, por SNMP'
      }
      icon={Waves}
      actions={
        <div className="flex flex-wrap gap-2">
          {datos && (
            <Button icon={Download} onClick={exportar}>
              Exportar
            </Button>
          )}
          {datos && (
            <Button icon={Save} onClick={() => leer({ guardar: true })} cargando={cargando}>
              Leer y guardar
            </Button>
          )}
          <Button variante="primario" icon={Waves} onClick={() => leer()} cargando={cargando}>
            Leer ahora
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />
        {guardado && <Aviso>{guardado}</Aviso>}

        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={completo}
            onChange={(e) => setCompleto(e.target.checked)}
            className="accent-sky-500"
          />
          Leer también temperatura, voltaje y corriente del láser
          <span className="text-slate-600">
            — son cinco recorridos en vez de uno; con muchas ONTs tarda cinco veces más
          </span>
        </label>

        {cargando && !datos && (
          <Cargando texto="Recorriendo el árbol SNMP del equipo… la OLT interroga cada módulo por la fibra" />
        )}

        {!datos && !cargando && (
          <Aviso>
            La lectura tarda porque la OLT tiene que preguntarle a cada ONT por la fibra. Contra el
            X7 con 85 ONTs son unos 6 segundos; con mil, algo más de un minuto. No se pide sola: se
            lee cuando hace falta.
          </Aviso>
        )}

        {datos && (
          <>
            <div className="flex flex-wrap items-center gap-4 t-panel px-4 py-3">
              {Object.entries(NIVELES).map(([clave, n]) => {
                const cuantas = datos.onts.filter(
                  (o) => nivelDe(o.rx_dbm) === clave,
                ).length
                return (
                  <span key={clave} className="flex items-center gap-2 text-xs" title={n.ayuda}>
                    <span className={`h-2.5 w-2.5 rounded-full ${n.punto}`} />
                    <span className="text-slate-300">{n.label}</span>
                    <span className="font-semibold text-slate-100">{cuantas}</span>
                  </span>
                )
              })}
            </div>

            {datos.con_alerta > 0 && (
              <Aviso tipo="alerta">
                <span className="flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    <b>{datos.con_alerta} ONTs por debajo de {UMBRAL_DBM} dBm.</b> Si están todas en
                    el mismo puerto, es la fibra o el módulo óptico de ese puerto y no los equipos
                    de los abonados.
                  </span>
                </span>
              </Aviso>
            )}

            {puertos.map((p) => (
              <div key={p.clave}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Slot {p.slot} · Puerto {p.puerto}
                  </h3>
                  <span className="text-[11px] text-slate-500">{p.onts.length} ONTs</span>
                  {p.malas > 0 && <Badge color="rojo">{p.malas} con señal baja</Badge>}
                  {p.sinDato > 0 && <Badge color="gris">{p.sinDato} sin lectura</Badge>}
                  {/* Un puerto entero caído es una causa, no quince. */}
                  {p.malas === p.onts.length && p.onts.length > 1 && (
                    <Badge color="rojo">todo el puerto — revisá la fibra o el módulo</Badge>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {p.onts.map((o) => {
                    const n = nivel(o.rx_dbm)
                    return (
                      <div
                        key={o.ontId}
                        title={[
                          `ONT ${o.ontId}`,
                          `RX ${dbm(o.rx_dbm)}`,
                          o.tx_dbm != null ? `TX ${dbm(o.tx_dbm)}` : null,
                          o.temperatura_c != null ? `${o.temperatura_c} °C` : null,
                          o.voltaje_v != null ? `${o.voltaje_v} V` : null,
                          n.ayuda,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        className={`flex h-14 w-[70px] flex-col items-center justify-center rounded-lg border ${n.clase}`}
                      >
                        <span className="text-[10px] opacity-70">ONT {o.ontId}</span>
                        <span className="text-sm font-semibold">
                          {o.rx_dbm != null ? o.rx_dbm.toFixed(1) : '—'}
                        </span>
                        <span className="text-[9px] opacity-60">dBm</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </Card>
  )
}
