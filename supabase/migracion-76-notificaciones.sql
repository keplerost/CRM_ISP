-- =============================================================================
-- Migración 76 — Notificaciones
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere de la 70 a la 75.
--
-- Cierra el punto 20 del requerimiento.
--
-- ── Las notificaciones que pediste no son todas de la misma clase ──
--
-- Al escribirlas se ve que son dos cosas distintas, y tratarlas igual sale mal:
--
--   CONDICIONES — "falta la foto posterior de la cédula", "contrato pendiente de
--   firma", "el cliente tiene un pago pendiente", "promesa de pago vence hoy".
--   Son ciertas o no AHORA MISMO. Guardarlas en una tabla las deja envejecer: el
--   vendedor sube la cédula y el aviso sigue ahí diciendo que falta. Y borrarlo
--   requiere acordarse de borrarlo en cada lugar que pueda resolver la condición.
--
--   HECHOS — "tu venta fue enviada a instalaciones", "instalación programada
--   para mañana", "cliente instalado correctamente". Son momentos que ocurrieron.
--   Si solo se dedujeran del estado actual no habría forma de distinguir "se
--   instaló recién" de "se instaló hace tres meses", y avisar es justamente
--   decir que ACABA de pasar.
--
-- Las condiciones se calculan. Los hechos se guardan. Y la vista los junta, para
-- que la pantalla tenga una sola fuente.
-- =============================================================================


-- =============================================================================
-- 1. Los hechos
-- =============================================================================
CREATE TABLE IF NOT EXISTS notificaciones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id  UUID NOT NULL REFERENCES usuarios_sistema(id) ON DELETE CASCADE,

    tipo        VARCHAR(30) NOT NULL,
    titulo      TEXT NOT NULL,
    detalle     TEXT,

    -- A dónde lleva al tocarla. Una notificación que no lleva a ningún lado
    -- obliga a buscar a mano lo que acaba de nombrar.
    ruta        TEXT,

    entidad     VARCHAR(40),
    entidad_id  VARCHAR(60),

    leida_en    TIMESTAMPTZ,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario
    ON notificaciones (usuario_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_notificaciones_sin_leer
    ON notificaciones (usuario_id) WHERE leida_en IS NULL;

ALTER TABLE notificaciones ENABLE ROW LEVEL SECURITY;

-- Cada uno las suyas. No hay excepción para el administrador: las
-- notificaciones de otro no le sirven de nada y son ruido en su propia campana.
DROP POLICY IF EXISTS notificaciones_propias ON notificaciones;
CREATE POLICY notificaciones_propias ON notificaciones
    FOR ALL TO authenticated
    USING (usuario_id = mi_legajo_id())
    WITH CHECK (usuario_id = mi_legajo_id());


-- =============================================================================
-- 2. Quién recibe el aviso de una instalación
-- =============================================================================
-- El vendedor que la trajo. Se resuelve por el prospecto, que es el que conserva
-- el vínculo después de que el cliente se activa.
CREATE OR REPLACE FUNCTION vendedor_de_instalacion(p_instalacion UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT vendedor_id FROM prospectos
     WHERE instalacion_id = p_instalacion AND vendedor_id IS NOT NULL
     LIMIT 1
$$;

/** Crea la notificación, sin duplicar la misma cosa dos veces. */
CREATE OR REPLACE FUNCTION notificar(
    p_usuario UUID, p_tipo TEXT, p_titulo TEXT,
    p_detalle TEXT DEFAULT NULL, p_ruta TEXT DEFAULT NULL,
    p_entidad TEXT DEFAULT NULL, p_entidad_id TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_usuario IS NULL THEN RETURN; END IF;

    -- Sin este control, reagendar una instalación tres veces manda tres avisos
    -- iguales y la campana deja de leerse. Se considera repetida la misma cosa
    -- sobre la misma entidad en el mismo día.
    IF EXISTS (
        SELECT 1 FROM notificaciones
         WHERE usuario_id = p_usuario AND tipo = p_tipo
           AND entidad_id IS NOT DISTINCT FROM p_entidad_id
           AND creado_en > NOW() - INTERVAL '1 day'
    ) THEN
        RETURN;
    END IF;

    INSERT INTO notificaciones (usuario_id, tipo, titulo, detalle, ruta, entidad, entidad_id)
    VALUES (p_usuario, p_tipo, p_titulo, p_detalle, p_ruta, p_entidad, p_entidad_id);
END $$;


-- =============================================================================
-- 3. Los disparadores
-- =============================================================================
CREATE OR REPLACE FUNCTION notificar_expediente_enviado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_vendedor UUID; v_cliente TEXT;
BEGIN
    IF NEW.estado = 'enviado' AND OLD.estado IS DISTINCT FROM 'enviado' THEN
        SELECT p.vendedor_id, p.nombre INTO v_vendedor, v_cliente
          FROM prospectos p WHERE p.id = NEW.prospecto_id;

        PERFORM notificar(
            v_vendedor, 'venta_enviada',
            'Tu venta fue enviada a instalaciones',
            v_cliente || ' ya está en la bandeja del backoffice.',
            '/ventas/tablero', 'expediente', NEW.id::TEXT
        );
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notificar_expediente ON expedientes;
CREATE TRIGGER trg_notificar_expediente
    AFTER UPDATE OF estado ON expedientes
    FOR EACH ROW EXECUTE FUNCTION notificar_expediente_enviado();


CREATE OR REPLACE FUNCTION notificar_instalacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_vendedor UUID;
BEGIN
    IF NEW.estado IS NOT DISTINCT FROM OLD.estado THEN RETURN NEW; END IF;

    v_vendedor := vendedor_de_instalacion(NEW.id);
    IF v_vendedor IS NULL THEN RETURN NEW; END IF;

    IF NEW.estado = 'agendada' AND NEW.fecha IS NOT NULL THEN
        PERFORM notificar(
            v_vendedor, 'instalacion_programada',
            'Instalación programada',
            COALESCE(NEW.nombre, 'Tu cliente') || ' quedó agendado para el ' ||
              TO_CHAR(NEW.fecha, 'DD/MM'),
            '/ventas/tablero', 'instalacion', NEW.id::TEXT
        );

    ELSIF NEW.estado = 'hecha' THEN
        PERFORM notificar(
            v_vendedor, 'instalacion_hecha',
            'Cliente instalado correctamente',
            COALESCE(NEW.nombre, 'Tu cliente') || ' ya tiene el servicio andando.',
            '/ventas/tablero', 'instalacion', NEW.id::TEXT
        );

    ELSIF NEW.estado IN ('no_realizada', 'cancelada') THEN
        -- Esta no estaba en tu lista y la agrego: es la que más le importa al
        -- vendedor. Si el técnico fue y no se pudo instalar, el que tiene que
        -- llamar al cliente antes de que llame él es quien se lo vendió.
        PERFORM notificar(
            v_vendedor, 'instalacion_fallida',
            'No se pudo instalar',
            COALESCE(NEW.nombre, 'Tu cliente') || ': ' ||
              CASE NEW.estado WHEN 'no_realizada' THEN 'el técnico fue y no se pudo hacer'
                              ELSE 'la orden se canceló' END,
            '/ventas/tablero', 'instalacion', NEW.id::TEXT
        );
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notificar_instalacion ON instalaciones;
CREATE TRIGGER trg_notificar_instalacion
    AFTER UPDATE OF estado ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION notificar_instalacion();


-- =============================================================================
-- 4. Todo junto, para que la pantalla tenga una sola fuente
-- =============================================================================
-- Los hechos guardados + las condiciones calculadas. Las condiciones no llevan
-- `id` de notificación porque no existen como fila: se resuelven arreglando lo
-- que las causa, no marcándolas como leídas.
DROP VIEW IF EXISTS v_notificaciones;
-- Cada rama filtra por `mi_legajo_id()` explícitamente.
--
-- No alcanzaba con confiar en RLS: `v_cobros_por_gestionar` corre con privilegio
-- —tiene que hacerlo, para leer `clientes`— así que para un administrador
-- devuelve los cobros de todo el equipo. Sin el filtro acá, la campana del
-- administrador se llenaría de los avisos de cada vendedor.
CREATE VIEW v_notificaciones WITH (security_invoker = true) AS

-- ── Hechos ──
SELECT
    n.id::TEXT      AS clave,
    n.usuario_id,
    n.tipo,
    n.titulo,
    n.detalle,
    n.ruta,
    n.creado_en,
    (n.leida_en IS NOT NULL) AS leida,
    TRUE            AS se_puede_marcar,
    -- Urgencia: 0 pide acción hoy, 1 es informativo.
    CASE WHEN n.tipo = 'instalacion_fallida' THEN 0 ELSE 1 END AS urgencia
FROM notificaciones n
WHERE n.usuario_id = mi_legajo_id()
  -- Las leídas siguen tres días y después desaparecen solas. Una campana que
  -- acumula historia deja de leerse.
  AND (n.leida_en IS NULL OR n.creado_en > NOW() - INTERVAL '3 days')

UNION ALL

-- ── Condición: al expediente le falta algo ──
SELECT
    'exp-' || e.id::TEXT,
    e.vendedor_id,
    'expediente_incompleto',
    CASE
        WHEN NOT e.ok_cedula_posterior THEN 'Falta la fotografía posterior de la cédula'
        WHEN NOT e.ok_cedula_frontal   THEN 'Falta la fotografía frontal de la cédula'
        WHEN NOT e.ok_ubicacion        THEN 'Falta la ubicación del domicilio'
        WHEN NOT e.ok_fotos            THEN 'Faltan las fotos del domicilio'
        WHEN NOT e.ok_contrato         THEN 'Falta generar el contrato'
        WHEN NOT e.ok_firma            THEN 'Contrato pendiente de firma'
        ELSE 'Expediente listo para enviar'
    END,
    e.cliente,
    '/ventas/expediente/' || e.id::TEXT,
    e.creado_en,
    FALSE,
    FALSE,
    0
FROM v_expedientes e
WHERE e.estado = 'abierto' AND e.vendedor_id = mi_legajo_id()

UNION ALL

-- ── Condición: cobros y promesas ──
SELECT
    'cob-' || c.asignacion_id::TEXT,
    c.vendedor_id,
    CASE WHEN c.promesa_fecha = CURRENT_DATE THEN 'promesa_hoy' ELSE 'cobro_pendiente' END,
    CASE WHEN c.promesa_fecha = CURRENT_DATE
         THEN 'Promesa de pago vence hoy'
         ELSE 'El cliente tiene un pago pendiente que requiere tu gestión' END,
    c.cliente || ' · $' || TO_CHAR(c.saldo_pendiente, 'FM999999990.00') ||
      ' · ' || c.dias_atraso || ' días',
    '/ventas/cobranza',
    NOW(),
    FALSE,
    FALSE,
    0
FROM v_cobros_por_gestionar c
WHERE c.vendedor_id = mi_legajo_id()
  -- Solo las que piden algo hoy: el cobro recién asignado ya está en la bandeja
  -- y no necesita además una campanita.
  AND (c.promesa_fecha = CURRENT_DATE OR c.dias_atraso >= 15);

GRANT SELECT ON v_notificaciones TO authenticated;

COMMENT ON VIEW v_notificaciones IS
    'Hechos guardados + condiciones calculadas. Las condiciones no se marcan como leídas: se resuelven.';


-- =============================================================================
-- Revertir
-- =============================================================================
--   DROP TRIGGER IF EXISTS trg_notificar_instalacion ON instalaciones;
--   DROP TRIGGER IF EXISTS trg_notificar_expediente ON expedientes;
--   DROP VIEW IF EXISTS v_notificaciones;
--   DROP TABLE IF EXISTS notificaciones;
