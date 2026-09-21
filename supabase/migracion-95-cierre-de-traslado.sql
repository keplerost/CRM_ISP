-- =============================================================================
-- Migración 95 — El traslado se cierra solo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué faltaba ──
--
-- La 94 abre el traslado y el middleware da de baja la ONT vieja al autorizar
-- en el destino. Pero nadie marcaba el traslado como terminado: quedaba
-- `abierto` para siempre, invisible —sale de la cola en cuanto la baja está
-- hecha— y con una consecuencia que recién aparece meses después.
--
-- `iniciar_traslado()` no deja abrir un segundo traslado mientras haya uno
-- abierto. Eso es correcto: dos fotos del origen, y la segunda sacada con el
-- servicio a medio mover, sería guardar datos falsos. Pero significa que un
-- abonado que se mudó una vez NO PODRÍA VOLVER A MUDARSE, y el mensaje diría
-- "ya tiene un traslado en curso" para uno que terminó hace medio año.
--
-- ── Por qué un disparador y no una línea más en la función de cierre ──
--
-- Porque una orden de traslado se puede marcar como hecha por más de un camino:
-- `finalizar_alta_instalacion()` desde el asistente, o un UPDATE directo desde
-- la pantalla de órdenes. Si el cierre viviera en la función, el segundo camino
-- dejaría el traslado abierto y el abonado trabado igual.
--
-- ── Lo que NO cierra ──
--
-- Un traslado cuya ONT vieja siga viva. Eso lo impide el CHECK de la 94 y está
-- bien que lo impida: mientras haya un equipo colgado en la OLT de origen, el
-- trabajo no terminó. Se queda abierto y visible en la cola hasta que alguien
-- lo resuelva.
-- =============================================================================


CREATE OR REPLACE FUNCTION traslado_se_cierra()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.tipo <> 'traslado' OR NEW.estado <> 'hecha' THEN
        RETURN NEW;
    END IF;

    -- Solo los que ya no tienen nada colgado en la OLT de origen. El resto
    -- sigue abierto a propósito: es trabajo pendiente, no papeleo.
    UPDATE traslados
       SET estado     = 'hecho',
           cerrado_en = COALESCE(cerrado_en, NOW())
     WHERE instalacion_id = NEW.id
       AND estado = 'abierto'
       AND pendiente_baja = FALSE;

    -- Una orden de traslado cancelada tampoco puede dejar al abonado trabado
    -- para siempre. Se cancela el traslado con ella.
    RETURN NEW;
END $$;

COMMENT ON FUNCTION traslado_se_cierra IS
    'Al marcar hecha una orden de traslado, cierra el traslado correspondiente — salvo que la ONT del domicilio anterior siga autorizada.';

DROP TRIGGER IF EXISTS trg_traslado_cierra ON instalaciones;
CREATE TRIGGER trg_traslado_cierra
    AFTER INSERT OR UPDATE OF estado ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION traslado_se_cierra();


-- =============================================================================
-- Y la orden cancelada
-- =============================================================================
-- Si la mudanza no se hizo —el abonado se arrepintió, no había factibilidad—,
-- el traslado se cancela con su orden. Sin esto queda abierto y bloquea el
-- próximo intento, que es justo el caso en que más rápido se vuelve a intentar.
--
-- Va aparte del anterior porque son dos reglas distintas y mezclarlas en una
-- sola función haría que leer cualquiera de las dos obligue a entender la otra.
CREATE OR REPLACE FUNCTION traslado_se_cancela()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.tipo <> 'traslado' OR NEW.estado <> 'cancelada' THEN
        RETURN NEW;
    END IF;

    UPDATE traslados
       SET estado       = 'cancelado',
           cerrado_en   = COALESCE(cerrado_en, NOW()),
           -- La ONT del domicilio viejo sigue donde estaba y tiene que seguir:
           -- el abonado no se mudó. Se deja de reclamar la baja porque no hay
           -- ninguna baja que hacer.
           pendiente_baja = FALSE,
           baja_detalle = COALESCE(baja_detalle, 'El traslado se canceló: el abonado no se mudó.')
     WHERE instalacion_id = NEW.id
       AND estado = 'abierto';

    RETURN NEW;
END $$;

COMMENT ON FUNCTION traslado_se_cancela IS
    'Al cancelar una orden de traslado, cancela el traslado: el abonado no se mudó, así que no hay ninguna ONT que dar de baja.';

DROP TRIGGER IF EXISTS trg_traslado_cancela ON instalaciones;
CREATE TRIGGER trg_traslado_cancela
    AFTER UPDATE OF estado ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION traslado_se_cancela();


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Con la baja hecha, cerrar la orden cierra el traslado:
--   UPDATE traslados SET pendiente_baja = FALSE WHERE id = '<traslado>';
--   UPDATE instalaciones SET estado = 'hecha'   WHERE id = '<orden>';
--   SELECT estado, cerrado_en FROM traslados WHERE id = '<traslado>';   -- 'hecho'
--
--   -- Con la ONT vieja todavía viva, NO se cierra:
--   SELECT estado FROM traslados WHERE pendiente_baja;                  -- 'abierto'
