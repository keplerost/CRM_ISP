-- =============================================================================
-- Migración 115 — La firma del abonado, por qué no se recuperó, y cerrar la ficha
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Las tres piezas que faltaban del circuito ──
--
--   1. LA FIRMA DEL ABONADO al entregar el equipo.
--
--      Hoy el técnico cierra la orden y dice "lo recuperé". Nada prueba que el
--      abonado lo entregó. El día que alguien reclame —"yo entregué la ONT",
--      "a mí nunca me la dieron"— no hay contra qué mirar. Es el mismo problema
--      que el acta con la oficina, un eslabón antes.
--
--   2. POR QUÉ NO SE RECUPERÓ, en categorías y no en texto libre.
--
--      Cualquiera puede declarar un equipo perdido con un clic y una palabra, y
--      hoy no se distinguen tres cosas que no son iguales: el que se mudó sin
--      avisar, el que se niega estando localizable, y el que nadie fue a buscar.
--      Mezclados, el indicador de "valor perdido" no sirve para decidir nada.
--
--   3. CERRAR LA FICHA DEL ABONADO.
--
--      El equipo vuelve a la bodega y el abonado sigue figurando como activo.
--      No se borra la ficha —los pagos, las facturas del SRI y las comisiones
--      pagadas apuntan a ella— pero tiene que quedar marcada como retirada. Y
--      el aviso se repite hasta que alguien lo haga: un pendiente que suena una
--      sola vez es un pendiente que se pierde.
-- =============================================================================


-- =============================================================================
-- 1. La firma de quien entrega el equipo
-- =============================================================================
ALTER TABLE retiros_equipo
    ADD COLUMN IF NOT EXISTS firma_b64        TEXT,
    ADD COLUMN IF NOT EXISTS firmante         VARCHAR(150),
    ADD COLUMN IF NOT EXISTS firmado_en       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS categoria_cierre VARCHAR(24);

COMMENT ON COLUMN retiros_equipo.firma_b64 IS
    'El trazo de quien entregó el equipo, como imagen. No es una firma certificada: es la prueba de que alguien, en esa casa y ese día, entregó el aparato.';
COMMENT ON COLUMN retiros_equipo.firmante IS
    'Quién firmó. Casi nunca es el titular: firma el hijo, la esposa, el inquilino. Por eso se escribe el nombre y no se asume.';


-- =============================================================================
-- 2. Por qué no se recuperó
-- =============================================================================
-- ── Por qué una tabla y no un CHECK ──
--
-- Porque cada categoría lleva reglas asociadas —si cuenta como pérdida, si se
-- puede reclamar, si deja deuda de equipo en la ficha— y eso en un CHECK no
-- entra. Además la lista va a crecer: el día que aparezca un caso nuevo se
-- agrega una fila, no una migración.
CREATE TABLE IF NOT EXISTS retiro_categorias (
    clave       VARCHAR(24) PRIMARY KEY,
    nombre      VARCHAR(80) NOT NULL,
    descripcion TEXT,

    -- Si el equipo se da por perdido. `error_de_registro` y `equipo_dañado` no
    -- lo son: uno corrige el inventario, el otro es una baja técnica.
    es_perdida  BOOLEAN NOT NULL DEFAULT TRUE,
    -- Si todavía se le puede reclamar a alguien que existe y está localizable.
    reclamable  BOOLEAN NOT NULL DEFAULT FALSE,
    -- Si al cerrar hay que proponer dar de baja al abonado.
    cierra_ficha BOOLEAN NOT NULL DEFAULT TRUE,

    orden       SMALLINT NOT NULL DEFAULT 0,
    activa      BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO retiro_categorias (clave, nombre, descripcion, es_perdida, reclamable, cierra_ficha, orden) VALUES
    ('mudanza_sin_aviso', 'Se mudó sin avisar',
     'No vive más ahí y no hay forma de contactarlo. La casa está vacía o vive otra gente.', TRUE, FALSE, TRUE, 1),
    ('se_niega', 'Se niega a entregarlo',
     'Está localizable y no lo devuelve. Se le puede reclamar.', TRUE, TRUE, TRUE, 2),
    ('no_contesta', 'No contesta y no se lo encuentra',
     'Se lo llamó y se fue al domicilio varias veces sin dar con él.', TRUE, FALSE, TRUE, 3),
    ('equipo_robado', 'Robo o siniestro',
     'El abonado dice que se lo robaron o se quemó. Conviene pedir la denuncia.', TRUE, FALSE, TRUE, 4),
    ('equipo_dañado', 'El equipo está roto',
     'Se recuperó pero no sirve. No es una falla de recuperación: es una baja técnica.', FALSE, FALSE, TRUE, 5),
    ('cliente_fallecio', 'El abonado falleció', NULL, TRUE, FALSE, TRUE, 6),
    ('zona_insegura', 'Zona insegura',
     'No se puede ir a buscar. Marca la zona, además del equipo.', TRUE, FALSE, TRUE, 7),
    ('error_de_registro', 'Error de registro',
     'El equipo nunca estuvo en esa casa. No es una pérdida: corrige el inventario.', FALSE, FALSE, FALSE, 8)
ON CONFLICT (clave) DO NOTHING;

ALTER TABLE retiro_categorias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS retiro_categorias_lectura ON retiro_categorias;
CREATE POLICY retiro_categorias_lectura ON retiro_categorias
    FOR SELECT TO authenticated USING (true);


-- ── El CHECK de `motivo` tiene que dejar entrar las categorías nuevas ──
--
-- La 101 lo dejó con su propia lista de motivos, y las claves de acá no están
-- ahí: cerrar una orden con `mudanza_sin_aviso` rompía contra
-- `retiros_motivo_check`. Se amplía en vez de borrarlo — las órdenes viejas
-- tienen valores de la lista original y hay que seguir aceptándolos.
--
-- `cliente_volvio` es el más importante de conservar: lo escribe sola la tarea
-- nocturna al cancelar la orden de quien volvió a pagar.
ALTER TABLE retiros_equipo DROP CONSTRAINT IF EXISTS retiros_motivo_check;

ALTER TABLE retiros_equipo
    ADD CONSTRAINT retiros_motivo_check CHECK (
        motivo IS NULL OR motivo IN (
            -- Los de la 101, que siguen en las órdenes ya cerradas.
            'no_ubicado', 'se_niega', 'equipo_roto', 'equipo_robado',
            'no_estaba', 'zona_insegura', 'cliente_volvio', 'otro',
            -- Y las categorías de esta migración.
            'mudanza_sin_aviso', 'no_contesta', 'equipo_dañado',
            'cliente_fallecio', 'error_de_registro'
        )
    );


-- =============================================================================
-- 3. Cerrar la orden: con firma si se recuperó, con categoría si no
-- =============================================================================
-- ── Hay que BORRAR la versión anterior, no reemplazarla ──
--
-- `CREATE OR REPLACE FUNCTION` reemplaza solo si la lista de argumentos es
-- idéntica. Al sumarle dos parámetros, Postgres crea una función NUEVA y deja
-- viva la de seis: quedan dos `cerrar_retiro_equipo` y cualquier llamada falla
-- con «function cerrar_retiro_equipo(...) is not unique», porque los defaults
-- hacen que las dos sirvan.
--
-- Eso rompería la pantalla del técnico sin que nadie lo note al escribir la
-- migración. Lo detectó el arnés al correr el circuito completo.
DROP FUNCTION IF EXISTS cerrar_retiro_equipo(UUID, BOOLEAN, TEXT, TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION cerrar_retiro_equipo(
    p_retiro      UUID,
    p_recuperado  BOOLEAN,
    p_motivo      TEXT DEFAULT NULL,
    p_observacion TEXT DEFAULT NULL,
    p_serie       TEXT DEFAULT NULL,
    p_almacen     UUID DEFAULT NULL,
    p_firma       TEXT DEFAULT NULL,
    p_firmante    TEXT DEFAULT NULL
)
RETURNS retiros_equipo
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fila    retiros_equipo%ROWTYPE;
    v_equipo  equipos%ROWTYPE;
    v_almacen UUID;
    v_legajo  UUID := mi_legajo_id();
    v_cat     retiro_categorias%ROWTYPE;
BEGIN
    SELECT * INTO v_fila FROM retiros_equipo WHERE id = p_retiro;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa orden de retiro';
    END IF;

    IF NOT puede_gestionar_retiros()
       AND v_fila.tecnico_id IS DISTINCT FROM mi_tecnico_id()
       AND v_fila.responsable_id IS DISTINCT FROM v_legajo THEN
        RAISE EXCEPTION 'Esa orden de retiro no es tuya';
    END IF;

    IF v_fila.estado NOT IN ('pendiente', 'asignado') THEN
        RAISE EXCEPTION 'Esa orden ya está cerrada (%)', v_fila.estado;
    END IF;

    /*
     * ── Lo que se exige de cada lado ──
     *
     * Si se recuperó: la firma. Es lo único que después distingue "yo entregué
     * la ONT" de "a mí nunca me la dieron".
     *
     * Si no se recuperó: la categoría. Un equipo dado por perdido sin
     * explicación no se puede analizar, y "otro" en un campo de texto no es una
     * explicación.
     */
    IF p_recuperado AND COALESCE(BTRIM(p_firma), '') = '' THEN
        RAISE EXCEPTION 'Falta la firma de quien entrega el equipo';
    END IF;

    IF NOT p_recuperado THEN
        SELECT * INTO v_cat FROM retiro_categorias
         WHERE clave = COALESCE(NULLIF(BTRIM(p_motivo), ''), '—') AND activa;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Hace falta elegir por qué no se recuperó (categoría válida)';
        END IF;
    END IF;

    -- ── El equipo ──
    IF COALESCE(BTRIM(p_serie), '') <> '' THEN
        SELECT * INTO v_equipo FROM equipos
         WHERE UPPER(BTRIM(serie)) = UPPER(BTRIM(p_serie)) LIMIT 1;
    ELSIF v_fila.equipo_id IS NOT NULL THEN
        SELECT * INTO v_equipo FROM equipos WHERE id = v_fila.equipo_id;
    END IF;

    IF p_recuperado AND v_equipo.id IS NOT NULL THEN
        -- Al almacén de quien lo tiene en la mano, como puso la 111.
        v_almacen := COALESCE(
            p_almacen,
            (SELECT a.id FROM almacenes a WHERE a.tecnico_id = v_fila.tecnico_id LIMIT 1),
            (SELECT a.id FROM almacenes a WHERE a.tipo = 'bodega' ORDER BY a.creado_en LIMIT 1)
        );

        UPDATE equipos
           SET estado = 'en_stock', cliente_id = NULL, instalacion_id = NULL, almacen_id = v_almacen
         WHERE id = v_equipo.id;

        INSERT INTO movimientos_inventario (
            tipo, articulo_id, equipo_id, cantidad, almacen_destino_id,
            costo_unit, motivo, usuario_id, usuario_nombre
        )
        SELECT 'devolucion', v_equipo.articulo_id, v_equipo.id, 1, v_almacen,
               NULLIF(v_fila.valor, 0),
               FORMAT('Retiro de equipo por falta de renovación (orden %s)', p_retiro),
               v_legajo,
               (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                  FROM usuarios_sistema u WHERE u.id = v_legajo);

    ELSIF NOT p_recuperado AND v_equipo.id IS NOT NULL THEN
        -- Se da por perdido salvo que la categoría diga que nunca estuvo ahí.
        IF v_cat.clave = 'error_de_registro' THEN
            UPDATE equipos SET cliente_id = NULL, instalacion_id = NULL WHERE id = v_equipo.id;
        ELSE
            UPDATE equipos
               SET estado = 'baja', cliente_id = NULL, instalacion_id = NULL, almacen_id = NULL
             WHERE id = v_equipo.id;
        END IF;
    END IF;

    UPDATE retiros_equipo
       SET estado = CASE WHEN p_recuperado THEN 'recuperado' ELSE 'no_recuperado' END,
           categoria_cierre = CASE WHEN p_recuperado THEN NULL ELSE v_cat.clave END,
           motivo = COALESCE(NULLIF(BTRIM(p_motivo), ''), motivo),
           observaciones = COALESCE(NULLIF(BTRIM(p_observacion), ''), observaciones),
           firma_b64  = COALESCE(NULLIF(BTRIM(p_firma), ''), firma_b64),
           firmante   = COALESCE(NULLIF(BTRIM(p_firmante), ''), firmante),
           firmado_en = CASE WHEN COALESCE(BTRIM(p_firma), '') <> '' THEN NOW() ELSE firmado_en END,
           cerrado_por = v_legajo,
           cerrado_en = NOW()
     WHERE id = p_retiro
    RETURNING * INTO v_fila;

    /*
     * Cuando no se recupera, el pendiente nace acá mismo: no hay acta que
     * esperar. Cuando sí se recupera, el aviso sale al firmarse el acta en la
     * oficina — que es cuando el equipo termina de volver.
     */
    IF NOT p_recuperado AND v_cat.cierra_ficha THEN
        PERFORM avisar_ficha_por_cerrar(v_fila.cliente_id);
    END IF;

    RETURN v_fila;
END $$;


-- =============================================================================
-- 4. El pendiente de cerrar la ficha
-- =============================================================================
/**
 * Avisa que un abonado quedó sin equipo pero sigue figurando como activo.
 *
 * ── Por qué no se cierra solo ──
 *
 * Porque dar de baja a un abonado es una decisión comercial, no una
 * consecuencia mecánica de que volvió una ONT. Puede estar cambiando de
 * domicilio, puede haber pedido el equipo nuevo, puede deber plata que alguien
 * quiere seguir gestionando. El sistema avisa; la persona decide.
 */
CREATE OR REPLACE FUNCTION avisar_ficha_por_cerrar(p_cliente UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cliente clientes%ROWTYPE;
    r RECORD;
BEGIN
    IF p_cliente IS NULL THEN RETURN; END IF;

    SELECT * INTO v_cliente FROM clientes WHERE id = p_cliente;
    IF NOT FOUND OR v_cliente.estado = 'baja' THEN RETURN; END IF;

    -- A todos los que pueden hacerlo, no a uno solo: si el aviso le llega a la
    -- persona que está de vacaciones, el pendiente se queda quieto un mes.
    FOR r IN
        SELECT id FROM usuarios_sistema
         WHERE activo AND (permisos ? '*' OR permisos ? 'clientes.editar' OR permisos ? 'retiros.gestionar')
    LOOP
        PERFORM notificar(
            r.id,
            'ficha_por_cerrar',
            'Ficha por cerrar',
            v_cliente.nombre || ' se quedó sin equipo y sigue como ' || v_cliente.estado ||
            '. Si ya no es abonado, marcalo como retirado.',
            '/inventario/retiros',
            'cliente',
            p_cliente::TEXT
        );
    END LOOP;
END $$;


/** Los que están en esa situación, para la solapa de la pantalla. */
DROP VIEW IF EXISTS v_fichas_por_cerrar;
CREATE VIEW v_fichas_por_cerrar AS
SELECT DISTINCT ON (c.id)
    c.id           AS cliente_id,
    c.codigo,
    c.nombre,
    c.estado,
    c.zona,
    COALESCE(c.telefono_movil, c.telefono) AS telefono,
    r.id           AS retiro_id,
    r.estado       AS retiro_estado,
    r.categoria_cierre,
    cat.nombre     AS categoria,
    r.cerrado_en,
    r.serie,
    r.valor,
    -- Si el equipo volvió de verdad o se dio por perdido. Cambia la
    -- conversación: uno es un cierre limpio, el otro deja deuda de equipo.
    (r.estado = 'recuperado') AS equipo_recuperado
FROM retiros_equipo r
JOIN clientes c ON c.id = r.cliente_id
LEFT JOIN retiro_categorias cat ON cat.clave = r.categoria_cierre
WHERE r.estado IN ('recuperado', 'no_recuperado')
  AND c.estado <> 'baja'
  AND puede_gestionar_retiros()
ORDER BY c.id, r.cerrado_en DESC;

GRANT SELECT ON v_fichas_por_cerrar TO authenticated;

COMMENT ON VIEW v_fichas_por_cerrar IS
    'Abonados que se quedaron sin equipo y siguen figurando como activos. Es el pendiente que queda después de cerrar un retiro.';


/**
 * Marca al abonado como retirado.
 *
 * Envuelve a `dar_de_baja_cliente` en vez de reemplazarla: aquella ya sabe
 * escribir el motivo, la fecha y la nota, y ya decide si la pérdida le cuenta
 * al vendedor en la calidad de su cohorte. Lo que agrega esto es el rastro de
 * que la baja salió de un retiro de equipo, que es distinto de una baja pedida
 * por el abonado.
 */
CREATE OR REPLACE FUNCTION cerrar_ficha_por_retiro(
    p_cliente UUID,
    p_motivo  UUID DEFAULT NULL,
    p_nota    TEXT DEFAULT NULL
)
RETURNS clientes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_retiro retiros_equipo%ROWTYPE;
    v_nota   TEXT;
BEGIN
    IF NOT puede_gestionar_retiros() THEN
        RAISE EXCEPTION 'No tenés permiso para cerrar fichas';
    END IF;

    SELECT * INTO v_retiro FROM retiros_equipo
     WHERE cliente_id = p_cliente AND estado IN ('recuperado', 'no_recuperado')
     ORDER BY cerrado_en DESC LIMIT 1;

    v_nota := COALESCE(NULLIF(BTRIM(p_nota), ''), '') ||
        CASE
            WHEN v_retiro.id IS NULL THEN ''
            WHEN v_retiro.estado = 'recuperado'
                THEN CASE WHEN p_nota IS NULL THEN '' ELSE ' · ' END ||
                     'Equipo recuperado el ' || TO_CHAR(v_retiro.cerrado_en AT TIME ZONE zona_horaria(), 'DD/MM/YYYY') ||
                     COALESCE(' (' || v_retiro.serie || ')', '')
            ELSE CASE WHEN p_nota IS NULL THEN '' ELSE ' · ' END ||
                 'Equipo NO recuperado: ' || COALESCE(v_retiro.categoria_cierre, 'sin categoría') ||
                 COALESCE(' (' || v_retiro.serie || ')', '')
        END;

    RETURN dar_de_baja_cliente(p_cliente, p_motivo, NULLIF(v_nota, ''));
END $$;


/**
 * El recordatorio semanal.
 *
 * Lo llama la tarea de cartera. `notificar` no repite el mismo aviso sobre la
 * misma entidad dentro del día, así que correrlo a diario no molesta: el
 * pendiente vuelve a aparecer una vez por día hasta que alguien lo resuelva.
 */
CREATE OR REPLACE FUNCTION avisar_fichas_por_cerrar()
RETURNS TABLE (avisadas INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r RECORD;
    v_n INT := 0;
BEGIN
    FOR r IN
        SELECT DISTINCT c.id
          FROM retiros_equipo re
          JOIN clientes c ON c.id = re.cliente_id
         WHERE re.estado IN ('recuperado', 'no_recuperado')
           AND c.estado <> 'baja'
           -- Solo lo cerrado en los últimos 90 días: más viejo que eso ya es
           -- una decisión tomada de no darlo de baja, y seguir avisando sería
           -- ruido que tapa los pendientes nuevos.
           AND re.cerrado_en > NOW() - INTERVAL '90 days'
    LOOP
        PERFORM avisar_ficha_por_cerrar(r.id);
        v_n := v_n + 1;
    END LOOP;

    RETURN QUERY SELECT v_n;
END $$;


-- =============================================================================
-- 5. Que el acta también lo dispare
-- =============================================================================
-- Cuando el equipo se recuperó, el pendiente nace al firmarse el acta: es ahí
-- cuando el aparato termina de volver a la empresa.
CREATE OR REPLACE FUNCTION recibir_entrega_inventario(
    p_entrega  UUID,
    p_firma    TEXT,
    p_almacen  UUID DEFAULT NULL,
    p_notas    TEXT DEFAULT NULL
)
RETURNS entregas_inventario
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_acta    entregas_inventario%ROWTYPE;
    v_legajo  UUID := mi_legajo_id();
    v_destino UUID;
    v_item    RECORD;
BEGIN
    SELECT * INTO v_acta FROM entregas_inventario WHERE id = p_entrega;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa acta';
    END IF;

    IF v_acta.estado <> 'pendiente' THEN
        RAISE EXCEPTION 'Esa acta ya está %', v_acta.estado;
    END IF;

    IF NOT puede_gestionar_retiros() THEN
        RAISE EXCEPTION 'No tenés permiso para recibir material';
    END IF;

    IF v_legajo IS NOT NULL AND v_legajo = v_acta.entrega_id THEN
        RAISE EXCEPTION 'No podés recibir tu propia entrega: la firma tiene que ser de quien recibe';
    END IF;

    IF COALESCE(BTRIM(p_firma), '') = '' THEN
        RAISE EXCEPTION 'Falta la firma de quien recibe';
    END IF;

    v_destino := COALESCE(
        p_almacen,
        (SELECT a.id FROM almacenes a WHERE a.tipo = 'bodega' ORDER BY a.creado_en LIMIT 1)
    );

    IF v_destino IS NULL THEN
        RAISE EXCEPTION 'No hay un almacén general a dónde recibir';
    END IF;

    FOR v_item IN
        SELECT i.equipo_id, i.retiro_id, e.articulo_id
          FROM entrega_items i
          JOIN equipos e ON e.id = i.equipo_id
         WHERE i.entrega_id = p_entrega
    LOOP
        UPDATE equipos SET almacen_id = v_destino WHERE id = v_item.equipo_id;

        INSERT INTO movimientos_inventario (
            tipo, articulo_id, equipo_id, cantidad,
            almacen_origen_id, almacen_destino_id, motivo, usuario_id, usuario_nombre
        )
        SELECT 'transferencia', v_item.articulo_id, v_item.equipo_id, 1,
               v_acta.almacen_origen, v_destino,
               FORMAT('Entrega de equipos recuperados (acta %s)', v_acta.numero),
               v_legajo,
               (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                  FROM usuarios_sistema u WHERE u.id = v_legajo);

        -- El equipo terminó de volver: si su dueño sigue figurando como
        -- abonado, ahí nace el pendiente de cerrar la ficha.
        IF v_item.retiro_id IS NOT NULL THEN
            PERFORM avisar_ficha_por_cerrar(
                (SELECT cliente_id FROM retiros_equipo WHERE id = v_item.retiro_id)
            );
        END IF;
    END LOOP;

    UPDATE entregas_inventario
       SET estado = 'recibida',
           recibe_id = v_legajo,
           almacen_destino = v_destino,
           firma_b64 = p_firma,
           firmado_en = NOW(),
           notas = COALESCE(NULLIF(BTRIM(p_notas), ''), notas)
     WHERE id = p_entrega
    RETURNING * INTO v_acta;

    RETURN v_acta;
END $$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, nombre, es_perdida, reclamable FROM retiro_categorias ORDER BY orden;
--
--   -- Cerrar sin firma tiene que fallar:
--   SELECT cerrar_retiro_equipo('<orden>', true);
--
--   -- Y sin categoría, también:
--   SELECT cerrar_retiro_equipo('<orden>', false, 'porque sí');
--
--   SELECT nombre, estado, equipo_recuperado, categoria FROM v_fichas_por_cerrar;
--   SELECT titulo, detalle FROM notificaciones WHERE tipo = 'ficha_por_cerrar';
