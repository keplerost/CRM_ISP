import { useState } from 'react'
import { Save } from 'lucide-react'
import {
  CATEGORIAS,
  CONTROL_PPPOE,
  IMPUESTOS,
  SHAPING,
  aKbps,
  dinero,
  repartir,
} from '../../lib/planes'
import { Aviso, Button, Field, Input, Select, Textarea } from '../ui'

/**
 * Alta y edición de un plan de internet.
 *
 * Está partido en las dos mitades que el plan realmente tiene —lo comercial y
 * lo técnico— porque las llena gente distinta: el precio y el IVA los define
 * quien vende, y la cola y la prioridad quien arma la red.
 *
 * El total a facturar se muestra mientras se escribe. Un precio de 25 con IVA
 * incluido y uno de 25 más IVA son dos productos distintos, y sin verlo
 * calculado se cargan igual.
 */

const VACIO = {
  nombre: '',
  descripcion: '',
  categoria: 'residencial',
  codigo_facturacion: '',
  precio: '',
  tipo_impuesto: 'incluido',
  iva_porcentaje: 15,
  bajada_mbps: '',
  subida_mbps: '',
  perfil_ppp: '',
  control_pppoe: 'olt',
  traffic_table_index: '',
  traffic_table_bajada: '',
  traffic_table_subida: '',
  garantizado_bajada: '',
  garantizado_subida: '',
  prioridad: '',
  activo: true,
  // Lo que declara el anexo 1f del contrato. Opcional: si no se llena, el
  // contrato deja esas líneas en blanco y se completan a mano.
  comparticion: '',
  minima_bajada: '',
  minima_subida: '',
}

/**
 * Los niveles de compartición que enumera el anexo 1f.
 *
 * Dice "(1:1, 2:1, 4:1, 8:4)" —el último con un 4, no con un 1—. Se respeta lo
 * que dice el formulario inscrito aunque parezca un error de tipeo: quien
 * compare el contrato contra el modelo va a buscar exactamente eso. Y se puede
 * escribir otro, porque esa lista es un ejemplo.
 */
const COMPARTICION = ['1:1', '2:1', '4:1', '8:4']

export default function PlanForm({
  plan,
  routers = [],
  asignados = [],
  // Las traffic tables que tiene la OLT. `null` = todavía no se leyeron; una
  // lista vacía = se leyeron y no hay ninguna. Son cosas distintas y la pantalla
  // dice cuál es cada una.
  velocidades = null,
  onLeerVelocidades,
  onGuardar,
  onCancelar,
}) {
  /**
   * En qué equipos se ofrece el plan.
   *
   * Va acá dentro y no solo en su propio diálogo porque es parte de crear el
   * plan: un plan de 300 megas que existe en la base y en ningún router no se
   * le puede vender a nadie. Antes había que guardar, salir y buscar un icono.
   *
   * Es una relación de muchos a muchos de verdad: el mismo plan puede ofrecerse
   * en PROGRESO y en LA MANA, con su perfil creado en los dos equipos.
   */
  const [enRouters, setEnRouters] = useState(() => new Set(asignados))

  const alternarRouter = (id) =>
    setEnRouters((s) => {
      const nuevo = new Set(s)
      if (nuevo.has(id)) nuevo.delete(id)
      else nuevo.add(id)
      return nuevo
    })

  const [form, setForm] = useState(() =>
    plan
      ? {
          nombre: plan.nombre ?? '',
          descripcion: plan.descripcion ?? '',
          categoria: plan.categoria ?? 'residencial',
          codigo_facturacion: plan.codigo_facturacion ?? '',
          precio: plan.precio ?? '',
          tipo_impuesto: plan.tipo_impuesto ?? 'incluido',
          iva_porcentaje: plan.iva_porcentaje ?? 15,
          bajada_mbps: plan.bajada_kbps != null ? plan.bajada_kbps / 1000 : '',
          subida_mbps: plan.subida_kbps != null ? plan.subida_kbps / 1000 : '',
          perfil_ppp: plan.perfil_ppp ?? '',
          control_pppoe: plan.control_pppoe ?? 'olt',
          traffic_table_index: plan.traffic_table_index ?? '',
          // Se cae al índice viejo para los planes que todavía no se migraron.
          traffic_table_bajada: plan.traffic_table_bajada ?? plan.traffic_table_index ?? '',
          traffic_table_subida: plan.traffic_table_subida ?? plan.traffic_table_index ?? '',
          garantizado_bajada: plan.garantizado_bajada_kbps != null ? plan.garantizado_bajada_kbps / 1000 : '',
          garantizado_subida: plan.garantizado_subida_kbps != null ? plan.garantizado_subida_kbps / 1000 : '',
          prioridad: plan.prioridad ?? '',
          activo: plan.activo ?? true,
          comparticion: plan.comparticion ?? '',
          minima_bajada: plan.minima_bajada_kbps != null ? plan.minima_bajada_kbps / 1000 : '',
          minima_subida: plan.minima_subida_kbps != null ? plan.minima_subida_kbps / 1000 : '',
        }
      : VACIO,
  )
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const cuentas = repartir(form.precio, form.tipo_impuesto, form.iva_porcentaje)

  // El caudal garantizado no puede superar la velocidad: RouterOS rechazaría la
  // cola entera y el abonado se quedaría sin siquiera su límite.
  const problemas = []
  if (form.garantizado_bajada !== '' && Number(form.garantizado_bajada) > Number(form.bajada_mbps || 0)) {
    problemas.push('El caudal garantizado de bajada no puede superar la velocidad del plan.')
  }
  if (form.garantizado_subida !== '' && Number(form.garantizado_subida) > Number(form.subida_mbps || 0)) {
    problemas.push('El caudal garantizado de subida no puede superar la velocidad del plan.')
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      const texto = (v) => String(v ?? '').trim() || null
      const numero = (v) => (v === '' || v == null ? null : Number(v))

      await onGuardar({
        nombre: form.nombre.trim(),
        descripcion: texto(form.descripcion),
        categoria: form.categoria,
        // Vacío va como NULL: dos planes con código '' chocarían contra el
        // índice único, y "sin código" no es un código repetido.
        codigo_facturacion: texto(form.codigo_facturacion),
        precio: Number(form.precio) || 0,
        tipo_impuesto: form.tipo_impuesto,
        iva_porcentaje: Number(form.iva_porcentaje) || 0,
        bajada_kbps: aKbps(form.bajada_mbps),
        subida_kbps: aKbps(form.subida_mbps),
        perfil_ppp: texto(form.perfil_ppp),
        control_pppoe: form.control_pppoe,
        traffic_table_index: numero(form.traffic_table_bajada ?? form.traffic_table_index),
        // Una tabla por sentido: el equipo las pide separadas y casi todos los
        // planes son asimétricos.
        traffic_table_bajada: numero(form.traffic_table_bajada),
        traffic_table_subida: numero(form.traffic_table_subida),
        garantizado_bajada_kbps: aKbps(form.garantizado_bajada),
        garantizado_subida_kbps: aKbps(form.garantizado_subida),
        prioridad: numero(form.prioridad),
        activo: form.activo,
        // Lo del anexo 1f. Vacío va como NULL y no como 0: una velocidad mínima
        // efectiva de cero es una promesa contractual distinta de no declararla.
        comparticion: texto(form.comparticion),
        minima_bajada_kbps: aKbps(form.minima_bajada),
        minima_subida_kbps: aKbps(form.minima_subida),
      }, [...enRouters])
    } catch (err) {
      setError(
        err.code === '23505'
          ? `Ya existe un plan llamado "${form.nombre}" o con ese código de facturación`
          : err.message,
      )
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-6">
      {error && <Aviso tipo="alerta">{error}</Aviso>}

      {/* --- Comercial ------------------------------------------------- */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Datos comerciales
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del plan">
            <Input value={form.nombre} onChange={set('nombre')} placeholder="Plan Hogar 100M" required />
          </Field>

          <Field label="Categoría" hint={CATEGORIAS[form.categoria]?.ayuda}>
            <Select value={form.categoria} onChange={set('categoria')}>
              {Object.entries(CATEGORIAS).map(([valor, c]) => (
                <option key={valor} value={valor}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Precio de lista">
            <Input
              type="number"
              step="0.01"
              min={0}
              value={form.precio}
              onChange={set('precio')}
              required
            />
          </Field>

          <Field label="IVA" hint={IMPUESTOS[form.tipo_impuesto]?.ayuda}>
            <Select value={form.tipo_impuesto} onChange={set('tipo_impuesto')}>
              {Object.entries(IMPUESTOS).map(([valor, i]) => (
                <option key={valor} value={valor}>
                  {i.label}
                </option>
              ))}
            </Select>
          </Field>

          {form.tipo_impuesto !== 'ninguno' && (
            <Field label="Tarifa de IVA (%)">
              <Input
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={form.iva_porcentaje}
                onChange={set('iva_porcentaje')}
              />
            </Field>
          )}

          <Field label="Código de facturación" hint="Va en el detalle del comprobante">
            <Input
              value={form.codigo_facturacion}
              onChange={set('codigo_facturacion')}
              maxLength={25}
              placeholder="1016"
            />
          </Field>

          <Field label="Descripción" className="sm:col-span-2" hint="Lo que se le dice al cliente">
            <Textarea rows={2} value={form.descripcion} onChange={set('descripcion')} />
          </Field>
        </div>

        {/* El desglose, mientras se escribe. */}
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-center">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Base</p>
            <p className="text-sm font-semibold text-slate-200">{dinero(cuentas.base)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">
              IVA {form.tipo_impuesto === 'ninguno' ? '' : `${form.iva_porcentaje}%`}
            </p>
            <p className="text-sm font-semibold text-slate-200">{dinero(cuentas.iva)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Total a facturar</p>
            <p className="text-sm font-semibold text-emerald-300">{dinero(cuentas.total)}</p>
          </div>
        </div>
      </section>

      {/* --- Técnico --------------------------------------------------- */}
      <section className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Parámetros técnicos
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bajada (Mbps)">
            <Input
              type="number"
              step="0.1"
              min={0.1}
              value={form.bajada_mbps}
              onChange={set('bajada_mbps')}
              required
            />
          </Field>
          <Field label="Subida (Mbps)">
            <Input
              type="number"
              step="0.1"
              min={0.1}
              value={form.subida_mbps}
              onChange={set('subida_mbps')}
              required
            />
          </Field>
        </div>

        {/* --- Lo que se declara en el contrato ---
            Son datos del anexo 1f, no parámetros de la red: no configuran nada
            en el router ni en la OLT. Van acá porque son del plan y porque el
            que arma un plan nuevo es quien sabe con qué compartición lo va a
            vender.

            Todo opcional: si no se llena, el contrato deja esas líneas en
            blanco y se completan a mano. Una velocidad mínima efectiva puesta
            al azar es una promesa contractual que después hay que cumplir. */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs font-medium text-slate-300">
            En el contrato <span className="font-normal text-slate-500">· anexo 1f, opcional</span>
          </p>

          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Nivel de compartición">
              <Input
                list="niveles-comparticion"
                value={form.comparticion}
                onChange={set('comparticion')}
                placeholder="4:1"
              />
              {/* `datalist` y no un `select`: se elige de la lista del anexo o se
                  escribe otro, sin dos controles ni un "Otro…" que hay que
                  descubrir. */}
              <datalist id="niveles-comparticion">
                {COMPARTICION.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Mínima efectiva bajada (Mbps)">
              <Input
                type="number"
                step="0.1"
                min={0}
                value={form.minima_bajada}
                onChange={set('minima_bajada')}
                placeholder={form.bajada_mbps || ''}
              />
            </Field>
            <Field label="Mínima efectiva subida (Mbps)">
              <Input
                type="number"
                step="0.1"
                min={0}
                value={form.minima_subida}
                onChange={set('minima_subida')}
                placeholder={form.subida_mbps || ''}
              />
            </Field>
          </div>
        </div>

        {/* --- Cómo se limita en fibra ---
            En PPPoE lo hace el router; en GPON lo hace la OLT con una traffic
            table por sentido. Antes acá se escribía un número a mano y así
            quedaron dos planes apuntando a tablas inexistentes y uno a la de
            1 Gbps mientras vendía 100 megas. Ahora se elige de las que el
            equipo tiene de verdad. */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs font-medium text-slate-300">En fibra (GPON)</p>

          {velocidades === null ? (
            <p className="mt-2 text-[11px] text-slate-500">
              <button
                type="button"
                onClick={onLeerVelocidades}
                className="text-sky-400 hover:text-sky-300"
              >
                Leer los perfiles de la OLT
              </button>{' '}
              para poder elegir con qué velocidad se aplica.
            </p>
          ) : velocidades.length === 0 ? (
            <p className="mt-2 text-[11px] leading-snug text-amber-400">
              La OLT no tiene ningún perfil cargado. Se crean desde Servicios → Perfiles de
              velocidad.
            </p>
          ) : (
            <>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Tabla de bajada" hint="lo que baja el abonado">
                  <Select value={form.traffic_table_bajada ?? ''} onChange={set('traffic_table_bajada')}>
                    <option value="">— sin límite en la OLT —</option>
                    {velocidades.map((t) => (
                      <option key={t.index} value={t.index}>
                        {t.index} · {t.sin_limite ? 'sin límite' : `${t.mbps} Mbps`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Tabla de subida" hint="lo que sube">
                  <Select value={form.traffic_table_subida ?? ''} onChange={set('traffic_table_subida')}>
                    <option value="">— sin límite en la OLT —</option>
                    {velocidades.map((t) => (
                      <option key={t.index} value={t.index}>
                        {t.index} · {t.sin_limite ? 'sin límite' : `${t.mbps} Mbps`}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              {/* Que la tabla elegida coincida con lo que el plan vende. Es
                  exactamente el error que nadie veía: el nombre del plan decía
                  100M y la tabla aplicaba 1048. */}
              {(() => {
                const t = (i) => velocidades.find((x) => String(x.index) === String(i))
                const avisos = []
                const revisar = (indice, mbps, sentido) => {
                  const tabla = t(indice)
                  if (!tabla || !mbps) return
                  if (tabla.sin_limite) {
                    avisos.push(`la tabla de ${sentido} no limita nada y el plan vende ${mbps} Mbps`)
                  } else if (Math.abs(tabla.mbps - mbps) > mbps * 0.1) {
                    avisos.push(
                      `la tabla de ${sentido} aplica ${tabla.mbps} Mbps y el plan vende ${mbps}`,
                    )
                  }
                }
                revisar(form.traffic_table_bajada, Number(form.bajada_mbps), 'bajada')
                revisar(form.traffic_table_subida, Number(form.subida_mbps), 'subida')

                return avisos.length ? (
                  <p className="mt-2 text-[11px] leading-snug text-amber-400">
                    Ojo: {avisos.join(' · ')}. El abonado va a tener la velocidad de la tabla, no la
                    del nombre del plan.
                  </p>
                ) : null
              })()}
            </>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs font-medium text-slate-300">{SHAPING.pppoe.label}</p>

          <div className="mt-3">
            <Field
              label="El caudal lo controla"
              hint={CONTROL_PPPOE[form.control_pppoe]?.ayuda}
            >
              <Select value={form.control_pppoe} onChange={set('control_pppoe')}>
                {Object.entries(CONTROL_PPPOE).map(([valor, c]) => (
                  <option key={valor} value={valor}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Perfil PPP en el router" hint="Vacío = se usa el nombre del plan">
              <Input value={form.perfil_ppp} onChange={set('perfil_ppp')} placeholder="PLAN HOME 100M" />
            </Field>
            <Field
              label="Traffic table de la OLT"
              hint={
                form.control_pppoe === 'olt'
                  ? 'Índice del perfil de caudal'
                  : 'No se usa: en este plan limita el router'
              }
            >
              <Input
                type="number"
                min={1}
                value={form.traffic_table_index}
                onChange={set('traffic_table_index')}
                disabled={form.control_pppoe !== 'olt'}
              />
            </Field>
          </div>

          {form.control_pppoe === 'mikrotik' && (
            <p className="mt-2 text-[11px] text-amber-300/80">
              El perfil va a llevar {form.bajada_mbps || '—'} Mbps de bajada y{' '}
              {form.subida_mbps || '—'} de subida, más la ráfaga y la prioridad que tenga cargadas.
              Es un límite compartido por todos los abonados PPPoE de este plan.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs font-medium text-slate-300">
            {SHAPING.ip.label} → {SHAPING.ip.donde}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">{SHAPING.ip.detalle}</p>
          <p className="mt-1 text-[11px] text-slate-500">{SHAPING.ip.aplica}</p>

          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Garantizado bajada (Mbps)" hint="limit-at">
              <Input
                type="number"
                step="0.1"
                min={0}
                value={form.garantizado_bajada}
                onChange={set('garantizado_bajada')}
              />
            </Field>
            <Field label="Garantizado subida (Mbps)">
              <Input
                type="number"
                step="0.1"
                min={0}
                value={form.garantizado_subida}
                onChange={set('garantizado_subida')}
              />
            </Field>
            <Field label="Prioridad" hint="1 se atiende primero">
              <Select value={form.prioridad} onChange={set('prioridad')}>
                <option value="">Sin definir (8)</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <p className="mt-2 text-[11px] text-slate-500">
            La ráfaga se configura aparte, con el botón “Cola”: son seis valores y RouterOS los
            exige todos juntos o rechaza la cola entera.
          </p>
        </div>

        <Field label="Estado">
          <Select
            value={form.activo ? 'si' : 'no'}
            onChange={(e) => setForm((f) => ({ ...f, activo: e.target.value === 'si' }))}
          >
            <option value="si">Activo — se ofrece en las altas</option>
            <option value="no">Retirado — solo para los que ya lo tienen</option>
          </Select>
        </Field>
      </section>

      {/* --- Disponibilidad --------------------------------------------- */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          En qué routers se ofrece
        </h3>
        <p className="text-[11px] text-slate-500">
          El mismo plan puede venderse en varios nodos. En cada uno marcado se crea el perfil PPP{' '}
          <b className="text-slate-300">{form.perfil_ppp.trim() || form.nombre || 'del plan'}</b>, sin
          rate-limit.
        </p>

        {routers.length === 0 ? (
          <Aviso>No hay routers cargados todavía.</Aviso>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {routers.map((r) => (
              <label
                key={r.id}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition ${
                  enRouters.has(r.id)
                    ? 'border-sky-500/50 bg-sky-500/10'
                    : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  checked={enRouters.has(r.id)}
                  onChange={() => alternarRouter(r.id)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-sky-500"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-100">{r.nombre}</span>
                  <span className="block text-[11px] text-slate-500">{r.ip_host}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {enRouters.size > 0 && (
          <p className="text-[11px] text-slate-500">
            Guardar deja la asignación anotada. El perfil se crea en los equipos con el botón
            “Aprovisionar”, desde el icono de routers del listado.
          </p>
        )}
      </section>

      {problemas.map((p) => (
        <Aviso key={p} tipo="alerta">
          {p}
        </Aviso>
      ))}

      {plan?.abonados > 0 && (
        <Aviso>
          {plan.abonados} abonados tienen este plan. Cambiar la velocidad acá no se la cambia a
          ninguno: eso vive en los equipos y se aplica con “A los clientes” y “Aprovisionar
          perfiles”.
        </Aviso>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button
          type="submit"
          variante="primario"
          icon={Save}
          cargando={guardando}
          disabled={problemas.length > 0}
        >
          {plan ? 'Guardar cambios' : 'Crear plan'}
        </Button>
      </div>
    </form>
  )
}
