-- =============================================================================
-- Migración 37 — Servicios / Planes de Internet
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 36.
-- Es idempotente, con una salvedad que vale la pena conocer: rehace dos vistas
-- definidas con `*` —`v_planes` y `v_clientes_ficha`— y de ellas cuelgan otras
-- catorce creadas después. Volver a correrla las fotografía, las suelta con
-- CASCADE y las devuelve con sus opciones, permisos y comentarios; la sección 7
-- comprueba que ninguna haya perdido el filtro de RLS por el camino.
--
-- Efecto secundario buscado: al rehacerse, las vistas con `*` incorporan las
-- columnas que las tablas ganaron después. Una instalación nueva y una migrada
-- terminan con el mismo esquema, que es lo que antes no pasaba.
--
-- El plan era hasta ahora un dato técnico: dos velocidades y un precio. Pero es
-- la única cosa del sistema que toca las dos mitades del negocio a la vez —lo
-- que el abonado contrata y lo que el equipo aplica— y esa doble naturaleza no
-- estaba escrita en ningún lado.
--
-- Lo que falta y esta migración agrega:
--
-- 1. **Lo comercial.** Categoría y, sobre todo, cómo se comporta el IVA. Hoy el
--    indicador vive solo en la ficha del abonado, así que al dar de alta a
--    alguien hay que acordarse de ponerlo: el plan se vende "con IVA incluido"
--    pero eso no está escrito en el plan. El primero que se olvida factura mal.
--
-- 2. **A qué routers llega.** Un plan existe en la base, pero para que un
--    abonado PPPoE lo tenga hace falta que el perfil exista EN el equipo. Sin
--    registrar dónde se aprovisionó, la única forma de saberlo es entrar router
--    por router.
--
-- 3. **El total a facturar, calculado.** Un precio de 25 con IVA incluido y uno
--    de 25 más IVA son dos productos distintos y en el listado se veían igual.
--
-- Una decisión que NO se toma acá: el impuesto del abonado sigue mandando sobre
-- el del plan. El plan trae el valor por defecto —de dónde sale la venta— y la
-- ficha puede desviarse, porque hay abonados exentos y no por eso se les cambia
-- el plan.
-- =============================================================================


-- =============================================================================
-- 1. Datos comerciales del plan
-- =============================================================================
ALTER TABLE planes_velocidad
    ADD COLUMN IF NOT EXISTS categoria VARCHAR(15) NOT NULL DEFAULT 'residencial',

    -- Cómo se comporta el IVA sobre el precio. Los mismos tres modos que ya
    -- entiende la facturación, para no inventar un cuarto vocabulario.
    ADD COLUMN IF NOT EXISTS tipo_impuesto VARCHAR(10) NOT NULL DEFAULT 'incluido',
    ADD COLUMN IF NOT EXISTS iva_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 15
        CHECK (iva_porcentaje >= 0 AND iva_porcentaje <= 100),

    -- Lo que se le dice al cliente y lo que puede ir en el detalle de la
    -- factura.
    ADD COLUMN IF NOT EXISTS descripcion TEXT,

    /**
     * Quién controla el caudal de los abonados PPPoE de este plan.
     *
     * En fibra lo normal es la OLT, con su traffic table, y el perfil del
     * MikroTik queda sin rate-limit. Pero hay sectores donde el control se hace
     * en el router —una cabecera sin OLT, un nodo heredado, una OLT que no
     * soporta el caudal que se vende— y ahí el perfil sí tiene que limitar.
     *
     * Va en el plan y no en un ajuste global porque conviven: el mismo ISP
     * puede tener un plan de 300 controlado por la OLT en un nodo y otro
     * controlado por el router en otro.
     *
     * Los abonados con IP fija no dependen de esto: a ellos los limita su
     * Simple Queue, siempre en el MikroTik.
     */
    ADD COLUMN IF NOT EXISTS control_pppoe VARCHAR(10) NOT NULL DEFAULT 'olt',

    -- Un plan que se deja de vender no se borra: lo referencian los abonados
    -- que lo tienen y los contratos firmados. Se retira.
    ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN planes_velocidad.tipo_impuesto IS
    'incluido = el precio ya trae el IVA y se desglosa hacia atrás · mas = se le suma · ninguno = exento. Es el valor por defecto: la ficha del abonado puede desviarse.';

COMMENT ON COLUMN planes_velocidad.activo IS
    'Un plan retirado no se ofrece en las altas, pero sigue existiendo para los abonados que lo tienen. Borrarlo dejaría contratos apuntando a nada.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planes_categoria_check') THEN
        ALTER TABLE planes_velocidad ADD CONSTRAINT planes_categoria_check
            CHECK (categoria IN ('residencial', 'corporativo', 'otro'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planes_tipo_impuesto_check') THEN
        ALTER TABLE planes_velocidad ADD CONSTRAINT planes_tipo_impuesto_check
            CHECK (tipo_impuesto IN ('incluido', 'mas', 'ninguno'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planes_control_pppoe_check') THEN
        ALTER TABLE planes_velocidad ADD CONSTRAINT planes_control_pppoe_check
            CHECK (control_pppoe IN ('olt', 'mikrotik'));
    END IF;
END $$;

COMMENT ON COLUMN planes_velocidad.control_pppoe IS
    'olt = el caudal lo pone la traffic table y el perfil PPP va sin rate-limit · mikrotik = el perfil lleva el límite. Solo afecta a los abonados PPPoE; los de IP fija se limitan siempre con su Simple Queue.';


-- =============================================================================
-- 2. En qué routers está disponible el plan
-- =============================================================================
-- Un plan puede ofrecerse en unos nodos y no en otros —el de 500 megas no se
-- vende donde el enlace da 200— y el perfil PPP tiene que existir en cada
-- equipo donde se venda.
--
-- El estado del aprovisionamiento se guarda por router y no en el plan: que el
-- perfil se haya creado en tres de los cinco CCR es exactamente lo que hay que
-- poder ver.
CREATE TABLE IF NOT EXISTS plan_routers (
    plan_id   UUID NOT NULL REFERENCES planes_velocidad(id)  ON DELETE CASCADE,
    router_id UUID NOT NULL REFERENCES routers_mikrotik(id)  ON DELETE CASCADE,

    estado VARCHAR(12) NOT NULL DEFAULT 'pendiente'
           CHECK (estado IN ('pendiente', 'aplicado', 'error')),
    -- Cómo quedó el perfil en el equipo la última vez que se aprovisionó.
    perfil_aplicado VARCHAR(100),
    rate_limit      VARCHAR(100),
    aprovisionado_at TIMESTAMP WITH TIME ZONE,
    error TEXT,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (plan_id, router_id)
);

COMMENT ON TABLE plan_routers IS
    'Dónde está disponible cada plan y si su perfil PPP ya se creó en ese equipo. Sin esto, saber dónde se aprovisionó exige entrar router por router.';

COMMENT ON COLUMN plan_routers.rate_limit IS
    'El rate-limit con el que quedó el perfil. En FTTH va vacío a propósito: el caudal lo controla la OLT y un límite acá pelearía con ella.';

CREATE INDEX IF NOT EXISTS idx_plan_routers_router ON plan_routers (router_id);

ALTER TABLE plan_routers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_plan_routers" ON plan_routers;
CREATE POLICY "auth_all_plan_routers" ON plan_routers
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- 3. El plan con su precio desglosado
-- =============================================================================
-- El reparto del impuesto se calcula igual que en la facturación mensual: con
-- IVA incluido se desglosa hacia atrás, "más IVA" se suma, exento no lleva.
-- Duplicar la cuenta acá es a propósito — el listado de planes tiene que poder
-- mostrar el total sin pasar por el middleware— pero es la MISMA regla, y si
-- alguna cambia hay que cambiar las dos.
/**
 * Antes de recrear las vistas: guardar lo que cuelga de ellas y soltarlo.
 *
 * ── Por qué hace falta ──
 *
 * Esta migración rehace dos vistas que empiezan con `*`: `v_planes` con `p.*` y
 * `v_clientes_ficha` con `c.*`. Sus columnas son las que tengan las tablas EN EL
 * MOMENTO de crearlas, y las tablas siguieron creciendo: la 47 le agregó dos
 * columnas a `planes_velocidad`, y a `clientes` le fueron agregando desde la 59
 * hasta la 100.
 *
 * Por eso `CREATE OR REPLACE` no alcanza —las columnas nuevas se meterían en el
 * medio y Postgres rechaza el cambio— y un `DROP` a secas tampoco: de las dos
 * cuelgan otras vistas creadas DESPUÉS. De `v_planes`, catorce, hasta tres
 * niveles de profundidad: el módulo comercial entero y el desempeño técnico.
 *
 * La salida es soltarlas con CASCADE y volver a poner lo que se llevó puesto.
 *
 * ── Lo que NO se puede perder al rehacerlas ──
 *
 * `security_invoker`. Todas lo tienen, y es lo que hace que cada usuario vea
 * solo lo suyo: recrear una vista sin esa opción no la conserva, la BORRA, y
 * deja la cartera comercial abierta para cualquiera con sesión. Es exactamente
 * el agujero que abrió una recreación descuidada y que arregló la 89.
 *
 * Por eso la foto guarda cuatro cosas de cada vista —definición, opciones,
 * comentario y permisos— y al restaurarlas se comprueba una por una que la
 * opción haya vuelto.
 *
 * ── Por qué una tabla temporal y no una variable ──
 *
 * Porque la foto se toma antes de los `CREATE` y se restaura después, y entre
 * medio hay varias sentencias sueltas. Una tabla temporal vive lo que dure la
 * sesión del editor, que es exactamente lo que hace falta.
 */
DO $$
DECLARE
    v_rehechas TEXT[] := ARRAY['v_planes', 'v_clientes_ficha'];
    v_vista TEXT;
    v_cuantas INT;
BEGIN
    /**
     * Si esta migración ya corrió, no hay nada que rehacer.
     *
     * Y no es solo por ahorrar trabajo: `v_clientes_ficha` empieza con `c.*`, y
     * `clientes` ganó columnas después —entre ellas `portal_clave_hash`—.
     * Rehacerla ahora las metería a todas en la vista, así que reejecutar el
     * archivo terminaría publicando un hash de contraseña que hoy no se ve.
     *
     * Volver a correr una migración tiene que ser NO HACER NADA. Ese es el
     * único significado de idempotente que sirve.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'Las vistas de la 37 ya están puestas: no se tocan.';
        RETURN;
    END IF;

    DROP TABLE IF EXISTS _vistas_colgadas;
    CREATE TEMP TABLE _vistas_colgadas (
        orden       INT,
        vista       TEXT,
        definicion  TEXT,
        opciones    TEXT,
        comentario  TEXT,
        permisos    JSONB
    );

    FOREACH v_vista IN ARRAY v_rehechas LOOP
        CONTINUE WHEN to_regclass('public.' || v_vista) IS NULL;  -- primera vez

        -- Todo lo que cuelga de esta vista, directa o indirectamente. El nivel
        -- MÁXIMO de cada una es el orden en que hay que recrearlas: si B depende
        -- de A, todo camino hasta A se extiende hasta B con un paso más, así que
        -- B siempre queda después.
        INSERT INTO _vistas_colgadas (orden, vista, definicion, opciones, comentario, permisos)
        WITH RECURSIVE arbol AS (
            SELECT c.oid, c.relname::TEXT AS vista, 0 AS nivel
              FROM pg_class c
             WHERE c.relname = v_vista AND c.relkind = 'v'
            UNION ALL
            SELECT dep.oid, dep.relname::TEXT, a.nivel + 1
              FROM arbol a
              JOIN pg_depend d   ON d.refobjid = a.oid
              JOIN pg_rewrite rw ON rw.oid = d.objid
              JOIN pg_class dep  ON dep.oid = rw.ev_class AND dep.relkind = 'v'
             WHERE dep.oid <> a.oid
               AND a.nivel < 10          -- red de seguridad contra un ciclo
        )
        SELECT
            MAX(a.nivel),
            a.vista,
            pg_get_viewdef(a.oid, true),
            (SELECT array_to_string(c.reloptions, ', ') FROM pg_class c WHERE c.oid = a.oid),
            obj_description(a.oid, 'pg_class'),
            (SELECT jsonb_agg(jsonb_build_object('quien', g.grantee, 'que', g.privilege_type))
               FROM information_schema.role_table_grants g
              WHERE g.table_schema = 'public'
                AND g.table_name = a.vista
                AND g.grantee <> CURRENT_USER)
          FROM arbol a
         GROUP BY a.oid, a.vista;

        EXECUTE FORMAT('DROP VIEW %I CASCADE', v_vista);
    END LOOP;

    -- Las que esta migración vuelve a escribir por su cuenta no se restauran:
    -- para eso está el resto del archivo.
    DELETE FROM _vistas_colgadas WHERE vista = ANY(v_rehechas);

    SELECT COUNT(DISTINCT vista) INTO v_cuantas FROM _vistas_colgadas;
    IF v_cuantas > 0 THEN
        RAISE NOTICE 'Se van a rehacer % vistas que colgaban de v_planes y v_clientes_ficha.', v_cuantas;
    END IF;
END $$;

DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `precio_total`, la cadena siguió y esta versión quedó
     * atrás: la esta misma migracion la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_planes'
           AND column_name = 'precio_total'
    ) THEN
        RAISE NOTICE 'v_planes ya está en su versión de la esta misma migracion: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_planes WITH (security_invoker = true) AS
SELECT
    p.*,
    ROUND(p.bajada_kbps / 1000.0, 1) AS bajada_mbps,
    ROUND(p.subida_kbps / 1000.0, 1) AS subida_mbps,

    CASE p.tipo_impuesto
        WHEN 'incluido' THEN ROUND(p.precio / (1 + p.iva_porcentaje / 100), 2)
        ELSE ROUND(p.precio, 2)
    END AS precio_sin_iva,

    CASE p.tipo_impuesto
        WHEN 'ninguno'  THEN 0::NUMERIC
        WHEN 'incluido' THEN ROUND(p.precio - ROUND(p.precio / (1 + p.iva_porcentaje / 100), 2), 2)
        ELSE ROUND(p.precio * p.iva_porcentaje / 100, 2)
    END AS iva_valor,

    CASE p.tipo_impuesto
        WHEN 'mas' THEN ROUND(p.precio * (1 + p.iva_porcentaje / 100), 2)
        ELSE ROUND(p.precio, 2)
    END AS precio_total,

    COALESCE(u.abonados, 0)   AS abonados,
    COALESCE(u.activos, 0)    AS abonados_activos,
    COALESCE(r.routers, 0)    AS routers,
    COALESCE(r.aplicados, 0)  AS routers_aplicados
FROM planes_velocidad p
LEFT JOIN (
    SELECT plan_id,
           COUNT(*)                                       AS abonados,
           COUNT(*) FILTER (WHERE estado = 'activo')       AS activos
    FROM clientes
    WHERE plan_id IS NOT NULL AND estado <> 'baja'
    GROUP BY plan_id
) u ON u.plan_id = p.id
LEFT JOIN (
    SELECT plan_id,
           COUNT(*)                                        AS routers,
           COUNT(*) FILTER (WHERE estado = 'aplicado')      AS aplicados
    FROM plan_routers
    GROUP BY plan_id
) r ON r.plan_id = p.id
$vista$;
END $guarda$;


COMMENT ON VIEW v_planes IS
    'Planes con su precio desglosado (base, IVA y total a facturar), cuántos abonados los tienen y en cuántos routers está aprovisionado su perfil.';


/** Qué planes tiene cada router y cómo quedó el perfil. */
CREATE OR REPLACE VIEW v_plan_routers WITH (security_invoker = true) AS
SELECT
    pr.*,
    p.nombre     AS plan,
    p.perfil_ppp,
    p.bajada_kbps,
    p.subida_kbps,
    r.nombre     AS router,
    r.ip_host    AS router_ip
FROM plan_routers pr
LEFT JOIN planes_velocidad p  ON p.id = pr.plan_id
LEFT JOIN routers_mikrotik r  ON r.id = pr.router_id;


-- =============================================================================
-- 4. La ficha del abonado hereda el impuesto del plan
-- =============================================================================
-- `v_clientes_ficha` se rehace para exponer el tipo de impuesto y la tarifa del
-- plan al lado de los del cliente. La generación mensual usa el del cliente si
-- está y el del plan si no: el plan trae de dónde sale la venta y la ficha
-- puede desviarse para un abonado exento.
--
-- Se suelta y se rehace porque está definida con `c.*`: un CREATE OR REPLACE
-- fallaría al cambiar la lista de columnas.
--
-- El `DROP` no está acá: lo hace el bloque de la sección 3, con CASCADE, después
-- de fotografiar todo lo que cuelga. Soltarla suelta —como estaba— falla en
-- cuanto alguien creó una vista encima, que es lo que hicieron la 73 y la 76.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `plan_tipo_impuesto`, la cadena siguió y esta versión quedó
     * atrás: la esta misma migracion la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'plan_tipo_impuesto'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya está en su versión de la esta misma migracion: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS
SELECT
    c.*,
    p.nombre  AS plan,
    p.precio  AS plan_precio,
    p.bajada_kbps,
    p.subida_kbps,
    p.categoria      AS plan_categoria,
    p.tipo_impuesto  AS plan_tipo_impuesto,
    p.iva_porcentaje AS plan_iva_porcentaje,
    p.perfil_ppp     AS plan_perfil_ppp,
    r.nombre  AS router,
    o.sn      AS onu_serial,
    o.estado  AS onu_estado,
    o.rx_power_dbm,
    nap.nombre AS nap,
    ap.nombre  AS conectado_a,
    COALESCE(s.saldo, 0)               AS saldo,
    COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
    s.ultimo_pago,
    ct.id     AS contrato_id,
    ct.numero AS contrato_numero,
    ct.precio_mensual AS contrato_precio
FROM clientes c
LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
LEFT JOIN routers_mikrotik r   ON r.id = c.router_id
LEFT JOIN onus o               ON o.id = c.onu_id
LEFT JOIN puntos_red nap       ON nap.id = c.nap_id
LEFT JOIN puntos_red ap        ON ap.id = c.conectado_a_id
LEFT JOIN v_saldo_clientes s   ON s.client_id = c.id
LEFT JOIN contratos ct         ON ct.client_id = c.id AND ct.estado = 'vigente'
$vista$;
END $guarda$;


-- =============================================================================
-- 5. Lo que ya estaba cargado
-- =============================================================================
-- Los planes existentes quedan como residenciales con IVA incluido, que es como
-- se venían facturando: `repartirImpuesto` ya usaba 'incluido' cuando el
-- abonado no tenía nada puesto. No cambia ninguna factura.
--
-- Y los routers: si un plan ya tenía perfil_ppp cargado, se lo da por
-- disponible en todos los equipos activos, en estado 'pendiente'. Pendiente y
-- no 'aplicado' a propósito — que el nombre esté escrito no prueba que el
-- perfil exista en el equipo, y darlo por aplicado sin verificarlo es
-- exactamente la clase de suposición que deja abonados sin límite.
INSERT INTO plan_routers (plan_id, router_id, estado)
SELECT p.id, r.id, 'pendiente'
  FROM planes_velocidad p
 CROSS JOIN routers_mikrotik r
 WHERE p.perfil_ppp IS NOT NULL
   AND r.activo
ON CONFLICT (plan_id, router_id) DO NOTHING;


-- =============================================================================
-- 7. Se devuelve lo que colgaba
-- =============================================================================
-- Va al final del archivo, y no pegado al `CREATE` de `v_planes`, porque entre
-- las vistas que hay que restaurar hay varias que leen `v_clientes_ficha` —la
-- bandeja de cobranza y las notificaciones—. Restaurarlas antes de que la
-- sección 4 la vuelva a crear falla con "relation does not exist".
--
-- La regla es simple: primero todo lo que esta migración escribe, y al final lo
-- que había encima.

/**
 * Y ahora se devuelve todo lo que colgaba, en orden.
 *
 * Cada vista se recrea con su definición, sus opciones —`security_invoker` entre
 * ellas, que es lo que no se puede perder—, su comentario y sus permisos. Todo
 * en una sola sentencia por vista: crearla y arreglarle la opción después
 * dejaría un instante con la vista sin filtro, y aunque esto corre dentro de una
 * transacción no hay razón para escribirlo mal.
 *
 * La comprobación va acá adentro, vista por vista, y no en una lista escrita a
 * mano más abajo: una lista se desactualiza en cuanto alguien agrega una vista
 * nueva encima de estas, y entonces deja de mirar justo lo que habría que mirar.
 */
DO $$
DECLARE
    r RECORD;
    g RECORD;
    v_opcion TEXT;
    v_sin_filtro TEXT[] := ARRAY[]::TEXT[];
    v_cuantas INT := 0;
BEGIN
    IF to_regclass('_vistas_colgadas') IS NULL THEN
        RETURN;  -- primera vez: no había nada colgando
    END IF;

    FOR r IN
        SELECT vista, MAX(orden) AS orden,
               MAX(definicion) AS definicion, MAX(opciones) AS opciones,
               MAX(comentario) AS comentario, MAX(permisos::TEXT)::JSONB AS permisos
          FROM _vistas_colgadas
         GROUP BY vista
         ORDER BY MAX(orden), vista
    LOOP
        EXECUTE FORMAT(
            'CREATE VIEW %I %s AS %s',
            r.vista,
            CASE WHEN COALESCE(r.opciones, '') <> '' THEN 'WITH (' || r.opciones || ')' ELSE '' END,
            r.definicion
        );

        IF r.comentario IS NOT NULL THEN
            EXECUTE FORMAT('COMMENT ON VIEW %I IS %L', r.vista, r.comentario);
        END IF;

        FOR g IN SELECT * FROM jsonb_to_recordset(COALESCE(r.permisos, '[]'::JSONB))
                              AS x(quien TEXT, que TEXT)
        LOOP
            EXECUTE FORMAT('GRANT %s ON %I TO %I', g.que, r.vista, g.quien);
        END LOOP;

        -- ¿Volvió con el filtro puesto? Se pregunta por la que se acaba de
        -- crear, no por lo que se creía haber escrito.
        IF r.opciones LIKE '%security_invoker=true%' THEN
            SELECT COALESCE(
                     (SELECT option_value FROM pg_class c,
                             pg_options_to_table(c.reloptions)
                       WHERE c.relname = r.vista AND c.relkind = 'v'
                         AND option_name = 'security_invoker'), 'off')
              INTO v_opcion;
            IF v_opcion <> 'true' THEN
                v_sin_filtro := v_sin_filtro || r.vista;
            END IF;
        END IF;

        v_cuantas := v_cuantas + 1;
    END LOOP;

    DROP TABLE _vistas_colgadas;

    IF array_length(v_sin_filtro, 1) IS NULL THEN
        RAISE NOTICE 'COMPROBADO: las % vistas volvieron con sus opciones y permisos.', v_cuantas;
    ELSE
        RAISE WARNING 'PELIGRO: estas vistas quedaron SIN filtro de RLS: %. Corré: ALTER VIEW <nombre> SET (security_invoker = true);',
              array_to_string(v_sin_filtro, ', ');
    END IF;
END $$;
