import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmar } from '../../../lib/confirmar'
import { Camera, CheckCircle2, Trash2 } from 'lucide-react'
import { supabase } from '../../../lib/supabaseClient'
import { comprimirImagen } from '../../../lib/soporte'
import { faltantes } from '../../../lib/instalaciones'
import { campoApi } from '../../../lib/colaCampo'
import { inventarioApi } from '../../../lib/inventario'
import FirmaDigital from '../../soporte/FirmaDigital'
import { Aviso, Button, Field, Input, Select, Textarea } from '../../ui'

/**
 * Paso 6 — conformidad del cliente y alta.
 *
 * La firma y las fotos son lo que respalda el trabajo cuando dentro de tres
 * meses alguien discuta si se instaló, qué se dejó puesto y en qué estado. Sin
 * eso, la única prueba es la palabra del técnico.
 *
 * "Finalizar Alta" no hace un UPDATE: llama a la función de la base, que crea
 * la ficha del abonado y cierra la instalación en una sola operación. Hacerlo
 * en dos pasos desde el celular significa que perder la señal en el medio deje
 * un cliente activo sin instalación cerrada —o al revés—.
 */
/**
 * Qué se fotografía, según cómo llega el servicio.
 *
 * ── Por qué no es una lista sola ──
 *
 * Las cuatro primeras son iguales en fibra y en radio: se llega, se tiende, se
 * conecta adentro. Las dos del medio no: en fibra se fotografía la ONT y el
 * nivel óptico; en radio, el CPE y la ALINEACIÓN de la antena, que es el
 * equivalente —es lo que después permite discutir si el problema es el
 * apuntamiento o el equipo—.
 *
 * Ofrecerle "Nivel óptico" a un técnico de radio no es solo raro: lo obliga a
 * cargar la foto de la alineación como "otra", y entonces la búsqueda de "la
 * foto del apuntamiento de esta casa" no encuentra nada tres meses después.
 * Que es exactamente el problema que estas categorías vinieron a resolver.
 *
 * El VALOR guardado se mantiene (`equipo`, `potencia`) para no partir en dos lo
 * ya cargado: lo que cambia es cómo se lee en pantalla.
 */
const FOTOS_COMUNES = [
  { valor: 'fachada', label: 'Fachada del domicilio' },
  { valor: 'exterior', label: 'Instalación exterior' },
  { valor: 'cableado', label: 'Cableado y sujeción' },
  { valor: 'roseta', label: 'Roseta' },
]

const FOTOS_POR_TECNOLOGIA = {
  ftth: [
    { valor: 'equipo', label: 'ONT / router instalado' },
    { valor: 'potencia', label: 'Nivel óptico' },
  ],
  wireless: [
    { valor: 'equipo', label: 'CPE / antena instalada' },
    { valor: 'potencia', label: 'Alineación y señal' },
  ],
}

const FOTOS_FINALES = [
  { valor: 'velocidad', label: 'Prueba de velocidad' },
  { valor: 'otro', label: 'Otra' },
]

export default function PasoCierre({ orden, onError, onFinalizado, onEncolado }) {
  const confirmar = useConfirmar()
  const archivoRef = useRef(null)

  const tiposDeFoto = [
    ...FOTOS_COMUNES,
    ...(FOTOS_POR_TECNOLOGIA[orden.tecnologia === 'wireless' ? 'wireless' : 'ftth'] ?? []),
    ...FOTOS_FINALES,
  ]

  const [fotos, setFotos] = useState([])
  const [subiendo, setSubiendo] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [finalizando, setFinalizando] = useState(false)

  const [form, setForm] = useState({
    firma_b64: orden.firma_b64 ?? null,
    firmante_nombre: orden.firmante_nombre ?? orden.titular ?? '',
    firmante_identificacion: orden.firmante_identificacion ?? orden.cedula ?? '',
    metros_cable: orden.metros_cable ?? '',
    observaciones: orden.observaciones ?? '',
    tipo_foto: 'equipo',
  })

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  const cargarFotos = useCallback(async () => {
    const { data } = await supabase
      .from('instalacion_fotos')
      .select('*')
      .eq('instalacion_id', orden.id)
      .order('created_at')

    // El bucket es privado, así que cada imagen necesita su URL firmada. Una
    // hora alcanza de sobra para el rato que el técnico tiene la pantalla
    // abierta.
    const conUrl = await Promise.all(
      (data ?? []).map(async (f) => {
        const { data: url } = await supabase.storage
          .from('instalaciones')
          .createSignedUrl(f.ruta, 3600)
        return { ...f, url: url?.signedUrl ?? null }
      }),
    )

    setFotos(conUrl)
  }, [orden.id])

  useEffect(() => {
    cargarFotos()
  }, [cargarFotos])

  async function subirFotos(e) {
    const archivos = Array.from(e.target.files ?? [])
    if (!archivos.length) return

    setSubiendo(true)
    onError?.(null)

    try {
      const { data: sesion } = await supabase.auth.getUser()

      for (const archivo of archivos) {
        // Se achica antes de subir: el técnico está con datos móviles y una
        // foto de 4 MB del celular a veces no llega.
        const blob = await comprimirImagen(archivo)
        const ruta = `${orden.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`

        const { error: errSubida } = await supabase.storage
          .from('instalaciones')
          .upload(ruta, blob, { contentType: 'image/jpeg' })
        if (errSubida) throw errSubida

        const { error } = await supabase.from('instalacion_fotos').insert({
          instalacion_id: orden.id,
          tipo: form.tipo_foto,
          ruta,
          created_by: sesion?.user?.id ?? null,
        })
        if (error) throw error
      }

      await cargarFotos()
    } catch (err) {
      onError?.(err)
    } finally {
      setSubiendo(false)
      if (archivoRef.current) archivoRef.current.value = ''
    }
  }

  async function borrarFoto(f) {
    if (!await confirmar('¿Borrar esta foto?')) return
    await supabase.storage.from('instalaciones').remove([f.ruta])
    await supabase.from('instalacion_fotos').delete().eq('id', f.id)
    await cargarFotos()
  }

  /** Guarda la conformidad sin cerrar: el alta se confirma con el otro botón. */
  async function guardar() {
    setGuardando(true)
    onError?.(null)

    try {
      // Pasa por la cola: si perdió la señal justo al terminar, la firma que
      // acaba de dibujar el cliente no se pierde. Es el dato más caro de
      // recuperar de toda la orden — hay que volver al domicilio.
      await campoApi.guardarOrden(orden.id, {
        firma_b64: form.firma_b64,
        firmante_nombre: form.firmante_nombre.trim() || null,
        firmante_identificacion: form.firmante_identificacion.trim() || null,
        metros_cable: form.metros_cable === '' ? null : Number(form.metros_cable),
        observaciones: form.observaciones.trim() || null,
        // 6 desde que el material se registra antes del cierre: dejarlo en 5
        // haría que una orden ya firmada reabra en el paso de materiales.
        paso: Math.max(Number(orden.paso ?? 0), 6),
      })
      return true
    } catch (err) {
      onError?.(err)
      return false
    } finally {
      setGuardando(false)
    }
  }

  async function finalizar() {
    if (!form.firma_b64) return onError?.(new Error('Falta la firma de conformidad del cliente'))

    // Se guarda primero para que la función de la base valide contra lo que el
    // técnico acaba de escribir y no contra lo que había cuando abrió el paso.
    if (!(await guardar())) return

    setFinalizando(true)
    onError?.(null)

    try {
      /**
       * Un solo botón, con o sin señal.
       *
       * Con conexión finaliza de una y sigue todo igual que antes. Sin
       * conexión, el cierre queda en la cola y sale cuando vuelve la señal.
       *
       * Se puede encolar porque `finalizar_alta_instalacion` es idempotente: si
       * la instalación ya tiene `client_id`, devuelve ese mismo id sin crear
       * otro abonado, y el `FOR UPDATE` serializa dos llamadas simultáneas. Eso
       * se verificó leyendo la función antes de permitir esto — un reintento
       * sobre algo que no lo fuera crearía clientes duplicados.
       */
      const r = await campoApi.finalizarOrden(orden.id)

      if (r.encolado) {
        // Nunca "listo": el cierre no ocurrió todavía. La franja de arriba lo
        // dice y no se puede cerrar; decir "listo" acá haría que el técnico se
        // vaya creyendo que el abonado ya está activo.
        await onEncolado?.()
        return
      }

      // Recién ahora existe el cliente, así que recién ahora se le puede atar el
      // equipo que el técnico descontó en el paso anterior. Es lo que después
      // responde "¿qué equipo tiene este abonado?" sin pasar por la instalación.
      // No lanza si falla: el alta ya está hecha y un error acá haría que el
      // técnico la repita.
      await inventarioApi.vincularEquiposACliente(orden.id, r.data)

      await onFinalizado?.(r.data)
    } catch (err) {
      onError?.(err)
    } finally {
      setFinalizando(false)
    }
  }

  const pendientes = faltantes({ ...orden, firma_b64: form.firma_b64 })

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Quién firma" hint="El nombre de quien recibe el servicio">
          <Input value={form.firmante_nombre} onChange={set('firmante_nombre')} />
        </Field>
        <Field label="Cédula de quien firma">
          <Input
            value={form.firmante_identificacion}
            onChange={set('firmante_identificacion')}
            inputMode="numeric"
          />
        </Field>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-slate-400">
          Firma de conformidad del cliente
        </p>
        <FirmaDigital
          valor={form.firma_b64}
          onCambio={(v) => setForm((f) => ({ ...f, firma_b64: v }))}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Metros de cable usados">
          <Input type="number" min={0} value={form.metros_cable} onChange={set('metros_cable')} />
        </Field>
        <Field label="Qué se va a fotografiar">
          {/* En el orden en que se sacan: se llega, se tiende, se conecta
              adentro, se mide, se prueba. */}
          <Select value={form.tipo_foto} onChange={set('tipo_foto')}>
            {tiposDeFoto.map((t) => (
              <option key={t.valor} value={t.valor}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <input
          ref={archivoRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={subirFotos}
          className="hidden"
        />
        <Button
          type="button"
          icon={Camera}
          onClick={() => archivoRef.current?.click()}
          cargando={subiendo}
          className="w-full"
        >
          Tomar foto de la instalación
        </Button>

        {fotos.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {fotos.map((f) => (
              <div key={f.id} className="group relative overflow-hidden rounded-lg border border-slate-800">
                {f.url ? (
                  <img src={f.url} alt={f.tipo} className="h-24 w-full object-cover" />
                ) : (
                  <div className="grid h-24 place-items-center text-[11px] text-slate-500">
                    sin vista previa
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => borrarFoto(f)}
                  className="absolute right-1 top-1 rounded-full bg-black/70 p-1.5 text-slate-200"
                  aria-label="Borrar la foto"
                >
                  <Trash2 size={12} />
                </button>
                {/* La etiqueta y no el valor crudo: la miniatura decía
                    "potencia", que en radio no le dice nada a nadie. */}
                <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-center text-[10px] text-slate-300">
                  {tiposDeFoto.find((t) => t.valor === f.tipo)?.label ?? f.tipo}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Field label="Observaciones">
        <Textarea
          rows={3}
          value={form.observaciones}
          onChange={set('observaciones')}
          placeholder="Qué quedó pendiente, qué se le explicó al abonado…"
        />
      </Field>

      {pendientes.length > 0 && (
        <Aviso tipo="alerta">
          <p className="font-medium">Todavía falta:</p>
          <ul className="mt-1 list-inside list-disc">
            {pendientes.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Aviso>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Button onClick={guardar} cargando={guardando}>
          Guardar sin cerrar
        </Button>
        <Button
          variante="primario"
          icon={CheckCircle2}
          onClick={finalizar}
          cargando={finalizando}
          disabled={pendientes.length > 0}
        >
          Finalizar alta
        </Button>
      </div>

      <p className="text-center text-xs text-slate-500">
        Al finalizar, el abonado pasa al módulo Usuarios con su plan, su IP y sus datos de conexión.
      </p>
    </div>
  )
}
