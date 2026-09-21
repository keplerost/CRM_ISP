import { supabase } from './supabaseClient'

/**
 * Arma el mensaje de un número de transacción repetido.
 *
 * Decir solo "ya está registrado" obliga a salir a buscar dónde. Con el cliente
 * y el recibo, quien está cobrando resuelve en el momento si es un duplicado de
 * verdad o si tipeó mal un dígito.
 */
export async function errorTransaccionRepetida(numero) {
  const { data } = await supabase
    .from('v_pagos')
    .select('numero, cliente, monto, fecha_pago, forma_pago')
    .eq('n_transaccion', numero)
    .eq('anulado', false)
    .maybeSingle()

  if (!data) {
    return new Error(`El N° de transacción ${numero} ya está registrado en otro cobro.`)
  }

  const fecha = new Date(`${String(data.fecha_pago).slice(0, 10)}T12:00:00`).toLocaleDateString()

  return new Error(
    `El N° ${numero} ya está registrado: recibo N° ${String(data.numero).padStart(6, '0')} ` +
      `de ${data.cliente} por $${Number(data.monto).toFixed(2)} (${data.forma_pago}, ${fecha}). ` +
      'Una transferencia o un recibo se registran una sola vez.',
  )
}
