import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { configurarMoneda } from '../../lib/formato'
import { fijarIvaGeneral } from '../../lib/iva'
import { fijarPais, usePais } from '../../lib/pais'
import { Aviso, Button, Card, Field, Select } from '../ui'

/**
 * El país del ISP.
 *
 * Decide cómo se llaman las cosas —el impuesto, el ente tributario, los
 * documentos— y qué módulos legales existen: el comprobante del SRI y lo de
 * ARCOTEL son solo de Ecuador. Al elegirlo se proponen el impuesto, la moneda y
 * la zona horaria del país; se pueden destildar, porque hay ISPs que facturan
 * en dólares sin estar en Ecuador.
 */
export default function PaisIsp({ onError }) {
  const actual = usePais()
  const [paises, setPaises] = useState([])
  const [elegido, setElegido] = useState(null)
  const [aplicar, setAplicar] = useState({ impuesto: true, moneda: true, zona: true })
  const [guardando, setGuardando] = useState(false)
  const [hecho, setHecho] = useState(null)

  useEffect(() => {
    api.general.paises().then(setPaises).catch(onError)
  }, [onError])

  const codigo = elegido ?? actual.codigo
  const perfil = paises.find((p) => p.codigo === codigo) ?? actual
  const cambia = codigo !== actual.codigo

  async function guardar() {
    setGuardando(true)
    setHecho(null)
    onError?.(null)
    try {
      const r = await api.general.guardarPais({ pais: codigo, aplicar })
      // Que el menú y las pantallas abiertas se enteren sin recargar.
      fijarPais(r.perfil)
      if (r.hecho.impuesto) fijarIvaGeneral(r.hecho.impuesto.tarifa)
      if (r.hecho.moneda) configurarMoneda(r.hecho.moneda.simbolo)
      setElegido(null)
      setHecho(r.hecho)
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const marca = (clave) => (e) => setAplicar((a) => ({ ...a, [clave]: e.target.checked }))

  const fuera = []
  if (!perfil.modulos.facturacionElectronica) fuera.push('la facturación electrónica del SRI')
  if (!perfil.modulos.reporteRegulador) fuera.push('el reporte de ARCOTEL')
  if (!perfil.modulos.contratoRegulador) fuera.push('el contrato de adhesión de ARCOTEL')

  return (
    <Card title="País" subtitle="Dónde opera el ISP" icon={Globe}>
      <div className="space-y-4">
        <Field label="País del ISP">
          <Select
            value={codigo}
            onChange={(e) => {
              setElegido(e.target.value)
              setHecho(null)
            }}
            className="max-w-xs"
          >
            {(paises.length ? paises : [actual]).map((p) => (
              <option key={p.codigo} value={p.codigo}>
                {p.nombre}
              </option>
            ))}
          </Select>
        </Field>

        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Dato titulo="Impuesto" valor={`${perfil.impuesto.nombre} ${perfil.impuesto.tarifa} %`} />
          <Dato titulo="Ente tributario" valor={`${perfil.ente.sigla} — ${perfil.ente.nombre}`} />
          <Dato titulo="Regulador" valor={`${perfil.regulador.sigla} — ${perfil.regulador.nombre}`} />
          <Dato titulo="Moneda" valor={`${perfil.moneda.simbolo} (${perfil.moneda.codigo})`} />
          <Dato titulo="Zona horaria" valor={perfil.zona} />
          <Dato
            titulo="Documentos"
            valor={`${perfil.documentos['05']?.nombre} · ${perfil.documentos['04']?.nombre}`}
          />
        </dl>

        {fuera.length > 0 && (
          <Aviso>
            En {perfil.nombre} no se muestran {fuera.join(', ')}: son exigencias legales de Ecuador. La
            facturación del sistema, los cobros, los cortes y la red funcionan completos.
          </Aviso>
        )}

        {cambia && (
          <div className="space-y-2 rounded-lg border border-[rgba(15,23,42,0.08)] p-3">
            <p className="text-xs font-medium text-slate-300">Al guardar, aplicar también:</p>
            <Marca checked={aplicar.impuesto} onChange={marca('impuesto')}>
              El impuesto: {perfil.impuesto.nombre} {perfil.impuesto.tarifa} % (se actualizan los planes
              que tenían el anterior)
            </Marca>
            <Marca checked={aplicar.moneda} onChange={marca('moneda')}>
              La moneda: {perfil.moneda.simbolo} {perfil.moneda.codigo}
            </Marca>
            <Marca checked={aplicar.zona} onChange={marca('zona')}>
              La zona horaria: {perfil.zona} (las tareas programadas pasan a esa hora)
            </Marca>
          </div>
        )}

        <div className="flex justify-end">
          <Button variante="primario" onClick={guardar} cargando={guardando} disabled={!cambia}>
            Guardar país
          </Button>
        </div>

        {hecho && (
          <Aviso tipo="exito">
            País: {hecho.pais}.
            {hecho.impuesto &&
              ` Impuesto en ${hecho.impuesto.tarifa} %${hecho.impuesto.planes ? ` (${hecho.impuesto.planes} plan(es) actualizados)` : ''}.`}
            {hecho.moneda && ` Moneda: ${hecho.moneda.simbolo} ${hecho.moneda.codigo}.`}
            {hecho.zona && ` Zona horaria: ${hecho.zona}.`}
          </Aviso>
        )}

        <p className="text-xs leading-snug text-slate-500">
          Los datos de cada país son un punto de partida: confirmalos con un contador local antes de
          facturar. El impuesto, la moneda y la zona se pueden cambiar después en sus pantallas.
        </p>
      </div>
    </Card>
  )
}

const Dato = ({ titulo, valor }) => (
  <div>
    <dt className="text-xs text-slate-500">{titulo}</dt>
    <dd className="text-slate-200">{valor}</dd>
  </div>
)

const Marca = ({ checked, onChange, children }) => (
  <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-300">
    <input type="checkbox" checked={checked} onChange={onChange} className="mt-1 accent-sky-500" />
    <span>{children}</span>
  </label>
)
