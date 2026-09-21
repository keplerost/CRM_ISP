-- =============================================================================
-- Migración 101 — Cartera: retiro de equipos y reactivaciones (Fase 5)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere la 100: lee `meses_sin_pago()`, `comision_reglas` y el veredicto de
-- calidad de cada venta.
--
-- ── Qué trae ──
--
--   1. La CARTERA EN RIESGO del vendedor: quién de sus clientes dejó de
--      renovar, cuánto le falta para perderse y qué se hizo al respecto.
--   2. La ORDEN DE RETIRO del equipo, que se genera sola cuando un abonado
--      llega a la condición configurada, con sus intentos y su evidencia.
--   3. Las REACTIVACIONES: quién volvió, después de cuánto y de quién era.
--
-- ── Qué NO trae, a propósito ──
--
-- Ningún descuento. El punto 13 es explícito —no descontar automáticamente el
-- valor de una ONT perdida al vendedor— y el 11 también: una comisión pagada no
-- se reduce sola. Acá se mide y se muestra; cobrarle algo a alguien es una
-- decisión administrativa que no toma una tarea programada.
--
-- Tampoco trae un incentivo de reactivación. El punto 14 pide preparar el
-- modelo sin mezclarlo con la comisión de venta nueva: la tabla queda y el
-- incentivo, cuando exista, la va a leer. Mezclarlo hoy sería pagar dos veces
-- por el mismo cliente.
--
-- ── Lo que se reutiliza en vez de duplicar ──
--
-- La GESTIÓN de un cliente en riesgo —llamarlo, anotar el resultado, registrar
-- una promesa— ya existe entera desde la migración 70/73: `cobranza_asignaciones`
-- y `cobranza_gestiones`, con su pantalla y su función. Acá no se crea otra
-- bandeja: se abre una asignación en esas mismas tablas con un motivo distinto.
--
-- Dos historiales de contacto con el mismo abonado es la forma de que ninguno
-- de los dos esté completo.
--
-- El EQUIPO tampoco se reinventa: sale de `equipos` —el inventario de la 69— y
-- al recuperarse vuelve al almacén del técnico con su movimiento, como
-- cualquier otro ingreso. Un retiro que no toca el stock es un equipo que el
-- sistema sigue creyendo instalado en la casa de alguien que ya no es cliente.
-- =============================================================================


-- =============================================================================
-- 1. Quién puede qué
-- =============================================================================
/**
 * Manejar retiros es mandar a alguien a la casa de un ex abonado a buscar un
 * aparato. No es una operación de red ni una decisión comercial: es logística
 * de recupero, y tiene su propio permiso.
 *
 * Sin legajo no se bloquea, igual que el resto del sistema.
 */
CREATE OR REPLACE FUNCTION puede_gestionar_retiros()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        -- `inventario.transferir` también sirve: es el permiso de quien despacha
        -- material a los técnicos, y un equipo que vuelve es material que
        -- entra. Sin esto, toda instalación que ya funciona tendría que editar
        -- sus roles antes de poder cerrar la primera orden.
        (SELECT permisos ? '*' OR permisos ? 'retiros.gestionar' OR permisos ? 'inventario.transferir'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        TRUE
    )
$$;

COMMENT ON FUNCTION puede_gestionar_retiros IS
    'TRUE si quien pregunta puede crear, asignar y cerrar órdenes de retiro de equipo.';


-- =============================================================================
-- 2. La orden de retiro
-- =============================================================================
/**
 * Un equipo a recuperar, con toda la historia que hizo falta para llegar ahí.
 *
 * ── Por qué copia las fechas en vez de calcularlas ──
 *
 * Porque son la explicación de por qué se mandó a alguien a golpear una puerta.
 * `ultimo_pago` sale de `pagos` y ahí sigue, pero el día que ese abonado
 * reactive y pague, la consulta devolvería la fecha nueva y la orden pasaría a
 * decir que se generó contra un cliente al día. Congeladas, la orden se sigue
 * entendiendo dentro de dos años.
 *
 * ── Por qué el valor también se congela ──
 *
 * Punto 13: "8 ONT pendientes × $50 = $400 en activos pendientes de
 * recuperación". Ese número tiene que ser estable. Si saliera de
 * `articulos.costo_ultimo`, una compra más cara en marzo cambiaría el valor de
 * lo que se perdió en enero.
 */
CREATE TABLE IF NOT EXISTS retiros_equipo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    -- Informativo: quién vendió. NO se usa para descontarle nada — el punto 13
    -- lo prohíbe— sino para medir la tasa de recuperación por vendedor.
    vendedor_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    -- ── El equipo ──
    -- Los tres pueden faltar: hay abonados viejos cuyo aparato nunca entró al
    -- inventario. La orden se genera igual —el equipo está en la casa aunque el
    -- sistema no lo tenga fichado— y el técnico anota la serie al retirarlo.
    equipo_id UUID REFERENCES equipos(id) ON DELETE SET NULL,
    onu_id    UUID REFERENCES onus(id)    ON DELETE SET NULL,
    serie     VARCHAR(60),
    modelo    VARCHAR(140),
    valor     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),

    -- ── Por qué se llegó acá ──
    fecha_instalacion DATE,
    ultimo_pago       DATE,
    suspendido_en     DATE,
    meses_sin_pago    SMALLINT,

    -- ── El trabajo ──
    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    intentos   SMALLINT NOT NULL DEFAULT 0 CHECK (intentos >= 0),

    estado VARCHAR(14) NOT NULL DEFAULT 'pendiente',

    -- ── El cierre ──
    -- Por qué no se pudo recuperar. Obligatorio al cerrar en 'no_recuperado':
    -- un equipo que se da por perdido sin explicación es una pérdida que nadie
    -- va a poder analizar después.
    motivo        VARCHAR(24),
    observaciones TEXT,
    evidencia_url TEXT,

    creado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    asignado_en TIMESTAMPTZ,
    cerrado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    cerrado_en  TIMESTAMPTZ,

    CONSTRAINT retiros_estado_check CHECK (estado IN (
        'pendiente',       -- generada, sin técnico
        'asignado',        -- alguien la tiene
        'recuperado',
        'no_recuperado',
        'cancelado'        -- el abonado volvió, o se decidió no ir
    )),
    CONSTRAINT retiros_motivo_check CHECK (motivo IS NULL OR motivo IN (
        'no_ubicado',      -- no vive más ahí
        'se_niega',        -- se niega a entregarlo
        'equipo_roto',
        'equipo_robado',
        'no_estaba',       -- nunca se lo encontró en la casa
        'zona_insegura',
        'cliente_volvio',
        'otro'
    )),
    -- Dar por perdido un activo sin decir por qué es exactamente lo que impide
    -- después saber si el problema es el barrio, el técnico o el proceso.
    CONSTRAINT retiros_cierre_con_motivo
        CHECK (estado <> 'no_recuperado' OR motivo IS NOT NULL)
);

ALTER TABLE retiros_equipo ENABLE ROW LEVEL SECURITY;

-- Una orden abierta por abonado. Dos técnicos yendo a la misma casa el mismo
-- día es peor que no ir: el segundo se entera de que el primero ya lo retiró
-- cuando ya golpeó la puerta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_retiros_una_abierta
    ON retiros_equipo (cliente_id) WHERE estado IN ('pendiente', 'asignado');

CREATE INDEX IF NOT EXISTS idx_retiros_estado  ON retiros_equipo (estado, creado_en);
CREATE INDEX IF NOT EXISTS idx_retiros_tecnico ON retiros_equipo (tecnico_id, estado);


/**
 * Cada vez que alguien fue.
 *
 * ── Por qué no alcanza con el contador ──
 *
 * `intentos = 3` no dice nada. Tres visitas en las que no había nadie a las 10
 * de la mañana son un problema de horario, no de un abonado que se esconde; la
 * diferencia se ve leyendo los tres renglones y no el número.
 */
CREATE TABLE IF NOT EXISTS retiro_intentos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retiro_id UUID NOT NULL REFERENCES retiros_equipo(id) ON DELETE CASCADE,

    tecnico_id UUID REFERENCES tecnicos(id) ON DELETE SET NULL,
    resultado  VARCHAR(16) NOT NULL,
    observacion TEXT,
    foto_url   TEXT,

    usuario_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT retiro_intentos_resultado_check CHECK (resultado IN (
        'no_estaba', 'se_niega', 'no_ubicado', 'reprogramado', 'recuperado', 'otro'
    ))
);

ALTER TABLE retiro_intentos ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_retiro_intentos ON retiro_intentos (retiro_id, creado_en DESC);


-- ── Seguridad ──
--
-- Leer: quien gestiona retiros, el técnico asignado, y el vendedor que vendió a
-- ese abonado. El último importa: el punto 13 le pide medir la recuperación de
-- sus equipos, y sin ver sus propias órdenes no puede.
DROP POLICY IF EXISTS retiros_equipo_lectura ON retiros_equipo;
CREATE POLICY retiros_equipo_lectura ON retiros_equipo
    FOR SELECT TO authenticated
    USING (
        puede_gestionar_retiros()
        OR tecnico_id = mi_tecnico_id()
        OR vendedor_id = mi_legajo_id()
    );

-- Escribir directo: nadie. Una orden cerrada a mano no mueve el inventario, y
-- el equipo queda figurando instalado en la casa de alguien que ya no existe.
DROP POLICY IF EXISTS retiros_equipo_escritura ON retiros_equipo;
CREATE POLICY retiros_equipo_escritura ON retiros_equipo
    FOR ALL TO authenticated
    USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS retiro_intentos_lectura ON retiro_intentos;
CREATE POLICY retiro_intentos_lectura ON retiro_intentos
    FOR SELECT TO authenticated
    USING (
        puede_gestionar_retiros()
        OR EXISTS (
            SELECT 1 FROM retiros_equipo r
             WHERE r.id = retiro_intentos.retiro_id
               AND (r.tecnico_id = mi_tecnico_id() OR r.vendedor_id = mi_legajo_id())
        )
    );

DROP POLICY IF EXISTS retiro_intentos_escritura ON retiro_intentos;
CREATE POLICY retiro_intentos_escritura ON retiro_intentos
    FOR ALL TO authenticated
    USING (false) WITH CHECK (false);


-- =============================================================================
-- 3. El generador de órdenes
-- =============================================================================
/**
 * Abre la orden de retiro de quien llegó a la condición configurada.
 *
 * ── Cuándo se abre ──
 *
 * Cuando el abonado lleva `meses_sin_pago_retiro` meses sin pagar —2 por
 * defecto, configurable desde Comisiones e Incentivos— o cuando se lo dio de
 * baja. Las dos cosas significan lo mismo para el equipo: está en una casa que
 * ya no paga.
 *
 * ── Por qué NO se abre por estar cortado ──
 *
 * Porque el corte es la herramienta de cobro, no el final. Un abonado cortado
 * el día 6 que paga el 12 es el caso normal del prepago, y mandarle un técnico
 * a retirarle el equipo por eso sería perder un cliente que no se había ido.
 *
 * ── Qué pasa si no tiene equipo fichado ──
 *
 * Se abre igual, sin `equipo_id`. El aparato está en la casa aunque el
 * inventario no lo sepa, y no abrir la orden sería decidir que lo que no está
 * cargado no existe. El técnico anota la serie cuando lo retira.
 */
CREATE OR REPLACE FUNCTION generar_retiros_equipo()
RETURNS TABLE (creadas INT, canceladas INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reglas comision_reglas%ROWTYPE;
    v_creadas INT := 0;
    v_canceladas INT := 0;
    r RECORD;
BEGIN
    SELECT * INTO v_reglas
      FROM comision_reglas
     WHERE esquema_id = esquema_comisiones_vigente(CURRENT_DATE);

    IF NOT FOUND THEN
        -- Sin esquema no hay umbral configurado, y no se inventa uno acá: el
        -- punto 2 pide que estos números no estén quemados en código.
        RETURN QUERY SELECT 0, 0;
        RETURN;
    END IF;

    -- ── Cancelar las que dejaron de tener sentido ──
    -- El abonado volvió a pagar y está activo: el equipo se queda donde está.
    -- Va primero, para no mandar a nadie a buscar algo que ya no hay que
    -- buscar.
    WITH cancelar AS (
        UPDATE retiros_equipo re
           SET estado = 'cancelado',
               motivo = 'cliente_volvio',
               observaciones = COALESCE(re.observaciones, '') ||
                   CASE WHEN re.observaciones IS NULL THEN '' ELSE E'\n' END ||
                   'Cancelada automáticamente: el abonado volvió a pagar.',
               cerrado_en = NOW()
          FROM clientes c
         WHERE c.id = re.cliente_id
           AND re.estado IN ('pendiente', 'asignado')
           AND c.estado <> 'baja'
           AND meses_sin_pago(c.id) < v_reglas.meses_sin_pago_retiro
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_canceladas FROM cancelar;

    -- ── Abrir las nuevas ──
    FOR r IN
        SELECT
            c.id AS cliente_id,
            c.fecha_instalacion,
            c.onu_id,
            m.meses,
            p.ultimo_pago,
            cv.vendedor_id,
            e.equipo_id,
            e.serie,
            e.modelo,
            e.valor
        FROM clientes c
        -- Una sola llamada por abonado. Repetirla en el WHERE y en el SELECT la
        -- ejecutaría dos veces por cada cliente de la base.
        CROSS JOIN LATERAL (SELECT meses_sin_pago(c.id) AS meses) m
        -- El último pago se usa tres veces: para la orden, para la fecha de
        -- suspensión y para decidir si una orden vieja todavía bloquea.
        CROSS JOIN LATERAL (
            SELECT MAX(pg.fecha_pago)::DATE AS ultimo_pago
              FROM pagos pg
             WHERE pg.client_id = c.id AND NOT pg.anulado
        ) p
        LEFT JOIN v_cliente_vendedor cv ON cv.cliente_id = c.id
        -- El equipo instalado, si el inventario lo tiene. Con LIMIT porque un
        -- abonado puede tener dos aparatos fichados —una ONT y un router— y sin
        -- esto se abrirían dos órdenes para la misma casa.
        LEFT JOIN LATERAL (
            SELECT eq.id AS equipo_id, eq.serie, ar.nombre AS modelo,
                   COALESCE(ar.costo_ultimo, 0) AS valor
              FROM equipos eq
              LEFT JOIN articulos ar ON ar.id = eq.articulo_id
             WHERE eq.cliente_id = c.id AND eq.estado = 'instalado'
             ORDER BY (ar.categoria = 'ont') DESC NULLS LAST, eq.creado_en
             LIMIT 1
        ) e ON TRUE
        WHERE (c.estado = 'baja' OR m.meses >= v_reglas.meses_sin_pago_retiro)
          -- Que haya algo que buscar: o un equipo fichado, o una ONU asociada.
          AND (e.equipo_id IS NOT NULL OR c.onu_id IS NOT NULL)
          AND NOT EXISTS (
              SELECT 1 FROM retiros_equipo x
               WHERE x.cliente_id = c.id
                 AND x.estado IN ('pendiente', 'asignado')
          )
          /**
           * Y que no haya una cerrada que todavía valga.
           *
           * Sin esta condición la tarea abriría una orden nueva cada noche: el
           * abonado sigue en baja, los meses sin pagar siguen creciendo y el
           * índice único solo impide dos ABIERTAS a la vez.
           *
           * Pero "cerrada" no puede bloquear para siempre. Un abonado al que se
           * le retiró el equipo, que reactivó meses después con una instalación
           * nueva y que volvió a caer, es otra caída y merece su propia orden —
           * si no, el segundo equipo se queda en esa casa sin que nadie lo
           * anote.
           *
           * El corte es el pago: una orden cerrada bloquea mientras el abonado
           * no haya pagado nada después de cerrarse. Las canceladas no bloquean,
           * porque cancelar significa justamente que volvió.
           */
          AND NOT EXISTS (
              SELECT 1 FROM retiros_equipo x
               WHERE x.cliente_id = c.id
                 AND x.estado IN ('recuperado', 'no_recuperado')
                 AND (p.ultimo_pago IS NULL OR p.ultimo_pago <= x.cerrado_en::DATE)
          )
    LOOP
        INSERT INTO retiros_equipo (
            cliente_id, vendedor_id, equipo_id, onu_id, serie, modelo, valor,
            fecha_instalacion, ultimo_pago, suspendido_en, meses_sin_pago, estado
        ) VALUES (
            r.cliente_id, r.vendedor_id, r.equipo_id, r.onu_id,
            COALESCE(r.serie, (SELECT o.sn FROM onus o WHERE o.id = r.onu_id)),
            r.modelo, r.valor,
            r.fecha_instalacion, r.ultimo_pago,
            -- Cuándo quedó suspendido: el último pago más los meses que aguanta
            -- la configuración antes de considerarlo caído.
            CASE WHEN r.ultimo_pago IS NOT NULL
                 THEN (r.ultimo_pago + (v_reglas.meses_sin_pago_suspension || ' months')::INTERVAL)::DATE
            END,
            r.meses, 'pendiente'
        );

        v_creadas := v_creadas + 1;
    END LOOP;

    RETURN QUERY SELECT v_creadas, v_canceladas;
END $$;

COMMENT ON FUNCTION generar_retiros_equipo IS
    'Abre la orden de retiro de quien llegó a la condición de retiro y cancela las de quienes volvieron a pagar. Idempotente.';


-- =============================================================================
-- 4. Trabajar la orden
-- =============================================================================
/**
 * Asigna la orden a un técnico.
 */
CREATE OR REPLACE FUNCTION asignar_retiro_equipo(p_retiro UUID, p_tecnico UUID)
RETURNS retiros_equipo
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_fila retiros_equipo%ROWTYPE;
BEGIN
    IF NOT puede_gestionar_retiros() THEN
        RAISE EXCEPTION 'No tenés permiso para asignar retiros de equipo';
    END IF;

    UPDATE retiros_equipo
       SET tecnico_id = p_tecnico,
           estado = CASE WHEN estado = 'pendiente' THEN 'asignado' ELSE estado END,
           asignado_en = NOW()
     WHERE id = p_retiro
       AND estado IN ('pendiente', 'asignado')
    RETURNING * INTO v_fila;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Esa orden de retiro no existe o ya está cerrada';
    END IF;

    RETURN v_fila;
END $$;


/**
 * Anota que alguien fue.
 *
 * El intento con resultado `recuperado` NO cierra la orden: cerrar mueve el
 * inventario y necesita saber a qué almacén entra el equipo. Se hacen las dos
 * cosas desde la pantalla del técnico, en ese orden, y si la segunda falla la
 * primera igual quedó registrada — que es lo correcto: el técnico fue.
 */
CREATE OR REPLACE FUNCTION registrar_intento_retiro(
    p_retiro     UUID,
    p_resultado  TEXT,
    p_observacion TEXT DEFAULT NULL,
    p_foto       TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
    v_fila retiros_equipo%ROWTYPE;
BEGIN
    SELECT * INTO v_fila FROM retiros_equipo WHERE id = p_retiro;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa orden de retiro';
    END IF;

    IF NOT puede_gestionar_retiros()
       AND v_fila.tecnico_id IS DISTINCT FROM mi_tecnico_id() THEN
        RAISE EXCEPTION 'Esa orden de retiro no es tuya';
    END IF;

    INSERT INTO retiro_intentos (retiro_id, tecnico_id, resultado, observacion, foto_url, usuario_id)
    VALUES (p_retiro, COALESCE(v_fila.tecnico_id, mi_tecnico_id()), p_resultado,
            p_observacion, p_foto, mi_legajo_id())
    RETURNING id INTO v_id;

    UPDATE retiros_equipo
       SET intentos = intentos + 1,
           -- La última evidencia queda a mano en la orden; el historial completo
           -- vive en los intentos.
           evidencia_url = COALESCE(p_foto, evidencia_url)
     WHERE id = p_retiro;

    RETURN v_id;
END $$;


/**
 * Cierra la orden: recuperado o no.
 *
 * ── Qué pasa con el equipo cuando se recupera ──
 *
 * Vuelve al almacén del técnico como una devolución, con su movimiento de
 * inventario. Sin eso el stock nunca se entera de que el aparato volvió, y la
 * próxima instalación compra uno nuevo teniendo ese en la camioneta.
 *
 * ── Y cuando no ──
 *
 * El equipo queda en `baja`: no está en ningún almacén ni instalado en nadie.
 * Es la única forma honesta de decir "sabemos dónde está y no lo tenemos". El
 * valor queda registrado en la orden y suma al indicador de pérdida — que es
 * información para administración, NO un descuento a nadie.
 */
/**
 * ── Este bloque se saltea si ya corrió la 115 ──
 *
 * La 115 le agregó dos parámetros a esta función —la firma de quien entrega y
 * el nombre del firmante— y borró esta versión de seis. Volver a crearla acá
 * NO la reemplaza: Postgres las trata como dos funciones distintas, y desde ese
 * momento cualquier llamada falla con «function cerrar_retiro_equipo(...) is
 * not unique». La pantalla del técnico deja de poder cerrar una orden.
 *
 * La pregunta es por el CONTENIDO, no por un número de migración: si existe la
 * tabla de categorías de cierre, la versión nueva ya está en la base.
 */
DO $guarda_cierre$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'retiro_categorias'
    ) THEN
        RAISE NOTICE 'cerrar_retiro_equipo ya está en su versión de la 115: no se toca.';
        RETURN;
    END IF;

    EXECUTE $cuerpo$
CREATE OR REPLACE FUNCTION cerrar_retiro_equipo(
    p_retiro      UUID,
    p_recuperado  BOOLEAN,
    p_motivo      TEXT DEFAULT NULL,
    p_observacion TEXT DEFAULT NULL,
    p_serie       TEXT DEFAULT NULL,
    p_almacen     UUID DEFAULT NULL
)
RETURNS retiros_equipo
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
DECLARE
    v_fila    retiros_equipo%ROWTYPE;
    v_equipo  equipos%ROWTYPE;
    v_almacen UUID;
    v_legajo  UUID := mi_legajo_id();
BEGIN
    SELECT * INTO v_fila FROM retiros_equipo WHERE id = p_retiro;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa orden de retiro';
    END IF;

    IF NOT puede_gestionar_retiros()
       AND v_fila.tecnico_id IS DISTINCT FROM mi_tecnico_id() THEN
        RAISE EXCEPTION 'Esa orden de retiro no es tuya';
    END IF;

    IF v_fila.estado NOT IN ('pendiente', 'asignado') THEN
        RAISE EXCEPTION 'Esa orden ya está cerrada (%)', v_fila.estado;
    END IF;

    IF NOT p_recuperado AND COALESCE(BTRIM(p_motivo), '') = '' THEN
        RAISE EXCEPTION 'Hace falta el motivo: un equipo dado por perdido sin explicación no se puede analizar después';
    END IF;

    -- ── El equipo ──
    -- Por serie si la escribieron, si no por el que traía la orden. La serie a
    -- mano importa: es el caso del abonado viejo cuyo aparato nunca entró al
    -- inventario, y también el del equipo que resultó ser otro.
    IF COALESCE(BTRIM(p_serie), '') <> '' THEN
        SELECT * INTO v_equipo FROM equipos
         WHERE UPPER(BTRIM(serie)) = UPPER(BTRIM(p_serie)) LIMIT 1;
    ELSIF v_fila.equipo_id IS NOT NULL THEN
        SELECT * INTO v_equipo FROM equipos WHERE id = v_fila.equipo_id;
    END IF;

    IF p_recuperado AND v_equipo.id IS NOT NULL THEN
        -- A dónde entra: el almacén que digan, el del técnico, o la bodega.
        v_almacen := COALESCE(
            p_almacen,
            (SELECT a.id FROM almacenes a
              WHERE a.tecnico_id = COALESCE(v_fila.tecnico_id, mi_tecnico_id()) AND a.activo
              LIMIT 1),
            (SELECT a.id FROM almacenes a WHERE a.tipo = 'bodega' AND a.activo
              ORDER BY a.creado_en LIMIT 1)
        );

        IF v_almacen IS NULL THEN
            RAISE EXCEPTION 'No hay ningún almacén donde ingresar el equipo recuperado';
        END IF;

        UPDATE equipos
           SET estado = 'en_stock',
               almacen_id = v_almacen,
               cliente_id = NULL,
               instalacion_id = NULL,
               onu_id = NULL,
               actualizado_en = NOW()
         WHERE id = v_equipo.id;

        -- La ficha no puede seguir apuntando a una ONU que ya no está en esa
        -- casa: es el mismo cuidado que toma el reemplazo de equipo de la 93.
        -- Borrarla de la OLT es otra cosa y la hace el middleware.
        UPDATE clientes SET onu_id = NULL, updated_at = NOW()
         WHERE id = v_fila.cliente_id;

        -- El movimiento es lo que hace que el stock lo refleje: el trigger de la
        -- 69 se encarga de las existencias.
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
        -- Ni en un almacén ni instalado: se sabe dónde está y no lo tenemos.
        UPDATE equipos
           SET estado = 'baja',
               almacen_id = NULL,
               notas = CONCAT_WS(E'\n', notas,
                   FORMAT('No recuperado el %s: %s', CURRENT_DATE, p_motivo)),
               actualizado_en = NOW()
         WHERE id = v_equipo.id;
    END IF;

    UPDATE retiros_equipo
       SET estado = CASE WHEN p_recuperado THEN 'recuperado' ELSE 'no_recuperado' END,
           motivo = COALESCE(NULLIF(BTRIM(p_motivo), ''), motivo),
           observaciones = CONCAT_WS(E'\n', observaciones, NULLIF(BTRIM(p_observacion), '')),
           equipo_id = COALESCE(v_equipo.id, equipo_id),
           serie = COALESCE(NULLIF(BTRIM(p_serie), ''), v_equipo.serie, serie),
           cerrado_por = v_legajo,
           cerrado_en = NOW()
     WHERE id = p_retiro
    RETURNING * INTO v_fila;

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion,
        entidad, entidad_id, datos
    ) VALUES (
        v_legajo,
        COALESCE((SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                    FROM usuarios_sistema u WHERE u.id = v_legajo), 'Sistema'),
        (SELECT u.rol FROM usuarios_sistema u WHERE u.id = v_legajo),
        CASE WHEN p_recuperado THEN 'retiro.recuperado' ELSE 'retiro.no_recuperado' END,
        FORMAT('Cerró el retiro del equipo %s como %s',
               COALESCE(v_fila.serie, 'sin serie'),
               CASE WHEN p_recuperado THEN 'recuperado' ELSE 'NO recuperado' END),
        'retiro_equipo', p_retiro::TEXT,
        jsonb_build_object('cliente', v_fila.cliente_id, 'valor', v_fila.valor,
                           'motivo', p_motivo, 'intentos', v_fila.intentos)
    );

    RETURN v_fila;
END $f$;
$cuerpo$;

    EXECUTE $comentario$
COMMENT ON FUNCTION cerrar_retiro_equipo(UUID, BOOLEAN, TEXT, TEXT, TEXT, UUID) IS
'Cierra la orden y mueve el inventario: recuperado vuelve al almacén, no recuperado queda en baja. Nunca descuenta a nadie.'
$comentario$;
END $guarda_cierre$;


-- =============================================================================
-- 5. Las reactivaciones
-- =============================================================================
/**
 * Quién volvió, cuándo y después de cuánto tiempo.
 *
 * ── Por qué una tabla y no una columna en `clientes` ──
 *
 * Porque un abonado puede irse y volver más de una vez, y cada vuelta es un
 * hecho con su fecha. Una columna `reactivado_en` guardaría solo la última y
 * borraría la historia justo cuando empieza a ser interesante.
 *
 * ── Por qué NO genera comisión ──
 *
 * Punto 14, textual: una reactivación no se contabiliza como venta nueva. El
 * motor ya lo garantiza por dos lados —solo mira prospectos con
 * `tipo_operacion = 'nueva'`, y el índice único impide una segunda comisión por
 * el mismo abonado— así que acá no hay nada que impedir: hay algo que
 * REGISTRAR, para que el día que exista el incentivo de recuperación tenga de
 * dónde leer.
 */
CREATE TABLE IF NOT EXISTS reactivaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    -- El vendedor ORIGINAL, el que lo trajo. El punto 14 pide conservarlo.
    vendedor_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    -- El pago que la disparó y el anterior: entre los dos está el hueco.
    pago_id     UUID REFERENCES pagos(id) ON DELETE SET NULL,
    pago_anterior DATE,
    reactivado_el DATE NOT NULL,
    meses_inactivo SMALLINT NOT NULL DEFAULT 0,

    -- Si el equipo había llegado a orden de retiro. Una reactivación con orden
    -- abierta es la que hay que mirar: alguien está por ir a buscar un aparato
    -- a la casa de un cliente que volvió.
    retiro_id UUID REFERENCES retiros_equipo(id) ON DELETE SET NULL,

    origen VARCHAR(10) NOT NULL DEFAULT 'automatica',
    notas  TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reactivaciones_origen_check CHECK (origen IN ('automatica', 'manual')),
    -- Una sola por cliente y fecha: la detección corre todos los días y sin esto
    -- el mismo regreso se anotaría una vez por corrida.
    UNIQUE (cliente_id, reactivado_el)
);

ALTER TABLE reactivaciones ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_reactivaciones_vendedor
    ON reactivaciones (vendedor_id, reactivado_el DESC);

DROP POLICY IF EXISTS reactivaciones_lectura ON reactivaciones;
CREATE POLICY reactivaciones_lectura ON reactivaciones
    FOR SELECT TO authenticated
    USING (ve_comisiones_de_todos() OR vendedor_id = mi_legajo_id());

DROP POLICY IF EXISTS reactivaciones_escritura ON reactivaciones;
CREATE POLICY reactivaciones_escritura ON reactivaciones
    FOR ALL TO authenticated
    USING (false) WITH CHECK (false);


/**
 * Encuentra a los que volvieron.
 *
 * ── Cómo se detecta ──
 *
 * Por el hueco entre dos pagos. Si entre uno y el siguiente pasaron más meses
 * que el umbral de suspensión configurado, ese segundo pago es un regreso.
 *
 * Se mira `pagos` y no el estado del abonado a propósito: el estado es de HOY y
 * se pisa a sí mismo. Los pagos son un hecho fechado, así que la detección
 * funciona igual corriendo hoy que corriendo dentro de un año, y da lo mismo.
 *
 * ── Por qué no cuenta como venta ──
 *
 * Porque no lo es. Acá solo se anota; ninguna función de comisiones lee esta
 * tabla, y ese es justamente el punto 14.
 */
CREATE OR REPLACE FUNCTION detectar_reactivaciones(p_desde DATE DEFAULT NULL)
RETURNS TABLE (detectadas INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reglas comision_reglas%ROWTYPE;
    v_desde  DATE;
    v_n      INT := 0;
BEGIN
    SELECT * INTO v_reglas
      FROM comision_reglas
     WHERE esquema_id = esquema_comisiones_vigente(CURRENT_DATE);

    IF NOT FOUND THEN
        RETURN QUERY SELECT 0;
        RETURN;
    END IF;

    -- Por defecto se miran los últimos 45 días. Recorrer el historial completo
    -- todas las noches es trabajo inútil: lo viejo ya se detectó. Con una fecha
    -- explícita se puede reconstruir hacia atrás.
    v_desde := COALESCE(p_desde, CURRENT_DATE - 45);

    WITH pagos_ordenados AS (
        SELECT
            pg.id,
            pg.client_id,
            pg.fecha_pago::DATE AS fecha,
            LAG(pg.fecha_pago::DATE) OVER (PARTITION BY pg.client_id ORDER BY pg.fecha_pago) AS anterior
        FROM pagos pg
        WHERE NOT pg.anulado
    ),
    vueltas AS (
        SELECT
            p.id AS pago_id,
            p.client_id,
            p.fecha,
            p.anterior,
            (EXTRACT(YEAR FROM AGE(p.fecha, p.anterior)) * 12
             + EXTRACT(MONTH FROM AGE(p.fecha, p.anterior)))::INT AS meses
        FROM pagos_ordenados p
        WHERE p.anterior IS NOT NULL
          AND p.fecha >= v_desde
    ),
    insertadas AS (
        INSERT INTO reactivaciones (
            cliente_id, vendedor_id, pago_id, pago_anterior, reactivado_el,
            meses_inactivo, retiro_id, origen
        )
        SELECT
            v.client_id,
            cv.vendedor_id,
            v.pago_id,
            v.anterior,
            v.fecha,
            v.meses,
            (SELECT re.id FROM retiros_equipo re
              WHERE re.cliente_id = v.client_id
              ORDER BY re.creado_en DESC LIMIT 1),
            'automatica'
        FROM vueltas v
        LEFT JOIN v_cliente_vendedor cv ON cv.cliente_id = v.client_id
        WHERE v.meses >= v_reglas.meses_sin_pago_suspension
        ON CONFLICT (cliente_id, reactivado_el) DO NOTHING
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_n FROM insertadas;

    RETURN QUERY SELECT v_n;
END $$;

COMMENT ON FUNCTION detectar_reactivaciones IS
    'Anota a quienes volvieron a pagar después de un hueco. No genera comisión: el punto 14 lo prohíbe.';


-- =============================================================================
-- 6. La cartera en riesgo del vendedor
-- =============================================================================
/**
 * "4 clientes de tu cartera no han renovado."
 *
 * ── Por qué esta vista y no la bandeja de cobranza ──
 *
 * Porque la bandeja de la 73 se llena con DEUDA: saldo mayor a cero dentro de
 * la ventana comercial. Bajo prepago hay un caso que se le escapa entero — el
 * abonado que simplemente dejó de renovar y al que no se le siguió facturando
 * no tiene saldo, y sin embargo es exactamente el cliente que el vendedor está
 * por perder y con él su bono de calidad.
 *
 * Esta vista sale del otro lado: de las ventas que le contaron como
 * comisionables. Es la lista de "los tuyos", medida en meses sin pagar.
 *
 * ── Por qué NO lleva security_invoker ──
 *
 * Misma razón que `v_cobros_por_gestionar`: corre con privilegio para poder
 * leer `clientes` —que al vendedor le está cerrada— y devolver SOLO las
 * columnas que necesita para llamar. Sin cédula, sin dirección, sin clave PPP,
 * sin historial de pagos. Es el punto 28.
 */
DROP VIEW IF EXISTS v_cartera_en_riesgo;
CREATE VIEW v_cartera_en_riesgo AS
SELECT
    cv.id            AS venta_id,
    cv.cliente_id,
    cv.vendedor_id,
    cv.cohorte,
    c.nombre         AS cliente,
    COALESCE(c.telefono_movil, c.telefono) AS telefono,
    pl.nombre        AS plan,
    m.meses          AS meses_sin_pago,
    (SELECT MAX(pg.fecha_pago)::DATE FROM pagos pg
      WHERE pg.client_id = cv.cliente_id AND NOT pg.anulado) AS ultimo_pago,
    c.estado         AS estado_cliente,
    cv.calidad_estado,

    -- En qué punto de la caída está. Es lo que ordena el trabajo del día: el
    -- que está a un mes de perderse se llama primero que el que ya se perdió.
    CASE
        WHEN r.id IS NOT NULL              THEN 'retiro'
        WHEN c.estado = 'baja'             THEN 'baja'
        WHEN m.meses >= reg.meses_sin_pago_retiro THEN 'por_retirar'
        ELSE 'sin_renovar'
    END              AS situacion,

    r.id             AS retiro_id,
    -- La gestión abierta, si la hay: es lo que la pantalla usa para registrar el
    -- contacto con la función que ya existe.
    ca.id            AS asignacion_id,
    g.creado_en      AS ultima_gestion,
    g.resultado      AS ultimo_resultado,
    g.promesa_fecha
FROM comision_ventas cv
JOIN clientes c            ON c.id = cv.cliente_id
CROSS JOIN LATERAL (SELECT meses_sin_pago(cv.cliente_id) AS meses) m
LEFT JOIN planes_velocidad pl ON pl.id = cv.plan_id
LEFT JOIN comision_reglas reg ON reg.esquema_id = cv.esquema_id
LEFT JOIN retiros_equipo r ON r.cliente_id = cv.cliente_id
                          AND r.estado IN ('pendiente', 'asignado')
LEFT JOIN cobranza_asignaciones ca ON ca.cliente_id = cv.cliente_id AND ca.estado = 'activa'
LEFT JOIN LATERAL (
    SELECT cg.creado_en, cg.resultado, cg.promesa_fecha
      FROM cobranza_gestiones cg
     WHERE cg.asignacion_id = ca.id
     ORDER BY cg.creado_en DESC
     LIMIT 1
) g ON TRUE
WHERE cv.estado <> 'anulada'
  AND cv.comisionable_en IS NOT NULL
  AND m.meses >= COALESCE(reg.meses_sin_pago_suspension, 1)
  AND (ve_comisiones_de_todos() OR cv.vendedor_id = mi_legajo_id());

GRANT SELECT ON v_cartera_en_riesgo TO authenticated;

COMMENT ON VIEW v_cartera_en_riesgo IS
    'Los clientes del vendedor que dejaron de renovar, con su situación y la última gestión. Corre con privilegio para devolver solo las columnas necesarias.';


/**
 * Abre la gestión de recuperación de un cliente propio.
 *
 * ── Por qué hace falta si ya existe `asignar_cobranza` ──
 *
 * Porque aquella exige ser administrador —es la puerta de la asignación
 * excepcional— y esta es la puerta del vendedor sobre SU cliente: no puede
 * elegir a quién, solo puede abrir la gestión de alguien que ya es suyo. La
 * verificación de que lo sea está adentro y no en la pantalla.
 *
 * Reutiliza las tablas de cobranza para que el historial de contactos con ese
 * abonado sea uno solo.
 */
CREATE OR REPLACE FUNCTION abrir_gestion_recuperacion(p_cliente UUID, p_dias INT DEFAULT 30)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_legajo UUID := mi_legajo_id();
    v_vendedor UUID;
    v_id UUID;
BEGIN
    SELECT cv.vendedor_id INTO v_vendedor
      FROM comision_ventas cv
     WHERE cv.cliente_id = p_cliente
       AND cv.estado <> 'anulada'
     LIMIT 1;

    IF v_vendedor IS NULL THEN
        RAISE EXCEPTION 'Ese abonado no figura como venta de nadie';
    END IF;

    IF NOT ve_comisiones_de_todos() AND v_vendedor IS DISTINCT FROM v_legajo THEN
        RAISE EXCEPTION 'Ese abonado no es de tu cartera';
    END IF;

    -- Si ya hay una activa, se devuelve esa: dos gestiones abiertas sobre el
    -- mismo abonado parten el historial en dos.
    SELECT id INTO v_id FROM cobranza_asignaciones
     WHERE cliente_id = p_cliente AND estado = 'activa' LIMIT 1;

    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    INSERT INTO cobranza_asignaciones
        (cliente_id, vendedor_id, vence_el, saldo_inicial, motivo, asignado_por)
    SELECT p_cliente, v_vendedor, CURRENT_DATE + p_dias,
           (SELECT saldo FROM v_clientes_ficha WHERE id = p_cliente),
           'Recuperación: dejó de renovar', v_legajo
    RETURNING id INTO v_id;

    RETURN v_id;
END $$;


-- =============================================================================
-- 7. Los números del punto 13
-- =============================================================================
/**
 * Las órdenes con el nombre de todo al lado.
 *
 * Sin `security_invoker`, y por la misma razón que la bandeja de cobranza: al
 * técnico y al vendedor la tabla `clientes` les está cerrada, así que la vista
 * heredada les devolvería sus propias órdenes con el nombre y el teléfono en
 * blanco — es decir, sin la única información que necesitan para ir. El filtro
 * de quién ve qué está en el WHERE y repite el de la política.
 */
DROP VIEW IF EXISTS v_retiros_equipo;
CREATE VIEW v_retiros_equipo AS
SELECT
    re.*,
    c.nombre  AS cliente,
    COALESCE(c.telefono_movil, c.telefono) AS telefono,
    t.nombre  AS tecnico,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    (CURRENT_DATE - re.creado_en::DATE)::INT AS dias_abierta,
    (SELECT MAX(i.creado_en) FROM retiro_intentos i WHERE i.retiro_id = re.id) AS ultimo_intento
FROM retiros_equipo re
LEFT JOIN clientes c         ON c.id = re.cliente_id
LEFT JOIN tecnicos t         ON t.id = re.tecnico_id
LEFT JOIN usuarios_sistema u ON u.id = re.vendedor_id
WHERE puede_gestionar_retiros()
   OR re.tecnico_id = mi_tecnico_id()
   OR re.vendedor_id = mi_legajo_id();

GRANT SELECT ON v_retiros_equipo TO authenticated;


/**
 * La tasa de recuperación y el valor en riesgo.
 *
 * Una fila por vendedor, más el total. El punto 13 pide medir la recuperación;
 * el corte por vendedor es lo que después permite ver si un patrón es del
 * proceso o de quién vendió — sin que eso signifique descontarle nada.
 */
DROP VIEW IF EXISTS v_retiros_resumen;
CREATE VIEW v_retiros_resumen WITH (security_invoker = true) AS
SELECT
    re.vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,

    COUNT(*) FILTER (WHERE re.estado IN ('pendiente', 'asignado'))  AS pendientes,
    COUNT(*) FILTER (WHERE re.estado = 'recuperado')                AS recuperados,
    COUNT(*) FILTER (WHERE re.estado = 'no_recuperado')             AS no_recuperados,
    COUNT(*) FILTER (WHERE re.estado = 'cancelado')                 AS cancelados,

    -- Lo que todavía está en la calle: el "valor económico en riesgo" del
    -- ejemplo del requerimiento —8 ONT × $50 = $400—.
    COALESCE(SUM(re.valor) FILTER (WHERE re.estado IN ('pendiente', 'asignado')), 0) AS valor_en_riesgo,
    COALESCE(SUM(re.valor) FILTER (WHERE re.estado = 'no_recuperado'), 0)            AS valor_perdido,
    COALESCE(SUM(re.valor) FILTER (WHERE re.estado = 'recuperado'), 0)               AS valor_recuperado,

    -- Sobre las CERRADAS: incluir las pendientes en el denominador daría una
    -- tasa que baja sola cada vez que se abre una orden nueva, aunque el equipo
    -- de campo esté recuperando todo.
    CASE
        WHEN COUNT(*) FILTER (WHERE re.estado IN ('recuperado', 'no_recuperado')) = 0 THEN NULL
        ELSE ROUND(
            COUNT(*) FILTER (WHERE re.estado = 'recuperado') * 100.0
            / COUNT(*) FILTER (WHERE re.estado IN ('recuperado', 'no_recuperado')), 2)
    END AS tasa_recuperacion
FROM retiros_equipo re
LEFT JOIN usuarios_sistema u ON u.id = re.vendedor_id
-- GROUPING SETS y no ROLLUP: el ROLLUP agrega un nivel intermedio —el mismo
-- vendedor con el nombre en NULL— que no le sirve a nadie y que en pantalla se
-- ve como una fila duplicada. Acá hay exactamente dos niveles: cada vendedor y
-- el total.
GROUP BY GROUPING SETS (
    (re.vendedor_id, TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))),
    ()
);

GRANT SELECT ON v_retiros_resumen TO authenticated;

COMMENT ON VIEW v_retiros_resumen IS
    'ONT pendientes, recuperadas, no recuperadas, tasa y valor en riesgo. La fila con vendedor NULL es el total.';


-- Las reactivaciones con nombre. Sin `security_invoker` por lo mismo que la de
-- retiros: al vendedor le sirve para saber a quién recuperó, y para eso hace
-- falta el nombre.
DROP VIEW IF EXISTS v_reactivaciones;
CREATE VIEW v_reactivaciones AS
SELECT
    ra.*,
    c.nombre AS cliente,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    pl.nombre AS plan
FROM reactivaciones ra
LEFT JOIN clientes c          ON c.id = ra.cliente_id
LEFT JOIN planes_velocidad pl ON pl.id = c.plan_id
LEFT JOIN usuarios_sistema u  ON u.id = ra.vendedor_id
WHERE ve_comisiones_de_todos() OR ra.vendedor_id = mi_legajo_id();

GRANT SELECT ON v_reactivaciones TO authenticated;


-- =============================================================================
-- 8. El interruptor de la tarea
-- =============================================================================
-- Va aparte de la de comisiones a propósito. Aquella congela lo que se le paga
-- a alguien y por eso arranca apagada y con advertencia; esta abre órdenes de
-- trabajo y anota regresos, que no le cuesta plata a nadie. Tenerlas juntas
-- obligaría a elegir entre no generar retiros o encender el cierre de
-- comisiones antes de tiempo.
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS cartera_automatico BOOLEAN DEFAULT FALSE;
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS cartera_hora VARCHAR(5) DEFAULT '04:00';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Abrir las órdenes que correspondan hoy:
--   SELECT * FROM generar_retiros_equipo();
--
--   SELECT cliente, serie, modelo, valor, meses_sin_pago, estado, dias_abierta
--     FROM v_retiros_equipo ORDER BY creado_en DESC;
--
--   -- El trabajo del día del técnico, y el cierre:
--   SELECT asignar_retiro_equipo('<orden>', '<tecnico>');
--   SELECT registrar_intento_retiro('<orden>', 'no_estaba', 'Fui a las 10, no había nadie');
--   SELECT cerrar_retiro_equipo('<orden>', TRUE, NULL, 'Entregado sin problema', 'HWTC1234ABCD');
--
--   -- Los números del punto 13 (la fila sin vendedor es el total):
--   SELECT vendedor, pendientes, recuperados, no_recuperados, tasa_recuperacion,
--          valor_en_riesgo, valor_perdido
--     FROM v_retiros_resumen;
--
--   -- Quiénes volvieron:
--   SELECT * FROM detectar_reactivaciones();
--   SELECT cliente, vendedor, pago_anterior, reactivado_el, meses_inactivo
--     FROM v_reactivaciones ORDER BY reactivado_el DESC;
--
--   -- Y la cartera del vendedor:
--   SELECT cliente, telefono, meses_sin_pago, situacion, ultimo_resultado
--     FROM v_cartera_en_riesgo ORDER BY meses_sin_pago DESC;
