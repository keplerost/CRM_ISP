-- =============================================================================
-- Migración 85 — El monitoreo de red, cerrado y abierto donde corresponde
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── La puerta que quedaba ──
--
-- Se acaba de agregar verificación de permisos al middleware: un técnico ya no
-- puede llamar a `/api/nms/sondear` ni a `/api/mikrotik/*`.
--
-- Eso no servía de nada mientras la tabla siguiera así:
--
--     CREATE POLICY "auth_all_nodos_red" ON nodos_red
--         FOR ALL TO authenticated USING (true) WITH CHECK (true);
--
-- `FOR ALL` incluye INSERT, UPDATE y DELETE. Cualquiera con sesión podía —desde
-- la consola del navegador, sin tocar el middleware— leer el inventario
-- completo de nodos con sus IPs, cambiarle la IP a una torre, o borrar el nodo
-- para que dejara de monitorearse. Cerrar el pasillo y dejar la ventana abierta
-- es no haber cerrado nada.
--
-- Es la misma clase de puerta lateral que cerró la migración 71 para los datos
-- de abonados. Esta quedó afuera porque en ese momento la red no era el tema.
--
-- ── Lo que sí necesita el técnico ──
--
-- Saber si el nodo de la zona está caído. Parado en la vereda, eso es la
-- diferencia entre revisar el domicilio durante una hora y avisar en dos
-- minutos que la falla no es de ahí.
--
-- Necesita eso: el estado. No la IP, no el usuario SNMP, no el router al que
-- cuelga. Por eso lo que se le abre es una VISTA con las columnas justas, y no
-- la tabla.
-- =============================================================================


-- =============================================================================
-- 1. Quién puede mirar el estado de la red
-- =============================================================================
CREATE OR REPLACE FUNCTION puede_ver_monitoreo()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*'
             OR permisos ? 'red.monitoreo'
             OR permisos ? 'red.monitoreo_ver'
           FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1),
        -- Sin legajo se permite, igual que el resto de los ayudantes: una
        -- instalación que todavía no corrió la migración 66 no puede quedarse
        -- sin monitoreo de golpe.
        TRUE
    )
$$;

/** Quién puede TOCARLA: dar de alta nodos, cambiar IPs, forzar sondeos. */
CREATE OR REPLACE FUNCTION puede_operar_red()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'red.monitoreo'
           FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1),
        TRUE
    )
$$;


-- =============================================================================
-- 2. La tabla se cierra
-- =============================================================================
DROP POLICY IF EXISTS "auth_all_nodos_red" ON nodos_red;
DROP POLICY IF EXISTS nodos_red_lectura ON nodos_red;
DROP POLICY IF EXISTS nodos_red_escritura ON nodos_red;

-- Leer la tabla cruda —con IP, router y credenciales de sondeo— es para quien
-- opera la red. El técnico entra por la vista de más abajo.
CREATE POLICY nodos_red_lectura ON nodos_red
    FOR SELECT TO authenticated USING (puede_operar_red());

CREATE POLICY nodos_red_escritura ON nodos_red
    FOR ALL TO authenticated
    USING (puede_operar_red())
    WITH CHECK (puede_operar_red());

DROP POLICY IF EXISTS "auth_all_nodo_eventos" ON nodo_eventos;
DROP POLICY IF EXISTS nodo_eventos_lectura ON nodo_eventos;
DROP POLICY IF EXISTS nodo_eventos_escritura ON nodo_eventos;

-- El historial de caídas lo puede LEER quien mira el estado: sirve para saber
-- si la zona viene fallando o si es de ahora.
CREATE POLICY nodo_eventos_lectura ON nodo_eventos
    FOR SELECT TO authenticated USING (puede_ver_monitoreo());

-- Escribirlo, no. Los eventos los genera el sondeo desde el middleware. Un
-- historial de caídas que el interesado puede editar no sirve para lo que se lo
-- consulta.
CREATE POLICY nodo_eventos_escritura ON nodo_eventos
    FOR ALL TO authenticated
    USING (puede_operar_red())
    WITH CHECK (puede_operar_red());


-- =============================================================================
-- 3. Lo que ve el técnico
-- =============================================================================
-- Solo lo que sirve para decidir en la vereda: cómo se llama, en qué zona está,
-- si responde, y desde cuándo.
--
-- Sin `ip`, sin `router_id`, sin comunidad SNMP, sin usuario ni clave. No es
-- desconfianza del técnico: es que esos datos no le sirven para nada en campo, y
-- todo dato que viaja al navegador es un dato que viaja al teléfono que se puede
-- perder o que alguien puede mirar por encima del hombro.
DROP VIEW IF EXISTS v_estado_red;
CREATE VIEW v_estado_red
-- Sin `security_invoker`: la vista corre con los permisos de quien la creó y por
-- eso puede leer `nodos_red`, que acaba de cerrarse. Es a propósito y es el
-- motivo de que exista — pero significa que la vista NO hereda RLS, así que el
-- filtro tiene que estar acá adentro. De ahí el WHERE.
AS
SELECT
    n.id,
    n.nombre,
    n.tipo,
    -- Dónde está, por nombre del punto. No van las coordenadas del sitio: el
    -- técnico va al domicilio del cliente, no a la torre.
    pr.nombre AS punto,
    n.estado,
    n.monitorear,
    n.latencia_ms,
    n.perdida_pct,
    n.ultimo_chequeo,
    n.desde,
    -- Cuánto hace que está así. Un nodo caído hace tres minutos y otro caído
    -- hace seis horas piden cosas distintas.
    CASE WHEN n.desde IS NULL THEN NULL
         ELSE (EXTRACT(EPOCH FROM (NOW() - n.desde)) / 60)::INT END AS minutos_asi,
    -- Si el padre está caído, lo de este nodo es consecuencia y no noticia.
    -- Sin esto, un corte de fibra en cabecera le muestra al técnico veinte
    -- nodos rojos y ninguna pista de cuál es el que importa.
    (p.estado = 'down') AS por_el_padre,
    p.nombre AS depende_de,
    -- Si es suyo. Lo primero que quiere ver es su zona.
    (n.tecnico_id IS NOT NULL AND n.tecnico_id = mi_tecnico_id()) AS es_mio
FROM nodos_red n
LEFT JOIN nodos_red  p  ON p.id  = n.padre_id
LEFT JOIN puntos_red pr ON pr.id = n.punto_id
WHERE puede_ver_monitoreo();

COMMENT ON VIEW v_estado_red IS
    'El estado de la red para quien trabaja en campo: nombre, zona y si responde. Sin IPs ni credenciales. El filtro va en el WHERE porque la vista no hereda RLS a propósito.';

GRANT SELECT ON v_estado_red TO authenticated;


-- =============================================================================
-- 4. Comprobación
-- =============================================================================
-- Después de correr esto, entrando como técnico tiene que dar:
--
--   SELECT count(*) FROM nodos_red;     →  0 filas    (cerrado)
--   SELECT count(*) FROM v_estado_red;  →  N filas    (abierto, sin IPs)
--   INSERT INTO nodos_red ...           →  error 42501
--
-- Si `nodos_red` devuelve filas siendo técnico, la migración no aplicó.
