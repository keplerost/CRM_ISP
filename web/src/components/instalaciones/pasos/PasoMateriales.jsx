import MaterialUsado from '../../inventario/MaterialUsado'

/**
 * Paso 5 — qué material se usó.
 *
 * ── Por qué acá y no en bodega ──
 *
 * El único momento en que alguien sabe con certeza que se usaron 45 metros de
 * drop y dos conectores es cuando acaba de usarlos. Si el descuento depende de
 * que el técnico se lo cuente a bodega y bodega lo cargue, no pasa: se olvida
 * uno de los dos, y a fin de mes el inventario no cuadra por un margen que nadie
 * puede explicar. Por eso el descuento sale del almacén del propio técnico y en
 * el asistente, antes del cierre.
 *
 * ── Se puede saltear ──
 *
 * A propósito. Una reinstalación o una visita sin material son casos reales, y
 * un paso obligatorio que a veces no aplica se completa con cualquier cosa con
 * tal de avanzar. Eso ensucia el inventario más que dejarlo vacío.
 *
 * El cuerpo vive en `MaterialUsado` porque el ticket hace exactamente lo mismo:
 * un técnico gastando material en un trabajo. Lo único propio de acá es que la
 * equipo leído en el paso 1 —la ONT en fibra, el CPE en radio— se propone solo.
 */
export default function PasoMateriales({ orden, onError, onGuardado }) {
  return (
    <MaterialUsado
      instalacionId={orden.id}
      serieSugerida={orden.equipo_sn}
      onError={onError}
      onRegistrado={onGuardado}
    />
  )
}
