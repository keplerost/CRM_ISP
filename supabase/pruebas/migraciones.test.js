import test from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MIGRACIONES, correrCadena, crearBase, fila, numero, sesion } from './base.mjs'

/**
 * Las migraciones, corridas de verdad.
 *
 * ── El orden importa ──
 *
 * Las pruebas de este archivo comparten una sola base y se apoyan una en la
 * anterior: primero se construye el esquema, después se lo usa. `node:test` las
 * corre en orden dentro del archivo, que es lo que permite armar un escenario
 * completo sin repetir la carga —que son diez segundos— en cada prueba.
 *
 * ── Qué se afirma ──
 *
 *   1. Que las 110 migraciones apliquen limpio, en orden, sobre una base vacía.
 *   2. Que las 8 del módulo de comisiones se puedan volver a correr sin romper
 *      nada, que es lo que promete la cabecera de cada una.
 *   3. Que las funciones EJECUTEN. Crear una función no prueba nada: plpgsql
 *      compila el cuerpo recién al invocarla.
 *   4. Que una venta recorra el circuito entero y dé el número correcto.
 *   5. Que los controles digan que no cuando corresponde.
 */

const MODULO = 97 // desde acá empieza el motor de comisiones

let db
let ids = {}

// El mes en curso: el esquema que carga la 97 rige desde su día 1, así que un
// escenario con fechas del mes pasado quedaría fuera de su vigencia y el motor
// —con razón— lo saltearía.
const ESTE_MES = "DATE_TRUNC('month', CURRENT_DATE)"

test('la cadena completa aplica limpio sobre una base vacía', async () => {
  db = await crearBase()
  const fallos = await correrCadena(db)

  for (const f of fallos) console.error(`  ${f.archivo}: ${f.mensaje}\n    ${f.detalle}`)
  assert.equal(fallos.length, 0, `${fallos.length} migraciones fallaron`)
  assert.ok(MIGRACIONES.length > 100, 'no se encontraron las migraciones')
})

test('las migraciones nuevas se pueden volver a correr', async () => {
  // Es lo que dice la cabecera de cada una, y lo que alguien va a hacer el día
  // que no esté seguro de si ya corrió alguna.
  //
  // El corte va en la 97 —donde empieza el módulo de comisiones— y se lleva
  // todo lo que venga después. No se cuenta cuántas son a propósito: una cuenta
  // fija convierte "agregué una migración" en una prueba en rojo que no dice
  // nada, y la que importa —que reejecutar no rompa— ya está más abajo.
  const nuevas = MIGRACIONES.filter((f) => numero(f) >= MODULO)
  assert.ok(nuevas.length >= 8, `se esperaban al menos 8 migraciones nuevas, hay ${nuevas.length}`)

  const fallos = await correrCadena(db, { desde: MODULO })
  for (const f of fallos) console.error(`  ${f.archivo}: ${f.mensaje}`)
  assert.equal(fallos.length, 0, 'alguna no es idempotente')
})

/**
 * El esquema completo: vistas con sus columnas, opciones y permisos.
 *
 * Es la foto que permite comparar "antes y después" de reejecutar. Sin ella, una
 * migración puede dejar el esquema distinto sin dar ningún error.
 */
async function esquema() {
  const r = await db.query(`
    SELECT c.relname AS vista,
           string_agg(k.column_name, ',' ORDER BY k.ordinal_position) AS columnas,
           COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), 'off') AS invoker,
           (SELECT COUNT(*) FROM information_schema.role_table_grants g
             WHERE g.table_name = c.relname AND g.grantee = 'authenticated') AS permisos
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN information_schema.columns k
        ON k.table_name = c.relname AND k.table_schema = 'public'
     WHERE c.relkind = 'v'
     GROUP BY c.relname, c.reloptions
     ORDER BY c.relname`)
  return Object.fromEntries(r.rows.map((v) => [v.vista, v]))
}

test('la cadena entera se puede volver a correr sin cambiar el esquema', async () => {
  /**
   * ── Las dos mitades de esta prueba ──
   *
   * Que no falle es la mitad fácil. La difícil es que no CAMBIE nada: una
   * migración vieja que se reejecuta puede reemplazar una vista por su versión
   * de hace un año sin dar ningún error, y ahí el sistema sigue "funcionando"
   * mientras las pantallas pierden columnas.
   *
   * Tres cosas que pasaron de verdad y que esta comparación ataja:
   *
   *   · La 37 rehace dos vistas con CASCADE y devuelve las catorce que colgaban.
   *     Si alguna volviera sin su `security_invoker`, la cartera comercial
   *     quedaría abierta para cualquiera con sesión.
   *   · La 49 resucitaba una vista y una columna que la 50 había quitado a
   *     propósito, deshaciendo en silencio una corrección posterior.
   *   · Media docena de migraciones rehacen `v_clientes_ficha`, `v_pagos` o
   *     `v_prospectos` con la definición que tenían en su momento.
   *
   * Ninguna de las tres aparece como error.
   */
  const antes = await esquema()

  const fallos = await correrCadena(db)
  for (const f of fallos) console.error(`  ${f.archivo}: ${f.mensaje}\n    ${f.detalle}`)
  assert.equal(fallos.length, 0, `${fallos.length} migraciones fallaron al reejecutarse`)

  const despues = await esquema()

  const desaparecidas = Object.keys(antes).filter((v) => !despues[v])
  const aparecidas = Object.keys(despues).filter((v) => !antes[v])
  const cambiadas = Object.keys(antes).filter(
    (v) => despues[v] && antes[v].columnas !== despues[v].columnas,
  )
  const sinRls = Object.keys(antes).filter(
    (v) => antes[v].invoker === 'true' && despues[v]?.invoker !== 'true',
  )
  const sinPermiso = Object.keys(antes).filter(
    (v) => Number(antes[v].permisos) > 0 && Number(despues[v]?.permisos ?? 0) === 0,
  )

  for (const v of cambiadas) {
    console.error(`  ${v}\n    antes:   ${antes[v].columnas}\n    después: ${despues[v].columnas}`)
  }

  assert.deepEqual(desaparecidas, [], 'reejecutar se llevó puestas vistas')
  assert.deepEqual(aparecidas, [], 'reejecutar resucitó vistas que una migración posterior quitó')
  assert.deepEqual(cambiadas, [], 'reejecutar cambió las columnas de una vista')
  assert.deepEqual(sinRls, [], 'reejecutar dejó vistas sin security_invoker: es un agujero de RLS')
  assert.deepEqual(sinPermiso, [], 'reejecutar dejó vistas sin el GRANT a authenticated')
})

test('ninguna función perdió su SECURITY DEFINER', async () => {
  /**
   * ── Por qué esta prueba existe ──
   *
   * `CREATE OR REPLACE FUNCTION` **borra** los atributos de seguridad: si la
   * definición nueva no repite `SECURITY DEFINER`, la función vuelve al modo
   * invoker sin un aviso, sin un error y sin que nada deje de compilar.
   *
   * Ya pasó. La 70 dejó `finalizar_alta_instalacion` como DEFINER para que el
   * técnico pudiera cerrar su alta sin permiso para editar abonados. La 94 y la
   * 96 la recrearon para agregarle el traslado y la IP fija, sin repetir la
   * marca, y el alta en campo quedó rota para todos los técnicos: al finalizar,
   * "new row violates row-level security policy for table clientes".
   *
   * Nadie lo vio durante meses porque hay que completar los seis pasos de una
   * instalación para llegar ahí.
   *
   * La prueba lee del SQL qué funciones se declaran DEFINER —tanto en su
   * definición como por `ALTER FUNCTION`— y compara contra cómo quedaron.
   */
  const sql = MIGRACIONES.map((f) =>
    readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), f), 'utf8'),
  ).join('\n')

  const esperadas = new Set()
  // Las que lo declaran al crearse: se busca el nombre hacia atrás desde la marca.
  for (const m of sql.matchAll(
    /CREATE (?:OR REPLACE )?FUNCTION\s+(\w+)\s*\([^)]*\)[\s\S]{0,400}?SECURITY DEFINER/g,
  )) {
    esperadas.add(m[1])
  }
  // Y las que la reciben por ALTER.
  for (const m of sql.matchAll(/ALTER FUNCTION\s+(\w+)\s*\([^)]*\)\s+SECURITY DEFINER/g)) {
    esperadas.add(m[1])
  }

  assert.ok(esperadas.size > 20, `se esperaban muchas funciones DEFINER, se detectaron ${esperadas.size}`)

  const r = await db.query(
    `SELECT p.proname, p.prosecdef
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname = ANY($1)`,
    [[...esperadas]],
  )

  const invoker = r.rows.filter((x) => !x.prosecdef).map((x) => x.proname)
  for (const f of invoker) {
    console.error(`  ${f} se declara SECURITY DEFINER en el SQL pero quedó como invoker`)
  }
  assert.deepEqual(invoker, [], 'alguna función perdió su SECURITY DEFINER al recrearse')
})

test('las funciones del módulo se ejecutan con la base vacía', async () => {
  // Acá es donde aparecen las columnas ambiguas y los tipos que no cierran.
  const llamadas = [
    'SELECT * FROM generar_comisiones()',
    'SELECT * FROM evaluar_cohortes()',
    'SELECT * FROM generar_retiros_equipo()',
    'SELECT * FROM detectar_reactivaciones()',
    'SELECT * FROM verificar_comisiones()',
    'SELECT meses_sin_pago(gen_random_uuid())',
    'SELECT bono_de_calidad(esquema_comisiones_vigente(), 92)',
    `SELECT * FROM cerrar_periodo_comisiones((${ESTE_MES} - INTERVAL '1 month')::DATE, NULL, TRUE)`,
  ]

  for (const sql of llamadas) {
    await assert.doesNotReject(() => db.query(sql), `falló: ${sql}`)
  }
})

test('las vistas del módulo responden', async () => {
  const vistas = [
    'v_comision_esquema',
    'v_comision_bases',
    'v_comision_ventas',
    'v_comision_resumen',
    'v_comision_periodos',
    'v_comision_cohortes',
    'v_comision_embudo',
    'v_comision_kpis',
    'v_comision_equipo',
    'v_comision_por_plan',
    'v_cartera_kpis',
    'v_cartera_en_riesgo',
    'v_retiros_equipo',
    'v_retiros_resumen',
    'v_reactivaciones',
    'v_validaciones',
    'v_auditoria_comisiones',
    'v_comercial_vendedor',
  ]

  for (const v of vistas) {
    await assert.doesNotReject(() => db.query(`SELECT * FROM ${v}`), `falló la vista ${v}`)
  }
})

test('una venta recorre el circuito entero y da el número correcto', async () => {
  // ── El escenario ──
  // Un plan de $10 de base, una vendedora y tres abonados instalados y activos.
  ids.plan = (
    await fila(
      db,
      `INSERT INTO planes_velocidad (nombre, bajada_kbps, subida_kbps, precio)
       VALUES ('50 Mbps', 50000, 25000, 20) RETURNING id`,
    )
  ).id

  await db.exec(`INSERT INTO comision_bases_plan (esquema_id, plan_id, base, comisiona)
                 VALUES (esquema_comisiones_vigente(), '${ids.plan}', 10, TRUE)`)

  ids.vendedora = (
    await fila(
      db,
      `INSERT INTO usuarios_sistema (nombre, apellido, usuario, email, rol, activo, permisos, auth_id)
       VALUES ('Ana', 'Pérez', 'ana', 'ana@ejemplo.com', 'vendedor', TRUE,
               '["comisiones.ver_propias"]'::jsonb, gen_random_uuid())
       RETURNING id, auth_id`,
    )
  ).id

  ids.clientes = []
  for (const nombre of ['Juan', 'Rosa', 'Luis']) {
    const c = (
      await fila(
        db,
        `INSERT INTO clientes (nombre, plan_id, estado, activado_en, fecha_instalacion)
         VALUES ('${nombre}', '${ids.plan}', 'activo',
                 ${ESTE_MES} + INTERVAL '5 days', (${ESTE_MES} + INTERVAL '5 days')::DATE)
         RETURNING id`,
      )
    ).id
    ids.clientes.push(c)

    await db.exec(`
      INSERT INTO prospectos (nombre, telefono, vendedor_id, cliente_id, estado, ganado_en, tipo_operacion)
      VALUES ('${nombre}', '0999999999', '${ids.vendedora}', '${c}', 'ganado',
              ${ESTE_MES} + INTERVAL '2 days', 'nueva');

      INSERT INTO instalaciones (client_id, tipo, estado, fecha, alta_at)
      VALUES ('${c}', 'nueva', 'hecha',
              (${ESTE_MES} + INTERVAL '5 days')::DATE, ${ESTE_MES} + INTERVAL '5 days');
    `)
  }

  // ── El motor ──
  const gen = await fila(db, 'SELECT * FROM generar_comisiones()')
  assert.equal(gen.creadas, 3)
  assert.equal(gen.comisionables, 3, 'las tres tenían que quedar comisionables')

  const sinFaltantes = await db.query(
    'SELECT cliente, le_falta FROM v_comision_ventas ORDER BY cliente',
  )
  assert.equal(sinFaltantes.rows.length, 3)
  for (const v of sinFaltantes.rows) {
    assert.equal(v.le_falta, null, `a ${v.cliente} le falta algo: ${v.le_falta}`)
  }

  // 3 ventas × base 10 = 30, nivel Inicial (1–10 ventas) al 20 % → 6,00.
  // Es el mismo resultado que da `calcular()` en el navegador, y esa es la
  // igualdad que sostiene todo el módulo: lo que el vendedor ve mientras vende
  // y lo que la base paga a fin de mes.
  const r = await fila(db, 'SELECT * FROM v_comision_resumen')
  assert.equal(r.ventas_validas, 3)
  assert.equal(Number(r.base_total), 30)
  assert.equal(r.nivel, 'Inicial')
  assert.equal(Number(r.porcentaje), 20)
  assert.equal(Number(r.monto), 6)

  // ── El cierre ──
  // Forzado porque el mes en curso todavía no se puede cerrar: hay ventas en
  // período de cortesía.
  const cierre = await fila(
    db,
    `SELECT * FROM cerrar_periodo_comisiones(${ESTE_MES}::DATE, NULL, TRUE)`,
  )
  assert.equal(cierre.res_estado, 'cerrado')
  assert.equal(Number(cierre.res_monto), 6)

  const p = await fila(db, 'SELECT * FROM v_comision_periodos')
  ids.periodo = p.id
  assert.equal(Number(p.monto), 6)
  assert.equal(Number(p.total_a_pagar), 6)
  assert.equal(p.estado, 'cerrado')
})

test('aprobar y pagar exigen legajo, permiso y el orden correcto', async () => {
  // Sin sesión: la acción se rechaza en vez de quedar registrada sin responsable.
  await sesion(db, null)
  await assert.rejects(
    () => db.query(`SELECT * FROM mover_periodo_comisiones('${ids.periodo}', 'aprobado')`),
    /legajo/,
    'dejó aprobar sin que quede quién lo hizo',
  )

  // Con la sesión de la vendedora: tiene legajo, pero no el permiso.
  const ana = await fila(db, `SELECT auth_id FROM usuarios_sistema WHERE id = '${ids.vendedora}'`)
  await sesion(db, ana.auth_id)
  await assert.rejects(
    () => db.query(`SELECT * FROM mover_periodo_comisiones('${ids.periodo}', 'aprobado')`),
    /permiso/,
    'una vendedora pudo aprobar su propia comisión',
  )

  // Con la de administración: sí.
  const marta = await fila(
    db,
    `INSERT INTO usuarios_sistema (nombre, apellido, usuario, email, rol, activo, permisos, auth_id)
     VALUES ('Marta', 'Gestión', 'marta', 'marta@ejemplo.com', 'super_admin', TRUE,
             '["*"]'::jsonb, gen_random_uuid())
     RETURNING id, auth_id`,
  )
  ids.admin = marta.id
  await sesion(db, marta.auth_id)

  await db.query(`SELECT * FROM mover_periodo_comisiones('${ids.periodo}', 'aprobado', 'Revisado')`)
  await db.query(`SELECT * FROM mover_periodo_comisiones('${ids.periodo}', 'pagado', 'Transferido')`)

  const p = await fila(db, `SELECT * FROM comision_periodos WHERE id = '${ids.periodo}'`)
  assert.equal(p.estado, 'pagado')
  assert.ok(p.aprobado_por, 'quedó aprobado sin firma')
  assert.ok(p.pagado_por, 'quedó pagado sin firma')

  // Y no se puede volver atrás: un período pagado no se reaprueba.
  await assert.rejects(
    () => db.query(`SELECT * FROM mover_periodo_comisiones('${ids.periodo}', 'aprobado')`),
    /cerrado/,
  )
})

test('la calidad deja afuera las bajas que no son del vendedor', async () => {
  const motivo = await fila(
    db,
    'SELECT id, nombre FROM motivos_baja WHERE NOT afecta_calidad ORDER BY orden LIMIT 1',
  )

  await db.query(`SELECT * FROM dar_de_baja_cliente('${ids.clientes[0]}', '${motivo.id}', 'Se mudó')`)
  await db.query('SELECT * FROM evaluar_cohortes()')

  const c = await fila(db, 'SELECT * FROM v_comision_cohortes')
  // El que se fue por un motivo que no depende de quien vendió sale del
  // denominador: ni suma ni resta. Es el punto 17.
  assert.equal(c.evaluables, 2)
  assert.equal(c.conservados, 2)
  assert.equal(c.excluidos, 1)
  assert.equal(Number(c.calidad), 100)
  // Y el bono es cero igual, porque no llega al mínimo de clientes evaluables.
  assert.equal(Number(c.bono), 0)
  assert.match(c.detalle, /al menos/)
})

test('el disparador de auditoría registra el antes y el después', async () => {
  const antes = await fila(
    db,
    "SELECT COUNT(*)::int n FROM auditoria_sistema WHERE accion = 'comisiones.regla_cambiada'",
  )

  await db.exec(`UPDATE comision_niveles SET porcentaje = porcentaje + 1
                  WHERE id = (SELECT id FROM comision_niveles ORDER BY orden LIMIT 1)`)

  const a = await fila(
    db,
    `SELECT usuario_nombre, descripcion, campos FROM v_auditoria_comisiones
      WHERE accion = 'comisiones.regla_cambiada' ORDER BY creado_en DESC LIMIT 1`,
  )
  assert.equal(a.usuario_nombre, 'Marta Gestión', 'no quedó quién lo cambió')
  assert.deepEqual(a.campos.porcentaje, [20, 21], 'no quedó el valor anterior y el nuevo')

  // Guardar sin cambiar nada no deja renglón: la pantalla escribe las cuatro
  // tablas de una sola vez y, sin este filtro, el cambio real quedaría escondido
  // entre veinte renglones idénticos.
  const medio = await fila(
    db,
    "SELECT COUNT(*)::int n FROM auditoria_sistema WHERE accion = 'comisiones.regla_cambiada'",
  )
  await db.exec('UPDATE comision_niveles SET porcentaje = porcentaje')
  const despues = await fila(
    db,
    "SELECT COUNT(*)::int n FROM auditoria_sistema WHERE accion = 'comisiones.regla_cambiada'",
  )
  assert.equal(despues.n, medio.n, 'un UPDATE sin cambios ensució la auditoría')
  assert.equal(medio.n, antes.n + 1)

  // Se deja como estaba: si no, el período ya cerrado dejaría de cuadrar al
  // recalcular y la revisión lo marcaría —con razón—.
  await db.exec(`UPDATE comision_niveles SET porcentaje = porcentaje - 1
                  WHERE id = (SELECT id FROM comision_niveles ORDER BY orden LIMIT 1)`)
})

test('un abonado no puede tener dos comisiones vivas', async () => {
  // La barrera está en un índice único de la base y no en el código: un índice
  // no se olvida de correr ni tiene una rama que nadie probó.
  await assert.rejects(
    () => db.query(`INSERT INTO comision_ventas (cliente_id) VALUES ('${ids.clientes[1]}')`),
    /duplicate key|unique/i,
  )
})

test('la revisión del módulo pasa sus catorce pruebas', async () => {
  const r = await db.query('SELECT * FROM verificar_comisiones()')
  assert.equal(r.rows.length, 14)

  const problemas = r.rows.filter((x) => x.res_estado !== 'ok')
  for (const p of problemas) console.error(`  ${p.res_prueba} · ${p.res_casos} · ${p.res_detalle}`)
  assert.equal(problemas.length, 0, 'la revisión encontró algo')
})

/**
 * El número del abonado, su clave y la fecha de su estado — la 107.
 *
 * Lo que se cuida acá no es que las columnas existan, sino las tres promesas
 * que hace la migración y que se romperían en silencio:
 *
 *   · Que cada abonado tenga un número propio y sin repetir, porque ese número
 *     se imprime en un contrato.
 *   · Que la fecha del estado se selle sola. Si no, la lista de "quién lleva dos
 *     meses cortado" sale mal y alguien maneja hasta una casa equivocada.
 *   · Que rehacer `v_clientes_ficha` no haya publicado `portal_clave_hash`, que
 *     es exactamente lo que la 65 escondió.
 */
test('cada abonado nace con su número, sin repetir', async () => {
  await db.exec(`
      INSERT INTO clientes (nombre, estado)
      SELECT 'Abonado ' || g, 'activo' FROM generate_series(1, 20) g
  `)

  const r = await fila(
    db,
    'SELECT COUNT(*) AS n, COUNT(DISTINCT codigo) AS distintos, COUNT(*) FILTER (WHERE codigo IS NULL) AS sin FROM clientes',
  )

  assert.equal(Number(r.sin), 0, 'hay abonados sin número')
  assert.equal(Number(r.distintos), Number(r.n), 'hay números repetidos')
})

test('la fecha del estado se sella sola, y solo cuando el estado cambia', async () => {
  const c = await fila(db, "SELECT id, estado_desde FROM clientes WHERE nombre = 'Abonado 1'")

  // Un cambio que no es de estado no toca la fecha: si la tocara, todos
  // parecerían recién suspendidos y la lista de recuperación saldría vacía.
  await db.exec(`UPDATE clientes SET telefono = '0999999999' WHERE id = '${c.id}'`)
  const igual = await fila(db, `SELECT estado_desde FROM clientes WHERE id = '${c.id}'`)
  assert.equal(String(igual.estado_desde), String(c.estado_desde))

  await db.exec(`UPDATE clientes SET estado = 'suspendido' WHERE id = '${c.id}'`)
  const nueva = await fila(
    db,
    `SELECT estado, estado_desde, (estado_desde > now() - interval '10 seconds') AS recien
       FROM clientes WHERE id = '${c.id}'`,
  )

  assert.equal(nueva.estado, 'suspendido')
  assert.equal(nueva.recien, true, 'la fecha del estado no se actualizó')
})

test('la ficha muestra lo nuevo y sigue sin publicar el hash de la clave', async () => {
  const r = await db.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
  `)
  const columnas = r.rows.map((x) => x.column_name)

  for (const c of ['codigo', 'zona', 'estado_desde', 'portal_clave', 'numero_orden', 'pasarela', 'baja_en']) {
    assert.ok(columnas.includes(c), `a la ficha le falta ${c}`)
  }

  assert.ok(
    !columnas.includes('portal_clave_hash'),
    'la ficha está publicando el hash de la contraseña',
  )
})

/**
 * El equipo recuperado: del abonado al técnico, y del técnico a la bodega — la 111.
 *
 * ── Qué se cuida ──
 *
 * Que el inventario diga siempre dónde está el equipo DE VERDAD. El error que
 * esta migración vino a corregir es sutil: el aparato se anotaba en la bodega
 * central en el momento en que el técnico lo sacaba de la casa del abonado, y
 * ahí se quedaba tres días en una camioneta mientras alguien lo prometía para
 * otra instalación.
 *
 * Y que la firma valga algo: si quien entrega pudiera firmar su propia entrega,
 * el acta no probaría nada.
 */
test('el equipo recuperado queda en el almacén del técnico, no en la bodega', async () => {
  await sesion(db, null)
  await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
        ('aaaaaaaa-0000-0000-0000-000000000001', 'tec@demo.ec'),
        ('aaaaaaaa-0000-0000-0000-000000000002', 'ofi@demo.ec');

      INSERT INTO tecnicos (id, nombre, activo)
      VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'Técnico Uno', true);

      INSERT INTO usuarios_sistema (id, auth_id, usuario, email, nombre, apellido, rol, permisos, activo, tecnico_id)
      VALUES ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
              'tec', 'tec@demo.ec', 'Tomás', 'Campo', 'tecnico', '["retiros.gestionar"]'::jsonb, true,
              'bbbbbbbb-0000-0000-0000-000000000001'),
             ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002',
              'ofi', 'ofi@demo.ec', 'Olga', 'Oficina', 'admin', '["*"]'::jsonb, true, NULL);

      -- El almacén del técnico NO se inserta: lo crea un disparador al dar de
      -- alta al técnico, y ponerlo a mano choca contra su índice único.
      INSERT INTO almacenes (id, nombre, tipo, tecnico_id) VALUES
        ('dddddddd-0000-0000-0000-000000000001', 'Bodega central', 'bodega', NULL);

      INSERT INTO articulos (id, nombre, categoria, unidad)
      VALUES ('eeeeeeee-0000-0000-0000-000000000001', 'ONT XPON', 'ont', 'u');

      INSERT INTO clientes (id, nombre, estado) VALUES ('ffffffff-0000-0000-0000-000000000001', 'Moroso Uno', 'baja');

      INSERT INTO equipos (id, articulo_id, serie, estado, cliente_id)
      VALUES ('99999999-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001',
              'SN-RECUP-1', 'instalado', 'ffffffff-0000-0000-0000-000000000001');

      INSERT INTO retiros_equipo (id, cliente_id, equipo_id, serie, estado, meses_sin_pago, tecnico_id, responsable_id)
      VALUES ('88888888-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001',
              '99999999-0000-0000-0000-000000000001', 'SN-RECUP-1', 'asignado', 3,
              'bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001');
  `)

  await sesion(db, 'aaaaaaaa-0000-0000-0000-000000000001')
  // Desde la 115 el cierre por recuperación exige la firma de quien entrega el
  // equipo: es lo único que después separa "yo la entregué" de "a mí nunca me
  // la dieron".
  await db.query(`
      SELECT cerrar_retiro_equipo('88888888-0000-0000-0000-000000000001', true,
             NULL, NULL, NULL, NULL, 'data:image/png;base64,XXXX', 'Hijo del titular')`)

  const firma = await fila(db, `
      SELECT firmante, firma_b64 IS NOT NULL AS firmada, firmado_en IS NOT NULL AS sellada
        FROM retiros_equipo WHERE id = '88888888-0000-0000-0000-000000000001'`)
  assert.equal(firma.firmada, true, 'la firma tiene que quedar guardada')
  assert.equal(firma.sellada, true, 'y con su fecha')
  assert.equal(firma.firmante, 'Hijo del titular', 'quién firmó importa: casi nunca es el titular')

  const eq = await fila(db, `
      SELECT a.tipo, a.tecnico_id, e.estado
        FROM equipos e JOIN almacenes a ON a.id = e.almacen_id
       WHERE e.id = '99999999-0000-0000-0000-000000000001'`)

  assert.equal(eq.tipo, 'tecnico', 'el equipo tiene que quedar donde está: con el técnico')
  assert.equal(eq.tecnico_id, 'bbbbbbbb-0000-0000-0000-000000000001')
  assert.equal(eq.estado, 'en_stock')
})

test('el acta cambia el material de manos, y no la puede firmar quien entrega', async () => {
  // El técnico arma el acta con lo que lleva a la oficina.
  await sesion(db, 'aaaaaaaa-0000-0000-0000-000000000001')
  // Desde la 120 el acta también exige la firma de quien entrega: con una sola
  // firma prueba la mitad —que la oficina aceptó unos equipos, pero no que el
  // técnico los entregó—.
  await assert.rejects(
    () =>
      db.query(
        `SELECT crear_entrega_inventario(ARRAY['99999999-0000-0000-0000-000000000001']::UUID[], 'sin firma')`,
      ),
    /falta tu firma/i,
  )

  const acta = await fila(
    db,
    `SELECT * FROM crear_entrega_inventario(ARRAY['99999999-0000-0000-0000-000000000001']::UUID[],
            'Una ONT recuperada', 'data:image/png;base64,TEC')`,
  )
  assert.ok(acta.firma_entrega_b64, 'la firma del que entrega tiene que quedar guardada')
  assert.equal(acta.estado, 'pendiente')
  assert.ok(acta.numero > 0, 'el acta necesita un número con el que hablar de ella')

  // Mientras nadie firme, el equipo sigue siendo del técnico.
  const antes = await fila(db, `
      SELECT a.tipo FROM equipos e JOIN almacenes a ON a.id = e.almacen_id
       WHERE e.id = '99999999-0000-0000-0000-000000000001'`)
  assert.equal(antes.tipo, 'tecnico', 'el acta pendiente no puede mover el inventario')

  // Y no puede firmarse a sí mismo la recepción.
  await assert.rejects(
    () => db.query(`SELECT recibir_entrega_inventario('${acta.id}', 'firma')`),
    /no podés recibir tu propia entrega/i,
  )

  // La oficina la recibe y firma.
  await sesion(db, 'aaaaaaaa-0000-0000-0000-000000000002')
  const firmada = await fila(
    db,
    `SELECT * FROM recibir_entrega_inventario('${acta.id}', 'data:image/png;base64,XXXX')`,
  )
  assert.equal(firmada.estado, 'recibida')
  assert.ok(firmada.firmado_en, 'tiene que quedar cuándo se firmó')

  const despues = await fila(db, `
      SELECT a.nombre AS almacen FROM equipos e JOIN almacenes a ON a.id = e.almacen_id
       WHERE e.id = '99999999-0000-0000-0000-000000000001'`)
  assert.equal(despues.almacen, 'Bodega central', 'al firmarse, el equipo pasa al almacén general')

  // Y el movimiento quedó registrado, que es lo que permite reconstruirlo después.
  const mov = await fila(db, `
      SELECT tipo, motivo FROM movimientos_inventario
       WHERE equipo_id = '99999999-0000-0000-0000-000000000001'
       ORDER BY creado_en DESC LIMIT 1`)
  assert.equal(mov.tipo, 'transferencia')
  assert.match(mov.motivo, /acta/i)
})

test('un acta no se puede recibir dos veces', async () => {
  const acta = await fila(db, `SELECT id FROM entregas_inventario WHERE estado = 'recibida' LIMIT 1`)
  await assert.rejects(
    () => db.query(`SELECT recibir_entrega_inventario('${acta.id}', 'firma')`),
    /ya está recibida/i,
  )
})

test('no se puede entregar un equipo que no está en el almacén propio', async () => {
  await sesion(db, 'aaaaaaaa-0000-0000-0000-000000000001')
  // Ya está en la bodega: salió del almacén del técnico al firmarse el acta.
  // Con firma y todo: lo que lo impide es que el equipo ya no es suyo, no que
  // falte algo del formulario.
  await assert.rejects(
    () =>
      db.query(
        `SELECT crear_entrega_inventario(ARRAY['99999999-0000-0000-0000-000000000001']::UUID[],
                NULL, 'data:image/png;base64,TEC')`,
      ),
    /ninguno de esos equipos está en tu almacén/i,
  )
  await sesion(db, null)
})

/**
 * El estado del equipo lo decide a dónde va, no cómo se llama el movimiento — la 116.
 *
 * ── Por qué esto necesita una prueba propia ──
 *
 * Porque la misma palabra —`transferencia`— significa dos cosas opuestas según
 * el destino: despachar material a un técnico es asignarlo, y devolverlo a la
 * bodega es liberarlo. El disparador miraba solo el tipo, así que una ONT
 * recuperada llegaba a la bodega marcada como "asignado" y desaparecía del
 * stock disponible: nadie la usaba, y se compraba otra teniéndola en el estante.
 *
 * Se detectó firmando un acta de verdad, no leyendo el código.
 */
test('una transferencia asigna o libera según el destino', async () => {
  await sesion(db, null)
  await db.exec(`
      INSERT INTO tecnicos (id, nombre, activo)
      VALUES ('b1110000-0000-0000-0000-000000000001', 'Tec Inventario', true);

      INSERT INTO almacenes (id, nombre, tipo)
      VALUES ('d1110000-0000-0000-0000-000000000001', 'Bodega inventario', 'bodega');

      INSERT INTO articulos (id, nombre, categoria, unidad)
      VALUES ('e1110000-0000-0000-0000-000000000001', 'ONT prueba', 'ont', 'u');

      INSERT INTO equipos (id, articulo_id, serie, estado)
      VALUES ('91110000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'SN-INV', 'en_stock');
  `)

  const alm = await fila(
    db,
    `SELECT id FROM almacenes WHERE tecnico_id = 'b1110000-0000-0000-0000-000000000001'`,
  )

  const mover = (origen, destino, motivo) =>
    db.exec(`
      INSERT INTO movimientos_inventario
             (tipo, articulo_id, equipo_id, cantidad, almacen_origen_id, almacen_destino_id, motivo)
      VALUES ('transferencia', 'e1110000-0000-0000-0000-000000000001',
              '91110000-0000-0000-0000-000000000001', 1, '${origen}', '${destino}', '${motivo}')`)

  const estado = async () =>
    (await fila(db, `SELECT estado FROM equipos WHERE id = '91110000-0000-0000-0000-000000000001'`))
      .estado

  await mover('d1110000-0000-0000-0000-000000000001', alm.id, 'despacho al técnico')
  assert.equal(await estado(), 'asignado', 'en manos de un técnico el equipo está asignado')

  await mover(alm.id, 'd1110000-0000-0000-0000-000000000001', 'acta de devolución')
  assert.equal(await estado(), 'en_stock', 'de vuelta en la bodega el equipo es stock disponible')

  // Y las existencias tienen que cerrar: salió y volvió.
  const ex = await fila(
    db,
    `SELECT COALESCE(SUM(cantidad), 0) AS total FROM existencias
      WHERE articulo_id = 'e1110000-0000-0000-0000-000000000001'`,
  )
  assert.equal(Number(ex.total), 0, 'ir y volver no puede inventar ni perder existencias')
})

test('el acta vale cuando la firmaron los dos', async () => {
  /**
   * `firmada` no es "alguien firmó": es que firmaron las DOS partes. Es lo
   * único que después distingue "yo entregué cinco" de "a mí me llegaron
   * cuatro" — que es la discusión entera que este acta viene a evitar.
   */
  const a = await fila(
    db,
    `SELECT numero, firmada_entrega, firmada_recepcion, firmada
       FROM v_entregas_inventario ORDER BY numero DESC LIMIT 1`,
  )

  assert.equal(a.firmada_entrega, true, 'falta la firma de quien entrega')
  assert.equal(a.firmada_recepcion, true, 'falta la firma de quien recibe')
  assert.equal(a.firmada, true, 'con las dos, el acta está completa')
})


/**
 * El abonado migrado no es un moroso de dos años.
 *
 * `meses_sin_pago()` mira los pagos de este sistema, y un abonado recién traído
 * de otro no tiene ninguno. Cae entonces a cuándo se activó — y ahí está el
 * problema, porque la migración tiene que preservar la antigüedad: un cliente
 * instalado hace dos años se importa CON esa fecha, no con la de hoy.
 *
 * Sin más datos, eso se lee como dos años sin pagar. La cartera corta en 3, así
 * que la primera noche después de migrar el padrón se abre una orden de retiro
 * por cada abonado antiguo, y a la mañana hay técnicos yendo a levantar equipos
 * de casas que están al día.
 *
 * (Con `estado = 'activo'` el disparador de la 70 sella `activado_en` en NOW() y
 * el problema queda tapado por accidente. Pero los suspendidos —justo los que la
 * cartera mira— no pasan por ahí, y esos son los que reventarían.)
 *
 * Lo que la 121 agrega es la fecha del último pago del sistema anterior. No es
 * un pago —no entra a caja ni a comisiones—, es el punto de partida.
 */
test('un abonado migrado con su último pago no cae en cartera', async () => {
  await sesion(db, null)
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, fecha_instalacion, activado_en,
                            sistema_origen, codigo_externo)
      VALUES
        ('c1210000-0000-0000-0000-000000000001', 'MIGRADO SIN SU PAGO', 'suspendido',
         CURRENT_DATE - INTERVAL '2 years', NOW() - INTERVAL '2 years', 'viejo', 'V-1'),
        ('c1210000-0000-0000-0000-000000000002', 'MIGRADO CON SU PAGO', 'suspendido',
         CURRENT_DATE - INTERVAL '2 years', NOW() - INTERVAL '2 years', 'viejo', 'V-2');

      UPDATE clientes
         SET ultimo_pago_externo = CURRENT_DATE - INTERVAL '10 days'
       WHERE id = 'c1210000-0000-0000-0000-000000000002';
  `)

  const meses = async (id) =>
    Number((await fila(db, `SELECT meses_sin_pago('${id}') AS m`)).m)

  assert.equal(
    await meses('c1210000-0000-0000-0000-000000000001'),
    24,
    'sin la fecha del último pago, dos años de instalado se leen como dos años sin pagar',
  )
  assert.equal(
    await meses('c1210000-0000-0000-0000-000000000002'),
    0,
    'con la fecha migrada, el abonado está al día',
  )
})

test('un pago cobrado acá le gana a la fecha que vino de afuera', async () => {
  /**
   * El orden importa: lo de afuera es una referencia, lo de acá es un hecho
   * contable. Si el abonado migrado paga con nosotros y después deja de pagar,
   * la cuenta tiene que correr desde ESE pago — no quedarse clavada en la fecha
   * que trajo el archivo, que lo dejaría al día para siempre.
   */
  await db.exec(`
      INSERT INTO pagos (client_id, monto, fecha_pago)
      VALUES ('c1210000-0000-0000-0000-000000000002', 20, CURRENT_DATE - INTERVAL '8 months');
  `)

  const m = Number(
    (await fila(db, `SELECT meses_sin_pago('c1210000-0000-0000-0000-000000000002') AS m`)).m,
  )
  assert.equal(m, 8, 'manda el último pago de este sistema, aunque sea más viejo que el importado')
})


// ---------------------------------------------------------------------------
// 122 — La IP que ya está en uso
// ---------------------------------------------------------------------------

/**
 * La dirección de un abonado migrado no se le puede dar a otro.
 *
 * "La primera IP libre" se calculaba mirando solo `ip_addresses`, el registro
 * del IPAM. Los abonados guardan la suya en `clientes.ip`, y esa tabla en una
 * instalación real está vacía — así que después de importar un padrón la cuenta
 * seguía proponiendo la primera dirección del bloque, que ya está en la casa de
 * alguien.
 *
 * Dos equipos con la misma IP no fallan con un cartel: se cortan el servicio
 * entre ellos de a ratos, y eso se persigue durante días.
 */
test('la IP de un abonado no se le ofrece a otro', async () => {
  await sesion(db, null)
  await db.exec(`
      INSERT INTO routers_mikrotik (id, nombre, ip_host, usuario, password_encrypted)
      VALUES ('7a220000-0000-0000-0000-000000000001', 'CCR PRUEBA', '10.0.0.1', 'admin', 'x');

      INSERT INTO subredes (id, nombre, cidr, tipo, router_id, gateway)
      VALUES ('5b220000-0000-0000-0000-000000000001', 'BLOQUE PRUEBA', '10.44.0.0/24',
              'estatica', '7a220000-0000-0000-0000-000000000001', '10.44.0.1');

      INSERT INTO clientes (id, nombre, estado, router_id, ip)
      VALUES ('c2220000-0000-0000-0000-000000000001', 'ABONADO MIGRADO', 'activo',
              '7a220000-0000-0000-0000-000000000001', '10.44.0.2');
  `)

  assert.equal(
    (await fila(db, `SELECT quien_tiene_la_ip('10.44.0.2') AS q`)).q,
    'ABONADO MIGRADO',
    'la IP de un abonado tiene que aparecer como ocupada',
  )

  assert.equal(
    (await fila(db, `SELECT quien_tiene_la_ip('10.44.0.9') AS q`)).q,
    null,
    'una que nadie usa tiene que dar libre',
  )

  // El .1 es el gateway y el .2 lo tiene el abonado: la primera libre es el .3.
  assert.equal(
    (await fila(db, `SELECT primera_ip_libre('5b220000-0000-0000-0000-000000000001') AS ip`)).ip,
    '10.44.0.3',
    'ni el gateway ni la del abonado se pueden ofrecer',
  )
})

test('el abonado dado de baja devuelve su dirección', async () => {
  /**
   * Si la retuviera para siempre, un ISP con cinco años de historia tendría
   * medio bloque bloqueado por gente que ya no es cliente. En la realidad esa
   * dirección se reasigna al siguiente.
   */
  await db.exec(`
      UPDATE clientes SET estado = 'baja'
       WHERE id = 'c2220000-0000-0000-0000-000000000001';
  `)

  assert.equal(
    (await fila(db, `SELECT quien_tiene_la_ip('10.44.0.2') AS q`)).q,
    null,
    'la IP del que se fue queda disponible',
  )
  assert.equal(
    (await fila(db, `SELECT primera_ip_libre('5b220000-0000-0000-0000-000000000001') AS ip`)).ip,
    '10.44.0.2',
  )
})

test('el suspendido SÍ retiene su dirección', async () => {
  // Sigue siendo abonado y su equipo sigue en la casa. Reasignársela a otro es
  // exactamente el choque que esto viene a evitar.
  await db.exec(`
      UPDATE clientes SET estado = 'suspendido'
       WHERE id = 'c2220000-0000-0000-0000-000000000001';
  `)
  assert.equal(
    (await fila(db, `SELECT quien_tiene_la_ip('10.44.0.2') AS q`)).q,
    'ABONADO MIGRADO',
  )
})

test('una reserva del IPAM también ocupa, pero una fila libre no', async () => {
  await db.exec(`
      INSERT INTO ip_addresses (router_id, subred_id, ip_address, interfaz, estado, descripcion)
      VALUES
        ('7a220000-0000-0000-0000-000000000001', '5b220000-0000-0000-0000-000000000001',
         '10.44.0.3', 'ether1', 'reservada', 'Cámara del nodo'),
        ('7a220000-0000-0000-0000-000000000001', '5b220000-0000-0000-0000-000000000001',
         '10.44.0.4', 'ether1', 'libre', NULL);
  `)

  assert.equal(
    (await fila(db, `SELECT quien_tiene_la_ip('10.44.0.3') AS q`)).q,
    'Cámara del nodo',
    'las reservas que no son de abonados también ocupan',
  )
  assert.equal(
    (await fila(db, `SELECT quien_tiene_la_ip('10.44.0.4') AS q`)).q,
    null,
    'una fila en estado libre es justamente una dirección disponible',
  )
})

test('la IP del abonado registrada en el IPAM no pelea consigo misma', async () => {
  // La misma dirección puede estar en las dos tablas. Contarla dos veces la
  // haría aparecer como conflicto, y quien lo lea va a ir a buscar un problema
  // que no existe.
  await db.exec(`
      INSERT INTO ip_addresses (router_id, subred_id, ip_address, interfaz, estado, client_id)
      VALUES ('7a220000-0000-0000-0000-000000000001', '5b220000-0000-0000-0000-000000000001',
              '10.44.0.2', 'ether1', 'asignada', 'c2220000-0000-0000-0000-000000000001');
  `)

  const c = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_ips_en_conflicto WHERE ip = '10.44.0.2'`,
  )
  assert.equal(c.n, 0, 'la IP de un abonado registrada en el IPAM no es un conflicto')
})


// ---------------------------------------------------------------------------
// 123 — Cuando se está por acabar el material
// ---------------------------------------------------------------------------

/**
 * La bodega y la mochila del técnico no se miden con la misma vara.
 *
 * `articulos.stock_minimo` existía desde la 69 y no lo miraba nadie. Al
 * empezar a mirarlo aparece el problema de fondo: si el mínimo fuera uno solo,
 * el técnico —que nunca va a andar con veinte ONTs encima— viviría en alerta
 * permanente. Y una alerta que suena siempre no la mira nadie.
 */
test('el mínimo de la bodega no se le aplica a la mochila del técnico', async () => {
  await sesion(db, null)
  await db.exec(`
      INSERT INTO tecnicos (id, nombre, activo)
      VALUES ('7b230000-0000-0000-0000-000000000001', 'Tec Stock', true);

      INSERT INTO almacenes (id, nombre, tipo)
      VALUES ('a1230000-0000-0000-0000-000000000001', 'Bodega stock', 'bodega');

      INSERT INTO articulos (id, nombre, categoria, unidad, stock_minimo)
      VALUES ('e1230000-0000-0000-0000-000000000001', 'Conector SC/APC', 'conector', 'u', 20);
  `)

  const alm = await fila(
    db,
    `SELECT id FROM almacenes WHERE tecnico_id = '7b230000-0000-0000-0000-000000000001'`,
  )

  // La bodega con 5 de un mínimo de 20, y el técnico con 5 y sin mínimo propio.
  await db.exec(`
      INSERT INTO existencias (articulo_id, almacen_id, cantidad) VALUES
        ('e1230000-0000-0000-0000-000000000001', 'a1230000-0000-0000-0000-000000000001', 5),
        ('e1230000-0000-0000-0000-000000000001', '${alm.id}', 5);
  `)

  const bajos = (
    await db.query(`SELECT almacen, cantidad, minimo, falta FROM v_stock_bajo ORDER BY almacen`)
  ).rows

  assert.equal(bajos.length, 1, 'solo la bodega tiene que alertar')
  assert.equal(bajos[0].almacen, 'Bodega stock')
  assert.equal(Number(bajos[0].falta), 15, 'faltan 15 para volver al mínimo')
})

test('con su propio mínimo, el técnico sí alerta', async () => {
  const alm = await fila(
    db,
    `SELECT id FROM almacenes WHERE tecnico_id = '7b230000-0000-0000-0000-000000000001'`,
  )

  await db.exec(`
      INSERT INTO stock_minimos (almacen_id, articulo_id, minimo, reponer)
      VALUES ('${alm.id}', 'e1230000-0000-0000-0000-000000000001', 6, 20);
  `)

  const t = await fila(
    db,
    `SELECT cantidad, minimo, falta, sugerido, minimo_propio
       FROM v_stock_bajo WHERE almacen_id = '${alm.id}'`,
  )

  assert.equal(Number(t.minimo), 6, 'manda el mínimo del almacén, no el del artículo')
  assert.equal(t.minimo_propio, true)
  assert.equal(Number(t.falta), 1)
  assert.equal(Number(t.sugerido), 20, 'lo que conviene reponer no es lo mismo que lo que falta')
})

test('estar justo en el mínimo ya es la señal', async () => {
  /**
   * El mínimo es el punto de REPOSICIÓN, no el de emergencia. Avisar recién al
   * bajar de él llega con una unidad de atraso, y con material que tarda una
   * semana en llegar esa unidad es una instalación que no se hace.
   */
  await db.exec(`
      UPDATE existencias SET cantidad = 20
       WHERE almacen_id = 'a1230000-0000-0000-0000-000000000001'
         AND articulo_id = 'e1230000-0000-0000-0000-000000000001';
  `)

  const b = await fila(
    db,
    `SELECT cantidad, minimo, falta, agotado FROM v_stock_bajo
      WHERE almacen_id = 'a1230000-0000-0000-0000-000000000001'`,
  )
  assert.equal(Number(b.cantidad), 20)
  assert.equal(Number(b.falta), 0, 'no falta nada todavía, pero hay que reponer')
  assert.equal(b.agotado, false)
})

test('los avisos salen y llegan al técnico y a quien repone', async () => {
  await db.exec(`
      INSERT INTO usuarios_sistema (id, usuario, nombre, email, activo, permisos, tecnico_id)
      VALUES
        ('11230000-0000-0000-0000-000000000001', 'bodeguero', 'Bodeguero', 'bod@x.com', true,
         '["inventario.gestionar"]'::JSONB, NULL),
        ('11230000-0000-0000-0000-000000000002', 'tecstock', 'Tec Stock', 'tec@x.com', true,
         '[]'::JSONB, '7b230000-0000-0000-0000-000000000001');
  `)

  const r = await fila(db, `SELECT avisar_stock_bajo() AS r`)
  assert.ok(r.r.avisos > 0, 'no mandó ningún aviso')

  const delTecnico = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM notificaciones
      WHERE usuario_id = '11230000-0000-0000-0000-000000000002' AND tipo = 'stock_bajo'`,
  )
  assert.ok(delTecnico.n > 0, 'el técnico tiene que enterarse antes de salir a la ruta')

  const delBodeguero = await fila(
    db,
    `SELECT detalle FROM notificaciones
      WHERE usuario_id = '11230000-0000-0000-0000-000000000001' AND tipo = 'stock_bajo'
      LIMIT 1`,
  )
  assert.match(delBodeguero.detalle, /Conector SC\/APC/, 'el aviso tiene que decir qué falta')
})


// ---------------------------------------------------------------------------
// 124 y 125 — La página que ve el abonado cortado
// ---------------------------------------------------------------------------

test('las cuentas de banco se publican solas y la caja nunca', async () => {
  /**
   * Un ISP que instala este sistema carga sus cuentas en Cobranza y arma su
   * ficha de empresa. Si además tuviera que ir a otra pantalla a marcar cuáles
   * publicar, la página del cortado le saldría vacía sin que nada le diga por
   * qué. Una cuenta de banco existe PARA que le depositen.
   *
   * La que hay que proteger es la caja de la oficina: "depositá en Caja Oficina"
   * no significa nada para alguien sentado en su casa.
   */
  await sesion(db, null)
  await db.exec(`
      INSERT INTO cuentas_pago (nombre, tipo, banco, numero) VALUES
        ('Banco Prueba', 'banco', 'Prueba', '111222333'),
        ('Billetera Prueba', 'billetera', NULL, '0999999999');
  `)

  const banco = await fila(db, `SELECT mostrar_en_corte FROM cuentas_pago WHERE nombre = 'Banco Prueba'`)
  const billetera = await fila(db, `SELECT mostrar_en_corte FROM cuentas_pago WHERE nombre = 'Billetera Prueba'`)
  const caja = await fila(db, `SELECT mostrar_en_corte FROM cuentas_pago WHERE tipo = 'efectivo' LIMIT 1`)

  assert.equal(banco.mostrar_en_corte, true, 'una cuenta nueva de banco se publica sola')
  assert.equal(billetera.mostrar_en_corte, true)
  assert.equal(caja.mostrar_en_corte, false, 'la caja de la oficina no se publica nunca')
})

test('apagar una cuenta a mano sobrevive a reejecutar la migración', async () => {
  /**
   * Es la razón de la bandera `cuentas_inicializadas`. Sin ella, volver a correr
   * la 125 —lo que hace cualquiera que no esté seguro de si ya la corrió—
   * volvería a publicar una cuenta que alguien apagó a propósito, y esa persona
   * no se enteraría: la cuenta reaparecería en una página que ella no mira.
   */
  await db.exec(`
      UPDATE cuentas_pago SET mostrar_en_corte = FALSE WHERE nombre = 'Banco Prueba';
  `)

  const archivo = MIGRACIONES.find((f) => numero(f) === 125)
  assert.ok(archivo, 'no se encontró la migración 125')
  await db.exec(
    readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), archivo), 'utf8'),
  )

  const despues = await fila(db, `SELECT mostrar_en_corte FROM cuentas_pago WHERE nombre = 'Banco Prueba'`)
  assert.equal(despues.mostrar_en_corte, false, 'una migración no puede reimponer su criterio')
})

test('la ficha del cortado se busca por IP y no publica de más', async () => {
  /**
   * Esta vista es el único recorte de `clientes` que ve alguien SIN sesión. La
   * lista de columnas es explícita para que el día que alguien agregue un campo
   * delicado a la tabla no termine publicado en la página del cortado.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, identificacion)
      VALUES ('c1240000-0000-0000-0000-000000000001', 'CORTADO DE PRUEBA', 'cortado',
              '10.55.0.9', '1799887766');
  `)

  const f = await fila(db, `SELECT * FROM v_corte_abonado WHERE ip = '10.55.0.9'`)
  assert.equal(f.nombre, 'CORTADO DE PRUEBA')
  assert.equal(Number(f.saldo), 0)

  const columnas = Object.keys(f)
  for (const prohibida of ['portal_clave', 'portal_clave_hash', 'clave_ppp', 'identificacion']) {
    assert.ok(
      !columnas.includes(prohibida),
      `"${prohibida}" no puede salir en la página que ve cualquiera`,
    )
  }
})


// ---------------------------------------------------------------------------
// 126 — El editor de plantillas
// ---------------------------------------------------------------------------

test('las plantillas quedan cargadas y ordenadas por dónde se usan', async () => {
  const r = await db.query(
    `SELECT categoria, COUNT(*)::INT AS n FROM plantillas_mensaje
      WHERE del_sistema GROUP BY categoria ORDER BY categoria`,
  )
  const por = Object.fromEntries(r.rows.map((x) => [x.categoria, x.n]))

  assert.ok(por.documento >= 6, 'faltan documentos')
  assert.ok(por.correo >= 12, 'faltan correos')
  assert.ok(por.sms >= 10, 'faltan mensajes de SMS/Telegram')
  assert.equal(por.web, 2, 'las dos páginas: aviso de pago y aviso de corte')
})

test('una plantilla del sistema no se puede borrar', async () => {
  /**
   * Borrar "aviso de pago 1" no rompe nada visible: la tarea que lo manda sigue
   * corriendo y no manda nada. El daño aparece un mes después, cuando nadie
   * recibió su aviso y la cartera creció sola.
   *
   * La protección va en la base y no en la pantalla porque la pantalla es UNA de
   * las formas de llegar a esta tabla, no la única.
   */
  await sesion(db, null)
  await assert.rejects(
    () => db.exec(`DELETE FROM plantillas_mensaje WHERE clave = 'web_aviso_corte'`),
    /no se puede borrar/,
  )

  const sigue = await fila(
    db,
    `SELECT nombre FROM plantillas_mensaje WHERE clave = 'web_aviso_corte'`,
  )
  assert.equal(sigue.nombre, 'Aviso de corte')
})

test('una plantilla propia del ISP sí se borra', async () => {
  // Las que crea el ISP son suyas: el sistema no las busca por clave y nada
  // deja de funcionar si desaparecen.
  await db.exec(`
      INSERT INTO plantillas_mensaje (nombre, canal, categoria, cuerpo)
      VALUES ('Mía', 'email', 'correo', 'hola');
  `)
  await db.exec(`DELETE FROM plantillas_mensaje WHERE nombre = 'Mía'`)

  const q = await fila(db, `SELECT COUNT(*)::INT AS n FROM plantillas_mensaje WHERE nombre = 'Mía'`)
  assert.equal(q.n, 0)
})

test('editar una plantilla sobrevive a reejecutar la migración', async () => {
  /**
   * El ISP va a reescribir estos textos con sus palabras. Una migración que se
   * reejecuta no puede devolverle el texto de fábrica a alguien que se tomó ese
   * trabajo — y no se enteraría hasta que un abonado le muestre el mensaje.
   */
  await db.exec(`
      UPDATE plantillas_mensaje
         SET cuerpo = 'MI TEXTO PROPIO'
       WHERE clave = 'sms_corte_servicio';
  `)

  const archivo = MIGRACIONES.find((f) => numero(f) === 126)
  await db.exec(
    readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), archivo), 'utf8'),
  )

  const despues = await fila(
    db,
    `SELECT cuerpo FROM plantillas_mensaje WHERE clave = 'sms_corte_servicio'`,
  )
  assert.equal(despues.cuerpo, 'MI TEXTO PROPIO')
})

// ---------------------------------------------------------------------------
// 127 — Los tres avisos de pago
// ---------------------------------------------------------------------------

test('cada abonado recibe el aviso que le toca por sus días de atraso', async () => {
  await sesion(db, null)
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email) VALUES
        ('c1270000-0000-0000-0000-000000000001', 'POR VENCER',  'activo', 'a@x.com'),
        ('c1270000-0000-0000-0000-000000000002', 'RECIEN VENCIO','activo', 'b@x.com'),
        ('c1270000-0000-0000-0000-000000000003', 'HACE RATO',   'activo', 'c@x.com'),
        ('c1270000-0000-0000-0000-000000000004', 'AL DIA',      'activo', 'd@x.com');

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES
        -- vence en 2 días → aviso 1 (la regla es -3)
        ('c1270000-0000-0000-0000-000000000001','POR VENCER','otro','Servicio',
         CURRENT_DATE, CURRENT_DATE + 2, 20, 0, 20),
        -- venció ayer → aviso 2 (la regla es +1)
        ('c1270000-0000-0000-0000-000000000002','RECIEN VENCIO','otro','Servicio',
         CURRENT_DATE - 30, CURRENT_DATE - 1, 20, 0, 20),
        -- venció hace 20 días → aviso 3 (la regla es +5)
        ('c1270000-0000-0000-0000-000000000003','HACE RATO','otro','Servicio',
         CURRENT_DATE - 50, CURRENT_DATE - 20, 20, 0, 20);
  `)

  const r = await db.query(
    `SELECT nombre, nivel, dias FROM v_avisos_pago_pendientes ORDER BY nombre`,
  )
  const por = Object.fromEntries(r.rows.map((x) => [x.nombre, x.nivel]))

  assert.equal(por['POR VENCER'], 1)
  assert.equal(por['RECIEN VENCIO'], 2)
  assert.equal(por['HACE RATO'], 3)
  assert.equal(por['AL DIA'], undefined, 'sin factura impaga no se le escribe')
})

test('al abonado con tres facturas vencidas se le manda UN mensaje', async () => {
  /**
   * Recibiría tres el mismo día, y a partir del segundo deja de leerlos. Se
   * manda uno solo: el del nivel más urgente que le corresponda.
   */
  await db.exec(`
      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES
        ('c1270000-0000-0000-0000-000000000003','HACE RATO','otro','Servicio',
         CURRENT_DATE - 20, CURRENT_DATE - 1, 20, 0, 20),
        ('c1270000-0000-0000-0000-000000000003','HACE RATO','otro','Servicio',
         CURRENT_DATE - 10, CURRENT_DATE + 2, 20, 0, 20);
  `)

  const r = await db.query(
    `SELECT nivel FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1270000-0000-0000-0000-000000000003'`,
  )
  assert.equal(r.rows.length, 1, 'un solo renglón por abonado')
  assert.equal(r.rows[0].nivel, 3, 'y el más urgente de los tres')
})

test('el mismo aviso no se manda dos veces por la misma factura', async () => {
  /**
   * La tarea corre todos los días. "Vence en 3 días" se cumple un solo día, pero
   * "venció hace 5 o más" se cumple para siempre: sin esta regla, el aviso 3 se
   * repetiría cada mañana hasta que el abonado pague.
   */
  const antes = await fila(
    db,
    `SELECT factura_id, plantilla_id FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1270000-0000-0000-0000-000000000003'`,
  )

  await db.exec(`
      INSERT INTO comunicaciones (client_id, factura_id, plantilla_id, canal, direccion, estado)
      VALUES ('c1270000-0000-0000-0000-000000000003', '${antes.factura_id}',
              '${antes.plantilla_id}', 'email', 'saliente', 'enviado');
  `)

  const r = await db.query(
    `SELECT 1 FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1270000-0000-0000-0000-000000000003'
        AND factura_id = '${antes.factura_id}'`,
  )
  assert.equal(r.rows.length, 0, 'ya se le mandó ese aviso por esa factura')
})

test('un envío fallido se reintenta al día siguiente', async () => {
  // Es la diferencia entre "ya se le avisó" y "se intentó y no salió". Marcar
  // las dos cosas igual dejaría al abonado sin aviso y al sistema conforme.
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email)
      VALUES ('c1270000-0000-0000-0000-000000000005', 'FALLÓ EL ENVIO', 'activo', 'e@x.com');

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1270000-0000-0000-0000-000000000005','FALLÓ EL ENVIO','otro','Servicio',
              CURRENT_DATE - 50, CURRENT_DATE - 20, 20, 0, 20);
  `)

  const a = await fila(
    db,
    `SELECT factura_id, plantilla_id FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1270000-0000-0000-0000-000000000005'`,
  )

  await db.exec(`
      INSERT INTO comunicaciones (client_id, factura_id, plantilla_id, canal, direccion, estado, error)
      VALUES ('c1270000-0000-0000-0000-000000000005', '${a.factura_id}',
              '${a.plantilla_id}', 'email', 'saliente', 'fallido', 'sin smtp');
  `)

  const r = await db.query(
    `SELECT 1 FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1270000-0000-0000-0000-000000000005'`,
  )
  assert.equal(r.rows.length, 1, 'sigue pendiente: el mensaje nunca salió')
})

test('al que ya no es abonado no se le escribe', async () => {
  // Sigue debiendo, pero mandarle un aviso de corte automático a quien está
  // cortado hace meses es ruido que solo genera llamadas.
  await db.exec(`
      UPDATE clientes SET estado = 'baja'
       WHERE id = 'c1270000-0000-0000-0000-000000000002';
  `)

  const r = await db.query(
    `SELECT 1 FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1270000-0000-0000-0000-000000000002'`,
  )
  assert.equal(r.rows.length, 0)
})

test('cada nivel trae sus dos plantillas: la larga y la corta', async () => {
  /**
   * El correo lleva la larga; el SMS, WhatsApp y Telegram llevan la corta. Un
   * correo entero mandado por SMS pasa los 160 caracteres, se cobra doble y
   * llega partido en dos.
   */
  const a = await fila(
    db,
    `SELECT plantilla_email_id, plantilla_corta_id FROM v_avisos_pago_pendientes LIMIT 1`,
  )
  assert.ok(a.plantilla_email_id, 'falta la del correo')
  assert.ok(a.plantilla_corta_id, 'falta la corta')
  assert.notEqual(a.plantilla_email_id, a.plantilla_corta_id)
})

test('desactivar una plantilla apaga ese canal, no el escalón', async () => {
  // "El primer aviso solo por correo" tiene que poder decirse sin perder el
  // primer aviso.
  await db.exec(`UPDATE plantillas_mensaje SET activa = FALSE WHERE clave = 'sms_aviso_pago_1'`)

  const r = await db.query(
    `SELECT plantilla_email_id, plantilla_corta_id FROM v_avisos_pago_pendientes WHERE nivel = 1`,
  )
  assert.ok(r.rows.length > 0, 'el escalón sigue vivo')
  assert.equal(r.rows[0].plantilla_corta_id, null, 'pero por ahí no sale')

  await db.exec(`UPDATE plantillas_mensaje SET activa = TRUE WHERE clave = 'sms_aviso_pago_1'`)
})

test('con las dos plantillas apagadas, el escalón no existe', async () => {
  await db.exec(`
      UPDATE plantillas_mensaje SET activa = FALSE
       WHERE clave IN ('mail_aviso_pago_1', 'sms_aviso_pago_1');
  `)

  const r = await db.query(`SELECT 1 FROM v_avisos_pago_pendientes WHERE nivel = 1`)
  assert.equal(r.rows.length, 0)

  await db.exec(`
      UPDATE plantillas_mensaje SET activa = TRUE
       WHERE clave IN ('mail_aviso_pago_1', 'sms_aviso_pago_1');
  `)
})

test('avisar por un canal impide que mañana llegue por el otro', async () => {
  /**
   * Es el problema que crea tener dos plantillas por nivel. Antes el control de
   * duplicados preguntaba por la PLANTILLA: mandarle el SMS del nivel 3 no
   * marcaba el correo del nivel 3 como enviado, y al día siguiente le llegaba de
   * nuevo por correo. Ahora la pregunta es por el NIVEL.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email, telefono_movil)
      VALUES ('c1280000-0000-0000-0000-000000000001', 'DOBLE AVISO', 'activo',
              'f@x.com', '0998877665');

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1280000-0000-0000-0000-000000000001','DOBLE AVISO','otro','Servicio',
              CURRENT_DATE - 50, CURRENT_DATE - 20, 20, 0, 20);
  `)

  const a = await fila(
    db,
    `SELECT factura_id, plantilla_corta_id FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1280000-0000-0000-0000-000000000001'`,
  )

  // Se le manda por WhatsApp, o sea con la plantilla CORTA.
  await db.exec(`
      INSERT INTO comunicaciones (client_id, factura_id, plantilla_id, canal, direccion, estado)
      VALUES ('c1280000-0000-0000-0000-000000000001', '${a.factura_id}',
              '${a.plantilla_corta_id}', 'whatsapp', 'saliente', 'enviado');
  `)

  const r = await db.query(
    `SELECT 1 FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1280000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.rows.length, 0, 'ya se le avisó ese nivel: no importa por qué canal')
})

// ---------------------------------------------------------------------------
// 129 — Los avisos que cada abonado quiere
// ---------------------------------------------------------------------------

test('el abonado que pidió no ser molestado no recibe nada', async () => {
  /**
   * Apagar los avisos no impide el corte: es dejar de molestar, no dejar de
   * cobrar. Pero el que lo pidió tiene que salir de la lista de envíos, o el
   * pedido no sirvió de nada.
   */
  await sesion(db, null)
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email, avisos_activos)
      VALUES ('c1290000-0000-0000-0000-000000000001', 'NO ME MOLESTEN', 'activo',
              'g@x.com', FALSE);

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1290000-0000-0000-0000-000000000001','NO ME MOLESTEN','otro','Servicio',
              CURRENT_DATE - 50, CURRENT_DATE - 20, 20, 0, 20);
  `)

  const r = await db.query(
    `SELECT 1 FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1290000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.rows.length, 0)
})

test('un abonado puede tener sus propios días de aviso', async () => {
  /**
   * "El último aviso, un día antes del corte" tiene que poder decirse para uno
   * sin cambiárselo a todos. La cuenta se hace por abonado, no una vez para
   * toda la base.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email)
      VALUES ('c1290000-0000-0000-0000-000000000002', 'AVISAME ANTES', 'activo', 'h@x.com');

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1290000-0000-0000-0000-000000000002','AVISAME ANTES','otro','Servicio',
              CURRENT_DATE - 20, CURRENT_DATE + 1, 20, 0, 20);
  `)

  // Con el general (-3) todavía no le toca: la factura vence recién mañana.
  const antes = await db.query(
    `SELECT nivel FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1290000-0000-0000-0000-000000000002'`,
  )
  assert.equal(antes.rows[0]?.nivel, 1, 'con el general le toca el primer aviso')

  // Le pedimos el ÚLTIMO aviso un día antes de vencer.
  await db.exec(`
      UPDATE clientes SET aviso_dias_3 = -1
       WHERE id = 'c1290000-0000-0000-0000-000000000002';
  `)

  const despues = await fila(
    db,
    `SELECT nivel FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1290000-0000-0000-0000-000000000002'`,
  )
  assert.equal(despues.nivel, 3, 'ahora le toca el último, un día antes')
})

test('los canales elegidos viajan hasta el que envía', async () => {
  // La vista los expone para que el enviador no tenga que volver a consultar la
  // ficha por cada abonado.
  await db.exec(`
      UPDATE clientes SET avisos_canales = ARRAY['whatsapp']
       WHERE id = 'c1290000-0000-0000-0000-000000000002';
  `)

  const f = await fila(
    db,
    `SELECT avisos_canales FROM v_avisos_pago_pendientes
      WHERE cliente_id = 'c1290000-0000-0000-0000-000000000002'`,
  )
  assert.deepEqual(f.avisos_canales, ['whatsapp'])
})

test('la página del corte sabe a quién no mostrarse', async () => {
  // Se corta igual: esto solo decide si se le explica por qué.
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, avisos_pantalla)
      VALUES ('c1290000-0000-0000-0000-000000000003', 'SIN PANTALLA', 'cortado',
              '10.77.0.9', FALSE);
  `)

  const f = await fila(db, `SELECT avisos_pantalla FROM v_corte_abonado WHERE ip = '10.77.0.9'`)
  assert.equal(f.avisos_pantalla, false)
})

// ---------------------------------------------------------------------------
// 131 — A los cuántos meses se corta
// ---------------------------------------------------------------------------

test('la ficha muestra lo que hay guardado de avisos', async () => {
  /**
   * ── El error que esta prueba ataja ──
   *
   * La pantalla del abonado lee `v_clientes_ficha`. Las columnas de avisos que
   * agregaron la 129 y la 130 nunca se sumaron a esa vista, y el efecto era de
   * los peores: guardar funcionaba —los valores quedaban bien en `clientes`—
   * pero al reabrir la ficha se veían los de fábrica.
   *
   * Alguien configuraba "solo WhatsApp", volvía a entrar, veía "todos", y lo
   * corregía otra vez. Nada falla y nada avisa.
   */
  await sesion(db, null)
  const f = await fila(db, `SELECT * FROM v_clientes_ficha LIMIT 1`)
  const columnas = Object.keys(f)

  for (const c of [
    'cortar_tras_meses', 'avisos_activos', 'avisos_canales', 'avisos_pantalla',
    'aviso_dias_1', 'aviso_dias_2', 'aviso_dias_3',
    'aviso_factura_canales', 'aviso_pantalla_dias',
  ]) {
    assert.ok(columnas.includes(c), `la ficha no expone "${c}": la pantalla no lo va a mostrar`)
  }

  // Y sigue sin publicar lo que no debe.
  assert.ok(!columnas.includes('portal_clave_hash'), 'la ficha no puede publicar el hash')
})

test('el corte se dice en meses y el interruptor viejo lo acompaña', async () => {
  /**
   * `aplicar_corte` lo leen tres vistas, el importador de padrón y la plantilla
   * de migración. Se conserva, pero pasa a ser la respuesta a "¿se corta alguna
   * vez?" — que es lo que esos lugares preguntan de verdad.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, cortar_tras_meses)
      VALUES ('c1310000-0000-0000-0000-000000000001', 'PAGA CADA TRES MESES', 'activo', 3);
  `)

  const c = await fila(
    db,
    `SELECT cortar_tras_meses, aplicar_corte FROM clientes
      WHERE id = 'c1310000-0000-0000-0000-000000000001'`,
  )
  assert.equal(c.cortar_tras_meses, 3)
  assert.equal(c.aplicar_corte, true, 'se corta alguna vez, así que el interruptor va encendido')
})

test('el servicio gratis se dice con cero y no se contradice', async () => {
  await db.exec(`
      UPDATE clientes SET cortar_tras_meses = 0
       WHERE id = 'c1310000-0000-0000-0000-000000000001';
  `)

  const c = await fila(
    db,
    `SELECT cortar_tras_meses, aplicar_corte FROM clientes
      WHERE id = 'c1310000-0000-0000-0000-000000000001'`,
  )
  assert.equal(c.aplicar_corte, false, 'nunca se corta: el interruptor se apaga solo')
})

test('el importador viejo, que escribe el booleano, no deja una contradicción', async () => {
  /**
   * El importador de padrón sigue escribiendo `aplicar_corte`. Sin la
   * sincronización en las dos direcciones, importar un abonado con "no cortar"
   * lo dejaría con `cortar_tras_meses = 1` y se lo cortaría al mes pese a lo que
   * decía el archivo. Es la clase de contradicción que no da error y se
   * descubre cuando alguien se queda sin internet.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, aplicar_corte)
      VALUES ('c1310000-0000-0000-0000-000000000002', 'IMPORTADO SIN CORTE', 'activo', FALSE);
  `)

  const c = await fila(
    db,
    `SELECT cortar_tras_meses, aplicar_corte FROM clientes
      WHERE id = 'c1310000-0000-0000-0000-000000000002'`,
  )
  assert.equal(c.aplicar_corte, false)
  assert.equal(c.cortar_tras_meses, 0, 'lo que decía el archivo tiene que sobrevivir')
})

test('volver a encender el interruptor deja un umbral utilizable', async () => {
  await db.exec(`
      UPDATE clientes SET aplicar_corte = TRUE
       WHERE id = 'c1310000-0000-0000-0000-000000000002';
  `)
  const c = await fila(
    db,
    `SELECT cortar_tras_meses FROM clientes WHERE id = 'c1310000-0000-0000-0000-000000000002'`,
  )
  assert.equal(c.cortar_tras_meses, 1, 'un mes, que es como trabajó siempre ese interruptor')
})

test('la lista de corte por mora respeta el umbral de cada uno', async () => {
  /**
   * El que paga cada tres meses no puede aparecer al primero, y el del servicio
   * gratis no puede aparecer nunca. Es lo que el interruptor de sí/no no podía
   * expresar.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, cortar_tras_meses, fecha_instalacion, activado_en, ip)
      VALUES
        ('c1310000-0000-0000-0000-000000000003', 'MOROSO DE UN MES', 'activo', 1,
         CURRENT_DATE - 400, NOW() - INTERVAL '13 months', '10.31.0.3'),
        ('c1310000-0000-0000-0000-000000000004', 'PAGA CADA SEIS', 'activo', 6,
         CURRENT_DATE - 400, NOW() - INTERVAL '13 months', '10.31.0.4'),
        ('c1310000-0000-0000-0000-000000000005', 'SERVICIO GRATIS', 'activo', 0,
         CURRENT_DATE - 400, NOW() - INTERVAL '13 months', '10.31.0.5');

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      SELECT id, nombre, 'otro', 'Servicio', CURRENT_DATE - 90, CURRENT_DATE - 60, 20, 0, 20
        FROM clientes WHERE id IN (
          'c1310000-0000-0000-0000-000000000003',
          'c1310000-0000-0000-0000-000000000004',
          'c1310000-0000-0000-0000-000000000005');
  `)

  /**
   * ── Lo que cambió con la 154 ──
   *
   * El plazo de cada uno se expresa en DÍAS DE GRACIA, no en un umbral de meses.
   * "Paga cada seis" son 180 días de gracia: es el mismo acuerdo dicho con el
   * campo que la ficha siempre mostró y que el corte antes ignoraba.
   */
  await db.exec(`
      UPDATE clientes SET dias_gracia = 180
       WHERE id = 'c1310000-0000-0000-0000-000000000004';
  `)

  const dosMeses = await db.query(
    `SELECT nombre FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id::TEXT LIKE 'c1310000%' ORDER BY nombre`,
  )
  const conDos = dosMeses.rows.map((x) => x.nombre)

  assert.ok(conDos.includes('MOROSO DE UN MES'), 'venció hace dos meses y no tiene gracia')
  assert.ok(!conDos.includes('PAGA CADA SEIS'), 'dos meses no pasan sus 180 días de gracia')
  assert.ok(!conDos.includes('SERVICIO GRATIS'), 'cero es nunca')

  // Y con una factura de verdad vieja, sí le toca.
  await db.exec(`
      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1310000-0000-0000-0000-000000000004','PAGA CADA SEIS','otro','Servicio',
              CURRENT_DATE - 240, CURRENT_DATE - 215, 20, 0, 20);
  `)

  const r = await db.query(
    `SELECT nombre FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id::TEXT LIKE 'c1310000%' ORDER BY nombre`,
  )
  const nombres = r.rows.map((x) => x.nombre)

  assert.ok(nombres.includes('PAGA CADA SEIS'), '215 días pasan sus 180 de gracia')
  assert.ok(!nombres.includes('SERVICIO GRATIS'), 'y el gratis sigue sin aparecer')

  // Se lo deja como estaba para las pruebas que vienen abajo.
  await db.exec(`
      UPDATE clientes SET dias_gracia = 0
       WHERE id = 'c1310000-0000-0000-0000-000000000004';
  `)
})


// ---------------------------------------------------------------------------
// 132 — El corte por mora, y la reconexión
// ---------------------------------------------------------------------------

test('al que tiene una promesa vigente no se lo corta', async () => {
  /**
   * Se le dio un plazo y todavía está dentro. Cortarlo ahí es no haber cumplido
   * nuestra parte, y es la clase de cosa que un abonado no olvida.
   */
  await sesion(db, null)
  await db.exec(`
      INSERT INTO promesas_pago (client_id, fecha_promesa, monto, estado)
      VALUES ('c1310000-0000-0000-0000-000000000003', CURRENT_DATE + 3, 20, 'activa');
  `)

  const r = await db.query(
    `SELECT 1 FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1310000-0000-0000-0000-000000000003'`,
  )
  assert.equal(r.rows.length, 0, 'la promesa vigente lo protege')
})

test('la promesa vencida deja de protegerlo', async () => {
  // De esa se encarga el corte de promesas, que es más específico y llega antes.
  await db.exec(`
      UPDATE promesas_pago SET fecha_promesa = CURRENT_DATE - 5
       WHERE client_id = 'c1310000-0000-0000-0000-000000000003';
  `)

  const r = await db.query(
    `SELECT 1 FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1310000-0000-0000-0000-000000000003'`,
  )
  assert.equal(r.rows.length, 1)
})

test('al excluido del firewall no se lo corta aunque deba', async () => {
  // Enlaces críticos, cámaras, instituciones: cortarlos por un saldo es
  // exactamente lo que esa marca viene a impedir.
  await db.exec(`
      UPDATE clientes SET excluir_firewall = TRUE
       WHERE id = 'c1310000-0000-0000-0000-000000000004';
  `)

  const r = await db.query(
    `SELECT 1 FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1310000-0000-0000-0000-000000000004'`,
  )
  assert.equal(r.rows.length, 0)

  await db.exec(`
      UPDATE clientes SET excluir_firewall = FALSE
       WHERE id = 'c1310000-0000-0000-0000-000000000004';
  `)
})

test('al que no tiene IP no se lo intenta cortar', async () => {
  // No hay qué mandarle al router. Aparecería como fallido en cada corrida, y
  // ese ruido diario tapa los fallos que sí importan.
  await db.exec(`
      UPDATE clientes SET ip = NULL WHERE id = 'c1310000-0000-0000-0000-000000000004';
  `)

  const r = await db.query(
    `SELECT 1 FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1310000-0000-0000-0000-000000000004'`,
  )
  assert.equal(r.rows.length, 0)

  await db.exec(`
      UPDATE clientes SET ip = '10.31.0.4' WHERE id = 'c1310000-0000-0000-0000-000000000004';
  `)
})

test('el que pagó vuelve a la lista de reconexión, y solo si lo cortó esta tarea', async () => {
  /**
   * Cortar sin reconectar es peor que no cortar: el abonado que paga a las
   * nueve de la mañana seguiría sin internet hasta que alguien mire una
   * pantalla. La llamada por un pago no honrado es peor que la de un corte,
   * porque el abonado ya cumplió.
   *
   * Pero solo se deshace lo que hizo esta tarea. Un corte por abuso o una
   * suspensión pedida por el propio abonado no se pueden deshacer porque su
   * saldo llegó a cero.
   */
  await db.exec(`
      INSERT INTO routers_mikrotik (id, nombre, ip_host, usuario, password_encrypted)
      VALUES ('7a320000-0000-0000-0000-000000000001', 'CCR MORA', '10.0.0.9', 'admin', 'x');

      -- Con antigüedad: un abonado creado hoy no puede deber dos meses, y
      -- meses_sin_pago cae a su fecha de alta cuando nunca pagó.
      INSERT INTO clientes (id, nombre, estado, ip, router_id, cortar_tras_meses,
                            fecha_instalacion, activado_en)
      VALUES
        ('c1320000-0000-0000-0000-000000000001', 'CORTADO POR MORA', 'cortado',
         '10.32.0.1', '7a320000-0000-0000-0000-000000000001', 1,
         CURRENT_DATE - 400, NOW() - INTERVAL '13 months'),
        ('c1320000-0000-0000-0000-000000000002', 'CORTADO POR ABUSO', 'cortado',
         '10.32.0.2', '7a320000-0000-0000-0000-000000000001', 1,
         CURRENT_DATE - 400, NOW() - INTERVAL '13 months');

      INSERT INTO firewall_bloqueos (router_id, cliente_id, cliente_ip, tipo_accion, comentario, activo)
      VALUES
        ('7a320000-0000-0000-0000-000000000001', 'c1320000-0000-0000-0000-000000000001',
         '10.32.0.1', 'CORTAR_SERVICIO', 'Corte por mora · 2 meses', TRUE),
        ('7a320000-0000-0000-0000-000000000001', 'c1320000-0000-0000-0000-000000000002',
         '10.32.0.2', 'CORTAR_SERVICIO', 'Corte por uso indebido del servicio', TRUE);
  `)

  const r = await db.query(`SELECT nombre FROM v_clientes_a_reconectar ORDER BY nombre`)
  const nombres = r.rows.map((x) => x.nombre)

  assert.ok(
    nombres.includes('CORTADO POR MORA'),
    'sin deuda, hay que devolverle el servicio aunque haga trece meses que no paga',
  )
  assert.ok(
    !nombres.includes('CORTADO POR ABUSO'),
    'un automatismo no puede deshacer la decisión de una persona',
  )
})

test('el que sigue debiendo no se reconecta', async () => {
  await db.exec(`
      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1320000-0000-0000-0000-000000000001','CORTADO POR MORA','otro','Servicio',
              CURRENT_DATE - 90, CURRENT_DATE - 60, 20, 0, 20);
  `)

  const r = await db.query(
    `SELECT 1 FROM v_clientes_a_reconectar
      WHERE cliente_id = 'c1320000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.rows.length, 0, 'debe y pasó su umbral: sigue cortado')
})

test('una promesa de pago le devuelve el servicio aunque siga debiendo', async () => {
  // Es el sentido de una promesa: se lo reconecta a cambio de un compromiso.
  await db.exec(`
      INSERT INTO promesas_pago (client_id, fecha_promesa, monto, estado)
      VALUES ('c1320000-0000-0000-0000-000000000001', CURRENT_DATE + 5, 20, 'activa');
  `)

  const r = await db.query(
    `SELECT 1 FROM v_clientes_a_reconectar
      WHERE cliente_id = 'c1320000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.rows.length, 1)
})

// ---------------------------------------------------------------------------
// 134 — El pago reconecta al instante
// ---------------------------------------------------------------------------

test('registrar un pago encola la reconexión en el acto', async () => {
  /**
   * Es lo que hace que no haya que esperar a ninguna corrida. El abonado paga en
   * la ventanilla y se queda mirando el teléfono: los sistemas que reemplazamos
   * lo devuelven en segundos.
   *
   * El disparador está sobre `pagos`, así que da igual desde dónde se cobre —la
   * ficha, la caja, el buscador, o un INSERT a mano desde el editor SQL—. Pedirle
   * a cada pantalla que avise sería pedirle a alguna que se olvide, y ese olvido
   * no da error: simplemente el abonado se queda cortado.
   */
  await sesion(db, null)
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, router_id, cortar_tras_meses)
      VALUES ('c1340000-0000-0000-0000-000000000009', 'PAGA Y VUELVE', 'cortado',
              '10.34.0.9', '7a320000-0000-0000-0000-000000000001', 1);

      INSERT INTO pagos (client_id, monto, fecha_pago)
      VALUES ('c1340000-0000-0000-0000-000000000009', 20, CURRENT_DATE);
  `)

  const p = await fila(
    db,
    `SELECT motivo, procesado_en FROM reconexiones_pendientes
      WHERE cliente_id = 'c1340000-0000-0000-0000-000000000009'`,
  )
  assert.equal(p.motivo, 'pago')
  assert.equal(p.procesado_en, null, 'queda esperando a que el middleware lo atienda')
})

test('pagar tres facturas seguidas encola un solo pedido', async () => {
  // Si no, el middleware haría tres viajes al router para el mismo trabajo.
  await db.exec(`
      INSERT INTO pagos (client_id, monto, fecha_pago) VALUES
        ('c1340000-0000-0000-0000-000000000009', 20, CURRENT_DATE),
        ('c1340000-0000-0000-0000-000000000009', 20, CURRENT_DATE);
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM reconexiones_pendientes
      WHERE cliente_id = 'c1340000-0000-0000-0000-000000000009' AND procesado_en IS NULL`,
  )
  assert.equal(n.n, 1)
})

test('el pago de alguien que NO está cortado no encola nada', async () => {
  /**
   * El noventa y nueve por ciento de los pagos son de gente con servicio.
   * Encolarlos a todos llenaría la cola de pedidos que no hacen nada y
   * escondería los que sí importan.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c1340000-0000-0000-0000-000000000001', 'AL DIA Y PAGA', 'activo');

      INSERT INTO pagos (client_id, monto, fecha_pago)
      VALUES ('c1340000-0000-0000-0000-000000000001', 20, CURRENT_DATE);
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM reconexiones_pendientes
      WHERE cliente_id = 'c1340000-0000-0000-0000-000000000001'`,
  )
  assert.equal(n.n, 0)
})

test('una promesa de pago también reconecta al instante', async () => {
  // Es el compromiso a cambio del cual se le devuelve el servicio: que eso
  // tarde sería raro, porque el abonado está del otro lado del teléfono.
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, router_id, cortar_tras_meses)
      VALUES ('c1340000-0000-0000-0000-000000000002', 'PROMETE PAGAR', 'cortado',
              '10.34.0.2', '7a320000-0000-0000-0000-000000000001', 1);

      INSERT INTO promesas_pago (client_id, fecha_promesa, monto, estado)
      VALUES ('c1340000-0000-0000-0000-000000000002', CURRENT_DATE + 3, 20, 'activa');
  `)

  const p = await fila(
    db,
    `SELECT motivo FROM reconexiones_pendientes
      WHERE cliente_id = 'c1340000-0000-0000-0000-000000000002'`,
  )
  assert.equal(p.motivo, 'promesa')
})

test('el pedido trae todo lo que hace falta para sacarlo del router', async () => {
  // Sin el bloqueo, el middleware no sabría qué entrada del address-list sacar.
  const r = await fila(
    db,
    `SELECT nombre, ip, bloqueo_id, lista FROM v_reconexiones_a_procesar
      WHERE cliente_id = 'c1320000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.nombre, 'CORTADO POR MORA')
  assert.ok(r.bloqueo_id, 'sin el bloqueo no se sabe qué sacar del address-list')
})

test('el que pagó de menos y sigue debiendo no se reconecta, y su pedido se cierra', async () => {
  /**
   * Entra a la cola —porque estaba cortado y pagó— pero al mirar con los datos
   * ya asentados sigue debiendo. Sin cerrarlo, ese pedido se quedaría ahí para
   * siempre y el día que pague el resto habría dos suyos.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, router_id, cortar_tras_meses,
                            fecha_instalacion, activado_en)
      VALUES ('c1340000-0000-0000-0000-000000000003', 'PAGO DE MENOS', 'cortado',
              '10.34.0.3', '7a320000-0000-0000-0000-000000000001', 1,
              CURRENT_DATE - 400, NOW() - INTERVAL '13 months');

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1340000-0000-0000-0000-000000000003','PAGO DE MENOS','otro','Servicio',
              CURRENT_DATE - 90, CURRENT_DATE - 60, 50, 0, 50);

      INSERT INTO pagos (client_id, monto, fecha_pago)
      VALUES ('c1340000-0000-0000-0000-000000000003', 10, CURRENT_DATE);

      -- El minuto de gracia es para que el pago y su imputación no se pisen.
      UPDATE reconexiones_pendientes SET creado_en = NOW() - INTERVAL '5 minutes'
       WHERE cliente_id = 'c1340000-0000-0000-0000-000000000003';
  `)

  const antes = await db.query(
    `SELECT 1 FROM v_reconexiones_a_procesar
      WHERE cliente_id = 'c1340000-0000-0000-0000-000000000003'`,
  )
  assert.equal(antes.rows.length, 0, 'sigue debiendo: no se lo reconecta')

  await db.query(`SELECT limpiar_reconexiones_vencidas()`)

  const p = await fila(
    db,
    `SELECT procesado_en, error FROM reconexiones_pendientes
      WHERE cliente_id = 'c1340000-0000-0000-0000-000000000003'`,
  )
  assert.ok(p.procesado_en, 'el pedido se cierra en vez de quedarse para siempre')
  assert.match(p.error, /Ya no correspondía/)
})

// ---------------------------------------------------------------------------
// 135 — Avisar el corte y el pago
// ---------------------------------------------------------------------------

test('cobrar encola la confirmacion, este cortado o no', async () => {
  /**
   * Este aviso no tiene que ver con el corte: es el acuse de recibo del dinero.
   * El abonado al dia que paga por transferencia y no recibe nada llama igual
   * -o peor, vuelve a pagar-.
   */
  await sesion(db, null)
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email)
      VALUES ('c1350000-0000-0000-0000-000000000001', 'PAGA Y ESTA AL DIA', 'activo', 'i@x.com');

      INSERT INTO pagos (client_id, monto, fecha_pago)
      VALUES ('c1350000-0000-0000-0000-000000000001', 20, CURRENT_DATE);
  `)

  const a = await fila(
    db,
    `SELECT tipo, procesado_en FROM avisos_pendientes
      WHERE cliente_id = 'c1350000-0000-0000-0000-000000000001'
        AND tipo = 'pago_confirmado'`,
  )
  assert.equal(a.tipo, 'pago_confirmado')
  assert.equal(a.procesado_en, null)
})

test('el aviso trae el monto, que no vive en la ficha', async () => {
  // Sin el, la plantilla mostraria "{{monto}}" tal cual, y el acuse no diria
  // cuanto se recibio -que es lo unico que el abonado quiere confirmar-.
  const v = await fila(
    db,
    `SELECT nombre, monto, saldo FROM v_avisos_a_enviar
      WHERE cliente_id = 'c1350000-0000-0000-0000-000000000001'
        AND tipo = 'pago_confirmado'`,
  )
  assert.equal(Number(v.monto), 20)
})

test('dos pagos el mismo dia son dos avisos', async () => {
  // Son dos comprobantes distintos, y el abonado quiere ver reconocidos los dos.
  await db.exec(`
      INSERT INTO pagos (client_id, monto, fecha_pago)
      VALUES ('c1350000-0000-0000-0000-000000000001', 15, CURRENT_DATE);
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes
      WHERE cliente_id = 'c1350000-0000-0000-0000-000000000001'
        AND tipo = 'pago_confirmado'`,
  )
  assert.equal(n.n, 2)
})

test('un pago anulado despues de cobrarse no se confirma', async () => {
  // Seria avisarle de plata que ya no esta.
  await db.exec(`
      UPDATE pagos SET anulado = TRUE
       WHERE client_id = 'c1350000-0000-0000-0000-000000000001';
  `)

  const r = await db.query(
    `SELECT 1 FROM v_avisos_a_enviar
      WHERE cliente_id = 'c1350000-0000-0000-0000-000000000001'
        AND tipo = 'pago_confirmado'`,
  )
  assert.equal(r.rows.length, 0)
})

test('la plantilla del corte por correo existe', async () => {
  /**
   * Existia la corta para SMS y WhatsApp, no la de correo. Sin ella, al abonado
   * que solo tiene correo cargado se le cortaba el servicio sin decirle nada.
   */
  const p = await fila(
    db,
    `SELECT nombre, asunto FROM plantillas_mensaje WHERE clave = 'mail_corte_servicio'`,
  )
  assert.equal(p.nombre, 'Corte de servicio')
  assert.ok(p.asunto)
})

// ---------------------------------------------------------------------------
// 136 — La pantalla de aviso, en el router
// ---------------------------------------------------------------------------

test('sin lista de aviso configurada, el router no muestra aviso previo', async () => {
  /**
   * Es el valor de fabrica y es lo correcto: sin una regla de redireccion que
   * actue sobre esa lista, meter abonados ahi no hace nada — y las entradas se
   * acumularian en el equipo sin ningun efecto visible.
   */
  await sesion(db, null)
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, router_id, aviso_pantalla_dias,
                            cortar_tras_meses, fecha_instalacion, activado_en)
      VALUES ('c1360000-0000-0000-0000-000000000001', 'POR VENCER CON PANTALLA', 'activo',
              '10.36.0.1', '7a320000-0000-0000-0000-000000000001', -3, 1,
              CURRENT_DATE - 400, NOW() - INTERVAL '13 months');

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1360000-0000-0000-0000-000000000001','POR VENCER CON PANTALLA','otro','Servicio',
              CURRENT_DATE - 25, CURRENT_DATE + 2, 20, 0, 20);
  `)

  const enVentana = await db.query(
    `SELECT 1 FROM v_avisos_pantalla WHERE cliente_id = 'c1360000-0000-0000-0000-000000000001'`,
  )
  assert.equal(enVentana.rows.length, 1, 'esta dentro de su ventana de aviso')

  const aPoner = await db.query(
    `SELECT 1 FROM v_aviso_pantalla_a_poner
      WHERE cliente_id = 'c1360000-0000-0000-0000-000000000001'`,
  )
  assert.equal(aPoner.rows.length, 0, 'pero su router no sabe avisar')
})

test('con la lista configurada, entra a la de poner', async () => {
  await db.exec(`
      UPDATE routers_mikrotik SET lista_aviso = 'Aviso'
       WHERE id = '7a320000-0000-0000-0000-000000000001';
  `)

  const r = await fila(
    db,
    `SELECT nombre, lista_aviso, dias FROM v_aviso_pantalla_a_poner
      WHERE cliente_id = 'c1360000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.lista_aviso, 'Aviso')
  assert.equal(Number(r.dias), -2, 'le faltan dos dias para vencer')
})

test('una vez puesto, no se lo pone de nuevo', async () => {
  // Sin esto, cada corrida agregaria otra entrada al address-list para el mismo
  // abonado, y el equipo terminaria con cientos de duplicados.
  await db.exec(`
      INSERT INTO firewall_bloqueos (router_id, cliente_id, cliente_ip, tipo_accion, comentario, lista, activo)
      VALUES ('7a320000-0000-0000-0000-000000000001', 'c1360000-0000-0000-0000-000000000001',
              '10.36.0.1', 'REDIRECCION_PAGO', 'Aviso de pago . vence en 2 dias', 'Aviso', TRUE);
  `)

  const r = await db.query(
    `SELECT 1 FROM v_aviso_pantalla_a_poner
      WHERE cliente_id = 'c1360000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.rows.length, 0)
})

test('al que se corta se lo saca de la lista de aviso', async () => {
  /**
   * Si quedara en las dos listas, la primera regla que coincida decide que
   * pagina ve — y bien podria ser la de "tu factura esta por vencer" cuando ya
   * se quedo sin servicio.
   */
  await db.exec(`
      UPDATE clientes SET estado = 'cortado'
       WHERE id = 'c1360000-0000-0000-0000-000000000001';
  `)

  const r = await fila(
    db,
    `SELECT nombre, estado FROM v_aviso_pantalla_a_sacar
      WHERE cliente_id = 'c1360000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.estado, 'cortado')
})

test('al que apaga la pantalla en su ficha tambien se lo saca', async () => {
  await db.exec(`
      UPDATE clientes SET estado = 'activo', avisos_pantalla = FALSE
       WHERE id = 'c1360000-0000-0000-0000-000000000001';
  `)

  const r = await db.query(
    `SELECT 1 FROM v_aviso_pantalla_a_sacar
      WHERE cliente_id = 'c1360000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.rows.length, 1)
})

// ---------------------------------------------------------------------------
// 137 — La bienvenida y los avisos de soporte
// ---------------------------------------------------------------------------

test('al abonado nuevo se le da la bienvenida', async () => {
  await sesion(db, null)
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email)
      VALUES ('c1370000-0000-0000-0000-000000000001', 'ABONADO NUEVO', 'activo', 'j@x.com');
  `)

  const a = await fila(
    db,
    `SELECT tipo FROM avisos_pendientes
      WHERE cliente_id = 'c1370000-0000-0000-0000-000000000001' AND tipo = 'bienvenida'`,
  )
  assert.equal(a.tipo, 'bienvenida')
})

test('al abonado MIGRADO no se le da la bienvenida', async () => {
  /**
   * ── La trampa que esta prueba ataja ──
   *
   * Al migrar un padron, quinientos abonados pasan a activo el mismo dia. Sin
   * esta condicion, quinientas personas que llevan anios con el servicio
   * recibirian "bienvenido, tu servicio ya esta activo" — y contestarian todas
   * preguntando que paso.
   *
   * Es un error que no se descubre probando: se descubre por los mensajes de
   * vuelta, cuando ya salieron.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, email, sistema_origen, codigo_externo)
      VALUES ('c1370000-0000-0000-0000-000000000002', 'ABONADO MIGRADO', 'activo',
              'k@x.com', 'wisphub', 'W-1');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes
      WHERE cliente_id = 'c1370000-0000-0000-0000-000000000002' AND tipo = 'bienvenida'`,
  )
  assert.equal(n.n, 0)
})

test('la bienvenida se da una sola vez, aunque se corte y vuelva', async () => {
  // `activado_en` se sella la primera vez y no se edita: es el momento real del
  // alta, y no vuelve a ocurrir aunque el estado vaya y venga con los cortes.
  await db.exec(`
      UPDATE clientes SET estado = 'cortado' WHERE id = 'c1370000-0000-0000-0000-000000000001';
      UPDATE clientes SET estado = 'activo'  WHERE id = 'c1370000-0000-0000-0000-000000000001';
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes
      WHERE cliente_id = 'c1370000-0000-0000-0000-000000000001' AND tipo = 'bienvenida'`,
  )
  assert.equal(n.n, 1)
})

test('abrir un reporte le avisa al abonado, con su numero', async () => {
  /**
   * El abonado que reporta una falla se queda sin saber si alguien lo leyo. Esa
   * incertidumbre es la que produce la segunda llamada, y la tercera.
   */
  await db.exec(`
      INSERT INTO tickets (id, client_id, nombre, tipo_incidencia, estado)
      VALUES ('71370000-0000-0000-0000-000000000001', 'c1370000-0000-0000-0000-000000000001',
              'ABONADO NUEVO', 'sin_internet', 'abierto');
  `)

  const v = await fila(
    db,
    `SELECT tipo, ticket, motivo FROM v_avisos_a_enviar
      WHERE cliente_id = 'c1370000-0000-0000-0000-000000000001' AND tipo = 'ticket_abierto'`,
  )
  assert.ok(v.ticket, 'el mensaje tiene que llevar el numero de reporte')
  assert.equal(v.motivo, 'sin_internet')
})

test('asignarle tecnico avisa, y reasignarlo no avisa de nuevo', async () => {
  // Al abonado le importa que alguien vaya, no cuantas veces lo movimos de
  // tecnico entre nosotros.
  await db.exec(`
      INSERT INTO tecnicos (id, nombre, activo) VALUES
        ('71370000-0000-0000-0000-0000000000aa', 'Tec Uno', true),
        ('71370000-0000-0000-0000-0000000000bb', 'Tec Dos', true);

      UPDATE tickets SET tecnico_id = '71370000-0000-0000-0000-0000000000aa'
       WHERE id = '71370000-0000-0000-0000-000000000001';
      UPDATE tickets SET tecnico_id = '71370000-0000-0000-0000-0000000000bb'
       WHERE id = '71370000-0000-0000-0000-000000000001';
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes
      WHERE referencia_id = '71370000-0000-0000-0000-000000000001' AND tipo = 'ticket_asignado'`,
  )
  assert.equal(n.n, 1)

  const v = await fila(
    db,
    `SELECT tecnico FROM v_avisos_a_enviar WHERE tipo = 'ticket_asignado'
        AND cliente_id = 'c1370000-0000-0000-0000-000000000001'`,
  )
  assert.equal(v.tecnico, 'Tec Dos', 'lleva el tecnico que quedo asignado, no el primero')
})

test('cada respuesta al reporte es un aviso distinto', async () => {
  // Son mensajes distintos y el abonado quiere leerlos todos: la referencia es
  // el evento, no el ticket.
  await db.exec(`
      -- Con estado_anterior, como los que registra la aplicacion: el unico que
      -- viene sin el es la apertura, que no es una respuesta.
      INSERT INTO ticket_eventos (ticket_id, estado_anterior, estado_nuevo, nota) VALUES
        ('71370000-0000-0000-0000-000000000001', 'abierto', 'en_proceso', 'Pasamos manana entre 9 y 12'),
        ('71370000-0000-0000-0000-000000000001', 'en_proceso', 'resuelto', 'Se cambio el conector de la caja');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes
      WHERE cliente_id = 'c1370000-0000-0000-0000-000000000001' AND tipo = 'ticket_respuesta'`,
  )
  assert.equal(n.n, 2)

  const v = await fila(
    db,
    `SELECT respuesta FROM v_avisos_a_enviar
      WHERE tipo = 'ticket_respuesta' AND respuesta LIKE 'Se cambio%'`,
  )
  assert.match(v.respuesta, /conector/)
})

test('la apertura del ticket no cuenta como respuesta', async () => {
  /**
   * Al crear un ticket la base registra sola un evento con la nota "Ticket
   * creado". Sin excluirlo, el abonado recibia DOS mensajes por lo mismo:
   * "recibimos su reporte" y, un segundo despues, "sobre su reporte: Ticket
   * creado".
   *
   * Lo encontro una prueba que contaba mal, no una revision del codigo.
   */
  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes a
       JOIN ticket_eventos e ON e.id = a.referencia_id
      WHERE a.tipo = 'ticket_respuesta' AND e.estado_anterior IS NULL`,
  )
  assert.equal(n.n, 0)
})

test('un cambio de estado sin nota no es una respuesta', async () => {
  // Mandarlo seria avisarle de un mensaje vacio.
  await db.exec(`
      INSERT INTO ticket_eventos (ticket_id, estado_anterior, estado_nuevo)
      VALUES ('71370000-0000-0000-0000-000000000001', 'resuelto', 'cerrado');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes
      WHERE cliente_id = 'c1370000-0000-0000-0000-000000000001' AND tipo = 'ticket_respuesta'`,
  )
  assert.equal(n.n, 2, 'sigue habiendo dos: el cierre sin nota no cuenta')
})

test('un reporte de quien todavia no es abonado no encola nada', async () => {
  // No hay ficha de donde sacar el correo ni el celular.
  await db.exec(`
      INSERT INTO tickets (id, client_id, nombre, tipo_incidencia, estado)
      VALUES ('71370000-0000-0000-0000-000000000002', NULL, 'ALGUIEN QUE LLAMO',
              'sin_internet', 'abierto');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM avisos_pendientes
      WHERE referencia_id = '71370000-0000-0000-0000-000000000002'`,
  )
  assert.equal(n.n, 0)
})

test('dos plantillas no pueden compartir la clave', async () => {
  // Es como las busca el código: con dos, encontraría una u otra según el humor
  // del planificador de consultas.
  await assert.rejects(
    () => db.exec(`
        INSERT INTO plantillas_mensaje (clave, nombre, canal, categoria, cuerpo)
        VALUES ('web_aviso_corte', 'Otra', 'web', 'web', 'x')`),
    /duplicate key|unique/i,
  )
})

// ---------------------------------------------------------------------------
// 138 — Que gobierna de verdad cada plantilla de documento
// ---------------------------------------------------------------------------

test('el editor no promete que el RIDE se arma desde su plantilla', async () => {
  /**
   * Es la promesa mas cara de las seis: el ISP edita media hora un texto que no
   * va a salir impreso en ninguna parte, y ademas cree que puede cambiar un
   * documento con validez fiscal.
   */
  const p = await fila(
    db,
    `SELECT descripcion FROM plantillas_mensaje WHERE clave = 'doc_factura_sri'`,
  )
  assert.match(p.descripcion, /NO se arma desde aca|NO se arma desde acá/)
  assert.match(p.descripcion, /informaci[oó]n adicional/i, 'dice a donde ir para lo que si se edita')
})

test('la plantilla del comprobante gobierna lo que se imprime', async () => {
  /**
   * ── Lo que esta prueba defendia antes, y por que cambio ──
   *
   * Decia que `doc_recibo` tenia que anunciarse como ALTERNATIVO, porque generaba
   * un PDF que ninguna pantalla usaba: el ISP podia editarlo, guardarlo, mirar la
   * vista previa, y el papel que recibia el cliente no cambiaba nunca. El aviso
   * era un parche sobre un editor que no editaba nada.
   *
   * La 167 lo resolvio de raiz: esa plantilla es ahora el MENSAJE que va impreso
   * en el comprobante y en el PDF del correo. Ya no hay nada de que advertir,
   * porque editarla cambia lo que sale.
   */
  const p = await fila(
    db,
    `SELECT nombre, descripcion, cuerpo FROM plantillas_mensaje WHERE clave = 'doc_recibo'`,
  )

  assert.doesNotMatch(
    p.descripcion,
    /ALTERNATIVO/,
    'ya no es una plantilla que no se usa: lo que dice sale impreso',
  )
  assert.match(p.descripcion, /imprime|comprobante/i, 'tiene que decir dónde sale')
  assert.ok(p.cuerpo?.trim(), 'y traer un texto de arranque para no salir en blanco')
})

test('la 138 no le toca el cuerpo a ninguna plantilla', async () => {
  /**
   * Es la regla de todo el editor: una migracion que se reejecuta no puede
   * devolverle el texto de fabrica a quien redacto el suyo.
   *
   * Se comprueba de verdad: se edita un cuerpo, se vuelve a correr la 138 y
   * tiene que seguir estando lo editado.
   */
  await db.exec(`
      UPDATE plantillas_mensaje
         SET cuerpo = '<h1>MI CONTRATO PROPIO</h1>'
       WHERE clave = 'doc_contrato';
  `)

  const archivo = MIGRACIONES.find((f) => numero(f) === 138)
  assert.ok(archivo, 'no se encontro la migracion 138')
  await db.exec(
    readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), archivo), 'utf8'),
  )

  const p = await fila(
    db,
    `SELECT cuerpo, descripcion FROM plantillas_mensaje WHERE clave = 'doc_contrato'`,
  )
  assert.equal(p.cuerpo, '<h1>MI CONTRATO PROPIO</h1>', 'el cuerpo editado sobrevive')
  assert.match(p.descripcion, /exactamente lo que se imprime/, 'la descripcion si se actualiza')
})

test('cada plantilla de documento ofrece las variables que el codigo llena', async () => {
  /**
   * El editor muestra esta lista como la ayuda de que se puede escribir. Una
   * variable que figura y el codigo no llena sale impresa como {{asi}} en un
   * papel que alguien firma.
   */
  const esperadas = {
    doc_contrato: ['empresa', 'nombre', 'plan', 'precio', 'fecha_instalacion', 'dia_pago'],
    doc_hoja_instalacion: ['orden', 'equipo', 'serie', 'tecnico', 'potencia'],
    doc_ticket: ['ticket', 'motivo', 'solucion', 'tecnico'],
    doc_recibo: ['numero', 'monto', 'concepto', 'forma_pago'],
    doc_recibo_pos: ['numero', 'monto', 'concepto', 'forma_pago'],
  }

  for (const [clave, deben] of Object.entries(esperadas)) {
    const p = await fila(db, `SELECT variables FROM plantillas_mensaje WHERE clave = '${clave}'`)
    for (const v of deben) {
      assert.ok(p.variables.includes(v), `${clave} deberia ofrecer {{${v}}}`)
    }
  }
})

// ---------------------------------------------------------------------------
// 139 — El contrato de adhesion de ARCOTEL
// ---------------------------------------------------------------------------

test('no puede haber dos prestadores predeterminados', async () => {
  // Con dos, el contrato de quien no tiene prestador asignado saldria a nombre
  // de uno u otro segun el humor del planificador de consultas.
  await assert.rejects(
    () => db.exec(`
        INSERT INTO prestadores (razon_social, ruc, predeterminado)
        VALUES ('OTRO ISP', '9999999999001', TRUE)`),
    /duplicate key|unique/i,
  )
})

test('lo que el abonado no respondio queda sin responder, no en NO', async () => {
  /**
   * El formulario obliga a marcar si es adulto mayor o discapacitado —da derecho
   * a tarifa preferencial— y si acepta arbitraje, que "puede significar costos
   * en los que debe incurrir el Abonado".
   *
   * Un FALSE por defecto imprimiria un "NO" que nadie dijo: en el primer caso le
   * quitaria un derecho, en el segundo lo comprometeria a un gasto.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c1390000-0000-0000-0000-000000000001', 'SIN PREGUNTAR', 'activo');
  `)

  const c = await fila(
    db,
    `SELECT tarifa_preferencial, acepta_arbitraje, equipo_modalidad
       FROM clientes WHERE id = 'c1390000-0000-0000-0000-000000000001'`,
  )
  assert.equal(c.tarifa_preferencial, null)
  assert.equal(c.acepta_arbitraje, null)
  // El arrendamiento si tiene valor por defecto: es lo normal, y el propio
  // anexo dice que por el router no se puede cobrar.
  assert.equal(c.equipo_modalidad, 'arrendamiento')
})

test('la ficha puede releer los datos del contrato que se guardan', async () => {
  /**
   * Ya paso una vez con las preferencias de avisos: se guardaban bien y la
   * pantalla seguia mostrando los valores de fabrica porque la vista no las
   * exponia. Guardar sin poder releer se ve igual que no guardar.
   */
  const p = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)
  await db.exec(`
      UPDATE clientes
         SET prestador_id = '${p.id}', provincia = 'Cotopaxi', parroquia = 'El Carmen',
             tarifa_preferencial = TRUE, acepta_arbitraje = FALSE
       WHERE id = 'c1390000-0000-0000-0000-000000000001';
  `)

  const f = await fila(
    db,
    `SELECT prestador, provincia, parroquia, tarifa_preferencial, acepta_arbitraje
       FROM v_clientes_ficha WHERE id = 'c1390000-0000-0000-0000-000000000001'`,
  )
  assert.equal(f.provincia, 'Cotopaxi')
  assert.equal(f.parroquia, 'El Carmen')
  assert.equal(f.tarifa_preferencial, true)
  assert.equal(f.acepta_arbitraje, false)
  assert.ok(f.prestador, 'la ficha tiene que poder decir de que prestador es')
})

test('el modelo inscrito trae su fecha, que se imprime al pie', async () => {
  // Es lo que permite verificar que el papel firmado corresponde a un modelo
  // aprobado por la ARCOTEL. Sin fecha, el contrato no se puede contrastar.
  const p = await fila(
    db,
    `SELECT modelo_inscrito_el, vigencia_meses, permanencia_meses, valor_instalacion
       FROM prestadores WHERE predeterminado`,
  )
  assert.ok(p.modelo_inscrito_el, 'falta la fecha de inscripcion del modelo')
  assert.equal(p.vigencia_meses, 24)
  assert.equal(p.permanencia_meses, 24)
})

test('reejecutar la 139 no duplica prestadores ni pisa lo editado', async () => {
  // El ISP completa sus datos desde la pantalla; una migracion que se
  // reejecuta no puede devolverle los de fabrica.
  await db.exec(`
      UPDATE prestadores SET web = 'https://mi-propia-web.ec' WHERE predeterminado;
  `)
  const antes = await fila(db, `SELECT COUNT(*)::INT AS n FROM prestadores`)

  const archivo = MIGRACIONES.find((f) => numero(f) === 139)
  assert.ok(archivo, 'no se encontro la migracion 139')
  await db.exec(
    readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), archivo), 'utf8'),
  )

  const despues = await fila(db, `SELECT COUNT(*)::INT AS n FROM prestadores`)
  assert.equal(despues.n, antes.n, 'no se sembro nada de nuevo')

  const p = await fila(db, `SELECT web FROM prestadores WHERE predeterminado`)
  assert.equal(p.web, 'https://mi-propia-web.ec', 'lo editado sobrevive')
})

// ---------------------------------------------------------------------------
// 141 — El contrato empieza en la venta
// ---------------------------------------------------------------------------

test('marcar tercera edad pone sola la casilla del contrato', async () => {
  /**
   * Sin esto se podria guardar un abonado marcado como adulto mayor cuyo
   * contrato imprime NO en la casilla de tarifa preferencial. Nadie lo notaria
   * hasta que el abonado reclamara el descuento que le corresponde.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, condicion_especial)
      VALUES ('c1410000-0000-0000-0000-000000000001', 'ADULTO MAYOR', 'activo', 'tercera_edad');
  `)

  const c = await fila(
    db,
    `SELECT condicion_especial, tarifa_preferencial FROM clientes
      WHERE id = 'c1410000-0000-0000-0000-000000000001'`,
  )
  assert.equal(c.condicion_especial, 'tercera_edad')
  assert.equal(c.tarifa_preferencial, true)
})

test('quitarle la condicion deja la casilla en NO, no en sin responder', async () => {
  // Alguien la respondio; la respuesta ahora es que no le corresponde.
  await db.exec(`
      UPDATE clientes SET condicion_especial = 'ninguna'
       WHERE id = 'c1410000-0000-0000-0000-000000000001';
  `)

  const c = await fila(
    db,
    `SELECT tarifa_preferencial FROM clientes
      WHERE id = 'c1410000-0000-0000-0000-000000000001'`,
  )
  assert.equal(c.tarifa_preferencial, false)
})

test('un SI sin condicion del catalogo sigue siendo valido', async () => {
  // El formulario admite marcar SI sin explicar por que, y hay motivos que este
  // catalogo no cubre.
  await db.exec(`
      UPDATE clientes SET tarifa_preferencial = TRUE
       WHERE id = 'c1410000-0000-0000-0000-000000000001';
  `)

  const c = await fila(
    db,
    `SELECT condicion_especial, tarifa_preferencial FROM clientes
      WHERE id = 'c1410000-0000-0000-0000-000000000001'`,
  )
  assert.equal(c.condicion_especial, 'ninguna')
  assert.equal(c.tarifa_preferencial, true, 'el trigger no lo pisa')
})

test('lo que el vendedor anota en la orden llega a la ficha', async () => {
  /**
   * Es el punto de toda la migracion: quien sabe si el abonado es adulto mayor
   * es el vendedor, en la puerta de la casa. Si eso no viaja al alta, hay que
   * volver a preguntarlo por telefono — y en la practica nadie lo hace.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c1410000-0000-0000-0000-000000000002', 'DE LA VENTA', 'activo');

      INSERT INTO instalaciones (id, client_id, tipo, estado, fecha, nombre,
                                 provincia, canton, ciudad, parroquia,
                                 condicion_especial, acepta_arbitraje, equipo_modalidad)
      VALUES ('11410000-0000-0000-0000-000000000001',
              'c1410000-0000-0000-0000-000000000002',
              'nueva', 'agendada', CURRENT_DATE, 'DE LA VENTA',
              'Cotopaxi', 'La Mana', 'La Mana', 'El Carmen',
              'discapacidad', TRUE, 'compra');

      UPDATE instalaciones SET estado = 'hecha'
       WHERE id = '11410000-0000-0000-0000-000000000001';
  `)

  const c = await fila(
    db,
    `SELECT provincia, parroquia, condicion_especial, tarifa_preferencial,
            acepta_arbitraje, equipo_modalidad
       FROM clientes WHERE id = 'c1410000-0000-0000-0000-000000000002'`,
  )
  assert.equal(c.provincia, 'Cotopaxi')
  assert.equal(c.parroquia, 'El Carmen')
  assert.equal(c.condicion_especial, 'discapacidad')
  assert.equal(c.tarifa_preferencial, true, 'la casilla viaja resuelta')
  assert.equal(c.acepta_arbitraje, true)
  assert.equal(c.equipo_modalidad, 'compra')
})

test('lo que la orden dejo vacio no pisa lo que la oficina corrigio', async () => {
  /**
   * La oficina corrige por telefono lo que el vendedor no pregunto. Cerrar la
   * orden despues no puede volver a vaciarlo: seria perder el trabajo de quien
   * llamo.
   */
  await db.exec(`
      UPDATE clientes SET provincia = 'Los Rios'
       WHERE id = 'c1410000-0000-0000-0000-000000000002';

      INSERT INTO instalaciones (id, client_id, tipo, estado, fecha, nombre)
      VALUES ('11410000-0000-0000-0000-000000000002',
              'c1410000-0000-0000-0000-000000000002',
              'nueva', 'agendada', CURRENT_DATE, 'DE LA VENTA');

      UPDATE instalaciones SET estado = 'hecha'
       WHERE id = '11410000-0000-0000-0000-000000000002';
  `)

  const c = await fila(
    db,
    `SELECT provincia, acepta_arbitraje FROM clientes
      WHERE id = 'c1410000-0000-0000-0000-000000000002'`,
  )
  assert.equal(c.provincia, 'Los Rios', 'la correccion de la oficina sobrevive')
  assert.equal(c.acepta_arbitraje, true, 'y lo que ya estaba respondido tambien')
})

test('el arbitraje viene PROPUESTO, no impuesto por la columna', async () => {
  /**
   * El ISP puede querer que sus contratos salgan con el arbitraje aceptado, y es
   * legitimo. Pero no puede ser un DEFAULT TRUE en la columna: el contrato dice
   * que el Abonado "debera senalarlo en forma expresa" y que someterse "puede
   * significar costos en los que debe incurrir el Abonado", y ademas tiene su
   * propia raya de firma.
   *
   * La preferencia vive en el prestador; la columna sigue naciendo sin
   * responder.
   */
  const p = await fila(db, `SELECT arbitraje_por_defecto FROM prestadores WHERE predeterminado`)
  assert.equal(p.arbitraje_por_defecto, true, 'el ISP lo propone en SI')

  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c1410000-0000-0000-0000-000000000003', 'NADIE PREGUNTO', 'activo');
  `)
  const c = await fila(
    db,
    `SELECT acepta_arbitraje FROM clientes WHERE id = 'c1410000-0000-0000-0000-000000000003'`,
  )
  assert.equal(c.acepta_arbitraje, null, 'la columna nace sin responder')
})

test('la orden expone los datos del contrato para poder editarlos', async () => {
  const i = await fila(
    db,
    `SELECT provincia, parroquia, condicion_especial, acepta_arbitraje, equipo_modalidad
       FROM v_instalaciones WHERE id = '11410000-0000-0000-0000-000000000001'`,
  )
  assert.equal(i.provincia, 'Cotopaxi')
  assert.equal(i.condicion_especial, 'discapacidad')
  assert.equal(i.equipo_modalidad, 'compra')
})

test('la ficha expone la condicion del abonado', async () => {
  const c = await fila(
    db,
    `SELECT condicion_especial FROM v_clientes_ficha
      WHERE id = 'c1410000-0000-0000-0000-000000000002'`,
  )
  assert.equal(c.condicion_especial, 'discapacidad')
})

// ---------------------------------------------------------------------------
// 142 — El prestador hereda lo que el SRI ya sabe
// ---------------------------------------------------------------------------

test('cambiar la razon social en el SRI la cambia en su prestador', async () => {
  /**
   * Tener dos versiones de la razon social —una en cada pantalla— es como se
   * llega a un contrato que dice algo distinto de la factura del mismo mes.
   */
  // El arnes no trae datos de facturacion cargados, que es lo mismo que un ISP
  // recien instalado — justo el caso que hay que probar.
  await db.exec(`
      INSERT INTO sri_config (ruc, razon_social, dir_matriz, telefono, email)
      SELECT '1799999999001', 'QUIEN FACTURA SA', 'Av. Siempre Viva 100',
             '0980000000', 'facturacion@ejemplo.ec'
       WHERE NOT EXISTS (SELECT 1 FROM sri_config);
  `)
  const s = await fila(db, `SELECT ruc FROM sri_config LIMIT 1`)

  // Un prestador con el MISMO RUC que quien factura.
  await db.exec(`
      INSERT INTO prestadores (razon_social, ruc, predeterminado)
      VALUES ('NOMBRE VIEJO', '${s.ruc}', FALSE);

      UPDATE sri_config SET razon_social = 'NOMBRE NUEVO SA' WHERE ruc = '${s.ruc}';
  `)

  const p = await fila(db, `SELECT razon_social FROM prestadores WHERE ruc = '${s.ruc}'`)
  assert.equal(p.razon_social, 'NOMBRE NUEVO SA')
})

test('un prestador con OTRO ruc no se toca', async () => {
  /**
   * Quien factura y quien presta el servicio coinciden casi siempre, pero no
   * necesariamente. Copiar los datos de una entidad sobre la otra pondria en el
   * contrato el nombre de quien no lo firma.
   */
  await db.exec(`
      INSERT INTO prestadores (razon_social, ruc, predeterminado)
      VALUES ('OTRO NEGOCIO', '9988776655001', FALSE);

      UPDATE sri_config SET razon_social = 'CAMBIO OTRA VEZ SA';
  `)

  const p = await fila(db, `SELECT razon_social FROM prestadores WHERE ruc = '9988776655001'`)
  assert.equal(p.razon_social, 'OTRO NEGOCIO', 'el de otro RUC queda intacto')
})

test('el SRI no borra lo que el prestador tenia y el no sabe', async () => {
  // Si el SRI todavia no tiene telefono, no puede dejar sin telefono al
  // contrato.
  const s = await fila(db, `SELECT ruc FROM sri_config LIMIT 1`)
  await db.exec(`
      UPDATE prestadores SET telefono = '0999111222' WHERE ruc = '${s.ruc}';
      UPDATE sri_config SET telefono = NULL WHERE ruc = '${s.ruc}';
  `)

  const p = await fila(db, `SELECT telefono FROM prestadores WHERE ruc = '${s.ruc}'`)
  assert.equal(p.telefono, '0999111222')
})

test('la vista dice exactamente que le falta a cada prestador', async () => {
  /**
   * Es lo que el SRI no puede darle: son de otro tramite ante otro regulador.
   * Sin la fecha de inscripcion, el contrato no se puede contrastar contra un
   * modelo aprobado.
   */
  const p = await fila(
    db,
    `SELECT le_falta, hereda_del_sri FROM v_prestadores_listos WHERE ruc = '9988776655001'`,
  )

  assert.equal(p.hereda_del_sri, false, 'ese no factura, no hereda nada')
  const falta = p.le_falta.join(' | ')
  assert.match(falta, /ARCOTEL/)
  assert.match(falta, /parroquia/i)
  assert.match(falta, /anexo 1f/)
  assert.match(falta, /canal de reclamo/i)
})

test('al prestador completo no le falta nada', async () => {
  const p = await fila(
    db,
    `SELECT le_falta FROM v_prestadores_listos WHERE ruc = '1250579925001'`,
  )
  assert.deepEqual(p.le_falta, [], `todavia le falta: ${p.le_falta}`)
})

// ---------------------------------------------------------------------------
// 145 — Los papeles del abonado empiezan en la venta
// ---------------------------------------------------------------------------

test('el vendedor puede subir la cedula antes de que exista la ficha', async () => {
  /**
   * Es el motivo de toda la migracion. La cedula la ve el vendedor en la casa
   * del cliente; la ficha no existe hasta el alta, dias despues. Sin esto, la
   * unica pantalla para subirla es la de una ficha que todavia no hay — y por
   * eso `documentos` estaba en cero.
   */
  await db.exec(`
      INSERT INTO instalaciones (id, tipo, estado, fecha, nombre)
      VALUES ('11450000-0000-0000-0000-000000000001', 'nueva', 'prospecto',
              CURRENT_DATE, 'VENTA SIN FICHA');

      INSERT INTO documentos (instalacion_id, categoria, nombre, ruta)
      VALUES ('11450000-0000-0000-0000-000000000001', 'cedula_frontal',
              'cedula.jpg', 'ordenes/cedula.jpg');
  `)

  const d = await fila(
    db,
    `SELECT client_id, instalacion_id FROM documentos WHERE ruta = 'ordenes/cedula.jpg'`,
  )
  assert.equal(d.client_id, null, 'todavia no hay abonado')
  assert.ok(d.instalacion_id, 'pero si hay orden')
})

test('un documento sin dueño no se puede guardar', async () => {
  // Seria un archivo que no aparece en ninguna pantalla y que nadie sabe que
  // esta ocupando lugar.
  await assert.rejects(
    () => db.exec(`
        INSERT INTO documentos (categoria, nombre, ruta)
        VALUES ('otro', 'huerfano.pdf', 'x/huerfano.pdf')`),
    /documentos_tiene_dueno_check|violates check/i,
  )
})

test('al aparecer el abonado, los papeles lo adoptan solos', async () => {
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c1450000-0000-0000-0000-000000000001', 'VENTA SIN FICHA', 'activo');

      UPDATE instalaciones SET client_id = 'c1450000-0000-0000-0000-000000000001'
       WHERE id = '11450000-0000-0000-0000-000000000001';
  `)

  const d = await fila(
    db,
    `SELECT client_id, instalacion_id FROM documentos WHERE ruta = 'ordenes/cedula.jpg'`,
  )
  assert.equal(d.client_id, 'c1450000-0000-0000-0000-000000000001')
  assert.ok(d.instalacion_id, 'y sigue sabiendo de que orden vino')
})

test('los papeles se adoptan al ALTA, no al cierre del trabajo', async () => {
  /**
   * Son dos momentos distintos. Esperar al cierre dejaria la cedula sin dueño
   * durante todo el trabajo, que es justo cuando la oficina la va a buscar.
   *
   * La orden de arriba sigue en 'prospecto' y el documento ya tiene abonado.
   */
  const i = await fila(
    db,
    `SELECT estado FROM instalaciones WHERE id = '11450000-0000-0000-0000-000000000001'`,
  )
  assert.equal(i.estado, 'prospecto', 'el trabajo ni siquiera empezo')
})

test('las fotos del tecnico se ven en la ficha pero no se tocan desde ahi', async () => {
  /**
   * Viven en otro bucket y son el respaldo tecnico del trabajo. Copiarlas a
   * `documentos` duplicaria cada archivo para que despues alguien borre uno y
   * crea que borro los dos.
   */
  await db.exec(`
      INSERT INTO instalacion_fotos (instalacion_id, tipo, ruta, descripcion)
      VALUES ('11450000-0000-0000-0000-000000000001', 'equipo',
              'instalaciones/ont.jpg', 'La ONT en la pared');
  `)

  const filas = await db.query(
    `SELECT categoria, bucket, solo_lectura, nombre FROM v_documentos_abonado
      WHERE client_id = 'c1450000-0000-0000-0000-000000000001' ORDER BY solo_lectura`,
  )

  assert.equal(filas.rows.length, 2, 'la cedula y la foto, juntas')

  const cedula = filas.rows.find((f) => f.categoria === 'cedula_frontal')
  assert.equal(cedula.bucket, 'documentos')
  assert.equal(cedula.solo_lectura, false)

  const foto = filas.rows.find((f) => f.categoria === 'foto_instalacion')
  assert.equal(foto.bucket, 'instalaciones', 'la pantalla tiene que pedir la URL al bucket correcto')
  assert.equal(foto.solo_lectura, true, 'se borra desde la orden, que es su lugar')
  assert.equal(foto.nombre, 'La ONT en la pared')
})

test('las fotos de una orden sin abonado no aparecen en ninguna ficha', async () => {
  await db.exec(`
      INSERT INTO instalaciones (id, tipo, estado, fecha, nombre)
      VALUES ('11450000-0000-0000-0000-000000000002', 'nueva', 'prospecto',
              CURRENT_DATE, 'TODAVIA NADIE');

      INSERT INTO instalacion_fotos (instalacion_id, tipo, ruta)
      VALUES ('11450000-0000-0000-0000-000000000002', 'fachada', 'instalaciones/casa.jpg');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_documentos_abonado WHERE ruta = 'instalaciones/casa.jpg'`,
  )
  assert.equal(n.n, 0)
})

test('las categorias nuevas de la venta se aceptan', async () => {
  // La autorizacion es la que falta cuando quien firma no es el titular: sin
  // ella, el contrato lo firmo alguien que no figura en el.
  for (const cat of ['autorizacion', 'ruc', 'cedula_representante']) {
    await db.exec(`
        INSERT INTO documentos (instalacion_id, categoria, nombre, ruta)
        VALUES ('11450000-0000-0000-0000-000000000002', '${cat}', '${cat}.pdf', 'x/${cat}.pdf');
    `)
  }

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM documentos
      WHERE categoria IN ('autorizacion', 'ruc', 'cedula_representante')`,
  )
  assert.equal(n.n, 3)
})

// ---------------------------------------------------------------------------
// 146 — La vista del abonado solo trae lo del abonado
// ---------------------------------------------------------------------------

test('los papeles de una venta sin alta no estan en la vista del abonado', async () => {
  /**
   * Lo encontro una prueba del circuito completo, no una lectura del codigo. En
   * la pantalla no se notaba —la ficha filtra por el id del abonado y NULL no
   * iguala a nada— pero la vista se llama "documentos del abonado" y devolvia
   * filas sin abonado.
   *
   * El primero que escriba `SELECT * FROM v_documentos_abonado` para contar
   * papeles se lleva de mas las cedulas de ventas que no se instalaron. Es la
   * clase de error que no falla: da un numero equivocado.
   */
  await db.exec(`
      INSERT INTO instalaciones (id, tipo, estado, fecha, nombre)
      VALUES ('11460000-0000-0000-0000-000000000001', 'nueva', 'prospecto',
              CURRENT_DATE, 'VENTA SIN INSTALAR');

      INSERT INTO documentos (instalacion_id, categoria, nombre, ruta)
      VALUES ('11460000-0000-0000-0000-000000000001', 'cedula_frontal',
              'sin-alta.jpg', 'ordenes/sin-alta.jpg');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_documentos_abonado WHERE ruta = 'ordenes/sin-alta.jpg'`,
  )
  assert.equal(n.n, 0, 'no tiene abonado: no va en la vista del abonado')

  // Pero sigue estando donde le corresponde: colgado de su orden.
  const enOrden = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM documentos
      WHERE instalacion_id = '11460000-0000-0000-0000-000000000001'`,
  )
  assert.equal(enOrden.n, 1)
})

test('la vista NUNCA devuelve una fila sin abonado', async () => {
  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_documentos_abonado WHERE client_id IS NULL`,
  )
  assert.equal(n.n, 0)
})

// ---------------------------------------------------------------------------
// 147 — Una sola cedula vigente
// ---------------------------------------------------------------------------

test('la cedula nueva reemplaza a la anterior en vez de convivir', async () => {
  /**
   * Dos cedulas frontales del mismo abonado son peores que ninguna: en una
   * discusion sobre quien firmo el contrato, nadie sabe cual mirar.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c1470000-0000-0000-0000-000000000001', 'DOS CEDULAS', 'activo');

      INSERT INTO documentos (client_id, categoria, nombre, ruta)
      VALUES ('c1470000-0000-0000-0000-000000000001', 'cedula_frontal',
              'borrosa.jpg', 'x/borrosa.jpg');

      INSERT INTO documentos (client_id, categoria, nombre, ruta)
      VALUES ('c1470000-0000-0000-0000-000000000001', 'cedula_frontal',
              'buena.jpg', 'x/buena.jpg');
  `)

  const vigentes = await db.query(
    `SELECT nombre FROM documentos
      WHERE client_id = 'c1470000-0000-0000-0000-000000000001'
        AND categoria = 'cedula_frontal' AND reemplazado_en IS NULL`,
  )
  assert.equal(vigentes.rows.length, 1, 'una sola vigente')
  assert.equal(vigentes.rows[0].nombre, 'buena.jpg', 'la ultima que se subio')
})

test('la reemplazada no se borra: el reemplazo puede haber sido un error', async () => {
  // Alguien sube una foto movida encima de una buena y lo nota al mes.
  const vieja = await fila(
    db,
    `SELECT reemplazado_en, reemplazado_por FROM documentos WHERE ruta = 'x/borrosa.jpg'`,
  )
  assert.ok(vieja.reemplazado_en, 'quedo marcada con fecha')
  assert.ok(vieja.reemplazado_por, 'y sabe cual la reemplazo')
})

test('la ficha muestra solo la vigente', async () => {
  const filas = await db.query(
    `SELECT nombre FROM v_documentos_abonado
      WHERE client_id = 'c1470000-0000-0000-0000-000000000001'`,
  )
  assert.equal(filas.rows.length, 1)
  assert.equal(filas.rows[0].nombre, 'buena.jpg')
})

test('el contrato SI puede tener varias copias', async () => {
  /**
   * Conviven el generado por el sistema y el escaneo del firmado, y uno por
   * cada renovacion. Aplicarle la regla de la cedula borraria el historial de
   * lo que el abonado firmo.
   */
  await db.exec(`
      INSERT INTO documentos (client_id, categoria, nombre, ruta)
      VALUES ('c1470000-0000-0000-0000-000000000001', 'contrato',
              'generado.pdf', 'x/generado.pdf'),
             ('c1470000-0000-0000-0000-000000000001', 'contrato',
              'firmado.pdf', 'x/firmado.pdf');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM documentos
      WHERE client_id = 'c1470000-0000-0000-0000-000000000001'
        AND categoria = 'contrato' AND reemplazado_en IS NULL`,
  )
  assert.equal(n.n, 2, 'los dos conviven')
})

test('el ALTA no se cae porque la cedula ya estuviera cargada', async () => {
  /**
   * Es el caso que un indice unico a secas habria roto, y es el peor de todos:
   * un abonado puede tener dos ordenes —el alta y un traslado— con la cedula
   * subida en las dos. Al adoptar los papeles de la segunda, el indice habria
   * hecho fallar el alta entera.
   *
   * Un abonado sin dar de alta por una foto repetida es mucho peor que dos
   * fotos.
   */
  await db.exec(`
      INSERT INTO instalaciones (id, tipo, estado, fecha, nombre)
      VALUES ('11470000-0000-0000-0000-000000000001', 'traslado', 'agendada',
              CURRENT_DATE, 'DOS CEDULAS');

      INSERT INTO documentos (instalacion_id, categoria, nombre, ruta)
      VALUES ('11470000-0000-0000-0000-000000000001', 'cedula_frontal',
              'del-traslado.jpg', 'x/del-traslado.jpg');
  `)

  // El alta: la orden consigue su abonado y los papeles lo adoptan.
  await db.exec(`
      UPDATE instalaciones SET client_id = 'c1470000-0000-0000-0000-000000000001'
       WHERE id = '11470000-0000-0000-0000-000000000001';
  `)

  const vigentes = await db.query(
    `SELECT nombre FROM documentos
      WHERE client_id = 'c1470000-0000-0000-0000-000000000001'
        AND categoria = 'cedula_frontal' AND reemplazado_en IS NULL`,
  )
  assert.equal(vigentes.rows.length, 1, 'sigue habiendo una sola vigente')
})

test('escribir por fuera de la aplicacion tampoco puede dejar dos', async () => {
  /**
   * El disparador cubre el camino normal; el indice esta para el script que
   * alguien corra a mano, que es exactamente cuando hace falta.
   *
   * Se comprueba que los dos indices existan y con el predicado correcto: uno
   * por abonado y otro por orden, ambos solo sobre las copias VIGENTES —si
   * cubrieran tambien las reemplazadas, guardar el historial seria imposible—.
   */
  const indices = await db.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'documentos' AND indexname LIKE 'idx_documento_identidad%'`,
  )
  assert.equal(indices.rows.length, 2, 'uno por abonado y otro por orden')

  for (const i of indices.rows) {
    assert.match(i.indexdef, /UNIQUE/, `${i.indexname} tiene que ser unico`)
    assert.match(i.indexdef, /reemplazado_en IS NULL/, `${i.indexname} solo cubre las vigentes`)
    assert.match(i.indexdef, /cedula_frontal/, `${i.indexname} cubre las de identidad`)
  }
})

// ---------------------------------------------------------------------------
// 148 — La firma del contrato
// ---------------------------------------------------------------------------

test('la API viene APAGADA mientras no haya proveedor', async () => {
  /**
   * Encenderla sin proveedor contratado haria que cada intento llame a un
   * servicio que no existe y espere el timeout completo antes de ofrecer el
   * papel — con el cliente delante.
   */
  const c = await fila(db, `SELECT api_habilitada, timeout_segundos, vigencia_horas FROM config_firma`)
  assert.equal(c.api_habilitada, false)
  assert.equal(c.timeout_segundos, 30, 'la espera de la llamada')
  assert.equal(c.vigencia_horas, 72, 'lo que vale el enlace ya enviado')
})

test('un tramite de firma puede colgar de la ORDEN, sin abonado ni contrato', async () => {
  /**
   * Es el punto de que sea una tabla nueva: en este sistema el contrato se firma
   * ANTES del alta. Atarlo a `contratos` obligaria a crear el contrato —y el
   * cliente— antes de saber si el abonado va a firmar.
   */
  await db.exec(`
      INSERT INTO instalaciones (id, tipo, estado, fecha, nombre)
      VALUES ('11480000-0000-0000-0000-000000000001', 'nueva', 'prospecto',
              CURRENT_DATE, 'PARA FIRMAR');

      INSERT INTO firmas_contrato (id, instalacion_id, metodo, estado)
      VALUES ('f1480000-0000-0000-0000-000000000001',
              '11480000-0000-0000-0000-000000000001', 'electronica_api', 'pendiente');
  `)

  const f = await fila(
    db,
    `SELECT estado, contrato_id, client_id FROM firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000001'`,
  )
  assert.equal(f.estado, 'pendiente')
  assert.equal(f.contrato_id, null)
  assert.equal(f.client_id, null)
})

test('firmado sin respaldo no se puede guardar', async () => {
  /**
   * Es lo que hace que la palabra signifique algo. Sin esto, un contrato podria
   * quedar en firmado sin enlace del proveedor ni escaneo del papel: firmado
   * porque alguien apreto un boton.
   */
  await assert.rejects(
    () => db.exec(`
        INSERT INTO firmas_contrato (instalacion_id, metodo, estado, fecha_firma)
        VALUES ('11480000-0000-0000-0000-000000000001', 'manual', 'firmado', NOW())`),
    /firmas_firmado_completo|violates check/i,
    'falta el escaneo y quien lo valido',
  )

  await assert.rejects(
    () => db.exec(`
        INSERT INTO firmas_contrato (instalacion_id, metodo, estado, fecha_firma)
        VALUES ('11480000-0000-0000-0000-000000000001', 'electronica_api', 'firmado', NOW())`),
    /firmas_firmado_completo|violates check/i,
    'falta la referencia del proveedor',
  )
})

test('la firma electronica cierra sola con la referencia del proveedor', async () => {
  // Es el camino feliz: el proveedor confirma y nadie toca nada.
  await db.exec(`
      UPDATE firmas_contrato
         SET estado = 'firmado',
             fecha_firma = NOW(),
             referencia_proveedor = 'TRX-99887766',
             proveedor = 'proveedor-demo'
       WHERE id = 'f1480000-0000-0000-0000-000000000001';
  `)

  const f = await fila(
    db,
    `SELECT estado, referencia_proveedor FROM v_firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000001'`,
  )
  assert.equal(f.estado, 'firmado')
  assert.equal(f.referencia_proveedor, 'TRX-99887766', 'queda para auditoria o reclamo')
})

test('la firma manual exige quien la autorizo y quien la valido', async () => {
  await db.exec(`
      INSERT INTO firmas_contrato (id, instalacion_id, metodo, estado)
      VALUES ('f1480000-0000-0000-0000-000000000002',
              '11480000-0000-0000-0000-000000000001', 'manual', 'pendiente');
  `)

  // Sin nada, no cierra.
  await assert.rejects(
    () => db.exec(`
        UPDATE firmas_contrato
           SET estado = 'firmado', fecha_firma = NOW()
         WHERE id = 'f1480000-0000-0000-0000-000000000002'`),
    /violates check/i,
  )

  /**
   * Y tampoco con el escaneo pero sin quien lo autorizo.
   *
   * Lo encontro esta misma prueba: yo habia escrito el caso "con todo" sin
   * `autorizado_por`, y la base lo rechazo. Tenia razon la base — habilitar el
   * papel saltea la biometria y sin ese dato el contrato firmado a mano no tiene
   * explicacion.
   */
  await assert.rejects(
    () => db.exec(`
        UPDATE firmas_contrato
           SET estado = 'firmado', fecha_firma = NOW(),
               documento_firmado_url = 'documentos/contrato-firmado.pdf',
               validado_por = (SELECT id FROM usuarios_sistema LIMIT 1),
               validado_en = NOW()
         WHERE id = 'f1480000-0000-0000-0000-000000000002'`),
    /firmas_manual_autorizada|violates check/i,
  )

  // Con los dos —quien lo autorizo y quien lo valido—, si.
  await db.exec(`
      UPDATE firmas_contrato
         SET estado = 'firmado',
             fecha_firma = NOW(),
             autorizado_por = (SELECT id FROM usuarios_sistema LIMIT 1),
             autorizado_en = NOW(),
             motivo_manual = 'El proveedor no respondio',
             documento_firmado_url = 'documentos/contrato-firmado.pdf',
             validado_por = (SELECT id FROM usuarios_sistema LIMIT 1),
             validado_en = NOW()
       WHERE id = 'f1480000-0000-0000-0000-000000000002';
  `)

  const f = await fila(
    db,
    `SELECT estado, documento_firmado_url FROM firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000002'`,
  )
  assert.equal(f.estado, 'firmado')
  assert.ok(f.documento_firmado_url)
})

test('con la API apagada, el papel se ofrece siempre', async () => {
  // Es el caso de hoy: no hay proveedor contratado.
  const f = await fila(
    db,
    `SELECT puede_pasar_a_manual, api_habilitada FROM v_firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000001'`,
  )
  assert.equal(f.api_habilitada, false)
  // Ese ya esta firmado, asi que no se le ofrece nada.
  assert.equal(f.puede_pasar_a_manual, false, 'sobre uno firmado no se ofrece nada')

  await db.exec(`
      INSERT INTO firmas_contrato (id, instalacion_id, metodo, estado)
      VALUES ('f1480000-0000-0000-0000-000000000003',
              '11480000-0000-0000-0000-000000000001', 'electronica_api', 'pendiente');
  `)
  const nuevo = await fila(
    db,
    `SELECT puede_pasar_a_manual FROM v_firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000003'`,
  )
  assert.equal(nuevo.puede_pasar_a_manual, true)
})

test('con la API encendida, el papel solo si el camino electronico fallo', async () => {
  /**
   * El interruptor encendido no puede dejar a nadie esperando, pero tampoco
   * puede convertirse en un atajo: si el enlace se mando y el abonado todavia no
   * firmo, hay que esperarlo.
   */
  await db.exec(`UPDATE config_firma SET api_habilitada = TRUE WHERE id = 1`)

  const esperando = await fila(
    db,
    `SELECT puede_pasar_a_manual FROM v_firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000003'`,
  )
  assert.equal(esperando.puede_pasar_a_manual, false, 'todavia se lo espera')

  // Pero si la llamada fallo, el papel se ofrece sin apagar nada para los demas.
  await db.exec(`
      UPDATE firmas_contrato SET estado = 'fallido', error_api = 'timeout'
       WHERE id = 'f1480000-0000-0000-0000-000000000003';
  `)
  const fallido = await fila(
    db,
    `SELECT puede_pasar_a_manual FROM v_firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000003'`,
  )
  assert.equal(fallido.puede_pasar_a_manual, true, 'ese contrato puntual pasa a papel')

  await db.exec(`UPDATE config_firma SET api_habilitada = FALSE WHERE id = 1`)
})

test('el sistema no espera indefinidamente: lo vencido se marca', async () => {
  /**
   * Mientras un enlace de hace un mes figure como esperando al abonado, nadie le
   * ofrece el papel y el contrato no se firma nunca.
   */
  await db.exec(`
      INSERT INTO firmas_contrato (id, instalacion_id, metodo, estado, enviado_en, vence_en)
      VALUES ('f1480000-0000-0000-0000-000000000004',
              '11480000-0000-0000-0000-000000000001', 'electronica_api', 'enviado',
              NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days');
  `)

  // La pantalla ya lo muestra vencido aunque la tarea no haya corrido.
  const antes = await fila(
    db,
    `SELECT esperando_de_mas FROM v_firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000004'`,
  )
  assert.equal(antes.esperando_de_mas, true)

  const n = await fila(db, `SELECT vencer_firmas_pendientes() AS n`)
  assert.ok(n.n >= 1, 'la tarea lo vencio')

  const despues = await fila(
    db,
    `SELECT estado, puede_pasar_a_manual FROM v_firmas_contrato
      WHERE id = 'f1480000-0000-0000-0000-000000000004'`,
  )
  assert.equal(despues.estado, 'vencido')
  assert.equal(despues.puede_pasar_a_manual, true, 'y ahi se le ofrece el papel')
})

test('vencer no toca lo ya firmado', async () => {
  // Seria dar por no firmado un contrato que el abonado firmo.
  const f = await fila(
    db,
    `SELECT estado FROM firmas_contrato WHERE id = 'f1480000-0000-0000-0000-000000000001'`,
  )
  assert.equal(f.estado, 'firmado')
})

// ---------------------------------------------------------------------------
// 150 — Cada ISP con su modelo de contrato
// ---------------------------------------------------------------------------

test('el modelo base trae las catorce clausulas', async () => {
  /**
   * La PRIMERA no esta y no es un olvido: es la de los comparecientes, que no
   * tiene redaccion —son las dos cajas de datos— y la dibuja el generador.
   */
  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM clausulas_contrato WHERE prestador_id IS NULL`,
  )
  assert.equal(n.n, 14)

  const primera = await fila(
    db,
    `SELECT numeral, orden FROM clausulas_contrato WHERE prestador_id IS NULL ORDER BY orden LIMIT 1`,
  )
  assert.equal(primera.orden, 2, 'empieza en la segunda')
})

test('un prestador sin clausulas propias usa las del modelo base', async () => {
  const p = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)
  const filas = await db.query(
    `SELECT es_propia FROM v_clausulas_prestador WHERE prestador_id = '${p.id}'`,
  )

  assert.equal(filas.rows.length, 14)
  assert.ok(filas.rows.every((f) => f.es_propia === false), 'todas del modelo base')
})

test('copiar el modelo le da su propio juego', async () => {
  const p = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)
  const r = await fila(db, `SELECT copiar_modelo_a_prestador('${p.id}') AS n`)
  assert.equal(r.n, 14)

  const filas = await db.query(
    `SELECT es_propia FROM v_clausulas_prestador WHERE prestador_id = '${p.id}'`,
  )
  assert.equal(filas.rows.length, 14, 'sigue habiendo catorce, no veintiocho')
  assert.ok(filas.rows.every((f) => f.es_propia === true), 'ahora todas son suyas')
})

test('copiar dos veces no duplica', async () => {
  const p = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)
  const r = await fila(db, `SELECT copiar_modelo_a_prestador('${p.id}') AS n`)
  assert.equal(r.n, 0, 'ya tenia las suyas: no se copia de nuevo')
})

test('editar las de un prestador NO le cambia el contrato al otro', async () => {
  /**
   * Es el motivo de toda la migracion. Con las clausulas en el codigo, el
   * segundo ISP que instalara el sistema firmaria contratos con el texto del
   * primero.
   *
   * Y con una sola tabla compartida pasaria lo mismo dentro de la misma
   * instalacion: aca hay dos prestadores.
   */
  const uno = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)

  await db.exec(`
      INSERT INTO prestadores (razon_social, ruc, predeterminado)
      VALUES ('EL SEGUNDO ISP', '1799000000001', FALSE);
  `)
  const dos = await fila(db, `SELECT id FROM prestadores WHERE ruc = '1799000000001'`)

  await db.exec(`
      UPDATE clausulas_contrato
         SET texto = 'MI PROPIA REDACCION DE LA SEGUNDA'
       WHERE prestador_id = '${uno.id}' AND orden = 2;
  `)

  const delUno = await fila(
    db,
    `SELECT texto FROM v_clausulas_prestador WHERE prestador_id = '${uno.id}' AND orden = 2`,
  )
  const delDos = await fila(
    db,
    `SELECT texto, es_propia FROM v_clausulas_prestador WHERE prestador_id = '${dos.id}' AND orden = 2`,
  )

  assert.equal(delUno.texto, 'MI PROPIA REDACCION DE LA SEGUNDA')
  assert.equal(delDos.es_propia, false, 'el segundo sigue con el modelo base')
  assert.notEqual(delDos.texto, delUno.texto, 'y su texto NO cambio')
  assert.match(delDos.texto, /titulos habilitantes|títulos habilitantes/)
})

test('el modelo base queda intacto para el siguiente ISP', async () => {
  const base = await fila(
    db,
    `SELECT texto FROM clausulas_contrato WHERE prestador_id IS NULL AND orden = 2`,
  )
  assert.notEqual(base.texto, 'MI PROPIA REDACCION DE LA SEGUNDA')
})

test('dos clausulas no pueden ocupar el mismo lugar', async () => {
  /**
   * Con dos en la misma posicion, el orden de impresion lo decide el
   * planificador de consultas y cambia entre una impresion y la siguiente: el
   * mismo contrato saldria con las clausulas en distinto orden.
   */
  const p = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)
  await assert.rejects(
    () => db.exec(`
        INSERT INTO clausulas_contrato (prestador_id, orden, numeral, titulo)
        VALUES ('${p.id}', 2, 'CLAUSULA REPETIDA', 'Choca')`),
    /duplicate key|unique/i,
  )
})

test('un bloque inventado no se acepta', async () => {
  // Los bloques son el formulario que exige el regulador, no texto libre: uno
  // que el generador no conoce saldria como un hueco en el contrato.
  const p = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)
  await assert.rejects(
    () => db.exec(`
        INSERT INTO clausulas_contrato (prestador_id, orden, numeral, titulo, bloque)
        VALUES ('${p.id}', 99, 'CLAUSULA RARA', 'Con bloque inventado', 'lo_que_sea')`),
    /violates check/i,
  )
})

test('desactivar una clausula la saca del contrato', async () => {
  const p = await fila(db, `SELECT id FROM prestadores WHERE predeterminado`)
  await db.exec(`
      UPDATE clausulas_contrato SET activa = FALSE
       WHERE prestador_id = '${p.id}' AND orden = 15;
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clausulas_prestador WHERE prestador_id = '${p.id}'`,
  )
  assert.equal(n.n, 13, 'queda una menos')

  await db.exec(`
      UPDATE clausulas_contrato SET activa = TRUE
       WHERE prestador_id = '${p.id}' AND orden = 15;
  `)
})

// ---------------------------------------------------------------------------
// 153 — El atraso se mide por la factura vieja, no por el ultimo pago
// ---------------------------------------------------------------------------

/**
 * Un abono chico no puede comprar un mes de servicio.
 *
 * Medido contra la base de verdad antes de la 153: un abonado que debia tres
 * meses y $60 dejaba de aparecer en la lista de corte apenas abonaba UN dolar,
 * y volvia a aparecer solo cuando ese dolar cumplia un mes de viejo.
 *
 * El error no era del corte sino de la medida: `meses_sin_pago` cuenta desde el
 * ultimo pago —que es la pregunta correcta para comisiones y cartera— y el corte
 * necesita otra: hace cuanto vencio lo mas viejo que sigue sin pagarse.
 */
test('un abono parcial no salva del corte', async () => {
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, cortar_tras_meses,
                            activado_en, fecha_instalacion)
      VALUES ('c1530000-0000-0000-0000-000000000001', 'ABONO CHICO', 'activo',
              '192.0.2.10', 1, CURRENT_DATE - 100, CURRENT_DATE - 100);

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES
        ('c1530000-0000-0000-0000-000000000001','ABONO CHICO','otro','Servicio',
         CURRENT_DATE - 90, CURRENT_DATE - 85, 20, 0, 20),
        ('c1530000-0000-0000-0000-000000000001','ABONO CHICO','otro','Servicio',
         CURRENT_DATE - 60, CURRENT_DATE - 55, 20, 0, 20),
        ('c1530000-0000-0000-0000-000000000001','ABONO CHICO','otro','Servicio',
         CURRENT_DATE - 30, CURRENT_DATE - 25, 20, 0, 20);
  `)

  const debiendo = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1530000-0000-0000-0000-000000000001'`,
  )
  assert.equal(debiendo.n, 1, 'debiendo tres meses, le toca el corte')

  // Un dolar, hoy. Con el criterio viejo esto lo salvaba un mes entero.
  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, fecha_pago)
      VALUES ('c1530000-0000-0000-0000-000000000001', 1, 'efectivo', CURRENT_DATE);
  `)

  const conAbono = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1530000-0000-0000-0000-000000000001'`,
  )
  assert.equal(conAbono.n, 1, 'un dolar no puede comprar un mes de servicio')

  // Y las dos medidas tienen que diferir: es lo que hace visible el caso.
  const medidas = await fila(
    db,
    `SELECT meses_de_atraso, meses_sin_pago, saldo::NUMERIC AS saldo
       FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1530000-0000-0000-0000-000000000001'`,
  )
  assert.equal(Number(medidas.meses_sin_pago), 0, 'pago hoy, asi que no hay meses sin pagar')
  assert.ok(Number(medidas.meses_de_atraso) >= 2, 'pero la factura vieja sigue con dos meses')
  assert.ok(Number(medidas.saldo) > 50, 'y sigue debiendo casi todo')
})

test('cubrir la factura vieja si mueve el atraso', async () => {
  /**
   * La otra mitad de la regla: si no la moviera nada, el abonado quedaria
   * cortado para siempre. Lo que la mueve es cubrir lo mas viejo — que es
   * justamente el orden en que el sistema imputa los pagos.
   */
  await db.exec(`
      DELETE FROM pagos WHERE client_id = 'c1530000-0000-0000-0000-000000000001';
      DELETE FROM facturas
       WHERE client_id = 'c1530000-0000-0000-0000-000000000001'
         AND fecha_vencimiento < CURRENT_DATE - 30;
  `)

  /**
   * Se le pregunta a la funcion y no a la vista: con el atraso en cero el
   * abonado ya no aparece en la lista de corte, que es justamente lo que se
   * quiere comprobar.
   */
  const r = await fila(
    db,
    `SELECT meses_de_atraso('c1530000-0000-0000-0000-000000000001') AS meses,
            dias_de_atraso('c1530000-0000-0000-0000-000000000001')  AS dias`,
  )
  assert.equal(Number(r.meses), 0, 'lo que queda vencio hace menos de un mes')
  assert.ok(Number(r.dias) >= 20, 'pero los dias se siguen contando')

  /**
   * Y le sigue tocando el corte, porque lo que queda TAMBIEN esta vencido.
   *
   * Con la 154 el momento lo decide la fecha de corte, no los meses: cubrir la
   * factura vieja mueve el atraso pero no perdona la que sigue. Para salir de la
   * lista hay que quedar al dia, o conseguir una promesa.
   */
  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1530000-0000-0000-0000-000000000001'`,
  )
  assert.equal(n.n, 1, 'la que queda tambien esta vencida')

  /**
   * Al día se sale de la lista.
   *
   * El pago va CONTRA LA FACTURA. Uno sin `factura_id` no se imputa a nada: la
   * factura queda con su saldo intero y el abonado sigue debiendo, aunque la plata
   * esté registrada. Es lo que hace la pantalla de cobro —siempre elige la
   * factura— y por eso acá se hace igual.
   */
  const queda = await fila(
    db,
    `SELECT id FROM facturas WHERE client_id = 'c1530000-0000-0000-0000-000000000001'`,
  )
  await db.exec(`
      INSERT INTO pagos (client_id, factura_id, monto, forma_pago, fecha_pago)
      VALUES ('c1530000-0000-0000-0000-000000000001', '${queda.id}', 20, 'efectivo', CURRENT_DATE);
  `)
  const alDia = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1530000-0000-0000-0000-000000000001'`,
  )
  assert.equal(alDia.n, 0, 'pago lo que debia: sale de la lista')
})

test('la factura que todavia no vencio no es atraso', async () => {
  /**
   * Cero no significa "no debe": significa "lo que debe no vencio". Sin esto, el
   * abonado facturado ayer entraria a la cola de corte el mismo dia.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, cortar_tras_meses)
      VALUES ('c1530000-0000-0000-0000-000000000002', 'RECIEN FACTURADO', 'activo',
              '192.0.2.11', 1);

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1530000-0000-0000-0000-000000000002','RECIEN FACTURADO','otro','Servicio',
              CURRENT_DATE, CURRENT_DATE + 10, 20, 0, 20);
  `)

  const r = await fila(
    db,
    `SELECT meses_de_atraso('c1530000-0000-0000-0000-000000000002') AS meses,
            dias_de_atraso('c1530000-0000-0000-0000-000000000002')  AS dias`,
  )
  assert.equal(Number(r.meses), 0)
  assert.equal(Number(r.dias), 0, 'los dias no pueden ser negativos')

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1530000-0000-0000-0000-000000000002'`,
  )
  assert.equal(n.n, 0, 'no se corta a nadie por una factura que no vencio')
})

test('la reconexion usa la misma medida que el corte', async () => {
  /**
   * Si el corte mira una medida y la reconexion otra, un abonado puede cumplir
   * las dos condiciones a la vez: se cortaria y se reconectaria en cada corrida,
   * pegandole al router cada quince minutos para siempre.
   */
  const def = await fila(
    db,
    `SELECT pg_get_viewdef('v_clientes_a_reconectar'::regclass, true) AS sql`,
  )
  assert.ok(def.sql.includes('meses_de_atraso'), 'la reconexion tiene que mirar el atraso')

  const corte = await fila(
    db,
    `SELECT pg_get_viewdef('v_clientes_a_cortar_por_mora'::regclass, true) AS sql`,
  )
  assert.ok(corte.sql.includes('meses_de_atraso'), 'y el corte tambien')
})

test('la vista que atiende la cola de reconexion sigue en pie', async () => {
  /**
   * La 153 tuvo que tirar `v_clientes_a_reconectar` para agregarle columnas, y
   * `v_reconexiones_a_procesar` cuelga de ella. Olvidarse de recrearla dejaria
   * la cola de reconexion sin atender y nadie se enteraria hasta que un abonado
   * que pago siguiera sin internet.
   */
  const r = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_reconexiones_a_procesar`,
  )
  assert.ok(Number.isInteger(r.n), 'existe y contesta')

  // Y con sus columnas: si volviera sin `routeros_id` o sin `lista`, la tarea no
  // sabria que borrar del router.
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'v_reconexiones_a_procesar'`,
  )
  const nombres = cols.rows.map((x) => x.column_name)
  for (const c of ['pedido_id', 'cliente_id', 'ip', 'router_id', 'bloqueo_id', 'routeros_id', 'lista']) {
    assert.ok(nombres.includes(c), `le falta la columna ${c}`)
  }
})

// ---------------------------------------------------------------------------
// 154 — Se corta en la fecha de corte de cada abonado
// ---------------------------------------------------------------------------

/**
 * La regla del negocio: se factura el mes vencido y se corta en la fecha de corte
 * de cada uno. No hay espera de un mes.
 *
 * Antes el corte decidia con `cortar_tras_meses`, un umbral EN MESES, y con el
 * valor 1 —el que tienen todos— eso significaba esperar treinta dias despues del
 * vencimiento. El que no pagaba el 5 se cortaba el 5 del mes siguiente.
 */
test('se corta al dia siguiente del vencimiento, no al mes', async () => {
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip, cortar_tras_meses, dias_gracia,
                            dia_facturacion)
      VALUES ('c1540000-0000-0000-0000-000000000001', 'SIN GRACIA', 'activo',
              '192.0.2.20', 1, 0, 5);

      INSERT INTO facturas (client_id, cliente_nombre, tipo, concepto,
                            fecha_emision, fecha_vencimiento, subtotal, impuesto, total)
      VALUES ('c1540000-0000-0000-0000-000000000001','SIN GRACIA','otro','Servicio',
              CURRENT_DATE - 6, CURRENT_DATE - 1, 20, 0, 20);
  `)

  const r = await fila(
    db,
    `SELECT dias_de_atraso, dias_gracia, fecha_corte
       FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.ok(r, 'vencio ayer y no tiene gracia: hoy le toca')
  assert.equal(Number(r.dias_de_atraso), 1)
  assert.equal(Number(r.dias_gracia), 0)

  // Y la vista dice QUE DIA era, para poder explicarlo sin buscar la factura.
  //
  // Se pide como TEXT desde la base: una columna DATE vuelve como Date de
  // JavaScript, que al imprimirse se corre un dia en Ecuador —medianoche UTC es
  // la tarde del dia anterior en UTC-5— y la prueba fallaria por la zona horaria
  // en vez de por la regla.
  const dia = await fila(
    db,
    `SELECT fecha_corte::TEXT AS corte, (CURRENT_DATE - 1)::TEXT AS esperado
       FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.equal(dia.corte, dia.esperado, 'se cortaba el dia del vencimiento')
})

test('los dias de gracia corren la fecha de corte', async () => {
  /**
   * Es el campo que la ficha siempre mostro —"dias despues del vencimiento antes
   * de cortar"— y el que el corte ignoraba.
   */
  await db.exec(`
      UPDATE clientes SET dias_gracia = 5
       WHERE id = 'c1540000-0000-0000-0000-000000000001';
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.equal(n.n, 0, 'vencio ayer y tiene cinco dias de gracia: todavia no')

  // Al sexto dia si.
  await db.exec(`
      UPDATE facturas SET fecha_vencimiento = CURRENT_DATE - 6
       WHERE client_id = 'c1540000-0000-0000-0000-000000000001';
  `)
  const despues = await fila(
    db,
    `SELECT dias_de_atraso FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.ok(despues, 'paso su fecha de corte')
  assert.equal(Number(despues.dias_de_atraso), 6)
})

test('la fecha de corte es la misma que marca la factura como vencida', async () => {
  /**
   * Es lo que hace que la regla se pueda explicar en una linea: se corta al que
   * tiene una factura vencida. Si el corte usara una cuenta propia, la oficina
   * veria "vencida" en una pantalla y el abonado seguiria con internet —o al
   * revés, lo que es peor.
   */
  const r = await fila(
    db,
    `SELECT f.estado, fecha_de_corte(f.client_id)::TEXT AS corte
       FROM v_facturas f
      WHERE f.client_id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.equal(r.estado, 'vencida', 'la factura ya figura vencida')

  const enLista = await fila(
    db,
    `SELECT fecha_corte::TEXT AS corte FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.equal(enLista.corte, r.corte, 'las dos cuentas dan el mismo dia')
})

test('el que no se corta nunca sigue sin cortarse', async () => {
  // Servicio gratis, enlace institucional, camara. Es el unico papel que le
  // queda a `cortar_tras_meses`: cero es nunca.
  await db.exec(`
      UPDATE clientes SET cortar_tras_meses = 0
       WHERE id = 'c1540000-0000-0000-0000-000000000001';
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM v_clientes_a_cortar_por_mora
      WHERE cliente_id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.equal(n.n, 0)

  // Y el disparador de la 131 dejo `aplicar_corte` diciendo lo mismo.
  const c = await fila(
    db,
    `SELECT aplicar_corte FROM clientes
      WHERE id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.equal(c.aplicar_corte, false, 'los dos campos tienen que decir lo mismo')

  await db.exec(`
      UPDATE clientes SET cortar_tras_meses = 1
       WHERE id = 'c1540000-0000-0000-0000-000000000001';
  `)
})

test('la reconexion tambien mira la fecha de corte', async () => {
  /**
   * Tiene que ser la MISMA medida que el corte. Con una distinta, un abonado
   * podria cumplir las dos condiciones y quedar cortandose y reconectandose en
   * cada corrida, pegandole al router cada quince minutos para siempre.
   */
  const def = await fila(
    db,
    `SELECT pg_get_viewdef('v_clientes_a_reconectar'::regclass, true) AS sql`,
  )
  assert.ok(def.sql.includes('dias_de_atraso'), 'la reconexion mira los dias')
  assert.ok(def.sql.includes('dias_gracia'), 'y la gracia de cada uno')

  const corte = await fila(
    db,
    `SELECT pg_get_viewdef('v_clientes_a_cortar_por_mora'::regclass, true) AS sql`,
  )
  assert.ok(corte.sql.includes('dias_de_atraso'), 'y el corte tambien')
  assert.ok(
    !corte.sql.includes('>= c.cortar_tras_meses'),
    'los meses ya no deciden el momento del corte',
  )
})

test('los dias de gracia llegan hasta un ano', async () => {
  /**
   * Ahi vive ahora el plazo del que paga cada varios meses, que antes se
   * expresaba con el umbral en meses. Con el techo en 60 ese caso no entraba, y
   * quedarian dos conceptos para lo mismo otra vez.
   */
  await db.exec(`
      UPDATE clientes SET dias_gracia = 180
       WHERE id = 'c1540000-0000-0000-0000-000000000001';
  `)
  const c = await fila(
    db,
    `SELECT dias_gracia FROM clientes
      WHERE id = 'c1540000-0000-0000-0000-000000000001'`,
  )
  assert.equal(Number(c.dias_gracia), 180)

  // Pero no cualquier numero: el error de tipeo de tres ceros se sigue atajando.
  await assert.rejects(
    () => db.exec(`
        UPDATE clientes SET dias_gracia = 3000
         WHERE id = 'c1540000-0000-0000-0000-000000000001'`),
    /violates check/i,
  )

  await db.exec(`
      UPDATE clientes SET dias_gracia = 0
       WHERE id = 'c1540000-0000-0000-0000-000000000001';
  `)
})

// ---------------------------------------------------------------------------
// 155 — La auditoria no puede bloquear el cobro
// ---------------------------------------------------------------------------

test('quien escribe en una tabla de solo lectura corre como DEFINER', async () => {
  /**
   * ── El error que esto fija ──
   *
   * Cobrando desde la pantalla:
   *
   *   new row violates row-level security policy for table "audit_logs"
   *
   * Y el cobro entero se deshace: no se guarda el pago, ni la imputacion, ni el
   * recibo.
   *
   * `audit_logs` tiene RLS con una sola politica, de lectura — a proposito: una
   * bitacora que se puede escribir a mano no sirve como bitacora. Pero
   * `audit_cambios()` se habia declarado `LANGUAGE plpgsql` y nada mas, asi que
   * corria con los permisos de quien disparaba el cambio. Desde la pantalla eso
   * es `authenticated`, que no tiene INSERT.
   *
   * Cinco tablas disparan esa funcion —pagos, facturas, promesas_pago, clientes y
   * comunicaciones—, o sea que estaba bloqueado cobrar, anular una factura, dar
   * una promesa y editar una ficha.
   *
   * ── Por qué la prueba es general y no solo sobre audit_logs ──
   *
   * Porque la que ya existia —"ninguna funcion perdio su SECURITY DEFINER"—
   * compara contra lo que el SQL declara, y esta funcion nunca lo declaro: no
   * habia nada de donde caerse. La regla que falta es al revés: si escribe en una
   * tabla que `authenticated` no puede escribir, tiene que ser DEFINER.
   *
   * Esto NO se puede probar cobrando de verdad acá: PGlite corre como dueño y el
   * dueño se saltea RLS, asi que el INSERT pasaria igual. Lo que se comprueba es
   * la condicion que hace fallar en Supabase.
   */
  const cerradas = await db.query(`
      SELECT c.relname AS tabla
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r'
         AND c.relrowsecurity
         AND NOT EXISTS (
             SELECT 1 FROM pg_policies p
              WHERE p.schemaname = 'public'
                AND p.tablename = c.relname
                AND p.cmd IN ('INSERT', 'ALL')
         )`)

  const tablas = cerradas.rows.map((x) => x.tabla)
  assert.ok(
    tablas.includes('audit_logs'),
    'audit_logs tiene que seguir siendo de solo lectura: es lo que la hace servir de bitacora',
  )

  // Las funciones que le escriben a alguna de esas tablas.
  const escriben = await db.query(
    `SELECT p.proname, p.prosecdef, p.prosrc
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.prokind = 'f'`,
  )

  const culpables = []
  for (const f of escriben.rows) {
    for (const t of tablas) {
      // Basta con que la nombre en un INSERT: es texto, no un plan, pero alcanza
      // para el patron que causo el error.
      /**
       * Los escapes van DOBLES.
       *
       * Dentro de una plantilla de JavaScript, `\s` es una `s` y `\b` es un
       * carácter de retroceso: el patrón quedaba `INSERTs+INTOs+audit_logs⌫` y no
       * coincidía con nada. La prueba pasaba siempre, incluso con el error
       * presente — que es peor que no tenerla.
       *
       * Verificado corriendo la cadena hasta la 154, sin la corrección:
       * la prueba encuentra `audit_cambios → audit_logs`.
       */
      if (new RegExp(`INSERT\\s+INTO\\s+${t}\\b`, 'i').test(f.prosrc ?? '') && !f.prosecdef) {
        culpables.push(`${f.proname} escribe en ${t} y NO es SECURITY DEFINER`)
      }
    }
  }

  for (const c of culpables) console.error(`  ${c}`)
  assert.deepEqual(culpables, [], 'alguna funcion va a fallar con RLS al escribir')
})

test('la bitacora sigue sin aceptar que nadie le escriba a mano', async () => {
  /**
   * La otra mitad: la corrección no podia ser abrirle el INSERT a
   * `authenticated`. Eso arreglaba el cobro y convertia la auditoria en un
   * cuaderno que el auditado puede llenar.
   */
  const r = await db.query(
    `SELECT policyname, cmd FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'audit_logs'`,
  )

  assert.ok(r.rows.length > 0, 'audit_logs tiene que tener RLS con al menos una politica')
  for (const p of r.rows) {
    assert.equal(p.cmd, 'SELECT', `la politica ${p.policyname} permite ${p.cmd}: la bitacora se lee, no se escribe`)
  }
})

test('el disparador de auditoria sigue anotando lo que cambia', async () => {
  // Que sea DEFINER no puede haber cambiado lo que hace. Se comprueba con un
  // cambio de verdad en una ficha.
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado, ip)
      VALUES ('c1550000-0000-0000-0000-000000000001', 'AUDITADO', 'activo', '192.0.2.30');
  `)
  await db.exec(`
      UPDATE clientes SET ip = '192.0.2.31'
       WHERE id = 'c1550000-0000-0000-0000-000000000001';
  `)

  const r = await fila(
    db,
    `SELECT accion, antes ->> 'ip' AS antes, despues ->> 'ip' AS despues
       FROM audit_logs
      WHERE client_id = 'c1550000-0000-0000-0000-000000000001'
        AND entidad = 'clientes'
      ORDER BY created_at DESC LIMIT 1`,
  )

  assert.ok(r, 'el cambio de IP tiene que quedar anotado')
  assert.equal(r.accion, 'modificar')
  assert.equal(r.antes, '192.0.2.30')
  assert.equal(r.despues, '192.0.2.31')
})

// ---------------------------------------------------------------------------
// 158 — El efectivo va a caja
// ---------------------------------------------------------------------------

test('un cobro electronico sin cuenta no se puede guardar', async () => {
  /**
   * Sin cuenta no se sabe en que extracto buscarlo. Con dos cuentas del mismo
   * banco conciliadas juntas, la comparacion da cruces que parecen buenos y no lo
   * son: el comprobante de una cuenta se empareja con el movimiento de la otra.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c1580000-0000-0000-0000-000000000001', 'PAGADOR', 'activo');
  `)

  await assert.rejects(
    () => db.exec(`
        INSERT INTO pagos (client_id, monto, forma_pago, fecha_pago)
        VALUES ('c1580000-0000-0000-0000-000000000001', 20, 'transferencia', CURRENT_DATE)`),
    /a que cuenta entro|a qué cuenta entró/i,
  )
})

test('el efectivo no puede entrar a una cuenta del banco', async () => {
  /**
   * El error que motivo la migracion: la pantalla ofrecia todas las cuentas sin
   * mirar la forma de pago, asi que al cobrar en efectivo se elegia entre cuentas
   * del banco. Esa plata esta en la caja de la oficina.
   *
   * Y no es cosmetico: ese cobro aparece despues en la conciliacion como "sin
   * respaldo" —el banco no lo tiene— y manda a llamar a un abonado que pago en
   * ventanilla.
   */
  await db.exec(`
      INSERT INTO cuentas_pago (id, nombre, tipo, activa)
      VALUES ('c5800000-0000-0000-0000-000000000001', 'Pichincha prueba', 'banco', TRUE)
      ON CONFLICT (nombre) DO NOTHING;
  `)

  await assert.rejects(
    () => db.exec(`
        INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago)
        VALUES ('c1580000-0000-0000-0000-000000000001', 20, 'efectivo',
                'c5800000-0000-0000-0000-000000000001', CURRENT_DATE)`),
    /efectivo entra a caja/i,
  )
})

test('y una transferencia no puede entrar a la caja', async () => {
  // El mismo error al reves: la plata figura en la caja de la oficina y el arqueo
  // del dia no cuadra por un dinero que nadie toco.
  const caja = await fila(
    db,
    `SELECT id FROM cuentas_pago WHERE tipo = 'efectivo' AND activa LIMIT 1`,
  )
  assert.ok(caja, 'la 158 se asegura de que exista al menos una caja')

  await assert.rejects(
    () => db.exec(`
        INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago)
        VALUES ('c1580000-0000-0000-0000-000000000001', 20, 'transferencia',
                '${caja.id}', CURRENT_DATE)`),
    /caja de efectivo/i,
  )
})

test('cada forma de pago entra donde corresponde', async () => {
  const caja = await fila(db, `SELECT id FROM cuentas_pago WHERE tipo = 'efectivo' AND activa LIMIT 1`)

  // Efectivo a caja: pasa.
  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago)
      VALUES ('c1580000-0000-0000-0000-000000000001', 20, 'efectivo', '${caja.id}', CURRENT_DATE);
  `)

  // Transferencia a banco: pasa.
  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, n_transaccion, fecha_pago)
      VALUES ('c1580000-0000-0000-0000-000000000001', 20, 'transferencia',
              'c5800000-0000-0000-0000-000000000001', '999111', CURRENT_DATE);
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM pagos WHERE client_id = 'c1580000-0000-0000-0000-000000000001'`,
  )
  assert.equal(n.n, 2, 'los dos cobros bien puestos se guardan')
})

test('anular un cobro viejo sigue siendo posible', async () => {
  /**
   * Los cobros historicos no tienen cuenta —se importaron de otro sistema, o son
   * de antes de la regla— y anular es justamente como se corrigen. Exigirles la
   * regla nueva impediria arreglar el error que se quiere arreglar.
   */
  await db.exec(`
      INSERT INTO pagos (id, client_id, monto, forma_pago, fecha_pago, anulado)
      VALUES ('a1580000-0000-0000-0000-000000000001',
              'c1580000-0000-0000-0000-000000000001', 15, 'transferencia', CURRENT_DATE, TRUE);
  `)

  await db.exec(`
      UPDATE pagos SET forma_pago = 'transferencia', motivo_anulacion = 'cargado mal'
       WHERE id = 'a1580000-0000-0000-0000-000000000001';
  `)

  const p = await fila(
    db,
    `SELECT anulado FROM pagos WHERE id = 'a1580000-0000-0000-0000-000000000001'`,
  )
  assert.equal(p.anulado, true)
})

// ---------------------------------------------------------------------------
// 159 — Cada cobrador con su caja
// ---------------------------------------------------------------------------

test('al que tiene caja propia no se le ofrece la de la oficina', async () => {
  /**
   * Es la confusion que motivo la migracion: si al cajero se le ofrecen las dos,
   * el dia que cobre en la general su arqueo cierra bien y el de la oficina mal,
   * y nadie sabe por que.
   */
  await db.exec(`
      -- El usuario de autenticacion tiene que existir: \`pagos.created_by\` lo
      -- referencia, y sin el la prueba fallaria por la clave foranea y no por la
      -- regla que se quiere comprobar.
      INSERT INTO auth.users (id, email) VALUES
        ('a5900000-0000-0000-0000-000000000001', 'juana@isp.ec'),
        ('a5900000-0000-0000-0000-000000000003', 'pedro@isp.ec')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO usuarios_sistema (id, auth_id, nombre, apellido, usuario, email, rol, activo)
      VALUES ('c5900000-0000-0000-0000-000000000001',
              'a5900000-0000-0000-0000-000000000001',
              'Juana', 'Cobradora', 'juana', 'juana@isp.ec', 'cajero', TRUE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO cuentas_pago (id, nombre, tipo, activa, usuario_id)
      VALUES ('c5900000-0000-0000-0000-000000000002', 'Caja Juana', 'efectivo', TRUE,
              'c5900000-0000-0000-0000-000000000001')
      ON CONFLICT (nombre) DO NOTHING;
  `)

  const suyas = await db.query(
    `SELECT nombre, propia FROM cajas_del_usuario('a5900000-0000-0000-0000-000000000001')`,
  )

  assert.deepEqual(suyas.rows.map((x) => x.nombre), ['Caja Juana'])
  assert.equal(suyas.rows[0].propia, true)
})

test('el que no tiene caja propia usa la de la oficina', async () => {
  /**
   * Es lo que hace que la migracion no rompa nada el dia que se corre: hoy todas
   * las cajas son de la oficina y nadie tiene la suya.
   */
  await db.exec(`
      INSERT INTO usuarios_sistema (id, auth_id, nombre, usuario, email, rol, activo)
      VALUES ('c5900000-0000-0000-0000-000000000003',
              'a5900000-0000-0000-0000-000000000003',
              'Pedro', 'pedro', 'pedro@isp.ec', 'cajero', TRUE)
      ON CONFLICT (id) DO NOTHING;
  `)

  const suyas = await db.query(
    `SELECT nombre, propia FROM cajas_del_usuario('a5900000-0000-0000-0000-000000000003')`,
  )

  assert.ok(suyas.rows.length > 0, 'tiene que poder cobrar en efectivo')
  assert.ok(suyas.rows.every((x) => x.propia === false), 'ninguna es suya')
  assert.ok(
    !suyas.rows.some((x) => x.nombre === 'Caja Juana'),
    'y la caja de Juana no aparece',
  )
})

test('nadie puede cobrar contra la caja de otro', async () => {
  /**
   * Desde la 161 el mensaje dice "no es la tuya" y no "es de otra persona": la
   * regla dejo de preguntar de quien es la caja y pasa a preguntar cuales le
   * corresponden a quien cobra, que es lo mismo que ofrece la pantalla.
   */
  await db.exec(`
      INSERT INTO clientes (id, nombre, estado)
      VALUES ('c5900000-0000-0000-0000-000000000004', 'ABONADO CAJA', 'activo');
  `)

  await assert.rejects(
    () => db.exec(`
        INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago, created_by)
        VALUES ('c5900000-0000-0000-0000-000000000004', 20, 'efectivo',
                'c5900000-0000-0000-0000-000000000002', CURRENT_DATE,
                'a5900000-0000-0000-0000-000000000003')`),
    /no es la tuya/i,
  )
})

test('cobrar contra la propia si se puede', async () => {
  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago, created_by)
      VALUES ('c5900000-0000-0000-0000-000000000004', 20, 'efectivo',
              'c5900000-0000-0000-0000-000000000002', CURRENT_DATE,
              'a5900000-0000-0000-0000-000000000001');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM pagos
      WHERE cuenta_id = 'c5900000-0000-0000-0000-000000000002' AND NOT anulado`,
  )
  assert.equal(n.n, 1)
})

test('teniendo caja propia, no se puede cobrar en la de la oficina', async () => {
  /**
   * El agujero que encontro una prueba de verdad contra la base: la 159 miraba si
   * la caja era de OTRO, y la de la oficina no es de nadie, asi que se colaba.
   *
   * Es el mismo problema que la 159 vino a resolver: quien tiene su caja y cobra
   * en la general hace que su arqueo cierre bien y el de la oficina mal, y nadie
   * sabe por que.
   */
  const oficina = await fila(
    db,
    `SELECT id FROM cuentas_pago WHERE tipo = 'efectivo' AND usuario_id IS NULL AND activa LIMIT 1`,
  )
  assert.ok(oficina, 'tiene que haber una caja de la oficina para probar esto')

  await assert.rejects(
    () => db.exec(`
        INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago, created_by)
        VALUES ('c5900000-0000-0000-0000-000000000004', 20, 'efectivo',
                '${oficina.id}', CURRENT_DATE,
                'a5900000-0000-0000-0000-000000000001')`),
    /no es la tuya/i,
  )
})

test('el que NO tiene caja propia si puede usar la de la oficina', async () => {
  // Es lo que hace que la regla no rompa nada: hoy casi nadie tiene caja propia.
  const oficina = await fila(
    db,
    `SELECT id FROM cuentas_pago WHERE tipo = 'efectivo' AND usuario_id IS NULL AND activa LIMIT 1`,
  )

  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago, created_by)
      VALUES ('c5900000-0000-0000-0000-000000000004', 9, 'efectivo',
              '${oficina.id}', CURRENT_DATE, 'a5900000-0000-0000-0000-000000000003');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM pagos
      WHERE created_by = 'a5900000-0000-0000-0000-000000000003'`,
  )
  assert.equal(n.n, 1, 'Pedro no tiene caja propia: la de la oficina le sirve')
})

test('un cobro sin usuario —una importacion— no se bloquea', async () => {
  /**
   * El historico del sistema anterior se carga sin `created_by`. Exigirle dueño
   * dejaria la migracion del padron sin poder cargar los pagos viejos, que es
   * justamente lo que hay que poder hacer una sola vez y sin pelear.
   */
  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago)
      VALUES ('c5900000-0000-0000-0000-000000000004', 12, 'efectivo',
              'c5900000-0000-0000-0000-000000000002', CURRENT_DATE - 400);
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM pagos
      WHERE cuenta_id = 'c5900000-0000-0000-0000-000000000002'`,
  )
  assert.equal(n.n, 2, 'el importado entra igual')
})

test('las cuentas del banco las ve cualquiera', async () => {
  /**
   * Una transferencia entra al banco del ISP, no a la caja de nadie: repartir las
   * cuentas bancarias por cobrador dejaria a medio equipo sin poder registrar una
   * transferencia.
   */
  const def = await fila(
    db,
    `SELECT pg_get_viewdef('v_mis_cuentas_de_cobro'::regclass, true) AS sql`,
  )
  assert.ok(def.sql.includes("<> 'efectivo'"), 'lo que no es caja se ofrece siempre')
  assert.ok(def.sql.includes('cajas_del_usuario'), 'y las cajas pasan por la regla')
})

// ---------------------------------------------------------------------------
// 164 — Las velocidades en mega decimal
// ---------------------------------------------------------------------------

test('los planes en mega de 1024 pasan a mega decimal', async () => {
  /**
   * El mismo campo alimenta tres cosas que tienen que decir lo mismo: el contrato
   * que firma el abonado, el reporte a ARCOTEL y las colas del router. Con 51200
   * kbps y un sistema que divide por 1000, el contrato decia 50 y el reporte 51.2.
   *
   * Se comprueba la REGLA y no un plan puntual: los planes sembrados cambian
   * entre instalaciones, y una prueba atada a "el de 50 Mbps" falla en la
   * proxima base sin que nada este mal.
   */
  const viejos = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM planes_velocidad
      WHERE bajada_kbps > 0 AND bajada_kbps % 1024 = 0`,
  )
  assert.equal(viejos.n, 0, 'no puede quedar ninguno con la convencion vieja')

  // Y los que quedaron son redondos en mega decimal: 50000, no 51200.
  const raros = await db.query(
    `SELECT nombre, bajada_kbps FROM planes_velocidad
      WHERE bajada_kbps > 0 AND bajada_kbps % 1000 <> 0`,
  )
  assert.deepEqual(raros.rows, [], 'todos tienen que dar un numero redondo de mega')
})

test('lo anterior queda escrito, no se pierde', async () => {
  /**
   * Es un cambio de velocidad sobre planes con abonados. Si mañana aparece que
   * alguno de verdad era de 51.2, tiene que haber dónde mirarlo sin depender de
   * que alguien se acuerde.
   */
  const h = await fila(
    db,
    `SELECT nombre, bajada_kbps, motivo FROM planes_velocidad_historico
      WHERE bajada_kbps % 1024 = 0 ORDER BY cambiado_en DESC LIMIT 1`,
  )
  assert.ok(h, 'el valor viejo tiene que estar guardado')
  assert.match(h.motivo, /164/)
})

test('correrla dos veces no achica los planes de nuevo', async () => {
  /**
   * El riesgo real de esta migracion: si se aplicara a si misma, cada corrida
   * dividiria otra vez y los planes irian encogiendo sin que nadie lo note hasta
   * que un abonado reclame. Se evita exigiendo que el valor sea multiplo exacto de
   * 1024, que un plan ya corregido no cumple.
   */
  const antes = await db.query(
    'SELECT nombre, bajada_kbps, subida_kbps FROM planes_velocidad ORDER BY nombre',
  )

  const archivo = MIGRACIONES.find((f) => numero(f) === 164)
  assert.ok(archivo, 'no se encontro la migracion 164')
  await db.exec(
    readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), archivo), 'utf8'),
  )

  const despues = await db.query(
    'SELECT nombre, bajada_kbps, subida_kbps FROM planes_velocidad ORDER BY nombre',
  )
  assert.deepEqual(despues.rows, antes.rows, 'ningun plan se movio en la segunda corrida')
})


// ---------------------------------------------------------------------------
// 166 — El punto de recaudación cobra en efectivo
// ---------------------------------------------------------------------------

/**
 * Hace falta un usuario con rol `recaudacion`.
 *
 * Los de las pruebas anteriores son cajeros, y la regla es del rol. La primera
 * version de estas pruebas usaba a la cajera: pasaban sin comprobar nada, que es
 * peor que fallar.
 */
test('se arma un punto de recaudacion con su caja', async () => {
  await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
        ('a6600000-0000-0000-0000-000000000001', 'punto@isp.ec')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO usuarios_sistema (id, auth_id, nombre, usuario, email, rol, activo)
      VALUES ('c6600000-0000-0000-0000-000000000001',
              'a6600000-0000-0000-0000-000000000001',
              'Punto del Barrio', 'punto', 'punto@isp.ec', 'recaudacion', TRUE)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO cuentas_pago (id, nombre, tipo, activa, usuario_id)
      VALUES ('c6600000-0000-0000-0000-000000000002', 'Caja del Barrio', 'efectivo', TRUE,
              'c6600000-0000-0000-0000-000000000001')
      ON CONFLICT (nombre) DO NOTHING;
  `)

  const u = await fila(
    db,
    `SELECT rol FROM usuarios_sistema WHERE id = 'c6600000-0000-0000-0000-000000000001'`,
  )
  assert.equal(u.rol, 'recaudacion')
})

test('un punto de recaudacion no puede registrar una transferencia', async () => {
  /**
   * La plata se la entregan en la mano: no tiene con que verificar una
   * transferencia. Dejarselo registrar abre dos puertas y las dos terminan mal —
   * anotar un cobro que nunca entro y quedarse el efectivo, o equivocarse de
   * buena fe y que ese comprobante aparezca en la conciliacion como "sin
   * respaldo", mandando a llamar a un abonado que si pago.
   */
  const banco = await fila(db, `SELECT id FROM cuentas_pago WHERE tipo='banco' AND activa LIMIT 1`)

  await assert.rejects(
    () => db.exec(`
        INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, n_transaccion,
                           fecha_pago, created_by)
        VALUES ('c5900000-0000-0000-0000-000000000004', 20, 'transferencia',
                '${banco.id}', '778001', CURRENT_DATE,
                'a6600000-0000-0000-0000-000000000001')`),
    /solo en efectivo/i,
  )
})

test('el mensaje habla de la forma, no del monto', async () => {
  /**
   * Una transferencia PARCIAL rompe las dos reglas. El mensaje util es el de la
   * forma —"no podes cobrar asi"— y no el del monto, que lo mandaria a corregir
   * la cifra de un cobro que igual no puede hacer.
   */
  const banco = await fila(db, `SELECT id FROM cuentas_pago WHERE tipo='banco' AND activa LIMIT 1`)

  await assert.rejects(
    () => db.exec(`
        INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, n_transaccion,
                           fecha_pago, created_by)
        VALUES ('c5900000-0000-0000-0000-000000000004', 5, 'transferencia',
                '${banco.id}', '778002', CURRENT_DATE,
                'a6600000-0000-0000-0000-000000000001')`),
    /solo en efectivo/i,
  )
})

test('en efectivo y en su caja si puede', async () => {
  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago, created_by)
      VALUES ('c5900000-0000-0000-0000-000000000004', 7, 'efectivo',
              'c6600000-0000-0000-0000-000000000002', CURRENT_DATE,
              'a6600000-0000-0000-0000-000000000001');
  `)

  const n = await fila(
    db,
    `SELECT COUNT(*)::INT AS n FROM pagos
      WHERE created_by = 'a6600000-0000-0000-0000-000000000001' AND monto = 7`,
  )
  assert.equal(n.n, 1)
})

test('a los demas no se les toca la forma de pago', async () => {
  /**
   * La regla es del rol de recaudacion, no de todos. Un cajero registra una
   * transferencia todos los dias y esto no puede estorbarle.
   */
  const banco = await fila(db, `SELECT id FROM cuentas_pago WHERE tipo='banco' AND activa LIMIT 1`)

  await db.exec(`
      INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, n_transaccion,
                         fecha_pago, created_by)
      VALUES ('c5900000-0000-0000-0000-000000000004', 9, 'transferencia',
              '${banco.id}', '778003', CURRENT_DATE,
              'a5900000-0000-0000-0000-000000000003');
  `)

  const p = await fila(db, `SELECT forma_pago FROM pagos WHERE n_transaccion = '778003'`)
  assert.equal(p.forma_pago, 'transferencia', 'Pedro no es de recaudacion: cobra como quiera')
})
