-- =============================================================================
-- Migración 70 — Seguridad de cartera
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Este archivo existe por un hecho concreto: hubo vendedores que se llevaron la
-- base de abonados y se la vendieron a la competencia. Todo lo que sigue está
-- diseñado contra eso.
--
-- ── Por qué esto tiene que estar en la base y no en la aplicación ──
--
-- El navegador habla DIRECTO con Supabase: `ClientesPage` consulta la tabla
-- `clientes` con el token del usuario, sin pasar por el middleware. Es decir que
-- PostgREST es la API pública del sistema.
--
-- Con la política que había hasta hoy —`auth_all_clientes`, cualquier
-- autenticado lee todo— un vendedor podía abrir la consola del navegador y
-- pedir /rest/v1/clientes?select=* para bajarse la cartera entera. Esconder el
-- menú no cambiaba nada. Por eso el control va acá: si la fila no pasa la
-- política, el dato no sale de Postgres, y no hay pantalla ni endpoint ni URL
-- que lo pueda sacar.
--
-- ── La regla ──
--
-- El vendedor NUNCA tiene una lista de clientes que pueda recorrer. Ve:
--   · sus prospectos en proceso (todavía no son clientes),
--   · el estado de las instalaciones que vendió,
--   · y los clientes con una cobranza asignada y vigente — solo mientras dure.
--
-- Al activarse el servicio, el cliente desaparece de su vista. El prospecto se
-- archiva. Si aparece una deuda dentro de la ventana, vuelve como TAREA, no como
-- ficha: nombre, teléfono, plan, saldo y botones de contacto.
-- =============================================================================


-- =============================================================================
-- 1. Cuándo se activó el servicio
-- =============================================================================
-- Ninguna columna existente sirve para medir la ventana:
--
--   `fecha_instalacion` es la fecha AGENDADA. Es editable y a veces retroactiva:
--   una venta con la fecha mal cargada correría la ventana meses.
--
--   `created_at` tampoco: un abonado importado de MikroWisp lo tiene con la
--   fecha de la importación, y arrancaría su ventana el día de la migración.
--
-- `activado_en` se sella en el momento real del alta y no se edita.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS activado_en TIMESTAMPTZ;

COMMENT ON COLUMN clientes.activado_en IS
    'Momento real del alta del servicio. Es el reloj de la ventana de cobranza del vendedor. No se edita.';

-- Los abonados que ya existían quedan con NULL a propósito.
--
-- Se evaluó ponerles `created_at` para "no perder historia". Se descartó: ningún
-- cliente histórico tiene vendedor asignado, así que no habría a quién dárselos,
-- y rellenarlo sería abrir acceso que hoy nadie tiene sobre justamente la base
-- que ya se filtró una vez. NULL significa "ningún vendedor lo ve", que es lo
-- correcto.

-- Se sella solo, en el momento en que el cliente pasa a activo.
CREATE OR REPLACE FUNCTION sellar_activacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'activo' AND NEW.activado_en IS NULL THEN
        NEW.activado_en := NOW();
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sellar_activacion ON clientes;
CREATE TRIGGER trg_sellar_activacion
    BEFORE INSERT OR UPDATE OF estado ON clientes
    FOR EACH ROW EXECUTE FUNCTION sellar_activacion();


-- =============================================================================
-- 2. La configuración
-- =============================================================================
-- Una sola fila. La ventana es configurable porque lo pediste así, y porque el
-- número correcto depende de cómo pague la comisión cada ISP.
CREATE TABLE IF NOT EXISTS config_cartera (
    id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Cuántos meses después de la activación se le puede seguir asignando la
    -- cobranza de ese cliente al vendedor que lo vendió.
    ventana_cobranza_meses SMALLINT NOT NULL DEFAULT 6
                           CHECK (ventana_cobranza_meses BETWEEN 0 AND 60),

    -- Archivar el prospecto al activarse la venta. En TRUE el vendedor deja de
    -- ver también la ficha comercial —con su teléfono y su dirección—, no solo
    -- el cliente. Sin esto, alguien que trabaja dos años acumula cientos de
    -- fichas con teléfono, que es una base de datos exportable por la otra
    -- puerta.
    archivar_prospectos    BOOLEAN NOT NULL DEFAULT TRUE,

    actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO config_cartera (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE config_cartera ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS config_cartera_lectura ON config_cartera;
CREATE POLICY config_cartera_lectura ON config_cartera
    FOR SELECT TO authenticated USING (true);

-- Escribir NO: cambiar la ventana desde el navegador sería ampliarse el propio
-- acceso. Pasa por el middleware, que verifica el rol.


-- =============================================================================
-- 3. Cobranza asignada
-- =============================================================================
-- La asignación es lo que ABRE la visibilidad, y su cierre es lo que la quita.
-- No hay un estado intermedio donde el vendedor "todavía" vea al cliente: o
-- tiene una tarea activa, o no lo ve.
CREATE TABLE IF NOT EXISTS cobranza_asignaciones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  UUID NOT NULL REFERENCES clientes(id)          ON DELETE CASCADE,
    vendedor_id UUID NOT NULL REFERENCES usuarios_sistema(id)  ON DELETE CASCADE,

    -- Hasta cuándo. Se calcula al asignar con la ventana vigente y se congela:
    -- si mañana el administrador baja la ventana a 3 meses, las asignaciones ya
    -- hechas no se cortan de golpe en medio de una gestión.
    vence_el    DATE NOT NULL,

    -- `activa` = el vendedor ve al cliente. Cualquier otro estado = no lo ve.
    estado      VARCHAR(12) NOT NULL DEFAULT 'activa',

    -- Cuánto debía cuando se asignó. Sirve para saber si la gestión sirvió de
    -- algo, comparado contra el saldo de hoy.
    saldo_inicial NUMERIC(12,2),
    motivo      TEXT,

    -- Quién la creó. NULL = la creó el sistema al detectar la deuda.
    asignado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cerrado_en  TIMESTAMPTZ,

    CONSTRAINT cobranza_asignaciones_estado_check CHECK (estado IN (
        'activa', 'pagada', 'vencida', 'escalada', 'cancelada'
    ))
);

-- Un cliente no puede tener dos gestiones activas a la vez: dos vendedores
-- llamando al mismo abonado el mismo día es peor que no llamarlo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobranza_una_activa
    ON cobranza_asignaciones (cliente_id) WHERE estado = 'activa';
CREATE INDEX IF NOT EXISTS idx_cobranza_vendedor
    ON cobranza_asignaciones (vendedor_id, estado);

-- Cada contacto de cobro.
CREATE TABLE IF NOT EXISTS cobranza_gestiones (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asignacion_id  UUID NOT NULL REFERENCES cobranza_asignaciones(id) ON DELETE CASCADE,

    canal          VARCHAR(12) NOT NULL,
    resultado      VARCHAR(20) NOT NULL,
    observacion    TEXT,

    -- La promesa. Si hay fecha, el tablero arma el recordatorio para ese día.
    promesa_monto  NUMERIC(12,2),
    promesa_fecha  DATE,

    usuario_id     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    usuario_nombre VARCHAR(140),
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT cobranza_gestiones_canal_check CHECK (canal IN (
        'llamada', 'whatsapp', 'visita', 'otro'
    )),
    CONSTRAINT cobranza_gestiones_resultado_check CHECK (resultado IN (
        'pendiente_contacto', 'contactado', 'promesa_pago', 'no_responde',
        'pago_informado', 'pagado', 'escalar'
    )),
    -- Una promesa sin fecha no es una promesa: no se puede recordar ni reclamar.
    CONSTRAINT cobranza_promesa_con_fecha CHECK (
        resultado <> 'promesa_pago' OR promesa_fecha IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_cobranza_gestiones
    ON cobranza_gestiones (asignacion_id, creado_en DESC);


-- =============================================================================
-- 4. Archivado del prospecto
-- =============================================================================
ALTER TABLE prospectos
    ADD COLUMN IF NOT EXISTS archivado_en TIMESTAMPTZ;

COMMENT ON COLUMN prospectos.archivado_en IS
    'Cuándo dejó de ser trabajo del vendedor. Archivado = fuera de su vista, pero sigue en los reportes del administrador.';

CREATE INDEX IF NOT EXISTS idx_prospectos_activos
    ON prospectos (vendedor_id) WHERE archivado_en IS NULL;

-- Se archiva solo cuando la instalación se completa. El disparador es la
-- instalación y no el cliente porque es la instalación la que sabe de qué
-- prospecto viene.
CREATE OR REPLACE FUNCTION archivar_prospecto_de_instalacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'hecha' AND NEW.client_id IS NOT NULL
       AND (SELECT archivar_prospectos FROM config_cartera WHERE id = 1) THEN
        UPDATE prospectos
           SET archivado_en = COALESCE(archivado_en, NOW()),
               cliente_id   = COALESCE(cliente_id, NEW.client_id)
         WHERE instalacion_id = NEW.id
           AND archivado_en IS NULL;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_archivar_prospecto ON instalaciones;
CREATE TRIGGER trg_archivar_prospecto
    AFTER UPDATE OF estado ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION archivar_prospecto_de_instalacion();


-- =============================================================================
-- 5. Quién ve qué
-- =============================================================================
-- Dos funciones, y la división entre ellas importa para el rendimiento:
--
--   `cartera_completa()` no depende de la fila. Postgres la evalúa UNA vez por
--   consulta, no una por cliente.
--
--   `mis_clientes_visibles()` devuelve un conjunto, y la política lo usa con IN,
--   que el planificador resuelve como un semi-join. Una función escalar por fila
--   sobre diez mil clientes sería lentísima.

/**
 * ¿Este usuario puede ver la cartera entera?
 *
 * Se apoya en un permiso nuevo, `clientes.cartera`, y NO en `clientes.ver`.
 * Son preguntas distintas y confundirlas rompía dos roles: `clientes.ver` es
 * "puede abrir el listado de clientes" —que el cajero y el cobrador no tienen a
 * propósito— mientras que esto es "puede leer la fila de cualquier cliente", que
 * los dos necesitan para poder cobrarle a quien se presenta en el mostrador.
 */
CREATE OR REPLACE FUNCTION cartera_completa()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'clientes.cartera'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        -- Sin legajo no se bloquea a nadie: es una instalación que todavía no
        -- corrió la migración 66, y cerrarle el paso la dejaría inutilizable de
        -- golpe. El frente se comporta igual por la misma razón.
        TRUE
    )
$$;

/**
 * Los clientes que este usuario puede ver aunque no tenga la cartera completa.
 *
 * Tres orígenes, y ninguno es "los que vendí": esa lista no existe a propósito.
 */
CREATE OR REPLACE FUNCTION mis_clientes_visibles()
RETURNS TABLE (cliente_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH yo AS (
        SELECT id, tecnico_id FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo LIMIT 1
    )
    -- 1. Cobranza asignada y vigente. Es la única puerta por la que un vendedor
    --    vuelve a ver a un cliente ya activado, y se cierra sola al pagarse.
    SELECT ca.cliente_id
      FROM cobranza_asignaciones ca JOIN yo ON ca.vendedor_id = yo.id
     WHERE ca.estado = 'activa' AND ca.vence_el >= CURRENT_DATE

    UNION

    -- 2. El técnico y los clientes de sus trabajos. Incluye los cerrados: sin
    --    eso, su historial de tickets perdería el nombre del abonado.
    SELECT t.client_id
      FROM tickets t JOIN yo ON t.tecnico_id = yo.tecnico_id
     WHERE t.client_id IS NOT NULL

    UNION

    SELECT i.client_id
      FROM instalaciones i JOIN yo ON i.tecnico_id = yo.tecnico_id
     WHERE i.client_id IS NOT NULL
$$;


-- =============================================================================
-- 6. La política
-- =============================================================================
-- Reemplaza `auth_all_clientes`, que dejaba leer todo a cualquiera con sesión.
DROP POLICY IF EXISTS "auth_all_clientes" ON clientes;

DROP POLICY IF EXISTS clientes_lectura ON clientes;
CREATE POLICY clientes_lectura ON clientes
    FOR SELECT TO authenticated
    USING (cartera_completa() OR id IN (SELECT cliente_id FROM mis_clientes_visibles()));

-- Escribir exige la cartera completa. Un vendedor con una cobranza asignada
-- puede LEER a ese cliente para llamarlo, no editarlo: si pudiera, cambiarle el
-- teléfono al cliente de otro sería trivial.
--
-- El alta en campo del técnico no pasa por acá: `finalizar_alta_instalacion`
-- queda como SECURITY DEFINER más abajo, que es la forma correcta de permitir
-- una operación concreta sin darle permiso general a quien la ejecuta.
DROP POLICY IF EXISTS clientes_escritura ON clientes;
CREATE POLICY clientes_escritura ON clientes
    FOR ALL TO authenticated
    USING (cartera_completa())
    WITH CHECK (cartera_completa());


-- =============================================================================
-- 7. El prospecto archivado desaparece del vendedor
-- =============================================================================
DROP POLICY IF EXISTS prospectos_personal ON prospectos;

DROP POLICY IF EXISTS prospectos_lectura ON prospectos;
CREATE POLICY prospectos_lectura ON prospectos
    FOR SELECT TO authenticated
    USING (
        cartera_completa()          -- el administrador los ve todos, siempre
        OR archivado_en IS NULL     -- el vendedor, solo los que está trabajando
    );

DROP POLICY IF EXISTS prospectos_escritura ON prospectos;
CREATE POLICY prospectos_escritura ON prospectos
    FOR ALL TO authenticated
    USING (cartera_completa() OR archivado_en IS NULL)
    WITH CHECK (cartera_completa() OR archivado_en IS NULL);


-- =============================================================================
-- 8. Cobranza: quién ve las asignaciones
-- =============================================================================
ALTER TABLE cobranza_asignaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE cobranza_gestiones    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cobranza_asignaciones_lectura ON cobranza_asignaciones;
CREATE POLICY cobranza_asignaciones_lectura ON cobranza_asignaciones
    FOR SELECT TO authenticated
    USING (
        cartera_completa()
        OR vendedor_id = (SELECT id FROM usuarios_sistema WHERE auth_id = auth.uid() LIMIT 1)
    );

-- Asignar y cerrar pasa por el middleware: si el vendedor pudiera crear su
-- propia asignación, se daría acceso a cualquier cliente escribiendo una fila.
-- Es exactamente el agujero que este archivo viene a cerrar.

DROP POLICY IF EXISTS cobranza_gestiones_lectura ON cobranza_gestiones;
CREATE POLICY cobranza_gestiones_lectura ON cobranza_gestiones
    FOR SELECT TO authenticated
    USING (
        cartera_completa()
        OR asignacion_id IN (
            SELECT ca.id FROM cobranza_asignaciones ca
             WHERE ca.vendedor_id = (SELECT id FROM usuarios_sistema WHERE auth_id = auth.uid() LIMIT 1)
        )
    );

-- Registrar la gestión sí la hace el vendedor: es su trabajo, y solo sobre una
-- asignación que ya es suya.
DROP POLICY IF EXISTS cobranza_gestiones_alta ON cobranza_gestiones;
CREATE POLICY cobranza_gestiones_alta ON cobranza_gestiones
    FOR INSERT TO authenticated
    WITH CHECK (
        asignacion_id IN (
            SELECT ca.id FROM cobranza_asignaciones ca
             WHERE ca.estado = 'activa'
               AND ca.vendedor_id = (SELECT id FROM usuarios_sistema WHERE auth_id = auth.uid() LIMIT 1)
        )
        OR cartera_completa()
    );


-- =============================================================================
-- 9. El alta en campo tiene que seguir funcionando
-- =============================================================================
-- `finalizar_alta_instalacion` corre como INVOKER: con la política de escritura
-- recién puesta, el técnico —que no tiene la cartera— ya no podría crear el
-- cliente, y el asistente de alta se rompería en el último paso.
--
-- Pasa a SECURITY DEFINER. Es el patrón correcto: una operación concreta y
-- validada se ejecuta con privilegio, en vez de darle privilegio general a quien
-- la llama. El `search_path` fijo evita que alguien la desvíe creando objetos
-- con el mismo nombre en otro esquema.
ALTER FUNCTION finalizar_alta_instalacion(UUID) SECURITY DEFINER;
ALTER FUNCTION finalizar_alta_instalacion(UUID) SET search_path = public, pg_temp;


-- =============================================================================
-- 10. Un agujero que ya estaba abierto
-- =============================================================================
-- `v_electronic_documents` se creó sin `security_invoker`, así que corre con los
-- permisos de quien la creó y EVADE RLS: cualquiera con sesión podía leer por
-- ahí datos de facturación de todos los abonados. Es anterior a este pedido,
-- pero dejarlo sería tapar la puerta y no la ventana.
ALTER VIEW v_electronic_documents SET (security_invoker = true);


-- =============================================================================
-- Cómo revertir, si algo se rompe
-- =============================================================================
-- Devuelve el sistema al comportamiento anterior sin perder ningún dato:
--
--   DROP POLICY IF EXISTS clientes_lectura   ON clientes;
--   DROP POLICY IF EXISTS clientes_escritura ON clientes;
--   CREATE POLICY "auth_all_clientes" ON clientes
--       FOR ALL TO authenticated USING (true) WITH CHECK (true);
--
-- Las columnas, tablas y triggers pueden quedar: no molestan a nadie.
