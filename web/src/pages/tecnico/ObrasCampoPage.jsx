import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Hammer,
  LocateFixed,
  Package,
  RadioTower,
  Star,
} from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { hoyLocal, ubicacionActual } from '../../lib/soporte'
import { completarIngreso } from '../../lib/servicio'
import { METAS, fmt } from '../../lib/obras'
import { usePrepararIngreso } from '../../components/tecnico/IngresoGrupal'
import DetalleObra, { AvanceMetas, EncabezadoObra, useObra } from '../../components/obras/ObraDetalle'
import { subirFotoObra } from '../../components/obras/fotos'

/**
 * Las obras de mi cuadrilla (migración 232), en el celular.
 *
 * Lo que hace la cuadrilla en el poste, en cuatro botones:
 *
 *   · Parte del día   cuánto se tendió, cuántas NAP, fusiones y su pérdida,
 *                     con fotos, EPP e incidentes. El primero del día es el
 *                     ingreso, igual que el primer trabajo de un ticket.
 *   · Caja NAP        nombre, puertos, potencia, ubicación y foto. Queda en el
 *                     mapa de la red.
 *   · Material        lo que se usó, contra el presupuesto.
 *   · Entregar        el jefe de grupo, cuando no falta documentación.
 */

export default function ObrasCampoPage() {
  const [params] = useSearchParams()
  const [obras, setObras] = useState(null)

  const recargar = useCallback(async () => {
    const { data } = await supabase
      .from('v_obras_red')
      .select('*')
      .in('estado', ['planificada', 'en_curso', 'entregada'])
      .order('prioridad')
      .order('fecha_meta', { ascending: true, nullsFirst: false })
    setObras(data ?? [])
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const abrir = params.get('obra')

  if (obras === null) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-[#F6F8FB]" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <Hammer size={12} /> Obras de mi cuadrilla ({obras.length})
      </p>
      {!obras.length && (
        <div className="t-card p-6 text-center text-[13px] text-slate-500">
          No tenés obras asignadas. Cuando la oficina te asigne una, te llega a Notificaciones.
        </div>
      )}
      {obras.map((o) => (
        <ObraCampo key={o.id} fila={o} abiertaDeInicio={abrir === o.id} onCambio={recargar} />
      ))}
    </div>
  )
}

const BOTON =
  'flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-2.5 text-[12px] font-medium active:opacity-80'

function ObraCampo({ fila, abiertaDeInicio, onCambio }) {
  const [modo, setModo] = useState(null) // 'parte' | 'nap' | 'material' | 'entregar'
  const [verTodo, setVerTodo] = useState(abiertaDeInicio)
  const [hecho, setHecho] = useState(null)
  const { d, recargar } = useObra(verTodo || modo ? fila.id : null)
  const o = d?.obra ?? fila
  const abierta = ['planificada', 'en_curso'].includes(o.estado)

  async function listo(msg) {
    setModo(null)
    setHecho(msg)
    setTimeout(() => setHecho(null), 4000)
    await recargar()
    onCambio?.()
  }

  return (
    <article
      className={`t-card space-y-3 border p-3 ${
        o.estado === 'entregada' ? 'border-amber-500/40' : o.atrasada ? 'border-rose-500/50' : 'border-slate-700'
      }`}
    >
      <EncabezadoObra o={o} enlaceTicket={false} />
      {o.instrucciones && <p className="rounded-lg bg-sky-500/10 p-2 text-[12px] text-sky-200">{o.instrucciones}</p>}
      <AvanceMetas o={o} />

      {o.estado === 'entregada' && (
        <p className="text-[12px] text-amber-300">Entregada: la oficina la está revisando.</p>
      )}
      {hecho && (
        <p className="flex items-center gap-1.5 text-[12px] text-emerald-400">
          <CheckCircle2 size={14} /> {hecho}
        </p>
      )}

      {abierta && !modo && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <button type="button" onClick={() => setModo('parte')} className={`${BOTON} border-sky-500/50 text-sky-300`}>
              <ClipboardList size={14} /> Parte del día
            </button>
            <button type="button" onClick={() => setModo('nap')} className={`${BOTON} border-slate-700 text-slate-200`}>
              <RadioTower size={14} /> Caja NAP
            </button>
            <button type="button" onClick={() => setModo('material')} className={`${BOTON} border-slate-700 text-slate-200`}>
              <Package size={14} /> Material
            </button>
          </div>
          {o.puedo_entregar ? (
            <button
              type="button"
              onClick={() => setModo('entregar')}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-2.5 text-[13px] font-semibold text-white"
            >
              <CheckCircle2 size={14} /> Entregar la obra
            </button>
          ) : (
            <p className="text-[11px] text-slate-500">
              {o.jefe ? `La entrega el jefe de grupo: ${o.jefe}.` : 'La entrega el jefe de grupo.'}
            </p>
          )}
        </>
      )}

      {modo === 'parte' && <FormParte o={o} onCancelar={() => setModo(null)} onListo={() => listo('Parte enviado.')} />}
      {modo === 'nap' && <FormNap o={o} onCancelar={() => setModo(null)} onListo={() => listo('Caja registrada.')} />}
      {modo === 'material' && d && (
        <FormMaterial
          o={o}
          materiales={d.materiales}
          onCancelar={() => setModo(null)}
          onListo={(desc) => listo(desc ? 'Material cargado y descontado de tu almacén.' : 'Material cargado.')}
        />
      )}
      {modo === 'entregar' && d && (
        <FormEntregar
          o={o}
          faltantes={d.faltantes}
          onCancelar={() => setModo(null)}
          onListo={() => listo('Entregada. La oficina ya fue avisada.')}
        />
      )}

      <button
        type="button"
        onClick={() => setVerTodo((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-slate-500"
      >
        {verTodo ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Partes, NAP, material y bitácora
      </button>
      {verTodo && d?.obra && (
        <div className="border-t border-slate-800 pt-3">
          <DetalleObra d={d} enlaceTicket={false} />
        </div>
      )}
    </article>
  )
}

function Botones({ onCancelar, enviando, listo, etiqueta, verde = false }) {
  return (
    <div className="flex gap-2">
      <button type="button" onClick={onCancelar} className="flex-1 rounded-lg border border-slate-700 py-2 text-[13px] text-slate-300">
        Volver
      </button>
      <button
        type="submit"
        disabled={enviando || !listo}
        className={`flex-1 rounded-lg py-2 text-[13px] font-semibold text-white disabled:opacity-50 ${verde ? 'bg-emerald-600' : 'bg-sky-600'}`}
      >
        {enviando ? 'Enviando…' : etiqueta}
      </button>
    </div>
  )
}

const CAMPO = 'w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-[13px] text-slate-100'
const Etiqueta = ({ children }) => <span className="mb-0.5 block text-[11px] text-slate-400">{children}</span>

function ultimosDias(n) {
  const hoy = hoyLocal()
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(`${hoy}T12:00:00`)
    d.setDate(d.getDate() - i)
    return d.toISOString().slice(0, 10)
  })
}

function FormParte({ o, onCancelar, onListo }) {
  const prepararIngreso = usePrepararIngreso()
  const [f, setF] = useState({
    fecha: hoyLocal(),
    ...Object.fromEntries(METAS.map((m) => [m.clave, ''])),
    perdida_fusion_db: '',
    texto: '',
    epp_completo: true,
    incidente: false,
    incidente_nota: '',
  })
  const [fotos, setFotos] = useState([])
  // La misma clave en cada reintento: si el envío anterior llegó, no se duplica.
  const [clave] = useState(() => crypto.randomUUID())
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)
  const previas = useMemo(() => fotos.map((x) => URL.createObjectURL(x)), [fotos])
  useEffect(() => () => previas.forEach((u) => URL.revokeObjectURL(u)), [previas])

  const algo = METAS.some((m) => Number(f[m.clave]) > 0) || f.texto.trim()

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    try {
      let selfie = null
      if (f.fecha === hoyLocal()) {
        selfie = await prepararIngreso({ tipo: 'obra', id: o.id, lat: o.latitud ?? null, lng: o.longitud ?? null })
      }
      const rutas = []
      for (const foto of fotos) rutas.push(await subirFotoObra(o.id, foto, 'avance'))
      const pos = await ubicacionActual({ timeout: 8000 })
      const datos = {
        fecha: f.fecha,
        texto: f.texto.trim(),
        perdida_fusion_db: f.perdida_fusion_db === '' ? null : Number(f.perdida_fusion_db),
        epp_completo: f.epp_completo,
        incidente: f.incidente,
        incidente_nota: f.incidente_nota.trim(),
        fotos: rutas,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        ...Object.fromEntries(METAS.map((m) => [m.clave, Number(f[m.clave]) || 0])),
      }
      const { error: err } = await supabase.rpc('reportar_avance_obra', { p_obra: o.id, p_datos: datos, p_clave: clave })
      if (err) throw err
      await completarIngreso(selfie)
      onListo()
    } catch (err) {
      setError(err.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <form onSubmit={enviar} className="space-y-3 rounded-lg border border-sky-500/30 p-3">
      <label className="block">
        <Etiqueta>Día</Etiqueta>
        <select value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} className={CAMPO}>
          {ultimosDias(7).map((d, i) => (
            <option key={d} value={d}>
              {i === 0 ? 'Hoy' : i === 1 ? 'Ayer' : new Date(`${d}T12:00:00`).toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric' })}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-3 gap-2">
        {METAS.map((m) => (
          <label key={m.clave} className="block">
            <Etiqueta>
              {m.label}
              {m.unidad && ` (${m.unidad})`}
            </Etiqueta>
            <input
              type="number"
              min="0"
              step={m.clave === 'metros' ? 'any' : '1'}
              inputMode="decimal"
              value={f[m.clave]}
              onChange={(e) => setF({ ...f, [m.clave]: e.target.value })}
              className={CAMPO}
            />
          </label>
        ))}
      </div>
      {Number(f.fusiones) > 0 && (
        <label className="block">
          <Etiqueta>Pérdida promedio por fusión (dB), de la empalmadora</Etiqueta>
          <input
            type="number"
            min="0"
            max="5"
            step="0.01"
            inputMode="decimal"
            value={f.perdida_fusion_db}
            onChange={(e) => setF({ ...f, perdida_fusion_db: e.target.value })}
            placeholder="Ej.: 0.03"
            className={CAMPO}
          />
        </label>
      )}
      <label className="block">
        <Etiqueta>Qué se hizo o qué falta</Etiqueta>
        <textarea
          rows={2}
          value={f.texto}
          onChange={(e) => setF({ ...f, texto: e.target.value })}
          placeholder="Ej.: tendido del poste 14 al 22, falta subir la manga"
          className={CAMPO}
        />
      </label>

      <div>
        <Etiqueta>Fotos del trabajo (antes, durante, después)</Etiqueta>
        <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-600 py-2.5 text-[12px] text-slate-300">
          <Camera size={14} /> Agregar foto
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => {
              const nuevas = [...(e.target.files ?? [])]
              setFotos((xs) => [...xs, ...nuevas].slice(0, 8))
              e.target.value = ''
            }}
          />
        </label>
        {previas.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {previas.map((u, i) => (
              <button key={u} type="button" onClick={() => setFotos((xs) => xs.filter((_, j) => j !== i))} title="Quitar">
                <img src={u} alt="" className="h-14 w-14 rounded-lg object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-[12px] text-slate-200">
        <input type="checkbox" checked={f.epp_completo} onChange={(e) => setF({ ...f, epp_completo: e.target.checked })} />
        Todos con EPP completo (casco, arnés, guantes, chaleco)
      </label>
      <label className="flex items-center gap-2 text-[12px] text-slate-200">
        <input type="checkbox" checked={f.incidente} onChange={(e) => setF({ ...f, incidente: e.target.checked })} />
        Hubo un incidente de seguridad
      </label>
      {f.incidente && (
        <textarea
          rows={2}
          value={f.incidente_nota}
          onChange={(e) => setF({ ...f, incidente_nota: e.target.value })}
          placeholder="Qué pasó, quién, si hubo lesión"
          className={CAMPO}
        />
      )}
      {!fotos.length && <p className="text-[11px] text-amber-400">Sin fotos, la obra no se puede entregar: al menos un parte tiene que tener.</p>}
      {error && <p className="text-[12px] text-rose-400">{error}</p>}
      <Botones
        onCancelar={onCancelar}
        enviando={enviando}
        listo={algo && (!f.incidente || f.incidente_nota.trim())}
        etiqueta="Enviar parte"
      />
    </form>
  )
}

function FormNap({ o, onCancelar, onListo }) {
  const [f, setF] = useState({ nombre: '', puertos: '16', potencia: '' })
  const [pos, setPos] = useState(null)
  const [midiendo, setMidiendo] = useState(false)
  const [foto, setFoto] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)
  const previa = useMemo(() => (foto ? URL.createObjectURL(foto) : null), [foto])
  useEffect(() => () => previa && URL.revokeObjectURL(previa), [previa])

  async function medir() {
    setMidiendo(true)
    setPos(await ubicacionActual())
    setMidiendo(false)
  }
  useEffect(() => {
    medir()
  }, [])

  const pot = f.potencia === '' ? null : -Math.abs(Number(f.potencia))

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    try {
      const ruta = foto ? await subirFotoObra(o.id, foto, 'nap') : null
      const { error: err } = await supabase.rpc('registrar_nap_obra', {
        p_obra: o.id,
        p_nombre: f.nombre,
        p_lat: pos?.lat ?? null,
        p_lng: pos?.lng ?? null,
        p_puertos: Number(f.puertos) || null,
        p_potencia: pot,
        p_foto: ruta,
      })
      if (err) throw err
      onListo()
    } catch (err) {
      setError(err.message)
    } finally {
      setEnviando(false)
    }
  }

  return (
    <form onSubmit={enviar} className="space-y-3 rounded-lg border border-slate-700 p-3">
      <p className="text-[11px] text-slate-500">
        Si la caja ya estaba registrada con ese nombre, se actualiza: sirve para completarle la foto o la potencia.
      </p>
      <label className="block">
        <Etiqueta>Nombre de la caja, como está rotulada</Etiqueta>
        <input
          value={f.nombre}
          onChange={(e) => setF({ ...f, nombre: e.target.value })}
          placeholder="Ej.: NAP-MER-03"
          className={`${CAMPO} uppercase`}
          required
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <Etiqueta>Puertos</Etiqueta>
          <select value={f.puertos} onChange={(e) => setF({ ...f, puertos: e.target.value })} className={CAMPO}>
            {[4, 8, 16, 24, 32, 48].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Etiqueta>Potencia medida (dBm)</Etiqueta>
          <input
            type="number"
            step="0.01"
            inputMode="decimal"
            value={f.potencia}
            onChange={(e) => setF({ ...f, potencia: e.target.value })}
            placeholder="-19.50"
            className={CAMPO}
          />
        </label>
      </div>
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className={pos ? 'text-emerald-400' : 'text-amber-400'}>
          {midiendo
            ? 'Tomando la ubicación…'
            : pos
              ? `Ubicación tomada (±${Math.round(pos.precision ?? 0)} m)`
              : 'Sin ubicación: parate junto a la caja y volvé a tomarla'}
        </span>
        <button type="button" onClick={medir} className="flex items-center gap-1 text-sky-400">
          <LocateFixed size={13} /> Tomar de nuevo
        </button>
      </div>
      <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-600 py-2.5 text-[12px] text-slate-300">
        <Camera size={14} /> {foto ? 'Cambiar la foto' : 'Foto de la caja abierta'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => setFoto(e.target.files?.[0] ?? null)}
        />
      </label>
      {previa && <img src={previa} alt="" className="h-24 rounded-lg object-cover" />}
      {error && <p className="text-[12px] text-rose-400">{error}</p>}
      <Botones onCancelar={onCancelar} enviando={enviando} listo={f.nombre.trim()} etiqueta="Registrar caja" />
    </form>
  )
}

function FormMaterial({ o, materiales, onCancelar, onListo }) {
  const [linea, setLinea] = useState(materiales[0]?.id ?? 'otro')
  const [desc, setDesc] = useState('')
  const [unidad, setUnidad] = useState('u')
  const [cantidad, setCantidad] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)
  const m = materiales.find((x) => x.id === linea)

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    const { data, error: err } = await supabase.rpc('registrar_consumo_obra', {
      p_obra: o.id,
      p_material: m ? m.id : null,
      p_cantidad: Number(cantidad),
      p_descripcion: m ? null : desc,
      p_unidad: m ? null : unidad,
      p_articulo: null,
    })
    setEnviando(false)
    if (err) return setError(err.message)
    onListo(data?.descontado)
  }

  return (
    <form onSubmit={enviar} className="space-y-3 rounded-lg border border-slate-700 p-3">
      <label className="block">
        <Etiqueta>Material</Etiqueta>
        <select value={linea} onChange={(e) => setLinea(e.target.value)} className={CAMPO}>
          {materiales.map((x) => (
            <option key={x.id} value={x.id}>
              {x.descripcion} (presup. {fmt(x.presupuesto, 2)} {x.unidad})
            </option>
          ))}
          <option value="otro">Otro, no presupuestado</option>
        </select>
      </label>
      {!m && (
        <div className="grid grid-cols-3 gap-2">
          <label className="col-span-2 block">
            <Etiqueta>Qué material</Etiqueta>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} className={CAMPO} placeholder="Ej.: herraje tipo A" />
          </label>
          <label className="block">
            <Etiqueta>Unidad</Etiqueta>
            <input value={unidad} maxLength={10} onChange={(e) => setUnidad(e.target.value)} className={CAMPO} />
          </label>
        </div>
      )}
      <label className="block">
        <Etiqueta>Cantidad usada {m ? `(${m.unidad})` : ''}</Etiqueta>
        <input
          type="number"
          min="0"
          step="any"
          inputMode="decimal"
          value={cantidad}
          onChange={(e) => setCantidad(e.target.value)}
          className={CAMPO}
          required
        />
      </label>
      {error && <p className="text-[12px] text-rose-400">{error}</p>}
      <Botones
        onCancelar={onCancelar}
        enviando={enviando}
        listo={Number(cantidad) > 0 && (m || desc.trim())}
        etiqueta="Cargar material"
      />
    </form>
  )
}

function FormEntregar({ o, faltantes, onCancelar, onListo }) {
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)
  const falta = faltantes?.length > 0

  async function enviar(e) {
    e.preventDefault()
    setEnviando(true)
    setError(null)
    const { error: err } = await supabase.rpc('entregar_obra', { p_id: o.id, p_nota: nota.trim() })
    setEnviando(false)
    if (err) return setError(err.message)
    onListo()
  }

  return (
    <form onSubmit={enviar} className="space-y-3 rounded-lg border border-emerald-500/40 p-3">
      <p className="flex items-center gap-1.5 text-[12px] text-slate-300">
        <Star size={12} className="text-amber-400" /> La oficina la revisa: la aprueba o te la devuelve con lo que falte.
      </p>
      {falta ? (
        <div className="rounded-lg bg-amber-500/10 p-2 text-[12px] text-amber-300">
          <p className="font-semibold">Antes de entregar falta:</p>
          <ul className="mt-1 list-disc pl-4">
            {faltantes.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ) : (
        <textarea
          rows={3}
          autoFocus
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Cómo quedó: “tendido completo, 6 NAP con potencia entre -18 y -21 dBm”"
          className={CAMPO}
        />
      )}
      {error && <p className="text-[12px] text-rose-400">{error}</p>}
      <Botones onCancelar={onCancelar} enviando={enviando} listo={!falta && nota.trim()} etiqueta="Entregar" verde />
    </form>
  )
}
