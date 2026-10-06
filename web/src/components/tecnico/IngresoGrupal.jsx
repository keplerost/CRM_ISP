import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Camera, Check, MapPin, RefreshCw, Users } from 'lucide-react'

import { supabase } from '../../lib/supabaseClient'
import { useConfirmar } from '../../lib/confirmar'
import { prepararIngreso, sacarFoto } from '../../lib/servicio'
import { comprimirImagen, distanciaEnMetros, ubicacionActual, RADIO_LLEGADA_M } from '../../lib/soporte'
import { Button, Modal } from '../ui'

/**
 * La foto grupal en el sitio (migración 213).
 *
 * En el primer trabajo del día, el jefe de grupo:
 *
 *   1. Mide el GPS contra la ubicación del cliente. Lejos no puede seguir:
 *      la foto grupal prueba que la cuadrilla llegó AL SITIO, no que estaba
 *      junta en algún lado. La base lo vuelve a medir con la coordenada
 *      guardada; esto es para decírselo antes de que saque la foto.
 *   2. Marca quiénes están.
 *   3. Saca la foto con la cámara de atrás.
 *
 * A los marcados se les registra el ingreso con esa foto, esa hora y ese lugar.
 *
 * Es un proveedor y no un componente suelto porque la piden cuatro pantallas
 * (ticket, llegada a una instalación, lectura del equipo, reporte de una
 * reparación), y cada una lo hace desde la mitad de una función async.
 */

const Contexto = createContext(null)

export function IngresoGrupalProvider({ children }) {
  const [pedido, setPedido] = useState(null)
  const resolver = useRef(null)

  const pedir = useCallback(
    (datos) =>
      new Promise((resolve) => {
        resolver.current = resolve
        setPedido(datos)
      }),
    [],
  )

  const terminar = useCallback((hecho) => {
    setPedido(null)
    resolver.current?.(hecho)
    resolver.current = null
  }, [])

  return (
    <Contexto.Provider value={pedir}>
      {children}
      {pedido && <FotoGrupal datos={pedido} onTerminar={terminar} />}
    </Contexto.Provider>
  )
}

/**
 * `prepararIngreso(sitio)` con la confirmación y la foto grupal ya puestas.
 * `sitio` = { tipo, id, lat, lng } del trabajo que se está iniciando.
 */
export function usePrepararIngreso() {
  const confirmar = useConfirmar()
  const pedirGrupal = useContext(Contexto)
  return useCallback(
    (sitio) => prepararIngreso({ confirmar, pedirGrupal, sitio }),
    [confirmar, pedirGrupal],
  )
}

function FotoGrupal({ datos, onTerminar }) {
  const { sitio, integrantes = [] } = datos
  const tieneSitio = sitio?.lat != null && sitio?.lng != null

  const [pos, setPos] = useState(null)
  const [midiendo, setMidiendo] = useState(true)
  const [marcados, setMarcados] = useState(
    () => new Set(integrantes.filter((i) => !i.en_servicio).map((i) => i.id)),
  )
  const [foto, setFoto] = useState(null)
  const [previa, setPrevia] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState(null)

  const medir = useCallback(async () => {
    setMidiendo(true)
    setPos(await ubicacionActual())
    setMidiendo(false)
  }, [])

  useEffect(() => {
    medir()
  }, [medir])

  useEffect(() => {
    if (!foto) return setPrevia(null)
    const url = URL.createObjectURL(foto)
    setPrevia(url)
    return () => URL.revokeObjectURL(url)
  }, [foto])

  const distancia = pos && tieneSitio ? distanciaEnMetros(pos, { lat: Number(sitio.lat), lng: Number(sitio.lng) }) : null
  // La misma tolerancia que la base: el radio de llegada, más el error del GPS (hasta 100 m).
  const tolerancia = RADIO_LLEGADA_M + Math.min(Math.max(Math.round(pos?.precision ?? 0), 0), 100)
  const lejos = distancia != null && distancia > tolerancia
  const puede = pos && !lejos && foto && !enviando

  async function sacar() {
    // La de atrás: es una foto de la cuadrilla, no del jefe.
    const f = await sacarFoto('environment')
    if (f) setFoto(f)
  }

  async function marcar() {
    setEnviando(true)
    setError(null)
    try {
      const { data: id, error: err } = await supabase.rpc('ingreso_grupal', {
        p_presentes: [...marcados],
        p_sitio_tipo: sitio?.tipo ?? null,
        p_sitio_id: sitio?.id ?? null,
        p_lat: pos.lat,
        p_lng: pos.lng,
        p_precision: pos.precision != null ? Math.round(pos.precision) : null,
      })
      if (err) throw err

      // La foto, después: necesita el id para su carpeta. Si no sube, el
      // ingreso igual quedó marcado y la foto se reintenta desde el inicio.
      try {
        const blob = await comprimirImagen(foto)
        const ruta = `grupal/${id}/foto-${Date.now()}.jpg`
        const { error: errSubida } = await supabase.storage
          .from('jornadas')
          .upload(ruta, blob, { contentType: 'image/jpeg' })
        if (!errSubida) await supabase.rpc('foto_ingreso_grupal', { p_id: id, p_ruta: ruta })
      } catch {
        /* el ingreso ya está; la foto se sube después */
      }

      onTerminar(true)
    } catch (err) {
      setError(err.message)
      setEnviando(false)
    }
  }

  const alternar = (id) =>
    setMarcados((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Modal abierto titulo="Foto grupal en el sitio" onCerrar={() => onTerminar(false)}>
      <div className="space-y-4">
        <p className="text-[13px] text-slate-300">
          Es el primer trabajo del día. Tomá una foto de la cuadrilla en el sitio: marca el ingreso de
          los que están en ella, y sus horas cuentan desde ahora.
        </p>

        {/* 1. Dónde está */}
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-[13px] ${
            midiendo
              ? 'border-slate-700 text-slate-400'
              : !pos || lejos
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                : tieneSitio
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}
        >
          <MapPin size={15} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            {midiendo
              ? 'Midiendo tu ubicación…'
              : !pos
                ? 'No se pudo tomar la ubicación. Activá el GPS del teléfono: sin ubicación no se puede tomar la foto grupal.'
                : lejos
                  ? `Estás a ${distancia} m del cliente. La foto grupal se toma en el sitio: acercate y volvé a medir.`
                  : tieneSitio
                    ? `Estás en el sitio (a ${distancia} m del cliente).`
                    : 'Este trabajo no tiene la ubicación cargada: no se puede verificar el sitio. La foto queda registrada sin distancia.'}
          </div>
          {!midiendo && (!pos || lejos) && (
            <button type="button" onClick={medir} className="shrink-0 text-sky-400">
              <RefreshCw size={15} />
            </button>
          )}
        </div>

        {/* 2. Quiénes están */}
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <Users size={12} /> Quiénes están en la foto
          </p>
          <ul className="space-y-1">
            {integrantes.map((i) => (
              <li key={i.id}>
                <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-slate-200">
                  <input
                    type="checkbox"
                    checked={i.es_jefe || marcados.has(i.id)}
                    disabled={i.es_jefe || i.en_servicio}
                    onChange={() => alternar(i.id)}
                  />
                  <span className="flex-1">{i.nombre}</span>
                  {i.es_jefe && <span className="text-[11px] text-amber-400">jefe de grupo</span>}
                  {!i.es_jefe && i.en_servicio && (
                    <span className="text-[11px] text-emerald-400">ya marcó ingreso</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-slate-500">
            Quien no esté hoy marca su ingreso aparte, con su foto, al llegar a su primer trabajo.
          </p>
        </div>

        {/* 3. La foto */}
        <button
          type="button"
          onClick={sacar}
          disabled={!pos || lejos}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-slate-700 p-3 text-left disabled:opacity-40"
        >
          {previa ? (
            <img src={previa} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-lg bg-slate-800">
              <Camera size={22} className="text-slate-500" />
            </span>
          )}
          <span className="text-[13px] text-slate-300">
            {previa ? 'Tocá para sacarla de nuevo' : 'Sacar la foto grupal'}
          </span>
        </button>

        {error && <p className="text-[12px] text-rose-400">{error}</p>}

        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => onTerminar(false)}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            icon={Check}
            className="flex-1"
            onClick={marcar}
            cargando={enviando}
            disabled={!puede}
          >
            Marcar ingreso ({marcados.size})
          </Button>
        </div>
      </div>
    </Modal>
  )
}
