-- =============================================================================
-- Migración 133 — La reconexión no espera a mañana
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- La 132 dejó el corte y la reconexión en la misma corrida diaria. Para el corte
-- está bien: es una decisión que se toma una vez por día, de madrugada.
--
-- Para la reconexión no. El abonado que paga a las nueve de la mañana recupera
-- el servicio a las cinco de la mañana SIGUIENTE: veinte horas sin internet
-- después de haber cumplido. Es peor que el corte — el corte al menos tiene una
-- explicación que se le puede dar por teléfono.
--
-- ── Por qué no se dispara al registrar el pago ──
--
-- Sería lo ideal, y no se puede hoy: los pagos se registran desde el navegador
-- directo contra la base, sin pasar por el middleware, y la base no puede
-- hablarle al router. Cambiar eso significa tocar todos los lugares donde se
-- cobra —la ficha, la caja, el buscador de pagos— y cada uno que se olvide deja
-- un abonado cortado sin que nadie lo note.
--
-- Revisar cada pocos minutos es más simple y falla mejor: si una corrida se
-- pierde, la siguiente lo arregla. La consulta es barata porque la lista está
-- vacía casi siempre.
-- =============================================================================

ALTER TABLE config_tareas
    /**
     * Cada cuánto se revisa si hay que devolver el servicio.
     *
     * Diez minutos de fábrica. Es el tiempo que un abonado espera con el
     * comprobante en la mano antes de volver a llamar, y ponerlo mucho más bajo
     * no mejora esa percepción pero sí multiplica las consultas al router.
     */
    ADD COLUMN IF NOT EXISTS mora_reconexion_minutos INT DEFAULT 10;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'config_tareas_reconexion_check') THEN
        ALTER TABLE config_tareas ADD CONSTRAINT config_tareas_reconexion_check
            CHECK (mora_reconexion_minutos IS NULL OR mora_reconexion_minutos BETWEEN 1 AND 1440);
    END IF;
END $$;

COMMENT ON COLUMN config_tareas.mora_reconexion_minutos IS
    'Cada cuántos minutos se revisa si hay que reconectar a alguien que pagó. El corte sigue siendo una vez al día; devolver el servicio no puede esperar tanto.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Quién está esperando que le devuelvan el servicio ahora mismo:
--   SELECT nombre, saldo, meses_sin_pago FROM v_clientes_a_reconectar;
--
--   -- Y con qué frecuencia se lo va a revisar:
--   SELECT mora_hora, mora_reconexion_minutos FROM config_tareas WHERE id = 1;
