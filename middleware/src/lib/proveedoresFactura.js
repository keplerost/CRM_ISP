/**
 * Con quién se emite la factura electrónica en cada país.
 *
 * ── Por qué proveedores y no una integración propia por país ──
 *
 * Cada país tiene su sistema: el SRI firma XAdES por SOAP, la DIAN pide UBL 2.1
 * con habilitación previa, el SAT exige pasar por un PAC, la SUNAT por un OSE.
 * Escribir cada uno desde cero son meses. Un proveedor ya autorizado en el país
 * —OpenFactura, Alegra, Nubefact, Facturama— expone una API de un par de
 * endpoints, y conectarlo es cuestión de días.
 *
 * Ecuador es la excepción: el SRI ya está escrito en `src/sri/` y se habla
 * directo, sin intermediario.
 *
 * ── Qué hay acá ──
 *
 * La lista de proveedores por país y los campos que pide cada uno. La pantalla
 * se arma sola a partir de esto: agregar un proveedor es agregar una entrada.
 *
 * `integrado: false` quiere decir que los datos se cargan y se guardan, pero el
 * envío todavía no está programado. Es lo que permite mostrarle a un ISP de
 * otro país dónde va a poner su API key antes de cerrar la venta, sin mentirle
 * sobre lo que ya funciona.
 *
 * Los campos de los proveedores todavía no integrados salen de su
 * documentación pública: se confirman al programar cada uno.
 */

const MODO_PRUEBA = {
  clave: 'modo_prueba',
  etiqueta: 'Modo prueba',
  tipo: 'interruptor',
  ayuda: 'Emite contra el ambiente de pruebas del proveedor: los comprobantes no tienen validez.',
}

/** "Otros proveedores": para el que el ISP ya usa y no está en la lista. */
const OTRO = {
  id: 'otro',
  nombre: 'Otros proveedores',
  integrado: false,
  descripcion:
    'Si ya trabajás con un proveedor que no está en la lista, cargá sus datos de conexión. Se programa la integración con él.',
  campos: [
    { clave: 'nombre_proveedor', etiqueta: 'Proveedor', tipo: 'texto', requerido: true },
    { clave: 'url_api', etiqueta: 'URL de la API', tipo: 'texto', ayuda: 'La que figura en su documentación' },
    { clave: 'usuario', etiqueta: 'Usuario o correo', tipo: 'texto' },
    { clave: 'api_key', etiqueta: 'API KEY / token', tipo: 'secreto' },
    { clave: 'notas', etiqueta: 'Notas', tipo: 'texto_largo', ayuda: 'Lo que haga falta saber para conectarlo' },
    MODO_PRUEBA,
  ],
}

export const PROVEEDORES = {
  EC: [
    {
      id: 'sri',
      nombre: 'SRI directo',
      integrado: true,
      descripcion:
        'El sistema firma y envía los comprobantes al SRI sin intermediario. El emisor, el certificado de firma y la numeración se configuran en Facturación → Configuración.',
      configuraEn: '/facturacion?t=config',
      campos: [],
    },
  ],
  CL: [
    {
      id: 'openfactura',
      nombre: 'OpenFactura',
      sitio: 'https://www.openfactura.cl',
      integrado: false,
      descripcion: 'De Haulmer. Emite facturas y boletas electrónicas ante el SII.',
      campos: [
        { clave: 'razon_social', etiqueta: 'Razón social emisor', tipo: 'texto', requerido: true },
        { clave: 'rut', etiqueta: 'RUT emisor', tipo: 'texto', requerido: true, ejemplo: '76.123.456-7' },
        { clave: 'giro', etiqueta: 'Giro emisor', tipo: 'texto', ejemplo: 'Servicios de telecomunicaciones' },
        { clave: 'codigo_actividad', etiqueta: 'Código actividad económica', tipo: 'texto', ejemplo: '611090' },
        { clave: 'direccion', etiqueta: 'Dirección emisor', tipo: 'texto' },
        { clave: 'comuna', etiqueta: 'Comuna emisor', tipo: 'texto' },
        { clave: 'telefono', etiqueta: 'Teléfono emisor', tipo: 'texto' },
        { clave: 'codigo_sucursal', etiqueta: 'Código SII sucursal', tipo: 'texto' },
        {
          clave: 'tamano_pdf',
          etiqueta: 'Tamaño PDF',
          tipo: 'opciones',
          opciones: ['LETTER', 'A4', 'TICKET'],
          porDefecto: 'LETTER',
        },
        { clave: 'api_key', etiqueta: 'API KEY', tipo: 'secreto', requerido: true },
        {
          clave: 'usar_direccion_cliente',
          etiqueta: 'Usar la dirección del cliente del sistema',
          tipo: 'interruptor',
          ayuda: 'Si está apagado, la dirección del cliente se toma del SII.',
        },
        MODO_PRUEBA,
      ],
    },
    OTRO,
  ],
  CO: [
    {
      id: 'alegra',
      nombre: 'Alegra',
      sitio: 'https://www.alegra.com',
      integrado: false,
      descripcion: 'Proveedor tecnológico habilitado por la DIAN.',
      campos: [
        { clave: 'usuario', etiqueta: 'Correo de la cuenta', tipo: 'texto', requerido: true },
        { clave: 'token', etiqueta: 'Token de la API', tipo: 'secreto', requerido: true },
        { clave: 'numeracion', etiqueta: 'Numeración (resolución DIAN)', tipo: 'texto', ayuda: 'El id de la numeración autorizada' },
        MODO_PRUEBA,
      ],
    },
    OTRO,
  ],
  PE: [
    {
      id: 'nubefact',
      nombre: 'Nubefact',
      sitio: 'https://www.nubefact.com',
      integrado: false,
      descripcion: 'Operador de Servicios Electrónicos (OSE) autorizado por la SUNAT.',
      campos: [
        { clave: 'ruta', etiqueta: 'Ruta (URL de tu cuenta)', tipo: 'texto', requerido: true, ayuda: 'La que da Nubefact al activar la API' },
        { clave: 'token', etiqueta: 'Token', tipo: 'secreto', requerido: true },
        { clave: 'serie_factura', etiqueta: 'Serie de facturas', tipo: 'texto', ejemplo: 'F001' },
        { clave: 'serie_boleta', etiqueta: 'Serie de boletas', tipo: 'texto', ejemplo: 'B001' },
        MODO_PRUEBA,
      ],
    },
    OTRO,
  ],
  MX: [
    {
      id: 'facturama',
      nombre: 'Facturama',
      sitio: 'https://www.facturama.mx',
      integrado: false,
      descripcion: 'Proveedor de certificación (PAC) para CFDI 4.0 ante el SAT.',
      campos: [
        { clave: 'usuario', etiqueta: 'Usuario de la API', tipo: 'texto', requerido: true },
        { clave: 'contrasena', etiqueta: 'Contraseña de la API', tipo: 'secreto', requerido: true },
        { clave: 'rfc', etiqueta: 'RFC emisor', tipo: 'texto', requerido: true },
        { clave: 'regimen_fiscal', etiqueta: 'Régimen fiscal', tipo: 'texto', ejemplo: '601' },
        { clave: 'cp_expedicion', etiqueta: 'Código postal de expedición', tipo: 'texto', ejemplo: '06600' },
        MODO_PRUEBA,
      ],
    },
    OTRO,
  ],
  AR: [
    {
      id: 'tusfacturas',
      nombre: 'TusFacturasAPP',
      sitio: 'https://www.tusfacturas.app',
      integrado: false,
      descripcion: 'Emite comprobantes electrónicos ante ARCA (ex AFIP).',
      campos: [
        { clave: 'apikey', etiqueta: 'API key', tipo: 'secreto', requerido: true },
        { clave: 'apitoken', etiqueta: 'API token', tipo: 'secreto', requerido: true },
        { clave: 'usertoken', etiqueta: 'User token', tipo: 'secreto', requerido: true },
        { clave: 'punto_venta', etiqueta: 'Punto de venta', tipo: 'texto', ejemplo: '0001' },
        MODO_PRUEBA,
      ],
    },
    OTRO,
  ],
}

/** Los proveedores de un país. Uno sin lista propia tiene solo "Otros proveedores". */
export const proveedoresDe = (pais) => PROVEEDORES[String(pais ?? '').toUpperCase()] ?? [OTRO]

export const proveedorDe = (pais, id) => proveedoresDe(pais).find((p) => p.id === id) ?? null

/**
 * Separa lo que se guarda en claro de lo que va cifrado, y comprueba los
 * obligatorios si se está activando.
 *
 * Un secreto vacío NO borra el guardado: la pantalla nunca lo muestra, así que
 * el formulario llega siempre con esos campos en blanco. Tomarlo al pie de la
 * letra borraría la API key cada vez que alguien corrige el teléfono.
 *
 * @param guardados  { [clave]: true } los secretos que ya tienen valor
 */
export function armarDatos(proveedor, valores = {}, { activo = false, guardados = {} } = {}) {
  const datos = {}
  const secretos = {}
  const faltan = []

  for (const c of proveedor.campos) {
    if (c.clave === 'modo_prueba') continue
    const v = valores[c.clave]

    if (c.tipo === 'secreto') {
      if (v != null && String(v).trim() !== '') secretos[c.clave] = String(v).trim()
      if (c.requerido && activo && !secretos[c.clave] && !guardados[c.clave]) faltan.push(c.etiqueta)
      continue
    }

    if (c.tipo === 'interruptor') {
      datos[c.clave] = Boolean(v)
      continue
    }

    const texto = v == null ? '' : String(v).trim()
    datos[c.clave] = texto || (c.porDefecto ?? null)
    if (c.requerido && activo && !datos[c.clave]) faltan.push(c.etiqueta)
  }

  return { datos, secretos, faltan }
}
