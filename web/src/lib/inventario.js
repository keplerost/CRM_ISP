import { supabase } from './supabaseClient'
import { personalApi } from './personal'

/**
 * Inventario: bodega, almacenes de técnicos y la bitácora.
 *
 * ── La regla que hay que respetar desde acá ──
 *
 * El stock NUNCA se escribe directo. Se inserta un movimiento y un trigger de la
 * base actualiza las existencias. Por eso no vas a encontrar ningún
 * `update('existencias')` en este archivo: si lo hubiera, ese camino sería el
 * único que no deja rastro, y sería justo el que se usa cuando algo no cuadra —
 * o sea, el que borra la evidencia de lo que pasó.
 */

export const CATEGORIAS = {
  ont: 'ONT / ONU',
  router: 'Router',
  antena: 'Antena',
  cable: 'Cable',
  conector: 'Conector',
  herramienta: 'Herramienta',
  material: 'Material',
  otro: 'Otro',
}

export const UNIDADES = ['u', 'm', 'rollo', 'caja', 'par', 'kg']

export const TIPOS_MOVIMIENTO = {
  ingreso: { label: 'Ingreso', color: 'verde', ayuda: 'Entra material a un almacén.' },
  salida: { label: 'Salida', color: 'ambar', ayuda: 'Sale y no vuelve: baja, pérdida, venta.' },
  transferencia: { label: 'Transferencia', color: 'azul', ayuda: 'De un almacén a otro. Típico: bodega → técnico.' },
  consumo: { label: 'Consumo', color: 'azul', ayuda: 'Se usó en una instalación o un ticket.' },
  devolucion: { label: 'Devolución', color: 'verde', ayuda: 'El técnico devuelve lo que no usó.' },
  ajuste: { label: 'Ajuste', color: 'rojo', ayuda: 'Corrección tras un conteo. Lleva signo.' },
}

export const ESTADOS_EQUIPO = {
  en_stock: { label: 'En stock', color: 'verde' },
  asignado: { label: 'Con el técnico', color: 'azul' },
  instalado: { label: 'Instalado', color: 'gris' },
  averiado: { label: 'Averiado', color: 'ambar' },
  baja: { label: 'De baja', color: 'rojo' },
}

export const inventarioApi = {
  async catalogo() {
    const [articulos, almacenes] = await Promise.all([
      supabase.from('v_articulos').select('*').order('nombre'),
      supabase.from('almacenes').select('*').eq('activo', true).order('tipo').order('nombre'),
    ])
    if (articulos.error) throw articulos.error
    return { articulos: articulos.data ?? [], almacenes: almacenes.data ?? [] }
  },

  async existencias(almacenId) {
    let q = supabase.from('v_existencias').select('*').order('articulo')
    if (almacenId) q = q.eq('almacen_id', almacenId)
    const { data, error } = await q
    if (error) throw error
    // Las filas en cero son ruido: un artículo que alguna vez pasó por un
    // almacén deja su renglón para siempre, y con veinte almacenes la lista se
    // llena de ceros que tapan lo que sí hay.
    return (data ?? []).filter((e) => Number(e.cantidad) !== 0)
  },

  /**
   * Lo que está en el mínimo o por debajo, almacén por almacén.
   *
   * Se pregunta por almacén y no por artículo porque es lo que hay que hacer
   * con la respuesta: el pedido de material es de una bodega o de la mochila de
   * un técnico. Un total sumado de todos lados no le dice a nadie qué cargar en
   * la camioneta.
   */
  async stockBajo() {
    const { data, error } = await supabase
      .from('v_stock_bajo')
      .select('*')
      // Lo agotado primero: es la diferencia entre "hay que reponer" y "hoy no
      // se puede instalar".
      .order('agotado', { ascending: false })
      .order('falta', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  /**
   * El mínimo de un artículo en un almacén concreto.
   *
   * Existe además del mínimo del artículo porque la bodega y la mochila del
   * técnico no se miden con la misma vara: la bodega avisa a las 20 ONTs, el
   * técnico a las 2. Con un solo número, o el técnico vive en alerta permanente
   * o el aviso de la bodega llega tarde.
   */
  async guardarMinimo({ almacen_id, articulo_id, minimo, reponer }) {
    const { data, error } = await supabase
      .from('stock_minimos')
      .upsert(
        {
          almacen_id,
          articulo_id,
          minimo: Number(minimo),
          reponer: reponer === '' || reponer == null ? null : Number(reponer),
        },
        { onConflict: 'almacen_id,articulo_id' },
      )
      .select()
      .single()
    if (error) throw error
    return data
  },

  /** Dejar de controlar ese artículo en ese almacén. */
  async borrarMinimo({ almacen_id, articulo_id }) {
    const { error } = await supabase
      .from('stock_minimos')
      .delete()
      .eq('almacen_id', almacen_id)
      .eq('articulo_id', articulo_id)
    if (error) throw error
  },

  /** Los mínimos ya cargados, para poder editarlos. */
  async minimos() {
    const { data, error } = await supabase.from('stock_minimos').select('*')
    if (error) throw error
    return data ?? []
  },

  async guardarArticulo(articulo) {
    const { id, ...datos } = articulo
    const fila = {
      ...datos,
      codigo: datos.codigo?.trim() || null,
      tipo_ont_id: datos.tipo_ont_id || null,
      stock_minimo: datos.stock_minimo === '' ? null : Number(datos.stock_minimo),
    }
    const { data, error } = id
      ? await supabase.from('articulos').update(fila).eq('id', id).select().single()
      : await supabase.from('articulos').insert(fila).select().single()
    if (error) throw error
    return data
  },

  async equipos({ almacenId, articuloId, busqueda } = {}) {
    let q = supabase.from('v_equipos').select('*').order('creado_en', { ascending: false }).limit(500)
    if (almacenId) q = q.eq('almacen_id', almacenId)
    if (articuloId) q = q.eq('articulo_id', articuloId)
    if (busqueda) q = q.or(`serie.ilike.%${busqueda}%,mac.ilike.%${busqueda}%`)
    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /**
   * Registra un movimiento. Es la única forma de mover stock.
   *
   * Para artículos por serie inserta un movimiento por equipo, no uno con
   * cantidad 5: cada aparato tiene su propia historia de dónde estuvo, y un
   * renglón agrupado la pierde justo para los que más importa rastrear.
   */
  async mover({ tipo, articuloId, cantidad, equipoIds = [], origen, destino, motivo, instalacionId, ticketId, costoUnit }, perfil) {
    const comun = {
      tipo,
      articulo_id: articuloId,
      almacen_origen_id: origen || null,
      almacen_destino_id: destino || null,
      instalacion_id: instalacionId || null,
      ticket_id: ticketId || null,
      costo_unit: costoUnit == null || costoUnit === '' ? null : Number(costoUnit),
      motivo: motivo || null,
      usuario_id: perfil?.id ?? null,
      usuario_nombre: perfil ? `${perfil.nombre} ${perfil.apellido ?? ''}`.trim() : null,
    }

    const filas = equipoIds.length
      ? equipoIds.map((equipo_id) => ({ ...comun, equipo_id, cantidad: 1 }))
      : [{ ...comun, cantidad: Number(cantidad) }]

    const { error } = await supabase.from('movimientos_inventario').insert(filas)
    if (error) throw error

    personalApi.registrar(
      `inventario.${tipo}`,
      `${TIPOS_MOVIMIENTO[tipo]?.label ?? tipo} de ${filas.length > 1 ? `${filas.length} equipos` : `${cantidad ?? 1}`}` +
        (motivo ? ` — ${motivo}` : ''),
      { entidad: 'articulo', entidad_id: articuloId },
    )
  },

  /** Da de alta equipos con serie. No mueve stock por sí solo: eso es el ingreso. */
  async altaEquipos({ articuloId, almacenId, series, mac }, perfil) {
    const limpias = [...new Set(series.map((s) => s.trim().toUpperCase()).filter(Boolean))]
    if (!limpias.length) throw new Error('No hay ninguna serie para dar de alta')

    const { data, error } = await supabase
      .from('equipos')
      .insert(
        limpias.map((serie, i) => ({
          articulo_id: articuloId,
          serie,
          mac: limpias.length === 1 ? mac || null : null,
          almacen_id: almacenId,
          estado: 'en_stock',
        })),
      )
      .select()
    if (error) {
      if (error.code === '23505') throw new Error('Alguna de esas series ya está cargada')
      throw error
    }

    // El ingreso que los hace existir en el stock. Va después del alta porque
    // necesita los ids, y con el trigger de por medio el stock queda cuadrado
    // sin que nadie sume nada a mano.
    await this.mover(
      {
        tipo: 'ingreso',
        articuloId,
        destino: almacenId,
        equipoIds: data.map((e) => e.id),
        motivo: 'Alta de equipos con serie',
      },
      perfil,
    )
    return data
  },

  async movimientos({ articuloId, almacenId, limite = 300 } = {}) {
    let q = supabase.from('v_movimientos').select('*').order('creado_en', { ascending: false }).limit(limite)
    if (articuloId) q = q.eq('articulo_id', articuloId)
    if (almacenId) {
      q = q.or(`almacen_origen_id.eq.${almacenId},almacen_destino_id.eq.${almacenId}`)
    }
    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  // ── Proveedores y compras ──
  async proveedores() {
    const { data, error } = await supabase.from('proveedores').select('*').order('nombre')
    if (error) throw error
    return data ?? []
  },

  async guardarProveedor(p) {
    const { id, ...datos } = p
    const { error } = id
      ? await supabase.from('proveedores').update(datos).eq('id', id)
      : await supabase.from('proveedores').insert(datos)
    if (error) throw error
  },

  async compras() {
    const { data, error } = await supabase
      .from('compras')
      .select('*, proveedores(nombre), compra_items(*, articulos(nombre, unidad, por_serie))')
      .order('fecha', { ascending: false })
      .limit(200)
    if (error) throw error
    return data ?? []
  },

  async guardarCompra({ compra, items }, perfil) {
    const { data, error } = await supabase
      .from('compras')
      .insert({ ...compra, creado_por: perfil?.id ?? null })
      .select()
      .single()
    if (error) throw error

    if (items.length) {
      const { error: e2 } = await supabase
        .from('compra_items')
        .insert(items.map((i) => ({ ...i, compra_id: data.id })))
      if (e2) throw e2
    }
    return data
  },

  /**
   * Recibe la compra: acá y solo acá entra el material al stock.
   *
   * Una compra en borrador es una intención. Sumar el stock al registrarla haría
   * que bodega prometa material que todavía está en el camión del proveedor —
   * que es de donde salen las instalaciones agendadas sin equipo.
   */
  async recibirCompra(compra, perfil) {
    if (compra.estado === 'recibida') throw new Error('Esa compra ya fue recibida')

    for (const item of compra.compra_items ?? []) {
      const series = Array.isArray(item.series) ? item.series : []

      if (item.articulos?.por_serie && series.length) {
        await this.altaEquipos(
          { articuloId: item.articulo_id, almacenId: compra.almacen_id, series },
          perfil,
        )
      } else {
        await this.mover(
          {
            tipo: 'ingreso',
            articuloId: item.articulo_id,
            cantidad: item.cantidad,
            destino: compra.almacen_id,
            costoUnit: item.costo_unit,
            motivo: `Compra ${String(compra.numero).padStart(5, '0')}`,
          },
          perfil,
        )
      }

      // El último costo sirve para valorizar el stock sin llevar un promedio
      // ponderado, que en un ISP chico nadie mantiene.
      if (Number(item.costo_unit) > 0) {
        await supabase
          .from('articulos')
          .update({ costo_ultimo: item.costo_unit })
          .eq('id', item.articulo_id)
      }
    }

    const { error } = await supabase
      .from('compras')
      .update({ estado: 'recibida', recibida_en: new Date().toISOString() })
      .eq('id', compra.id)
    if (error) throw error
  },

  /**
   * Lo que ya se descontó por esta instalación.
   *
   * El paso de materiales lo consulta al abrir. Sin esto, un técnico que vuelve
   * atrás en el asistente —o que recarga porque se le cortó la señal— vuelve a
   * cargar todo y descuenta el doble. En el asistente de campo eso no es
   * hipotético: pasa cada vez que hay mala cobertura.
   */
  async consumosDeTrabajo({ instalacionId, ticketId }) {
    if (!instalacionId && !ticketId) return []
    let q = supabase.from('v_movimientos').select('*').eq('tipo', 'consumo').order('creado_en')
    q = instalacionId ? q.eq('instalacion_id', instalacionId) : q.eq('ticket_id', ticketId)
    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /**
   * Descuenta el material usado en una instalación.
   *
   * Un movimiento por línea, todos en un solo insert: si la señal se corta a la
   * mitad no puede quedar descontado el cable y no la ONT. Que la base lo
   * acepte o lo rechace entero es la única forma de que el técnico sepa qué
   * pasó sin tener que revisar el stock desde la vereda.
   */
  async registrarConsumo({ instalacionId, ticketId, almacenId, lineas }, perfil) {
    const comun = {
      tipo: 'consumo',
      almacen_origen_id: almacenId,
      instalacion_id: instalacionId ?? null,
      ticket_id: ticketId ?? null,
      // El motivo dice de qué trabajo salió. Es lo que después separa "cuánto
      // material se fue en altas" de "cuánto se fue en garantías", que son dos
      // números muy distintos para quien mira los costos.
      motivo: instalacionId ? 'Usado en la instalación' : 'Usado en la reparación',
      usuario_id: perfil?.id ?? null,
      usuario_nombre: perfil ? `${perfil.nombre} ${perfil.apellido ?? ''}`.trim() : null,
    }

    const filas = lineas.flatMap((l) =>
      l.equipoIds?.length
        ? l.equipoIds.map((equipo_id) => ({
            ...comun,
            articulo_id: l.articuloId,
            equipo_id,
            cantidad: 1,
          }))
        : [{ ...comun, articulo_id: l.articuloId, cantidad: Number(l.cantidad) }],
    )
    if (!filas.length) return

    const { error } = await supabase.from('movimientos_inventario').insert(filas)
    if (error) throw error
  },

  /**
   * Ata los equipos consumidos al abonado recién creado.
   *
   * Corre después de finalizar el alta, y no antes, por una razón simple: el
   * cliente no existe hasta ese momento. Es lo que después responde "¿qué ONT
   * tiene Pérez?" cuando llama diciendo que no le anda, sin tener que buscar por
   * la instalación.
   */
  async vincularEquiposACliente(instalacionId, clienteId) {
    if (!instalacionId || !clienteId) return
    const { error } = await supabase
      .from('equipos')
      .update({ cliente_id: clienteId })
      .eq('instalacion_id', instalacionId)
    // No se propaga: el alta ya se completó y devolver un error acá haría que el
    // técnico crea que falló, y la repita.
    if (error) console.warn('[inventario] no se pudo vincular el equipo al cliente:', error.message)
  },

  /** El almacén del técnico que tiene la sesión abierta. */
  async miAlmacen(tecnicoId) {
    if (!tecnicoId) return null
    const { data } = await supabase
      .from('almacenes')
      .select('*')
      .eq('tecnico_id', tecnicoId)
      .maybeSingle()
    return data ?? null
  },
}
