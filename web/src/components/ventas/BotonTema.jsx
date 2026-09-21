import { Moon, Sun } from 'lucide-react'

/**
 * El interruptor sol/noche de las pantallas de campo.
 *
 * ── Por qué muestra el destino y no el estado ──
 *
 * En oscuro aparece un sol, porque apretarlo lleva al claro. Es la convención de
 * los teléfonos y la que la gente ya tiene aprendida — mostrar el estado actual
 * hace que la mitad lo apriete al revés.
 *
 * El área de toque es de 44 px aunque el ícono mida 18: es el mínimo con el que
 * se le acierta a un botón caminando, y esta pantalla se usa caminando.
 */
export default function BotonTema({ tema, onAlternar }) {
  const aClaro = tema === 'oscuro'
  return (
    <button
      type="button"
      onClick={onAlternar}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg campo-suave transition hover:campo-txt"
      title={aClaro ? 'Cambiar a claro — se lee mejor al sol' : 'Cambiar a oscuro'}
      aria-label={aClaro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
    >
      {aClaro ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  )
}
