import * as evolution from './evolution.js'
import * as meta from './meta.js'
import * as twilio from './twilio.js'
import * as baileys from './baileys.js'
import * as manual from './manual.js'
import * as crm from './crm.js'

/**
 * Por dónde sale WhatsApp.
 *
 * ── Por qué un driver por vía ──
 *
 * Porque son cinco formas de hacer lo mismo y la elección es del ISP, no del
 * programador: una empresa que arranca usa Evolution porque es gratis, y el día
 * que factura lo suficiente se pasa a la API oficial de Meta. Ese cambio tiene
 * que ser un desplegable en Ajustes, no una tarde de trabajo.
 *
 * Todos exponen lo mismo:
 *
 *     enviar({ config, numero, texto })  → { ok, id?, error?, enlace? }
 *     estado({ config })                 → { conectado, como?, detalle }
 *
 * Y ninguno lanza excepciones: devuelven `{ ok: false, error }`. Un aviso que no
 * salió no puede tumbar la tarea que estaba mandando otros veinte.
 *
 * ── Cuáles sirven para avisos automáticos ──
 *
 * Todas menos `manual`, que solo arma el enlace `wa.me` para que lo mande una
 * persona. A las tres de la mañana no hay nadie apretando ese botón, y por eso
 * `automatico()` existe: la pantalla de alertas lo usa para avisar que con esa
 * vía elegida no va a salir nada solo.
 */

const DRIVERS = { evolution, meta, twilio, baileys, manual, crm }

/** Las que pueden enviar sin que haya una persona delante. */
const AUTOMATICAS = new Set(['evolution', 'meta', 'twilio', 'baileys', 'crm'])

export const automatico = (via) => AUTOMATICAS.has(via)

export const driverDe = (via) => DRIVERS[via] ?? manual

export async function enviarWhatsapp({ via, config, numero, texto }) {
  return driverDe(via).enviar({ config, numero, texto })
}

export async function estadoWhatsapp({ via, config }) {
  const d = driverDe(via)
  return d.estado ? d.estado({ config }) : { conectado: false, detalle: 'Sin estado' }
}

/** Cómo se llama cada una en la pantalla, y qué conviene saber antes de elegirla. */
export const VIAS = [
  {
    clave: 'manual',
    nombre: 'Manual',
    resumen: 'Abre el chat con el texto listo. No envía solo.',
    automatico: false,
    costo: 'gratis',
  },
  {
    clave: 'evolution',
    nombre: 'Evolution API',
    resumen: 'Gratis, con tu propio número. La sesión vive en un servicio aparte.',
    automatico: true,
    costo: 'gratis',
    aviso: 'No es oficial: usá un número distinto al que atiende clientes.',
  },
  {
    clave: 'baileys',
    nombre: 'Baileys',
    resumen: 'Gratis, con tu propio número, adentro del middleware.',
    automatico: true,
    costo: 'gratis',
    aviso: 'No es oficial, y la sesión se cae con cada reinicio del servidor.',
  },
  {
    clave: 'meta',
    nombre: 'Cloud API de Meta',
    resumen: 'Oficial. Sin riesgo de bloqueo.',
    automatico: true,
    costo: 'pago',
    aviso: 'Pide empresa verificada y plantillas aprobadas.',
  },
  {
    clave: 'twilio',
    nombre: 'Twilio',
    resumen: 'La misma API oficial, revendida.',
    automatico: true,
    costo: 'pago',
  },
  {
    clave: 'crm',
    nombre: 'CRM externo',
    resumen: 'Los avisos salen por el mismo número que ya usa tu bot de atención.',
    automatico: true,
    costo: 'según el CRM',
    aviso:
      'El sistema decide qué avisar y cuándo; el CRM lo entrega. Hace falta que cada aviso tenga su nombre del lado de ellos.',
  },
]
