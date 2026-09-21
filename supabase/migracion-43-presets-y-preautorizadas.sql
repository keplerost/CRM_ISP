-- =============================================================================
-- Migración 43 — Plantillas de autorización y ONTs cargadas por adelantado
-- =============================================================================
-- Dos tablas que resuelven la misma molestia desde lados opuestos.
--
-- Autorizar una ONT pide siempre los mismos seis datos: perfil de línea, perfil
-- de servicio, VLAN, gemport, plan y zona. De esos, cinco se repiten en todas
-- las altas de una zona y solo uno cambia. Escribirlos de memoria cada vez es
-- donde se cuela el error que nadie encuentra después: una VLAN mal tipeada deja
-- al abonado sin salida y desde el lado GPON se ve todo bien.
--
--   autorizacion_presets   guardan el CÓMO: el juego de datos que se repite
--   onts_preautorizadas    guardan el QUIÉN: la serie que todavía no llegó
--
-- La segunda es la que cambia el trabajo de verdad. Hoy alguien tiene que estar
-- mirando la pantalla cuando el técnico conecta la ONT. Cargándola de antemano,
-- el técnico conecta y el sistema la autoriza solo.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Plantillas de autorización
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS autorizacion_presets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre      VARCHAR(80) NOT NULL,

    -- NULL = sirve para cualquier OLT. Con OLT = solo para ésa.
    --
    -- La diferencia importa por los perfiles: sus IDs son de cada equipo, y el
    -- perfil 2 de una OLT no tiene por qué ser el perfil 2 de la otra. Por eso
    -- se guarda también el NOMBRE de cada perfil: una plantilla general se
    -- resuelve por nombre en la OLT donde se aplique, y si ahí no existe se
    -- avisa en vez de usar el número a ciegas.
    olt_id      UUID REFERENCES olts(id) ON DELETE CASCADE,

    line_profile_id     INT,
    line_profile_nombre VARCHAR(60),
    srv_profile_id      INT,
    srv_profile_nombre  VARCHAR(60),

    vlan        INT,
    gemport     INT DEFAULT 1,
    plan_id     UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,
    zona        VARCHAR(60),

    -- La que se ofrece marcada al abrir el formulario.
    predeterminado BOOLEAN NOT NULL DEFAULT FALSE,

    notas       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS autorizacion_presets_olt_idx ON autorizacion_presets (olt_id);

COMMENT ON TABLE autorizacion_presets IS
    'Juegos de datos de autorización que se repiten. Guardan también el nombre de cada perfil porque los IDs de perfil son de cada OLT: el perfil 2 de una no es el perfil 2 de la otra.';

COMMENT ON COLUMN autorizacion_presets.vlan IS
    'Se guarda a propósito, aunque el formulario suelto no la sugiera. La diferencia es que acá la persona la eligió una vez y le puso nombre; sugerirla suelta se acepta sin mirar.';


-- -----------------------------------------------------------------------------
-- 2. ONTs cargadas antes de que lleguen
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onts_preautorizadas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id      UUID NOT NULL REFERENCES olts(id) ON DELETE CASCADE,
    sn          VARCHAR(50) NOT NULL,

    preset_id   UUID REFERENCES autorizacion_presets(id) ON DELETE SET NULL,

    -- Copiados de la plantilla al momento de cargar la ONT, no leídos de ella
    -- después. Si alguien edita la plantilla en el medio, esta ONT tiene que
    -- entrar con lo que se decidió cuando se cargó, no con lo que la plantilla
    -- diga el día que el técnico conecte.
    nombre          VARCHAR(120),
    comentario      TEXT,
    plan_id         UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,
    vlan            INT,
    gemport         INT DEFAULT 1,
    line_profile_id INT,
    srv_profile_id  INT,

    -- Opcionales: dónde se espera que aparezca. Si se cargan, la autorización
    -- automática exige que coincida.
    slot        INT,
    puerto      INT,

    instalacion_id UUID REFERENCES instalaciones(id) ON DELETE SET NULL,

    -- Si está en false, cuando aparezca queda lista para autorizar con un clic
    -- pero no se toca el equipo sola.
    automatica  BOOLEAN NOT NULL DEFAULT TRUE,

    -- esperando | autorizada | fallada | cancelada
    estado      VARCHAR(20) NOT NULL DEFAULT 'esperando',
    intentos    INT NOT NULL DEFAULT 0,
    ultimo_error TEXT,

    -- Hasta cuándo tiene sentido esperarla. Una ONT cargada para una
    -- instalación que se canceló no puede quedar autorizándose sola seis meses
    -- después, cuando el equipo se revendió y aparece en la fibra de otro.
    vence_at    TIMESTAMPTZ,

    autorizada_at TIMESTAMPTZ,
    onu_id      UUID REFERENCES onus(id) ON DELETE SET NULL,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (olt_id, sn)
);

CREATE INDEX IF NOT EXISTS onts_preautorizadas_olt_idx ON onts_preautorizadas (olt_id);
CREATE INDEX IF NOT EXISTS onts_preautorizadas_estado_idx ON onts_preautorizadas (estado);
CREATE INDEX IF NOT EXISTS onts_preautorizadas_sn_idx ON onts_preautorizadas (sn);

COMMENT ON TABLE onts_preautorizadas IS
    'ONTs cargadas antes de estar conectadas. Cuando el barrido las encuentra en la fibra, se autorizan solas con los datos guardados acá.';

COMMENT ON COLUMN onts_preautorizadas.intentos IS
    'Cuántas veces se intentó autorizarla sola. Existe para que un alta que falla siempre no se reintente cada cinco minutos para siempre.';

COMMENT ON COLUMN onts_preautorizadas.estado IS
    '"fallada" no se reintenta sola: si el equipo la rechazó, repetir el mismo comando cada cinco minutos no la va a aceptar. Queda para que una persona lo mire.';


-- -----------------------------------------------------------------------------
-- 3. Vista para la pantalla
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_preautorizadas;
CREATE VIEW v_preautorizadas WITH (security_invoker = true) AS
SELECT
    p.*,
    o.nombre        AS olt,
    o.numero        AS olt_numero,
    pr.nombre       AS preset,
    pl.nombre       AS plan,
    i.nombre        AS instalacion_nombre,
    i.direccion     AS instalacion_direccion,
    -- Si ya está en la cola de la OLT, se puede autorizar ahora mismo.
    EXISTS (
        SELECT 1 FROM onts_esperando e
        WHERE e.olt_id = p.olt_id AND e.sn = p.sn
    ) AS ya_conectada,
    (p.vence_at IS NOT NULL AND p.vence_at < NOW()) AS vencida
FROM onts_preautorizadas p
JOIN olts o ON o.id = p.olt_id
LEFT JOIN autorizacion_presets pr ON pr.id = p.preset_id
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
LEFT JOIN instalaciones i ON i.id = p.instalacion_id;


-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
-- Explícito y fuera de cualquier bloque DO: el analizador de Supabase no lee
-- adentro de un EXECUTE y reporta las tablas como si quedaran sin RLS.

ALTER TABLE autorizacion_presets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE onts_preautorizadas   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_autorizacion_presets" ON autorizacion_presets;
CREATE POLICY "auth_all_autorizacion_presets" ON autorizacion_presets
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_all_onts_preautorizadas" ON onts_preautorizadas;
CREATE POLICY "auth_all_onts_preautorizadas" ON onts_preautorizadas
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
