-- =============================================================================
-- Migración 203 — El crecimiento por router
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- La gerencia quiere ver, mes a mes y por cada MikroTik, si la cartera crece o
-- se achica, y cómo evolucionan los morosos y la deuda. Eso son dos preguntas
-- con dos respuestas distintas:
--
--   1. ALTAS Y BAJAS. Se pueden reconstruir hacia atrás: cada ficha tiene su
--      fecha de instalación (o de registro) y, si se fue, su fecha de baja.
--      `reporte_crecimiento_routers()` las cuenta por mes y por router.
--
--   2. CORTADOS, PAUSADOS Y DEUDA DE CADA MES. No se pueden reconstruir: el
--      sistema guarda el estado de HOY de cada abonado, no su historia. Por eso
--      se empieza a sacar una FOTO mensual (`fotos_routers_mensual`), y desde el
--      mes en que corre esta migración en adelante la historia queda guardada.
--
-- ── Cómo funciona la foto ──
--
-- La tarea "Foto mensual por router" llama a `tomar_foto_routers()` una vez por
-- día. La función PISA la fila del mes en curso, así que cuando el mes termina
-- queda congelada con el estado del último día en que corrió: es la foto del
-- cierre del mes. Si el servidor estuvo caído el último día, queda la del
-- anteúltimo, que es lo más cerca que se puede estar.
--
-- ── Lo que el reporte NO sabe ──
--
--   · Un abonado que se cambió de router cuenta, en todos los meses, en el
--     router que tiene HOY. El sistema no guarda los traslados entre equipos.
--   · Los importados sin fecha de instalación tienen como fecha de alta el día
--     de la importación. Se informan aparte, como "carga inicial", para que el
--     mes de la importación no parezca un mes de ventas récord.
-- =============================================================================


-- =============================================================================
-- 1. La foto mensual
-- =============================================================================
/**
 * Sin FK a `routers_mikrotik` a propósito: si un router se da de baja, su
 * historia tiene que seguir en el reporte. Por eso también se guarda el nombre.
 */
CREATE TABLE IF NOT EXISTS fotos_routers_mensual (
    mes           DATE        NOT NULL,   -- siempre el día 1
    router_id     UUID        NOT NULL,
    router_nombre TEXT        NOT NULL,
    activos       INT         NOT NULL DEFAULT 0,
    cortados      INT         NOT NULL DEFAULT 0,
    suspendidos   INT         NOT NULL DEFAULT 0,
    por_cobrar    NUMERIC(14,2) NOT NULL DEFAULT 0,
    vencido       NUMERIC(14,2) NOT NULL DEFAULT 0,
    tomada_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mes, router_id),
    CONSTRAINT fotos_routers_mes_dia_1 CHECK (EXTRACT(DAY FROM mes) = 1)
);

COMMENT ON TABLE fotos_routers_mensual IS
    'Estado de cada router al cierre de cada mes: activos, cortados, pausados y deuda. La escribe tomar_foto_routers().';

ALTER TABLE fotos_routers_mensual ENABLE ROW LEVEL SECURITY;

/**
 * Se lee con sesión; se escribe SOLO por la función. Una foto editable a mano
 * deja de ser una foto: es una opinión sobre el pasado.
 */
DROP POLICY IF EXISTS auth_leer_fotos_routers ON fotos_routers_mensual;
CREATE POLICY auth_leer_fotos_routers ON fotos_routers_mensual
    FOR SELECT TO authenticated USING (true);


/**
 * Toma (o actualiza) la foto del mes de `p_hoy`.
 *
 * `p_hoy` lo manda el middleware con su fecha local. Si se omite se usa la
 * fecha de la zona del ISP, no la de UTC: a las 20:00 de Ecuador del día 31 en
 * UTC ya es el mes siguiente, y la foto del cierre caería en el mes que no es.
 */
CREATE OR REPLACE FUNCTION tomar_foto_routers(p_hoy DATE DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hoy   DATE := COALESCE(p_hoy, (NOW() AT TIME ZONE zona_horaria())::date);
    v_mes   DATE := date_trunc('month', v_hoy)::date;
    v_filas INT;
BEGIN
    WITH deuda AS (
        SELECT f.client_id,
               SUM(f.saldo) FILTER (WHERE f.saldo > 0)                                    AS por_cobrar,
               SUM(f.saldo) FILTER (WHERE f.saldo > 0 AND f.fecha_vencimiento < v_hoy)    AS vencido
          FROM v_facturas_por_cobrar f
         GROUP BY f.client_id
    )
    INSERT INTO fotos_routers_mensual AS fr
           (mes, router_id, router_nombre, activos, cortados, suspendidos, por_cobrar, vencido, tomada_en)
    SELECT v_mes,
           r.id,
           r.nombre,
           COUNT(c.id) FILTER (WHERE c.estado = 'activo'),
           COUNT(c.id) FILTER (WHERE c.estado = 'cortado'),
           COUNT(c.id) FILTER (WHERE c.estado = 'suspendido'),
           COALESCE(SUM(d.por_cobrar), 0),
           COALESCE(SUM(d.vencido), 0),
           NOW()
      FROM routers_mikrotik r
      -- Los retirados no cuentan, igual que en el panel: ni su gente ni su deuda.
      LEFT JOIN clientes c ON c.router_id = r.id AND c.estado IN ('activo', 'cortado', 'suspendido')
      LEFT JOIN deuda d    ON d.client_id = c.id
     GROUP BY r.id, r.nombre
    ON CONFLICT (mes, router_id) DO UPDATE
       SET router_nombre = EXCLUDED.router_nombre,
           activos       = EXCLUDED.activos,
           cortados      = EXCLUDED.cortados,
           suspendidos   = EXCLUDED.suspendidos,
           por_cobrar    = EXCLUDED.por_cobrar,
           vencido       = EXCLUDED.vencido,
           tomada_en     = EXCLUDED.tomada_en;

    GET DIAGNOSTICS v_filas = ROW_COUNT;
    RETURN v_filas;
END;
$$;

COMMENT ON FUNCTION tomar_foto_routers IS
    'Guarda el estado de cada router en el mes en curso. Se puede llamar muchas veces: pisa la foto del mes, no la duplica.';

REVOKE ALL ON FUNCTION tomar_foto_routers(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tomar_foto_routers(DATE) TO authenticated, service_role;


-- =============================================================================
-- 2. La tarea que la toma
-- =============================================================================
/**
 * Encendida de fábrica: solo lee y escribe su propia tabla. Apagada, la
 * historia de morosos tendría huecos que después no se pueden llenar.
 *
 * Tarde a propósito: la foto del último día del mes es la que queda.
 */
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS foto_routers_automatico BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS foto_routers_hora       TEXT    NOT NULL DEFAULT '23:30';

COMMENT ON COLUMN config_tareas.foto_routers_automatico IS
    'Guardar cada día el estado de cada router en la foto del mes en curso.';
COMMENT ON COLUMN config_tareas.foto_routers_hora IS
    'A qué hora tomar la foto. Tarde: la del último día del mes es la que queda como cierre.';


-- =============================================================================
-- 3. El reporte
-- =============================================================================
/**
 * Una fila por mes y por router, con altas, bajas, total al cierre y —cuando
 * hay foto de ese mes— cortados, pausados y deuda.
 *
 * `security invoker`: lee `clientes` con los permisos de quien pregunta, igual
 * que el listado. El que no puede ver la cartera no la ve por acá.
 */
CREATE OR REPLACE FUNCTION reporte_crecimiento_routers(p_desde DATE, p_hasta DATE)
RETURNS TABLE (
    mes           DATE,
    router_id     UUID,
    router        TEXT,
    altas         INT,
    carga_inicial INT,
    bajas         INT,
    neto          INT,
    total         INT,
    con_foto      BOOLEAN,
    activos       INT,
    cortados      INT,
    suspendidos   INT,
    por_cobrar    NUMERIC,
    vencido       NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    WITH meses AS (
        SELECT g::date AS mes, (g + INTERVAL '1 month')::date AS siguiente
          FROM generate_series(date_trunc('month', p_desde),
                               date_trunc('month', p_hasta),
                               INTERVAL '1 month') AS g
    ),
    abonados AS (
        SELECT c.router_id,
               COALESCE(c.fecha_instalacion, (c.created_at AT TIME ZONE zona_horaria())::date) AS alta,
               -- Importado y sin fecha real: su "alta" es el día de la carga.
               (c.fecha_instalacion IS NULL
                AND (c.origen <> 'manual' OR c.sistema_origen IS NOT NULL))                  AS importado,
               -- Solo los que HOY están de baja: uno que volvió no se fue.
               CASE WHEN c.estado = 'baja'
                    THEN (COALESCE(c.baja_en, c.estado_desde, c.updated_at) AT TIME ZONE zona_horaria())::date
               END                                                                            AS baja
          FROM clientes c
    ),
    equipos AS (
        SELECT r.id, r.nombre::text AS nombre FROM routers_mikrotik r
        UNION ALL
        -- Los routers borrados que dejaron foto: su historia sigue contando.
        (SELECT DISTINCT ON (f.router_id) f.router_id, f.router_nombre
           FROM fotos_routers_mensual f
          WHERE NOT EXISTS (SELECT 1 FROM routers_mikrotik r WHERE r.id = f.router_id)
          ORDER BY f.router_id, f.mes DESC)
        UNION ALL
        SELECT NULL, 'Sin router asignado'
         WHERE EXISTS (SELECT 1 FROM clientes WHERE router_id IS NULL)
    ),
    cuentas AS (
        SELECT m.mes, e.id AS router_id, e.nombre AS router,
               COUNT(a.alta) FILTER (WHERE a.alta >= m.mes AND a.alta < m.siguiente AND NOT a.importado)::int AS altas,
               COUNT(a.alta) FILTER (WHERE a.alta >= m.mes AND a.alta < m.siguiente AND a.importado)::int     AS carga_inicial,
               COUNT(a.baja) FILTER (WHERE a.baja >= m.mes AND a.baja < m.siguiente)::int                     AS bajas,
               COUNT(a.alta) FILTER (WHERE a.alta < m.siguiente
                                       AND (a.baja IS NULL OR a.baja >= m.siguiente))::int                    AS total
          FROM meses m
         CROSS JOIN equipos e
          LEFT JOIN abonados a ON a.router_id IS NOT DISTINCT FROM e.id
         GROUP BY m.mes, e.id, e.nombre
    )
    SELECT k.mes, k.router_id, k.router,
           k.altas, k.carga_inicial, k.bajas,
           k.altas + k.carga_inicial - k.bajas AS neto,
           k.total,
           f.mes IS NOT NULL AS con_foto,
           f.activos, f.cortados, f.suspendidos, f.por_cobrar, f.vencido
      FROM cuentas k
      LEFT JOIN fotos_routers_mensual f ON f.mes = k.mes AND f.router_id = k.router_id
     ORDER BY k.mes, k.router
$$;

COMMENT ON FUNCTION reporte_crecimiento_routers IS
    'Altas, bajas y total por mes y por router, con la foto mensual de morosos y deuda cuando existe.';

GRANT EXECUTE ON FUNCTION reporte_crecimiento_routers(DATE, DATE) TO authenticated, service_role;


-- La primera foto, ya: así el mes en curso no queda vacío esperando a la tarea.
SELECT tomar_foto_routers();


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT * FROM fotos_routers_mensual ORDER BY mes DESC, router_nombre;
--
--   -- El último año:
--   SELECT * FROM reporte_crecimiento_routers(CURRENT_DATE - INTERVAL '11 months', CURRENT_DATE);
