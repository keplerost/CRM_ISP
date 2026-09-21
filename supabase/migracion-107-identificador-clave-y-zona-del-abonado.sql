-- =============================================================================
-- Migración 107 — El número del abonado, su clave, su zona y desde cuándo está así
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué se pidió ──
--
-- En el sistema anterior, la ficha del abonado mostraba cuatro cosas que acá no
-- estaban:
--
--   1. Un ID corto y propio del abonado —132, no un UUID—, que es el que se
--      escribe en el contrato de papel.
--   2. Una contraseña del sistema, generada, visible y dictable por teléfono.
--   3. A qué router está conectado.  ← ya estaba: `v_clientes_ficha.router`.
--   4. El estado, y debajo la FECHA Y HORA en que quedó así.
--
-- Y en el listado de abonados hacía falta una zona para filtrar y para sacar la
-- lista de a quién hay que ir a visitar.
--
-- Esta migración agrega lo que falta: `codigo`, `portal_clave`, `zona` y
-- `estado_desde`. El router no necesita nada.
--
-- ── Por qué un `codigo` y no el `numero_orden` que ya existe ──
--
-- `numero_orden` es el número de la ORDEN que dio de alta al abonado (la 91).
-- Sirve para eso y hay que dejarlo quieto, pero no alcanza como identificador
-- del abonado: los que se importaron de otro sistema nunca tuvieron orden y lo
-- tienen vacío, y un traslado o una reinstalación generan una orden nueva.
--
-- El `codigo` es del abonado y no se mueve: se asigna una vez, cuando la ficha
-- nace, y lo acompaña hasta la baja.
--
-- ── Sobre guardar la clave en claro ──
--
-- La 65 dejó la clave del portal HASHEADA a propósito, y eso sigue igual: el
-- portal sigue autenticando contra `portal_clave_hash`. Lo que se agrega es una
-- segunda columna con la misma clave legible, porque quien atiende el teléfono
-- tiene que poder dictarla.
--
-- Es un paso atrás en seguridad y conviene decirlo con todas las letras: quien
-- pueda leer la fila del abonado puede leer su clave. Se eligió por decisión
-- explícita del dueño del sistema, con el mismo criterio con el que `clave_ppp`
-- ya se guarda en claro desde la 10. Quien la muestre en pantalla tiene que
-- pedir permiso: la app lo hace detrás de `clientes.editar` y con un botón de
-- ojo, no a la vista.
-- =============================================================================


-- =============================================================================
-- 1. El número del abonado
-- =============================================================================
CREATE SEQUENCE IF NOT EXISTS clientes_codigo_seq;

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS codigo INT;

COMMENT ON COLUMN clientes.codigo IS
    'Número corto y propio del abonado, el que se escribe en el contrato. Se asigna solo al crear la ficha y no cambia nunca: un traslado o una reinstalación no lo tocan. Distinto de numero_orden, que es el número de la orden que lo dio de alta.';

-- Los que ya estaban reciben su número por antigüedad, que es el orden en que
-- los habría numerado el sistema si hubiera existido desde el principio.
WITH por_antiguedad AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n
      FROM clientes
     WHERE codigo IS NULL
)
UPDATE clientes c
   SET codigo = a.n
  FROM por_antiguedad a
 WHERE c.id = a.id;

-- La secuencia arranca después del último asignado. El `false` es lo que hace
-- que el próximo `nextval` devuelva ese número y no el siguiente: con `true` se
-- perdería un número en cada corrida.
SELECT setval('clientes_codigo_seq', COALESCE(MAX(codigo), 0) + 1, false) FROM clientes;

ALTER TABLE clientes ALTER COLUMN codigo SET DEFAULT nextval('clientes_codigo_seq');
ALTER TABLE clientes ALTER COLUMN codigo SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_codigo ON clientes (codigo);


-- =============================================================================
-- 2. La clave del sistema, legible
-- =============================================================================
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS portal_clave VARCHAR(40);

COMMENT ON COLUMN clientes.portal_clave IS
    'La misma clave del portal que portal_clave_hash, en claro, para poder dictarla por teléfono. Se escriben siempre juntas desde el middleware. Vacía significa que el abonado puso una clave propia desde el portal: ahí solo queda el hash y nadie la puede leer.';

-- El portal es público y entra como `anon`. No tiene por qué ver ninguna de las
-- dos formas de la clave.
REVOKE SELECT (portal_clave) ON clientes FROM anon;


-- =============================================================================
-- 3. La zona
-- =============================================================================
-- Campo propio del abonado y no heredado de la ONU ni del NAP: la zona con la
-- que se gestiona —a quién llamar, a quién ir a retirarle el equipo— es una
-- división comercial, y no siempre coincide con por dónde entra la fibra. Los
-- de radio, además, no tienen ONU de la que heredarla.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS zona VARCHAR(60);

COMMENT ON COLUMN clientes.zona IS
    'Zona comercial del abonado, para filtrar el listado y armar las rutas de visita. Se carga a mano: es una división de gestión, no de red.';

CREATE INDEX IF NOT EXISTS idx_clientes_zona ON clientes (zona) WHERE zona IS NOT NULL;


-- =============================================================================
-- 4. Desde cuándo está en este estado
-- =============================================================================
-- Es lo que hace posible la pregunta que motivó todo esto: "¿quién lleva dos
-- meses suspendido?". Sin esta fecha, un abonado cortado en marzo y otro
-- cortado ayer son indistinguibles.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS estado_desde TIMESTAMPTZ;

COMMENT ON COLUMN clientes.estado_desde IS
    'Cuándo el abonado quedó en el estado que tiene ahora. Lo escribe un disparador en cada cambio de estado. Para las fichas anteriores a esta migración es una aproximación: se tomó updated_at.';

-- Para los que ya estaban no hay forma de saberlo: `updated_at` es lo más
-- cercano que existe y queda dicho arriba que es una aproximación. Inventar una
-- fecha exacta sería peor que admitir que no se sabe.
UPDATE clientes
   SET estado_desde = COALESCE(updated_at, created_at, NOW())
 WHERE estado_desde IS NULL;

ALTER TABLE clientes ALTER COLUMN estado_desde SET DEFAULT NOW();

CREATE OR REPLACE FUNCTION marcar_cambio_de_estado()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        NEW.estado_desde := NOW();
    END IF;
    RETURN NEW;
END $$;

COMMENT ON FUNCTION marcar_cambio_de_estado() IS
    'Sella la fecha cada vez que el abonado cambia de estado. Va BEFORE UPDATE para escribir en la misma fila y no disparar un segundo UPDATE.';

DROP TRIGGER IF EXISTS trg_estado_desde ON clientes;
CREATE TRIGGER trg_estado_desde
    BEFORE UPDATE OF estado ON clientes
    FOR EACH ROW EXECUTE FUNCTION marcar_cambio_de_estado();

-- El índice que usa el listado de recuperación: "los suspendidos, del más viejo
-- al más nuevo".
CREATE INDEX IF NOT EXISTS idx_clientes_estado_desde ON clientes (estado, estado_desde);


-- =============================================================================
-- 5. Que la ficha los vea
-- =============================================================================
-- ── Por qué se repite la lista de columnas en vez de usar `c.*` ──
--
-- Porque `*` se expande cuando la vista se crea, no cuando se consulta: la
-- versión que hay hoy en la base congeló las columnas que `clientes` tenía en
-- la 37, y por eso las que vinieron después —`numero_orden`, `activado_en`, las
-- de la baja— no aparecen en la ficha. Volver a poner `c.*` las traería todas
-- de golpe, incluida `portal_clave_hash`, que es exactamente lo que la 65
-- quiso esconder.
--
-- ── Por qué CREATE OR REPLACE y no DROP + CREATE ──
--
-- Porque de esta vista cuelgan otras dos —la bandeja de cobranza de la 73 y la
-- cartera en riesgo de la 101— y un DROP se las llevaría puestas. REPLACE
-- exige que las columnas que ya existían queden con el mismo nombre, el mismo
-- tipo y el mismo orden, y que lo nuevo vaya AL FINAL. Por eso la lista de
-- abajo reproduce el orden exacto de la vista actual y las cuatro columnas
-- nuevas van al final del todo.
--
-- ── Y por qué se saltea si ya vino algo después ──
--
-- Porque una migración posterior puede agregarle más columnas —la 108 le sumó
-- la pasarela—, y volver a correr esta se las llevaría: `CREATE OR REPLACE`
-- puede AGREGAR columnas al final, nunca quitarlas, así que ni siquiera falla
-- de forma limpia. La pregunta es por el CONTENIDO de la vista y no por un
-- número de migración: este archivo no tiene por qué saber qué vino después.
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'pasarela'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya tiene una versión posterior a la 107: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS
SELECT
    c.id,
    c.nombre,
    c.router_id,
    c.onu_id,
    c.plan_id,
    c.ip,
    c.mac_address,
    c.usuario_ppp,
    c.estado,
    c.origen,
    c.velocidad_cruda,
    c.comentario,
    c.created_at,
    c.updated_at,
    c.tipo_identificacion,
    c.identificacion,
    c.email,
    c.telefono,
    c.direccion,
    c.precio_mensual,
    c.dia_facturacion,
    c.telefono_movil,
    c.codigo_pago,
    c.clave_ppp,
    c.latitud,
    c.longitud,
    c.notas,
    c.nap_id,
    c.puerto_nap,
    c.conectado_a_id,
    c.ip_administracion,
    c.tipo_antena,
    c.tipo_conexion,
    c.tipo_ip,
    c.red_ipv4,
    c.ipv6,
    c.ipv6_duid,
    c.rutas,
    c.descripcion_servicio,
    c.excluir_firewall,
    c.fecha_instalacion,
    c.factura_electronica,
    c.modalidad_pago,
    c.dia_generar_factura,
    c.tipo_impuesto,
    c.dias_gracia,
    c.aplicar_corte,
    c.descuento_tipo,
    c.descuento_porcentaje,
    c.descuento_documento,
    c.promo_porcentaje,
    c.promo_meses,
    c.promo_desde,
    c.telegram_chat_id,
    c.canal_preferido,
    p.nombre  AS plan,
    p.precio  AS plan_precio,
    p.bajada_kbps,
    p.subida_kbps,
    p.categoria      AS plan_categoria,
    p.tipo_impuesto  AS plan_tipo_impuesto,
    p.iva_porcentaje AS plan_iva_porcentaje,
    p.perfil_ppp     AS plan_perfil_ppp,
    r.nombre  AS router,
    o.sn      AS onu_serial,
    o.estado  AS onu_estado,
    o.rx_power_dbm,
    nap.nombre AS nap,
    ap.nombre  AS conectado_a,
    COALESCE(s.saldo, 0)               AS saldo,
    COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
    s.ultimo_pago,
    ct.id     AS contrato_id,
    ct.numero AS contrato_numero,
    ct.precio_mensual AS contrato_precio,
    -- Lo nuevo, al final por lo que dice el comentario de arriba.
    c.codigo,
    c.zona,
    c.estado_desde,
    c.portal_clave,
    c.numero_orden
FROM clientes c
LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
LEFT JOIN routers_mikrotik r   ON r.id = c.router_id
LEFT JOIN onus o               ON o.id = c.onu_id
LEFT JOIN puntos_red nap       ON nap.id = c.nap_id
LEFT JOIN puntos_red ap        ON ap.id = c.conectado_a_id
LEFT JOIN v_saldo_clientes s   ON s.client_id = c.id
LEFT JOIN contratos ct         ON ct.client_id = c.id AND ct.estado = 'vigente'
$vista$;
END $guarda$;

COMMENT ON VIEW v_clientes_ficha IS
    'La ficha completa del abonado: sus datos, su plan, su router, su ONU, su saldo y su contrato vigente. Las columnas se enumeran una por una a propósito, para que agregar una columna a `clientes` no la publique sin querer.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Cada abonado tiene su número, sin repetidos y sin huecos al final:
--   SELECT codigo, nombre, estado, estado_desde, zona FROM clientes ORDER BY codigo;
--
--   -- El próximo que se cree sigue la cuenta:
--   SELECT last_value FROM clientes_codigo_seq;
--
--   -- El disparador sella la fecha:
--   UPDATE clientes SET estado = 'suspendido' WHERE codigo = 1;
--   SELECT estado, estado_desde FROM clientes WHERE codigo = 1;   -- estado_desde = ahora
--
--   -- Y la ficha ya las muestra:
--   SELECT codigo, zona, estado_desde, numero_orden FROM v_clientes_ficha LIMIT 5;
