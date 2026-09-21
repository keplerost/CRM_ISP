import { supabase } from './supabaseClient'

/**
 * Las plantillas: los textos que el sistema le manda al abonado.
 *
 * ── Por qué se agrupan por dónde se usan y no por canal ──
 *
 * Porque la pregunta con la que alguien llega acá es "quiero cambiar lo que dice
 * el recibo" o "quiero cambiar el aviso de corte", no "quiero ver las de correo".
 * Agrupar por canal obliga a saber de antemano por dónde se manda cada cosa —y
 * el aviso de corte se manda por tres canales distintos—.
 */

export const CATEGORIAS = [
  {
    clave: 'documento',
    nombre: 'Documentos',
    para: 'Lo que se imprime o se entrega firmado: comprobantes, hoja de instalación, contrato.',
  },
  {
    clave: 'correo',
    nombre: 'Correos',
    para: 'Los correos automáticos. Cada uno tiene su asunto y su cuerpo.',
  },
  {
    clave: 'sms',
    nombre: 'SMS y Telegram',
    para: 'Mensajes cortos. Un SMS se cobra por tramos de 160 caracteres: uno largo llega partido en dos, y el segundo pedazo llega sin contexto.',
  },
  {
    clave: 'web',
    nombre: 'Páginas web',
    para: 'Lo que ve el abonado en el navegador cuando está por vencer o ya está suspendido.',
  },
]

/**
 * Datos de ejemplo para la vista previa.
 *
 * ── Por qué valores que parecen reales y no "XXX" ──
 *
 * Porque lo que hay que poder juzgar mirando la vista previa es si el texto se
 * ENTIENDE, y con marcadores de relleno no se juzga nada: "Estimado XXX, su
 * factura de XXX por XXX" se lee bien y no dice si el mensaje real va a sonar
 * raro. Con un nombre largo de verdad y un monto con decimales se ve.
 */
export const EJEMPLO = {
  nombre: 'OÑA RIERA JOSÉ LUIS',
  primer_nombre: 'José',
  identificacion: '1712345678',
  codigo: '1042',
  empresa: 'OR IMPORTACIONES',
  ruc: '0504056151001',
  telefono: '0981864229',
  direccion: 'Av. Quito, casa 3',
  plan: 'PLAN_HOME',
  precio: '$20.09',
  ip: '172.16.10.3',
  periodo: 'agosto 2026',
  total: '$20.09',
  monto: '$20.09',
  saldo: '$40.18',
  concepto: 'Servicio de internet · agosto 2026',
  forma_pago: 'Transferencia',
  numero: '000124',
  fecha: '15/08/2026',
  fecha_vencimiento: '05/09/2026',
  fecha_corte: '10/09/2026',
  fecha_instalacion: '14/03/2022',
  dia_pago: '5',
  ticket: '318',
  orden: '1042',
  motivo: 'Sin señal desde anoche',
  respuesta: 'Se cambió el conector en la caja y el servicio quedó normal.',
  tecnico: 'Edison Delgado',
  fecha_visita: 'mañana entre 9 y 12',
  equipo: 'FTTH LA MANA',
  zona: 'GUAMANÍ',
  afectados: '23',
  duracion: '42 minutos',
  serie: 'HWTC6E1B5AB4',
  asunto: 'Sobre su servicio',
  mensaje: 'Le escribimos para comentarle una novedad sobre su servicio.',
}

/** Reemplaza {{marcador}} por su valor. Lo que no se conoce queda a la vista. */
export function aplicar(texto, datos = EJEMPLO) {
  return String(texto ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (original, clave) =>
    datos[clave] != null ? String(datos[clave]) : original,
  )
}

/**
 * Los marcadores que el texto usa de verdad.
 *
 * Se leen del cuerpo y no de la columna `variables`: esa la declaró quien creó
 * la plantilla, y en cuanto alguien edita el texto y agrega un marcador nuevo,
 * las dos listas dejan de coincidir. La que importa es la que está escrita.
 */
export function marcadoresDe(texto) {
  const encontrados = new Set()
  for (const m of String(texto ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    encontrados.add(m[1])
  }
  return [...encontrados]
}

/** Los que se usan pero no tienen con qué llenarse: van a salir crudos. */
export function marcadoresSinValor(texto, datos = EJEMPLO) {
  return marcadoresDe(texto).filter((m) => datos[m] == null)
}

export const plantillasApi = {
  async listar() {
    const { data, error } = await supabase
      .from('plantillas_mensaje')
      .select('*')
      .order('categoria')
      .order('nombre')
    if (error) throw error
    return data ?? []
  },

  async guardar(p) {
    const { id, created_at, ...datos } = p
    const fila = { ...datos, actualizado_en: new Date().toISOString() }

    const { data, error } = id
      ? await supabase.from('plantillas_mensaje').update(fila).eq('id', id).select().single()
      : await supabase.from('plantillas_mensaje').insert(fila).select().single()
    if (error) throw error
    return data
  },

  /**
   * Borrar.
   *
   * La base rechaza las del sistema con un disparador. Acá no se repite esa
   * comprobación: duplicarla haría que el día que cambie la regla haya dos
   * versiones de la verdad. La pantalla solo esconde el botón.
   */
  async borrar(id) {
    const { error } = await supabase.from('plantillas_mensaje').delete().eq('id', id)
    if (error) throw error
  },
}
