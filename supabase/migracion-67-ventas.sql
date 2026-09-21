-- =============================================================================
-- Migración 67 — Ventas: prospectos, actividad, cotizaciones y cobertura
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_prospectos` se redefinió en
-- la 81, con más columnas. Reemplazar esa versión por la de acá dejaría a las
-- pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- El rol Vendedor existía con sus permisos, pero no había ninguna pantalla
-- detrás: al entrar veía el mapa de abonados y el catálogo de planes, que es
-- justo lo que un vendedor NO debería estar mirando. Esto es el módulo que
-- faltaba.
--
-- ── Prospecto no es lo mismo que instalación ──
--
-- `instalaciones` ya guarda un prospecto: nombre, teléfono y factibilidad de
-- alguien que todavía no es cliente. Se evaluó reusarla y no crear nada. Se
-- descartó, porque las dos tablas responden preguntas distintas:
--
--   `instalaciones` = un trabajo agendado. Existe cuando ya se decidió instalar
--   y alguien tiene que ir. Su pregunta es "¿quién va, cuándo, y de qué caja
--   cuelga?".
--
--   `prospectos` = alguien que preguntó. La mayoría nunca va a llegar a ser una
--   instalación, y ese es el punto: el vendedor necesita ver los que se
--   enfriaron, los que hay que volver a llamar y los que se perdieron, con el
--   motivo. Meter eso en `instalaciones` llenaría la agenda de los técnicos de
--   trabajos que nadie va a hacer.
--
-- Cuando el prospecto se gana, se crea su instalación y las dos quedan
-- vinculadas por `instalacion_id`. Ahí termina el trabajo del vendedor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- El prospecto
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prospectos (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    nombre              VARCHAR(150) NOT NULL,
    identificacion      VARCHAR(20),
    telefono            VARCHAR(30),
    telefono_whatsapp   VARCHAR(30),
    email               VARCHAR(200),

    direccion           TEXT,
    -- "Casa de dos pisos, portón verde". En un barrio sin nomenclatura es lo
    -- único con lo que después el técnico llega.
    referencia          TEXT,
    sector              VARCHAR(100),
    canton              VARCHAR(100),
    latitud             NUMERIC(10, 7),
    longitud            NUMERIC(10, 7),

    -- Qué pidió. Es el plan del catálogo, no un texto libre: el vendedor elige
    -- de lo que se vende, y así la cotización sale con el precio vigente.
    plan_id             UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,

    -- De dónde salió. Sin esto no se puede responder en qué conviene gastar:
    -- si los referidos cierran el triple que las redes, eso cambia el mes.
    origen              VARCHAR(20) NOT NULL DEFAULT 'otro',

    -- El embudo. "Oportunidad" no es una tabla aparte: es el prospecto parado
    -- en una de estas etapas. Separarlas obliga a mantener sincronizadas dos
    -- filas que siempre dicen lo mismo.
    estado              VARCHAR(15) NOT NULL DEFAULT 'nuevo',
    motivo_perdida      TEXT,

    -- Quién lo atiende. Es el legajo, no el técnico: un prospecto se le asigna
    -- a un vendedor.
    vendedor_id         UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    -- Factibilidad. Se copia el vocabulario de `instalaciones` a propósito: es
    -- la misma pregunta hecha antes, y al ganar el prospecto el valor se
    -- traslada sin traducir.
    cobertura           VARCHAR(15) NOT NULL DEFAULT 'pendiente',
    nap_id              UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    distancia_nodo_m    INT CHECK (distancia_nodo_m IS NULL OR distancia_nodo_m >= 0),

    -- Cuándo hay que volver a llamarlo. Es la columna que ordena el día del
    -- vendedor; sin ella la lista es un montón y no una agenda.
    proxima_accion      DATE,

    -- A dónde fue a parar cuando se ganó.
    instalacion_id      UUID REFERENCES instalaciones(id) ON DELETE SET NULL,
    cliente_id          UUID REFERENCES clientes(id)      ON DELETE SET NULL,

    notas               TEXT,
    creado_por          UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT prospectos_estado_check CHECK (estado IN (
        'nuevo', 'contactado', 'cotizado', 'negociacion', 'ganado', 'perdido'
    )),
    CONSTRAINT prospectos_origen_check CHECK (origen IN (
        'referido', 'redes', 'llamada', 'visita', 'local', 'web', 'otro'
    )),
    CONSTRAINT prospectos_cobertura_check CHECK (cobertura IN (
        'pendiente', 'factible', 'con_obra', 'no_factible'
    )),
    -- Un prospecto perdido sin motivo no enseña nada: dentro de dos meses nadie
    -- va a poder decir por qué se caen las ventas.
    CONSTRAINT prospectos_perdido_con_motivo CHECK (
        estado <> 'perdido' OR NULLIF(BTRIM(COALESCE(motivo_perdida, '')), '') IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_prospectos_estado   ON prospectos (estado, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_prospectos_vendedor ON prospectos (vendedor_id, estado);
CREATE INDEX IF NOT EXISTS idx_prospectos_agenda   ON prospectos (proxima_accion)
    WHERE estado NOT IN ('ganado', 'perdido');

COMMENT ON TABLE prospectos IS
    'Alguien que preguntó por el servicio. Al ganarse se convierte en instalación.';

-- -----------------------------------------------------------------------------
-- Lo que se hizo con cada uno
-- -----------------------------------------------------------------------------
-- Llamadas, visitas y mensajes. Es lo que distingue "no contesta desde hace tres
-- semanas" de "recién lo llamé": sin el registro, los dos se ven igual en la
-- lista y el vendedor vuelve a llamar al que ya dijo que no.
CREATE TABLE IF NOT EXISTS prospecto_actividades (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospecto_id   UUID NOT NULL REFERENCES prospectos(id) ON DELETE CASCADE,

    tipo           VARCHAR(15) NOT NULL,
    resultado      VARCHAR(20),
    detalle        TEXT,

    -- Se guarda el nombre además del id, por lo mismo que en la auditoría: el
    -- renglón tiene que seguir siendo legible si el vendedor deja la empresa.
    usuario_id     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    usuario_nombre VARCHAR(140),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT prospecto_actividades_tipo_check CHECK (tipo IN (
        'llamada', 'visita', 'whatsapp', 'correo', 'nota'
    )),
    CONSTRAINT prospecto_actividades_resultado_check CHECK (resultado IS NULL OR resultado IN (
        'contactado', 'no_contesta', 'reagendar', 'interesado', 'no_interesado'
    ))
);

CREATE INDEX IF NOT EXISTS idx_prospecto_actividades
    ON prospecto_actividades (prospecto_id, creado_en DESC);

-- -----------------------------------------------------------------------------
-- Cotizaciones
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotizaciones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    numero          BIGSERIAL,
    prospecto_id    UUID NOT NULL REFERENCES prospectos(id) ON DELETE CASCADE,

    -- El plan y su precio se copian al cotizar. No se leen del catálogo al
    -- mostrar: si mañana sube la tarifa, la cotización que el cliente tiene en
    -- la mano no puede cambiar sola.
    plan_id         UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,
    plan_nombre     VARCHAR(120),
    precio_mensual  NUMERIC(12, 2) NOT NULL DEFAULT 0,
    costo_instalacion NUMERIC(12, 2) NOT NULL DEFAULT 0,
    costo_equipo    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    descuento       NUMERIC(12, 2) NOT NULL DEFAULT 0,
    meses_contrato  SMALLINT,

    validez_dias    SMALLINT NOT NULL DEFAULT 15,
    estado          VARCHAR(12) NOT NULL DEFAULT 'borrador',
    notas           TEXT,

    creado_por      UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT cotizaciones_estado_check CHECK (estado IN (
        'borrador', 'enviada', 'aceptada', 'rechazada', 'vencida'
    )),
    CONSTRAINT cotizaciones_montos_no_negativos CHECK (
        precio_mensual >= 0 AND costo_instalacion >= 0 AND costo_equipo >= 0 AND descuento >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_cotizaciones_prospecto ON cotizaciones (prospecto_id, creado_en DESC);

-- -----------------------------------------------------------------------------
-- Zonas de cobertura
-- -----------------------------------------------------------------------------
-- Dónde llega el servicio, dibujado a mano.
--
-- Complementa a las cajas NAP, que dicen dónde llega HOY con puerto libre. La
-- zona dice hasta dónde se vende: incluye la manzana a la que todavía no se
-- tendió pero está en el plan del mes. El vendedor necesita las dos —una para
-- prometer y otra para saber si es inmediato— y por eso el mapa las muestra
-- juntas y distinguidas.
CREATE TABLE IF NOT EXISTS zonas_cobertura (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      VARCHAR(120) NOT NULL,
    tipo        VARCHAR(10)  NOT NULL DEFAULT 'circulo',
    tecnologia  VARCHAR(10)  NOT NULL DEFAULT 'ftth',

    -- Círculo: centro y radio. Es lo que se dibuja en treinta segundos sobre un
    -- barrio, y alcanza para la mayoría de los casos.
    centro_lat  NUMERIC(10, 7),
    centro_lng  NUMERIC(10, 7),
    radio_m     INT CHECK (radio_m IS NULL OR radio_m > 0),

    -- Polígono: [[lat, lng], ...]. Para cuando el límite sigue una calle o un
    -- río y el círculo prometería del otro lado.
    poligono    JSONB,

    color       VARCHAR(7) NOT NULL DEFAULT '#0ea5e9',
    activa      BOOLEAN NOT NULL DEFAULT TRUE,
    notas       TEXT,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT zonas_cobertura_tipo_check CHECK (tipo IN ('circulo', 'poligono')),
    CONSTRAINT zonas_cobertura_tecnologia_check CHECK (tecnologia IN ('ftth', 'wireless', 'ambas')),
    -- Una zona sin geometría no se puede dibujar, y una fila que no se dibuja
    -- es una zona que el vendedor cree que existe y no ve en el mapa.
    CONSTRAINT zonas_cobertura_tiene_forma CHECK (
        (tipo = 'circulo'  AND centro_lat IS NOT NULL AND centro_lng IS NOT NULL AND radio_m IS NOT NULL)
     OR (tipo = 'poligono' AND jsonb_typeof(poligono) = 'array' AND jsonb_array_length(poligono) >= 3)
    )
);

COMMENT ON TABLE zonas_cobertura IS
    'Hasta dónde se vende. Las cajas NAP dicen dónde hay puerto libre hoy; esto, hasta dónde se promete.';

-- -----------------------------------------------------------------------------
-- La vista del embudo
-- -----------------------------------------------------------------------------
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
SELECT
    p.*,
    pl.nombre                                   AS plan,
    pl.precio                                   AS plan_precio,
    TRIM(CONCAT(v.nombre, ' ', v.apellido))     AS vendedor,
    n.nombre                                    AS nap,

    (SELECT COUNT(*) FROM prospecto_actividades a WHERE a.prospecto_id = p.id) AS actividades,
    (SELECT MAX(a.creado_en) FROM prospecto_actividades a WHERE a.prospecto_id = p.id) AS ultima_actividad,
    (SELECT COUNT(*) FROM cotizaciones c WHERE c.prospecto_id = p.id) AS cotizaciones,

    -- Cuántos días hace que nadie lo toca. Es la columna por la que se ordena
    -- para encontrar lo que se está enfriando, que es donde se pierden las
    -- ventas que ya estaban.
    EXTRACT(DAY FROM NOW() - COALESCE(
        (SELECT MAX(a.creado_en) FROM prospecto_actividades a WHERE a.prospecto_id = p.id),
        p.creado_en
    ))::INT AS dias_sin_contacto
FROM prospectos p
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
LEFT JOIN usuarios_sistema  v ON v.id  = p.vendedor_id
LEFT JOIN puntos_red        n ON n.id  = p.nap_id
$vista$;
END $guarda$;

-- -----------------------------------------------------------------------------
-- Seguridad
-- -----------------------------------------------------------------------------
ALTER TABLE prospectos            ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospecto_actividades ENABLE ROW LEVEL SECURITY;
ALTER TABLE cotizaciones          ENABLE ROW LEVEL SECURITY;
ALTER TABLE zonas_cobertura       ENABLE ROW LEVEL SECURITY;

-- El personal con sesión trabaja estas tablas desde la pantalla. A diferencia
-- de `usuarios_sistema`, acá no hay ningún escalón de privilegio que proteger:
-- lo peor que puede hacer alguien es cargar un prospecto de más. Quién puede
-- abrir la pantalla ya lo decide el permiso `ventas.*`.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['prospectos', 'prospecto_actividades', 'cotizaciones', 'zonas_cobertura']
    LOOP
        EXECUTE FORMAT('DROP POLICY IF EXISTS %I_personal ON %I', t, t);
        EXECUTE FORMAT(
            'CREATE POLICY %I_personal ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            t, t
        );
    END LOOP;
END $$;
