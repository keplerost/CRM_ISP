import { useCallback, useEffect, useState } from 'react'
import { Backpack, PackageMinus, Undo2 } from 'lucide-react'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
  SkeletonTabla,
  Stat,
  Table,
} from '../../components/ui'
import { usePermisos } from '../../lib/AuthContext'
import { ESTADOS_EQUIPO, inventarioApi } from '../../lib/inventario'

/**
 * Mi almacén — lo que el técnico lleva encima.
 *
 * ── Por qué el técnico tiene su propia pantalla y no la de bodega ──
 *
 * Bodega necesita ver los veinte almacenes y comparar. El técnico necesita ver
 * uno: el suyo. Darle la pantalla de bodega significa que cada vez que quiere
 * saber si le quedan conectores tiene que filtrar por su nombre entre veinte
 * opciones, parado en una vereda con el celular en una mano.
 *
 * Y hay algo más importante: acá **devuelve** lo que no usó. Sin un lugar
 * evidente para devolver, el material sobrante se queda en la camioneta y el
 * inventario dice que se consumió. Esa es la fuga real de un ISP, no el robo.
 */
export default function MiAlmacenPage() {
  const { perfil } = usePermisos()

  const [almacen, setAlmacen] = useState(null)
  const [existencias, setExistencias] = useState([])
  const [equipos, setEquipos] = useState([])
  const [almacenes, setAlmacenes] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [devolviendo, setDevolviendo] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const mio = await inventarioApi.miAlmacen(perfil?.tecnico_id)
      setAlmacen(mio)

      if (mio) {
        const [ex, eq, cat] = await Promise.all([
          inventarioApi.existencias(mio.id),
          inventarioApi.equipos({ almacenId: mio.id }),
          inventarioApi.catalogo(),
        ])
        setExistencias(ex)
        setEquipos(eq)
        // Solo las bodegas: un técnico devuelve a bodega, no le pasa material a
        // otro técnico por su cuenta — eso lo despacha quien lleva el control.
        setAlmacenes(cat.almacenes.filter((a) => a.tipo !== 'tecnico'))
      }
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [perfil])

  useEffect(() => {
    recargar()
  }, [recargar])

  // Sin técnico vinculado no hay almacén posible. Es el mismo campo del que
  // dependen sus tickets asignados, así que el aviso apunta a donde se arregla.
  if (!cargando && !perfil?.tecnico_id) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Aviso tipo="alerta">
          Tu usuario no está vinculado a un técnico, así que todavía no tiene almacén. Pedile a un
          administrador que te vincule en <b>Ajustes → Gestión de personal</b>, en el campo "Técnico
          vinculado".
        </Aviso>
      </div>
    )
  }

  if (!cargando && !almacen) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Aviso tipo="alerta">
          Todavía no se creó tu almacén. Se crean solos al correr la migración de inventario para
          los técnicos activos; si sos nuevo, pedile a bodega que te lo dé de alta.
        </Aviso>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
          <Backpack size={20} className="text-sky-400" />
          Mi almacén
        </h1>
        <p className="text-sm text-slate-400">
          {almacen?.nombre} — el material que tenés asignado y todavía no usaste.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Artículos distintos" valor={existencias.length} />
        <Stat
          label="Equipos con serie"
          valor={equipos.filter((q) => ['en_stock', 'asignado'].includes(q.estado)).length}
          color="text-sky-400"
        />
        <Stat label="Instalados por vos" valor={equipos.filter((q) => q.estado === 'instalado').length} />
      </div>

      <Card
        title="Material"
        subtitle="Lo que se descuenta solo cuando cerrás una instalación"
      >
        {cargando ? (
          <SkeletonTabla filas={4} columnas={3} />
        ) : (
          <Table
            columnas={['Artículo', 'Cantidad', '']}
            filas={existencias}
            vacio="No tenés material asignado. Pedíselo a bodega."
            renderFila={(e) => (
              <tr key={e.articulo_id} className="hover:bg-slate-800/40">
                <td className="px-3 py-2 text-slate-200">{e.articulo}</td>
                <td className="px-3 py-2 tabular-nums text-slate-100">
                  {Number(e.cantidad).toLocaleString('es-EC')} {e.unidad}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variante="fantasma"
                    icon={Undo2}
                    onClick={() =>
                      setDevolviendo({
                        articuloId: e.articulo_id,
                        articulo: e,
                        cantidad: '',
                        destino: almacenes[0]?.id ?? '',
                        equipoIds: [],
                      })
                    }
                  >
                    Devolver
                  </Button>
                </td>
              </tr>
            )}
          />
        )}
      </Card>

      <Card title="Equipos que tenés" subtitle="ONT y routers asignados a tu nombre">
        {cargando ? (
          <SkeletonTabla filas={4} columnas={3} />
        ) : (
          <Table
            columnas={['Serie', 'Artículo', 'Estado', 'Cliente']}
            filas={equipos}
            vacio="Sin equipos asignados."
            renderFila={(q) => (
              <tr key={q.id} className="hover:bg-slate-800/40">
                <td className="px-3 py-2 font-mono text-[12px] text-slate-100">{q.serie}</td>
                <td className="px-3 py-2 text-slate-300">{q.articulo}</td>
                <td className="px-3 py-2">
                  <Badge color={ESTADOS_EQUIPO[q.estado]?.color ?? 'gris'}>
                    {ESTADOS_EQUIPO[q.estado]?.label ?? q.estado}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-[12px] text-slate-400">{q.cliente ?? '—'}</td>
              </tr>
            )}
          />
        )}
      </Card>

      <Modal
        abierto={!!devolviendo}
        titulo={`Devolver ${devolviendo?.articulo?.articulo ?? ''}`}
        onCerrar={() => setDevolviendo(null)}
      >
        {devolviendo && (
          <div className="space-y-3">
            <Aviso>
              Lo que devolvés vuelve al stock de bodega. Devolver lo que sobró es lo que hace que el
              inventario cuadre: si se queda en la camioneta, el sistema lo da por consumido.
            </Aviso>
            <Field label="Devolver a">
              <Select
                value={devolviendo.destino}
                onChange={(e) => setDevolviendo({ ...devolviendo, destino: e.target.value })}
              >
                {almacenes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Cantidad (${devolviendo.articulo?.unidad ?? 'u'})`}>
              <Input
                type="number"
                step="0.01"
                max={devolviendo.articulo?.cantidad}
                value={devolviendo.cantidad}
                onChange={(e) => setDevolviendo({ ...devolviendo, cantidad: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variante="fantasma" onClick={() => setDevolviendo(null)}>
                Cancelar
              </Button>
              <Button
                disabled={
                  !devolviendo.cantidad ||
                  Number(devolviendo.cantidad) <= 0 ||
                  Number(devolviendo.cantidad) > Number(devolviendo.articulo?.cantidad ?? 0)
                }
                onClick={async () => {
                  try {
                    await inventarioApi.mover(
                      {
                        tipo: 'transferencia',
                        articuloId: devolviendo.articuloId,
                        cantidad: devolviendo.cantidad,
                        origen: almacen.id,
                        destino: devolviendo.destino,
                        motivo: 'Devolución del técnico',
                      },
                      perfil,
                    )
                    setDevolviendo(null)
                    await recargar()
                  } catch (err) {
                    setError(err)
                  }
                }}
              >
                Devolver
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
