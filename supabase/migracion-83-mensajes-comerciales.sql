-- =============================================================================
-- Migración 83 — Registro de mensajes al prospecto
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué había ──
--
-- El botón de WhatsApp del Cotizador armaba un enlace `wa.me` y abría el chat.
-- Nada más. El mensaje salía del celular del vendedor y el sistema no se
-- enteraba: ni que existió, ni a quién, ni qué decía.
--
-- Eso deja el mismo agujero que la migración 70 vino a cerrar por el otro lado.
-- La cartera está protegida, pero la CONVERSACIÓN con el prospecto vive entera
-- en un teléfono ajeno. Cuando el vendedor se va, se va con ella: qué se le
-- prometió a cada uno, en qué quedaron, quién estaba por cerrar.
--
-- ── Lo que hace esto, y lo que NO hace ──
--
-- Guarda qué mensaje se preparó, para quién, cuándo y con qué cotización.
--
-- No dice que el mensaje se envió. No puede: el envío ocurre en el teléfono del
-- vendedor, fuera del sistema, y él puede cerrar WhatsApp sin apretar enviar.
-- Por eso el estado nace en `preparado` y no en `enviado`. Ponerle `enviado`
-- sería cómodo y sería mentira, y el día que haya que reclamar "yo le avisé" el
-- registro no probaría nada.
--
-- Cuando se conecte la API de Meta —los campos ya están en Ajustes →
-- Mensajería— los mensajes que salgan por ahí sí van a nacer en `enviado`, con
-- el id del proveedor. La columna `via` distingue los dos casos, así que el
-- historial no mezcla lo que se sabe con lo que se supone.
-- =============================================================================


CREATE TABLE IF NOT EXISTS mensajes_comerciales (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Los dos son opcionales porque se cotiza antes de que exista el prospecto:
    -- alguien entra al local, pregunta y se le manda el precio. Eso también
    -- tiene que quedar registrado.
    prospecto_id  UUID REFERENCES prospectos(id)   ON DELETE CASCADE,
    cotizacion_id UUID REFERENCES cotizaciones(id) ON DELETE SET NULL,

    canal         VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    -- El número tal como se usó, no una referencia. Si mañana el prospecto
    -- corrige su teléfono, el registro tiene que seguir diciendo a dónde se
    -- escribió realmente.
    destino       VARCHAR(40) NOT NULL,
    cuerpo        TEXT NOT NULL,

    --   preparado → se abrió el chat con el texto. No hay acuse de nada.
    --   enviado   → salió por la API y el proveedor lo aceptó.
    --   fallido   → el proveedor lo rechazó.
    estado        VARCHAR(20) NOT NULL DEFAULT 'preparado',
    -- Por dónde: `manual` es el teléfono del vendedor; `meta` o `twilio`, la API.
    via           VARCHAR(20) NOT NULL DEFAULT 'manual',
    proveedor_id  TEXT,
    -- Solo se llena cuando de verdad se sabe. En manual queda NULL para siempre.
    enviado_en    TIMESTAMPTZ,

    vendedor_id   UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT mensajes_comerciales_estado_check
        CHECK (estado IN ('preparado', 'enviado', 'fallido')),
    CONSTRAINT mensajes_comerciales_via_check
        CHECK (via IN ('manual', 'meta', 'twilio')),
    -- Un mensaje suelto, sin prospecto ni cotización, no se puede auditar: no se
    -- sabría de qué venta habla.
    CONSTRAINT mensajes_comerciales_tiene_a_quien
        CHECK (prospecto_id IS NOT NULL OR cotizacion_id IS NOT NULL),
    -- La fecha de envío solo existe si hubo envío comprobado. Sin esto, un
    -- `preparado` con fecha se leería como un envío que nadie puede probar.
    CONSTRAINT mensajes_comerciales_fecha_coherente
        CHECK (enviado_en IS NULL OR estado = 'enviado')
);

CREATE INDEX IF NOT EXISTS idx_mensajes_comerciales_prospecto
    ON mensajes_comerciales (prospecto_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_mensajes_comerciales_vendedor
    ON mensajes_comerciales (vendedor_id, creado_en DESC);


-- =============================================================================
-- La vista para las pantallas
-- =============================================================================
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `resumen`, la cadena siguió y esta versión quedó
     * atrás: la esta misma migracion la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_mensajes_comerciales'
           AND column_name = 'resumen'
    ) THEN
        RAISE NOTICE 'v_mensajes_comerciales ya está en su versión de la esta misma migracion: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_mensajes_comerciales';
    EXECUTE $vista$
CREATE VIEW v_mensajes_comerciales WITH (security_invoker = true) AS
SELECT
    m.*,
    TRIM(CONCAT(u.nombre, ' ', u.apellido)) AS vendedor,
    p.nombre                                AS prospecto,
    c.numero                                AS cotizacion_numero,
    -- Para la pantalla: la primera línea alcanza para reconocer el mensaje sin
    -- traerse el texto entero de cincuenta filas.
    LEFT(m.cuerpo, 120)                     AS resumen
FROM mensajes_comerciales m
LEFT JOIN usuarios_sistema u ON u.id = m.vendedor_id
LEFT JOIN prospectos p       ON p.id = m.prospecto_id
LEFT JOIN cotizaciones c     ON c.id = m.cotizacion_id
$vista$;
END $guarda$;


-- =============================================================================
-- Seguridad
-- =============================================================================
ALTER TABLE mensajes_comerciales ENABLE ROW LEVEL SECURITY;

-- Leer: lo propio, o todo si maneja la cartera. Un vendedor no tiene por qué
-- ver qué les escriben los otros a sus prospectos — eso es la cartera ajena
-- contada de otra forma.
DROP POLICY IF EXISTS mensajes_comerciales_lectura ON mensajes_comerciales;
CREATE POLICY mensajes_comerciales_lectura ON mensajes_comerciales
    FOR SELECT TO authenticated
    USING (cartera_completa() OR vendedor_id = mi_legajo_id());

-- Escribir: solo a nombre propio. Sin el `WITH CHECK`, cualquiera podría
-- insertar filas firmadas por otro vendedor, y un registro que se puede firmar
-- con el nombre ajeno no sirve para auditar nada.
DROP POLICY IF EXISTS mensajes_comerciales_alta ON mensajes_comerciales;
CREATE POLICY mensajes_comerciales_alta ON mensajes_comerciales
    FOR INSERT TO authenticated
    WITH CHECK (vendedor_id = mi_legajo_id() OR cartera_completa());

-- Y no se edita ni se borra desde el navegador. Un registro que el registrado
-- puede reescribir no es un registro. No hay política de UPDATE ni de DELETE:
-- con RLS activo, lo que no tiene política está prohibido.
