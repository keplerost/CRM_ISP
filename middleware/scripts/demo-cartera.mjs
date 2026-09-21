/**
 * Juego de datos DEMO para probar cartera, retiros y reactivaciones.
 *
 * ── Qué arma ──
 *
 * Tres abonados que llegaron por el circuito real —prospecto ganado, cliente,
 * pagos— porque es la única forma de que el motor los reconozca: la comisión
 * sale de `prospectos.estado = 'ganado'` y el vendedor de `v_cliente_vendedor`,
 * que también lee prospectos. Un cliente insertado suelto no aparece en ninguna
 * de las dos pantallas y la prueba diría que todo está bien sin haber probado
 * nada.
 *
 * Cada uno está en un punto distinto de la caída, que es lo que hace que las
 * pantallas tengan algo que mostrar:
 *
 *   DEMO CARTERA UNO   · pagó hace 3 meses → llega a retiro
 *   DEMO CARTERA DOS   · pagó hace 1 mes   → en riesgo, todavía sin retiro
 *   DEMO CARTERA TRES  · pagó hace 4 meses → retiro, y después vuelve a pagar
 *
 * ── Cómo se borra ──
 *
 *   node scripts/demo-cartera.mjs --borrar
 *
 * Todo lleva el prefijo DEMO en el nombre o en la serie, así que el script de
 * limpieza general también lo levanta.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const hoy = new Date()
const haceMeses = (n) => {
  const d = new Date(hoy)
  d.setMonth(d.getMonth() - n)
  return d.toISOString().slice(0, 10)
}

const debe = (etiqueta, { data, error }) => {
  if (error) {
    console.error(`✗ ${etiqueta}: ${error.message}`)
    process.exit(1)
  }
  console.log(`✔ ${etiqueta}`)
  return data
}

// ---------------------------------------------------------------------------

async function borrar() {
  console.log('── Borrando el juego DEMO de cartera\n')
  const { data: cli } = await db.from('clientes').select('id').ilike('nombre', 'DEMO CARTERA%')
  const ids = (cli ?? []).map((c) => c.id)

  if (ids.length) {
    for (const t of ['retiro_intentos']) {
      const { data: r } = await db.from('retiros_equipo').select('id').in('cliente_id', ids)
      const rids = (r ?? []).map((x) => x.id)
      if (rids.length) await db.from(t).delete().in('retiro_id', rids)
    }
    await db.from('reactivaciones').delete().in('cliente_id', ids)
    await db.from('retiros_equipo').delete().in('cliente_id', ids)
    await db.from('comision_cohortes').delete().in('cliente_id', ids)
    await db.from('comision_ventas').delete().in('cliente_id', ids)
    await db.from('cobranza_gestiones').delete().in('asignacion_id',
      ((await db.from('cobranza_asignaciones').select('id').in('cliente_id', ids)).data ?? []).map((a) => a.id))
    await db.from('cobranza_asignaciones').delete().in('cliente_id', ids)
    await db.from('pagos').delete().in('client_id', ids)
    await db.from('equipos').update({ cliente_id: null, estado: 'en_stock' }).in('cliente_id', ids)
    await db.from('equipos').delete().ilike('serie', 'DEMO-CART%')
  }

  await db.from('prospectos').delete().ilike('nombre', 'DEMO CARTERA%')
  const { count } = await db.from('clientes').delete({ count: 'exact' }).ilike('nombre', 'DEMO CARTERA%')
  await db.from('articulos').delete().eq('nombre', 'DEMO ONT Cartera')

  console.log(`\n${count ?? 0} abonados DEMO borrados.`)
}

// ---------------------------------------------------------------------------

async function sembrar() {
  console.log('── Sembrando el juego DEMO de cartera\n')

  const vendedor = debe(
    'vendedor',
    await db.from('usuarios_sistema').select('id, nombre').eq('usuario', 'katty').maybeSingle(),
  )
  const plan = debe(
    'plan',
    await db.from('planes_velocidad').select('id, nombre, precio').eq('nombre', 'PLAN_HOME').maybeSingle(),
  )

  // Un artículo y sus equipos: sin algo que buscar, `generar_retiros_equipo`
  // no abre la orden aunque el abonado esté caído.
  let articulo = (await db.from('articulos').select('id').eq('nombre', 'DEMO ONT Cartera').maybeSingle()).data
  if (!articulo) {
    articulo = debe(
      'artículo DEMO',
      await db
        .from('articulos')
        .insert({ nombre: 'DEMO ONT Cartera', categoria: 'ont', unidad: 'u', costo_ultimo: 35 })
        .select('id')
        .single(),
    )
  }

  const CASOS = [
    { n: 'UNO', mesesUltimoPago: 3, nota: 'llega a retiro' },
    { n: 'DOS', mesesUltimoPago: 1, nota: 'en riesgo, sin retiro todavía' },
    { n: 'TRES', mesesUltimoPago: 4, nota: 'retiro y después reactivación' },
  ]

  const creados = []

  for (const caso of CASOS) {
    const nombre = `DEMO CARTERA ${caso.n}`

    const cliente = debe(
      `cliente ${nombre}`,
      await db
        .from('clientes')
        .insert({
          nombre,
          estado: 'activo',
          plan_id: plan.id,
          precio_mensual: plan.precio,
          tipo_identificacion: '05',
          identificacion: `999000${caso.n.length}${creados.length}`,
          telefono_movil: '0999000000',
          direccion: 'Domicilio DEMO de prueba',
          zona: 'DEMO',
          dia_facturacion: 5,
          fecha_instalacion: haceMeses(8),
          activado_en: new Date(haceMeses(8)).toISOString(),
          notas: 'DEMO cartera. Borrable con scripts/demo-cartera.mjs --borrar',
        })
        .select('id, nombre, codigo')
        .single(),
    )

    // El prospecto ganado: es lo que ata al vendedor y lo que hace que el motor
    // de comisiones lo vea.
    debe(
      `prospecto de ${nombre}`,
      await db
        .from('prospectos')
        .insert({
          nombre,
          telefono: '0999000000',
          vendedor_id: vendedor.id,
          estado: 'ganado',
          cliente_id: cliente.id,
          plan_id: plan.id,
          notas: 'DEMO PRUEBA cartera',
        })
        .select('id')
        .single(),
    )

    debe(
      `equipo de ${nombre}`,
      await db
        .from('equipos')
        .insert({
          articulo_id: articulo.id,
          serie: `DEMO-CART-${caso.n}`,
          estado: 'instalado',
          cliente_id: cliente.id,
        })
        .select('id')
        .single(),
    )

    // Dos pagos: uno viejo y el último, que es el que define los meses sin pagar.
    debe(
      `pagos de ${nombre}`,
      await db.from('pagos').insert([
        { client_id: cliente.id, monto: plan.precio, fecha_pago: haceMeses(caso.mesesUltimoPago + 2), forma_pago: 'efectivo' },
        { client_id: cliente.id, monto: plan.precio, fecha_pago: haceMeses(caso.mesesUltimoPago), forma_pago: 'efectivo' },
      ]).select('id'),
    )

    creados.push({ ...caso, cliente })
    console.log(`   ${nombre}: último pago hace ${caso.mesesUltimoPago} ${caso.mesesUltimoPago === 1 ? 'mes' : 'meses'} — ${caso.nota}\n`)
  }

  return creados
}

// ---------------------------------------------------------------------------

if (process.argv.includes('--borrar')) {
  await borrar()
} else {
  const creados = await sembrar()
  console.log('Sembrado. Ahora hay que generar las comisiones para que entren a cartera:')
  console.log('  SELECT * FROM generar_comisiones();')
  console.log('  SELECT * FROM generar_retiros_equipo();')
  console.log(`\nAbonados creados: ${creados.map((c) => c.cliente.codigo).join(', ')}`)
}
