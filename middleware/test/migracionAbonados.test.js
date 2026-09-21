import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMPOS_PLANTILLA, aFecha, fechaAmbigua, mapearColumnas, normalizarEstado,
} from '../src/services/migracionAbonados.js'

/**
 * Traer la base de abonados de otro sistema.
 *
 * Cada sistema exporta con sus propios encabezados. Pedirle al ISP que renombre
 * veinte columnas antes de importar es pedirle que se equivoque justo con lo
 * más caro que tiene.
 */

describe('reconoce las columnas como las exporta cada sistema', () => {
  test('MikroWisp: identificador numérico y "nombre"', () => {
    const { mapa } = mapearColumnas(['id', 'nombre', 'cedula', 'telefono', 'saldo'])
    assert.equal(mapa.codigo_externo, 'id')
    assert.equal(mapa.nombre, 'nombre')
    assert.equal(mapa.identificacion, 'cedula')
    assert.equal(mapa.saldo, 'saldo')
  })

  test('una planilla con acentos y mayúsculas', () => {
    // "Dirección" y "DIRECCION" son la misma columna.
    const { mapa } = mapearColumnas(['Código', 'Nombre Completo', 'Dirección', 'Teléfono'])
    assert.equal(mapa.codigo_externo, 'Código')
    assert.equal(mapa.nombre, 'Nombre Completo')
    assert.equal(mapa.direccion, 'Dirección')
    assert.equal(mapa.telefono, 'Teléfono')
  })

  test('nombres separados por guiones o espacios', () => {
    const { mapa } = mapearColumnas(['id_cliente', 'razon social', 'dia-pago'])
    assert.equal(mapa.codigo_externo, 'id_cliente')
    assert.equal(mapa.nombre, 'razon social')
    assert.equal(mapa.dia_facturacion, 'dia-pago')
  })

  test('no asigna la misma columna a dos campos', () => {
    // "cliente" podría ser el nombre o el identificador. Una sola vez.
    const { mapa } = mapearColumnas(['cliente', 'nombre'])
    const usadas = Object.values(mapa)
    assert.equal(new Set(usadas).size, usadas.length)
  })

  test('el fijo y el celular no caen en el mismo campo', () => {
    // El celular es el que usa WhatsApp: mezclarlos manda los avisos al fijo.
    const { mapa } = mapearColumnas(['nombre', 'Teléfono', 'Celular'])
    assert.equal(mapa.telefono, 'Teléfono')
    assert.equal(mapa.telefono_movil, 'Celular')
  })

  test('reconoce lo que hace falta para no perder la historia', () => {
    const { mapa } = mapearColumnas([
      'nombre', 'Fecha Instalación', 'Último Pago', 'Serie ONT', 'IP Actual', 'Zona',
    ])
    assert.equal(mapa.fecha_instalacion, 'Fecha Instalación')
    assert.equal(mapa.ultimo_pago, 'Último Pago')
    assert.equal(mapa.serie_onu, 'Serie ONT')
    assert.equal(mapa.ip, 'IP Actual')
    assert.equal(mapa.zona, 'Zona')
  })
})

describe('la plantilla que genera el sistema', () => {
  test('cada columna que ofrece, el importador la entiende', () => {
    /**
     * La prueba que impide el peor error posible de esta pantalla: que la
     * plantilla ofrezca una columna que el importador después ignora. Alguien
     * llenaría quinientas filas con cuidado para nada, y no se enteraría hasta
     * abrir una ficha y ver el campo vacío.
     *
     * Alcanza con que los títulos de la plantilla estén entre los alias.
     */
    const { mapa, sin_reconocer } = mapearColumnas(CAMPOS_PLANTILLA.map((c) => c.titulo))

    assert.deepEqual(sin_reconocer, [], 'la plantilla ofrece columnas que el importador no lee')

    for (const campo of CAMPOS_PLANTILLA) {
      assert.equal(
        mapa[campo.clave],
        campo.titulo,
        `la columna "${campo.titulo}" no cayó en ${campo.clave}`,
      )
    }
  })

  test('cada columna explica qué va y da un ejemplo', () => {
    // La hoja de instrucciones se arma con esto. Una columna sin explicación es
    // una columna que alguien va a llenar mal.
    for (const c of CAMPOS_PLANTILLA) {
      assert.ok(c.ayuda?.length > 20, `"${c.titulo}" no explica qué va`)
      assert.ok(c.ejemplo, `"${c.titulo}" no tiene ejemplo`)
    }
  })

  test('las columnas que Excel arruinaría van como texto', () => {
    /**
     * Excel se come el cero de "0998877665" y convierte una cédula larga en
     * notación científica. Son dos de los datos que más se usan, y se rompen en
     * silencio: nadie revisa quinientos celulares.
     */
    const texto = CAMPOS_PLANTILLA.filter((c) => c.texto).map((c) => c.clave)
    for (const clave of ['identificacion', 'telefono', 'telefono_movil', 'ip', 'codigo_pago', 'serie_onu']) {
      assert.ok(texto.includes(clave), `${clave} tiene que ir con formato de texto`)
    }
  })

  test('están las dos columnas que no se recuperan después', () => {
    const claves = CAMPOS_PLANTILLA.map((c) => c.clave)
    assert.ok(claves.includes('fecha_instalacion'), 'falta la antigüedad del abonado')
    assert.ok(claves.includes('ultimo_pago'), 'falta desde cuándo no paga')
  })
})

describe('lo que no entiende, lo dice', () => {
  test('informa las columnas que no reconoció', () => {
    // Descartarlas en silencio esconde una columna importante con un nombre
    // inesperado, que después nadie sabe dónde quedó.
    const { sin_reconocer } = mapearColumnas(['nombre', 'vendedor', 'contrato_pdf'])
    assert.deepEqual(sin_reconocer, ['vendedor', 'contrato_pdf'])
  })

  test('sin la columna del nombre, avisa cuál falta', () => {
    // Es la única imprescindible: un abonado sin nombre no se puede ni buscar.
    const { faltan } = mapearColumnas(['id', 'telefono'])
    assert.deepEqual(faltan, ['nombre'])
  })

  test('con el nombre alcanza para empezar', () => {
    const { faltan } = mapearColumnas(['nombre'])
    assert.equal(faltan.length, 0)
  })
})

describe('las fechas, que son lo que no se puede perder', () => {
  test('el formato de la base pasa derecho', () => {
    assert.equal(aFecha('2024-01-15'), '2024-01-15')
    assert.equal(aFecha('2024-01-15 08:30:00'), '2024-01-15')
    assert.equal(aFecha('2024-1-5'), '2024-01-05')
  })

  test('día/mes/año, que es como se exporta acá', () => {
    assert.equal(aFecha('15/01/2024'), '2024-01-15')
    assert.equal(aFecha('15-01-2024'), '2024-01-15')
    assert.equal(aFecha('5/1/2024'), '2024-01-05')
    assert.equal(aFecha('15/01/2024 08:30'), '2024-01-15')
  })

  test('un año de dos dígitos no manda al abonado al año 24', () => {
    assert.equal(aFecha('15/01/24'), '2024-01-15')
    assert.equal(aFecha('15/01/98'), '1998-01-15')
  })

  test('una fecha de Excel llega como objeto y se toma en UTC', () => {
    // exceljs arma las fechas en UTC. Pasarlas por la zona local las correría
    // un día para atrás, y una base entera con la antigüedad corrida un día es
    // un error que nadie descubre.
    assert.equal(aFecha(new Date('2024-01-15T00:00:00Z')), '2024-01-15')
  })

  test('lo que no es una fecha no se inventa', () => {
    assert.equal(aFecha(''), null)
    assert.equal(aFecha('sin datos'), null)
    assert.equal(aFecha('35/13/2024'), null)
    assert.equal(aFecha(null), null)
  })

  test('avisa cuando no se puede saber si es día/mes o mes/día', () => {
    // "03/04/2024" es marzo o abril según quién lo escribió. Elegir mal corre
    // la antigüedad de media base sin que nadie lo note, así que se avisa.
    assert.equal(fechaAmbigua('03/04/2024'), true)
    assert.equal(fechaAmbigua('15/01/2024'), false, 'el 15 solo puede ser un día')
    assert.equal(fechaAmbigua('2024-01-15'), false)
    assert.equal(fechaAmbigua(new Date()), false, 'una fecha de Excel ya viene resuelta')
  })
})

describe('los estados de otro sistema', () => {
  test('los habituales se traducen', () => {
    assert.equal(normalizarEstado('Activo'), 'activo')
    assert.equal(normalizarEstado('SUSPENDIDO'), 'suspendido')
    assert.equal(normalizarEstado('Moroso'), 'cortado')
  })

  test('"retirado" es una baja, que es como se llama acá', () => {
    assert.equal(normalizarEstado('retirado'), 'baja')
    assert.equal(normalizarEstado('Cancelado'), 'baja')
    assert.equal(normalizarEstado('inactivo'), 'baja')
  })

  test('lo que no se entiende entra como activo', () => {
    // Es la opción segura: un abonado que en realidad estaba de baja se nota al
    // primer mes; uno activo importado como baja se queda sin servicio hoy.
    assert.equal(normalizarEstado('vip'), 'activo')
    assert.equal(normalizarEstado(''), 'activo')
  })
})
