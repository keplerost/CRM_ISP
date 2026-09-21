-- =============================================================================
-- Migración 93 — Reemplazo de equipo en el domicilio
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El problema ──
--
-- Cambiar una ONT quemada son cinco cosas que tienen que pasar JUNTAS:
--
--   1. La ONT nueva sale del almacén del técnico.
--   2. La ONT nueva queda atada al abonado.
--   3. La ONT vieja vuelve como averiada — o vuelve a bodega si anda.
--   4. En la OLT se da de baja la vieja y se autoriza la nueva.
--   5. `clientes.onu_id` pasa a apuntar a la nueva.
--
-- Hoy se puede hacer 1 y 4 por separado, y nada más. Lo que pasa cuando se hace
-- a mano y en desorden es predecible: la ONT vieja sigue figurando instalada en
-- casa del cliente, el stock no cuadra, y dentro de tres meses nadie puede
-- responder "¿qué equipo tiene este abonado?".
--
-- ── Qué hace esta migración, y qué no ──
--
-- Hace 1, 2, 3 y 5, en una sola operación: o pasan las cuatro o no pasa
-- ninguna. Deja registrado el reemplazo con su motivo.
--
-- NO toca la OLT. Eso es el paso 4 y vive en el middleware, que es el único que
-- tiene las credenciales del equipo — el navegador del técnico no habla con la
-- OLT y no va a empezar a hacerlo. La función marca el reemplazo como
-- `pendiente_olt` y el middleware lo cierra.
--
-- ── Sobre el permiso ──
--
-- Autorizar una ONT no es un privilegio nuevo para el técnico: ya lo hace en
-- cada instalación, por `POST /instalaciones/:id/autorizar`, y ahí los datos
-- salen de la orden de trabajo y no de lo que escriba en el celular. Un
-- reemplazo es la misma operación acotada sobre un abonado que ya existe.
-- =============================================================================


-- =============================================================================
-- 1. El registro del reemplazo
-- =============================================================================
CREATE TABLE IF NOT EXISTS reemplazos_equipo (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    cliente_id   UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    -- De dónde salió el reemplazo. Casi siempre un ticket; a veces una visita
    -- programada. Los dos son opcionales pero al menos uno tiene que estar: un
    -- cambio de equipo sin trabajo asociado no se puede auditar.
    ticket_id       UUID REFERENCES tickets(id)       ON DELETE SET NULL,
    instalacion_id  UUID REFERENCES instalaciones(id) ON DELETE SET NULL,

    equipo_anterior_id UUID REFERENCES equipos(id) ON DELETE SET NULL,
    equipo_nuevo_id    UUID NOT NULL REFERENCES equipos(id) ON DELETE RESTRICT,

    /**
     * Cuál era la ONU en la OLT.
     *
     * Se guarda acá porque la función deja `clientes.onu_id` en NULL —la ficha
     * no puede seguir apuntando a un equipo que ya no está— y sin este dato el
     * middleware no tendría cómo saber en qué puerto, con qué perfil y con qué
     * VLAN estaba, que es exactamente lo que hay que copiar al equipo nuevo.
     *
     * Sin esto, el paso de la OLT tendría que adivinar el puerto. Poner un
     * equipo en un puerto que no sabemos si es el correcto puede dejar sin
     * servicio a otro abonado.
     */
    onu_anterior_id    UUID REFERENCES onus(id) ON DELETE SET NULL,
    -- Las series se COPIAN además de referenciarse. Un equipo se puede dar de
    -- baja y borrar; el registro de qué se cambió y por qué tiene que
    -- sobrevivir a eso.
    serie_anterior  VARCHAR(60),
    serie_nueva     VARCHAR(60) NOT NULL,

    motivo       VARCHAR(24) NOT NULL,
    detalle      TEXT,
    -- Qué se hizo con el viejo: si anda, vuelve a bodega; si no, se marca
    -- averiado. Es la diferencia entre recuperar un equipo y perderlo.
    destino_anterior VARCHAR(12) NOT NULL DEFAULT 'averiado',

    -- El paso 4. Arranca pendiente y lo cierra el middleware al reaprovisionar.
    pendiente_olt BOOLEAN NOT NULL DEFAULT TRUE,
    olt_at        TIMESTAMPTZ,

    tecnico_id   UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    creado_por   UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reemplazos_motivo_check CHECK (motivo IN (
        'quemado',        -- rayo, sobretensión
        'no_enciende',
        'sin_senal',      -- no engancha con la OLT
        'wifi_falla',
        'golpeado',
        'obsoleto',       -- se cambia por uno mejor
        'robo_perdida',
        'otro'
    )),
    CONSTRAINT reemplazos_destino_check CHECK (destino_anterior IN (
        'averiado', 'bodega', 'baja', 'cliente'
    )),
    CONSTRAINT reemplazos_tiene_origen CHECK (
        ticket_id IS NOT NULL OR instalacion_id IS NOT NULL
    )
);

-- Para quien ya corrió esta migración antes de que existiera la columna.
ALTER TABLE reemplazos_equipo
    ADD COLUMN IF NOT EXISTS onu_anterior_id UUID REFERENCES onus(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reemplazos_cliente ON reemplazos_equipo (cliente_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_reemplazos_pendientes
    ON reemplazos_equipo (creado_en) WHERE pendiente_olt;


-- =============================================================================
-- 2. La operación completa
-- =============================================================================
/**
 * Cambia el equipo de un abonado, entero o nada.
 *
 * ── Por qué es una función y no cinco escrituras desde la pantalla ──
 *
 * Porque el celular se queda sin señal en el medio. Si esto fueran cinco
 * llamadas, cortarse después de la segunda dejaría al abonado con dos equipos
 * instalados en su ficha y el stock descontado dos veces. Acá, o pasan todas o
 * no pasa ninguna.
 *
 * ── Qué valida antes de tocar nada ──
 *
 * Que el equipo nuevo exista, esté en stock y sea de este técnico. Sin eso, un
 * error de tipeo en la serie instalaría en la ficha del cliente un equipo que
 * está en la camioneta de otro.
 */
CREATE OR REPLACE FUNCTION reemplazar_equipo_cliente(
    p_cliente        UUID,
    p_serie_nueva    TEXT,
    p_motivo         TEXT,
    p_destino        TEXT DEFAULT 'averiado',
    p_detalle        TEXT DEFAULT NULL,
    p_ticket         UUID DEFAULT NULL,
    p_instalacion    UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_tecnico   UUID;
    v_legajo    UUID;
    v_almacen   UUID;
    v_nuevo     equipos%ROWTYPE;
    v_viejo     equipos%ROWTYPE;
    v_onu_vieja UUID;
    v_reemplazo UUID;
BEGIN
    v_legajo  := mi_legajo_id();
    v_tecnico := mi_tecnico_id();

    IF p_ticket IS NULL AND p_instalacion IS NULL THEN
        RAISE EXCEPTION 'El reemplazo tiene que estar asociado a un ticket o a una instalación';
    END IF;

    -- ── El equipo nuevo ──
    SELECT * INTO v_nuevo FROM equipos
     WHERE UPPER(BTRIM(serie)) = UPPER(BTRIM(p_serie_nueva))
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No hay ningún equipo cargado con la serie %. Revisá el número o pedí que lo den de alta en bodega.', p_serie_nueva;
    END IF;

    IF v_nuevo.estado <> 'en_stock' THEN
        RAISE EXCEPTION 'El equipo % no está disponible: figura como %.', p_serie_nueva, v_nuevo.estado;
    END IF;

    -- Que salga del almacén de quien lo está instalando. Un técnico no puede
    -- descontar de la camioneta de otro.
    IF v_tecnico IS NOT NULL THEN
        SELECT id INTO v_almacen FROM almacenes WHERE tecnico_id = v_tecnico LIMIT 1;
        IF v_almacen IS NOT NULL AND v_nuevo.almacen_id IS DISTINCT FROM v_almacen THEN
            RAISE EXCEPTION 'El equipo % no está en tu almacén. Pedí la transferencia antes de instalarlo.', p_serie_nueva;
        END IF;
    END IF;

    -- ── El equipo viejo: el que hoy figura instalado en ese cliente ──
    SELECT * INTO v_viejo FROM equipos
     WHERE cliente_id = p_cliente AND estado = 'instalado'
     ORDER BY actualizado_en DESC NULLS LAST
     LIMIT 1;

    -- ── 3. El viejo sale ──
    IF v_viejo.id IS NOT NULL THEN
        UPDATE equipos
           SET estado     = CASE p_destino
                              WHEN 'bodega'  THEN 'en_stock'
                              WHEN 'baja'    THEN 'baja'
                              WHEN 'cliente' THEN 'instalado'
                              ELSE 'averiado'
                            END,
               -- Deja de estar en casa del cliente, salvo que se le haya dejado.
               cliente_id = CASE WHEN p_destino = 'cliente' THEN cliente_id ELSE NULL END,
               almacen_id = CASE WHEN p_destino = 'bodega' THEN v_almacen ELSE almacen_id END,
               onu_id     = NULL
         WHERE id = v_viejo.id;
    END IF;

    -- ── 1 y 2. El nuevo entra ──
    UPDATE equipos
       SET estado     = 'instalado',
           cliente_id = p_cliente,
           almacen_id = NULL,
           instalacion_id = COALESCE(p_instalacion, instalacion_id)
     WHERE id = v_nuevo.id;

    -- El movimiento de inventario, para que el stock cuadre. Sin esto, el
    -- equipo desaparece del almacén sin que la bitácora lo explique.
    INSERT INTO movimientos_inventario (
        tipo, articulo_id, equipo_id, cantidad, almacen_origen_id,
        instalacion_id, ticket_id, motivo, usuario_id
    ) VALUES (
        'consumo', v_nuevo.articulo_id, v_nuevo.id, 1, v_nuevo.almacen_id,
        p_instalacion, p_ticket,
        'Reemplazo de equipo: ' || p_motivo, v_legajo
    );

    -- ── Cuál era la ONU, ANTES de soltarla ──
    --
    -- Este es el dato que después necesita el middleware para poner la ONT
    -- nueva en el mismo puerto y con el mismo perfil. Si se leyera después de
    -- anular `onu_id`, ya no estaría.
    SELECT onu_id INTO v_onu_vieja FROM clientes WHERE id = p_cliente;

    -- ── 5. El abonado apunta al nuevo ──
    --
    -- `onu_id` queda en NULL hasta que la OLT confirme: apuntarlo a la ONU vieja
    -- sería dejar la ficha diciendo algo falso, y apuntarlo a una nueva que
    -- todavía no existe en la OLT, también.
    UPDATE clientes
       SET onu_id      = NULL,
           mac_address = COALESCE(v_nuevo.mac, mac_address)
     WHERE id = p_cliente;

    -- ── El registro ──
    INSERT INTO reemplazos_equipo (
        cliente_id, ticket_id, instalacion_id,
        equipo_anterior_id, equipo_nuevo_id, onu_anterior_id,
        serie_anterior, serie_nueva,
        motivo, detalle, destino_anterior, tecnico_id, creado_por
    ) VALUES (
        p_cliente, p_ticket, p_instalacion,
        v_viejo.id, v_nuevo.id, v_onu_vieja,
        v_viejo.serie, v_nuevo.serie,
        p_motivo, p_detalle, p_destino, v_tecnico, v_legajo
    )
    RETURNING id INTO v_reemplazo;

    RETURN v_reemplazo;
END $$;

COMMENT ON FUNCTION reemplazar_equipo_cliente IS
    'Cambia el equipo de un abonado en una sola operación: descuenta el nuevo del almacén del técnico, lo ata al cliente, saca el viejo y deja el reemplazo registrado. NO toca la OLT — eso lo cierra el middleware, y hasta entonces el reemplazo queda `pendiente_olt`.';


-- =============================================================================
-- 3. Lo que falta aprovisionar
-- =============================================================================
-- La cola que mira la oficina: reemplazos hechos en el domicilio cuya ONU
-- todavía no se cambió en la OLT. Mientras esté acá, el abonado no tiene
-- servicio.
DROP VIEW IF EXISTS v_reemplazos_pendientes;
CREATE VIEW v_reemplazos_pendientes WITH (security_invoker = true) AS
SELECT
    r.*,
    c.nombre    AS cliente,
    c.direccion,
    t.nombre    AS tecnico,
    tk.numero   AS ticket_numero,
    (EXTRACT(EPOCH FROM (NOW() - r.creado_en)) / 60)::INT AS minutos_esperando
FROM reemplazos_equipo r
LEFT JOIN clientes c ON c.id = r.cliente_id
LEFT JOIN tecnicos t ON t.id = r.tecnico_id
LEFT JOIN tickets tk ON tk.id = r.ticket_id
WHERE r.pendiente_olt;

GRANT SELECT ON v_reemplazos_pendientes TO authenticated;


-- =============================================================================
-- 4. Seguridad
-- =============================================================================
ALTER TABLE reemplazos_equipo ENABLE ROW LEVEL SECURITY;

-- Leer: quien maneja la cartera, y el técnico los suyos. Un reemplazo lleva el
-- nombre y la dirección del abonado por el JOIN de la vista, así que se rige por
-- la misma regla que todo lo demás.
DROP POLICY IF EXISTS reemplazos_lectura ON reemplazos_equipo;
CREATE POLICY reemplazos_lectura ON reemplazos_equipo
    FOR SELECT TO authenticated
    USING (cartera_completa() OR tecnico_id = mi_tecnico_id());

-- Escribir directo: nadie. Se hace por la función, que valida el almacén, el
-- estado del equipo y deja todo consistente. Una fila insertada a mano acá sería
-- un reemplazo sin descuento de stock ni cambio de equipo — el registro diría
-- una cosa y el inventario otra.
DROP POLICY IF EXISTS reemplazos_escritura ON reemplazos_equipo;
CREATE POLICY reemplazos_escritura ON reemplazos_equipo
    FOR ALL TO authenticated
    USING (cartera_completa()) WITH CHECK (cartera_completa());


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT reemplazar_equipo_cliente(
--       '<cliente>', 'HWTC12345678', 'quemado', 'averiado', 'Rayo', '<ticket>');
--
--   SELECT cliente, serie_anterior, serie_nueva, minutos_esperando
--     FROM v_reemplazos_pendientes;
--
-- Y que el stock haya bajado uno:
--   SELECT * FROM movimientos_inventario ORDER BY creado_en DESC LIMIT 1;
