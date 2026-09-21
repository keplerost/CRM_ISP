-- =============================================================================
-- Migración 158 — El efectivo va a caja, y lo electrónico exige cuenta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Los dos errores que esto impide ──
--
-- 1. Un cobro en EFECTIVO imputado a una cuenta del banco.
--
--    La pantalla ofrecía todas las cuentas sin mirar la forma de pago, así que
--    al cobrar en efectivo se elegía entre cuentas del Pichincha. Esa plata no
--    está en ningún banco: está en la caja de la oficina, en la mano de quien
--    cobró.
--
--    No es cosmético. Ese cobro aparece después en la conciliación como "sin
--    respaldo" —el banco no lo tiene, claro— y manda a llamar a un abonado que
--    pagó en ventanilla.
--
-- 2. Un cobro ELECTRÓNICO sin cuenta.
--
--    Sin cuenta no se sabe en qué extracto buscarlo. Con dos cuentas en el mismo
--    banco conciliadas juntas, la comparación da cruces que parecen buenos y no
--    lo son: el comprobante de una cuenta se empareja con el movimiento de la
--    otra.
--
-- ── Por qué va en la base y no solo en la pantalla ──
--
-- Porque la pantalla es un camino, no el único. Una importación, un script o una
-- pantalla nueva pueden escribir en `pagos` sin pasar por ahí, y la regla tiene
-- que valer igual. La pantalla ya la aplica; esto es la red debajo.
--
-- ── Qué NO hace ──
--
-- No toca los pagos que ya están. Un disparador se aplica a lo que se escribe de
-- ahora en adelante: los cobros históricos —los de las pruebas, los que se
-- importen del sistema anterior— quedan como están. Corregirlos hacia atrás
-- inventaría una cuenta que nadie eligió.
-- =============================================================================

CREATE OR REPLACE FUNCTION validar_cuenta_del_pago()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tipo TEXT;
    v_nombre TEXT;
BEGIN
    -- Los pagos anulados no se validan: anular es corregir, y exigirle la regla
    -- nueva a una corrección de un cobro viejo impediría justamente arreglarlo.
    IF NEW.anulado THEN
        RETURN NEW;
    END IF;

    IF NEW.cuenta_id IS NOT NULL THEN
        SELECT tipo, nombre INTO v_tipo, v_nombre
          FROM cuentas_pago WHERE id = NEW.cuenta_id;
    END IF;

    /**
     * Lo electrónico deja rastro en algún lado, y hay que decir en cuál.
     */
    IF NEW.forma_pago IN ('transferencia', 'deposito', 'tarjeta') THEN
        IF NEW.cuenta_id IS NULL THEN
            RAISE EXCEPTION
                'Un cobro por % tiene que decir a qué cuenta entró: sin eso no se puede conciliar con el banco.',
                NEW.forma_pago
                USING ERRCODE = 'check_violation';
        END IF;

        IF v_tipo = 'efectivo' THEN
            RAISE EXCEPTION
                'Un cobro por % no puede entrar a "%", que es una caja de efectivo.',
                NEW.forma_pago, v_nombre
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    /**
     * Y el efectivo va a caja.
     *
     * No se le exige tener cuenta —hay cobros en efectivo cargados de antes sin
     * ella y la pantalla ya la pide— pero si dice una, tiene que ser una caja.
     */
    IF NEW.forma_pago = 'efectivo' AND v_tipo IS NOT NULL AND v_tipo <> 'efectivo' THEN
        RAISE EXCEPTION
            'El efectivo entra a caja, no a "%". Elegí una cuenta de tipo efectivo.',
            v_nombre
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

COMMENT ON FUNCTION validar_cuenta_del_pago IS
    'Impide que el efectivo entre a una cuenta bancaria y que un cobro electrónico quede sin cuenta. Sin esto, los dos errores aparecen recién en la conciliación, como cobros sin respaldo.';

DROP TRIGGER IF EXISTS trg_validar_cuenta_pago ON pagos;
CREATE TRIGGER trg_validar_cuenta_pago
    BEFORE INSERT OR UPDATE OF forma_pago, cuenta_id ON pagos
    FOR EACH ROW EXECUTE FUNCTION validar_cuenta_del_pago();


-- =============================================================================
-- Que exista al menos una caja
-- =============================================================================
-- La 08 siembra "Caja Oficina". Si alguien la borró o la desactivó, cobrar en
-- efectivo se vuelve imposible desde la pantalla —no habría ninguna cuenta del
-- tipo que corresponde— y el mensaje de error no diría por qué.
INSERT INTO cuentas_pago (nombre, tipo, titular)
SELECT 'Caja Oficina', 'efectivo', NULL
 WHERE NOT EXISTS (SELECT 1 FROM cuentas_pago WHERE tipo = 'efectivo' AND activa);


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Las cajas y las cuentas de banco, que es lo que ofrece cada forma de pago:
--   SELECT nombre, tipo, activa FROM cuentas_pago ORDER BY tipo, nombre;
--
--   -- Y que la regla esté puesta:
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'pagos'::regclass AND NOT tgisinternal;
