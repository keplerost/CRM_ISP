-- =============================================================================
-- Migración 193 — La pausa por viaje
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- El abonado que se va de vacaciones un mes y pide que le paren el servicio.
-- Hasta ahora la ficha solo ofrecía "Suspender servicio" —que lo deja como
-- CORTADO, o sea moroso— y "Dar de baja", que lo saca del sistema.
--
-- Ninguna de las dos sirve: la primera lo trata como si debiera plata, y como
-- los cortados SÍ se facturan, al volver del viaje se encuentra con la factura
-- del mes que no usó. La segunda lo borra de la cartera y pierde su historia.
--
-- El estado `suspendido` ya existía en el modelo desde la migración 02, pero
-- ninguna pantalla lo producía: solo llegaba importando un secret deshabilitado
-- desde un router.
--
-- ── Lo que se agrega ──
--
-- El motivo y hasta cuándo. Sin el motivo, dentro de dos meses nadie se acuerda
-- de por qué ese abonado está pausado ni si corresponde cobrarle.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Por qué y hasta cuándo
-- -----------------------------------------------------------------------------

/**
 * Por qué se pausó.
 *
 * Libre a propósito: "viaje hasta el 15", "obra en la casa", "pidió parar
 * mientras arregla el techo". Una lista cerrada obliga a elegir mal el día que
 * aparece el caso que no estaba previsto, y lo que importa acá es poder
 * reconstruir la conversación dos meses después.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS suspendido_motivo TEXT,
    ADD COLUMN IF NOT EXISTS suspendido_hasta  DATE;

COMMENT ON COLUMN clientes.suspendido_motivo IS
    'Por qué se pausó el servicio. Uso interno: no sale en factura ni contrato.';
COMMENT ON COLUMN clientes.suspendido_hasta IS
    'Hasta cuándo se acordó la pausa. Informativo: la reactivación es manual.';


-- -----------------------------------------------------------------------------
-- 2. Que la ficha pueda verlas
-- -----------------------------------------------------------------------------
-- `v_clientes_ficha` no hereda las columnas nuevas: su `SELECT c.*` se expandió
-- a una lista fija el día que se creó. Mismo patrón que la 144 y la 192 —
-- envolver la definición actual y sumar las columnas al final—. Agregarlas a la
-- tabla y no a la vista las dejaría invisibles sin ningún error.

DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'suspendido_motivo'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone la pausa: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS '
         || 'SELECT v.*, sp.suspendido_motivo, sp.suspendido_hasta '
         || 'FROM (' || rtrim(pg_get_viewdef('v_clientes_ficha'::regclass, true), ';') || ') v '
         || 'JOIN clientes sp ON sp.id = v.id';
    RAISE NOTICE 'v_clientes_ficha expone el motivo y la fecha de la pausa.';
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Quién está pausado y hasta cuándo:
--   SELECT nombre, estado, suspendido_motivo, suspendido_hasta
--     FROM clientes WHERE estado = 'suspendido' ORDER BY suspendido_hasta;
--
--   -- Los que ya deberían haber vuelto:
--   SELECT nombre, suspendido_hasta
--     FROM clientes
--    WHERE estado = 'suspendido' AND suspendido_hasta < CURRENT_DATE;
--   -- si sale alguno, está sin servicio y sin facturar de más: hay que
--   -- reactivarlo a mano desde su ficha.
