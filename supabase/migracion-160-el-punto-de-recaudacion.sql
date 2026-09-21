-- =============================================================================
-- Migración 160 — El punto de recaudación
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué es ──
--
-- La tienda del barrio, el corresponsal, el local que cobra el internet. Recibe
-- efectivo, imprime el comprobante del sistema, y después deposita lo recaudado.
--
-- No es un cajero de la oficina y por eso no alcanzaba el rol que ya había: el
-- cajero emite facturas, consulta estados de cuenta y cobra montos parciales.
-- Un punto de recaudación hace UNA cosa —cobrar lo que se debe, completo— y
-- todo lo demás que pueda hacer es superficie para equivocarse.
--
-- ── Lo que puede y lo que no ──
--
--   PUEDE   buscar un abonado por nombre, cédula o contrato, y cobrarle.
--           Imprimir el comprobante. Ver lo que él mismo recaudó.
--
--   NO PUEDE  abrir el padrón —no navega la cartera, la busca—, cobrar montos
--           parciales, editar una factura, un nombre ni nada. Ver lo que
--           recaudaron los demás.
--
-- ── El dinero ──
--
-- Entra a SU caja, la que le asigna la 159. Ahí queda hasta que deposita, y ese
-- depósito aparece en el extracto del banco —"DEP CNB" y el RUC del local— donde
-- la conciliación lo cruza. Así, en todo momento se sabe cuánto tiene cada punto
-- sin depositar.
-- =============================================================================

/**
 * El rol nuevo.
 *
 * Se recrea la restricción entera porque un CHECK no se puede "ampliar": se
 * borra y se vuelve a poner con la lista completa.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'usuarios_sistema'::regclass
           AND conname = 'usuarios_sistema_rol_valido'
           AND pg_get_constraintdef(oid) LIKE '%recaudacion%'
    ) THEN
        RAISE NOTICE 'El rol recaudacion ya está permitido: no se toca.';
        RETURN;
    END IF;

    ALTER TABLE usuarios_sistema DROP CONSTRAINT IF EXISTS usuarios_sistema_rol_valido;
    ALTER TABLE usuarios_sistema ADD CONSTRAINT usuarios_sistema_rol_valido CHECK (rol IN (
        'super_admin', 'admin', 'finanzas', 'cobrador',
        'cajero', 'vendedor', 'supervisor', 'tecnico', 'bodega',
        'recaudacion'
    ));
END $guarda$;


-- =============================================================================
-- Lo que ve en su pantalla
-- =============================================================================
/**
 * Cuánto lleva recaudado quien está mirando.
 *
 * ── Por qué es una vista y no una consulta en la pantalla ──
 *
 * Porque el punto de recaudación tiene que poder comparar su número con el del
 * administrador, y los dos tienen que salir de la misma cuenta. Si la pantalla
 * sumara por su lado, cualquier diferencia de criterio —incluir o no los
 * anulados, contar por fecha de pago o por fecha de registro— aparecería como
 * plata faltante en una discusión donde nadie se equivocó.
 *
 * `security_invoker` para que `auth.uid()` sea el de la sesión y no el del dueño
 * de la vista: sin eso, todos verían la recaudación de la misma persona.
 */
CREATE OR REPLACE VIEW v_mi_recaudacion WITH (security_invoker = true) AS
SELECT
    COUNT(*) FILTER (WHERE p.fecha_pago = CURRENT_DATE AND NOT p.anulado) AS cobros_hoy,
    COALESCE(SUM(p.monto) FILTER (WHERE p.fecha_pago = CURRENT_DATE AND NOT p.anulado), 0) AS hoy,
    COUNT(*) FILTER (WHERE NOT p.anulado) AS cobros_total,
    COALESCE(SUM(p.monto) FILTER (WHERE NOT p.anulado), 0) AS total,
    /**
     * Lo anulado se muestra siempre, aunque sea cero.
     *
     * Es la respuesta a "imprimí diez comprobantes y entrego el valor de nueve".
     * Sin ese número, la diferencia parece un faltante de caja.
     */
    COUNT(*) FILTER (WHERE p.anulado AND p.fecha_pago = CURRENT_DATE) AS anulados_hoy,
    COALESCE(SUM(p.monto) FILTER (WHERE p.anulado AND p.fecha_pago = CURRENT_DATE), 0) AS anulado_hoy,
    MIN(p.fecha_pago) AS desde
FROM pagos p
WHERE p.created_by = auth.uid();

COMMENT ON VIEW v_mi_recaudacion IS
    'Lo que recaudó quien está mirando: hoy y en total. Sale de la misma cuenta que el cierre del administrador, para que los dos números se puedan comparar sin discutir el criterio.';


-- =============================================================================
-- Que solo pueda cobrar el total
-- =============================================================================
/**
 * Un punto de recaudación no negocia montos.
 *
 * ── Por qué en la base y no solo en la pantalla ──
 *
 * Porque es la regla que más tienta a saltarse: el abonado dice "solo tengo
 * veinte" y el del local lo carga igual con tal de no perder la venta. El
 * resultado es una factura a medio pagar que el abonado cree cancelada, y un
 * corte que llega igual.
 *
 * Se aplica solo al rol de recaudación: el cajero de la oficina SÍ puede tomar
 * un abono, porque tiene con quién consultarlo y puede registrar una promesa.
 */
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
     * Las filas hijas de un cobro repartido no se validan.
     *
     * Un cobro de $40 que salda dos facturas de $20 genera dos filas de $20
     * cada una, y ninguna "cubre el saldo" de la factura mirada por separado.
     * Lo que importa es que el abonado entregó todo lo que debía, y eso ya lo
     * garantiza la fila principal.
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
    'Impide que un punto de recaudación registre un abono parcial. El cajero de la oficina sí puede: tiene con quién consultarlo y puede dejar una promesa de pago.';

DROP TRIGGER IF EXISTS trg_cobro_recaudacion ON pagos;
CREATE TRIGGER trg_cobro_recaudacion
    BEFORE INSERT ON pagos
    FOR EACH ROW EXECUTE FUNCTION validar_cobro_de_recaudacion();


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Lo que ve el punto de recaudación en su pantalla:
--   SELECT * FROM v_mi_recaudacion;
--
--   -- Y lo mismo desde el lado del administrador, que tiene que dar igual:
--   SELECT COUNT(*), SUM(cobrado) FROM v_transacciones
--    WHERE operador_id = '...' AND fecha_pago = CURRENT_DATE AND NOT anulado;
