-- =============================================================================
-- Migración 74 — Archivos protegidos y auditoría de accesos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere la 70 a la 73.
--
-- Cierra los puntos 4 y 25 del requerimiento, y una puerta lateral más que
-- apareció al revisar: `tickets`.
--
-- ── Los tres buckets viejos ──
--
-- `documentos`, `tickets` e `instalaciones` son privados —eso ya estaba bien—
-- pero su política dice solamente:
--
--     USING (bucket_id = 'documentos')
--
-- O sea: cualquier usuario con sesión puede leer CUALQUIER archivo del bucket si
-- conoce la ruta. Y las rutas no son secretas: son `<id de la entidad>/archivo`,
-- y esos id aparecen en las URLs de la aplicación.
--
-- Para una foto de un poste da igual. Para la cédula de un abonado, no.
--
-- La corrección aprovecha que las cuatro convenciones de ruta son iguales —
-- todas empiezan por el id de su entidad— así que la política puede leer esa
-- primera carpeta y preguntarle a la tabla. El permiso del archivo pasa a ser
-- exactamente el de su ficha, sin una segunda regla que pueda discrepar.
-- =============================================================================


-- =============================================================================
-- 1. Tickets: la puerta lateral que faltaba
-- =============================================================================
-- Guardan el nombre del abonado, su teléfono y el detalle del reclamo. La
-- política era `USING (TRUE)`: cualquiera con sesión, todos los tickets.
--
-- El técnico conserva los suyos. Es lo mismo que ya hace la pantalla al filtrar
-- por `tecnico_id`, pero ahora también del lado del servidor: hasta hoy, ese
-- filtro se saltaba escribiendo la consulta a mano.
DROP POLICY IF EXISTS tickets_autenticados ON tickets;
DROP POLICY IF EXISTS tickets_acceso ON tickets;
CREATE POLICY tickets_acceso ON tickets
    FOR ALL TO authenticated
    USING (
        cartera_completa()
        OR (tecnico_id IS NOT NULL AND tecnico_id = mi_tecnico_id())
        OR client_id IN (SELECT cliente_id FROM mis_clientes_visibles())
    )
    WITH CHECK (
        cartera_completa()
        OR (tecnico_id IS NOT NULL AND tecnico_id = mi_tecnico_id())
    );

-- Los eventos y adjuntos heredan del ticket: la subconsulta ya pasa por la
-- política de arriba.
DROP POLICY IF EXISTS ticket_eventos_autenticados ON ticket_eventos;
DROP POLICY IF EXISTS ticket_eventos_acceso ON ticket_eventos;
CREATE POLICY ticket_eventos_acceso ON ticket_eventos
    FOR ALL TO authenticated
    USING (ticket_id IN (SELECT id FROM tickets))
    WITH CHECK (ticket_id IN (SELECT id FROM tickets));

DROP POLICY IF EXISTS ticket_adjuntos_autenticados ON ticket_adjuntos;
DROP POLICY IF EXISTS ticket_adjuntos_acceso ON ticket_adjuntos;
CREATE POLICY ticket_adjuntos_acceso ON ticket_adjuntos
    FOR ALL TO authenticated
    USING (ticket_id IN (SELECT id FROM tickets))
    WITH CHECK (ticket_id IN (SELECT id FROM tickets));

-- `tecnicos`, `cuadrillas` y `cuadrilla_miembros` quedan abiertos a propósito:
-- son nombres del personal, no datos de abonados, y todo el sistema los necesita
-- para mostrar "asignado a Juan".


-- =============================================================================
-- 2. Los archivos
-- =============================================================================
-- Cada bucket valida contra la tabla de la que cuelga. Si el usuario no puede
-- ver la ficha, tampoco puede abrir el archivo — aunque tenga la ruta exacta.

-- ── documentos: cuelgan del cliente ──
DROP POLICY IF EXISTS "documentos_leer" ON storage.objects;
CREATE POLICY "documentos_leer" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'documentos'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM clientes)
    );

DROP POLICY IF EXISTS "documentos_subir" ON storage.objects;
CREATE POLICY "documentos_subir" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'documentos'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM clientes)
    );

DROP POLICY IF EXISTS "documentos_borrar" ON storage.objects;
CREATE POLICY "documentos_borrar" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'documentos'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM clientes)
    );

-- ── tickets: cuelgan del ticket ──
DROP POLICY IF EXISTS "tickets_leer" ON storage.objects;
CREATE POLICY "tickets_leer" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'tickets'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM tickets)
    );

DROP POLICY IF EXISTS "tickets_subir" ON storage.objects;
CREATE POLICY "tickets_subir" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'tickets'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM tickets)
    );

DROP POLICY IF EXISTS "tickets_borrar" ON storage.objects;
CREATE POLICY "tickets_borrar" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'tickets'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM tickets)
    );

-- ── instalaciones: fotos del domicilio y del equipo ──
DROP POLICY IF EXISTS "instalaciones_leer" ON storage.objects;
CREATE POLICY "instalaciones_leer" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'instalaciones'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM instalaciones)
    );

DROP POLICY IF EXISTS "instalaciones_subir" ON storage.objects;
CREATE POLICY "instalaciones_subir" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'instalaciones'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM instalaciones)
    );

DROP POLICY IF EXISTS "instalaciones_borrar" ON storage.objects;
CREATE POLICY "instalaciones_borrar" ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'instalaciones'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM instalaciones)
    );


-- =============================================================================
-- 3. Desde qué dispositivos entra cada uno
-- =============================================================================
-- El punto 4 pide detectar el acceso desde una IP nueva. Para saber cuál es
-- nueva hay que saber cuáles son viejas.
CREATE TABLE IF NOT EXISTS usuario_dispositivos (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id     UUID NOT NULL REFERENCES usuarios_sistema(id) ON DELETE CASCADE,

    ip             VARCHAR(45) NOT NULL,
    user_agent     TEXT,

    -- Cuántas veces y cuándo. `primera_vez` es lo que convierte esto en una
    -- señal: una IP que aparece hoy por primera vez a las 3 de la mañana dice
    -- algo; la de siempre, no.
    primera_vez    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ultima_vez     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accesos        INT NOT NULL DEFAULT 1,

    UNIQUE (usuario_id, ip)
);

CREATE INDEX IF NOT EXISTS idx_dispositivos_usuario
    ON usuario_dispositivos (usuario_id, ultima_vez DESC);

ALTER TABLE usuario_dispositivos ENABLE ROW LEVEL SECURITY;

-- Solo lo lee quien audita. Un vendedor viendo desde qué IPs entra el resto del
-- equipo no aporta nada y sí ayuda a quien quiera hacerse pasar por otro.
DROP POLICY IF EXISTS usuario_dispositivos_lectura ON usuario_dispositivos;
CREATE POLICY usuario_dispositivos_lectura ON usuario_dispositivos
    FOR SELECT TO authenticated
    USING (cartera_completa() OR usuario_id = mi_legajo_id());

-- Escribe el middleware, que es el único que ve la IP real.


-- =============================================================================
-- 4. Consultas de auditoría
-- =============================================================================
-- Lo que hace falta para el punto 4: poder detectar comportamiento anormal
-- después. Van como vistas para que la pregunta se escriba una vez.

-- Quién miró qué, con todo el contexto en una fila.
DROP VIEW IF EXISTS v_auditoria;
CREATE VIEW v_auditoria WITH (security_invoker = true) AS
SELECT
    a.*,
    u.rol       AS rol_actual,
    u.activo    AS usuario_activo,
    -- ¿Esa IP era conocida cuando pasó esto? Es lo que separa "entró de su casa"
    -- de "alguien entró con su usuario desde otro lado".
    EXISTS (
        SELECT 1 FROM usuario_dispositivos d
         WHERE d.usuario_id = a.usuario_id AND d.ip = a.ip
           AND d.primera_vez < a.creado_en - INTERVAL '1 minute'
    ) AS ip_conocida
FROM auditoria_sistema a
LEFT JOIN usuarios_sistema u ON u.id = a.usuario_id;

-- Los movimientos que valen la pena mirar.
--
-- No es una alarma automática: es la lista corta que alguien revisa. Un sistema
-- que dispara alertas solo termina ignorado a la tercera falsa.
DROP VIEW IF EXISTS v_auditoria_señales;
CREATE VIEW v_auditoria_señales WITH (security_invoker = true) AS
SELECT
    a.usuario_id,
    a.usuario_nombre,
    a.usuario_rol,
    DATE(a.creado_en)                                   AS dia,
    COUNT(*)                                            AS acciones,
    COUNT(DISTINCT a.entidad_id)                        AS registros_distintos,
    COUNT(DISTINCT a.ip)                                AS ips,
    COUNT(*) FILTER (WHERE a.accion LIKE '%ver_documento%') AS documentos_abiertos,
    MIN(a.creado_en)                                    AS desde,
    MAX(a.creado_en)                                    AS hasta
FROM auditoria_sistema a
WHERE a.usuario_id IS NOT NULL
GROUP BY a.usuario_id, a.usuario_nombre, a.usuario_rol, DATE(a.creado_en);

COMMENT ON VIEW v_auditoria_señales IS
    'Resumen diario por usuario. Muchos registros distintos en un día, o varias IPs, es lo que hay que mirar.';


-- =============================================================================
-- Lo que esta migración NO puede hacer, y conviene saberlo
-- =============================================================================
-- El punto 4 pide registrar cuando un vendedor CONSULTA un cliente o hace una
-- búsqueda. Eso se registra desde la aplicación, y hay que decir con claridad
-- hasta dónde llega:
--
--   · Las acciones hechas desde las pantallas quedan registradas. Sirve para
--     detectar a quien abre trescientas fichas en una tarde.
--
--   · Una consulta hecha a mano contra PostgREST —con el token, desde la
--     consola— NO deja rastro en `auditoria_sistema`. Postgres puede auditar
--     escrituras con triggers, pero no lecturas fila por fila sin una carga que
--     no vale la pena.
--
-- Por eso el control de fondo NO es la auditoría: es RLS. Lo que un vendedor no
-- puede leer, no lo lee ni desde la pantalla ni desde la consola. La auditoría
-- sirve para lo que sí puede ver: si abre de a una todas las fichas que le
-- corresponden, eso queda registrado y se nota.
--
-- Decir que "todo acceso queda auditado" sería falso, y peor: daría una
-- sensación de control que no existe.
--
-- Lo que SÍ es completo y del lado del servidor: cada inicio de sesión con su
-- IP y su dispositivo, y toda escritura sobre usuarios, permisos, cobranzas,
-- inventario y expedientes.


-- =============================================================================
-- Revertir
-- =============================================================================
--   DROP POLICY IF EXISTS tickets_acceso ON tickets;
--   CREATE POLICY tickets_autenticados ON tickets FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);
--   (mismo patrón para ticket_eventos y ticket_adjuntos)
--
--   Y para los buckets, volver a la política amplia:
--   DROP POLICY IF EXISTS "documentos_leer" ON storage.objects;
--   CREATE POLICY "documentos_leer" ON storage.objects
--       FOR SELECT TO authenticated USING (bucket_id = 'documentos');
