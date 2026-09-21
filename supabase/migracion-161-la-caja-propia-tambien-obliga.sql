-- =============================================================================
-- Migración 161 — Tener caja propia también obliga a usarla
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El agujero ──
--
-- La 159 impide cobrar contra la caja DE OTRO, y eso funciona. Pero deja pasar
-- algo que es el mismo problema: cobrar contra la caja de la OFICINA teniendo
-- una propia.
--
-- La caja de la oficina no tiene dueño, así que la comprobación —"¿esta caja es
-- de otra persona?"— no se dispara. Visto en una prueba de verdad, con el punto
-- de recaudación recién creado:
--
--   cobrar $12 de una factura de $20 : rechazado
--   cobrar en la caja de la oficina  : PASÓ      ← no debía
--   cobrar los $20 completos         : pasó
--
-- La pantalla ya no ofrece esa caja —`cajas_del_usuario` la excluye para quien
-- tiene la suya— pero eso es cortesía, no control: quien escribe la fila directo
-- la mete igual, y el arqueo de la oficina cierra con plata que es de otro.
--
-- ── La regla, completa ──
--
-- Un cobro en efectivo entra a una caja que le corresponda a quien cobra. Es la
-- MISMA lista que ofrece la pantalla, y por eso se usa la misma función: si la
-- pantalla y la base tuvieran cada una su criterio, el día que se separen la
-- pantalla ofrecería una caja que la base rechaza — y el cajero no tendría forma
-- de entender por qué.
-- =============================================================================

CREATE OR REPLACE FUNCTION validar_cuenta_del_pago()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tipo   TEXT;
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

    -- Lo electrónico deja rastro en algún lado, y hay que decir en cuál.
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

    -- Y el efectivo va a caja.
    IF NEW.forma_pago = 'efectivo' AND v_tipo IS NOT NULL AND v_tipo <> 'efectivo' THEN
        RAISE EXCEPTION
            'El efectivo entra a caja, no a "%". Elegí una cuenta de tipo efectivo.',
            v_nombre
            USING ERRCODE = 'check_violation';
    END IF;

    /**
     * La caja tiene que ser una de las suyas.
     *
     * Reemplaza a la comprobación de la 159, que solo miraba si la caja era de
     * OTRO: la de la oficina no es de nadie, así que se colaba.
     *
     * Se pregunta con la misma función que usa la pantalla para ofrecer. Un cobro
     * hecho por un proceso del sistema —una importación, la carga del histórico—
     * no tiene usuario y no se valida: bloquearlo dejaría la migración del padrón
     * sin poder cargar los pagos viejos.
     */
    IF v_tipo = 'efectivo' AND NEW.created_by IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM usuarios_sistema WHERE auth_id = NEW.created_by)
           AND NOT EXISTS (
               SELECT 1 FROM cajas_del_usuario(NEW.created_by) c WHERE c.id = NEW.cuenta_id
           )
        THEN
            RAISE EXCEPTION
                'La caja "%" no es la tuya. Cobrá contra la tuya: si no tenés, pedila en Ajustes.',
                v_nombre
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

COMMENT ON FUNCTION validar_cuenta_del_pago IS
    'Impide que el efectivo entre a una cuenta bancaria, que un cobro electrónico quede sin cuenta, y que alguien cobre contra una caja que no le corresponde —la de otro, o la de la oficina teniendo la suya—. Usa la misma función que la pantalla para decidir cuáles le corresponden.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Las cajas que le tocan a alguien:
--   SELECT * FROM cajas_del_usuario('<auth_id>');
--
--   -- Y que ya no pueda cobrar en otra:
--   INSERT INTO pagos (client_id, monto, forma_pago, cuenta_id, fecha_pago, created_by)
--   VALUES ('<cliente>', 10, 'efectivo', '<caja ajena>', CURRENT_DATE, '<auth_id>');
--   -- ERROR: La caja "Caja Oficina" no es la tuya.
