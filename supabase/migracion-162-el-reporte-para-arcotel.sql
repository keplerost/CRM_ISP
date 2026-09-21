-- =============================================================================
-- Migración 162 — El reporte para ARCOTEL
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué es ──
--
-- El listado que el regulador pide: qué se le facturó a cada abonado, con su
-- plan, su velocidad, su tecnología y dónde vive. Se arma sobre las facturas
-- EMITIDAS AL SRI —no sobre las del sistema— porque es lo que el organismo puede
-- contrastar contra el propio SRI.
--
-- ── De dónde sale cada columna ──
--
--   MES                    del período de la factura
--   NOMBRE DEL USUARIO     la razón social con la que se emitió, no la de hoy
--   TELÉFONO               el móvil, y si no hay, el fijo
--   CANTÓN / CIUDAD        de la ficha del abonado
--   PARROQUIA              de la ficha
--   NOMBRE DEL PLAN        del plan contratado
--   DIRECCIÓN              de la ficha
--   COSTO INCLUIDO IMPUESTOS  el total de la factura
--   DOWN / UP (Mbps)       del plan, convertidos desde kbps
--   TECNOLOGÍA             la red de acceso declarada, o la de su instalación
--
-- ── Por qué el nombre sale de la FACTURA y no de la ficha ──
--
-- Porque un comprobante fiscal es un hecho ya ocurrido. Si el abonado cambió de
-- razón social en marzo, el reporte de enero tiene que seguir diciendo el nombre
-- con el que se emitió: es lo que el SRI tiene guardado, y una diferencia ahí es
-- una observación del regulador.
--
-- Todo lo demás —dirección, teléfono, plan— sale de la ficha de hoy, porque es
-- lo que el regulador quiere saber para poder ubicar al abonado.
-- =============================================================================

/**
 * ── La guarda ──
 *
 * La 163 le agrega a esta vista la fecha, la hora, el documento y la forma de
 * pago. Si esta migración se corre DESPUÉS —cosa que pasa cuando alguien las
 * aplica fuera de orden, o cuando vuelve a correr una vieja por las dudas—
 * intentaría devolver la versión chica y aborta con:
 *
 *   ERROR: 42P16: cannot drop columns from view
 *
 * El resto del archivo sigue corriendo igual: `v_arcotel_incompletos` vive acá y
 * la 163 no la recrea, así que saltear la migración entera dejaría a la pantalla
 * sin la lista de lo que hay que completar.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'v_reporte_arcotel'
           AND column_name = 'documento'
    ) THEN
        RAISE NOTICE 'v_reporte_arcotel ya está en su versión de la 163: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_reporte_arcotel AS
SELECT
    f.id                AS factura_id,
    f.client_id,
    f.numero_fiscal,
    f.fecha_emision,
    /**
     * El mes, en dos formas.
     *
     * `mes` es para agrupar y ordenar; `mes_nombre` es lo que se imprime. Armar
     * el nombre en la pantalla obligaría a repetir la traducción de los meses en
     * el Excel, en el PDF y en la tabla, y las tres se separarían.
     */
    TO_CHAR(COALESCE(f.periodo_desde, f.fecha_emision), 'YYYY-MM') AS mes,
    INITCAP(TO_CHAR(COALESCE(f.periodo_desde, f.fecha_emision), 'TMMonth YYYY')) AS mes_nombre,

    -- La razón social del comprobante: lo que el SRI tiene guardado.
    COALESCE(f.cliente_nombre, c.nombre) AS usuario,
    c.identificacion,
    c.codigo,

    COALESCE(NULLIF(c.telefono_movil, ''), NULLIF(c.telefono, '')) AS telefono,
    -- El cantón es lo que pide el formulario; si no está cargado, la ciudad
    -- alcanza: son el mismo dato con distinto nombre en media Sierra.
    COALESCE(NULLIF(c.canton, ''), NULLIF(c.ciudad, '')) AS canton,
    c.parroquia,
    c.direccion,

    p.nombre            AS plan,
    f.total             AS costo_con_impuestos,

    /**
     * Las velocidades en Mbps, que es la unidad del formulario.
     *
     * Se redondea a un decimal: el plan guarda kbps y 10240 kbps son 10.24 Mbps,
     * un número que en un reporte al regulador se lee como un error de carga.
     */
    ROUND(p.bajada_kbps / 1000.0, 1) AS down_mbps,
    ROUND(p.subida_kbps / 1000.0, 1) AS up_mbps,

    /**
     * La tecnología, con las palabras del formulario.
     *
     * Primero lo que se declaró en la ficha —el anexo 1f del contrato— y si está
     * vacío, lo que dice su instalación. Un abonado sin ninguna de las dos sale
     * como "POR DEFINIR" y no como fibra: inventarle una tecnología al regulador
     * es peor que declarar que falta el dato.
     */
    CASE COALESCE(c.red_acceso::TEXT, i.tecnologia)
        WHEN 'fibra'       THEN 'FIBRA OPTICA'
        WHEN 'ftth'        THEN 'FIBRA OPTICA'
        WHEN 'inalambrico' THEN 'RADIO ENLACE'
        WHEN 'radio'       THEN 'RADIO ENLACE'
        WHEN 'wireless'    THEN 'RADIO ENLACE'
        WHEN 'par_cobre'   THEN 'PAR DE COBRE'
        WHEN 'coaxial'     THEN 'COAXIAL'
        WHEN 'otros'       THEN 'OTROS'
        ELSE 'POR DEFINIR'
    END AS tecnologia,

    -- Para poder emitir el reporte de un prestador por vez: son dos RUC y el
    -- regulador los mira por separado.
    c.prestador_id,
    f.estado_sri,

    /**
     * El nivel de compartición, tal como lo declara el anexo 1f.
     *
     * Va al FINAL de la vista a propósito: `CREATE OR REPLACE` puede agregar
     * columnas pero no meterlas en el medio, y esta migración puede haberse
     * corrido ya. En el reporte sí aparece junto a las velocidades, que es donde
     * el formulario la pide.
     *
     * Se guarda como texto —"1:1", "4:1", "8:4"— y no como número: es una razón,
     * no una cantidad, y el regulador la espera escrita así. Sale del plan, que es
     * el mismo lugar de donde la toma el contrato.
     */
    p.comparticion
FROM v_facturas f
LEFT JOIN clientes c           ON c.id = f.client_id
LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
/**
 * La instalación del abonado, para la tecnología.
 *
 * `DISTINCT ON` porque un abonado puede tener varias —una nueva, un traslado— y
 * la que vale es la última: si se mudó de la antena a la fibra, el reporte tiene
 * que decir fibra.
 */
LEFT JOIN LATERAL (
    SELECT ins.tecnologia
      FROM instalaciones ins
     WHERE ins.client_id = f.client_id
       AND ins.tecnologia IS NOT NULL
     ORDER BY ins.fecha DESC NULLS LAST, ins.created_at DESC
     LIMIT 1
) i ON TRUE
WHERE NOT f.anulada
  /**
   * Solo lo que llegó al SRI y quedó autorizado.
   *
   * Una factura emitida y rechazada no existe para el organismo: incluirla haría
   * que el reporte declare ingresos que el SRI no tiene, y esa diferencia es
   * exactamente lo que el regulador cruza.
   */
  AND f.numero_fiscal IS NOT NULL
  AND f.estado_sri = 'AUTORIZADO'
$vista$;

    EXECUTE $comentario$
COMMENT ON VIEW v_reporte_arcotel IS
    'Las facturas autorizadas por el SRI con los campos que pide ARCOTEL: mes, abonado, contacto, ubicación, plan, velocidades, costo y tecnología.'
$comentario$;
END $guarda$;


-- =============================================================================
-- Qué le falta a la ficha para que el reporte salga completo
-- =============================================================================
/**
 * Los huecos, antes de exportar.
 *
 * ── Por qué esto existe ──
 *
 * Porque un reporte al regulador con celdas vacías se devuelve, y descubrirlo
 * después de mandarlo cuesta una observación. Esta vista dice qué abonados van a
 * salir incompletos y qué les falta, para poder arreglarlo antes.
 */
CREATE OR REPLACE VIEW v_arcotel_incompletos AS
SELECT
    r.client_id,
    r.codigo,
    r.usuario,
    r.mes,
    ARRAY_REMOVE(ARRAY[
        CASE WHEN r.telefono   IS NULL OR r.telefono = ''   THEN 'teléfono'   END,
        CASE WHEN r.canton     IS NULL OR r.canton = ''     THEN 'cantón'     END,
        CASE WHEN r.parroquia  IS NULL OR r.parroquia = ''  THEN 'parroquia'  END,
        CASE WHEN r.direccion  IS NULL OR r.direccion = ''  THEN 'dirección'  END,
        CASE WHEN r.plan       IS NULL                      THEN 'plan'       END,
        CASE WHEN r.down_mbps  IS NULL                      THEN 'velocidad'  END,
        CASE WHEN r.tecnologia = 'POR DEFINIR'              THEN 'tecnología' END,
        /**
         * La compartición falta en el PLAN, no en el abonado.
         *
         * Por eso se nombra así: quien lea la lista tiene que ir a Servicios →
         * Planes y no a la ficha del abonado. Cargándola una vez se arregla para
         * todos los que tienen ese plan.
         */
        CASE WHEN r.comparticion IS NULL OR r.comparticion = ''
             THEN 'compartición (en el plan)' END
    ], NULL) AS le_falta
FROM v_reporte_arcotel r
WHERE r.telefono     IS NULL OR r.telefono = ''
   OR r.canton       IS NULL OR r.canton = ''
   OR r.parroquia    IS NULL OR r.parroquia = ''
   OR r.direccion    IS NULL OR r.direccion = ''
   OR r.plan         IS NULL
   OR r.down_mbps    IS NULL
   OR r.tecnologia = 'POR DEFINIR'
   OR r.comparticion IS NULL OR r.comparticion = '';

COMMENT ON VIEW v_arcotel_incompletos IS
    'Abonados que saldrían con celdas vacías en el reporte de ARCOTEL, con la lista de lo que les falta. Se mira antes de exportar: un reporte incompleto al regulador se devuelve.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El reporte de un mes:
--   SELECT mes_nombre, usuario, telefono, canton, parroquia, plan, direccion,
--          costo_con_impuestos, down_mbps, up_mbps, comparticion, tecnologia
--     FROM v_reporte_arcotel
--    WHERE mes = '2026-08'
--    ORDER BY usuario;
--
--   -- Los planes a los que les falta la compartición, que se carga una vez:
--   SELECT nombre, bajada_kbps, subida_kbps, comparticion
--     FROM planes_velocidad WHERE activo AND COALESCE(comparticion, '') = '';
--
--   -- Y qué habría que completar antes de mandarlo:
--   SELECT codigo, usuario, le_falta FROM v_arcotel_incompletos WHERE mes = '2026-08';
