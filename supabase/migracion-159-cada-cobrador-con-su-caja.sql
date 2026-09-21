-- =============================================================================
-- Migración 159 — Cada cobrador con su caja
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Por qué ──
--
-- Con una sola caja compartida, el efectivo de todos los que cobran cae en el
-- mismo lugar. El reporte de caja de cada uno sale mezclado con el de los demás,
-- y cuando falta plata no hay forma de saber de qué caja falta.
--
-- El cierre por operador ya se puede filtrar en la pantalla de transacciones,
-- pero eso responde "cuánto cobró Juan", no "cuánto hay en la caja de Juan". Son
-- preguntas distintas: la primera se contesta con los recibos, la segunda con el
-- dinero que se entrega. Cuadran solo cuando cada uno tiene su caja.
--
-- ── Cómo queda ──
--
--   Una caja puede tener dueño. La del dueño es la única que él ve al cobrar en
--   efectivo, y nadie más puede cobrar contra ella.
--
--   Una caja SIN dueño es de la oficina: la ven todos los que no tienen la suya.
--   Es lo que hace que esto no rompa nada el día que se corre — hoy todas las
--   cajas son así.
--
-- ── Lo que NO hace ──
--
-- No reparte las cajas solo. Quién cobra y con qué caja es una decisión de
-- quien administra, y adivinarla por el histórico de cobros pondría plata de
-- todos en la caja del que más cobró.
-- =============================================================================

ALTER TABLE cuentas_pago
    ADD COLUMN IF NOT EXISTS usuario_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL;

COMMENT ON COLUMN cuentas_pago.usuario_id IS
    'De quién es esta caja. NULL = de la oficina, la usan los que no tienen la suya. Con dueño, solo él puede cobrar contra ella.';

-- Buscar "las cajas de este usuario" es lo que hace la pantalla de cobro en cada
-- apertura: sin índice recorre la tabla entera cada vez.
CREATE INDEX IF NOT EXISTS idx_cuentas_usuario ON cuentas_pago (usuario_id) WHERE usuario_id IS NOT NULL;

/**
 * Dos cajas del mismo dueño se pueden tener —una por sucursal, por ejemplo— pero
 * no dos veces la misma. El nombre ya es único en la tabla, así que no hace falta
 * nada más acá; se deja dicho para que no se agregue una restricción que sobra.
 */


-- =============================================================================
-- Las cajas que le corresponden a cada uno
-- =============================================================================
/**
 * La regla, en un solo lugar.
 *
 * La usan la pantalla de cobro para ofrecer, y el disparador de más abajo para
 * impedir. Si vivieran separadas, el día que se separen la pantalla ofrecería una
 * caja que la base rechaza — y el cajero no tendría forma de entender por qué.
 */
CREATE OR REPLACE FUNCTION cajas_del_usuario(p_auth UUID)
RETURNS TABLE (id UUID, nombre VARCHAR, tipo VARCHAR, propia BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH yo AS (
        SELECT u.id FROM usuarios_sistema u WHERE u.auth_id = p_auth
    ),
    mias AS (
        SELECT c.id, c.nombre, c.tipo, TRUE AS propia
          FROM cuentas_pago c
         WHERE c.activa
           AND c.usuario_id = (SELECT id FROM yo)
    )
    SELECT * FROM mias
    UNION ALL
    /**
     * Las de la oficina, SOLO si no tiene ninguna propia.
     *
     * Es lo que evita la confusión que motivó todo esto: al que tiene su caja no
     * se le ofrece la general, porque el día que cobre ahí su arqueo va a cerrar
     * bien y el de la oficina mal, y nadie va a saber por qué.
     */
    SELECT c.id, c.nombre, c.tipo, FALSE
      FROM cuentas_pago c
     WHERE c.activa
       AND c.usuario_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM mias)
$$;

COMMENT ON FUNCTION cajas_del_usuario IS
    'Las cajas contra las que puede cobrar este usuario: las suyas, o las de la oficina si no tiene ninguna propia.';


/**
 * Y la vista que usa la pantalla, ya resuelta para quien esté mirando.
 *
 * `security_invoker` para que `auth.uid()` sea el del usuario de la sesión y no
 * el del dueño de la vista.
 */
CREATE OR REPLACE VIEW v_mis_cuentas_de_cobro WITH (security_invoker = true) AS
SELECT
    c.id,
    c.nombre,
    c.tipo,
    c.banco,
    c.numero,
    c.titular,
    c.usuario_id,
    -- Para que la pantalla pueda decir "tu caja" y distinguirla de la general.
    (c.usuario_id IS NOT NULL) AS propia
FROM cuentas_pago c
WHERE c.activa
  AND (
      /**
       * Las cuentas que NO son cajas las ve cualquiera.
       *
       * Una transferencia entra al banco del ISP, no a la caja de nadie: repartir
       * las cuentas bancarias por cobrador no tendría sentido y dejaría a medio
       * equipo sin poder registrar una transferencia.
       */
      c.tipo <> 'efectivo'
      OR c.id IN (SELECT id FROM cajas_del_usuario(auth.uid()))
  );

COMMENT ON VIEW v_mis_cuentas_de_cobro IS
    'Lo que la pantalla de cobro puede ofrecer a quien está mirando: todas las cuentas bancarias, y solo las cajas que le corresponden.';


-- =============================================================================
-- Que no se pueda cobrar contra la caja de otro
-- =============================================================================
/**
 * Se agrega a la validación de la 158 en vez de crear otro disparador.
 *
 * Dos disparadores sobre lo mismo se ejecutan en orden alfabético y el mensaje
 * que ve el cajero depende de cuál falle primero — que es una forma rara de
 * decidir qué error mostrar.
 */
CREATE OR REPLACE FUNCTION validar_cuenta_del_pago()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tipo   TEXT;
    v_nombre TEXT;
    v_dueno  UUID;
    v_quien  UUID;
BEGIN
    -- Los pagos anulados no se validan: anular es corregir, y exigirle la regla
    -- nueva a una corrección de un cobro viejo impediría justamente arreglarlo.
    IF NEW.anulado THEN
        RETURN NEW;
    END IF;

    IF NEW.cuenta_id IS NOT NULL THEN
        SELECT tipo, nombre, usuario_id INTO v_tipo, v_nombre, v_dueno
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
     * La caja de otro no se toca.
     *
     * Solo cuando la caja tiene dueño Y se sabe quién está cobrando. Un cobro
     * hecho por un proceso del sistema —una importación, la reconciliación de un
     * pago externo— no tiene usuario, y bloquearlo dejaría la migración del
     * padrón sin poder cargar el histórico.
     */
    IF v_dueno IS NOT NULL AND NEW.created_by IS NOT NULL THEN
        SELECT id INTO v_quien FROM usuarios_sistema WHERE auth_id = NEW.created_by;

        IF v_quien IS NOT NULL AND v_quien <> v_dueno THEN
            RAISE EXCEPTION
                'La caja "%" es de otra persona. Cobrá contra la tuya: si no tenés, pedila en Ajustes.',
                v_nombre
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

COMMENT ON FUNCTION validar_cuenta_del_pago IS
    'Impide que el efectivo entre a una cuenta bancaria, que un cobro electrónico quede sin cuenta, y que alguien cobre contra la caja de otro. Sin esto los tres errores aparecen recién cuando no cuadra el arqueo.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Quién tiene caja propia y quién usa la de la oficina:
--   SELECT c.nombre AS caja, c.tipo,
--          COALESCE(u.nombre || ' ' || COALESCE(u.apellido, ''), '(de la oficina)') AS dueno
--     FROM cuentas_pago c
--     LEFT JOIN usuarios_sistema u ON u.id = c.usuario_id
--    WHERE c.activa ORDER BY c.tipo, c.nombre;
--
--   -- Y el arqueo de una caja, que ahora es el de una sola persona:
--   SELECT t.operador, COUNT(*), SUM(t.cobrado)
--     FROM v_transacciones t
--    WHERE t.cuenta_id = '...' AND t.fecha_pago = CURRENT_DATE AND NOT t.anulado
--    GROUP BY t.operador;
