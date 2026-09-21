-- =============================================================================
-- Migración 66 — Gestión de personal: usuarios, roles, permisos y auditoría
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Hasta acá el sistema tenía una sola clase de usuario: el que entra. Cualquiera
-- que entraba veía todo — la cartera completa de abonados, la facturación, las
-- claves de las OLTs. Eso alcanza mientras el ISP lo maneja una persona; el día
-- que entra un técnico tercerizado, deja de alcanzar.
--
-- ── Las dos tablas ──
--
-- `usuarios_sistema` es el legajo: quién es, qué rol tiene y qué puede tocar.
-- Cuelga de auth.users por `auth_id`, pero no ES auth.users: ahí Supabase guarda
-- la credencial y nada más. El apellido, el celular, el rol y los permisos son
-- del negocio y viven acá, donde se pueden consultar y auditar.
--
-- `auditoria_sistema` es el registro de quién hizo qué. Existe por una razón
-- concreta: cuando aparece un pago borrado o un abonado con el plan cambiado,
-- la pregunta siempre es la misma —"¿quién?"— y sin esta tabla no hay respuesta.
--
-- ── Por qué los permisos son un JSONB y no una tabla ──
--
-- Se evaluó una tabla `permisos` con su relación N a N. Se descartó: el catálogo
-- de permisos es código —cambia cuando se agrega una pantalla, no cuando se
-- agrega un usuario— y tenerlo en la base obliga a una migración por cada
-- pantalla nueva, más un JOIN en cada carga de sesión. El arreglo de claves se
-- lee de una y se compara en memoria.
--
-- El rol NO es la fuente de la verdad de los permisos: es la plantilla que los
-- carga marcados la primera vez. Después el administrador agrega o quita, y lo
-- que vale es la lista. Un "Cobrador" al que le habilitaron ver reportes sigue
-- siendo Cobrador — el rol es cómo se lo llama, la lista es lo que puede.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- El legajo
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios_sistema (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- El usuario de Supabase Auth. Es NULL mientras el legajo existe pero
    -- todavía no puede entrar: sirve para dejar cargada la gente antes de
    -- darle acceso, y para que borrar la credencial no borre el historial de
    -- quién hizo qué.
    auth_id         UUID UNIQUE,

    nombre          VARCHAR(60)  NOT NULL,
    apellido        VARCHAR(60)  NOT NULL DEFAULT '',
    usuario         VARCHAR(40)  NOT NULL,
    email           VARCHAR(120) NOT NULL,
    celular         VARCHAR(30),

    rol             VARCHAR(20)  NOT NULL DEFAULT 'tecnico',
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,

    -- Un despachador de la central opera cualquier zona; un técnico de una
    -- ciudad, solo la suya. Sin esta bandera habría que listar zona por zona a
    -- quien igual las ve todas.
    todas_las_zonas BOOLEAN      NOT NULL DEFAULT FALSE,
    dos_factores    BOOLEAN      NOT NULL DEFAULT FALSE,

    -- La lista efectiva de claves de permiso. El rol solo la propone.
    permisos        JSONB        NOT NULL DEFAULT '[]'::jsonb,

    -- El rol técnico se ata al técnico ya cargado en Soporte, para que sus
    -- tickets asignados sean los mismos que ve el despachador. Sin esto habría
    -- dos listas de técnicos que se contradicen.
    tecnico_id      UUID REFERENCES tecnicos(id) ON DELETE SET NULL,

    creado_por      UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    ultimo_acceso   TIMESTAMPTZ,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT usuarios_sistema_rol_valido CHECK (rol IN (
        'super_admin', 'admin', 'finanzas', 'cobrador',
        'cajero', 'vendedor', 'supervisor', 'tecnico', 'bodega'
    )),
    CONSTRAINT usuarios_sistema_permisos_arreglo CHECK (jsonb_typeof(permisos) = 'array')
);

-- El nombre de usuario y el correo se comparan sin distinguir mayúsculas: quien
-- entra escribe "Jperez" o "jperez" sin pensarlo, y dos legajos que solo se
-- diferencian en eso son el mismo error esperando a pasar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_sistema_usuario
    ON usuarios_sistema (LOWER(usuario));
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_sistema_email
    ON usuarios_sistema (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_usuarios_sistema_rol ON usuarios_sistema (rol, activo);

COMMENT ON TABLE usuarios_sistema IS
    'Quién puede entrar y qué puede tocar. El rol es la plantilla; permisos es lo que vale.';
COMMENT ON COLUMN usuarios_sistema.permisos IS
    'Arreglo de claves del catálogo de web/src/lib/permisos.js. ["*"] = todo.';

-- -----------------------------------------------------------------------------
-- El registro de quién hizo qué
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auditoria_sistema (
    id             BIGSERIAL PRIMARY KEY,

    -- Se guarda el id Y el nombre. El id sirve para filtrar; el nombre para que
    -- el registro siga siendo legible cuando el usuario se borre — un renglón
    -- que dice "alguien borró la factura 567" no sirve de nada.
    usuario_id     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    usuario_nombre VARCHAR(140),
    usuario_rol    VARCHAR(20),

    -- Qué pasó, en clave: 'usuario.crear', 'ticket.cerrar', 'pago.registrar'.
    -- La clave es para filtrar y contar; la descripción, para leer.
    accion         VARCHAR(60) NOT NULL,
    descripcion    TEXT        NOT NULL,

    -- Sobre qué. Permite abrir la ficha desde el renglón de auditoría.
    entidad        VARCHAR(40),
    entidad_id     VARCHAR(60),

    -- El antes y el después, cuando se trata de un cambio. Es lo que convierte
    -- "editó el usuario Juan" en algo accionable: se ve qué permiso se agregó.
    datos          JSONB,

    ip             VARCHAR(45),
    user_agent     TEXT,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_fecha   ON auditoria_sistema (creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria_sistema (usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_accion  ON auditoria_sistema (accion, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria_sistema (entidad, entidad_id);

COMMENT ON TABLE auditoria_sistema IS
    'Quién, cuándo, desde qué IP y qué hizo. Solo se agrega: no se edita ni se borra.';

-- -----------------------------------------------------------------------------
-- Seguridad
-- -----------------------------------------------------------------------------
ALTER TABLE usuarios_sistema  ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria_sistema ENABLE ROW LEVEL SECURITY;

-- Leer el legajo desde el navegador hace falta para dos cosas: la pantalla de
-- Gestión de personal, y que la app sepa al entrar qué permisos tiene quien
-- entró. Acá no hay contraseñas — esas viven en auth.users, que el navegador no
-- toca.
DROP POLICY IF EXISTS usuarios_sistema_lectura ON usuarios_sistema;
CREATE POLICY usuarios_sistema_lectura ON usuarios_sistema
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS auditoria_sistema_lectura ON auditoria_sistema;
CREATE POLICY auditoria_sistema_lectura ON auditoria_sistema
    FOR SELECT TO authenticated USING (true);

-- Escribir NO se puede desde el navegador, ni en una ni en la otra. En usuarios
-- porque crear la credencial exige la service_role key y porque la regla de que
-- un Administrador no puede crear otro Administrador solo vale si se verifica
-- en el servidor: en el navegador se saltea con la consola abierta. En
-- auditoría porque un registro que el auditado puede editar no es auditoría.
-- Ambas pasan por el middleware.

-- -----------------------------------------------------------------------------
-- El primer Super Administrador
-- -----------------------------------------------------------------------------
-- Sin esto la pantalla queda vacía y con candado: nadie tiene permiso de crear
-- usuarios, así que no hay forma de crear al primero. Se adopta a quien ya
-- entraba antes de esta migración — el dueño de la instalación.
INSERT INTO usuarios_sistema (auth_id, nombre, apellido, usuario, email, rol, permisos, todas_las_zonas)
SELECT
    u.id,
    COALESCE(NULLIF(SPLIT_PART(COALESCE(u.raw_user_meta_data ->> 'full_name', ''), ' ', 1), ''), 'Super'),
    COALESCE(NULLIF(SPLIT_PART(COALESCE(u.raw_user_meta_data ->> 'full_name', ''), ' ', 2), ''), 'Administrador'),
    SPLIT_PART(u.email, '@', 1),
    u.email,
    'super_admin',
    '["*"]'::jsonb,
    TRUE
FROM auth.users u
WHERE u.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM usuarios_sistema)
ORDER BY u.created_at
LIMIT 1
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Transferir o sumar un Super Administrador
-- -----------------------------------------------------------------------------
-- El Super Administrador NO se crea, ni se edita, ni se elimina desde el
-- sistema. Tampoco por otro Super Administrador. Es a propósito.
--
-- El motivo: si un Super Administrador pudiera crear otro, alcanzaría con
-- encontrar una sesión abierta un minuto para crearse un segundo dueño, entrar
-- con él y eliminar al primero. El dueño quedaría afuera de su propio sistema y
-- solo se recuperaría desde acá. Cerrando ese camino, lo peor que puede hacer
-- alguien que encuentra la sesión abierta es crear un Administrador — que se ve
-- en la auditoría, y se borra.
--
-- Si de verdad hace falta otro dueño —dos socios, una sucesión, un cambio de
-- titular—, se hace acá, a mano y a conciencia. Descomentá y reemplazá el
-- correo por el de la persona, que ya tiene que existir como usuario:
--
--   UPDATE usuarios_sistema
--      SET rol = 'super_admin', permisos = '["*"]'::jsonb, todas_las_zonas = TRUE
--    WHERE LOWER(email) = LOWER('nuevo.dueno@ejemplo.com');
--
-- Y si es una transferencia y no una suma, bajá al anterior en la misma
-- operación, para que no queden dos por olvido:
--
--   UPDATE usuarios_sistema
--      SET rol = 'admin', permisos = '[]'::jsonb
--    WHERE LOWER(email) = LOWER('dueno.anterior@ejemplo.com');
--
-- Ojo con dejarle los permisos en '[]': hay que volver a marcárselos desde la
-- pantalla, o esa persona entra y no ve nada. Es preferible a heredarle el
-- comodín sin querer.
