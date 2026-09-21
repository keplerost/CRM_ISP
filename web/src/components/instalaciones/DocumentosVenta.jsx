import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { FileText, Image as ImagenIcon, Trash2, Upload } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Button, Card } from '../ui'
import { comprimirImagen } from '../../lib/soporte'

/**
 * Los papeles que levanta el vendedor, en la orden de trabajo.
 *
 * ── Por qué acá y no en la ficha del abonado ──
 *
 * Porque la cédula la ve el vendedor, en la casa del cliente, el día que vende.
 * La ficha del abonado no existe hasta el alta, que es días después. Cuando
 * alguien tiene la cédula a mano todavía no hay dónde ponerla, y cuando hay
 * dónde ponerla ya nadie la tiene.
 *
 * Al dar de alta, estos papeles pasan solos a la ficha. No se copian: se les
 * completa el abonado, así que siguen sabiendo de qué venta vinieron.
 */

/**
 * Qué se le pide al vendedor, y por qué.
 *
 * `clave` es la que primero se piensa; el resto se piden cuando el caso lo
 * exige. La explicación no es decorativa: quien sube una autorización sin saber
 * para qué sirve la sube mal o no la sube.
 */
const CATEGORIAS = [
  {
    clave: 'cedula_frontal',
    label: 'Cédula (frontal)',
    icon: ImagenIcon,
    ayuda: 'Del titular, el mismo que va a firmar el contrato',
    clave_principal: true,
  },
  {
    clave: 'cedula_reverso',
    label: 'Cédula (reverso)',
    icon: ImagenIcon,
    ayuda: 'La cara de atrás, donde está la firma',
    clave_principal: true,
  },
  {
    clave: 'contrato',
    label: 'Contrato firmado',
    icon: FileText,
    ayuda: 'El escaneo de lo que el cliente firmó a mano',
    clave_principal: true,
  },
  {
    clave: 'planilla_servicio',
    label: 'Planilla de servicio',
    icon: FileText,
    ayuda: 'Luz o agua a nombre del titular: confirma el domicilio',
  },
  {
    clave: 'autorizacion',
    label: 'Autorización',
    icon: FileText,
    ayuda: 'Cuando quien firma NO es el titular. Sin esto, el contrato lo firmó alguien que no figura en él',
  },
  {
    clave: 'ruc',
    label: 'RUC',
    icon: FileText,
    ayuda: 'Del abonado empresa, para su factura',
  },
  {
    clave: 'cedula_representante',
    label: 'Cédula del representante',
    icon: ImagenIcon,
    ayuda: 'De quien firma por la empresa',
  },
  { clave: 'otro', label: 'Otro', icon: FileText, ayuda: '' },
]

const peso = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} kB`)

export default function DocumentosVenta({ instalacion, onError }) {
  const confirmar = useConfirmar()
  const [documentos, setDocumentos] = useState([])
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [subiendo, setSubiendo] = useState(null)
  const archivoRef = useRef(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    /**
     * Solo las copias vigentes.
     *
     * Al subir una cédula nueva, la anterior queda marcada y deja de mostrarse
     * —se conserva por si el reemplazo fue un error, pero mostrar las dos es
     * exactamente el problema que eso resuelve—.
     */
    const { data, error } = await supabase
      .from('documentos')
      .select('*')
      .eq('instalacion_id', instalacion.id)
      .is('reemplazado_en', null)
      .order('created_at')

    if (error) onError?.(error)
    setDocumentos(data ?? [])
    setCargando(false)
  }, [instalacion.id, onError])

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

      /**
       * Las fotos se achican; un PDF firmado va tal cual.
       *
       * Achicar un contrato firmado le quitaría validez, y una cédula sacada con
       * el teléfono pesa cinco megas que nadie necesita para leer un número.
       */
      const contenido = esImagen
        ? await comprimirImagen(archivo, { max: 1600, calidad: 0.75 })
        : archivo
      const extension = esImagen ? 'jpg' : (archivo.name.split('.').pop() ?? 'bin')

      // Bajo la carpeta de la orden. Al pasar a la ficha el archivo no se mueve:
      // solo se le completa el abonado, así que la ruta sigue diciendo de dónde
      // vino.
      const ruta = `ordenes/${instalacion.id}/${subiendo.categoria}-${Date.now()}.${extension}`

      const { error: errSubida } = await supabase.storage
        .from('documentos')
        .upload(ruta, contenido, { contentType: esImagen ? 'image/jpeg' : archivo.type })
      if (errSubida) throw errSubida

      const { error } = await supabase.from('documentos').insert({
        instalacion_id: instalacion.id,
        // Si la orden ya tiene abonado se le pone de una: el disparador cubre el
        // caso contrario, pero así el papel aparece en la ficha sin esperar nada.
        client_id: instalacion.client_id ?? null,
        categoria: subiendo.categoria,
        nombre: archivo.name,
        ruta,
        mime: esImagen ? 'image/jpeg' : archivo.type,
        tamano: contenido.size ?? archivo.size,
        // Interno por defecto, sin excepción por categoría: una cédula no se le
        // muestra a nadie por descuido.
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

  async function ver(doc) {
    const { data, error } = await supabase.storage
      .from('documentos')
      .createSignedUrl(doc.ruta, 3600)
    if (error) return onError?.(error)
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  async function borrar(doc) {
    if (!await confirmar(`¿Borrar "${doc.nombre}"?`)) return
    await supabase.storage.from('documentos').remove([doc.ruta])
    const { error } = await supabase.from('documentos').delete().eq('id', doc.id)
    if (error) onError?.(error)
    else await recargar()
  }

  const porCategoria = (c) => documentos.filter((d) => d.categoria === c)
  const faltanClave = CATEGORIAS.filter((c) => c.clave_principal && !porCategoria(c.clave).length)

  return (
    <Card
      title="Papeles del cliente"
      icon={FileText}
      subtitle="Se cargan al vender y pasan solos a la ficha cuando se da de alta"
    >
      {cargando ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : (
        <div className="space-y-3">
          {/*
            Lo que falta, dicho antes de que alguien lo descubra en el alta.
            No bloquea: hay ventas donde la cédula llega después.
          */}
          {faltanClave.length > 0 && (
            <Aviso>
              Falta cargar: {faltanClave.map((c) => c.label.toLowerCase()).join(', ')}.
            </Aviso>
          )}

          {CATEGORIAS.map((cat) => {
            const archivos = porCategoria(cat.clave)
            const Icon = cat.icon

            return (
              <div key={cat.clave}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
                      <Icon size={13} /> {cat.label}
                    </p>
                    {cat.ayuda && <p className="text-[11px] text-slate-600">{cat.ayuda}</p>}
                  </div>
                  <Button
                    variante="fantasma"
                    icon={Upload}
                    cargando={guardando && subiendo?.categoria === cat.clave}
                    onClick={() => elegirArchivo(cat.clave)}
                  >
                    Subir
                  </Button>
                </div>

                {archivos.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {archivos.map((d) => (
                      <li
                        key={d.id}
                        className="flex items-center gap-2 t-panel px-3 py-1.5"
                      >
                        <button
                          type="button"
                          onClick={() => ver(d)}
                          className="min-w-0 flex-1 truncate text-left text-xs text-sky-400 hover:text-sky-300"
                        >
                          {d.nombre}
                        </button>
                        <span className="shrink-0 text-[11px] text-slate-600">
                          {d.tamano ? peso(d.tamano) : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => borrar(d)}
                          className="shrink-0 text-slate-600 hover:text-rose-400"
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}

      <input
        ref={archivoRef}
        type="file"
        accept="image/*,application/pdf"
        onChange={subir}
        className="hidden"
      />
    </Card>
  )
}
