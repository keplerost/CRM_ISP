import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, FileText, PhoneCall, Upload } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../lib/apiNetwork'
import { abrirPdf } from '../lib/pdf'
import { dineroCero as dinero } from '../lib/formato'
import { Aviso, Button, Card, ErrorBanner, Field, Select, Table } from '../components/ui'

/**
 * Conciliación bancaria.
 *
 * ── La pregunta ──
 *
 * "¿La plata que dice el sistema entró de verdad?" Alguien registró un cobro con
 * un número de comprobante que le dictaron por WhatsApp. Acá se sube el extracto
 * y se contesta.
 *
 * ── Por qué son TRES listas y no una ──
 *
 * Porque hay dos formas de estar mal y son opuestas:
 *
 *   El sistema lo tiene y el banco no → se dio por cobrada plata que no entró.
 *   El banco lo tiene y el sistema no → alguien pagó y nadie le acreditó; ese
 *   abonado va camino al corte habiendo cumplido.
 *
 * Un informe que solo muestre la primera deja pasar la segunda, que es la que
 * genera el reclamo más caro.
 */

export default function ConciliacionPage() {
  const [cuentas, setCuentas] = useState([])
  const [cuenta, setCuenta] = useState('')
  const [archivo, setArchivo] = useState(null)
  const [informe, setInforme] = useState(null)
  const [subiendo, setSubiendo] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    supabase
      .from('cuentas_pago')
      .select('id, nombre, tipo, banco')
      .eq('activa', true)
      .neq('tipo', 'efectivo')
      .order('nombre')
      .then(({ data }) => setCuentas(data ?? []))
  }, [])

  /** El input da un File; el middleware espera base64. */
  function elegir(e) {
    const f = e.target.files?.[0]
    setInforme(null)
    if (!f) return setArchivo(null)

    const lector = new FileReader()
    lector.onload = () => setArchivo({ nombre: f.name, tamano: f.size, b64: lector.result })
    lector.onerror = () => setError(new Error('No se pudo leer el archivo'))
    lector.readAsDataURL(f)
  }

  async function conciliar() {
    if (!archivo) return
    setSubiendo(true)
    setError(null)
    try {
      setInforme(await api.pagos.conciliar({ archivo: archivo.b64, cuenta: cuenta || null }))
    } catch (e) {
      setError(e)
    } finally {
      setSubiendo(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Conciliación bancaria</h1>
        <p className="text-sm text-slate-500">
          Subí el extracto del banco y comprobá que los comprobantes registrados existan de
          verdad.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card>
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Field
            label="Cuenta"
            hint={
              cuenta
                ? 'Se comparan solo los cobros registrados en esta cuenta'
                : 'Sin elegir cuenta se comparan todas las transferencias y depósitos'
            }
          >
            <Select value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
              <option value="">Todas las electrónicas</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}{c.banco ? ` · ${c.banco}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Extracto" hint="El Excel tal como lo descarga el banco, sin editar">
            <div className="flex items-center gap-2">
              <Button variante="secundario" icon={Upload} onClick={() => inputRef.current?.click()}>
                Elegir archivo
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={elegir}
                className="hidden"
              />
              {archivo && (
                <span className="truncate text-xs text-slate-400" title={archivo.nombre}>
                  {archivo.nombre}
                </span>
              )}
            </div>
          </Field>

          <Field label="&nbsp;">
            <Button variante="primario" onClick={conciliar} disabled={!archivo} cargando={subiendo}>
              Conciliar
            </Button>
          </Field>
        </div>

        {/* El período NO se elige: sale del propio extracto. Pedirlo aparte deja
            comparar el archivo de julio contra los cobros de agosto y recibir
            doscientos faltantes que no lo son. */}
        <p className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
          El período se toma del archivo: se comparan los cobros de las mismas fechas que
          trae el extracto.
        </p>
      </Card>

      {informe && (
        <Informe
          informe={informe}
          onPdf={() =>
            abrirPdf(() => api.pagos.conciliacionPdf({ archivo: archivo.b64, cuenta: cuenta || null }))
              .catch(setError)
          }
        />
      )}
    </div>
  )
}

function Informe({ informe, onPdf }) {
  const { totales, periodo } = informe
  const cuadra = !informe.sin_respaldo.length && !informe.no_registrados.length

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            {cuadra ? (
              <CheckCircle2 size={18} className="text-emerald-400" />
            ) : (
              <AlertTriangle size={18} className="text-amber-400" />
            )}
            <span className="text-sm font-medium text-slate-200">
              {cuadra ? 'Todo cuadra' : 'Hay diferencias'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {periodo && (
              <span className="text-xs text-slate-500">
                {periodo.desde} al {periodo.hasta} · {informe.movimientos_banco} créditos en el banco ·{' '}
                {informe.cobros_sistema} cobros en el sistema
              </span>
            )}
            <Button variante="secundario" icon={FileText} onClick={onPdf}>
              Informe PDF
            </Button>
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Dato titulo="Entró al banco" valor={dinero(totales.banco)} />
          <Dato titulo="Conciliado" valor={dinero(totales.conciliado)} color="text-emerald-300" />
          <Dato
            titulo="Sin respaldo"
            valor={dinero(totales.sin_respaldo)}
            color="text-rose-300"
            nota={`${informe.sin_respaldo.length} comprobante${informe.sin_respaldo.length === 1 ? '' : 's'}`}
          />
          <Dato
            titulo="No registrado"
            valor={dinero(totales.no_registrado)}
            color="text-amber-300"
            nota={`${informe.no_registrados.length} movimiento${informe.no_registrados.length === 1 ? '' : 's'}`}
          />
        </div>

        {informe.ilegibles?.length > 0 && (
          <div className="px-4 pb-4">
            <Aviso tipo="alerta">
              {informe.ilegibles.length} fila{informe.ilegibles.length === 1 ? '' : 's'} del extracto
              no se pudieron leer y quedaron fuera de la comparación.
            </Aviso>
          </div>
        )}
      </Card>

      {/* --- A quién llamar --------------------------------------------------- */}
      {informe.sin_respaldo.length > 0 && (
        <Card
          title="A quién llamar"
          icon={PhoneCall}
          subtitle="Registrados como cobrados, no están en el extracto del banco"
        >
          <Table
            columnas={['Cliente', 'Teléfono', 'Comprobante', 'Fecha', 'Cobrado', 'Motivo']}
            filas={informe.sin_respaldo}
            vacio="Ninguno"
            renderFila={(c) => (
              <tr key={c.id} className="text-slate-300">
                <td className="px-3 py-2 text-slate-100">
                  {c.client_id ? (
                    <Link to={`/clientes/${c.client_id}`} className="hover:text-sky-400">
                      {c.cliente}
                    </Link>
                  ) : (
                    c.cliente
                  )}
                  {c.codigo != null && <span className="ml-2 text-xs text-slate-500">#{c.codigo}</span>}
                </td>
                <td className="px-3 py-2">
                  {c.telefono ? (
                    /* Toca y llama: esta lista se usa con el teléfono en la mano. */
                    <a href={`tel:${c.telefono}`} className="text-sky-400 hover:underline">
                      {c.telefono}
                    </a>
                  ) : (
                    <span className="text-slate-600">sin teléfono</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{c.n_transaccion ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{c.fecha_pago}</td>
                <td className="px-3 py-2 text-right tabular-nums">{dinero(c.cobrado)}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{c.motivo}</td>
              </tr>
            )}
          />
        </Card>
      )}

      {/* --- Entró y nadie lo registró ---------------------------------------- */}
      {informe.no_registrados.length > 0 && (
        <Card
          title="Entró al banco y nadie lo registró"
          subtitle="Alguien pagó y no se le acreditó: si no se carga, se lo corta habiendo pagado"
        >
          <Table
            columnas={['Fecha', 'Quién', 'Documento', 'Concepto', 'Monto']}
            filas={informe.no_registrados}
            vacio="Ninguno"
            renderFila={(m) => (
              <tr key={`${m.documento}-${m.fila}`} className="text-slate-300">
                <td className="px-3 py-2 text-xs">
                  {m.fecha} <span className="text-slate-600">{String(m.hora).slice(0, 5)}</span>
                </td>
                <td className="px-3 py-2 text-slate-100">
                  {m.probable_nombre || <span className="text-slate-600">no lo dice el banco</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{m.documento}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{m.concepto}</td>
                <td className="px-3 py-2 text-right tabular-nums">{dinero(m.monto)}</td>
              </tr>
            )}
          />
        </Card>
      )}

      {/* --- Mismo comprobante, otro monto ------------------------------------ */}
      {informe.monto_distinto.length > 0 && (
        <Card
          title="Mismo comprobante, distinto monto"
          subtitle="El comprobante existe pero por otro valor: hay que corregir el registrado"
        >
          <Table
            columnas={['Cliente', 'Comprobante', 'En el sistema', 'En el banco', 'Diferencia']}
            filas={informe.monto_distinto}
            vacio="Ninguno"
            renderFila={(c) => (
              <tr key={c.id} className="text-slate-300">
                <td className="px-3 py-2 text-slate-100">{c.cliente}</td>
                <td className="px-3 py-2 font-mono text-xs">{c.n_transaccion}</td>
                <td className="px-3 py-2 text-right tabular-nums">{dinero(c.cobrado)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{dinero(c.banco.monto)}</td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    c.diferencia > 0 ? 'text-emerald-300' : 'text-rose-300'
                  }`}
                >
                  {c.diferencia > 0 ? '+' : ''}
                  {dinero(c.diferencia)}
                </td>
              </tr>
            )}
          />
        </Card>
      )}
    </div>
  )
}

function Dato({ titulo, valor, nota = null, color = 'text-slate-100' }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{titulo}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{valor}</p>
      {nota && <p className="mt-0.5 text-[11px] text-slate-500">{nota}</p>}
    </div>
  )
}
