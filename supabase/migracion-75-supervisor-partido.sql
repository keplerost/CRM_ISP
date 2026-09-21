-- =============================================================================
-- Migración 75 — El Supervisor se parte en dos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Por qué ──
--
-- El rol "Supervisor" hacía dos trabajos que no son el mismo: dirigía al equipo
-- comercial (metas, embudo, cobranzas) Y despachaba operaciones (asignar
-- técnicos, tickets, red, inventario). Era un híbrido que quedó así por no
-- haberlo decidido.
--
-- El problema no era la prolijidad. Ese rol tenía `clientes.cartera`, o sea la
-- base completa de abonados. Si terminaba siendo el jefe de ventas, le estábamos
-- dando exactamente lo que las migraciones 70 a 74 le acababan de quitar a los
-- vendedores — y con más motivo para llevárselo, porque maneja al equipo entero.
--
--   Supervisor de ventas → embudo, metas y cobranzas del equipo. SIN cartera.
--   Jefe técnico         → backoffice, tickets, red, inventario. CON cartera,
--                          porque para despachar una cuadrilla hay que ver al
--                          abonado.
-- =============================================================================


-- =============================================================================
-- 1. Los roles válidos
-- =============================================================================
ALTER TABLE usuarios_sistema DROP CONSTRAINT IF EXISTS usuarios_sistema_rol_valido;

-- Se agregan los dos y se conserva 'supervisor' como valor aceptado.
--
-- Conservarlo no es indecisión: la restricción se valida en cada UPDATE, y si
-- quedara alguna fila vieja con ese valor —en esta base no hay, pero este
-- archivo también corre en instalaciones de otros ISP— cualquier edición
-- posterior de ese usuario fallaría con un error que no dice nada útil. Se migra
-- abajo y el valor queda tolerado.
ALTER TABLE usuarios_sistema ADD CONSTRAINT usuarios_sistema_rol_valido CHECK (rol IN (
    'super_admin', 'admin', 'finanzas', 'cobrador', 'cajero', 'vendedor',
    'supervisor_ventas', 'jefe_tecnico', 'tecnico', 'bodega',
    'supervisor'  -- heredado: se migra solo, ver abajo
));


-- =============================================================================
-- 2. Migrar los que ya existan
-- =============================================================================
-- A `jefe_tecnico` y no a `supervisor_ventas`, y la elección importa.
--
-- Quien hoy es Supervisor tiene la cartera completa y despacha trabajo. Pasarlo
-- a ventas le QUITARÍA accesos que está usando —dejaría de ver instalaciones y
-- tickets— y un rol que de golpe no puede trabajar se resuelve dándole permisos
-- de más, que es peor que el problema original.
--
-- A jefe técnico conserva todo lo que tenía salvo el tablero comercial, que es
-- justamente lo que hay que sacarle a quien no dirige ventas.
UPDATE usuarios_sistema
   SET rol = 'jefe_tecnico',
       permisos = permisos - 'ventas.equipo' - 'ventas.dashboard'
 WHERE rol = 'supervisor';


-- =============================================================================
-- 3. El resumen comercial
-- =============================================================================
-- `v_comercial_vendedor` listaba a los roles que aparecen en el tablero de
-- ventas. Decía 'supervisor', que ya no existe: sin esto, el nuevo supervisor de
-- ventas no figuraría en su propia pantalla de equipo.
DROP VIEW IF EXISTS v_comercial_vendedor;
CREATE VIEW v_comercial_vendedor WITH (security_invoker = true) AS
SELECT
    u.id                                  AS vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', u.apellido)) AS vendedor,
    m.meta_altas,
    m.meta_monto,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS altas_mes,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado = 'ganado'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ), 0) AS monto_mes,

    COUNT(p.id) FILTER (WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')) AS abiertos,
    COALESCE(SUM(p.valor_mensual) FILTER (
        WHERE p.estado IN ('nuevo','contactado','cotizado','negociacion')
    ), 0) AS monto_en_juego,

    COUNT(p.id) FILTER (
        WHERE p.estado = 'perdido'
          AND DATE_TRUNC('month', p.actualizado_en) = DATE_TRUNC('month', NOW())
    ) AS perdidos_mes
FROM usuarios_sistema u
LEFT JOIN v_prospectos p ON p.vendedor_id = u.id
LEFT JOIN metas_venta  m ON m.vendedor_id = u.id
                        AND m.anio = EXTRACT(YEAR  FROM NOW())::SMALLINT
                        AND m.mes  = EXTRACT(MONTH FROM NOW())::SMALLINT
-- El jefe técnico NO está en esta lista: no vende, y aparecer con cero ventas en
-- el tablero de metas es ruido que hace dudar de si le falta cargar algo.
WHERE u.rol IN ('vendedor', 'supervisor_ventas', 'admin', 'super_admin')
GROUP BY u.id, u.nombre, u.apellido, m.meta_altas, m.meta_monto;


-- =============================================================================
-- Revertir
-- =============================================================================
--   UPDATE usuarios_sistema SET rol = 'supervisor' WHERE rol = 'jefe_tecnico';
-- Los permisos quitados hay que volver a marcarlos desde la pantalla: la
-- migración no los guarda porque `permisos` es la lista efectiva, no un
-- historial.
