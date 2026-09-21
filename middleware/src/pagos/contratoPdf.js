import { generarDocumento } from './documentoPdf.js'

/**
 * El contrato de servicio, en PDF.
 *
 * ── Lo que este PDF NO es ──
 *
 * El contrato FIRMADO. Esto genera el papel para imprimir y llevar; la firma se
 * hace aparte y el escaneo se sube a `contratos.documento_url`. Mezclarlos haría
 * creer que un contrato generado ya está aceptado.
 *
 * El dibujo vive en `documentoPdf`, que es el mismo motor de la hoja de
 * instalación y de la impresión de ticket. Lo propio del contrato es quién
 * firma: dos partes, y la que se obliga por el ISP es la RAZÓN SOCIAL — el
 * nombre comercial no se obliga a nada.
 */
export function generarContrato({ plantilla, empresa = {}, cliente = {}, contrato = {}, logo = null }) {
  return generarDocumento({
    plantilla,
    empresa,
    logo,
    firmas: [
      {
        nombre: empresa.razon_social || empresa.nombre_comercial || '',
        pie: 'El proveedor',
      },
      {
        nombre: cliente.nombre ?? '',
        pie: cliente.identificacion ? `C.I./RUC ${cliente.identificacion}` : 'El abonado',
      },
    ],
    pie: contrato.numero ? `Contrato ${contrato.numero}` : '',
  })
}
