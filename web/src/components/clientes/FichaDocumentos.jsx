import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import {
  Eye,
  EyeOff,
  FileSignature,
  FileText,
  HardDrive,
  Image as ImagenIcon,
  Plus,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, Card, Field, Input, Modal, Select, Table, Textarea } from '../ui'
import { comprimirImagen, enlaceWhatsapp } from '../../lib/soporte'
import DatosContrato from './DatosContrato'
import FirmaContrato from '../contratos/FirmaContrato'

/**
 * Papeles del abonado: cédula, contrato, acta de entrega y el inventario de lo
 * que se le dejó instalado.
 *
 * Dos cosas que no son detalles:
 *
 *  - Todo entra como **interno** por defecto. Una cédula no se le muestra a
 *    nadie ni se comparte por WhatsApp sin querer: son datos personales, y el
 *    valor por defecto es lo que decide qué pasa cuando alguien va con prisa.
 *  - Los enlaces para compartir **vencen en una hora**. Un enlace eterno a una
 *    cédula es una filtración esperando a que alguien reenvíe la conversación.
 */

/**
 * Los papeles del abonado, con qué es cada uno.
 *
 * La ayuda no es decorativa: sin ella nadie sabe qué va en "planilla de
 * servicio" ni por qué existe "autorización", y las categorías terminan todas
 * en "otro".
 */
const CATEGORIAS = {
  cedula_frontal: { label: 'Cédula (frontal)', icon: ImagenIcon, ayuda: 'Del titular' },
  cedula_reverso: { label: 'Cédula (reverso)', icon: ImagenIcon, ayuda: 'La cara con la firma' },
  contrato: { label: 'Contrato', icon: FileText, ayuda: 'El generado y el escaneo del firmado' },
  acta_entrega: {
    label: 'Acta de entrega',
    icon: FileText,
    ayuda: 'Lo que firma al recibir el equipo: respalda el reclamo en una baja',
  },
  planilla_servicio: {
    label: 'Planilla de servicio',
    icon: FileText,
    ayuda: 'Luz o agua a nombre del titular: confirma el domicilio',
  },
  foto_instalacion: {
    label: 'Fotos de la instalación',
    icon: ImagenIcon,
    ayuda: 'Las que tomó el técnico. Se administran desde la orden de trabajo',
  },
  autorizacion: {
    label: 'Autorización',
    icon: FileText,
    ayuda: 'Cuando quien firma no es el titular',
  },
  ruc: { label: 'RUC', icon: FileText, ayuda: 'Del abonado empresa' },
  cedula_representante: {
    label: 'Cédula del representante',
    icon: ImagenIcon,
    ayuda: 'De quien firma por la empresa',
  },
  otro: { label: 'Otro', icon: FileText, ayuda: '' },
}

const TIPOS_EQUIPO = {
  ont: 'ONT / módem óptico',
  router: 'Router',
  antena: 'Antena',
  cpe: 'CPE',
  switch: 'Switch',
  otro: 'Otro',
}

const EQUIPO_VACIO = {
  tipo: 'ont',
  marca: '',
  modelo: '',
  serie: '',
  mac: '',
  propiedad: 'isp',
  estado: 'entregado',
  notas: '',
}

const peso = (b) => {
  const n = Number(b) || 0
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

const fecha = (f) => (f ? new Date(f).toLocaleDateString() : '—')

export default function FichaDocumentos({ cliente, onError }) {
  const confirmar = useConfirmar()
  const [documentos, setDocumentos] = useState([])
  const [equipos, setEquipos] = useState([])
  const [urls, setUrls] = useState({})
  const [cargando, setCargando] = useState(true)

  const [subiendo, setSubiendo] = useState(null)
  const [viendo, setViendo] = useState(null)
  const [equipo, setEquipo] = useState(null)
  const [guardando, setGuardando] = useState(false)
  // `null` = el formulario del contrato está cerrado. Cuando se abre lleva el
  // plan del abonado, que es de donde salen las condiciones técnicas del anexo.
  const [contrato, setContrato] = useState(null)

  const archivoRef = useRef(null)

  const recargar = useCallback(async () => {
    setCargando(true)

    /**
     * De la VISTA y no de la tabla.
     *
     * Trae también las fotos que tomó el técnico en la instalación, que viven en
     * otro bucket y no se copian acá: se muestran desde donde están. Por eso
     * cada fila dice de qué bucket es y si se puede borrar desde esta pantalla.
     */
    const [d, e] = await Promise.all([
      supabase.from('v_documentos_abonado').select('*').eq('client_id', cliente.id).order('created_at'),
      supabase.from('equipos_cliente').select('*').eq('client_id', cliente.id).order('created_at'),
    ])

    if (d.error) onError?.(d.error)
    setDocumentos(d.data ?? [])
    setEquipos(e.data ?? [])

    // El bucket es privado: cada archivo necesita su enlace firmado. Una hora
    // alcanza para mirarlos y es poco para que un enlace filtrado sirva.
    const mapa = {}
    for (const doc of d.data ?? []) {
      const { data } = await supabase.storage
        .from(doc.bucket ?? 'documentos')
        .createSignedUrl(doc.ruta, 3600)
      if (data?.signedUrl) mapa[doc.id] = data.signedUrl
    }
    setUrls(mapa)
    setCargando(false)
  }, [cliente.id, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  function elegirArchivo(categoria) {
    setSubiendo({ categoria })
    // El input se dispara en el siguiente ciclo, cuando ya sabe qué categoría es.
    setTimeout(() => archivoRef.current?.click(), 0)
  }

  async function subir(e) {
    const archivo = e.target.files?.[0]
    if (!archivo || !subiendo) return

    setGuardando(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()
      const esImagen = archivo.type.startsWith('image/')

      // Las fotos se achican; un PDF firmado va tal cual, que alterarlo le
      // quitaría validez.
      const contenido = esImagen ? await comprimirImagen(archivo, { max: 1600, calidad: 0.75 }) : archivo
      const extension = esImagen ? 'jpg' : (archivo.name.split('.').pop() ?? 'bin')
      const ruta = `${cliente.id}/${subiendo.categoria}-${Date.now()}.${extension}`

      const { error: errSubida } = await supabase.storage
        .from('documentos')
        .upload(ruta, contenido, { contentType: esImagen ? 'image/jpeg' : archivo.type })
      if (errSubida) throw errSubida

      const { error } = await supabase.from('documentos').insert({
        client_id: cliente.id,
        categoria: subiendo.categoria,
        nombre: archivo.name,
        ruta,
        mime: esImagen ? 'image/jpeg' : archivo.type,
        tamano: contenido.size ?? archivo.size,
        // Interno por defecto, sin excepción por categoría.
        visible_cliente: false,
        created_by: sesion?.user?.id ?? null,
      })
      if (error) throw error

      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
      setSubiendo(null)
      if (archivoRef.current) archivoRef.current.value = ''
    }
  }

  async function cambiarVisibilidad(doc) {
    const visible = !doc.visible_cliente

    if (visible && doc.categoria.startsWith('cedula')) {
      const seguir = await confirmar(
        'Es una cédula. Marcarla como visible la deja al alcance del abonado en su portal.\n\n¿Continuar?',
      )
      if (!seguir) return
    }

    const { error } = await supabase
      .from('documentos')
      .update({ visible_cliente: visible })
      .eq('id', doc.id)
    if (error) return onError?.(error)
    await recargar()
  }

  async function borrar(doc) {
    if (!await confirmar(`¿Borrar "${doc.nombre}"? No se puede deshacer.`)) return

    // El archivo primero: borrar solo la fila dejaría el archivo huérfano en el
    // bucket, ocupando espacio y sin nada que lo referencie.
    await supabase.storage.from('documentos').remove([doc.ruta])
    const { error } = await supabase.from('documentos').delete().eq('id', doc.id)
    if (error) return onError?.(error)
    await recargar()
  }

  async function guardarEquipo(e) {
    e.preventDefault()
    setGuardando(true)

    try {
      const { data: sesion } = await supabase.auth.getUser()
      const { id, ...datos } = equipo
      const fila = {
        client_id: cliente.id,
        tipo: datos.tipo,
        marca: datos.marca?.trim() || null,
        modelo: datos.modelo?.trim() || null,
        serie: datos.serie?.trim() || null,
        mac: datos.mac?.trim() || null,
        propiedad: datos.propiedad,
        estado: datos.estado,
        notas: datos.notas?.trim() || null,
        devuelto_at: datos.estado === 'devuelto' ? new Date().toISOString() : null,
        created_by: sesion?.user?.id ?? null,
      }

      const { error } = id
        ? await supabase.from('equipos_cliente').update(fila).eq('id', id)
        : await supabase.from('equipos_cliente').insert(fila)
      if (error) throw error

      setEquipo(null)
      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  /**
   * Abre el formulario del contrato con lo que ya está cargado.
   *
   * Se trae el plan del abonado porque la compartición y la velocidad mínima
   * efectiva que pide el anexo 1f son del plan, no de la ficha — y el formulario
   * tiene que mostrar lo que ya vale antes de dejar cambiarlo.
   */
  async function abrirFormularioContrato() {
    onError?.(null)
    try {
      // La lista completa, no solo el plan que ya tiene: el formulario deja
      // elegirlo, y de ahi salen la comparticion y las velocidades del anexo 1f.
      const [{ data: planes }, { data: prestador }] = await Promise.all([
        supabase
          .from('planes_velocidad')
          .select('id, nombre, precio, bajada_kbps, subida_kbps, comparticion, minima_bajada_kbps, minima_subida_kbps')
          .eq('activo', true)
          .order('precio'),
        // Con qué valor viene propuesta la casilla de arbitraje. Lo decide el
        // ISP en el prestador; el abonado la firma aparte.
        supabase
          .from('prestadores')
          .select('arbitraje_por_defecto')
          .eq('predeterminado', true)
          .maybeSingle(),
      ])

      setContrato({
        planes: planes ?? [],
        plan: (planes ?? []).find((p) => p.id === cliente.plan_id) ?? null,
        arbitraje: prestador?.arbitraje_por_defecto ?? null,
      })
    } catch (err) {
      onError?.(err)
    }
  }

  /**
   * Genera el contrato de adhesión, lo guarda y lo abre para imprimir.
   *
   * ── Por qué se guarda además de abrirse ──
   *
   * Porque el que se imprime y el que se firma tienen que ser el mismo papel.
   * El contrato se arma con los datos del momento —plan, precio, permanencia— y
   * esos cambian: si dentro de un año alguien reclama, generarlo de nuevo daría
   * otro documento. La copia guardada es la que se firmó.
   *
   * El escaneo con la firma se sube después, en esta misma pantalla.
   */
  async function generarContrato() {
    setGuardando(true)
    onError?.(null)

    try {
      const blob = await api.documentos.contratoArcotel(cliente.id)

      const ruta = `${cliente.id}/contrato-${Date.now()}.pdf`
      const { error: errSubida } = await supabase.storage
        .from('documentos')
        .upload(ruta, blob, { contentType: 'application/pdf' })
      if (errSubida) throw errSubida

      const { data: sesion } = await supabase.auth.getUser()
      const { error } = await supabase.from('documentos').insert({
        client_id: cliente.id,
        categoria: 'contrato',
        // El nombre dice que está SIN FIRMAR: en la lista va a convivir con el
        // escaneo del firmado, y confundirlos sería dar por firmado lo que no.
        nombre: `Contrato de adhesión (sin firmar) — ${new Date().toLocaleDateString()}.pdf`,
        ruta,
        mime: 'application/pdf',
        tamano: blob.size,
        visible_cliente: false,
        created_by: sesion?.user?.id ?? null,
      })
      if (error) throw error

      // Y se abre para imprimirlo y llevarlo a firmar.
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)

      await recargar()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const porCategoria = (c) => documentos.filter((d) => d.categoria === c)

  return (
    <div className="space-y-4">
      {/*
        La firma arriba de los papeles: es el estado del contrato, y es lo
        primero que alguien viene a mirar acá.
      */}
      <FirmaContrato cliente={cliente} onError={onError} />

      <Card
        title="Documentos"
        icon={HardDrive}
        subtitle="Cédula, contrato y actas del abonado"
        actions={
          <Button
            variante="primario"
            icon={FileSignature}
            cargando={guardando}
            onClick={abrirFormularioContrato}
            title="Completa lo que falta, genera el contrato de adhesión con sus cuatro anexos, lo guarda acá y lo abre para imprimir"
          >
            Generar contrato
          </Button>
        }
      >
        {cargando ? (
          <p className="text-sm text-slate-500">Cargando…</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(CATEGORIAS).map(([clave, cat]) => {
              const archivos = porCategoria(clave)
              const Icon = cat.icon

              return (
                <div key={clave}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
                        <Icon size={13} /> {cat.label}
                      </p>
                      {cat.ayuda && (
                        <p className="text-[11px] text-slate-600">{cat.ayuda}</p>
                      )}
                    </div>
                    {/*
                      Las fotos de la instalación no se suben desde acá: las
                      toma el técnico y se administran en su orden de trabajo.
                      Un botón que promete lo contrario deja fotos sueltas en la
                      ficha que el técnico nunca ve.
                    */}
                    {clave !== 'foto_instalacion' && (
                      <button
                        type="button"
                        onClick={() => elegirArchivo(clave)}
                        disabled={guardando}
                        className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 disabled:opacity-50"
                      >
                        <Upload size={12} /> Subir
                      </button>
                    )}
                  </div>

                  {archivos.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2 text-xs text-slate-600">
                      Sin archivos
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                      {archivos.map((d) => (
                        <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                          <button
                            type="button"
                            onClick={() => setViendo(d)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <span className="block truncate text-sm text-slate-200">{d.nombre}</span>
                            <span className="text-[11px] text-slate-500">
                              {peso(d.tamano)} · {fecha(d.created_at)}
                            </span>
                          </button>

                          {/*
                            Lo de solo lectura viene de otra tabla: son las
                            fotos del técnico, que se ven acá pero se
                            administran donde viven. Borrarlas desde esta
                            pantalla haría desaparecer el respaldo del trabajo
                            sin que nadie espere esa consecuencia.
                          */}
                          {d.solo_lectura ? (
                            <span className="shrink-0 rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-500">
                              de la orden
                            </span>
                          ) : (
                            <>
                          <button
                            type="button"
                            onClick={() => cambiarVisibilidad(d)}
                            title={
                              d.visible_cliente
                                ? 'Visible para el cliente'
                                : 'Solo interno'
                            }
                            className={`shrink-0 rounded px-2 py-1 text-[10px] ${
                              d.visible_cliente
                                ? 'bg-amber-500/15 text-amber-300'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {d.visible_cliente ? (
                              <span className="flex items-center gap-1">
                                <Eye size={11} /> Cliente
                              </span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <EyeOff size={11} /> Interno
                              </span>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => borrar(d)}
                            className="shrink-0 text-slate-600 hover:text-rose-400"
                          >
                            <Trash2 size={14} />
                          </button>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <input ref={archivoRef} type="file" accept="image/*,application/pdf" onChange={subir} className="hidden" />
      </Card>

      <Card
        title="Equipos entregados"
        icon={HardDrive}
        subtitle="Lo que se reclama en una baja"
        actions={
          <Button variante="primario" icon={Plus} onClick={() => setEquipo(EQUIPO_VACIO)}>
            Agregar
          </Button>
        }
      >
        <Table
          columnas={['Equipo', 'Serie', 'MAC', 'Propiedad', 'Estado', '']}
          filas={equipos}
          vacio="No hay equipos registrados. Cargalos para poder reclamarlos si el abonado se da de baja."
          renderFila={(e) => (
            <tr key={e.id} className="border-t border-slate-800">
              <td className="px-3 py-2 text-sm text-slate-200">
                {TIPOS_EQUIPO[e.tipo]}
                {e.marca || e.modelo ? (
                  <span className="block text-[11px] text-slate-500">
                    {[e.marca, e.modelo].filter(Boolean).join(' ')}
                  </span>
                ) : null}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{e.serie ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-xs">{e.mac ?? '—'}</td>
              <td className="px-3 py-2 text-xs">
                {e.propiedad === 'isp' ? (
                  <span className="text-sky-300">Del ISP</span>
                ) : (
                  <span className="text-slate-400">Del cliente</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs">
                <span
                  className={
                    e.estado === 'entregado'
                      ? 'text-emerald-400'
                      : e.estado === 'devuelto'
                        ? 'text-slate-400'
                        : 'text-rose-400'
                  }
                >
                  {e.estado}
                </span>
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => setEquipo(e)}
                  className="text-[11px] text-sky-400 hover:text-sky-300"
                >
                  Editar
                </button>
              </td>
            </tr>
          )}
        />
      </Card>

      {/* ---------------------------------------------------- Previsualizador */}
      <Modal
        abierto={Boolean(viendo)}
        titulo={viendo?.nombre ?? ''}
        onCerrar={() => setViendo(null)}
        ancho="max-w-3xl"
      >
        {viendo && (
          <div className="space-y-3">
            {String(viendo.mime).startsWith('image/') ? (
              <img
                src={urls[viendo.id]}
                alt={viendo.nombre}
                className="max-h-[60vh] w-full rounded-lg object-contain"
              />
            ) : (
              <iframe
                src={urls[viendo.id]}
                title={viendo.nombre}
                className="h-[60vh] w-full rounded-lg border border-slate-700 bg-white"
              />
            )}

            <div className="flex flex-wrap items-center gap-2">
              <a
                href={urls[viendo.id]}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Abrir aparte
              </a>

              {enlaceWhatsapp(
                cliente.telefono_movil || cliente.telefono,
                `Le compartimos su ${CATEGORIAS[viendo.categoria]?.label.toLowerCase()}: ${urls[viendo.id]}`,
              ) && (
                <a
                  href={enlaceWhatsapp(
                    cliente.telefono_movil || cliente.telefono,
                    `Le compartimos su ${CATEGORIAS[viendo.categoria]?.label.toLowerCase()}: ${urls[viendo.id]}`,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-emerald-600/40 px-3 py-2 text-sm text-emerald-300 hover:bg-emerald-500/10"
                >
                  <Share2 size={15} /> Compartir por WhatsApp
                </a>
              )}
            </div>

            <Aviso tipo="alerta">
              El enlace que se comparte vence en una hora. Después hay que volver a generarlo desde
              acá — un enlace eterno a una cédula queda dando vueltas en cualquier reenvío.
            </Aviso>
          </div>
        )}
      </Modal>

      {/* ---------------------------------------------------- Equipo */}
      <Modal
        abierto={Boolean(equipo)}
        titulo={equipo?.id ? 'Editar equipo' : 'Agregar equipo'}
        onCerrar={() => setEquipo(null)}
      >
        {equipo && (
          <form onSubmit={guardarEquipo} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tipo">
                <Select
                  value={equipo.tipo}
                  onChange={(e) => setEquipo((x) => ({ ...x, tipo: e.target.value }))}
                >
                  {Object.entries(TIPOS_EQUIPO).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Propiedad" hint="Solo se reclama lo del ISP">
                <Select
                  value={equipo.propiedad}
                  onChange={(e) => setEquipo((x) => ({ ...x, propiedad: e.target.value }))}
                >
                  <option value="isp">Del ISP (comodato)</option>
                  <option value="cliente">Del cliente</option>
                </Select>
              </Field>
              <Field label="Marca">
                <Input
                  value={equipo.marca ?? ''}
                  onChange={(e) => setEquipo((x) => ({ ...x, marca: e.target.value }))}
                />
              </Field>
              <Field label="Modelo">
                <Input
                  value={equipo.modelo ?? ''}
                  onChange={(e) => setEquipo((x) => ({ ...x, modelo: e.target.value }))}
                />
              </Field>
              <Field label="Serie">
                <Input
                  value={equipo.serie ?? ''}
                  onChange={(e) => setEquipo((x) => ({ ...x, serie: e.target.value }))}
                />
              </Field>
              <Field label="MAC">
                <Input
                  value={equipo.mac ?? ''}
                  onChange={(e) => setEquipo((x) => ({ ...x, mac: e.target.value }))}
                  placeholder="AA:BB:CC:DD:EE:FF"
                />
              </Field>
            </div>

            <Field label="Estado">
              <Select
                value={equipo.estado}
                onChange={(e) => setEquipo((x) => ({ ...x, estado: e.target.value }))}
              >
                <option value="entregado">Entregado</option>
                <option value="devuelto">Devuelto</option>
                <option value="perdido">Perdido</option>
                <option value="dañado">Dañado</option>
              </Select>
            </Field>

            <Field label="Notas">
              <Textarea
                rows={2}
                value={equipo.notas ?? ''}
                onChange={(e) => setEquipo((x) => ({ ...x, notas: e.target.value }))}
              />
            </Field>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setEquipo(null)}>
                Cancelar
              </Button>
              <Button variante="primario" type="submit" cargando={guardando}>
                Guardar
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/*
        Lo que falta para que el contrato salga completo, y el contrato.

        Se cierra ANTES de generar: armar las nueve hojas y subirlas lleva unos
        segundos, y dejar el formulario abierto mientras tanto hace que alguien
        vuelva a apretar "Guardar y generar" y se cree un segundo contrato.
      */}
      {contrato && (
        <DatosContrato
          cliente={cliente}
          plan={contrato.plan}
          planes={contrato.planes}
          tabla="clientes"
          arbitrajePorDefecto={contrato.arbitraje}
          abierto
          onCerrar={() => setContrato(null)}
          onError={onError}
          onListo={async () => {
            setContrato(null)
            await generarContrato()
          }}
        />
      )}
    </div>
  )
}
