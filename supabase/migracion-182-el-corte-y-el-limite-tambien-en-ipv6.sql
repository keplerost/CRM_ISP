-- =============================================================================
-- Migración 182 — El corte y el límite también en IPv6
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── El agujero que tapa ──
--
-- El sistema corta metiendo la IP del moroso en un `address-list` de
-- `/ip/firewall` y bloqueándola con una regla filter. Eso es IPv4 y solamente
-- IPv4.
--
-- El día que un ISP le entregue IPv6 a sus abonados, el moroso queda cortado en
-- v4 y **sigue navegando por v6**. Y como Google, YouTube, Facebook y Netflix
-- responden por IPv6, para él no cambia casi nada: el sistema anota el corte
-- como hecho y el cliente sigue conectado.
--
-- Lo mismo con la velocidad: la `simple queue` limita su IPv4 y el tráfico v6
-- pasa sin tope.
--
-- ── Por qué es opcional y apagado por defecto ──
--
-- Porque la mayoría de los ISP todavía no entrega IPv6, y un sistema que
-- intenta escribir en `/ipv6/firewall` de un router sin el paquete habilitado
-- falla en cada corte. Se enciende por router, y solo cuando ese equipo ya
-- entrega IPv6 de verdad.
--
-- ── Por qué va por router y no por ISP ──
--
-- Porque la migración a IPv6 es gradual: se empieza por un nodo, se prueba, y
-- recién después se extiende. Un interruptor global obligaría a tenerlo todo
-- listo el mismo día.
--
-- ── Sirve igual para fibra y para radioenlace ──
--
-- Nada de esto toca la OLT ni depende del medio: son reglas de capa 3 en el
-- MikroTik. Un abonado por radioenlace con IPv6 se corta y se limita igual que
-- uno de fibra.
-- =============================================================================


-- =============================================================================
-- 1. El interruptor, por router
-- =============================================================================
ALTER TABLE routers_mikrotik
    /**
     * Si este equipo ya entrega IPv6 a sus abonados.
     *
     * Apagado, el sistema se comporta exactamente como hasta hoy: ni lee ni
     * escribe nada en `/ipv6/`. Encendido, cada corte y cada límite se aplican
     * en las dos versiones.
     */
    ADD COLUMN IF NOT EXISTS ipv6_activo BOOLEAN NOT NULL DEFAULT false,

    /**
     * La lista de corte de v6.
     *
     * Separada de la de v4 y con su propio nombre porque en RouterOS son dos
     * espacios distintos: `/ip/firewall/address-list` y
     * `/ipv6/firewall/address-list` no se ven entre sí. Usar el mismo nombre en
     * las dos funciona, pero lleva a creer que es una sola lista y a diagnosticar
     * mal el día que una corta y la otra no.
     */
    ADD COLUMN IF NOT EXISTS ipv6_lista_morosos VARCHAR(60) DEFAULT 'CORTE_MOROSOS_V6',

    -- Cuándo se preparó el equipo, para saber si las reglas están puestas sin
    -- tener que abrir una conexión.
    ADD COLUMN IF NOT EXISTS ipv6_preparado_at TIMESTAMPTZ;

COMMENT ON COLUMN routers_mikrotik.ipv6_activo IS
    'Si este router entrega IPv6 a los abonados. Apagado, el sistema no toca nada de /ipv6.';

COMMENT ON COLUMN routers_mikrotik.ipv6_lista_morosos IS
    'address-list de /ipv6/firewall donde entran los cortados. Es OTRA lista que la de v4: en RouterOS los dos espacios no se ven entre si.';


-- =============================================================================
-- 2. El prefijo delegado de cada abonado
-- =============================================================================
-- `clientes.ipv6` ya existe desde la migración 11, pero como texto suelto de 45
-- caracteres pensado para UNA dirección. Lo que hay que guardar es el PREFIJO
-- delegado —un /56 o /64— porque es sobre el prefijo entero que se corta y se
-- limita, no sobre una dirección: el abonado tiene cientos adentro y cambia de
-- una a otra sin avisar.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS ipv6_prefijo VARCHAR(60);

COMMENT ON COLUMN clientes.ipv6_prefijo IS
    'El prefijo delegado al abonado, ej. 2803:1234:5678:1200::/56. Es lo que se bloquea al cortar y lo que se limita en la cola: una sola direccion no alcanza porque el cliente usa cientos.';

-- Si alguien ya había cargado algo en `ipv6` con forma de prefijo, se copia.
UPDATE clientes
   SET ipv6_prefijo = ipv6
 WHERE ipv6_prefijo IS NULL
   AND ipv6 IS NOT NULL
   AND ipv6 LIKE '%/%';


-- =============================================================================
-- 3. Que el prefijo tenga forma de prefijo
-- =============================================================================
-- No valida que sea un IPv6 correcto —eso lo hace el middleware— pero sí que
-- traiga la barra. Un `2803:1234::` sin `/56` cargado como prefijo hace que el
-- corte bloquee una sola dirección y el abonado siga navegando con las otras.
ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_ipv6_prefijo_check;
ALTER TABLE clientes
    ADD CONSTRAINT clientes_ipv6_prefijo_check
    CHECK (ipv6_prefijo IS NULL OR ipv6_prefijo LIKE '%:%/%');


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, ipv6_activo, ipv6_lista_morosos, ipv6_preparado_at
--     FROM routers_mikrotik;
--
--   SELECT nombre, ipv6_prefijo FROM clientes WHERE ipv6_prefijo IS NOT NULL;
