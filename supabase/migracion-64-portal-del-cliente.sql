-- =============================================================================
-- Migración 64 — Portal del cliente
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- El abonado entra a ver sus facturas, reportar una falla y cambiar su clave
-- WiFi. Entra con su cédula y un código que le llega por WhatsApp: sin
-- contraseña que olvidar, que es de donde sale la mayoría de las llamadas a la
-- oficina en un portal.
--
-- ── La regla que gobierna todo este archivo ──
--
-- Un abonado NUNCA puede ver la cuenta de otro. Por eso ninguna de estas tablas
-- se lee desde el navegador: no hay políticas de lectura, y el `anon` de
-- Supabase no puede tocarlas. Todo pasa por el middleware, que resuelve de qué
-- cliente es la sesión y filtra por ese id — nunca por un id que mande el
-- navegador.
--
-- Confiar en un id que viene del cliente es la falla clásica de estos portales:
-- alcanza con cambiar un número en la URL para ver la factura del vecino.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Los códigos de un solo uso
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_codigos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    -- El código NO se guarda: se guarda su huella, calculada con la llave del
    -- servidor. Así, alguien que se lleve esta tabla no puede entrar con lo que
    -- encontró — le faltaría la llave, que vive en el .env y no en la base.
    codigo_hash VARCHAR(64) NOT NULL,

    -- Diez minutos. Suficiente para leer un WhatsApp y escribirlo; poco para
    -- que sirva un código que quedó viejo en una conversación.
    expira_en   TIMESTAMPTZ NOT NULL,

    -- Cuántas veces se erró. Sin esto, seis dígitos se adivinan probando: un
    -- millón de intentos es nada para un programa.
    intentos    SMALLINT NOT NULL DEFAULT 0,
    usado_en    TIMESTAMPTZ,

    -- Por dónde salió y a dónde. Sirve para explicarle a alguien que llama
    -- diciendo "no me llega": se ve si salió y a qué número.
    canal       VARCHAR(15),
    enviado_a   VARCHAR(120),

    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_codigos_cliente ON portal_codigos (cliente_id, creado_en DESC);

-- -----------------------------------------------------------------------------
-- Las sesiones
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_sesiones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    -- Igual que el código: se guarda la huella, no el token. El token existe
    -- solo en el celular del abonado.
    token_hash  VARCHAR(64) NOT NULL UNIQUE,

    -- Treinta días. Un abonado entra una vez al mes, cuando le llega la
    -- factura: pedirle el código cada vez lo haría dejar de entrar.
    expira_en   TIMESTAMPTZ NOT NULL,
    ultimo_uso  TIMESTAMPTZ,

    -- Para que el abonado pueda reconocer una sesión que no es suya y cerrarla.
    agente      VARCHAR(200),

    creada_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_sesiones_cliente ON portal_sesiones (cliente_id);
CREATE INDEX IF NOT EXISTS idx_portal_sesiones_expira ON portal_sesiones (expira_en);

-- -----------------------------------------------------------------------------
-- Lo que el abonado pide y todavía no se pudo aplicar
-- -----------------------------------------------------------------------------
--
-- Cambiar la clave del WiFi necesita llegar al equipo del abonado por TR069.
-- Cuando el ACS no tiene camino a la red de gestión —o el equipo está apagado—
-- el pedido no se pierde: queda acá y se aplica cuando se puede.
--
-- Decir "listo" y no hacerlo sería lo peor: el abonado cambia su clave, se
-- desconecta para reconectar con la nueva, y no entra ni con una ni con la otra.
CREATE TABLE IF NOT EXISTS portal_solicitudes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    tipo        VARCHAR(20) NOT NULL CHECK (tipo IN ('clave_wifi', 'nombre_wifi')),

    -- El valor pedido, cifrado cuando es una clave. Una clave de WiFi en claro
    -- en la base es una clave de WiFi en claro en cualquier respaldo.
    valor_encrypted TEXT NOT NULL,

    estado      VARCHAR(15) NOT NULL DEFAULT 'pendiente'
                CHECK (estado IN ('pendiente', 'aplicada', 'fallida', 'cancelada')),
    intentos    SMALLINT NOT NULL DEFAULT 0,
    ultimo_error TEXT,

    aplicada_en TIMESTAMPTZ,
    creada_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_solicitudes_pendientes
    ON portal_solicitudes (estado, creada_en) WHERE estado = 'pendiente';

-- -----------------------------------------------------------------------------
-- Acceso
-- -----------------------------------------------------------------------------
-- Ninguna política de lectura, a propósito. Estas tablas solo las toca el
-- middleware con service_role. Un abonado no tiene usuario de Supabase y no
-- debe poder consultar nada directo: cada dato que ve pasa por un endpoint que
-- ya sabe de qué cliente es la sesión.
ALTER TABLE portal_codigos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sesiones    ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_solicitudes ENABLE ROW LEVEL SECURITY;

-- El personal sí puede ver las solicitudes pendientes: es una cola de trabajo.
DROP POLICY IF EXISTS portal_solicitudes_staff ON portal_solicitudes;
CREATE POLICY portal_solicitudes_staff ON portal_solicitudes
    FOR SELECT TO authenticated USING (true);

-- -----------------------------------------------------------------------------
-- El abonado necesita poder entrar
-- -----------------------------------------------------------------------------
-- Sin identificación cargada no hay con qué reconocerlo, y sin celular no hay
-- a dónde mandarle el código. Este índice no es solo velocidad: es lo que evita
-- que dos abonados con la misma cédula hagan ambiguo el ingreso.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_identificacion_unica
    ON clientes (identificacion)
    WHERE identificacion IS NOT NULL AND identificacion <> '' AND estado <> 'baja';

COMMENT ON TABLE portal_codigos IS
    'Códigos de un solo uso del portal. Se guarda la huella, nunca el código.';
COMMENT ON TABLE portal_sesiones IS
    'Sesiones del portal. Se guarda la huella del token, nunca el token.';
COMMENT ON TABLE portal_solicitudes IS
    'Cambios pedidos desde el portal que esperan poder aplicarse en el equipo del abonado.';
