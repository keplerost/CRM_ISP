import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Boxes, Check, FileSignature, FileText, PackageCheck } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { entregasApi } from '../../lib/entregas'
import { api } from '../../lib/apiNetwork'
import { abrirPdf } from '../../lib/pdf'
import FirmaDigital from '../../components/soporte/FirmaDigital'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Textarea } from '../../components/ui'

/**
 * Lo que tengo en la camioneta, y el acta para devolverlo.
 *
 * ── Por qué el equipo recuperado pasa por acá ──
 *
 * Porque hasta que alguien de la oficina lo recibe y firma, ese equipo es
 * responsabilidad del técnico. Antes el sistema lo anotaba en la bodega central
 * en el momento en que salía de la casa del abonado: el inventario decía que
 * había una ONT disponible cuando en realidad estaba en una camioneta, y si se
 * perdía en el camino no había registro de en manos de quién estaba.
 *
 * El acta es exactamente ese momento que faltaba.
 */
export default function EntregarEquiposPage() {
  const [equipos, setEquipos] = useState([])
  const [actas, setActas] = useState([])
  const [elegidos, setElegidos] = useState(() => new Set())
  const [notas, setNotas] = useState('')
  const [cargando, setCargando] = useState(true)
  const [creando, setCreando] = useState(false)
  const [error, setError] = useState(null)
  const [hecha, setHecha] = useState(null)
  const [firma, setFirma] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [eq, ac] = await Promise.all([entregasApi.miAlmacen(), entregasApi.mias()])
      setEquipos(eq)
      setActas(ac)
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  const alternar = (id) =>
    setElegidos((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  async function crear() {
    setCreando(true)
    setError(null)
    try {
      const acta = await entregasApi.crear([...elegidos], notas, firma)
      setElegidos(new Set())
      setNotas('')
      setFirma(null)
      setHecha(acta)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setCreando(false)
    }
  }

  const disponibles = equipos.filter((e) => !e.en_acta)

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-3">
      <div className="flex items-center gap-2">
        <Link to="/campo" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold text-slate-100">
            <Boxes size={18} className="text-sky-400" />
            Entregar equipos a la oficina
          </h1>
          <p className="text-xs text-slate-500">
            {disponibles.length === 0 ? 'No tenés equipos para entregar' : `${disponibles.length} en tu poder`}
          </p>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {hecha && (
        <Aviso>
          Acta <b>N° {hecha.numero}</b> generada. Mostrala en la oficina: quien la reciba tiene que
          firmarla, y recién ahí los equipos salen de tu inventario.
        </Aviso>
      )}

      {cargando ? (
        <Cargando />
      ) : (
        <>
          <Card title="Lo que tenés">
            {disponibles.length === 0 ? (
              <p className="text-xs text-slate-500">
                Tu almacén está vacío. Los equipos que recuperes de un abonado aparecen acá hasta que
                los entregues.
              </p>
            ) : (
              <div className="space-y-1.5">
                {disponibles.map((e) => (
                  <label
                    key={e.id}
                    className="flex cursor-pointer items-start gap-2 t-panel p-2 transition hover:border-slate-700"
                  >
                    <input
                      type="checkbox"
                      checked={elegidos.has(e.id)}
                      onChange={() => alternar(e.id)}
                      className="mt-0.5 accent-sky-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-slate-100">{e.serie ?? 'sin serie'}</span>
                        <span className="text-[11px] text-slate-500">{e.articulo}</span>
                      </div>
                      {e.recuperado_de && (
                        <p className="text-[11px] text-slate-500">
                          Recuperado de {e.recuperado_de}
                          {e.recuperado_en ? ` · ${String(e.recuperado_en).slice(0, 10)}` : ''}
                        </p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}

            {equipos.some((e) => e.en_acta) && (
              <p className="mt-2 text-[11px] text-slate-500">
                {equipos.filter((e) => e.en_acta).length} equipo(s) ya están en un acta esperando
                firma y no se pueden volver a entregar.
              </p>
            )}

            {elegidos.size > 0 && (
              <div className="mt-3 space-y-3 border-t border-slate-800 pt-3">
                <Textarea
                  rows={2}
                  value={notas}
                  onChange={(e) => setNotas(e.target.value)}
                  placeholder="Notas para quien recibe (opcional)"
                  className="text-xs"
                />

                {/* Tu firma va acá, al armar el acta, y no en un paso aparte:
                    hacer la lista de lo que entregás ES entregarlo. La otra
                    firma —la de quien recibe— se pone en la oficina, y recién
                    con las dos el acta prueba algo. */}
                <div>
                  <p className="mb-1 text-xs text-slate-400">Tu firma</p>
                  <FirmaDigital valor={firma} onCambio={setFirma} alto={140} />
                </div>

                <Button
                  variante="primario"
                  icon={FileSignature}
                  cargando={creando}
                  onClick={crear}
                  disabled={!firma}
                  className="w-full"
                >
                  {firma
                    ? `Generar acta con ${elegidos.size} ${elegidos.size === 1 ? 'equipo' : 'equipos'}`
                    : 'Firmá para generar el acta'}
                </Button>
              </div>
            )}
          </Card>

          {actas.length > 0 && (
            <Card title="Mis actas">
              <div className="space-y-1.5">
                {actas.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-2 t-panel px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-slate-200">
                        Acta N° {a.numero}
                        <span className="ml-2 text-[11px] text-slate-500">
                          {a.equipos} {a.equipos === 1 ? 'equipo' : 'equipos'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {new Date(a.creado_en).toLocaleString('es-EC')}
                        {a.recibe ? ` · recibió ${a.recibe}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {a.firmada ? (
                        <Badge color="verde">
                          <Check size={11} className="mr-1 inline" />
                          firmada por los dos
                        </Badge>
                      ) : (
                        <Badge color="ambar">esperando la oficina</Badge>
                      )}
                      <Button
                        variante="fantasma"
                        icon={FileText}
                        title="Ver el acta en PDF"
                        onClick={() => abrirPdf(() => api.actas.entrega(a.id))}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <p className="text-center text-[11px] text-slate-500">
            <PackageCheck size={12} className="mr-1 inline" />
            Los equipos salen de tu inventario recién cuando alguien de la oficina firma el acta.
          </p>
        </>
      )}
    </div>
  )
}
