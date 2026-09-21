import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Minus, Package, Plus, Trash2 } from 'lucide-react'
import { usePermisos } from '../../lib/AuthContext'
import { inventarioApi } from '../../lib/inventario'
import { Aviso, Badge, Button, Cargando, Field, Select } from '../ui'

/**
 * El material que un técnico usó en un trabajo.
 *
 * Sirve para los dos trabajos que consumen material —una instalación nueva y la
 * reparación de un ticket— porque es exactamente el mismo problema: alguien
 * acaba de gastar cable y quiere descontarlo de lo que lleva encima, parado en
 * la vereda. Tenerlo dos veces significaría que la próxima corrección se aplica
 * en uno y se olvida en el otro.
 *
 * ── Por qué solo se ofrece lo que tiene ──
 *
 * La lista son SUS existencias, no el catálogo. Dejarlo elegir cualquier
 * artículo produciría consumos de material que nunca recibió, y su almacén
 * quedaría en negativo — un número que no significa nada y que después hay que
 * corregir a mano.
 *
 * `instalacionId` o `ticketId`: uno de los dos, nunca ambos. Es lo que después
 * permite preguntar "¿cuánto material se fue en garantías este mes?" separado de
 * lo que se fue en altas.
 */
export default function MaterialUsado({
  instalacionId,
  ticketId,
  serieSugerida,
  onError,
  onRegistrado,
  compacto = false,
}) {
  const { perfil } = usePermisos()

  const [almacen, setAlmacen] = useState(null)
  const [existencias, setExistencias] = useState([])
  const [equipos, setEquipos] = useState([])
  const [yaConsumido, setYaConsumido] = useState([])
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [lineas, setLineas] = useState([])

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      // Lo ya descontado por este trabajo. Sin esto, un técnico que recarga
      // porque se le cortó la señal vuelve a cargar todo y descuenta el doble.
      // En el celular, en la calle, eso no es hipotético.
      setYaConsumido(await inventarioApi.consumosDeTrabajo({ instalacionId, ticketId }))

      const mio = await inventarioApi.miAlmacen(perfil?.tecnico_id)
      setAlmacen(mio)
      if (mio) {
        const [ex, eq] = await Promise.all([
          inventarioApi.existencias(mio.id),
          inventarioApi.equipos({ almacenId: mio.id }),
        ])
        setExistencias(ex)
        setEquipos(eq.filter((q) => ['en_stock', 'asignado'].includes(q.estado)))
      }
    } catch (err) {
      onError?.(err)
    } finally {
      setCargando(false)
    }
  }, [instalacionId, ticketId, perfil, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  /**
   * Si el equipo leído en el trabajo está en su almacén, se propone solo.
   *
   * Es el olvido más caro: la ONT queda descontada del stock del técnico para
   * siempre y nadie sabe en qué casa terminó.
   */
  const sugerido = useMemo(() => {
    if (!serieSugerida) return null
    const sn = String(serieSugerida).trim().toUpperCase()
    return equipos.find((q) => String(q.serie).toUpperCase() === sn) ?? null
  }, [serieSugerida, equipos])

  const yaEnLista = (id) => lineas.some((l) => l.equipoIds?.includes(id))
  const yaDescontado = (id) => yaConsumido.some((c) => c.equipo_id === id)

  const agregarEquipo = (q) =>
    setLineas((ls) => [
      ...ls,
      {
        clave: `eq-${q.id}`,
        articuloId: q.articulo_id,
        etiqueta: `${q.articulo} · ${q.serie}`,
        equipoIds: [q.id],
      },
    ])

  const agregarMaterial = (e) =>
    setLineas((ls) => [
      ...ls,
      {
        clave: `mat-${e.articulo_id}`,
        articuloId: e.articulo_id,
        etiqueta: e.articulo,
        unidad: e.unidad,
        disponible: Number(e.cantidad),
        cantidad: 1,
      },
    ])

  const registrar = async () => {
    setGuardando(true)
    onError?.(null)
    try {
      await inventarioApi.registrarConsumo(
        { instalacionId, ticketId, almacenId: almacen.id, lineas },
        perfil,
      )
      setLineas([])
      await recargar()
      await onRegistrado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando texto="Cargando tu almacén…" />

  if (!almacen) {
    // En el ticket esto sería ruido: la mayoría de quienes lo abren no son
    // técnicos, y no tiene sentido explicarles cómo vincularse a uno.
    if (compacto) return null
    return (
      <Aviso tipo="alerta">
        Tu usuario no tiene un almacén asignado, así que el material no se puede descontar solo.
        Podés seguir; el consumo lo va a tener que cargar bodega a mano. Para que se descuente solo,
        pedile a un administrador que te vincule a un técnico en{' '}
        <b>Ajustes → Gestión de personal</b>.
      </Aviso>
    )
  }

  const disponiblesMaterial = existencias.filter(
    (e) => !lineas.some((l) => l.articuloId === e.articulo_id && !l.equipoIds),
  )
  const disponiblesEquipo = equipos.filter((q) => !yaEnLista(q.id) && !yaDescontado(q.id))
  const excedido = lineas.some(
    (l) => !l.equipoIds && Number(l.cantidad) > (l.disponible ?? 0),
  )

  return (
    <div className="space-y-4">
      {yaConsumido.length > 0 && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-emerald-300">
            <Check size={15} /> Ya descontado de tu almacén
          </div>
          <div className="space-y-1">
            {yaConsumido.map((c) => (
              <div key={c.id} className="flex justify-between text-[13px]">
                <span className="text-slate-300">
                  {c.articulo}
                  {c.serie ? ` · ${c.serie}` : ''}
                </span>
                <span className="tabular-nums text-slate-400">
                  {Number(c.cantidad).toLocaleString('es-EC')} {c.unidad}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Esto ya salió de tu stock. Si te equivocaste, no lo cargues de nuevo: avisale a bodega
            para que haga el ajuste.
          </p>
        </div>
      )}

      {sugerido && !yaEnLista(sugerido.id) && !yaDescontado(sugerido.id) && (
        <Aviso>
          El equipo que leíste (<b>{sugerido.serie}</b>) está en tu almacén.{' '}
          <button
            type="button"
            className="font-medium text-sky-300 underline"
            onClick={() => agregarEquipo(sugerido)}
          >
            Agregarlo al consumo
          </button>
        </Aviso>
      )}

      <div>
        {!compacto && (
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
            <Package size={16} /> Material usado
          </h3>
        )}

        {lineas.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 py-5 text-center text-[13px] text-slate-500">
            {yaConsumido.length
              ? 'Agregá más si usaste otra cosa.'
              : 'Si no usaste material, dejalo vacío.'}
          </p>
        ) : (
          <div className="space-y-1.5">
            {lineas.map((l, i) => (
              <div
                key={l.clave}
                className="flex items-center gap-2 t-card-sm p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-slate-100">{l.etiqueta}</div>
                  {l.disponible != null && (
                    <div className="text-[11px] text-slate-500">
                      tenés {l.disponible} {l.unidad}
                    </div>
                  )}
                </div>

                {l.equipoIds ? (
                  <Badge color="azul">1 equipo</Badge>
                ) : (
                  // Botones grandes y no solo un campo: esto se usa en la calle,
                  // con guantes, y el teclado numérico del celular tapa media
                  // pantalla.
                  <div className="flex items-center gap-1">
                    <Button
                      variante="fantasma"
                      icon={Minus}
                      onClick={() => {
                        const ls = [...lineas]
                        ls[i] = { ...l, cantidad: Math.max(1, Number(l.cantidad) - 1) }
                        setLineas(ls)
                      }}
                    />
                    <input
                      value={l.cantidad}
                      onChange={(e) => {
                        const ls = [...lineas]
                        ls[i] = { ...l, cantidad: e.target.value }
                        setLineas(ls)
                      }}
                      inputMode="decimal"
                      className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-center text-sm text-slate-100"
                    />
                    <Button
                      variante="fantasma"
                      icon={Plus}
                      onClick={() => {
                        const ls = [...lineas]
                        ls[i] = { ...l, cantidad: Number(l.cantidad) + 1 }
                        setLineas(ls)
                      }}
                    />
                    <span className="w-8 text-[12px] text-slate-500">{l.unidad}</span>
                  </div>
                )}

                <Button
                  variante="fantasma"
                  icon={Trash2}
                  onClick={() => setLineas(lineas.filter((_, x) => x !== i))}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Agregar equipo con serie">
          <Select
            value=""
            onChange={(e) => {
              const q = equipos.find((x) => x.id === e.target.value)
              if (q) agregarEquipo(q)
            }}
          >
            <option value="">
              {disponiblesEquipo.length ? '— elegí el equipo —' : 'No te queda ninguno'}
            </option>
            {disponiblesEquipo.map((q) => (
              <option key={q.id} value={q.id}>
                {q.articulo} · {q.serie}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Agregar material">
          <Select
            value=""
            onChange={(e) => {
              const ex = existencias.find((x) => x.articulo_id === e.target.value)
              if (ex) agregarMaterial(ex)
            }}
          >
            <option value="">
              {disponiblesMaterial.length ? '— elegí el material —' : 'No te queda material'}
            </option>
            {disponiblesMaterial.map((ex) => (
              <option key={ex.articulo_id} value={ex.articulo_id}>
                {ex.articulo} ({ex.cantidad} {ex.unidad})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* No deja descontar más de lo que tiene: un almacén personal en negativo
          no significa nada y hay que ir a corregirlo a mano. */}
      {excedido && (
        <Aviso tipo="alerta">
          Estás cargando más cantidad de la que tenés asignada. Corregí el número, o pedile a bodega
          que te transfiera lo que falta.
        </Aviso>
      )}

      <Button
        variante="primario"
        className="w-full"
        cargando={guardando}
        disabled={
          guardando ||
          lineas.length === 0 ||
          excedido ||
          lineas.some((l) => !l.equipoIds && !(Number(l.cantidad) > 0))
        }
        onClick={registrar}
      >
        Descontar de mi almacén
      </Button>
    </div>
  )
}
