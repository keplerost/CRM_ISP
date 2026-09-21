import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  BellRing,
  Check,
  Clock,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
  Wifi,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { UNIDAD_UMBRAL, textoAlerta } from '../../lib/alertas'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Input,
  Modal,
  Select,
  Table,
} from '../../components/ui'

/**
 * Ajustes → Alertas.
 *
 * ── Para qué existe ──
 *
 * Una ONT se apaga un martes y en la oficina se sabe el viernes, cuando el
 * abonado llama —si llama—. Para entonces el equipo puede estar en otra ciudad.
 * Acá se configura enterarse en diez minutos.
 *
 * ── Las tres secciones, en orden de importancia ──
 *
 *   A QUIÉN    Varios destinos, cada uno con sus tipos, sus zonas y su horario.
 *              Va primero porque es lo que se toca siempre.
 *   QUÉ        Los umbrales y —el número que más importa— cuántos minutos tiene
 *              que sostenerse una caída antes de avisar.
 *   QUÉ SALIÓ  El historial. Sin esto, "no me llegó nada" es indiscutible.
 */

const CANALES = [
  { clave: 'whatsapp', label: 'WhatsApp' },
  { clave: 'telegram', label: 'Telegram' },
  { clave: 'email', label: 'Correo' },
  { clave: 'sms', label: 'SMS' },
]

const VACIO = {
  nombre: '',
  canal: 'whatsapp',
  destino: '',
  tipos: [],
  zonas: [],
  desde_hora: '',
  hasta_hora: '',
  activo: true,
}

export default function AlertasPage() {
  const confirmar = useConfirmar()
  const [reglas, setReglas] = useState([])
  const [destinos, setDestinos] = useState([])
  const [envios, setEnvios] = useState([])
  const [zonas, setZonas] = useState([])
  const [estado, setEstado] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [enFormulario, setEnFormulario] = useState(null)
  const [probando, setProbando] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [r, d, e, z] = await Promise.all([
        supabase.from('alerta_reglas').select('*').order('clave'),
        supabase.from('alerta_destinos').select('*').order('creado_en'),
        supabase.from('v_alerta_envios').select('*').order('creado_en', { ascending: false }).limit(30),
        supabase.from('clientes').select('zona').not('zona', 'is', null),
      ])
      if (r.error) throw r.error
      setReglas(r.data ?? [])
      setDestinos(d.data ?? [])
      setEnvios(e.data ?? [])
      setZonas([...new Set((z.data ?? []).map((x) => x.zona))].sort())
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
    // El estado del canal viene del middleware: es el único que puede preguntarle
    // al proveedor si la sesión está viva sin exponer el token al navegador.
    api.alertas.estado().then(setEstado).catch(() => setEstado(null))
  }, [recargar])

  async function guardarRegla(clave, cambios) {
    try {
      const { error: e } = await supabase.from('alerta_reglas').update(cambios).eq('clave', clave)
      if (e) throw e
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  async function guardarDestino(datos) {
    try {
      const limpio = {
        ...datos,
        desde_hora: datos.desde_hora || null,
        hasta_hora: datos.hasta_hora || null,
      }
      const { error: e } = datos.id
        ? await supabase.from('alerta_destinos').update(limpio).eq('id', datos.id)
        : await supabase.from('alerta_destinos').insert(limpio)
      if (e) throw e
      setEnFormulario(null)
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  async function borrarDestino(d) {
    if (!await confirmar(`¿Dejar de avisarle a ${d.nombre}?`)) return
    try {
      const { error: e } = await supabase.from('alerta_destinos').delete().eq('id', d.id)
      if (e) throw e
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  async function probar(d) {
    setProbando(d.id)
    setError(null)
    try {
      const r = await api.alertas.probar(d.id)
      if (!r.ok) throw new Error(r.error ?? 'No se pudo enviar')
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setProbando(null)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-100">
          <BellRing size={20} className="text-amber-400" />
          Alertas en tiempo real
        </h1>
        <p className="text-sm text-slate-400">
          Avisos cuando un abonado se queda sin señal o se cae una caja entera, para atenderlo antes
          de que llame — y para que un equipo no se vaya sin que nadie se entere.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <EstadoDelCanal estado={estado} />

      {cargando ? (
        <Cargando />
      ) : (
        <>
          {/* ── A quién ── */}
          <Card
            title="A quién se le avisa"
            subtitle={`${destinos.filter((d) => d.activo).length} activos`}
            actions={
              <Button variante="primario" icon={Plus} onClick={() => setEnFormulario(VACIO)}>
                Agregar destino
              </Button>
            }
          >
            {destinos.length === 0 ? (
              <Aviso>
                Todavía no hay destinos. Sin al menos uno, el sistema detecta las caídas y las anota,
                pero no avisa a nadie.
              </Aviso>
            ) : (
              <Table
                columnas={['Nombre', 'Canal', 'Destino', 'Qué recibe', 'Horario', 'Prueba', '']}
                filas={destinos}
                renderFila={(d) => (
                  <tr key={d.id} className="text-slate-300">
                    <td className="px-3 py-2">
                      <span className={d.activo ? 'text-slate-100' : 'text-slate-500 line-through'}>
                        {d.nombre}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {CANALES.find((c) => c.clave === d.canal)?.label ?? d.canal}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{d.destino}</td>
                    <td className="px-3 py-2 text-[11px]">
                      {d.tipos?.length
                        ? d.tipos.map((t) => reglas.find((r) => r.clave === t)?.nombre ?? t).join(' · ')
                        : 'Todo'}
                      {d.zonas?.length > 0 && (
                        <div className="text-slate-500">Zonas: {d.zonas.join(', ')}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-400">
                      {d.desde_hora ? `${d.desde_hora.slice(0, 5)}–${d.hasta_hora?.slice(0, 5)}` : '24 h'}
                    </td>
                    <td className="px-3 py-2">
                      {d.probado_en ? (
                        <Badge color={d.probado_ok ? 'verde' : 'rojo'}>
                          {d.probado_ok ? 'llegó' : 'falló'}
                        </Badge>
                      ) : (
                        <span className="text-[11px] text-amber-400">sin probar</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          variante="fantasma"
                          icon={Send}
                          title="Enviar un mensaje de prueba"
                          cargando={probando === d.id}
                          onClick={() => probar(d)}
                        />
                        <Button
                          variante="fantasma"
                          icon={Clock}
                          title="Editar"
                          onClick={() => setEnFormulario(d)}
                        />
                        <Button variante="fantasma" icon={Trash2} onClick={() => borrarDestino(d)} />
                      </div>
                    </td>
                  </tr>
                )}
              />
            )}

            <p className="mt-3 text-[11px] text-slate-500">
              Probá cada destino al cargarlo. Es lo único que evita descubrir que el número estaba mal
              el día del primer corte.
            </p>
          </Card>

          {/* ── Qué se considera alerta ── */}
          <Card title="Qué se considera alerta">
            <div className="space-y-3">
              {reglas.map((r) => (
                <Regla key={r.clave} r={r} onGuardar={guardarRegla} />
              ))}
            </div>
          </Card>

          {/* ── Historial ── */}
          <Card title="Qué se mandó" subtitle="Los últimos 30">
            {envios.length === 0 ? (
              <p className="text-xs text-slate-500">Todavía no se mandó ninguna alerta.</p>
            ) : (
              <Table
                columnas={['Cuándo', 'Destino', 'Qué', 'Estado', 'Respuesta']}
                filas={envios}
                renderFila={(e) => (
                  <tr key={e.id} className="text-slate-300">
                    <td className="px-3 py-2 text-[11px] text-slate-400">
                      {new Date(e.creado_en).toLocaleString('es-EC')}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {e.destino_nombre ?? e.destino}
                      <div className="text-[11px] text-slate-500">{e.canal}</div>
                    </td>
                    <td className="max-w-[18rem] truncate px-3 py-2 text-[11px]" title={e.texto ?? ''}>
                      {e.etiqueta ?? e.texto}
                    </td>
                    <td className="px-3 py-2">
                      <Badge color={e.estado === 'enviado' ? 'verde' : e.estado === 'fallido' ? 'rojo' : 'gris'}>
                        {e.estado}
                      </Badge>
                    </td>
                    <td className="max-w-[16rem] truncate px-3 py-2 text-[11px] text-slate-500" title={e.respuesta ?? ''}>
                      {e.respuesta ?? '—'}
                    </td>
                  </tr>
                )}
              />
            )}
          </Card>
        </>
      )}

      <FormularioDestino
        datos={enFormulario}
        reglas={reglas}
        zonas={zonas}
        onCerrar={() => setEnFormulario(null)}
        onGuardar={guardarDestino}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Por dónde van a salir los avisos, y si eso puede funcionar solo.
 *
 * Es lo primero de la pantalla porque es la condición de todo lo demás: con la
 * vía "manual" elegida, se puede configurar media hora de reglas y destinos y no
 * va a salir un solo mensaje.
 */
function EstadoDelCanal({ estado }) {
  if (!estado) return null

  const via = estado.vias?.find((v) => v.clave === estado.via)

  return (
    <div
      className={`rounded-xl border p-3 ${
        estado.automatico && estado.conexion?.conectado
          ? 'border-emerald-500/30 bg-emerald-500/5'
          : 'border-amber-500/30 bg-amber-500/5'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Wifi size={16} className={estado.conexion?.conectado ? 'text-emerald-400' : 'text-amber-400'} />
        <span className="text-slate-200">
          WhatsApp sale por <b>{via?.nombre ?? estado.via}</b>
        </span>
        <Badge color={estado.conexion?.conectado ? 'verde' : 'ambar'}>
          {estado.conexion?.conectado ? 'conectado' : (estado.conexion?.detalle ?? 'sin conexión')}
        </Badge>
        {estado.conexion?.como && (
          <span className="text-[11px] text-slate-500">como {estado.conexion.como}</span>
        )}
      </div>

      {!estado.automatico && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          La vía elegida no envía sola: a las tres de la mañana no hay nadie apretando el botón.
          Cambiala a <b>Evolution API</b>, Meta o Twilio en Ajustes → Mensajería.
        </p>
      )}

      <div className="mt-2 text-[11px] text-slate-500">
        Tarea: {estado.tarea?.encendida ? `encendida, cada ${estado.tarea.cada_minutos} min` : 'apagada'}
        {estado.tarea?.ultima_corrida
          ? ` · última corrida ${new Date(estado.tarea.ultima_corrida).toLocaleString('es-EC')}`
          : ''}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Una regla, con su espera en minutos y su umbral. */
function Regla({ r, onGuardar }) {
  const [espera, setEspera] = useState(String(r.espera_min))
  const [umbral, setUmbral] = useState(r.umbral == null ? '' : String(r.umbral))
  const unidad = UNIDAD_UMBRAL[r.clave]

  const sucio = String(r.espera_min) !== espera || String(r.umbral ?? '') !== umbral

  const vistaPrevia = useMemo(
    () =>
      textoAlerta({
        regla: r.clave,
        nombre: r.nombre,
        etiqueta: r.clave === 'corte_grupo' ? 'NAP-12' : 'Ana Pérez',
        abonados: r.clave === 'corte_grupo' ? Number(umbral) || 3 : 1,
        zona: 'Centro',
        empezo_en: new Date(Date.now() - 12 * 60000),
        detalle: { codigo: 132, rx_dbm: Number(umbral) || -27 },
      }),
    [r.clave, r.nombre, umbral],
  )

  return (
    <div className="t-panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={r.activa}
              onChange={(e) => onGuardar(r.clave, { activa: e.target.checked })}
              className="accent-sky-500"
            />
            <span className="text-sm font-medium text-slate-100">{r.nombre}</span>
          </label>
          <p className="mt-1 text-[11px] leading-snug text-slate-500">{r.descripcion}</p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-slate-400">
            Esperar
            <div className="mt-1 flex items-center gap-1">
              <div className="w-16">
                <Input
                  type="number"
                  min={0}
                  max={1440}
                  value={espera}
                  onChange={(e) => setEspera(e.target.value)}
                  className="py-1 text-xs"
                />
              </div>
              <span className="text-[11px] text-slate-500">min</span>
            </div>
          </label>

          {unidad && (
            <label className="text-[11px] text-slate-400">
              Umbral
              <div className="mt-1 flex items-center gap-1">
                <div className="w-20">
                  <Input
                    type="number"
                    step="0.5"
                    value={umbral}
                    onChange={(e) => setUmbral(e.target.value)}
                    className="py-1 text-xs"
                  />
                </div>
                <span className="text-[11px] text-slate-500">{unidad}</span>
              </div>
            </label>
          )}

          {sucio && (
            <Button
              variante="primario"
              icon={Check}
              className="py-1 text-xs"
              onClick={() =>
                onGuardar(r.clave, {
                  espera_min: Number(espera) || 0,
                  umbral: umbral === '' ? null : Number(umbral),
                })
              }
            >
              Guardar
            </Button>
          )}
        </div>
      </div>

      {/* Cómo se va a leer en el teléfono. Es lo que permite darse cuenta de que
          un mensaje no dice dónde antes de la primera noche mala. */}
      <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-900/60 p-2 text-[11px] leading-snug text-slate-400">
        {vistaPrevia}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------

function FormularioDestino({ datos, reglas, zonas, onCerrar, onGuardar }) {
  const [form, setForm] = useState(VACIO)

  useEffect(() => {
    if (datos) {
      setForm({
        ...VACIO,
        ...datos,
        desde_hora: datos.desde_hora?.slice(0, 5) ?? '',
        hasta_hora: datos.hasta_hora?.slice(0, 5) ?? '',
      })
    }
  }, [datos])

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const alternar = (campo, valor) =>
    setForm((f) => ({
      ...f,
      [campo]: f[campo].includes(valor) ? f[campo].filter((x) => x !== valor) : [...f[campo], valor],
    }))

  return (
    <Modal
      abierto={Boolean(datos)}
      titulo={datos?.id ? `Editar ${datos.nombre}` : 'Nuevo destino'}
      onCerrar={onCerrar}
      ancho="max-w-lg"
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">
            Nombre
            <Input value={form.nombre} onChange={set('nombre')} placeholder="Edison (técnico)" className="mt-1" />
          </label>
          <label className="text-xs text-slate-400">
            Canal
            <Select value={form.canal} onChange={set('canal')} className="mt-1">
              {CANALES.map((c) => (
                <option key={c.clave} value={c.clave}>
                  {c.label}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <label className="block text-xs text-slate-400">
          {form.canal === 'email' ? 'Correo' : form.canal === 'telegram' ? 'Chat ID' : 'Número'}
          <Input
            value={form.destino}
            onChange={set('destino')}
            placeholder={form.canal === 'email' ? 'soporte@…' : '0999000000'}
            className="mt-1"
          />
        </label>

        <div>
          <p className="mb-1 text-xs text-slate-400">Qué recibe</p>
          <div className="flex flex-wrap gap-1">
            {reglas.map((r) => (
              <button
                key={r.clave}
                type="button"
                onClick={() => alternar('tipos', r.clave)}
                className={`rounded-md px-2 py-1 text-[11px] transition ${
                  form.tipos.includes(r.clave)
                    ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {r.nombre}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Sin marcar ninguno recibe todo.</p>
        </div>

        {zonas.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-slate-400">Solo estas zonas</p>
            <div className="flex flex-wrap gap-1">
              {zonas.map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => alternar('zonas', z)}
                  className={`rounded-md px-2 py-1 text-[11px] transition ${
                    form.zonas.includes(z)
                      ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {z}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">Sin marcar ninguna recibe todas.</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">
            Desde
            <Input type="time" value={form.desde_hora} onChange={set('desde_hora')} className="mt-1" />
          </label>
          <label className="text-xs text-slate-400">
            Hasta
            <Input type="time" value={form.hasta_hora} onChange={set('hasta_hora')} className="mt-1" />
          </label>
        </div>
        <p className="text-[11px] text-slate-500">
          Vacío = a cualquier hora. La franja puede cruzar la medianoche: 20:00 a 07:00 es la guardia
          nocturna.
        </p>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={form.activo}
            onChange={(e) => setForm((f) => ({ ...f, activo: e.target.checked }))}
            className="accent-sky-500"
          />
          Activo
        </label>

        <div className="flex justify-end gap-2">
          <Button variante="secundario" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            onClick={() => onGuardar(form)}
            disabled={!form.nombre.trim() || !form.destino.trim()}
          >
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  )
}
