-- =============================================================================
-- Migración 73 — Cobranza comercial
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere la 70, 71 y 72.
--
-- Implementa los puntos 5 a 9 del requerimiento: el cliente con deuda vuelve a
-- aparecerle al vendedor que lo vendió, para que gestione el cobro — y
-- desaparece solo cuando paga.
--
-- ── Una corrección a mi propio diseño de la migración 70 ──
--
-- En la 70 puse la asignación de cobranza dentro de `mis_clientes_visibles()`,
-- de modo que una cobranza activa le abría al vendedor la FILA ENTERA del
-- cliente. Eso contradice el punto 9, que pide mínimo privilegio: le habría dado
-- la cédula, la dirección, la clave PPP, las notas administrativas y el
-- historial de pagos, cuando lo único que necesita para llamar y cobrar es
-- nombre, teléfono, plan, saldo y fechas.
--
-- Acá se corrige. `mis_clientes_visibles()` deja de incluir la cobranza, y el
-- acceso pasa a ser una vista con las columnas justas. El vendedor en gestión de
-- cobro NO puede leer `clientes`, ni `pagos`, ni `contratos`: solo su bandeja.
-- =============================================================================


-- =============================================================================
-- 1. La corrección
-- =============================================================================
CREATE OR REPLACE FUNCTION mis_clientes_visibles()
RETURNS TABLE (cliente_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH yo AS (
        SELECT id, tecnico_id FROM usuarios_sistema
         WHERE auth_id = auth.uid() AND activo LIMIT 1
    )
    -- Solo el técnico y los clientes de sus trabajos.
    --
    -- La cobranza SALIÓ de acá a propósito: abría la ficha completa cuando lo
    -- que hace falta es un nombre, un teléfono y un saldo. Va por
    -- `v_cobros_por_gestionar`, más abajo.
    SELECT t.client_id
      FROM tickets t JOIN yo ON t.tecnico_id = yo.tecnico_id
     WHERE t.client_id IS NOT NULL

    UNION

    SELECT i.client_id
      FROM instalaciones i JOIN yo ON i.tecnico_id = yo.tecnico_id
     WHERE i.client_id IS NOT NULL
$$;


-- =============================================================================
-- 2. Quién vendió a cada cliente
-- =============================================================================
-- El vínculo existe pero está en dos saltos: `prospectos.cliente_id` apunta al
-- abonado y `prospectos.vendedor_id` a quien lo vendió. Se resuelve una vez acá
-- para no repetir el JOIN en cada consulta.
DROP VIEW IF EXISTS v_cliente_vendedor;
CREATE VIEW v_cliente_vendedor AS
SELECT DISTINCT ON (p.cliente_id)
    p.cliente_id,
    p.vendedor_id,
    p.id AS prospecto_id
FROM prospectos p
WHERE p.cliente_id IS NOT NULL AND p.vendedor_id IS NOT NULL
ORDER BY p.cliente_id, p.actualizado_en DESC;

-- Sin `security_invoker`: se usa DENTRO de funciones que ya validan quién
-- pregunta, y con RLS encima devolvería vacío justamente para el vendedor, que
-- es a quien tiene que servir.
COMMENT ON VIEW v_cliente_vendedor IS
    'Qué vendedor trajo a cada abonado. Uso interno de la cobranza comercial.';


-- =============================================================================
-- 3. Abrir y cerrar las gestiones, solo
-- =============================================================================
/**
 * Sincroniza la bandeja de cobranza comercial.
 *
 * Hace las dos mitades en una pasada:
 *
 *   ABRE  una asignación al vendedor cuando su cliente tiene saldo y todavía
 *         está dentro de la ventana.
 *   CIERRA las que ya no corresponden: el cliente pagó, o se le venció la
 *         ventana de acompañamiento.
 *
 * Cerrar es tan importante como abrir, y es la parte que se olvida: el punto 5
 * pide que el cliente desaparezca de la bandeja cuando pague. Si eso dependiera
 * de que alguien apriete un botón, el vendedor seguiría viendo —y llamando— a
 * gente que ya pagó.
 *
 * Idempotente: correrla dos veces seguidas no duplica nada. Va en el crontab
 * junto al resto de los automatismos.
 */
CREATE OR REPLACE FUNCTION sincronizar_cobranza_comercial()
RETURNS TABLE (abiertas INT, cerradas INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meses INT;
    v_abiertas INT := 0;
    v_cerradas INT := 0;
BEGIN
    SELECT ventana_cobranza_meses INTO v_meses FROM config_cartera WHERE id = 1;

    -- ── Cerrar ──
    -- Primero, para que un cliente que pagó y volvió a deber no quede con la
    -- asignación vieja y su saldo inicial equivocado.
    WITH cerrar AS (
        UPDATE cobranza_asignaciones ca
           SET estado     = CASE
                              WHEN COALESCE(f.saldo, 0) <= 0 THEN 'pagada'
                              ELSE 'vencida'
                            END,
               cerrado_en = NOW()
          FROM v_clientes_ficha f
         WHERE f.id = ca.cliente_id
           AND ca.estado = 'activa'
           AND (COALESCE(f.saldo, 0) <= 0 OR ca.vence_el < CURRENT_DATE)
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_cerradas FROM cerrar;

    -- ── Abrir ──
    WITH candidatos AS (
        SELECT
            c.id            AS cliente_id,
            cv.vendedor_id,
            f.saldo,
            -- La ventana se congela al asignar: si mañana se baja la
            -- configuración, la gestión en curso no se corta por la mitad.
            (c.activado_en::DATE + (v_meses || ' months')::INTERVAL)::DATE AS vence_el
        FROM clientes c
        JOIN v_clientes_ficha f  ON f.id = c.id
        JOIN v_cliente_vendedor cv ON cv.cliente_id = c.id
        JOIN usuarios_sistema u  ON u.id = cv.vendedor_id AND u.activo
        WHERE c.activado_en IS NOT NULL
          AND COALESCE(f.saldo, 0) > 0
          -- Dentro de la ventana comercial.
          AND c.activado_en::DATE + (v_meses || ' months')::INTERVAL >= CURRENT_DATE
          -- Y sin una gestión ya abierta.
          AND NOT EXISTS (
              SELECT 1 FROM cobranza_asignaciones x
               WHERE x.cliente_id = c.id AND x.estado = 'activa'
          )
    ),
    insertar AS (
        INSERT INTO cobranza_asignaciones
            (cliente_id, vendedor_id, vence_el, saldo_inicial, motivo)
        SELECT cliente_id, vendedor_id, vence_el, saldo,
               'Deuda detectada automáticamente'
          FROM candidatos
        ON CONFLICT DO NOTHING
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_abiertas FROM insertar;

    RETURN QUERY SELECT v_abiertas, v_cerradas;
END $$;


-- =============================================================================
-- 4. La bandeja
-- =============================================================================
-- El punto 7, con exactamente las columnas del punto 9 y ninguna más.
--
-- No lleva `security_invoker` a propósito, y esto es lo que hace que funcione:
-- corre con los permisos del dueño, así que puede leer `clientes` —que al
-- vendedor le está cerrada— y devolverle SOLO estas columnas. Sin cédula, sin
-- dirección, sin clave PPP, sin notas administrativas, sin historial de pagos.
--
-- El filtro por vendedor está adentro: cada uno ve lo suyo, y quien tiene la
-- cartera ve todo. Es el punto 24 — se busca dentro del universo autorizado, no
-- se busca todo y después se esconde.
/**
 * Va con `CREATE OR REPLACE` y no con `DROP` + `CREATE`.
 *
 * De esta vista cuelgan otras que se crean DESPUÉS —v_notificaciones, en la 76—, así que un `DROP`
 * hace que volver a correr este archivo falle con "cannot drop view because
 * other objects depend on it". Y como el editor de Supabase corre el archivo
 * entero en una transacción, se cae la migración completa.
 *
 * `CREATE OR REPLACE` reemplaza la definición sin tocar a quien depende de ella.
 * Exige que las columnas sean las mismas, que es exactamente el caso cuando lo
 * que se reejecuta es este mismo archivo.
 */
CREATE OR REPLACE VIEW v_cobros_por_gestionar AS
SELECT
    ca.id               AS asignacion_id,
    ca.cliente_id,
    ca.vendedor_id,
    ca.vence_el,
    ca.saldo_inicial,

    f.nombre            AS cliente,
    -- El teléfono es la herramienta de trabajo: sin él la bandeja no sirve.
    COALESCE(f.telefono_movil, f.telefono) AS telefono,
    f.plan,
    f.saldo             AS saldo_pendiente,
    f.facturas_pendientes,
    f.ultimo_pago,

    -- La factura más vieja sin pagar marca desde cuándo se debe.
    v.vencimiento       AS vencimiento_mas_viejo,
    GREATEST(0, (CURRENT_DATE - v.vencimiento))::INT AS dias_atraso,

    -- La última gestión, para no volver a llamar al que se llamó hace una hora.
    g.creado_en         AS ultima_gestion,
    g.resultado         AS ultimo_resultado,
    g.promesa_fecha,
    g.promesa_monto,

    -- El estado del punto 7: sale del último resultado, no de una columna que
    -- alguien tenga que mantener al día.
    COALESCE(g.resultado, 'pendiente_contacto') AS estado
FROM cobranza_asignaciones ca
JOIN v_clientes_ficha f ON f.id = ca.cliente_id
LEFT JOIN LATERAL (
    SELECT MIN(fa.fecha_vencimiento) AS vencimiento
      FROM facturas fa
     WHERE fa.client_id = ca.cliente_id
) v ON TRUE
LEFT JOIN LATERAL (
    SELECT cg.creado_en, cg.resultado, cg.promesa_fecha, cg.promesa_monto
      FROM cobranza_gestiones cg
     WHERE cg.asignacion_id = ca.id
     ORDER BY cg.creado_en DESC
     LIMIT 1
) g ON TRUE
WHERE ca.estado = 'activa'
  AND (
      cartera_completa()
      OR ca.vendedor_id = mi_legajo_id()
  );

COMMENT ON VIEW v_cobros_por_gestionar IS
    'La bandeja del vendedor. Corre con privilegio para devolver SOLO las columnas necesarias: el vendedor no puede leer clientes.';

-- Se le da acceso explícito. Sin esto, `authenticated` no puede consultarla.
GRANT SELECT ON v_cobros_por_gestionar TO authenticated;
GRANT SELECT ON v_cliente_vendedor      TO authenticated;


-- =============================================================================
-- 5. Registrar la gestión
-- =============================================================================
/**
 * Deja el contacto registrado y actualiza lo que corresponda.
 *
 * Va como función y no como un INSERT desde la pantalla por una razón: cuando el
 * resultado es `pagado`, hay que cerrar la asignación en la misma operación. Si
 * fueran dos pasos desde el navegador, perder la señal entre uno y otro dejaría
 * al cliente marcado como pagado y todavía en la bandeja.
 */
CREATE OR REPLACE FUNCTION registrar_gestion_cobranza(
    p_asignacion  UUID,
    p_canal       TEXT,
    p_resultado   TEXT,
    p_observacion TEXT DEFAULT NULL,
    p_promesa_fecha DATE DEFAULT NULL,
    p_promesa_monto NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_yo   UUID := mi_legajo_id();
    v_id   UUID;
    v_dueno UUID;
BEGIN
    SELECT vendedor_id INTO v_dueno
      FROM cobranza_asignaciones
     WHERE id = p_asignacion AND estado = 'activa';

    IF v_dueno IS NULL THEN
        RAISE EXCEPTION 'Esa gestión de cobranza no está activa';
    END IF;

    -- Se verifica acá y no solo en la pantalla: la función es SECURITY DEFINER,
    -- así que sin este control cualquiera podría registrar gestiones sobre la
    -- cobranza de otro.
    IF v_dueno <> v_yo AND NOT cartera_completa() THEN
        RAISE EXCEPTION 'Esa cobranza no está asignada a vos';
    END IF;

    INSERT INTO cobranza_gestiones (
        asignacion_id, canal, resultado, observacion,
        promesa_fecha, promesa_monto, usuario_id, usuario_nombre
    )
    SELECT p_asignacion, p_canal, p_resultado, p_observacion,
           p_promesa_fecha, p_promesa_monto, u.id,
           TRIM(CONCAT(u.nombre, ' ', u.apellido))
      FROM usuarios_sistema u WHERE u.id = v_yo
    RETURNING id INTO v_id;

    -- Marcar "pagado" NO cierra la asignación: el saldo real lo dice la
    -- facturación, no lo que el cliente prometió por teléfono. La sincronización
    -- la va a cerrar cuando el pago exista de verdad. Lo que sí se hace es
    -- escalar, que es una decisión y no una observación.
    IF p_resultado = 'escalar' THEN
        UPDATE cobranza_asignaciones
           SET estado = 'escalada', cerrado_en = NOW()
         WHERE id = p_asignacion;
    END IF;

    RETURN v_id;
END $$;


-- =============================================================================
-- 6. Asignación manual
-- =============================================================================
-- El punto 1 dice "salvo asignación explícita por un administrador". Esta es esa
-- puerta: fuera de la ventana, o para un cliente que no vendió, un administrador
-- puede asignarle una gestión puntual.
CREATE OR REPLACE FUNCTION asignar_cobranza(
    p_cliente  UUID,
    p_vendedor UUID,
    p_dias     INT DEFAULT 30,
    p_motivo   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID;
BEGIN
    IF NOT cartera_completa() THEN
        RAISE EXCEPTION 'Solo un administrador puede asignar una cobranza a mano';
    END IF;

    INSERT INTO cobranza_asignaciones
        (cliente_id, vendedor_id, vence_el, saldo_inicial, motivo, asignado_por)
    SELECT p_cliente, p_vendedor, CURRENT_DATE + p_dias,
           (SELECT saldo FROM v_clientes_ficha WHERE id = p_cliente),
           COALESCE(p_motivo, 'Asignación manual'), mi_legajo_id()
    RETURNING id INTO v_id;

    RETURN v_id;
END $$;


-- =============================================================================
-- 7. Lo que el tablero necesita contar
-- =============================================================================
-- El punto 26 pide cuatro tarjetas. Se calculan acá para que el número sea el
-- mismo en la tarjeta, en la bandeja y en cualquier reporte.
DROP VIEW IF EXISTS v_tablero_vendedor;
CREATE VIEW v_tablero_vendedor AS
SELECT
    u.id AS vendedor_id,

    (SELECT COUNT(*) FROM cobranza_asignaciones ca
      WHERE ca.vendedor_id = u.id AND ca.estado = 'activa')            AS cobros_por_gestionar,

    (SELECT COUNT(*) FROM v_expedientes e
      WHERE e.vendedor_id = u.id AND e.estado = 'abierto'
        AND e.ok_contrato AND NOT e.ok_firma)                          AS contratos_pendientes,

    (SELECT COUNT(*) FROM v_expedientes e
      WHERE e.vendedor_id = u.id AND e.estado = 'abierto'
        AND NOT e.completo)                                            AS expedientes_incompletos,

    (SELECT COUNT(*) FROM prospectos p
      JOIN instalaciones i ON i.id = p.instalacion_id
     WHERE p.vendedor_id = u.id
       AND i.estado IN ('nueva','revisando','lista_asignar','agendada','en_ruta','en_curso'))
                                                                       AS instalaciones_en_proceso,

    -- Las promesas que vencen hoy: es la primera línea de "qué hacer ahora".
    (SELECT COUNT(*) FROM cobranza_asignaciones ca
      JOIN cobranza_gestiones g ON g.asignacion_id = ca.id
     WHERE ca.vendedor_id = u.id AND ca.estado = 'activa'
       AND g.resultado = 'promesa_pago' AND g.promesa_fecha = CURRENT_DATE)
                                                                       AS promesas_hoy
FROM usuarios_sistema u
WHERE u.activo;

GRANT SELECT ON v_tablero_vendedor TO authenticated;


-- =============================================================================
-- 8. Que corra sola
-- =============================================================================
-- Se engancha al crontab que ya existe. Sin esto habría que apretar un botón
-- todos los días, y el día que nadie lo aprieta el vendedor no se entera de que
-- su cliente debe.
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS cobranza_cada_minutos INT
        CHECK (cobranza_cada_minutos IS NULL OR cobranza_cada_minutos BETWEEN 5 AND 1440);

COMMENT ON COLUMN config_tareas.cobranza_cada_minutos IS
    'Cada cuánto revisar deudas y cerrar las gestiones pagadas. NULL = usar el valor del .env.';


-- =============================================================================
-- Revertir
-- =============================================================================
--   DROP VIEW IF EXISTS v_tablero_vendedor, v_cobros_por_gestionar, v_cliente_vendedor;
--   DROP FUNCTION IF EXISTS sincronizar_cobranza_comercial();
--   DROP FUNCTION IF EXISTS registrar_gestion_cobranza(UUID,TEXT,TEXT,TEXT,DATE,NUMERIC);
--   DROP FUNCTION IF EXISTS asignar_cobranza(UUID,UUID,INT,TEXT);
-- Y para devolver la visibilidad de cobranza al vendedor, volver a la versión de
-- `mis_clientes_visibles()` de la migración 70.
