-- =============================================================================
-- Migración 122 — La IP que ya está en uso
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- El sistema tiene dos lugares donde vive una dirección IP:
--
--   `clientes.ip`   la que usa el abonado. Es la que se importa del padrón y la
--                   que se ve en su ficha.
--
--   `ip_addresses`  el registro del IPAM: los bloques y qué hay en cada uno.
--
-- Y "la primera dirección libre" —lo que el sistema propone al dar de alta a un
-- abonado nuevo— se calcula mirando SOLO el segundo. Hoy esa tabla está vacía,
-- así que la cuenta da siempre la primera dirección del bloque.
--
-- Mientras se cargaba todo a mano no se notaba. Al migrar un padrón entero sí:
-- quinientos abonados entran con su IP en `clientes.ip` y el IPAM sigue vacío,
-- así que el primer alta nueva propone una dirección que ya está en la casa de
-- alguien. Dos equipos con la misma IP no fallan con un cartel: se cortan el
-- servicio entre ellos, de a ratos, y eso se persigue durante días.
--
-- ── Lo que se hace ──
--
-- Una sola fuente para preguntar "¿esta IP está libre?", que mire las dos
-- tablas. No se unifican los datos —cada tabla tiene su razón de ser— pero sí
-- la pregunta.
--
-- Lo que NO resuelve esto: si la IP está ocupada en el MikroTik por alguien que
-- el sistema no conoce. Eso no se puede saber desde la base, hay que ir a
-- preguntarle al router; lo hace la conciliación del middleware.
-- =============================================================================

-- Buscar por IP tiene que ser barato: se pregunta una vez por cada dirección
-- candidata al buscar la primera libre.
CREATE INDEX IF NOT EXISTS idx_clientes_ip ON clientes (ip) WHERE ip IS NOT NULL;


-- =============================================================================
-- Quién ocupa cada dirección
-- =============================================================================
/**
 * Todas las direcciones tomadas, vengan de donde vengan.
 *
 * ── Por qué el abonado de baja NO ocupa su IP ──
 *
 * Porque si la ocupara para siempre, un ISP con cinco años de historia tendría
 * medio bloque bloqueado por gente que ya no es cliente. La dirección de un
 * abonado dado de baja vuelve a estar disponible, que es lo que pasa en la
 * realidad: se la reasigna al siguiente.
 *
 * Los suspendidos y los cortados SÍ la ocupan: siguen siendo abonados, su equipo
 * sigue en la casa, y reasignarle esa IP a otro es exactamente el choque que
 * esta migración viene a evitar.
 */
CREATE OR REPLACE VIEW v_ips_en_uso WITH (security_invoker = true) AS
SELECT
    c.ip                            AS ip,
    c.router_id,
    'abonado'::TEXT                 AS origen,
    c.id                            AS cliente_id,
    c.nombre                        AS quien,
    c.estado
FROM clientes c
WHERE c.ip IS NOT NULL
  AND c.ip <> ''
  AND c.estado <> 'baja'

UNION ALL

/**
 * Lo reservado en el IPAM que NO es de un abonado.
 *
 * Son gateways, enlaces, cámaras, equipos de gestión. Se cuentan como ocupadas
 * porque lo están, aunque nadie pague por ellas — y son justo las que más duele
 * pisar.
 *
 * Se dejan afuera dos cosas, y las dos importan:
 *
 *   LAS QUE TIENEN `client_id`. Esa dirección ya vino contada por el abonado, y
 *   contarla de nuevo la haría aparecer en la lista de conflictos peleando
 *   consigo misma.
 *
 *   LAS QUE ESTÁN EN `libre`. La tabla nació para volcar lo que hay en el
 *   router, y una fila en estado libre es justamente una dirección disponible:
 *   tratarla como ocupada dejaría bloques enteros sin poder asignar.
 */
SELECT
    d.ip_address                    AS ip,
    COALESCE(d.router_id, s.router_id) AS router_id,
    'reserva'::TEXT                 AS origen,
    NULL::UUID                      AS cliente_id,
    COALESCE(d.descripcion, d.interfaz, 'reservada en el IPAM') AS quien,
    NULL::TEXT                      AS estado
FROM ip_addresses d
LEFT JOIN subredes s ON s.id = d.subred_id
WHERE d.client_id IS NULL
  AND COALESCE(d.estado, 'libre') <> 'libre';

COMMENT ON VIEW v_ips_en_uso IS
    'Toda dirección tomada: la de cada abonado que no está de baja, más lo reservado en el IPAM. Es lo que hay que consultar antes de asignar una IP.';


/**
 * ¿Quién tiene esta dirección?
 *
 * Devuelve el nombre de quien la ocupa, o NULL si está libre. Se devuelve el
 * NOMBRE y no un booleano a propósito: "esa IP está ocupada" obliga a ir a
 * buscar por quién, y el que está dando de alta a un abonado con el técnico
 * esperando en el poste no va a ir a buscar nada.
 *
 * `p_excluir` es el abonado que se está editando: al guardar su propia ficha sin
 * cambiarle la IP, no puede chocar consigo mismo.
 */
CREATE OR REPLACE FUNCTION quien_tiene_la_ip(
    p_ip      TEXT,
    p_router  UUID DEFAULT NULL,
    p_excluir UUID DEFAULT NULL
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT u.quien
      FROM v_ips_en_uso u
     WHERE u.ip = TRIM(p_ip)
       -- Sin router, se busca en toda la red: dos abonados de routers distintos
       -- con la misma IP privada es normal y no choca. Con router, solo ahí.
       AND (p_router IS NULL OR u.router_id = p_router OR u.router_id IS NULL)
       AND (p_excluir IS NULL OR u.cliente_id IS DISTINCT FROM p_excluir)
     LIMIT 1
$$;

COMMENT ON FUNCTION quien_tiene_la_ip IS
    'El nombre de quien ocupa esa IP, o NULL si está libre. Consultar SIEMPRE antes de asignar una dirección.';


-- =============================================================================
-- La primera libre, mirando de verdad
-- =============================================================================
/**
 * La primera dirección disponible de un bloque.
 *
 * Reemplaza la cuenta que hacía la pantalla, que solo miraba `ip_addresses`.
 * Ahora mira también a los abonados — que es donde están las direcciones de
 * verdad después de migrar un padrón.
 *
 * Se saltean la primera y la última del bloque: la primera suele ser el gateway
 * y la última es el broadcast. Entregar cualquiera de las dos deja al abonado
 * sin servicio de una forma que cuesta ver.
 */
CREATE OR REPLACE FUNCTION primera_ip_libre(p_subred UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sub    subredes%ROWTYPE;
    v_desde  BIGINT;
    v_hasta  BIGINT;
    v_n      BIGINT;
    v_ip     TEXT;
BEGIN
    SELECT * INTO v_sub FROM subredes WHERE id = p_subred;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa subred';
    END IF;

    -- Solo IPv4. En un /64 de IPv6 recorrer direcciones una por una no termina
    -- nunca, y ahí las direcciones no se reparten así.
    IF family(v_sub.cidr) <> 4 THEN
        RAISE EXCEPTION 'La subred % no es IPv4', v_sub.nombre;
    END IF;

    -- El rango declarado manda sobre el del bloque: un /24 del que el ISP solo
    -- entrega .100 a .200 tiene el resto para otra cosa, y proponer .10 sería
    -- meterse en el medio de sus enlaces.
    v_desde := COALESCE(
        v_sub.rango_desde - '0.0.0.0'::INET,
        (network(v_sub.cidr) - '0.0.0.0'::INET) + 1
    );
    v_hasta := COALESCE(
        v_sub.rango_hasta - '0.0.0.0'::INET,
        (broadcast(v_sub.cidr) - '0.0.0.0'::INET) - 1
    );

    v_n := v_desde;
    WHILE v_n <= v_hasta LOOP
        v_ip := host('0.0.0.0'::INET + v_n);

        IF quien_tiene_la_ip(v_ip, v_sub.router_id) IS NULL
           -- Ni el gateway del propio bloque, aunque nadie lo haya registrado.
           AND (v_sub.gateway IS NULL OR v_ip <> host(v_sub.gateway))
        THEN
            RETURN v_ip;
        END IF;

        v_n := v_n + 1;
    END LOOP;

    RETURN NULL;
END $$;

COMMENT ON FUNCTION primera_ip_libre IS
    'La primera dirección disponible del bloque, mirando los abonados y las reservas. NULL si no queda ninguna.';


-- =============================================================================
-- Las que ya chocan hoy
-- =============================================================================
/**
 * Direcciones que tienen más de un dueño.
 *
 * El índice único de `clientes (router_id, ip)` impide que dos abonados del
 * MISMO router compartan una IP. No impide que la comparta un abonado con una
 * reserva del IPAM, ni que dos abonados de routers distintos tengan la misma
 * cuando uno de los dos está mal cargado.
 *
 * Después de migrar un padrón es lo primero que hay que mirar.
 */
CREATE OR REPLACE VIEW v_ips_en_conflicto WITH (security_invoker = true) AS
SELECT
    u.ip,
    u.router_id,
    COUNT(*)                                   AS cuantos,
    STRING_AGG(u.quien, ' · ' ORDER BY u.quien) AS quienes,
    ARRAY_AGG(u.cliente_id) FILTER (WHERE u.cliente_id IS NOT NULL) AS clientes
FROM v_ips_en_uso u
GROUP BY u.ip, u.router_id
HAVING COUNT(*) > 1;

COMMENT ON VIEW v_ips_en_conflicto IS
    'Direcciones con más de un dueño. Lo primero que hay que revisar después de importar un padrón.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- ¿Alguien tiene esta IP?
--   SELECT quien_tiene_la_ip('10.20.1.15');
--
--   -- ¿Cuántas direcciones ocupa cada router?
--   SELECT r.nombre, COUNT(*) FROM v_ips_en_uso u
--     LEFT JOIN routers_mikrotik r ON r.id = u.router_id
--    GROUP BY r.nombre ORDER BY 2 DESC;
--
--   -- ¿Hay choques?
--   SELECT * FROM v_ips_en_conflicto;
