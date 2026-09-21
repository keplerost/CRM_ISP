/**
 * Cola de ejecución por clave: una tarea a la vez para cada clave.
 *
 * Existe por una limitación concreta del hardware: las OLTs del taller admiten
 * muy pocas sesiones SSH simultáneas. Al pasarse contestan "exceed max sessions"
 * y rechazan TODO —incluso las conexiones nuevas— hasta que se liberen las
 * abiertas. Dos clics seguidos en la UI, o dos pestañas, alcanzaban para llegar
 * al tope y dejar el equipo inaccesible por varios minutos.
 *
 * Serializando por equipo, la app nunca abre más de una sesión a la vez contra
 * el mismo host. Equipos distintos siguen trabajando en paralelo.
 */

const colas = new Map()

/**
 * Encola `tarea` bajo `clave` y devuelve su resultado.
 * Las tareas con la misma clave corren de a una, en orden de llegada.
 */
export function enCola(clave, tarea) {
  const previa = colas.get(clave) ?? Promise.resolve()

  // Se pasa `tarea` como manejador de éxito Y de error: así la cadena sigue
  // aunque la operación anterior haya fallado, sin dejar la cola trabada.
  const resultado = previa.then(tarea, tarea)

  // El turno nunca rechaza: es solo la señal de "terminé" para el que sigue.
  const turno = resultado.then(
    () => {},
    () => {},
  )
  colas.set(clave, turno)

  // Si nadie se encoló mientras tanto, sacamos la entrada para no acumular.
  turno.then(() => {
    if (colas.get(clave) === turno) colas.delete(clave)
  })

  return resultado
}

/** Cuántas claves tienen trabajo pendiente. Para tests y diagnóstico. */
export const colasActivas = () => colas.size
