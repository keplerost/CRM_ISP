-- =============================================================================
-- Migración 165 — El cierre de caja también se cierra
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El agujero ──
--
-- La pantalla de Transacciones ya no se le ofrece a quien solo cobra, y el
-- reporte del middleware se acota solo. Pero la vista se puede pedir DIRECTO desde
-- el navegador, y ahí devolvía todo.
--
-- Comprobado entrando con la sesión del punto de recaudación:
--
--   v_transacciones      11 filas VISIBLES     ← no debía ver ninguna ajena
--   v_reporte_arcotel     0 filas VISIBLES
--
-- El motivo es que las dos vistas se crearon sin `security_invoker`, así que
-- corren con los permisos de su dueño y RLS no se aplica. Cualquiera con sesión y
-- la consola abierta las lee enteras.
--
-- Es exactamente lo que advierte el encabezado del mapa de rutas del frente:
-- esconder una pantalla es cortesía, lo que protege es esto.
--
-- ── Por qué no alcanza con marcarlas `security_invoker` ──
--
-- Porque la política de `pagos` deja leer todo a quien tiene `clientes.cartera`,
-- y el punto de recaudación lo tiene: lo necesita para buscar por cédula al
-- abonado que se le para enfrente. Poder abrir una ficha no es poder ver la caja
-- de los demás.
--
-- Así que además de respetar RLS, la vista filtra por operador salvo que quien
-- mira pueda consolidar.
-- =============================================================================

/**
 * ¿Quien está mirando puede ver los cobros de todos?
 *
 * Mismo patrón que `cartera_completa()`, y por las mismas razones: SECURITY
 * DEFINER para poder leer `usuarios_sistema` sin abrirle esa tabla a nadie, y
 * `TRUE` cuando no hay legajo — que es como corren el middleware y las tareas
 * programadas, que necesitan la caja entera para armar el cierre.
 */
CREATE OR REPLACE FUNCTION consolida_cobros()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*'
             OR permisos ? 'finanzas.ver_todos'
             OR permisos ? 'finanzas.transferencias'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        /**
         * Sin legajo, TRUE.
         *
         * Es el middleware con el rol de servicio y las tareas programadas: no
         * tienen `auth.uid()` y necesitan ver todo para armar el cierre de caja y
         * el reporte. Devolver FALSE acá dejaría los dos PDF en blanco sin ningún
         * error que lo explique.
         */
        TRUE
    )
$$;

COMMENT ON FUNCTION consolida_cobros IS
    'TRUE si quien mira puede ver los cobros de todos los operadores. Sin legajo devuelve TRUE: es el middleware, que arma el cierre completo.';


/**
 * Y cuál es el legajo de quien mira.
 *
 * Separado de la función de arriba porque se usa para filtrar, no para decidir.
 * NULL cuando no hay sesión con legajo, y ahí el filtro no aplica —lo cubre
 * `consolida_cobros()`, que en ese caso ya dijo TRUE—.
 */
CREATE OR REPLACE FUNCTION mi_legajo()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1
$$;

COMMENT ON FUNCTION mi_legajo IS
    'El id de personal de quien está mirando. NULL si no tiene legajo.';


-- =============================================================================
-- Las vistas, ahora con los permisos de quien pregunta
-- =============================================================================
/**
 * `security_invoker` para que RLS se aplique, y el filtro por operador encima.
 *
 * Se usa ALTER y no CREATE OR REPLACE: la opción se puede cambiar sin volver a
 * escribir la definición, y así esta migración no queda con una copia de la vista
 * que envejece cada vez que la de arriba cambia.
 */
ALTER VIEW v_transacciones   SET (security_invoker = true);
ALTER VIEW v_reporte_arcotel SET (security_invoker = true);
ALTER VIEW v_arcotel_resumen SET (security_invoker = true);
ALTER VIEW v_arcotel_incompletos SET (security_invoker = true);

/**
 * El filtro por operador va en una vista que envuelve a la otra.
 *
 * ── Por qué envolver y no editar `v_transacciones` ──
 *
 * Porque su definición vive en la 157 y la cambian las migraciones que agregan
 * columnas. Meterle acá una cláusula que aquellas no conocen haría que la próxima
 * la borre sin que nadie lo note — y lo que se borraría es un control de acceso.
 *
 * Con `pg_get_viewdef` se reescribe sobre lo que HAYA, sea cual sea su versión.
 */
DO $envolver$
DECLARE
    v_def TEXT;
BEGIN
    -- Si ya está envuelta, no se vuelve a envolver: dos capas del mismo filtro
    -- no protegen más y hacen ilegible la definición.
    IF EXISTS (
        SELECT 1 FROM pg_views
         WHERE schemaname = 'public' AND viewname = 'v_transacciones'
           AND definition ILIKE '%consolida_cobros%'
    ) THEN
        RAISE NOTICE 'v_transacciones ya filtra por operador: no se toca.';
        RETURN;
    END IF;

    SELECT pg_get_viewdef('v_transacciones'::regclass, true) INTO v_def;

    EXECUTE FORMAT($sql$
        CREATE OR REPLACE VIEW v_transacciones WITH (security_invoker = true) AS
        SELECT * FROM (%s) AS t
         WHERE consolida_cobros() OR t.operador_id = mi_legajo()
    $sql$, RTRIM(v_def, ';' || CHR(10) || CHR(9) || ' '));
END $envolver$;

COMMENT ON VIEW v_transacciones IS
    'Todos los cobros con lo que hace falta para cerrar caja. Quien no puede consolidar ve SOLO los suyos: el filtro está en la vista, no en la pantalla, porque una pantalla escondida no protege un dato.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Con la sesión de alguien que solo cobra, esto tiene que devolver solo lo
--   -- suyo, y con la de un administrador, todo:
--   SELECT COUNT(*) FROM v_transacciones;
--
--   -- Y quién es cada uno para la base:
--   SELECT consolida_cobros() AS consolida, mi_legajo() AS legajo;
