import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fecha,
  DOCUMENTOS,
  redDeAcceso,
  tipoDeCuenta,
  condicionesPactadas,
} from '../src/services/documentos.js'

/**
 * La fecha de un contrato es un dato con consecuencias: desde cuándo corre el
 * servicio, desde cuándo la permanencia. Equivocarla por un día es de los
 * errores más fáciles de cometer y de los más difíciles de ver.
 */

test('una fecha sola se imprime tal cual, sin pasar por ninguna zona horaria', () => {
  // `new Date('2026-08-12')` es medianoche UTC, que en Ecuador es el 11 a las
  // 19:00. Convertir una fecha que no tiene hora es inventarle una.
  assert.equal(fecha('2026-08-12'), '12/08/2026')
  assert.equal(fecha('2026-01-01'), '01/01/2026')
})

test('un instante sí se convierte a la hora de acá', () => {
  // 02:00 UTC del 10 es todavía el 9 a las 21:00 en Ecuador. Partir el texto
  // imprimiría el día siguiente al que realmente pasó.
  assert.equal(fecha('2026-08-10T02:00:00Z'), '09/08/2026')
  assert.equal(fecha('2026-08-10T17:29:16.525824+00:00'), '10/08/2026')
})

test('lo que falta o no se entiende no rompe el documento', () => {
  assert.equal(fecha(null), '')
  assert.equal(fecha(''), '')
  assert.equal(fecha(undefined), '')
  // Un dato raro se imprime como está: mejor que el abonado vea algo extraño a
  // que lea "Invalid Date" o que no salga el contrato.
  assert.equal(fecha('cuando se instaló'), 'cuando se instaló')
})

test('las seis claves de documento son las que hay en la base', () => {
  // Si alguien renombra una clave acá sin renombrarla en la migración, el
  // documento deja de encontrar su plantilla y no sale.
  assert.deepEqual(Object.values(DOCUMENTOS).sort(), [
    'doc_contrato',
    'doc_factura_sri',
    'doc_hoja_instalacion',
    'doc_recibo',
    'doc_recibo_pos',
    'doc_ticket',
  ])
})

/**
 * La red de acceso y el tipo de cuenta del anexo 1f.
 *
 * Los dos se venían adivinando, y las dos deducciones tenían el mismo problema:
 * acertaban en el caso común y mentían en el resto sin que nadie lo notara.
 */

test('lo que el ISP eligió manda sobre la deducción', () => {
  // Un abonado con ONT al que se le declara coaxial: la ONT no puede ganarle a
  // lo que alguien escribió a propósito.
  assert.equal(redDeAcceso({ elegida: 'coaxial', tieneOnt: true }), 'Coaxial')
  assert.equal(redDeAcceso({ elegida: 'par_cobre', tecnologia: 'ftth' }), 'Par de Cobre')
  assert.equal(tipoDeCuenta({ elegido: 'cibercafe', categoriaPlan: 'residencial' }), 'Cibercafé')
})

test('sin elegir, se deduce como se venía haciendo', () => {
  assert.equal(redDeAcceso({ tecnologia: 'ftth' }), 'Fibra óptica')
  assert.equal(redDeAcceso({ tieneOnt: true }), 'Fibra óptica')
  assert.equal(redDeAcceso({ tecnologia: 'wireless' }), 'Inalámbrico')
  assert.equal(redDeAcceso({}), 'Inalámbrico')

  assert.equal(tipoDeCuenta({ categoriaPlan: 'corporativo' }), 'Corporativo')
  assert.equal(tipoDeCuenta({ categoriaPlan: 'residencial' }), 'Residencial')
  assert.equal(tipoDeCuenta({}), 'Residencial')
})

test('la tecnología es "ftth", no "fibra"', () => {
  /**
   * Así la guarda el catálogo. El código comparaba contra 'fibra' —una cadena
   * que no existe en la base— y por eso TODA orden de fibra sin ONT cargada
   * declaraba "Inalámbrico" en el contrato.
   *
   * Lo encontró una prueba contra datos reales, no una lectura del código.
   */
  assert.equal(redDeAcceso({ tecnologia: 'ftth' }), 'Fibra óptica')
  assert.equal(
    redDeAcceso({ tecnologia: 'fibra' }),
    'Inalámbrico',
    'esa cadena no existe en el catálogo: si algún día existe, hay que agregarla acá',
  )
})

test('un valor que no está en el anexo no se imprime', () => {
  // Si alguien mete una clave inventada en la base, el contrato no puede
  // imprimirla: el anexo solo admite sus cinco opciones. Se cae a la deducción.
  assert.equal(redDeAcceso({ elegida: 'satelital', tecnologia: 'ftth' }), 'Fibra óptica')
  assert.equal(tipoDeCuenta({ elegido: 'gubernamental' }), 'Residencial')
})

test('el cibercafé solo sale bien si alguien lo eligió', () => {
  // La categoría del plan tiene tres valores y ninguno es cibercafé, así que la
  // deducción no puede producirlo nunca. Es exactamente el caso que motivó el
  // campo.
  assert.equal(tipoDeCuenta({ categoriaPlan: 'otro' }), 'Residencial')
  assert.equal(tipoDeCuenta({ elegido: 'cibercafe' }), 'Cibercafé')
})

/**
 * La permanencia y la instalación.
 *
 * Son las dos caras del mismo trato y por eso se resuelven juntas: la
 * permanencia es la contrapartida de la instalación gratis. Separarlas es cómo
 * se llega a un contrato que se contradice dentro de la misma hoja.
 */

const PRESTADOR = {
  permanencia_meses: 24,
  valor_instalacion: 160,
  beneficios_permanencia: 'Instalación de servicio de internet',
  beneficio_anexo: 'INSTALACIÓN GRATIS',
  costo_no_permanencia: 'EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN',
}

test('sin pactar nada distinto, valen las condiciones del prestador', () => {
  const c = condicionesPactadas({ prestador: PRESTADOR })

  assert.equal(c.permanencia, '2 años')
  assert.equal(c.valor_instalacion, 160)
  assert.equal(c.hay_permanencia, true)
  assert.equal(c.beneficio_anexo, 'INSTALACIÓN GRATIS')
})

test('el que paga la instalación no queda atado a nada', () => {
  /**
   * Es el caso que motivó todo esto. Antes, con la permanencia guardada en el
   * prestador, el que pagaba los $160 firmaba igual dos años de permanencia — y
   * el anexo le declaraba "INSTALACIÓN GRATIS" como beneficio de una
   * permanencia que estaba pagando.
   */
  const c = condicionesPactadas({
    pactado: { permanencia_meses: 0, valor_instalacion: 160 },
    prestador: PRESTADOR,
  })

  assert.equal(c.hay_permanencia, false)
  assert.equal(c.valor_instalacion, 160)
  assert.match(c.beneficio_anexo, /No aplica/)
  assert.match(c.costo_no_permanencia, /No aplica/)
  assert.equal(c.beneficios, '', 'la cláusula quinta no enumera beneficios que no hay')
})

test('el cero pactado no se confunde con el campo vacío', () => {
  /**
   * `??` y no `||`. Con `||`, un cero —"sin permanencia", "instalación
   * gratis"— caería al valor del prestador y el contrato diría lo contrario de
   * lo que se pactó.
   */
  const cero = condicionesPactadas({
    pactado: { permanencia_meses: 0, valor_instalacion: 0 },
    prestador: PRESTADOR,
  })
  assert.equal(cero.permanencia_meses, 0)
  assert.equal(cero.valor_instalacion, 0)

  const vacio = condicionesPactadas({
    pactado: { permanencia_meses: null, valor_instalacion: undefined },
    prestador: PRESTADOR,
  })
  assert.equal(vacio.permanencia_meses, 24)
  assert.equal(vacio.valor_instalacion, 160)
})

test('el local comercial pacta un año con instalación gratis', () => {
  const c = condicionesPactadas({
    pactado: { permanencia_meses: 12, valor_instalacion: 0 },
    prestador: PRESTADOR,
  })

  assert.equal(c.permanencia, '1 año', 'en singular: "1 años" se lee como un error')
  assert.equal(c.valor_instalacion, 0)
  assert.equal(c.hay_permanencia, true)
  assert.equal(c.beneficio_anexo, 'INSTALACIÓN GRATIS')
})

test('sin permanencia, los textos dicen No aplica y no quedan en blanco', () => {
  // Un renglón vacío en un contrato se lee como un dato que falta, y alguien lo
  // va a completar a mano con lo que le parezca.
  const c = condicionesPactadas({ pactado: { permanencia_meses: 0 }, prestador: PRESTADOR })

  assert.ok(c.beneficio_anexo.trim().length > 0)
  assert.ok(c.costo_no_permanencia.trim().length > 0)
})

test('sin prestador configurado no rompe: sale sin permanencia', () => {
  const c = condicionesPactadas({})
  assert.equal(c.hay_permanencia, false)
  assert.equal(c.valor_instalacion, 0)
})

test('la cláusula quinta PREGUNTA por lo ofrecido, no por lo pactado', () => {
  /**
   * Salió de mirar el PDF impreso, no el código: al que paga la instalación el
   * contrato le preguntaba "¿se acoge al periodo de permanencia mínima de 0
   * meses?", que no significa nada.
   *
   * La cláusula es una pregunta y existe para que el abonado la conteste: lleva
   * lo que el ISP ofrece. El resultado va en la casilla y en el anexo.
   */
  const noSeAcoge = condicionesPactadas({
    pactado: { permanencia_meses: 0 },
    prestador: PRESTADOR,
  })

  assert.equal(noSeAcoge.permanencia_ofrecida, '2 años', 'la pregunta ofrece los 24 meses')
  assert.equal(noSeAcoge.permanencia, 'No aplica', 'el anexo declara que no se acogió')
  assert.equal(noSeAcoge.hay_permanencia, false, 'y la casilla queda en NO')

  // Al que sí se acoge, las dos coinciden.
  const seAcoge = condicionesPactadas({
    pactado: { permanencia_meses: 24 },
    prestador: PRESTADOR,
  })
  assert.equal(seAcoge.permanencia_ofrecida, '2 años')
  assert.equal(seAcoge.permanencia, '2 años')
})

test('el comercial pacta menos de lo ofrecido y las dos se distinguen', () => {
  // El local se acoge, pero a un año en vez de dos: la pregunta sigue ofreciendo
  // los dos años del ISP y el anexo declara el año pactado.
  const c = condicionesPactadas({
    pactado: { permanencia_meses: 12, valor_instalacion: 0 },
    prestador: PRESTADOR,
  })

  assert.equal(c.permanencia_ofrecida, '2 años')
  assert.equal(c.permanencia, '1 año')
  assert.equal(c.hay_permanencia, true)
})
