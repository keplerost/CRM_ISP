import CuentasPago from '../../components/pagos/CuentasPago'

/**
 * Ajustes → Cuentas de cobro.
 *
 * Vivía dentro de Facturación → Configuración, pero las cuentas no son de la
 * facturación: las usan Pagos, Cobros, la conciliación bancaria y la página del
 * abonado cortado. Quien quería cambiar un número de cuenta la buscaba en
 * Ajustes, y los propios avisos del sistema mandaban a "Ajustes → Cuentas de
 * pago", una página que no existía.
 */
export default function CuentasCobroPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Cuentas de cobro</h1>
        <p className="text-sm text-slate-400">
          Las cajas y las cuentas del banco donde entra la plata. Son las que se eligen al registrar
          un pago y las que ve el abonado cortado en “Dónde depositar”.
        </p>
      </div>
      <CuentasPago />
    </div>
  )
}
