import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'

import { CAMPOS_PLANTILLA, mapearColumnas } from '../src/services/migracionAbonados.js'
import { leerPlanilla } from '../src/lib/planilla.js'

/**
 * La plantilla, ida y vuelta.
 *
 * Lo que se prueba acá es el circuito entero sin base de datos: se arma un
 * archivo con la misma forma que genera el sistema, se lo vuelve a leer, y se
 * comprueba que salga lo mismo que entró.
 *
 * Importa porque la configuración que viaja en el archivo es lo que ata a cada
 * abonado con su router. Si esa hoja se lee mal, el padrón entero termina
 * colgado del router equivocado — y eso se descubre cuando el corte por mora no
 * funciona, semanas después.
 */

const ROUTER = 'a1b2c3d4-0000-0000-0000-000000000001'
const PLAN = 'b1b2c3d4-0000-0000-0000-000000000002'

/** Un archivo con las tres hojas, igual que el que genera el servicio. */
async function plantillaDePrueba({ filas = [], config = null, orden = null } = {}) {
  const wb = new ExcelJS.Workbook()

  const armarClientes = () => {
    const h = wb.addWorksheet('Clientes')
    h.addRow(CAMPOS_PLANTILLA.map((c) => c.titulo))
    filas.forEach((f) => h.addRow(f))
  }

  const armarConfig = () => {
    const h = wb.addWorksheet('Configuración')
    h.addRow(['Campo', 'Valor'])
    for (const [k, v] of Object.entries(
      config ?? {
        router_id: ROUTER,
        router: 'PROGRESO',
        tipo_conexion: 'pppoe',
        plan_id: PLAN,
        plan: 'PLAN_HOME',
        modalidad_pago: 'prepago',
        dia_generar_factura: 1,
        canal_preferido: 'whatsapp',
        aplicar_corte: 'si',
      },
    )) {
      h.addRow([k, v])
    }
  }

  const armarAyuda = () => {
    const h = wb.addWorksheet('Instrucciones')
    h.addRow(['Columna', 'Qué va', 'Ejemplo'])
    CAMPOS_PLANTILLA.forEach((c) => h.addRow([c.titulo, c.ayuda, c.ejemplo]))
  }

  // El orden de las hojas se puede alterar: alguien las arrastra en Excel.
  for (const cual of orden ?? ['clientes', 'ayuda', 'config']) {
    if (cual === 'clientes') armarClientes()
    if (cual === 'ayuda') armarAyuda()
    if (cual === 'config') armarConfig()
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

const leer = (bytes) => leerPlanilla({ nombre: 'padron.xlsx', bytes, ExcelJS })

test('la configuración del archivo vuelve entera', async () => {
  const { config } = await leer(await plantillaDePrueba())

  assert.equal(config.router_id, ROUTER, 'sin esto el padrón queda sin router')
  assert.equal(config.router, 'PROGRESO')
  assert.equal(config.tipo_conexion, 'pppoe')
  assert.equal(config.plan_id, PLAN)
  assert.equal(config.canal_preferido, 'whatsapp')
})

test('los abonados se leen de la hoja de clientes, no de las otras', async () => {
  const fila = CAMPOS_PLANTILLA.map((c) => (c.clave === 'nombre' ? 'OÑA RIERA JOSÉ' : ''))
  const { filas, encabezados } = await leer(await plantillaDePrueba({ filas: [fila] }))

  assert.equal(filas.length, 1, 'se coló una fila de otra hoja')
  assert.equal(filas[0]['Nombre Completo'], 'OÑA RIERA JOSÉ')
  assert.deepEqual(encabezados, CAMPOS_PLANTILLA.map((c) => c.titulo))
})

test('reordenar las hojas en Excel no rompe nada', async () => {
  /**
   * Es lo primero que hace alguien que quiere ver las instrucciones primero: las
   * arrastra al frente. Si la hoja de datos se eligiera por posición, se
   * importaría la ayuda como si fueran abonados —y cada columna de la plantilla
   * entraría como un cliente llamado "Código", "Nombre Completo"…—.
   */
  const fila = CAMPOS_PLANTILLA.map((c) => (c.clave === 'nombre' ? 'ANA' : ''))
  const { filas, config } = await leer(
    await plantillaDePrueba({ filas: [fila], orden: ['config', 'ayuda', 'clientes'] }),
  )

  assert.equal(filas.length, 1)
  assert.equal(filas[0]['Nombre Completo'], 'ANA')
  assert.equal(config.router_id, ROUTER, 'la configuración se sigue encontrando por nombre')
})

test('un archivo de otro sistema no trae configuración, y eso no es un error', async () => {
  // Es el caso del export de MikroWisp: no sabe nada de nuestros routers. La
  // pantalla lo detecta por acá y pide el router antes de dejar importar.
  const wb = new ExcelJS.Workbook()
  const h = wb.addWorksheet('Hoja1')
  h.addRow(['Nombre', 'Cédula'])
  h.addRow(['Ana', '123'])

  const { filas, config } = await leer(Buffer.from(await wb.xlsx.writeBuffer()))
  assert.equal(config, null)
  assert.equal(filas.length, 1)
})

test('una hoja de configuración vacía se trata como si no estuviera', async () => {
  const wb = new ExcelJS.Workbook()
  const c = wb.addWorksheet('Configuración')
  c.addRow(['Campo', 'Valor'])
  const h = wb.addWorksheet('Clientes')
  h.addRow(['Nombre', 'Cédula'])
  h.addRow(['Ana', '123'])

  const { config } = await leer(Buffer.from(await wb.xlsx.writeBuffer()))
  assert.equal(config, null, 'una hoja con solo el encabezado no configura nada')
})

test('el CSV nunca trae configuración', async () => {
  // Un CSV no tiene hojas. La pantalla tiene que pedir el router siempre que se
  // suba uno, y esto es lo que se lo dice.
  const r = await leerPlanilla({ nombre: 'padron.csv', bytes: new TextEncoder().encode('nombre;cedula\nAna;123') })
  assert.ok(!r.config)
})
