-- =============================================================================
-- Migración 68 — Dashboard comercial: cobertura, seguimientos, metas y puntaje
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_prospectos` y
-- `v_comercial_vendedor` se redefinió en la 81 y la 102, con más columnas.
-- Reemplazar esa versión por la de acá dejaría a las pantallas sin lo que hoy
-- usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- Requiere la 67 (prospectos, actividades, cotizaciones, zonas).
--
-- La 67 dejó el embudo. Esto es lo que hace que el embudo le SIRVA al vendedor:
-- que la pantalla le diga qué hacer hoy, a quién llamar primero y cuánto le
-- falta para la meta — en vez de darle una lista y que él deduzca.
--
-- ── Lo que se apoya en lo que ya existe ──
--
-- La verificación de cobertura NO reimplementa nada. `cobertura_cercana(lat,
-- lng)` ya existe desde la migración 31: devuelve las cajas más cercanas con su
-- capacidad y sus puertos libres, y descuenta los que ya reservaron
-- instalaciones agendadas. Y `puntos_red` ya guarda `olt_id`, `puerto_pon` y
-- `slot`. Toda la cadena OLT → PON → NAP → puerto sale de ahí; acá solo se
-- guarda el resultado de haber preguntado.
-- =============================================================================


-- =============================================================================
-- 1. Verificación de cobertura
-- =============================================================================
-- Alguien pregunta "¿llega a mi casa?". Eso pasa antes de que exista el
-- prospecto —muchas veces la respuesta es no y nunca llega a existir— y por eso
-- es una tabla propia y no un campo del prospecto.
--
-- Se guarda cada consulta, no solo la última. La misma dirección puede dar "sin
-- cobertura" en marzo y "disponible" en julio porque se tendió la manzana; el
-- historial es lo que permite volver a llamar a los que se dijo que no.
CREATE TABLE IF NOT EXISTS verificaciones_cobertura (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    direccion     TEXT NOT NULL,
    sector        VARCHAR(100),
    referencia    TEXT,
    latitud       NUMERIC(10, 7),
    longitud      NUMERIC(10, 7),

    -- El resultado, en el vocabulario del vendedor:
    --   disponible          → hay caja cerca con puerto libre. Se vende hoy.
    --   requiere_verificacion → hay red cerca pero falta que alguien confirme
    --                           (caja sin capacidad cargada, o al límite).
    --   sin_cobertura       → no hay nada al alcance.
    -- `con_obra` es un cuarto valor a propósito: existe en
    -- `instalaciones.factibilidad` desde antes, y perderlo obligaría a traducir
    -- en los dos sentidos cada vez que un prospecto se convierte en instalación.
    resultado     VARCHAR(22) NOT NULL DEFAULT 'requiere_verificacion',

    -- ── La cadena de red, para cuando el resultado es "disponible" ──
    -- Se llenan con lo que devolvió `cobertura_cercana`. Son punteros vivos: si
    -- mañana la caja se llena, la consulta de hoy sigue diciendo cuál era.
    nap_id        UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    olt_id        UUID REFERENCES olts(id)       ON DELETE SET NULL,
    puerto_pon    VARCHAR(20),
    puerto_nap    VARCHAR(20),
    distancia_m   INT CHECK (distancia_m IS NULL OR distancia_m >= 0),

    -- La foto del momento. La caja de hoy puede estar llena en dos semanas, y
    -- entonces "por qué le prometimos que había lugar" se responde con esto.
    capacidad     INT,
    disponibles   INT,

    tecnologia    VARCHAR(10) NOT NULL DEFAULT 'ftth',
    notas         TEXT,

    prospecto_id  UUID REFERENCES prospectos(id) ON DELETE SET NULL,
    verificado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT verificaciones_resultado_check CHECK (resultado IN (
        'disponible', 'con_obra', 'requiere_verificacion', 'sin_cobertura'
    )),
    CONSTRAINT verificaciones_tecnologia_check CHECK (tecnologia IN ('ftth', 'wireless'))
);

CREATE INDEX IF NOT EXISTS idx_verificaciones_fecha  ON verificaciones_cobertura (creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_verificaciones_sector ON verificaciones_cobertura (sector);
CREATE INDEX IF NOT EXISTS idx_verificaciones_geo    ON verificaciones_cobertura (latitud, longitud)
    WHERE latitud IS NOT NULL;

COMMENT ON TABLE verificaciones_cobertura IS
    'Cada vez que se preguntó si llega el servicio a una dirección, y qué se respondió.';


-- =============================================================================
-- 2. Seguimientos
-- =============================================================================
-- `prospecto_actividades` nació registrando lo que YA pasó. Un seguimiento es lo
-- que HAY que hacer: tiene fecha, hora y un estado que se cierra. Son la misma
-- cosa en dos momentos —"llamar el martes" se convierte en "llamé el martes"— y
-- por eso viven en la misma tabla en vez de en dos que habría que cruzar para
-- armar el historial de un prospecto.
ALTER TABLE prospecto_actividades
    -- Cuándo hay que hacerlo. NULL = es un registro de algo ya hecho.
    ADD COLUMN IF NOT EXISTS programado_para TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS proxima_accion  TEXT,
    ADD COLUMN IF NOT EXISTS estado          VARCHAR(12) NOT NULL DEFAULT 'completado',
    ADD COLUMN IF NOT EXISTS completado_en   TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospecto_actividades_estado_check') THEN
        ALTER TABLE prospecto_actividades ADD CONSTRAINT prospecto_actividades_estado_check
            CHECK (estado IN ('pendiente', 'completado', 'cancelado'));
    END IF;
END $$;

-- "Vencido" NO se guarda: se calcula.
--
-- Un estado almacenado exigiría una tarea programada que a medianoche recorra la
-- tabla y dé vuelta las filas. Esa tarea se cae un día, nadie se entera, y el
-- tablero muestra como pendiente lo que hace una semana está vencido —
-- exactamente el dato en el que el vendedor confía para saber qué se le está
-- escapando. Calculado, no puede desincronizarse.
CREATE INDEX IF NOT EXISTS idx_actividades_agenda
    ON prospecto_actividades (programado_para)
    WHERE estado = 'pendiente';

DROP VIEW IF EXISTS v_seguimientos;
CREATE VIEW v_seguimientos WITH (security_invoker = true) AS
SELECT
    a.*,
    p.nombre        AS prospecto,
    p.telefono,
    p.telefono_whatsapp,
    p.sector,
    p.estado        AS estado_prospecto,
    p.vendedor_id,
    CASE
        WHEN a.estado <> 'pendiente' THEN a.estado
        WHEN a.programado_para IS NULL THEN 'pendiente'
        WHEN a.programado_para < NOW() THEN 'vencido'
        ELSE 'pendiente'
    END AS estado_efectivo,
    (a.programado_para::DATE = CURRENT_DATE) AS es_de_hoy
FROM prospecto_actividades a
JOIN prospectos p ON p.id = a.prospecto_id;

COMMENT ON VIEW v_seguimientos IS
    'Los seguimientos con su estado real. "vencido" se calcula: un estado guardado se desincroniza.';


-- =============================================================================
-- 3. Metas de venta
-- =============================================================================
-- Sin meta no se puede responder "cuánto me falta", que es la mitad de lo que el
-- vendedor viene a mirar. Se guarda por mes y por vendedor: una meta anual no
-- sirve para saber cómo va la semana.
--
-- `vendedor_id` NULL = la meta del equipo. Permite tener el número global aunque
-- todavía no se repartió por persona.
CREATE TABLE IF NOT EXISTS metas_venta (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendedor_id UUID REFERENCES usuarios_sistema(id) ON DELETE CASCADE,
    anio        SMALLINT NOT NULL,
    mes         SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),

    -- Las dos formas de medir a un vendedor de ISP. Se guardan las dos porque
    -- responden cosas distintas: veinte altas de plan chico no es lo mismo que
    -- cinco corporativas, y el dueño mira una u otra según el mes.
    meta_altas  INT     NOT NULL DEFAULT 0 CHECK (meta_altas >= 0),
    meta_monto  NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (meta_monto >= 0),

    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una sola meta por vendedor y mes. El índice trata el NULL del equipo como un
-- valor: sin esto, `UNIQUE` deja cargar diez metas de equipo para el mismo mes,
-- porque en SQL NULL nunca es igual a NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_metas_venta_unica
    ON metas_venta (COALESCE(vendedor_id, '00000000-0000-0000-0000-000000000000'::UUID), anio, mes);


-- =============================================================================
-- 4. El puntaje de conversión
-- =============================================================================
-- "Qué prospectos tienen mayor posibilidad de convertirse", calculado con lo que
-- el sistema ya sabe. No hay nada aprendido ni estimado: son cinco señales
-- observables, cada una con su peso, sumadas.
--
-- Se calcula en la vista y no en el navegador por dos razones: se ordena por él
-- —y ordenar en el cliente obliga a traer los 500 prospectos para mostrar 10— y
-- así el número es el mismo en la pantalla, en un reporte y en cualquier
-- consulta que alguien haga mañana.
--
-- Cada señal deja su motivo en `motivos_puntaje`. Un número sin explicación no
-- lo usa nadie: el vendedor tiene que poder ver por qué este está primero, y
-- discrepar cuando el sistema se equivoca.
-- El resumen por vendedor se apoya en esta vista, así que hay que bajarlo antes
-- de reemplazarla. Sin esta línea el archivo funciona la primera vez y falla la
-- segunda con "cannot drop view because other objects depend on it" — que es la
-- peor clase de migración: la que parece idempotente hasta que no lo es.
DROP VIEW IF EXISTS v_comercial_vendedor;
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `plan_precio_neto`, la cadena siguió y esta versión quedó
     * atrás: la 81 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_prospectos'
           AND column_name = 'plan_precio_neto'
    ) THEN
        RAISE NOTICE 'v_prospectos ya está en su versión de la 81: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_prospectos';
    EXECUTE $vista$
CREATE VIEW v_prospectos WITH (security_invoker = true) AS
WITH base AS (
    SELECT
        p.*,
        pl.nombre  AS plan,
        pl.precio  AS plan_precio,
        TRIM(CONCAT(v.nombre, ' ', v.apellido)) AS vendedor,
        n.nombre   AS nap,

        (SELECT COUNT(*) FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'completado') AS actividades,
        (SELECT MAX(a.creado_en) FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'completado') AS ultima_actividad,
        (SELECT a.resultado FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'completado'
          ORDER BY a.creado_en DESC LIMIT 1) AS ultimo_resultado,
        (SELECT COUNT(*) FROM cotizaciones c WHERE c.prospecto_id = p.id) AS cotizaciones,
        -- Lo que vale esta oportunidad: lo cotizado manda sobre el precio de
        -- lista, porque es el número que el cliente tiene en la mano.
        COALESCE(
            (SELECT c.precio_mensual FROM cotizaciones c
              WHERE c.prospecto_id = p.id ORDER BY c.creado_en DESC LIMIT 1),
            pl.precio, 0
        ) AS valor_mensual,
        (SELECT COUNT(*) FROM prospecto_actividades a
          WHERE a.prospecto_id = p.id AND a.estado = 'pendiente'
            AND a.programado_para < NOW()) AS seguimientos_vencidos
    FROM prospectos p
    LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
    LEFT JOIN usuarios_sistema  v ON v.id  = p.vendedor_id
    LEFT JOIN puntos_red        n ON n.id  = p.nap_id
),
senales AS (
    SELECT
        b.*,
        EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en))::INT AS dias_sin_contacto,

        -- 1. En qué etapa está. Es la señal más fuerte: alguien negociando
        --    precio está mucho más cerca que alguien que recién llamó.
        CASE b.estado WHEN 'negociacion' THEN 40 WHEN 'cotizado' THEN 30
                      WHEN 'contactado' THEN 15 WHEN 'nuevo' THEN 5 ELSE 0 END AS pt_etapa,

        -- 2. Si le llega el servicio. Un prospecto entusiasmado fuera de
        --    cobertura vale cero, por más que haya dicho que sí a todo.
        CASE b.cobertura WHEN 'factible' THEN 25 WHEN 'con_obra' THEN 10
                         WHEN 'no_factible' THEN -40 ELSE 0 END AS pt_cobertura,

        -- 3. Qué dijo la última vez.
        CASE b.ultimo_resultado WHEN 'interesado' THEN 15 WHEN 'contactado' THEN 5
                                WHEN 'no_contesta' THEN -5 WHEN 'no_interesado' THEN -30
                                ELSE 0 END AS pt_resultado,

        -- 4. Si ya tiene el precio en la mano.
        CASE WHEN b.cotizaciones > 0 THEN 15 ELSE 0 END AS pt_cotizacion,

        -- 5. Qué tan fresco está. Un prospecto que se enfría pierde valor
        --    aunque todo lo demás siga igual: eso es lo que pasa de verdad.
        CASE
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 2 THEN 10
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 5 THEN 5
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 10 THEN 0
            WHEN EXTRACT(DAY FROM NOW() - COALESCE(b.ultima_actividad, b.creado_en)) <= 20 THEN -10
            ELSE -20
        END AS pt_frescura
    FROM base b
)
SELECT
    s.*,
    -- Cerrado el trato, el puntaje no significa nada: se fuerza a 0 para que los
    -- ganados y perdidos no ensucien la lista de "a quién llamar".
    CASE WHEN s.estado IN ('ganado', 'perdido') THEN 0
         ELSE GREATEST(0, LEAST(100,
             s.pt_etapa + s.pt_cobertura + s.pt_resultado + s.pt_cotizacion + s.pt_frescura))
    END AS puntaje,

    -- Por qué. En el orden en que pesan.
    ARRAY_REMOVE(ARRAY[
        CASE WHEN s.pt_etapa      >= 30 THEN 'Etapa avanzada' END,
        CASE WHEN s.pt_cobertura  >= 25 THEN 'Tiene cobertura'
             WHEN s.pt_cobertura  <   0 THEN 'Fuera de cobertura' END,
        CASE WHEN s.pt_cotizacion >   0 THEN 'Ya cotizado' END,
        CASE WHEN s.pt_resultado  >   0 THEN 'Se mostró interesado'
             WHEN s.pt_resultado  <   0 THEN 'Última respuesta fría' END,
        CASE WHEN s.pt_frescura   >   0 THEN 'Contacto reciente'
             WHEN s.pt_frescura   <   0 THEN 'Se está enfriando' END,
        CASE WHEN s.seguimientos_vencidos > 0 THEN 'Tiene seguimientos vencidos' END
    ], NULL) AS motivos_puntaje
FROM senales s
$vista$;
END $guarda$;


-- =============================================================================
-- 5. Cómo va cada vendedor este mes
-- =============================================================================
-- Junta en una fila lo vendido, lo que falta y lo que hay en juego. Se calcula
-- acá y no sumando en el navegador para que el número sea el mismo en la
-- pantalla del vendedor, en la del dueño y en cualquier reporte.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `comision_nivel`, la cadena siguió y esta versión quedó
     * atrás: la 102 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_comercial_vendedor'
           AND column_name = 'comision_nivel'
    ) THEN
        RAISE NOTICE 'v_comercial_vendedor ya está en su versión de la 102: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_comercial_vendedor';
    EXECUTE $vista$
CREATE VIEW v_comercial_vendedor WITH (security_invoker = true) AS
SELECT
    u.id                                  AS vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', u.apellido)) AS vendedor,
    m.meta_altas,
    m.meta_monto,

    -- Vendido: los ganados de este mes. El monto es la mensualidad, que es como
    -- se mide una venta de ISP — no el primer pago.
    COUNT(p.id) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS altas_mes,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ), 0) AS monto_mes,

    -- En juego: lo abierto, sin ponderar. Ponderarlo por el puntaje daría un
    -- número más "correcto" y menos útil — el vendedor quiere saber cuánto hay
    -- sobre la mesa, no cuánto espera un modelo.
    COUNT(p.id) FILTER (WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')
    ), 0) AS monto_en_juego,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'perdido'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS perdidos_mes
FROM usuarios_sistema u
LEFT JOIN v_prospectos p ON p.vendedor_id = u.id
LEFT JOIN metas_venta  m ON m.vendedor_id = u.id
                        AND m.anio = EXTRACT(YEAR  FROM NOW())::SMALLINT
                        AND m.mes  = EXTRACT(MONTH FROM NOW())::SMALLINT
WHERE u.rol IN ('vendedor', 'supervisor', 'admin', 'super_admin')
GROUP BY u.id, u.nombre, u.apellido, m.meta_altas, m.meta_monto
$vista$;
END $guarda$;


-- =============================================================================
-- Seguridad
-- =============================================================================
ALTER TABLE verificaciones_cobertura ENABLE ROW LEVEL SECURITY;
ALTER TABLE metas_venta              ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['verificaciones_cobertura', 'metas_venta']
    LOOP
        EXECUTE FORMAT('DROP POLICY IF EXISTS %I_personal ON %I', t, t);
        EXECUTE FORMAT(
            'CREATE POLICY %I_personal ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            t, t
        );
    END LOOP;
END $$;
