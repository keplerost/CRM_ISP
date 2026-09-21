-- =============================================================================
-- Migración 134 — El pago reconecta al instante
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que estaba mal ──
--
-- La 133 dejó la reconexión en una revisión cada diez minutos. No alcanza. El
-- abonado paga en la ventanilla, se queda mirando el teléfono, y espera. Diez
-- minutos con el comprobante en la mano son diez minutos de desconfianza — y
-- los sistemas que reemplazamos lo hacen en segundos.
--
-- ── Por qué una cola y no llamar al router desde la pantalla ──
--
-- Porque hay varios lugares donde se cobra —la ficha del abonado, la caja, el
-- buscador de pagos, y mañana un botón de pago en línea— y cada uno que se
-- olvide de avisar deja un abonado cortado que pagó. Ese olvido no da error:
-- simplemente no pasa nada, y el que reclama es el abonado.
--
-- Con un disparador sobre `pagos`, da igual desde dónde se cobre. Incluso un
-- INSERT hecho a mano desde el editor SQL dispara la reconexión. La cola es la
-- forma de que la base —que no puede hablarle al router— le pida al middleware
-- que lo haga ya.
--
-- ── Por qué la cola es una TABLA y no una notificación ──
--
-- Porque si el middleware está reiniciándose en ese momento, una notificación se
-- pierde y el abonado queda cortado hasta la próxima barrida. Una fila espera.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reconexiones_pendientes (
    id         BIGSERIAL PRIMARY KEY,
    cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    -- Qué la disparó. Sirve para entender un caso raro sin adivinar.
    motivo     VARCHAR(30) NOT NULL,

    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    procesado_en TIMESTAMPTZ,
    -- Si falló, por qué. Se conserva la fila: una reconexión que no se pudo
    -- hacer es exactamente lo que alguien tiene que poder ver.
    error        TEXT,
    intentos     INT NOT NULL DEFAULT 0
);

-- Lo pendiente se lee cada pocos segundos: tiene que ser barato.
CREATE INDEX IF NOT EXISTS idx_reconexiones_pendientes
    ON reconexiones_pendientes (creado_en) WHERE procesado_en IS NULL;

/**
 * Un abonado no puede tener dos pedidos abiertos a la vez.
 *
 * Si paga tres facturas seguidas se dispararían tres reconexiones idénticas, y
 * el middleware haría tres viajes al router para el mismo trabajo.
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconexiones_una_por_cliente
    ON reconexiones_pendientes (cliente_id) WHERE procesado_en IS NULL;

ALTER TABLE reconexiones_pendientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_reconexiones" ON reconexiones_pendientes;
CREATE POLICY "auth_all_reconexiones" ON reconexiones_pendientes
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Lo que pone el pedido en la cola
-- =============================================================================
/**
 * Pide la reconexión de un abonado, si corresponde.
 *
 * ── Por qué solo se encola al que está cortado ──
 *
 * Porque el noventa y nueve por ciento de los pagos son de gente con servicio.
 * Encolarlos a todos llenaría la cola de pedidos que no hacen nada y escondería
 * los que sí importan.
 */
CREATE OR REPLACE FUNCTION pedir_reconexion(p_cliente UUID, p_motivo TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_cliente IS NULL THEN RETURN; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM clientes WHERE id = p_cliente AND estado = 'cortado'
    ) THEN
        RETURN;
    END IF;

    INSERT INTO reconexiones_pendientes (cliente_id, motivo)
    VALUES (p_cliente, p_motivo)
    -- Ya hay un pedido abierto para este abonado: con uno alcanza.
    ON CONFLICT DO NOTHING;
END $$;


/**
 * Al registrar un pago.
 *
 * ── Por qué no se comprueba acá si el saldo quedó en cero ──
 *
 * Porque el pago y la imputación a las facturas pueden ocurrir en el mismo
 * instante y en cualquier orden, y preguntando por el saldo desde adentro del
 * disparador se puede leer el de ANTES. Se encola siempre que el abonado esté
 * cortado, y quien procesa la cola vuelve a preguntar con los datos ya
 * asentados: si todavía debe, el pedido se descarta sin tocar el router.
 */
CREATE OR REPLACE FUNCTION reconectar_al_pagar()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT NEW.anulado THEN
        PERFORM pedir_reconexion(NEW.client_id, 'pago');
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reconectar_al_pagar ON pagos;
CREATE TRIGGER trg_reconectar_al_pagar
    AFTER INSERT ON pagos
    FOR EACH ROW EXECUTE FUNCTION reconectar_al_pagar();


/**
 * Al darle una promesa de pago.
 *
 * Una promesa es el compromiso a cambio del cual se le devuelve el servicio.
 * Que eso también tarde diez minutos sería raro: el abonado está del otro lado
 * del teléfono esperando.
 */
CREATE OR REPLACE FUNCTION reconectar_al_prometer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'activa' AND NEW.fecha_promesa >= CURRENT_DATE THEN
        PERFORM pedir_reconexion(NEW.client_id, 'promesa');
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reconectar_al_prometer ON promesas_pago;
CREATE TRIGGER trg_reconectar_al_prometer
    AFTER INSERT ON promesas_pago
    FOR EACH ROW EXECUTE FUNCTION reconectar_al_prometer();


-- =============================================================================
-- Lo que el middleware consulta cada pocos segundos
-- =============================================================================
/**
 * Los pedidos que hay que atender ahora, con todo lo que hace falta para
 * hacerlo.
 *
 * Trae el bloqueo del firewall porque sin él no se sabe qué sacar del router, y
 * ya deja afuera a los que —mirado ahora, con los datos asentados— siguen
 * debiendo. Así el middleware no tiene que decidir nada: lo que aparece acá se
 * reconecta.
 */
CREATE OR REPLACE VIEW v_reconexiones_a_procesar AS
SELECT
    p.id            AS pedido_id,
    p.motivo,
    p.creado_en,
    r.cliente_id,
    r.nombre,
    r.ip,
    r.router_id,
    r.bloqueo_id,
    r.routeros_id,
    r.lista,
    r.saldo
FROM reconexiones_pendientes p
JOIN v_clientes_a_reconectar r ON r.cliente_id = p.cliente_id
WHERE p.procesado_en IS NULL
ORDER BY p.creado_en;

COMMENT ON VIEW v_reconexiones_a_procesar IS
    'Pedidos de reconexión que corresponde atender ahora. Lo que aparece acá se reconecta sin más preguntas.';


/**
 * Cierra los pedidos que ya no corresponden.
 *
 * Un abonado que pagó de menos y sigue debiendo entra a la cola y no sale por la
 * vista de arriba. Sin esto se quedaría ahí para siempre, y el día que pague el
 * resto habría dos pedidos suyos.
 */
CREATE OR REPLACE FUNCTION limpiar_reconexiones_vencidas()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cerradas INT;
BEGIN
    WITH cerrar AS (
        UPDATE reconexiones_pendientes p
           SET procesado_en = NOW(),
               error = 'Ya no correspondía: el abonado no está en condiciones de reconexión'
         WHERE p.procesado_en IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM v_clientes_a_reconectar r WHERE r.cliente_id = p.cliente_id
           )
           -- Un minuto de gracia: el pago y su imputación pueden no ser
           -- simultáneos, y cerrar el pedido antes de tiempo lo perdería.
           AND p.creado_en < NOW() - INTERVAL '1 minute'
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_cerradas FROM cerrar;

    RETURN v_cerradas;
END $$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Registrar un pago de un cortado y ver aparecer el pedido:
--   SELECT * FROM reconexiones_pendientes WHERE procesado_en IS NULL;
--
--   -- Y lo que el middleware va a atender:
--   SELECT nombre, ip, motivo, saldo FROM v_reconexiones_a_procesar;


-- =============================================================================
-- La cadencia
-- =============================================================================
-- La cola se atiende en segundos; la barrida de seguridad, cada tanto. Reemplaza
-- a `mora_reconexion_minutos` de la 133, que resultó ser demasiado lenta: diez
-- minutos con el comprobante en la mano son diez minutos de desconfianza.
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS mora_reconexion_segundos INT DEFAULT 5;
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS mora_barrida_minutos INT DEFAULT 15;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'config_tareas_reconexion_seg_check') THEN
        ALTER TABLE config_tareas ADD CONSTRAINT config_tareas_reconexion_seg_check
            CHECK (mora_reconexion_segundos IS NULL OR mora_reconexion_segundos BETWEEN 2 AND 300);
    END IF;
END $$;

COMMENT ON COLUMN config_tareas.mora_reconexion_segundos IS
    'Cada cuántos segundos se atiende la cola de reconexiones. La cola casi siempre está vacía: solo se encola a quien paga estando cortado.';
