-- =============================================================================
-- Migración 155 — La auditoría no puede bloquear el cobro
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- URGENTE: sin esto no se puede cobrar desde la pantalla.
--
-- ── El error, tal como lo ve la cajera ──
--
--   new row violates row-level security policy for table "audit_logs"
--
-- Y no se guarda nada: el cobro entero se deshace.
--
-- ── Por qué pasa ──
--
-- `audit_logs` tiene RLS con UNA sola política, de lectura:
--
--   CREATE POLICY audit_logs_lectura ON audit_logs FOR SELECT TO authenticated
--
-- Eso es a propósito y está bien: una bitácora que se puede escribir a mano no
-- sirve como bitácora. Lo que falta es que el disparador que la llena no esté
-- sujeto a esa restricción.
--
-- `audit_cambios()` se declaró `LANGUAGE plpgsql` y nada más, así que corre con
-- los permisos de QUIEN dispara el cambio. Desde la pantalla eso es el rol
-- `authenticated`, que no tiene permiso de INSERT — y el INSERT de la auditoría
-- aborta la transacción del cobro.
--
-- ── Por qué no se había visto ──
--
-- Porque todo lo que veníamos probando —facturación, cortes, pagos de prueba—
-- entra por el middleware, que usa el rol de servicio y se salta RLS. El camino
-- que falla es exactamente el que usa una persona: cobrar desde la pantalla.
--
-- Cinco tablas disparan esta función: pagos, facturas, promesas_pago, clientes y
-- comunicaciones. O sea que estaba bloqueado cobrar, anular una factura, dar una
-- promesa y editar la ficha de un abonado.
--
-- ── La corrección ──
--
-- `SECURITY DEFINER`: el disparador escribe con los permisos de su dueño, que es
-- el dueño de la tabla. La bitácora sigue siendo de solo lectura para todos los
-- demás —nadie puede insertarle una fila a mano— y el sistema puede escribirla.
--
-- Es el mismo patrón que usan todas las demás funciones del sistema. Esta era la
-- única que se había quedado afuera.
--
-- No se cambia NADA del cuerpo: se repite tal cual para poder agregarle las dos
-- líneas de la declaración.
-- =============================================================================

CREATE OR REPLACE FUNCTION audit_cambios()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_antes   JSONB := '{}'::JSONB;
    v_despues JSONB := '{}'::JSONB;
    v_actor   RECORD;
    v_cliente UUID;
    v_id      UUID;
    v_accion  TEXT;
    v_campos  TEXT[] := COALESCE(TG_ARGV, ARRAY[]::TEXT[]);
    k         TEXT;
BEGIN
    SELECT * INTO v_actor FROM audit_actor() LIMIT 1;

    IF TG_OP = 'DELETE' THEN
        v_accion  := 'eliminar';
        v_antes   := to_jsonb(OLD);
        v_id      := OLD.id;
    ELSIF TG_OP = 'INSERT' THEN
        v_accion  := 'crear';
        v_despues := to_jsonb(NEW);
        v_id      := NEW.id;
    ELSE
        v_accion := 'modificar';
        v_id     := NEW.id;

        -- Solo los campos que cambiaron. Si se declararon campos en el
        -- disparador, únicamente esos: en `clientes` interesan la IP, el plan y
        -- el estado, no que se haya tocado `updated_at`.
        FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW))
        LOOP
            CONTINUE WHEN k IN ('updated_at', 'created_at');
            CONTINUE WHEN CARDINALITY(v_campos) > 0 AND NOT (k = ANY(v_campos));
            IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
                v_antes   := v_antes   || jsonb_build_object(k, to_jsonb(OLD) -> k);
                v_despues := v_despues || jsonb_build_object(k, to_jsonb(NEW) -> k);
            END IF;
        END LOOP;

        -- Nada que registrar: un UPDATE que no cambió ninguno de los campos
        -- vigilados solo ensuciaría la bitácora.
        IF v_despues = '{}'::JSONB THEN
            RETURN NULL;
        END IF;
    END IF;

    -- De qué abonado es. Las tablas que no lo tienen quedan sin cliente.
    BEGIN
        v_cliente := COALESCE(
            (to_jsonb(COALESCE(NEW, OLD)) ->> 'client_id')::UUID,
            CASE WHEN TG_TABLE_NAME = 'clientes' THEN v_id END
        );
    EXCEPTION WHEN OTHERS THEN
        v_cliente := NULL;
    END;

    INSERT INTO audit_logs (
        categoria, accion, entidad, entidad_id, client_id,
        antes, despues, actor_id, actor_email, ip_origen
    )
    VALUES (
        TG_TABLE_NAME, v_accion, TG_TABLE_NAME, v_id, v_cliente,
        NULLIF(v_antes, '{}'::JSONB), NULLIF(v_despues, '{}'::JSONB),
        v_actor.id, v_actor.email, NULLIF(v_actor.ip, '')
    );

    RETURN NULL;
END $$;

COMMENT ON FUNCTION audit_cambios IS
    'Disparador genérico de auditoría. SECURITY DEFINER porque audit_logs es de solo lectura para authenticated: sin eso, cualquier cobro hecho desde la pantalla aborta con "new row violates row-level security policy".';


/**
 * Y `audit_actor`, por la misma razón que la de arriba pero al revés.
 *
 * Solo lee los ajustes de la sesión, así que no necesita permisos de nadie —pero
 * sin `search_path` fijo queda expuesta a que alguien defina un `audit_actor` en
 * un esquema propio y lo haga resolver primero. Es la práctica del resto del
 * sistema y esta también se había quedado afuera.
 */
CREATE OR REPLACE FUNCTION audit_actor()
RETURNS TABLE (id UUID, email TEXT, ip TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY SELECT
        NULLIF(current_setting('request.jwt.claims', TRUE)::JSONB ->> 'sub', '')::UUID,
        current_setting('request.jwt.claims', TRUE)::JSONB ->> 'email',
        SPLIT_PART(
            COALESCE(current_setting('request.headers', TRUE)::JSONB ->> 'x-forwarded-for', ''),
            ',', 1
        );
EXCEPTION WHEN OTHERS THEN
    -- Fuera de PostgREST esos ajustes no existen. No es un error: es un cambio
    -- hecho por un proceso interno.
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::TEXT;
END $$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Las dos tienen que decir SECURITY DEFINER:
--   SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('audit_cambios', 'audit_actor');
--
--   -- Y la bitácora sigue sin permitir que nadie le escriba a mano:
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'audit_logs';
