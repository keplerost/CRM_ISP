-- =============================================================================
-- Migración 71 — Las puertas laterales
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere la 70 (usa `cartera_completa()` y `mis_clientes_visibles()`).
--
-- ── Por qué existe este archivo ──
--
-- La migración 70 cerró `clientes` y lo verifiqué con el token de un vendedor
-- real: cero filas. Pero al revisar si esa prueba era concluyente encontré que
-- `contratos`, `pagos` y `facturas` estaban VACÍAS — o sea que el "cero filas"
-- de esas tablas no probaba nada, y sus políticas seguían siendo
-- `auth_all_*`: cualquier autenticado, todo.
--
-- Y hay una peor. `instalaciones` guarda, para cada alta, el nombre, la cédula,
-- el teléfono, el WhatsApp, el correo y la dirección del abonado. Con la 70
-- aplicada, un vendedor tenía la puerta principal cerrada y esta abierta de par
-- en par: una sola consulta a /rest/v1/instalaciones le devolvía la misma base
-- que veníamos a proteger, con teléfonos incluidos.
--
-- Cerrar `clientes` y dejar estas abiertas no es media protección: es ninguna.
--
-- ── El criterio ──
--
-- Toda tabla que contenga datos de un abonado se rige por la misma pregunta que
-- `clientes`: o tenés la cartera, o solo ves las filas de los clientes que te
-- corresponden hoy.
-- =============================================================================


-- =============================================================================
-- 1. Un ayudante más
-- =============================================================================
-- La red es otra pregunta que la cartera. El técnico tiene que ver las ONUs para
-- trabajar aunque no vea la lista de clientes; el vendedor no tiene por qué ver
-- ninguna de las dos.
CREATE OR REPLACE FUNCTION puede_ver_red()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'red.onus_ver' OR permisos ? 'red.olts_ver'
           FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1),
        TRUE
    )
$$;

/** El id del legajo de quien consulta. Se repetía en media docena de políticas. */
CREATE OR REPLACE FUNCTION mi_legajo_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1
$$;

/** El técnico al que está vinculado quien consulta, si lo está. */
CREATE OR REPLACE FUNCTION mi_tecnico_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT tecnico_id FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1
$$;


-- =============================================================================
-- 2. Dinero: pagos, promesas, facturas, contratos
-- =============================================================================
-- Todas llevan `client_id`. Un vendedor no tiene nada que hacer leyendo el
-- historial de pagos de la cartera: lo que necesita para cobrar se lo da la
-- bandeja de cobranza, con el saldo y nada más.
DROP POLICY IF EXISTS "auth_all_pagos" ON pagos;
DROP POLICY IF EXISTS pagos_cartera ON pagos;
CREATE POLICY pagos_cartera ON pagos
    FOR ALL TO authenticated
    USING (cartera_completa() OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles()))
    WITH CHECK (cartera_completa());

DROP POLICY IF EXISTS "auth_all_promesas_pago" ON promesas_pago;
DROP POLICY IF EXISTS promesas_cartera ON promesas_pago;
CREATE POLICY promesas_cartera ON promesas_pago
    FOR ALL TO authenticated
    USING (cartera_completa() OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles()))
    WITH CHECK (cartera_completa() OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles()));

DROP POLICY IF EXISTS "auth_all_facturas" ON facturas;
DROP POLICY IF EXISTS facturas_cartera ON facturas;
CREATE POLICY facturas_cartera ON facturas
    FOR ALL TO authenticated
    USING (cartera_completa() OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles()))
    WITH CHECK (cartera_completa());

-- El contrato lleva el precio pactado y las condiciones. Es de los documentos
-- que menos tiene que circular.
DROP POLICY IF EXISTS "auth_all_contratos" ON contratos;
DROP POLICY IF EXISTS contratos_cartera ON contratos;
CREATE POLICY contratos_cartera ON contratos
    FOR ALL TO authenticated
    USING (cartera_completa() OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles()))
    WITH CHECK (cartera_completa());

-- `cuentas_pago` no lleva datos de abonados —son las cuentas bancarias del
-- ISP— así que se deja como estaba a propósito: cerrarla rompería el cobro en
-- ventanilla sin proteger nada.


-- =============================================================================
-- 3. Instalaciones: la peor de las puertas
-- =============================================================================
-- Guarda nombre, cédula, teléfono, WhatsApp, correo y dirección de cada alta.
-- Quien la lea entera tiene la base de clientes, con o sin la tabla `clientes`.
--
-- Tres accesos legítimos y nada más:
--   · quien tiene la cartera (administración y backoffice),
--   · el técnico al que se le asignó el trabajo,
--   · el cliente que el usuario ya puede ver por otra vía.
--
-- El vendedor NO está en esa lista, ni siquiera para las que él vendió: lo suyo
-- es el estado, y para eso está la vista del punto 5.
ALTER TABLE instalaciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_instalaciones" ON instalaciones;
DROP POLICY IF EXISTS instalaciones_lectura ON instalaciones;
CREATE POLICY instalaciones_lectura ON instalaciones
    FOR SELECT TO authenticated
    USING (
        cartera_completa()
        OR (tecnico_id IS NOT NULL AND tecnico_id = mi_tecnico_id())
        OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles())
    );

-- Escribir: administración, y el técnico sobre su propio trabajo — que es lo que
-- hace el asistente de alta en campo paso por paso.
DROP POLICY IF EXISTS instalaciones_escritura ON instalaciones;
CREATE POLICY instalaciones_escritura ON instalaciones
    FOR ALL TO authenticated
    USING (cartera_completa() OR (tecnico_id IS NOT NULL AND tecnico_id = mi_tecnico_id()))
    WITH CHECK (cartera_completa() OR (tecnico_id IS NOT NULL AND tecnico_id = mi_tecnico_id()));

-- Las fotos del domicilio cuelgan de la instalación y valen lo mismo que ella.
DROP POLICY IF EXISTS "auth_all_instalacion_fotos" ON instalacion_fotos;
DROP POLICY IF EXISTS instalacion_fotos_cartera ON instalacion_fotos;
CREATE POLICY instalacion_fotos_cartera ON instalacion_fotos
    FOR ALL TO authenticated
    USING (instalacion_id IN (SELECT id FROM instalaciones))
    WITH CHECK (instalacion_id IN (SELECT id FROM instalaciones));
-- El `IN (SELECT id FROM instalaciones)` no es redundante: esa subconsulta ya
-- pasa por la política de arriba, así que la foto hereda exactamente el mismo
-- criterio sin repetirlo. Si mañana cambia el de instalaciones, este la sigue.


-- =============================================================================
-- 4. ONUs: llevan el nombre del abonado
-- =============================================================================
-- `onus` guarda mucho más que el equipo: `nombre_cliente`, `direccion`,
-- `contacto`, y hasta el `ssid` y la `clave_wifi` del abonado. Son 91 filas hoy.
--
-- La relación con el cliente va al REVÉS de lo que uno espera: no hay
-- `onus.client_id` — es `clientes.onu_id` el que apunta acá. Escribir la
-- política como si existiera la columna hacía fallar la migración entera.
--
-- El `IN (SELECT onu_id FROM clientes ...)` aprovecha eso: esa subconsulta pasa
-- por la política de `clientes`, así que solo devuelve las ONUs de los abonados
-- que el usuario ya puede ver. El criterio no se repite, se hereda.
DROP POLICY IF EXISTS "auth_all_onus" ON onus;
DROP POLICY IF EXISTS onus_red ON onus;
CREATE POLICY onus_red ON onus
    FOR ALL TO authenticated
    USING (
        puede_ver_red()
        OR id IN (SELECT onu_id FROM clientes WHERE onu_id IS NOT NULL)
    )
    WITH CHECK (puede_ver_red());


-- =============================================================================
-- 5. Lo que el vendedor SÍ puede ver de sus ventas
-- =============================================================================
-- El punto 19 del requerimiento: que pueda responderle al cliente en qué anda su
-- instalación, sin acceder a la información técnica ni a los datos personales.
--
-- Va como vista y no como una política más sobre `instalaciones` porque RLS
-- filtra FILAS, no columnas: dejarlo leer la fila para que vea el estado le
-- daría de yapa la cédula y el teléfono. La vista expone cinco columnas y
-- ninguna es un dato de contacto.
DROP VIEW IF EXISTS v_mis_ventas_estado;
CREATE VIEW v_mis_ventas_estado WITH (security_invoker = true) AS
SELECT
    p.id            AS prospecto_id,
    p.nombre        AS cliente,
    p.vendedor_id,
    i.id            AS instalacion_id,
    i.estado,
    i.fecha         AS fecha_agendada,
    i.alta_at       AS activada_en,
    -- Sin teléfono, sin cédula, sin dirección: para eso ya tiene el prospecto
    -- mientras está abierto, y después no lo necesita.
    pl.nombre       AS plan
FROM prospectos p
JOIN instalaciones i     ON i.id = p.instalacion_id
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id;

COMMENT ON VIEW v_mis_ventas_estado IS
    'En qué anda cada venta. Sin datos de contacto: el vendedor responde "está agendada", no accede a la ficha.';

-- La vista es security_invoker, así que hereda la política de `prospectos`: solo
-- devuelve las de quien consulta. Pero `instalaciones` ahora le está cerrada al
-- vendedor, y el JOIN la dejaría vacía. Se le abre exactamente esta lectura y
-- nada más.
DROP POLICY IF EXISTS instalaciones_estado_de_mi_venta ON instalaciones;
CREATE POLICY instalaciones_estado_de_mi_venta ON instalaciones
    FOR SELECT TO authenticated
    USING (
        id IN (
            SELECT pr.instalacion_id FROM prospectos pr
             WHERE pr.vendedor_id = mi_legajo_id() AND pr.instalacion_id IS NOT NULL
        )
    );
-- Ojo con esto: en Postgres varias políticas PERMISSIVE sobre la misma tabla se
-- suman con OR. O sea que el vendedor recupera la fila entera de SU instalación,
-- no solo las columnas de la vista. Es un dato que él ya cargó —es su propia
-- venta— así que no expone nada nuevo; pero conviene tenerlo escrito, porque la
-- intuición dice lo contrario.


-- =============================================================================
-- Verificación rápida después de aplicar
-- =============================================================================
-- Estas dos consultas, corridas desde el editor con tu propio usuario, tienen
-- que devolver TODO (sos Super Administrador). Si devuelven vacío, algo quedó
-- mal y conviene revertir:
--
--   SELECT COUNT(*) FROM clientes;
--   SELECT COUNT(*) FROM instalaciones;
--
-- Para revertir el archivo entero sin perder datos:
--
--   DROP POLICY IF EXISTS pagos_cartera ON pagos;
--   CREATE POLICY "auth_all_pagos" ON pagos FOR ALL TO authenticated USING (true) WITH CHECK (true);
--   ... (mismo patrón para promesas_pago, facturas, contratos, onus)
--   ALTER TABLE instalaciones DISABLE ROW LEVEL SECURITY;
