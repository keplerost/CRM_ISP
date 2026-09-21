-- =============================================================================
-- Migración 166 — El punto de recaudación cobra en efectivo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Por qué ──
--
-- La plata se la entregan en la mano. Un punto de recaudación no tiene con qué
-- verificar una transferencia: no ve el extracto del banco ni la cuenta del ISP.
--
-- Dejarle registrar "transferencia" abre dos puertas, y las dos terminan mal:
--
--   Puede anotar un cobro que nunca entró y quedarse con el efectivo. El abonado
--   figura al día, la plata no está, y recién se descubre conciliando.
--
--   O puede equivocarse de buena fe, y ese comprobante aparece en la conciliación
--   como "sin respaldo" — mandando a llamar a un abonado que sí pagó.
--
-- ── Dónde está la regla ──
--
-- En la pantalla, que solo le ofrece Efectivo; y acá, que es lo que la sostiene
-- cuando alguien llama a la base por otro camino. Se agrega a la validación que
-- ya existe para el cobro parcial, en vez de crear otro disparador: dos sobre lo
-- mismo se ejecutan en orden alfabético y el mensaje que ve el cajero dependería
-- de cuál falle primero.
-- =============================================================================

CREATE OR REPLACE FUNCTION validar_cobro_de_recaudacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rol   TEXT;
    v_saldo NUMERIC;
BEGIN
    IF NEW.anulado OR NEW.created_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT rol INTO v_rol FROM usuarios_sistema WHERE auth_id = NEW.created_by;
    IF v_rol IS DISTINCT FROM 'recaudacion' THEN
        RETURN NEW;
    END IF;

    /**
     * Solo efectivo.
     *
     * Se comprueba antes que el monto: si alguien intenta registrar una
     * transferencia parcial, el mensaje que le sirve es este —"no podés cobrar
     * así"— y no el del monto, que lo mandaría a corregir la cifra de un cobro
     * que igual no puede hacer.
     */
    IF NEW.forma_pago <> 'efectivo' THEN
        RAISE EXCEPTION
            'Un punto de recaudación cobra solo en efectivo. Para registrar % hace falta el permiso correspondiente.',
            NEW.forma_pago
            USING ERRCODE = 'check_violation';
    END IF;

    /**
     * Las filas hijas de un cobro repartido no se validan por monto.
     *
     * Un cobro de $40 que salda dos facturas de $20 genera dos filas de $20 cada
     * una, y ninguna "cubre el saldo" de la factura mirada por separado. Lo que
     * importa es que el abonado entregó todo lo que debía, y eso ya lo garantiza
     * la fila principal.
     *
     * La forma de pago sí se valida en todas: si la principal es efectivo, las
     * hijas también lo son.
     */
    IF NEW.es_reparto OR NEW.es_excedente OR NEW.pago_origen_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.factura_id IS NOT NULL THEN
        SELECT saldo INTO v_saldo FROM v_facturas WHERE id = NEW.factura_id;

        -- Un centavo de tolerancia: el redondeo del IVA no puede impedir un cobro.
        IF v_saldo IS NOT NULL AND NEW.monto < v_saldo - 0.01 THEN
            RAISE EXCEPTION
                'Un punto de recaudación cobra el valor completo. Esta factura debe % y se está registrando %.',
                TO_CHAR(v_saldo, 'FM999999990.00'), TO_CHAR(NEW.monto, 'FM999999990.00')
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

COMMENT ON FUNCTION validar_cobro_de_recaudacion IS
    'Un punto de recaudación cobra solo en efectivo y solo el valor completo. Las dos reglas están también en la pantalla; esta es la que las sostiene cuando se llama a la base por otro camino.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Con el auth_id de un punto de recaudación, esto tiene que fallar:
--   INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago, created_by)
--   VALUES ('<abonado>', 20, 'transferencia', '<cuenta>', CURRENT_DATE, '<su auth_id>');
--   -- ERROR: Un punto de recaudación cobra solo en efectivo.
