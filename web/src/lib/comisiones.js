import { supabase } from './supabaseClient'
import { personalApi } from './personal'

/**
 * Configuración de comisiones e incentivos.
 *
 * ── Qué hay acá y qué no ──
 *
 * Solo la configuración: cuánto vale cada plan para el vendedor, los escalones,
 * los bonos y las reglas del período. El motor que calcula comisiones de verdad
 * es la fase siguiente; esto es lo que ese motor va a leer.
 *
 * ── Por qué guardar es crear una versión y no editar ──
 *
 * Porque una comisión pagada tiene que poder explicarse. Si subir la base del
 * plan de 500 megas editara la fila existente, el período de agosto —ya cerrado
 * y cobrado— pasaría a mostrar números distintos de los que se pagaron, y nadie
 * podría demostrar cuáles eran los correctos.
 *
 * Así que hay dos formas de guardar y la pantalla las distingue:
 *
 *   `guardar`      corrige el esquema vigente. Para arreglar un valor mal
 *                  tipeado el mismo día, antes de que haya cerrado nada.
 *   `nuevaVersion` cierra el esquema actual y abre uno nuevo desde una fecha.
 *                  Es lo que corresponde cuando cambian las condiciones de
 *                  verdad, y es lo que deja intactos los períodos viejos.
 */

export const MODOS = {
  retroactivo: {
    label: 'Retroactivo',
    ayuda:
      'Al alcanzar un nivel, su porcentaje se aplica a TODAS las ventas del período. Llegar a 26 ventas paga el 45 % sobre las 26.',
  },
  progresivo: {
    label: 'Progresivo por tramos',
    ayuda:
      'Cada tramo cobra su propio porcentaje. Las primeras 10 al 20 %, las siguientes 5 al 30 %, y así.',
  },
}

/** Los requisitos que puede exigir una venta para volverse comisionable. */
export const REQUISITOS = [
  {
    campo: 'requiere_aprobacion',
    label: 'Aprobada por admisión',
    ayuda:
      'Exige que alguien con permiso haya validado la solicitud. Encendelo cuando la admisión esté en régimen: hasta entonces ninguna venta comisionaría.',
  },
  {
    campo: 'requiere_documentacion',
    label: 'Documentación completa',
    ayuda: 'Cédula, fotos y ubicación cargadas en el expediente.',
  },
  { campo: 'requiere_contrato', label: 'Contrato firmado' },
  { campo: 'requiere_instalacion', label: 'Instalación hecha' },
  { campo: 'requiere_activacion', label: 'Abonado activo' },
  {
    campo: 'requiere_primer_pago',
    label: 'Primer pago cobrado',
    ayuda: 'Respeta el período de cortesía: una instalación del 27 se espera hasta el 5 del mes siguiente.',
  },
]

/**
 * Los estados de una comisión, como los pide el punto 29.
 *
 * Cada uno lleva TEXTO además de color. Un tablero que distingue "pagada" de
 * "anulada" solo por el color deja afuera a quien no distingue esos dos colores
 * —y son justamente los dos que no conviene confundir.
 */
export const ESTADOS_COMISION = {
  proyectada: {
    label: 'Proyectada',
    color: 'azul',
    ayuda: 'Todavía puede cambiar: el período sigue abierto.',
  },
  pendiente_validacion: {
    label: 'Esperando primer pago',
    color: 'ambar',
    ayuda: 'Cumple todo menos el pago, y está dentro de su período de cortesía.',
  },
  generada: {
    label: 'Generada',
    color: 'azul',
    ayuda: 'El período cerró y quedó contada con este monto.',
  },
  aprobada: { label: 'Aprobada', color: 'verde', ayuda: 'Autorizada para pago.' },
  pagada: { label: 'Pagada', color: 'gris', ayuda: 'Ya se liquidó.' },
  anulada: {
    label: 'Anulada',
    color: 'rojo',
    ayuda: 'Se dio de baja con motivo escrito. Queda en la auditoría.',
  },
}

/** Los estados de una liquidación de período. */
export const ESTADOS_PERIODO = {
  cerrado: { label: 'Cerrado', color: 'ambar', ayuda: 'Congelado, esperando autorización.' },
  aprobado: { label: 'Aprobado', color: 'verde', ayuda: 'Autorizado, esperando pago.' },
  pagado: { label: 'Pagado', color: 'gris', ayuda: 'Liquidado.' },
}

export const comisionesApi = {
  /** El esquema vigente con todo lo que cuelga de él. */
  async esquema() {
    const { data: esquema, error } = await supabase
      .from('v_comision_esquema')
      .select('*')
      .eq('activo', true)
      .maybeSingle()
    if (error) throw error
    if (!esquema) return null

    const [niveles, bases, bonos] = await Promise.all([
      supabase.from('comision_niveles').select('*').eq('esquema_id', esquema.id).order('orden'),
      supabase.from('v_comision_bases').select('*').eq('esquema_id', esquema.id).order('bajada_kbps'),
      supabase.from('comision_bonos_calidad').select('*').eq('esquema_id', esquema.id).order('orden'),
    ])

    const fallo = [niveles, bases, bonos].find((r) => r.error)
    if (fallo) throw fallo.error

    return {
      ...esquema,
      niveles: niveles.data ?? [],
      bases: bases.data ?? [],
      bonos: bonos.data ?? [],
    }
  },

  /** Las versiones anteriores, para poder mirar con qué reglas se pagó cada mes. */
  async versiones() {
    const { data, error } = await supabase
      .from('v_comision_esquema')
      .select('*')
      .order('vigente_desde', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async motivosBaja() {
    const { data, error } = await supabase
      .from('motivos_baja')
      .select('*')
      .order('afecta_calidad')
      .order('orden')
    if (error) throw error
    return data ?? []
  },

  /**
   * Corrige el esquema vigente en el lugar.
   *
   * Se hace en cuatro escrituras y no en una transacción porque PostgREST no
   * las tiene: si se corta en el medio queda a medias. Es aceptable acá —esto es
   * configuración que se revisa en pantalla, no un movimiento de dinero— y a
   * cambio evita meter una función en la base para algo que va a cambiar de
   * forma varias veces todavía.
   */
  async guardar(esquema, { niveles, bases, bonos, reglas }, perfil) {
    const anterior = await this.esquema()

    if (reglas) {
      const { error } = await supabase
        .from('comision_reglas')
        .update({
          ...reglas,
          actualizado_en: new Date().toISOString(),
          actualizado_por: perfil?.id ?? null,
        })
        .eq('esquema_id', esquema.id)
      if (error) throw error
    }

    if (esquema.modo || esquema.nombre) {
      const { error } = await supabase
        .from('comision_esquemas')
        .update({
          nombre: esquema.nombre,
          modo: esquema.modo,
          notas: esquema.notas ?? null,
          actualizado_en: new Date().toISOString(),
        })
        .eq('id', esquema.id)
      if (error) throw error
    }

    for (const n of niveles ?? []) {
      const { error } = await supabase
        .from('comision_niveles')
        .update({
          nombre: n.nombre,
          desde_ventas: Number(n.desde_ventas),
          hasta_ventas: n.hasta_ventas === '' || n.hasta_ventas == null ? null : Number(n.hasta_ventas),
          porcentaje: Number(n.porcentaje),
        })
        .eq('id', n.id)
      if (error) throw error
    }

    for (const b of bases ?? []) {
      const { error } = await supabase
        .from('comision_bases_plan')
        .update({ base: Number(b.base), comisiona: b.comisiona })
        .eq('esquema_id', esquema.id)
        .eq('plan_id', b.plan_id)
      if (error) throw error
    }

    for (const b of bonos ?? []) {
      const { error } = await supabase
        .from('comision_bonos_calidad')
        .update({
          desde_pct: Number(b.desde_pct),
          hasta_pct: Number(b.hasta_pct),
          monto: Number(b.monto),
        })
        .eq('id', b.id)
      if (error) throw error
    }

    // Nada financiero se modifica en silencio: queda con el valor anterior y el
    // nuevo, que es lo que pide el punto 26.
    personalApi.registrar(
      'comisiones.configurar',
      `Editó el esquema de comisiones "${esquema.nombre}"`,
      {
        entidad: 'comision_esquema',
        entidad_id: esquema.id,
        datos: {
          antes: anterior
            ? { modo: anterior.modo, niveles: anterior.niveles, bases: anterior.bases, bonos: anterior.bonos }
            : null,
          despues: { modo: esquema.modo, niveles, bases, bonos, reglas },
        },
      },
    )
  },

  /**
   * Cierra el esquema vigente y abre uno nuevo copiando sus valores.
   *
   * El anterior queda con `vigente_hasta` el día antes: así ninguna fecha cae en
   * dos esquemas a la vez, que es lo que haría que una misma venta valiera dos
   * cosas distintas según cuándo se la consulte.
   */
  async nuevaVersion({ nombre, desde }, perfil) {
    const actual = await this.esquema()
    if (!actual) throw new Error('No hay un esquema vigente para copiar.')

    const inicio = desde || new Date().toISOString().slice(0, 10)
    const finAnterior = new Date(`${inicio}T12:00:00`)
    finAnterior.setDate(finAnterior.getDate() - 1)
    const finISO = finAnterior.toISOString().slice(0, 10)

    if (finISO < actual.vigente_desde) {
      throw new Error(
        `La versión nueva no puede arrancar antes que la actual (${actual.vigente_desde}). ` +
          'Elegí una fecha posterior.',
      )
    }

    // Primero se desactiva el actual: hay un índice único que impide dos activos
    // a la vez, y sin esto el insert de abajo fallaría con un error de base que
    // no le dice nada a nadie.
    const { error: eCierre } = await supabase
      .from('comision_esquemas')
      .update({ activo: false, vigente_hasta: finISO })
      .eq('id', actual.id)
    if (eCierre) throw eCierre

    const { data: nuevo, error } = await supabase
      .from('comision_esquemas')
      .insert({
        nombre,
        modo: actual.modo,
        vigente_desde: inicio,
        activo: true,
        creado_por: perfil?.id ?? null,
        notas: `Copiado de "${actual.nombre}".`,
      })
      .select()
      .single()
    if (error) {
      // Se revierte el cierre: dejar el sistema sin ningún esquema activo sería
      // peor que no haber hecho nada.
      await supabase
        .from('comision_esquemas')
        .update({ activo: true, vigente_hasta: actual.vigente_hasta })
        .eq('id', actual.id)
      throw error
    }

    await Promise.all([
      supabase.from('comision_reglas').insert({
        esquema_id: nuevo.id,
        ...Object.fromEntries(REQUISITOS.map((r) => [r.campo, actual[r.campo]])),
        dia_cortesia_desde: actual.dia_cortesia_desde,
        pago_ventana_desde: actual.pago_ventana_desde,
        pago_ventana_hasta: actual.pago_ventana_hasta,
        dia_cierre: actual.dia_cierre,
        dias_cohorte: actual.dias_cohorte,
        min_clientes_cohorte: actual.min_clientes_cohorte,
        meses_sin_pago_suspension: actual.meses_sin_pago_suspension,
        meses_sin_pago_retiro: actual.meses_sin_pago_retiro,
        actualizado_por: perfil?.id ?? null,
      }),
      supabase.from('comision_niveles').insert(
        actual.niveles.map((n) => ({
          esquema_id: nuevo.id,
          orden: n.orden,
          nombre: n.nombre,
          desde_ventas: n.desde_ventas,
          hasta_ventas: n.hasta_ventas,
          porcentaje: n.porcentaje,
        })),
      ),
      supabase.from('comision_bonos_calidad').insert(
        actual.bonos.map((b) => ({
          esquema_id: nuevo.id,
          orden: b.orden,
          desde_pct: b.desde_pct,
          hasta_pct: b.hasta_pct,
          monto: b.monto,
        })),
      ),
      supabase.from('comision_bases_plan').insert(
        actual.bases.map((b) => ({
          esquema_id: nuevo.id,
          plan_id: b.plan_id,
          base: b.base,
          comisiona: b.comisiona,
        })),
      ),
    ])

    personalApi.registrar(
      'comisiones.configurar',
      `Creó la versión "${nombre}" del esquema de comisiones, vigente desde ${inicio}`,
      { entidad: 'comision_esquema', entidad_id: nuevo.id, datos: { copiado_de: actual.id } },
    )

    return nuevo
  },

  /**
   * El resumen de un vendedor por período.
   *
   * Sin filtro devuelve lo que la sesión pueda ver: el vendedor, lo suyo. El
   * filtro está en la base —RLS sobre `comision_ventas`— y no acá.
   */
  async resumen({ vendedor, periodo } = {}) {
    let q = supabase.from('v_comision_resumen').select('*').order('periodo', { ascending: false })
    if (vendedor) q = q.eq('vendedor_id', vendedor)
    if (periodo) q = q.eq('periodo', periodo)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /** El embudo: solicitudes ingresadas frente a ventas comisionables. */
  async embudo({ vendedor, periodo } = {}) {
    let q = supabase.from('v_comision_embudo').select('*').order('periodo', { ascending: false })
    if (vendedor) q = q.eq('vendedor_id', vendedor)
    if (periodo) q = q.eq('periodo', periodo)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /** Las ventas de un período, con qué le falta a cada una para comisionar. */
  async ventas({ vendedor, periodo } = {}) {
    let q = supabase
      .from('v_comision_ventas')
      .select('*')
      .neq('estado', 'anulada')
      .order('comisionable_en', { ascending: false, nullsFirst: false })
    if (vendedor) q = q.eq('vendedor_id', vendedor)
    if (periodo) q = q.eq('periodo', periodo)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  // ── Inteligencia comercial: solo para quien ve todo el equipo ─────────────
  //
  // Las cuatro vistas filtran adentro con `ve_comisiones_de_todos()`. Sin el
  // permiso devuelven vacío en vez de fallar, así que la pantalla no necesita
  // preguntar antes: si no hay filas, no hay nada que mostrar.

  /** Los indicadores del período: embudo, ventas, dinero cerrado, calidad. */
  async kpis({ periodo } = {}) {
    let q = supabase.from('v_comision_kpis').select('*').order('periodo', { ascending: false })
    if (periodo) q = q.eq('periodo', periodo)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /** Una fila por vendedor: el embudo, las tasas y la retención de su cohorte. */
  async equipo({ periodo } = {}) {
    let q = supabase
      .from('v_comision_equipo')
      .select('*')
      .order('comisionables', { ascending: false })
    if (periodo) q = q.eq('periodo', periodo)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /** Qué se vende: ventas y base promedio por plan. */
  async porPlan({ periodo } = {}) {
    let q = supabase.from('v_comision_por_plan').select('*').order('ventas', { ascending: false })
    if (periodo) q = q.eq('periodo', periodo)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /** La foto de hoy: cartera por caerse, equipos en la calle, lo que espera firma. */
  async carteraKpis() {
    const { data, error } = await supabase.from('v_cartera_kpis').select('*').maybeSingle()
    if (error) throw error
    return data ?? null
  },

  /**
   * Mueve una liquidación por la máquina de estados: cerrado → aprobado → pagado.
   *
   * La verificación de permiso está en la base, no acá: la pantalla esconde el
   * botón por cortesía, y `mover_periodo_comisiones` rechaza la llamada si quien
   * la hace no tiene la clave. Esconder un botón no es un control de acceso.
   */
  async moverPeriodo(periodoId, destino, nota) {
    const { error } = await supabase.rpc('mover_periodo_comisiones', {
      p_periodo_id: periodoId,
      p_destino: destino,
      p_nota: nota || null,
    })
    if (error) throw error
  },

  /** Anula una venta comisionable. Exige motivo escrito: nada se cambia en silencio. */
  async anularVenta(ventaId, motivo) {
    const { error } = await supabase.rpc('anular_comision_venta', {
      p_venta: ventaId,
      p_motivo: motivo,
    })
    if (error) throw error
  },

  /** Las liquidaciones: qué se cerró, con qué reglas y en qué estado quedó. */
  async liquidaciones({ vendedor } = {}) {
    let q = supabase.from('v_comision_periodos').select('*').order('periodo', { ascending: false })
    if (vendedor) q = q.eq('vendedor_id', vendedor)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /**
   * Las cohortes de calidad.
   *
   * Sin vendedor devuelve lo que la sesión pueda ver: el vendedor, las suyas;
   * quien tiene `comisiones.ver_todas`, las de todo el equipo. El filtro está en
   * la base —RLS sobre `comision_cohortes`— y no acá, para que no haya una
   * segunda respuesta posible a la misma pregunta.
   */
  async cohortes({ vendedor, desde } = {}) {
    let q = supabase.from('v_comision_cohortes').select('*').order('cohorte', { ascending: false })
    if (vendedor) q = q.eq('vendedor_id', vendedor)
    if (desde) q = q.gte('cohorte', desde)

    const { data, error } = await q
    if (error) throw error
    return data ?? []
  },

  /**
   * El detalle de una cohorte: quién se conservó, quién se perdió y por qué.
   *
   * Es lo que convierte un 92 % en algo accionable — sin los nombres, el
   * porcentaje solo sirve para discutirlo.
   */
  async cohorteDetalle(vendedor, cohorte) {
    const { data, error } = await supabase
      .from('v_comision_ventas')
      .select(
        'id, cliente, cliente_id, plan, base, calidad_estado, calidad_motivo, meses_sin_pago, comisionable_en',
      )
      .eq('vendedor_id', vendedor)
      .eq('cohorte', cohorte)
      .neq('estado', 'anulada')
      .order('calidad_estado')
    if (error) throw error
    return data ?? []
  },

  /**
   * Lleva un escenario del simulador a la configuración real.
   *
   * ── Por qué crea una versión y no edita la vigente ──
   *
   * Porque cambiar bases y porcentajes es cambiar las condiciones, y el punto 25
   * es explícito: no modificar períodos históricos. Editar en el lugar haría que
   * agosto —ya cerrado y cobrado— pasara a mostrar números distintos de los que
   * se pagaron. La corrección en el lugar sigue existiendo en la pantalla de
   * configuración, que es donde corresponde arreglar un valor mal tipeado el
   * mismo día.
   *
   * ── Por qué son dos pasos y no uno ──
   *
   * `nuevaVersion` copia el esquema vigente, así que los tramos nuevos tienen
   * ids nuevos: no se pueden escribir los valores editados antes de que existan.
   * Se crea la versión, se relee y se mapean los valores por `orden` —para
   * niveles y bonos— y por `plan_id` —para las bases—, que es lo que se conserva
   * al copiar.
   *
   * Si el segundo paso falla, queda una versión creada con los valores viejos.
   * Es el modo de fallar correcto: una copia idéntica de lo que ya regía no le
   * cambia la comisión a nadie, y se ve en pantalla.
   */
  async aplicarSimulacion({ nombre, desde, modo, niveles, bonos, mezcla, minClientes }, perfil) {
    await this.nuevaVersion({ nombre, desde }, perfil)

    const nuevo = await this.esquema()
    if (!nuevo) throw new Error('No se pudo leer la versión nueva.')

    const nivelesNuevos = nuevo.niveles.map((n) => {
      const src = niveles?.find((x) => Number(x.orden) === Number(n.orden))
      return src
        ? {
            ...n,
            desde_ventas: src.desde_ventas,
            hasta_ventas: src.hasta_ventas,
            porcentaje: src.porcentaje,
            nombre: src.nombre ?? n.nombre,
          }
        : n
    })

    const bonosNuevos = nuevo.bonos.map((b) => {
      const src = bonos?.find((x) => Number(x.orden) === Number(b.orden))
      return src
        ? { ...b, desde_pct: src.desde_pct, hasta_pct: src.hasta_pct, monto: src.monto }
        : b
    })

    const basesNuevas = nuevo.bases.map((b) => {
      const src = mezcla?.find((x) => x.plan_id === b.plan_id)
      return src ? { ...b, base: src.base } : b
    })

    await this.guardar(
      { ...nuevo, modo: modo ?? nuevo.modo },
      {
        niveles: nivelesNuevos,
        bonos: bonosNuevos,
        bases: basesNuevas,
        reglas: minClientes == null ? null : { min_clientes_cohorte: Number(minClientes) },
      },
      perfil,
    )

    return nuevo
  },

  /**
   * Corre la revisión del módulo.
   *
   * Trece pruebas sobre duplicados, cierres, bonos, firmas y equipos. La función
   * exige ver todas las comisiones, así que devuelve error —y no una lista
   * vacía— para quien no puede: una revisión que dice "todo bien" porque no vio
   * nada es peor que ninguna.
   */
  async verificar() {
    const { data, error } = await supabase.rpc('verificar_comisiones')
    if (error) throw error
    return data ?? []
  },

  /** El rastro: cambios de reglas, validaciones, cierres, pagos y anulaciones. */
  async auditoria({ limite = 50 } = {}) {
    const { data, error } = await supabase
      .from('v_auditoria_comisiones')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(limite)
    if (error) throw error
    return data ?? []
  },

  async guardarMotivo(motivo) {
    const { id, ...datos } = motivo
    const { error } = id
      ? await supabase.from('motivos_baja').update(datos).eq('id', id)
      : await supabase.from('motivos_baja').insert(datos)
    if (error) throw error
  },
}

/**
 * La cuenta vive en `comisionesCalculo.js` y se reexporta desde acá.
 *
 * ── Por qué está partido ──
 *
 * Este archivo habla con Supabase; aquel no importa nada. Esa diferencia es lo
 * que permite que la multiplicación que decide cuánto cobra un vendedor tenga
 * pruebas —`middleware/test/comisionesCalculo.test.js`— sin necesitar una base
 * de datos para correrlas.
 *
 * Se reexporta para que las pantallas sigan importando `calcular`, `proyeccion`
 * y `siguienteNivel` desde `lib/comisiones` como hasta ahora: partir un archivo
 * no tiene por qué obligar a tocar seis pantallas.
 */
export { calcular, siguienteNivel, proyeccion } from './comisionesCalculo.js'
