import { useCallback, useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { ArrowLeft, Download, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { supabase } from '../../lib/supabaseClient'
import {
  Aviso,
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  Select,
  SkeletonTabla,
  Table,
  Textarea,
} from '../../components/ui'

/**
 * Tipos de ONU — el catálogo de modelos de equipo.
 *
 * Es global y no por OLT: un EG8145V5 tiene cuatro puertos y dos SSIDs cuelgue
 * de donde cuelgue. Tenerlo por equipo obligaría a cargar lo mismo tantas veces
 * como OLTs haya, y a que las copias se contradigan.
 *
 * Lo que se carga acá decide tres cosas:
 *
 *   al autorizar     qué service-profile se propone para ese modelo
 *   por TR069        qué nodos del árbol existen y se pueden pedir
 *   ficha manual     si el equipo tiene WiFi y cuántas redes — para no mandar
 *                    al técnico a configurar algo que no existe
 */

const CANALES = ['GPON', 'XG-PON', 'XGS-PON']
const NUMEROS = [0, 1, 2, 4, 8]

const VACIO = {
  imagen_url: null,
  marca: '',
  modelo: '',
  pon_tipo: 'GPON',
  canales: ['GPON'],
  puertos_ethernet: 4,
  wifi_ssids: 0,
  puertos_fxs: 0,
  catv: 0,
  perfiles_propios: true,
  perfil_default_id: '',
  capacidad: 'bridging_routing',
  prefijo_eth: 'eth_0/',
  prefijo_wifi: 'wifi_0/',
  prefijo_voip: 'pots_0/',
  vendor_id: '',
  version_spec: '',
  soporta_tr069: '',
  notas: '',
}

export default function TiposOnuPage() {
  const confirmar = useConfirmar()
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [editando, setEditando] = useState(null) // null | {} | fila
  const [planes, setPlanes] = useState([])
  const [importacion, setImportacion] = useState(null)
  const [importando, setImportando] = useState(false)

  const leer = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      setDatos(await api.tiposOnu.listar())
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    leer()
    supabase
      .from('planes_velocidad')
      .select('id, nombre, bajada_kbps')
      .eq('activo', true)
      .order('bajada_kbps')
      .then(({ data }) => setPlanes(data ?? []))
  }, [leer])

  if (editando) {
    return (
      <Formulario
        tipo={editando}
        planes={planes}
        onListo={() => {
          setEditando(null)
          leer()
        }}
        onCancelar={() => setEditando(null)}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Tipos de ONU</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Los modelos de equipo que usa el ISP, para todas las OLTs. Definen qué se le propone al
          autorizar, qué se le puede pedir por TR069 y qué tiene que configurar el técnico cuando el
          equipo no acepta configuración remota.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {datos === null ? (
        <SkeletonTabla filas={6} columnas={8} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button variante="primario" icon={Plus} onClick={() => setEditando({ ...VACIO })}>
              Agregar tipo
            </Button>
            {/* Los equipos ya dijeron qué son. Empezar de cero cargando treinta
                modelos a mano cuando la base ya los tiene anotados es trabajo
                que no hace falta. */}
            <Button
              icon={Download}
              cargando={importando}
              onClick={async () => {
                setImportando(true)
                setError(null)
                try {
                  setImportacion(await api.tiposOnu.importar({ aplicar: false }))
                } catch (err) {
                  setError(err)
                } finally {
                  setImportando(false)
                }
              }}
            >
              Traer los que reportaron las ONUs
            </Button>
            <span className="flex-1" />
            <span className="text-xs text-slate-500">
              {datos.resumen.total} modelos · {datos.resumen.en_uso} en uso ·{' '}
              {datos.resumen.sin_probar} sin saber si aceptan TR069
            </span>
            <Button variante="fantasma" icon={RefreshCw} cargando={cargando} onClick={leer}>
              Releer
            </Button>
          </div>

          {importacion && (
            <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
              <p className="text-sm font-semibold text-sky-200">
                {importacion.total} modelo(s) que las ONUs reportaron y no están cargados
              </p>
              {importacion.total === 0 ? (
                <p className="text-xs text-slate-400">Están todos cargados.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {importacion.propuestas.map((p) => (
                    <span key={p.modelo} className="rounded bg-slate-800 px-2 py-1 text-xs">
                      <span className="font-mono text-slate-100">{p.modelo}</span>
                      <span className="ml-1 text-slate-500">
                        {p.marca} · {p.onus} ONU{p.onus === 1 ? '' : 's'}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[11px] leading-snug text-slate-500">
                Se crean con los valores por defecto: cuántos puertos y si tiene WiFi no lo puede
                saber el sistema, hay que completarlo. Igual es mucho menos trabajo que cargarlos
                todos.
              </p>
              <div className="flex gap-2">
                <Button
                  variante="primario"
                  icon={Download}
                  cargando={importando}
                  disabled={!importacion.total}
                  onClick={async () => {
                    setImportando(true)
                    try {
                      await api.tiposOnu.importar({ aplicar: true })
                      setImportacion(null)
                      await leer()
                    } catch (err) {
                      setError(err)
                    } finally {
                      setImportando(false)
                    }
                  }}
                >
                  Crear {importacion.total}
                </Button>
                <Button variante="fantasma" onClick={() => setImportacion(null)}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          <Card>
            <Table
              columnas={[
                'PON',
                'Canales',
                'Modelo',
                'ONUs',
                'Ethernet',
                'WiFi',
                'VoIP',
                'CATV',
                'Perfiles propios',
                'Capacidad',
                'TR069',
                '',
              ]}
              filas={datos.tipos}
              vacio="Todavía no hay ningún modelo cargado."
              renderFila={(t) => (
                <tr key={t.id} className="text-slate-300">
                  <td className="px-3 py-2 text-xs">{t.pon_tipo}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">
                    {(t.canales ?? []).join(' ')}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {t.imagen_url ? (
                        <img
                          src={t.imagen_url}
                          alt={t.modelo}
                          className="h-8 w-12 shrink-0 rounded border border-slate-800 bg-slate-900 object-contain"
                        />
                      ) : (
                        <span className="h-8 w-12 shrink-0 rounded border border-dashed border-slate-800" />
                      )}
                      <span className="min-w-0">
                        <button
                          type="button"
                          onClick={() => setEditando(t)}
                          className="block truncate text-left text-sm font-medium text-sky-300 hover:underline"
                        >
                          {t.modelo}
                        </button>
                        <span className="block text-[11px] text-slate-500">{t.marca}</span>
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {t.onus > 0 ? (
                      <span className="text-sky-300">{t.onus}</span>
                    ) : (
                      <span className="text-slate-600">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm">{t.puertos_ethernet}</td>
                  <td className="px-3 py-2 text-sm">{t.wifi_ssids}</td>
                  <td className="px-3 py-2 text-sm">{t.puertos_fxs}</td>
                  <td className="px-3 py-2 text-sm">{t.catv}</td>
                  <td className="px-3 py-2 text-xs">
                    {t.perfiles_propios ? 'Sí' : <span className="text-slate-600">No</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {t.capacidad === 'bridging' ? 'Bridging' : 'Bridging / Routing'}
                  </td>
                  {/* Los tres estados se distinguen: "no se sabe" no es "no
                      soporta". Con el primero se intenta igual y se aprende. */}
                  <td className="px-3 py-2 text-xs">
                    {t.soporta_tr069 == null ? (
                      <span className="text-slate-600">sin probar</span>
                    ) : t.soporta_tr069 ? (
                      <Badge color="verde">sí</Badge>
                    ) : (
                      <Badge color="ambar">no</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variante="fantasma"
                      icon={Trash2}
                      onClick={async () => {
                        const texto = t.onus
                          ? `${t.marca} ${t.modelo} lo usan ${t.onus} ONUs. Borrarlo las deja sin modelo. ¿Seguir?`
                          : `¿Borrar ${t.marca} ${t.modelo}?`
                        if (!await confirmar(texto)) return
                        setError(null)
                        try {
                          await api.tiposOnu.borrar(t.id, t.onus > 0)
                          await leer()
                        } catch (err) {
                          setError(err)
                        }
                      }}
                    />
                  </td>
                </tr>
              )}
            />
          </Card>
        </>
      )}
    </div>
  )
}

function Formulario({ tipo, planes, onListo, onCancelar }) {
  const [form, setForm] = useState({ ...VACIO, ...tipo, canales: tipo.canales ?? ['GPON'] })
  const [avanzado, setAvanzado] = useState(false)
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [subiendo, setSubiendo] = useState(false)

  /**
   * Sube la foto al bucket y guarda su URL.
   *
   * El nombre del archivo lleva el momento: reemplazar la foto de un modelo con
   * el mismo nombre dejaría la vieja cacheada en el navegador de todos, y
   * nadie entendería por qué sigue viéndose la anterior.
   */
  async function subirImagen(e) {
    const archivo = e.target.files?.[0]
    if (!archivo) return

    // El límite lo tiene también el bucket, pero rechazarlo acá evita subir dos
    // megas por una red de celular para que el servidor lo rechace al final.
    if (archivo.size > 2 * 1024 * 1024) {
      return setError(new Error(`La imagen pesa ${Math.round(archivo.size / 1024)} KB y el máximo es 2 MB.`))
    }

    setSubiendo(true)
    setError(null)
    try {
      const ext = archivo.name.split('.').pop()?.toLowerCase() || 'png'
      const limpio = (form.modelo || 'modelo').replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 40)
      const ruta = `${limpio}-${Date.now()}.${ext}`

      const { error: err } = await supabase.storage
        .from('tipos-onu')
        .upload(ruta, archivo, { contentType: archivo.type, upsert: true })
      if (err) throw err

      const { data } = supabase.storage.from('tipos-onu').getPublicUrl(ruta)
      setForm((f) => ({ ...f, imagen_url: data.publicUrl }))
    } catch (err) {
      setError(err)
    } finally {
      setSubiendo(false)
      e.target.value = ''
    }
  }

  const set = (campo) => (e) =>
    setForm((f) => ({
      ...f,
      [campo]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }))

  const alternarCanal = (canal) =>
    setForm((f) => ({
      ...f,
      canales: f.canales.includes(canal)
        ? f.canales.filter((c) => c !== canal)
        : [...f.canales, canal],
    }))

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      const cuerpo = {
        ...form,
        soporta_tr069: form.soporta_tr069 === '' ? null : form.soporta_tr069 === 'si',
        perfil_default_id: form.perfil_default_id || null,
      }
      if (tipo.id) await api.tiposOnu.editar(tipo.id, cuerpo)
      else await api.tiposOnu.crear(cuerpo)
      onListo()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-4">
      <Button type="button" variante="fantasma" icon={ArrowLeft} onClick={onCancelar}>
        Volver al listado
      </Button>

      <h1 className="t-titulo text-lg font-bold text-slate-100">
        {tipo.id ? `${tipo.marca} ${tipo.modelo}` : 'Nuevo tipo de ONU'}
      </h1>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Modelo" hint="tal como lo reporta el equipo">
            <Input value={form.modelo} onChange={set('modelo')} placeholder="EG8145V5" required />
          </Field>
          <Field label="Marca">
            <Input value={form.marca} onChange={set('marca')} placeholder="Huawei" />
          </Field>

          <Field label="Tecnología">
            <div className="flex gap-4 pt-1.5">
              {['GPON', 'EPON'].map((v) => (
                <label key={v} className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input
                    type="radio"
                    checked={form.pon_tipo === v}
                    onChange={() => setForm((f) => ({ ...f, pon_tipo: v }))}
                  />
                  {v}
                </label>
              ))}
            </div>
          </Field>

          <Field
            label="Canales que soporta"
            hint="al autorizar se usa el primero que el equipo tenga"
          >
            <div className="flex flex-wrap gap-3 pt-1.5">
              {CANALES.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={form.canales.includes(c)}
                    onChange={() => alternarCanal(c)}
                  />
                  {c}
                </label>
              ))}
            </div>
          </Field>

          <Field label="Puertos Ethernet">
            <Select value={form.puertos_ethernet} onChange={set('puertos_ethernet')}>
              {NUMEROS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>

          {/* Cuántas redes, no "tiene WiFi": una ONT de una banda y una de dos
              se configuran distinto, y el técnico necesita saber cuántas. */}
          <Field label="Redes WiFi" hint="cuántos SSIDs configurables">
            <Select value={form.wifi_ssids} onChange={set('wifi_ssids')}>
              {[0, 1, 2, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Puertos VoIP">
            <Select value={form.puertos_fxs} onChange={set('puertos_fxs')}>
              {[0, 1, 2].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Salidas CATV">
            <Select value={form.catv} onChange={set('catv')}>
              {[0, 1].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Capacidad"
            hint="bridging = el PPPoE lo hace el router del abonado"
            className="sm:col-span-2"
          >
            <div className="flex flex-wrap gap-4 pt-1.5">
              {[
                ['bridging', 'Bridging'],
                ['bridging_routing', 'Bridging / Routing'],
              ].map(([v, label]) => (
                <label key={v} className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input
                    type="radio"
                    checked={form.capacidad === v}
                    onChange={() => setForm((f) => ({ ...f, capacidad: v }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </Field>

          <Field label="Perfiles de velocidad propios">
            <label className="flex items-center gap-2 pt-1.5 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={form.perfiles_propios}
                onChange={set('perfiles_propios')}
              />
              Acepta perfiles personalizados
            </label>
          </Field>

          <Field label="Plan por defecto" hint="el que se propone al autorizar una de estas">
            <Select value={form.perfil_default_id ?? ''} onChange={set('perfil_default_id')}>
              <option value="">— ninguno —</option>
              {planes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </Select>
          </Field>

          {/* Tres estados. "Sin probar" no es "no soporta": con el primero se
              intenta igual al autorizar y el resultado queda aprendido. */}
          <Field
            label="¿Acepta TR069?"
            hint="dejalo sin probar y el sistema lo averigua en la primera instalación"
          >
            <Select value={form.soporta_tr069 ?? ''} onChange={set('soporta_tr069')}>
              <option value="">Sin probar</option>
              <option value="si">Sí</option>
              <option value="no">No — va derecho a la ficha manual</option>
            </Select>
          </Field>

          {/* La foto del modelo. Se carga una vez y se ve en todos los
              abonados que tengan ese equipo: el que atiende un reclamo sabe de
              qué aparato le están hablando antes de salir. */}
          <Field
            label="Foto del equipo"
            hint="se ve en la ficha de cada abonado que tenga este modelo"
            className="sm:col-span-2"
          >
            <div className="flex flex-wrap items-center gap-3">
              {form.imagen_url && (
                <img
                  src={form.imagen_url}
                  alt={form.modelo}
                  className="h-16 rounded border border-slate-800 bg-slate-900 object-contain px-2"
                />
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={subirImagen}
                className="text-xs text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-slate-700 file:px-3 file:py-1.5 file:text-xs file:text-slate-100"
              />
              {subiendo && <span className="text-xs text-slate-500">subiendo…</span>}
              {form.imagen_url && !subiendo && (
                <Button
                  type="button"
                  variante="fantasma"
                  onClick={() => setForm((f) => ({ ...f, imagen_url: null }))}
                >
                  Quitar
                </Button>
              )}
            </div>
          </Field>

          <Field label="Notas" className="sm:col-span-2">
            <Textarea rows={2} value={form.notas ?? ''} onChange={set('notas')} />
          </Field>
        </div>
      </Card>

      <Button type="button" variante="fantasma" onClick={() => setAvanzado(!avanzado)}>
        {avanzado ? 'Ocultar avanzado' : 'Avanzado »'}
      </Button>

      {avanzado && (
        <Card>
          <div className="space-y-3 p-4">
            <Aviso>
              Estos nombres son los que el ACS usa para armar la ruta del árbol TR069 de este
              modelo. Si no coinciden con los que el equipo espera, la consulta va a una rama que no
              existe y la configuración falla sin decir por qué.
            </Aviso>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Prefijo Ethernet">
                <Input value={form.prefijo_eth ?? ''} onChange={set('prefijo_eth')} spellCheck={false} />
              </Field>
              <Field label="Prefijo WiFi">
                <Input value={form.prefijo_wifi ?? ''} onChange={set('prefijo_wifi')} spellCheck={false} />
              </Field>
              <Field label="Prefijo VoIP">
                <Input value={form.prefijo_voip ?? ''} onChange={set('prefijo_voip')} spellCheck={false} />
              </Field>
              <Field label="Vendor ID" hint="lo que el equipo dice de sí mismo">
                <Input value={form.vendor_id ?? ''} onChange={set('vendor_id')} placeholder="HWTC" />
              </Field>
              <Field label="Versión de spec">
                <Input value={form.version_spec ?? ''} onChange={set('version_spec')} placeholder="1.0" />
              </Field>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          Guardar
        </Button>
        <Button type="button" variante="fantasma" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
