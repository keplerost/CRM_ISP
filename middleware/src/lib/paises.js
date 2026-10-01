/**
 * El perfil de cada país: lo que cambia de un ISP a otro según dónde opera.
 *
 * ── Por qué existe ──
 *
 * El sistema nació en Ecuador y se vende también afuera. Hay cosas que son
 * solo nombres —el impuesto se llama IVA, IGV o ITBMS; el documento, cédula,
 * DNI o CURP— y otras que son exigencias legales de un solo país: el
 * comprobante electrónico del SRI, el contrato de adhesión y el reporte de
 * ARCOTEL. Las primeras se resuelven acá. Las segundas se marcan en `modulos`,
 * y lo que no existe en el país no se muestra.
 *
 * ── Lo que NO es ──
 *
 * No es la configuración del ISP: es el punto de partida. Al elegir el país se
 * proponen el impuesto, la moneda y la zona horaria, y cada uno se puede
 * cambiar después en su pantalla.
 *
 * ── Los documentos ──
 *
 * Se guardan con los códigos del SRI (05, 04, 06, 07, 08) porque la base solo
 * acepta esos y la facturación ecuatoriana los necesita tal cual. Acá se usan
 * como ROLES: 05 es el documento de la persona, 04 el identificador fiscal de
 * una empresa, 08 el de un extranjero. Cada país les pone su nombre y su largo.
 *
 * Los datos de cada país se cargaron con lo conocido a 2026. Antes de vender en
 * uno, confirmarlos con un contador local: las tarifas cambian.
 */

const DOC_FIJOS = {
  '06': { nombre: 'Pasaporte' },
  '07': { nombre: 'Consumidor final' },
}

const pais = (p) => ({
  ...p,
  documentos: { ...DOC_FIJOS, ...p.documentos },
  modulos: {
    facturacionElectronica: false,
    reporteRegulador: false,
    contratoRegulador: false,
    ...p.modulos,
  },
})

export const PAISES = [
  pais({
    codigo: 'EC',
    nombre: 'Ecuador',
    impuesto: { nombre: 'IVA', tarifa: 15 },
    ente: { sigla: 'SRI', nombre: 'Servicio de Rentas Internas' },
    regulador: { sigla: 'ARCOTEL', nombre: 'Agencia de Regulación y Control de las Telecomunicaciones' },
    moneda: { simbolo: '$', codigo: 'USD' },
    zona: 'America/Guayaquil',
    prefijo: '+593',
    documentos: {
      '05': { nombre: 'Cédula', largo: 10, ejemplo: '1712345678' },
      '04': { nombre: 'RUC', largo: 13, ejemplo: '1790012345001' },
      '08': { nombre: 'Identificación del exterior' },
    },
    modulos: { facturacionElectronica: true, reporteRegulador: true, contratoRegulador: true },
  }),
  pais({
    codigo: 'CO',
    nombre: 'Colombia',
    impuesto: { nombre: 'IVA', tarifa: 19 },
    ente: { sigla: 'DIAN', nombre: 'Dirección de Impuestos y Aduanas Nacionales' },
    regulador: { sigla: 'CRC', nombre: 'Comisión de Regulación de Comunicaciones' },
    moneda: { simbolo: '$', codigo: 'COP' },
    zona: 'America/Bogota',
    prefijo: '+57',
    documentos: {
      '05': { nombre: 'Cédula de ciudadanía', ejemplo: '1020304050' },
      '04': { nombre: 'NIT', ejemplo: '900123456-7' },
      '08': { nombre: 'Cédula de extranjería' },
    },
  }),
  pais({
    codigo: 'PE',
    nombre: 'Perú',
    impuesto: { nombre: 'IGV', tarifa: 18 },
    ente: { sigla: 'SUNAT', nombre: 'Superintendencia Nacional de Aduanas y de Administración Tributaria' },
    regulador: { sigla: 'OSIPTEL', nombre: 'Organismo Supervisor de Inversión Privada en Telecomunicaciones' },
    moneda: { simbolo: 'S/', codigo: 'PEN' },
    zona: 'America/Lima',
    prefijo: '+51',
    documentos: {
      '05': { nombre: 'DNI', largo: 8, ejemplo: '45678912' },
      '04': { nombre: 'RUC', largo: 11, ejemplo: '20123456789' },
      '08': { nombre: 'Carné de extranjería' },
    },
  }),
  pais({
    codigo: 'MX',
    nombre: 'México',
    impuesto: { nombre: 'IVA', tarifa: 16 },
    ente: { sigla: 'SAT', nombre: 'Servicio de Administración Tributaria' },
    // El IFT se disolvió en 2025; lo reemplaza la Comisión Reguladora de
    // Telecomunicaciones. Confirmar antes de vender ahí.
    regulador: { sigla: 'CRT', nombre: 'Comisión Reguladora de Telecomunicaciones' },
    moneda: { simbolo: '$', codigo: 'MXN' },
    zona: 'America/Mexico_City',
    prefijo: '+52',
    documentos: {
      '05': { nombre: 'CURP', largo: 18, ejemplo: 'GOMJ800101HDFRRN09' },
      '04': { nombre: 'RFC', ejemplo: 'GOMJ800101AB1' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'CL',
    nombre: 'Chile',
    impuesto: { nombre: 'IVA', tarifa: 19 },
    ente: { sigla: 'SII', nombre: 'Servicio de Impuestos Internos' },
    regulador: { sigla: 'SUBTEL', nombre: 'Subsecretaría de Telecomunicaciones' },
    moneda: { simbolo: '$', codigo: 'CLP' },
    zona: 'America/Santiago',
    prefijo: '+56',
    documentos: {
      '05': { nombre: 'RUN', ejemplo: '12.345.678-5' },
      '04': { nombre: 'RUT', ejemplo: '76.123.456-7' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'AR',
    nombre: 'Argentina',
    impuesto: { nombre: 'IVA', tarifa: 21 },
    ente: { sigla: 'ARCA', nombre: 'Agencia de Recaudación y Control Aduanero' },
    regulador: { sigla: 'ENACOM', nombre: 'Ente Nacional de Comunicaciones' },
    moneda: { simbolo: '$', codigo: 'ARS' },
    zona: 'America/Argentina/Buenos_Aires',
    prefijo: '+54',
    documentos: {
      '05': { nombre: 'DNI', ejemplo: '30123456' },
      '04': { nombre: 'CUIT', largo: 11, ejemplo: '30-71234567-8' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'BO',
    nombre: 'Bolivia',
    impuesto: { nombre: 'IVA', tarifa: 13 },
    ente: { sigla: 'SIN', nombre: 'Servicio de Impuestos Nacionales' },
    regulador: { sigla: 'ATT', nombre: 'Autoridad de Regulación y Fiscalización de Telecomunicaciones y Transportes' },
    moneda: { simbolo: 'Bs', codigo: 'BOB' },
    zona: 'America/La_Paz',
    prefijo: '+591',
    documentos: {
      '05': { nombre: 'Carnet de identidad', ejemplo: '6123456' },
      '04': { nombre: 'NIT', ejemplo: '1020304025' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'VE',
    nombre: 'Venezuela',
    impuesto: { nombre: 'IVA', tarifa: 16 },
    ente: { sigla: 'SENIAT', nombre: 'Servicio Nacional Integrado de Administración Aduanera y Tributaria' },
    regulador: { sigla: 'CONATEL', nombre: 'Comisión Nacional de Telecomunicaciones' },
    moneda: { simbolo: 'Bs', codigo: 'VES' },
    zona: 'America/Caracas',
    prefijo: '+58',
    documentos: {
      '05': { nombre: 'Cédula de identidad', ejemplo: 'V-12345678' },
      '04': { nombre: 'RIF', ejemplo: 'J-12345678-9' },
      '08': { nombre: 'Cédula de extranjero' },
    },
  }),
  pais({
    codigo: 'PA',
    nombre: 'Panamá',
    impuesto: { nombre: 'ITBMS', tarifa: 7 },
    ente: { sigla: 'DGI', nombre: 'Dirección General de Ingresos' },
    regulador: { sigla: 'ASEP', nombre: 'Autoridad Nacional de los Servicios Públicos' },
    moneda: { simbolo: '$', codigo: 'USD' },
    zona: 'America/Panama',
    prefijo: '+507',
    documentos: {
      '05': { nombre: 'Cédula', ejemplo: '8-123-456' },
      '04': { nombre: 'RUC', ejemplo: '155612345-2-2019' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'CR',
    nombre: 'Costa Rica',
    impuesto: { nombre: 'IVA', tarifa: 13 },
    ente: { sigla: 'Hacienda', nombre: 'Ministerio de Hacienda' },
    regulador: { sigla: 'SUTEL', nombre: 'Superintendencia de Telecomunicaciones' },
    moneda: { simbolo: '₡', codigo: 'CRC' },
    zona: 'America/Costa_Rica',
    prefijo: '+506',
    documentos: {
      '05': { nombre: 'Cédula física', largo: 9, ejemplo: '112345678' },
      '04': { nombre: 'Cédula jurídica', largo: 10, ejemplo: '3101123456' },
      '08': { nombre: 'DIMEX' },
    },
  }),
  pais({
    codigo: 'GT',
    nombre: 'Guatemala',
    impuesto: { nombre: 'IVA', tarifa: 12 },
    ente: { sigla: 'SAT', nombre: 'Superintendencia de Administración Tributaria' },
    regulador: { sigla: 'SIT', nombre: 'Superintendencia de Telecomunicaciones' },
    moneda: { simbolo: 'Q', codigo: 'GTQ' },
    zona: 'America/Guatemala',
    prefijo: '+502',
    documentos: {
      '05': { nombre: 'DPI', largo: 13, ejemplo: '1234567890101' },
      '04': { nombre: 'NIT', ejemplo: '1234567-8' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'HN',
    nombre: 'Honduras',
    impuesto: { nombre: 'ISV', tarifa: 15 },
    ente: { sigla: 'SAR', nombre: 'Servicio de Administración de Rentas' },
    regulador: { sigla: 'CONATEL', nombre: 'Comisión Nacional de Telecomunicaciones' },
    moneda: { simbolo: 'L', codigo: 'HNL' },
    zona: 'America/Tegucigalpa',
    prefijo: '+504',
    documentos: {
      '05': { nombre: 'DNI', largo: 13, ejemplo: '0801199012345' },
      '04': { nombre: 'RTN', largo: 14, ejemplo: '08011990123456' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'SV',
    nombre: 'El Salvador',
    impuesto: { nombre: 'IVA', tarifa: 13 },
    ente: { sigla: 'MH', nombre: 'Ministerio de Hacienda' },
    regulador: { sigla: 'SIGET', nombre: 'Superintendencia General de Electricidad y Telecomunicaciones' },
    moneda: { simbolo: '$', codigo: 'USD' },
    zona: 'America/El_Salvador',
    prefijo: '+503',
    documentos: {
      '05': { nombre: 'DUI', largo: 9, ejemplo: '01234567-8' },
      '04': { nombre: 'NIT', ejemplo: '0614-010190-101-2' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'NI',
    nombre: 'Nicaragua',
    impuesto: { nombre: 'IVA', tarifa: 15 },
    ente: { sigla: 'DGI', nombre: 'Dirección General de Ingresos' },
    regulador: { sigla: 'TELCOR', nombre: 'Instituto Nicaragüense de Telecomunicaciones y Correos' },
    moneda: { simbolo: 'C$', codigo: 'NIO' },
    zona: 'America/Managua',
    prefijo: '+505',
    documentos: {
      '05': { nombre: 'Cédula', ejemplo: '001-010190-0001A' },
      '04': { nombre: 'RUC', ejemplo: 'J0310000012345' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'DO',
    nombre: 'República Dominicana',
    impuesto: { nombre: 'ITBIS', tarifa: 18 },
    ente: { sigla: 'DGII', nombre: 'Dirección General de Impuestos Internos' },
    regulador: { sigla: 'INDOTEL', nombre: 'Instituto Dominicano de las Telecomunicaciones' },
    moneda: { simbolo: 'RD$', codigo: 'DOP' },
    zona: 'America/Santo_Domingo',
    prefijo: '+1',
    documentos: {
      '05': { nombre: 'Cédula', largo: 11, ejemplo: '00112345678' },
      '04': { nombre: 'RNC', largo: 9, ejemplo: '101123456' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'PY',
    nombre: 'Paraguay',
    impuesto: { nombre: 'IVA', tarifa: 10 },
    ente: { sigla: 'DNIT', nombre: 'Dirección Nacional de Ingresos Tributarios' },
    regulador: { sigla: 'CONATEL', nombre: 'Comisión Nacional de Telecomunicaciones' },
    moneda: { simbolo: '₲', codigo: 'PYG' },
    zona: 'America/Asuncion',
    prefijo: '+595',
    documentos: {
      '05': { nombre: 'Cédula de identidad', ejemplo: '1234567' },
      '04': { nombre: 'RUC', ejemplo: '80012345-6' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  pais({
    codigo: 'UY',
    nombre: 'Uruguay',
    impuesto: { nombre: 'IVA', tarifa: 22 },
    ente: { sigla: 'DGI', nombre: 'Dirección General Impositiva' },
    regulador: { sigla: 'URSEC', nombre: 'Unidad Reguladora de Servicios de Comunicaciones' },
    moneda: { simbolo: '$', codigo: 'UYU' },
    zona: 'America/Montevideo',
    prefijo: '+598',
    documentos: {
      '05': { nombre: 'Cédula de identidad', ejemplo: '1.234.567-8' },
      '04': { nombre: 'RUT', largo: 12, ejemplo: '211234560018' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
  /**
   * Para un país que no está en la lista: nombres genéricos y ningún módulo
   * legal. El ISP pone su impuesto, su moneda y su zona a mano.
   */
  pais({
    codigo: 'XX',
    nombre: 'Otro país',
    impuesto: { nombre: 'IVA', tarifa: 15 },
    ente: { sigla: 'Ente tributario', nombre: 'Ente tributario' },
    regulador: { sigla: 'Regulador', nombre: 'Ente regulador de telecomunicaciones' },
    moneda: { simbolo: '$', codigo: 'USD' },
    zona: 'UTC',
    prefijo: '',
    documentos: {
      '05': { nombre: 'Documento de identidad' },
      '04': { nombre: 'Identificador fiscal' },
      '08': { nombre: 'Documento extranjero' },
    },
  }),
]

export const PAIS_POR_DEFECTO = 'EC'

/** El perfil de un país. Uno desconocido cae a Ecuador: es lo que había antes. */
export const perfilDe = (codigo) =>
  PAISES.find((p) => p.codigo === String(codigo ?? '').toUpperCase()) ??
  PAISES.find((p) => p.codigo === PAIS_POR_DEFECTO)
