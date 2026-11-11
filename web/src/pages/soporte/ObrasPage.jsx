import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BarChart3, CheckCircle2, Hammer, Pencil, Plus, Undo2, XCircle } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { usePermisos } from '../../lib/AuthContext'
import { ESTADOS_OBRA, fmt } from '../../lib/obras'
import { Button, Card, ErrorBanner, Field, Modal, PedirMotivo, Select, SkeletonTabla, Tabs } from '../../components/ui'
import ObraForm from '../../components/obras/ObraForm'
import DetalleObra, { AvanceMetas, EncabezadoObra, useObra } from '../../components/obras/ObraDetalle'
import IndicadoresObras from '../../components/obras/IndicadoresObras'

/**
 * Las obras de red (migración 232): lo que construye MAZDA, medido como
 * construcción y no como tickets.
 *
 * La oficina crea la obra con su alcance, fecha meta y material; la cuadrilla
 * la reporta desde la app de campo; el jefe de grupo la entrega y acá se
 * aprueba o se devuelve. La pestaña Indicadores tiene los ocho números.
 */

const FILTROS = {
  abiertas: { label: 'Abiertas', estados: ['planificada', 'en_curso'] },
  revisar: { label: 'Por revisar', estados: ['entregada'] },
  cerradas: { label: 'Cerradas', estados: ['aprobada', 'cancelada'] },
  todas: { label: 'Todas', estados: null },
}

export default function ObrasPage() {
  const { puede } = usePermisos()
  const dirige = puede('soporte.obras')
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState(params.get('tab') === 'indicadores' ? 'indicadores' : 'obras')
  const [obras, setObras] = useState(null)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('abiertas')
  const [cuadrilla, setCuadrilla] = useState('')
  const [cuadrillas, setCuadrillas] = useState([])
  const [tecnicos, setTecnicos] = useState([])
  const [form, setForm] = useState(null) // { obra } | { desdeTicket } | {}
  const [abierta, setAbierta] = useState(null)

  const recargar = useCallback(async () => {
    const { data, error: e } = await supabase.from('v_obras_red').select('*').order('numero', { ascending: false })
    setError(e ?? null)
    setObras(e ? [] : (data ?? []))
  }, [])

  useEffect(() => {
    recargar()
    supabase
      .from('cuadrillas')
      .select('id,nombre')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setCuadrillas(data ?? []))
    supabase
      .from('tecnicos')
      .select('id,nombre')
      .eq('activo', true)
      .order('nombre')
      .then(({ data }) => setTecnicos(data ?? []))
  }, [recargar])

  // Desde Rutas: "Hace falta otro trabajo" → crear la obra para ese abonado.
  useEffect(() => {
    const tk = params.get('ticket')
    if (!tk || !dirige) return
    ;(async () => {
      const [{ data: t }, { data: vf }] = await Promise.all([
        supabase.from('tickets').select('id,numero,nombre,sector,direccion,latitud,longitud').eq('id', tk).maybeSingle(),
        supabase
          .from('visitas_fallidas')
          .select('detalle')
          .eq('ticket_id', tk)
          .order('creado_at', { ascending: false })
          .limit(1),
      ])
      if (t) setForm({ desdeTicket: { ...t, motivo: vf?.[0]?.detalle ?? null } })
      params.delete('ticket')
      setParams(params, { replace: true })
    })()
  }, [params, setParams, dirige])

  // Desde una notificación: /soporte/obras?obra=ID
  useEffect(() => {
    const o = params.get('obra')
    if (o) setAbierta(o)
  }, [params])

  const visibles = useMemo(() => {
    const est = FILTROS[filtro].estados
    return (obras ?? []).filter((o) => (!est || est.includes(o.estado)) && (!cuadrilla || o.cuadrilla_id === cuadrilla))
  }, [obras, filtro, cuadrilla])

  const porRevisar = (obras ?? []).filter((o) => o.estado === 'entregada').length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="t-titulo text-lg font-bold text-slate-100">Obras de red</h1>
          <p className="text-[12px] text-slate-500">
            Construcción y expansión: alcance, avance diario, NAP, material e indicadores de cada cuadrilla.
          </p>
        </div>
        {dirige && (
          <Button variante="primario" icon={Plus} onClick={() => setForm({})}>
            Nueva obra
          </Button>
        )}
      </div>

      <Tabs
        tabs={[
          { clave: 'obras', label: 'Obras', icon: Hammer, contador: porRevisar || null },
          { clave: 'indicadores', label: 'Indicadores', icon: BarChart3 },
        ]}
        activa={tab}
        onCambiar={setTab}
      />
      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {tab === 'indicadores' ? (
        <IndicadoresObras puedeConfigurar={dirige} onAbrirObra={setAbierta} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            {Object.entries(FILTROS).map(([k, f]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFiltro(k)}
                className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${
                  filtro === k ? 'border-sky-500 bg-sky-500/10 text-sky-400' : 'border-slate-700 text-slate-400'
                }`}
              >
                {f.label}
                {k === 'revisar' && porRevisar > 0 && ` (${porRevisar})`}
              </button>
            ))}
            <Field label="Cuadrilla" className="ml-auto w-48">
              <Select value={cuadrilla} onChange={(e) => setCuadrilla(e.target.value)}>
                <option value="">Todas</option>
                {cuadrillas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {obras === null ? (
            <SkeletonTabla filas={4} columnas={3} />
          ) : !visibles.length ? (
            <Card>
              <p className="p-6 text-center text-sm text-slate-500">
                {obras.length ? 'Ninguna obra con ese filtro.' : 'Todavía no hay obras. Creá la primera con "Nueva obra".'}
              </p>
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visibles.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setAbierta(o.id)}
                  className={`t-card space-y-3 border p-4 text-left ${
                    o.estado === 'entregada' ? 'border-amber-500/50' : o.atrasada ? 'border-rose-500/50' : 'border-transparent'
                  }`}
                >
                  <EncabezadoObra o={o} enlaceTicket={false} />
                  <AvanceMetas o={o} />
                  <p className="text-[11px] text-slate-500">
                    {o.dias_trabajados ? `${o.dias_trabajados} día(s) de trabajo` : 'Sin partes todavía'}
                    {o.ultimo_dia &&
                      ` · último parte ${new Date(`${o.ultimo_dia}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}`}
                    {o.naps_registradas ? ` · ${fmt(o.naps_registradas)} NAP registradas` : ''}
                  </p>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {form && (
        <ObraForm
          obra={form.obra}
          desdeTicket={form.desdeTicket}
          cuadrillas={cuadrillas}
          tecnicos={tecnicos}
          onCerrar={() => setForm(null)}
          onGuardada={(id) => {
            setForm(null)
            recargar()
            setAbierta(id)
          }}
        />
      )}

      {abierta && (
        <ObraAbierta
          id={abierta}
          dirige={dirige}
          onCerrar={() => {
            setAbierta(null)
            if (params.get('obra')) {
              params.delete('obra')
              setParams(params, { replace: true })
            }
          }}
          onEditar={(o) => {
            setAbierta(null)
            setForm({ obra: o })
          }}
          onCambio={recargar}
        />
      )}
    </div>
  )
}

function ObraAbierta({ id, dirige, onCerrar, onEditar, onCambio }) {
  const { d, recargar } = useObra(id)
  const [pedir, setPedir] = useState(null) // 'devolver' | 'cancelar'
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState(null)
  const o = d?.obra

  async function rpc(nombre, args) {
    setOcupado(true)
    setError(null)
    const { error: e } = await supabase.rpc(nombre, args)
    setOcupado(false)
    if (e) return setError(e)
    setPedir(null)
    await recargar()
    onCambio?.()
  }

  const abierta = o && ['planificada', 'en_curso', 'entregada'].includes(o.estado)

  return (
    <Modal abierto titulo={o ? `Obra #${o.numero}` : 'Obra'} onCerrar={onCerrar} ancho="max-w-3xl">
      {!d ? (
        <SkeletonTabla filas={4} columnas={2} />
      ) : !o ? (
        <p className="text-sm text-slate-500">No se encontró la obra.</p>
      ) : (
        <div className="space-y-4">
          <ErrorBanner error={error} onCerrar={() => setError(null)} />
          {dirige && abierta && (
            <div className="flex flex-wrap gap-2">
              {o.estado === 'entregada' && (
                <>
                  <Button
                    variante="primario"
                    icon={CheckCircle2}
                    cargando={ocupado}
                    onClick={() => rpc('revisar_obra', { p_id: o.id, p_aprobar: true, p_nota: null })}
                  >
                    Aprobar
                  </Button>
                  <Button icon={Undo2} onClick={() => setPedir('devolver')}>
                    Devolver con observación
                  </Button>
                </>
              )}
              {o.estado !== 'entregada' && (
                <Button icon={Pencil} onClick={() => onEditar(o)}>
                  Editar
                </Button>
              )}
              <Button variante="fantasma" icon={XCircle} onClick={() => setPedir('cancelar')}>
                Cancelar obra
              </Button>
            </div>
          )}
          {o.estado === 'entregada' && d.faltantes?.length > 0 && (
            <p className="text-[12px] text-amber-400">Ojo: {d.faltantes.join(' · ')}</p>
          )}
          <DetalleObra d={d} />
        </div>
      )}

      <PedirMotivo
        abierto={pedir === 'devolver'}
        titulo="Devolver la obra"
        etiquetaAccion="Devolver"
        variante="primario"
        ayuda="Le llega a la cuadrilla. Cuenta como devolución en los indicadores."
        sugerencias={['Falta foto de la manga', 'Potencia baja en una NAP: revisar', 'Falta rotular las cajas']}
        cargando={ocupado}
        onCancelar={() => setPedir(null)}
        onConfirmar={(m) => rpc('revisar_obra', { p_id: o.id, p_aprobar: false, p_nota: m })}
      />
      <PedirMotivo
        abierto={pedir === 'cancelar'}
        titulo="Cancelar la obra"
        etiquetaAccion="Cancelar obra"
        ayuda="Deja de contar en los indicadores."
        cargando={ocupado}
        onCancelar={() => setPedir(null)}
        onConfirmar={(m) => rpc('cancelar_obra', { p_id: o.id, p_motivo: m })}
      />
    </Modal>
  )
}
