import { supabase } from './supabaseClient'
import { encolar, registrarTipo } from './cola'

/**
 * Qué puede hacer el técnico sin señal.
 *
 * Este archivo es el puente entre la cola —que no sabe nada del negocio— y las
 * tablas. Cada tipo registrado acá es una operación que se puede reintentar sin
 * consecuencias, y esa propiedad hay que comprobarla una por una, no suponerla.
 *
 * ── Qué NO está acá, y por qué ──
 *
 * Las fotos. Una foto de un celular moderno son 3–5 MB, y una instalación lleva
 * seis. Guardar treinta megas por orden en IndexedDB funciona hasta que el
 * navegador decide que la app usa demasiado y borra TODO el almacenamiento —
 * incluida la cola de texto, que es la que importa.
 *
 * Las fotos se suben cuando hay señal. Es una limitación real y la pantalla la
 * dice; fingir que se guardaron y perderlas después es peor que no ofrecerlo.
 */

/* ── 1. Guardar el avance de una orden ──────────────────────────────────────
 *
 * Es un UPDATE sobre una fila que ya existe, con los campos que el técnico
 * acaba de cargar. Reintentarlo escribe los mismos valores otra vez: no hace
 * falta clave de idempotencia porque escribir dos veces lo mismo no duplica
 * nada.
 *
 * Sí importa el ORDEN — por eso la cola despacha en serie. Dos guardados de la
 * misma orden aplicados al revés dejarían los valores viejos encima.
 */
registrarTipo('instalacion.guardar', async ({ id, campos }) => {
  const { error } = await supabase.from('instalaciones').update(campos).eq('id', id)
  if (error) throw error
})

/* ── 2. Descontar material ──────────────────────────────────────────────────
 *
 * Acá la clave es imprescindible: es la operación que, reintentada, deja el
 * inventario mintiendo. El índice único de la migración 84 la rechaza con 23505
 * y la cola lee ese código como "ya estaba".
 */
registrarTipo('material.consumir', async ({ movimientos }, clave) => {
  // Varias líneas del mismo consumo comparten la clave base con un sufijo:
  // cada fila necesita su propia clave única, pero todas tienen que ser
  // estables entre reintentos.
  const filas = movimientos.map((m, i) => ({
    ...m,
    clave_idempotencia: derivar(clave, i),
  }))
  const { error } = await supabase.from('movimientos_inventario').insert(filas)
  if (error) throw error
})

/* ── 3. Cerrar la instalación ───────────────────────────────────────────────
 *
 * La función de la base ya es idempotente: si la instalación tiene `client_id`,
 * devuelve ese mismo id sin crear otro abonado, y el `FOR UPDATE` serializa dos
 * llamadas a la vez. Se comprobó antes de permitir encolarla — es lo que hace
 * posible que el botón sea uno solo.
 */
registrarTipo('instalacion.finalizar', async ({ id }) => {
  const { error } = await supabase.rpc('finalizar_alta_instalacion', { p_instalacion_id: id })
  if (error) throw error
})

/* ── 4. Tocar un ticket: cambiar su estado, o cerrarlo ──────────────────────
 *
 * Un solo tipo para las dos cosas porque son la misma escritura con distintos
 * campos, y porque así el orden entre ellas se respeta solo: "en ruta" y
 * después "resuelto" salen en ese orden de la cola.
 *
 * ── Por qué NO lleva clave de idempotencia ──
 *
 * Se comprobó, no se supuso. El historial del ticket lo escribe un disparador
 * de la base, y está guardado así:
 *
 *     IF NEW.estado IS DISTINCT FROM OLD.estado THEN ... END IF;
 *
 * O sea que reintentar un cierre sobre un ticket ya cerrado no deja un segundo
 * renglón: el estado no cambió, el disparador no dispara. Agregar una clave acá
 * sería protegerse de algo que la base ya impide.
 */
registrarTipo('ticket.actualizar', async ({ id, campos }) => {
  const { error } = await supabase.from('tickets').update(campos).eq('id', id)
  if (error) throw error
})

/**
 * Una clave por línea, derivada de la de la operación.
 *
 * Tiene que ser estable —el mismo índice da siempre la misma clave— y con
 * formato de UUID, porque la columna es UUID. Se reemplazan los últimos dígitos
 * en vez de generar una nueva: así se ve a simple vista que las cinco líneas
 * salieron del mismo consumo.
 */
function derivar(clave, i) {
  const sufijo = String(i).padStart(4, '0')
  return clave.slice(0, -4) + sufijo
}

/* ── La API que usan las pantallas ─────────────────────────────────────────
 *
 * Cada función intenta directo si hay señal y encola si no. Las pantallas no
 * preguntan si hay conexión ni eligen entre dos caminos: llaman a una función y
 * listo.
 *
 * Ese es el punto de todo esto. Un botón "guardar" y otro "guardar sin
 * conexión" obligarían al técnico a decidir algo que el sistema sabe mejor que
 * él, y a equivocarse justo cuando está apurado.
 */
async function intentarOEncolar(tipo, datos, ejecutar) {
  if (navigator.onLine) {
    try {
      return { enviado: true, data: await ejecutar() }
    } catch (err) {
      // Si el fallo es de la conexión, va a la cola. Si es de reglas —falta un
      // dato, RLS lo rechaza— se devuelve al que llamó: encolar un rechazo
      // haría que el técnico se entere del problema mañana.
      if (!esDeConexion(err)) throw err
    }
  }
  await encolar(tipo, datos)
  return { enviado: false, encolado: true }
}

/**
 * ¿Falló por la red?
 *
 * supabase-js devuelve `TypeError: Failed to fetch` cuando no hay salida, y un
 * objeto con `code` cuando el servidor contestó. Un error sin `code` es, casi
 * siempre, que nunca llegó.
 */
const esDeConexion = (err) =>
  !navigator.onLine ||
  !err?.code ||
  err.message?.includes('fetch') ||
  err.message?.includes('network')

export const campoApi = {
  guardarOrden: (id, campos) =>
    intentarOEncolar('instalacion.guardar', { id, campos }, async () => {
      const { error } = await supabase.from('instalaciones').update(campos).eq('id', id)
      if (error) throw error
    }),

  // Devuelve el id del cliente en `data` cuando se ejecutó de verdad. Encolada
  // no puede devolverlo —el cliente todavía no existe— y quien llama tiene que
  // mirar `encolado` antes de usarlo.
  finalizarOrden: (id) =>
    intentarOEncolar('instalacion.finalizar', { id }, async () => {
      const { data, error } = await supabase.rpc('finalizar_alta_instalacion', {
        p_instalacion_id: id,
      })
      if (error) throw error
      return data
    }),

  /** Cerrar el ticket, marcarlo en ruta, cambiarle el estado: es lo mismo. */
  actualizarTicket: (id, campos) =>
    intentarOEncolar('ticket.actualizar', { id, campos }, async () => {
      const { error } = await supabase.from('tickets').update(campos).eq('id', id)
      if (error) throw error
    }),

  consumirMaterial: (movimientos) =>
    intentarOEncolar('material.consumir', { movimientos }, async () => {
      const { error } = await supabase.from('movimientos_inventario').insert(movimientos)
      if (error) throw error
    }),
}
