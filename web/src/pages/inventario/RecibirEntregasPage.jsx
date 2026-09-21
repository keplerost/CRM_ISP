import { useCallback, useEffect, useState } from 'react'
import { FileSignature, FileText, Inbox, PackageCheck } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { entregasApi } from '../../lib/entregas'
import { api } from '../../lib/apiNetwork'
import { abrirPdf } from '../../lib/pdf'
import FirmaDigital from '../../components/soporte/FirmaDigital'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Modal,
  Select,
  Table,
  Textarea,
} from '../../components/ui'

/**
 * Las actas que esperan una firma.
 *
 * ── Qué se está firmando ──
 *
 * Que estos equipos concretos, con estas series, entraron a la oficina hoy. A
 * partir de la firma dejan de ser responsabilidad del técnico y pasan al
 * almacén general, con su movimiento de inventario.
 *
 * ── Por qué no la puede firmar quien entregó ──
 *
 * Porque entonces no probaría nada. La base lo rechaza —no es una validación de
 * esta pantalla— y por eso no hace falta esconder el botón: si alguien lo
 * intenta, el error explica el motivo.
 */
export default function RecibirEntregasPage() {
  const [actas, setActas] = useState([])
  const [almacenes, setAlmacenes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [firmando, setFirmando] = useState(null)
  const [firmadas, setFirmadas] = useState([])

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      /*
       * Las dos listas en el mismo viaje.
       *
       * Antes esta pantalla mostraba solo las pendientes, y al firmar un acta
       * desaparecía: el respaldo que se acababa de firmar dejaba de estar a la
       * vista justo cuando alguien lo quiere guardar o imprimir.
       */
      const [pend, todas] = await Promise.all([entregasApi.pendientes(), entregasApi.mias()])
      setActas(pend)
      setFirmadas(todas.filter((a) => a.estado === 'recibida'))
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
    supabase
      .from('almacenes')
      .select('id, nombre, tipo')
      .is('tecnico_id', null)
      .order('nombre')
      .then(({ data }) => setAlmacenes(data ?? []))
  }, [recargar])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
          <Inbox size={20} className="text-sky-400" />
          Material que devuelven los técnicos
        </h1>
        <p className="text-sm text-slate-400">
          Actas esperando que alguien las revise y firme. Hasta la firma, el equipo sigue siendo del
          técnico.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card>
        {cargando ? (
          <Cargando />
        ) : actas.length === 0 ? (
          <Aviso>No hay actas esperando firma.</Aviso>
        ) : (
          <Table
            columnas={['Acta', 'Entrega', 'Equipos', 'Desde', 'Notas', '']}
            filas={actas}
            renderFila={(a) => (
              <tr key={a.id} className="text-slate-300">
                <td className="px-3 py-2">
                  <span className="font-mono text-slate-100">N° {a.numero}</span>
                  <div className="text-[11px] text-slate-500">
                    {new Date(a.creado_en).toLocaleString('es-EC')}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  {a.entrega ?? '—'}
                  <div className="text-[11px] text-slate-500">
                    {a.firmada_entrega ? 'ya firmó' : 'sin firmar'}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Badge color="azul">{a.equipos}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{a.almacen_origen ?? '—'}</td>
                <td className="max-w-[18rem] truncate px-3 py-2 text-xs text-slate-400" title={a.notas ?? ''}>
                  {a.notas ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      variante="fantasma"
                      icon={FileText}
                      title="Ver el acta en PDF"
                      onClick={() => abrirPdf(() => api.actas.entrega(a.id))}
                    />
                    <Button
                      variante="primario"
                      icon={FileSignature}
                      onClick={() => setFirmando(a)}
                      className="py-1.5 text-xs"
                    >
                      Revisar y firmar
                    </Button>
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      {firmadas.length > 0 && (
        <Card
          title="Actas ya recibidas"
          subtitle="El respaldo firmado por las dos partes. Se puede imprimir cuando haga falta."
        >
          <Table
            columnas={['Acta', 'Entregó', 'Recibió', 'Equipos', 'Firmas', '']}
            filas={firmadas}
            renderFila={(a) => (
              <tr key={a.id} className="text-slate-300">
                <td className="px-3 py-2">
                  <span className="font-mono text-slate-100">N° {a.numero}</span>
                  <div className="text-[11px] text-slate-500">
                    {new Date(a.firmado_en ?? a.creado_en).toLocaleDateString('es-EC')}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">{a.entrega ?? '—'}</td>
                <td className="px-3 py-2 text-xs">{a.recibe ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge color="azul">{a.equipos}</Badge>
                </td>
                <td className="px-3 py-2">
                  {a.firmada ? (
                    <Badge color="verde">las dos</Badge>
                  ) : (
                    /* Las actas anteriores a la migración de las dos firmas
                       tienen solo la de recepción. Se dice, en vez de mostrarlas
                       como si estuvieran completas. */
                    <Badge color="ambar">solo recepción</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    icon={FileText}
                    onClick={() => abrirPdf(() => api.actas.entrega(a.id))}
                    className="py-1.5 text-xs"
                  >
                    Ver acta
                  </Button>
                </td>
              </tr>
            )}
          />
        </Card>
      )}

      <Firmar
        acta={firmando}
        almacenes={almacenes}
        onCerrar={() => setFirmando(null)}
        onListo={recargar}
        onError={setError}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

function Firmar({ acta, almacenes, onCerrar, onListo, onError }) {
  const [items, setItems] = useState([])
  const [firma, setFirma] = useState(null)
  const [almacen, setAlmacen] = useState('')
  const [notas, setNotas] = useState('')
  const [guardando, setGuardando] = useState(false)

  useEffect(() => {
    if (!acta) return
    setFirma(null)
    setNotas('')
    setAlmacen(almacenes.find((a) => a.tipo === 'bodega')?.id ?? '')
    entregasApi.items(acta.id).then(setItems).catch(onError)
  }, [acta, almacenes, onError])

  async function firmar() {
    setGuardando(true)
    try {
      await entregasApi.recibir(acta.id, { firma, almacen, notas })
      onCerrar()
      await onListo()
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Modal
      abierto={Boolean(acta)}
      titulo={acta ? `Acta N° ${acta.numero} — ${acta.entrega ?? ''}` : ''}
      onCerrar={onCerrar}
      ancho="max-w-xl"
    >
      <div className="space-y-4">
        {/* Lo que se está por firmar, con las series a la vista: firmar una
            lista que no se leyó es lo mismo que no firmar nada. */}
        <div>
          <p className="mb-1 text-xs text-slate-400">Contá y revisá antes de firmar:</p>
          <div className="max-h-48 space-y-1 overflow-y-auto t-panel p-2">
            {items.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-slate-200">{i.serie ?? 'sin serie'}</span>
                <span className="text-slate-500">{i.modelo ?? '—'}</span>
              </div>
            ))}
            {items.length === 0 && <p className="text-xs text-slate-500">Sin equipos.</p>}
          </div>
        </div>

        <label className="block text-xs text-slate-400">
          Entran a
          <Select value={almacen} onChange={(e) => setAlmacen(e.target.value)} className="mt-1">
            {almacenes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nombre}
              </option>
            ))}
          </Select>
        </label>

        <label className="block text-xs text-slate-400">
          Observaciones
          <Textarea
            rows={2}
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            placeholder="Si algo llegó dañado o falta, escribilo acá antes de firmar."
            className="mt-1"
          />
        </label>

        <div>
          <p className="mb-1 text-xs text-slate-400">Firma de quien recibe</p>
          <FirmaDigital valor={firma} onCambio={setFirma} alto={160} />
        </div>

        <div className="flex items-center justify-end gap-2">
          {!firma && <span className="mr-auto text-[11px] text-amber-400">Falta la firma.</span>}
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            icon={PackageCheck}
            onClick={firmar}
            cargando={guardando}
            disabled={!firma}
          >
            Recibir {items.length} {items.length === 1 ? 'equipo' : 'equipos'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
