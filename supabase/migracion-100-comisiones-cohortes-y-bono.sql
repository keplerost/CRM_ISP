-- =============================================================================
-- Migración 100 — Comisiones: cohortes de calidad y bono de cartera (Fase 4)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué trae ──
--
--   1. El MOTIVO por el que se fue un abonado, cargado en su ficha. El catálogo
--      existe desde la 97 y hasta hoy no había forma de usarlo.
--   2. El VEREDICTO de calidad de cada venta: conservado, perdido o excluido.
--   3. La COHORTE: el grupo de ventas de un mes, evaluado 90 días después, con
--      su porcentaje de calidad y el bono que le corresponde.
--   4. La LIQUIDACIÓN de ese bono dentro del período en que la cohorte cierra.
--
-- Después de esto el bono de calidad se calcula y se paga solo. Lo que todavía
-- no tiene es la pantalla del vendedor —eso es la Fase 6— ni la gestión de
-- cartera y el retiro de equipos, que es la Fase 5.
--
-- ── Por qué la cohorte no se evalúa a los 90 días de la venta ──
--
-- Porque entonces cada abonado del mismo mes cerraría un día distinto y no
-- habría un momento en que la cohorte esté completa: el bono de agosto se
-- estaría recalculando todos los días hasta fin de noviembre.
--
-- Se cuenta desde que TERMINA el mes de la cohorte. Así todos los clientes de
-- agosto tienen como mínimo sus 90 días de seguimiento —el que entró el 31 los
-- tiene justos, el que entró el 1 tiene 120— y la cohorte cierra una sola vez,
-- en una fecha que se puede anunciar de antemano.
--
-- ── Por qué el bono se paga en noviembre y no en agosto ──
--
-- Porque en agosto todavía no se sabe. La cohorte de agosto recién se puede
-- medir el 30 de noviembre, y para entonces el período de agosto está aprobado
-- y cobrado hace tres meses. Reabrirlo sería cambiar un pago hecho, que es
-- exactamente lo que el punto 25 prohíbe.
--
-- Así que el bono se suma al período abierto en que la cohorte cierra: el
-- vendedor lo ve como "bono de la cohorte de agosto" dentro de su liquidación de
-- noviembre, con el mes de origen escrito al lado.
--
-- ── Y por qué una cohorte cerrada no se vuelve a tocar ──
--
-- Punto 16, textual: una reactivación posterior NO modifica retroactivamente el
-- bono cerrado. Un cliente que vuelve en enero es una buena noticia y va a
-- contar en el incentivo de recuperación de la Fase 5; lo que no puede hacer es
-- reescribir un bono que ya se pagó en diciembre.
-- =============================================================================


-- =============================================================================
-- 1. Por qué se fue el abonado
-- =============================================================================
/**
 * El motivo de baja, en la ficha del cliente.
 *
 * ── Por qué hace falta acá y no en otra tabla ──
 *
 * Porque la baja ya se registra cambiando `clientes.estado` a 'baja' desde la
 * ficha, y una tabla aparte significaría que quien da de baja tiene que acordarse
 * de escribir en dos lugares. El que se olvida siempre es el segundo.
 *
 * ── Qué cambia esto para el vendedor ──
 *
 * Todo. Sin motivo, cada baja pesa igual: el abonado que se mudó fuera de
 * cobertura cuenta lo mismo que el que nunca pagó. Con el catálogo de la 97
 * —donde cada motivo dice si afecta o no la calidad— el vendedor deja de pagar
 * por lo que no depende de él, que es de lo que se trata el punto 17.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS motivo_baja_id UUID REFERENCES motivos_baja(id) ON DELETE SET NULL;
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS baja_en   TIMESTAMPTZ;
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS baja_nota TEXT;

COMMENT ON COLUMN clientes.motivo_baja_id IS
    'Por qué se fue. Decide si la baja le cuenta al vendedor en la calidad de su cohorte.';


/**
 * Da de baja a un abonado dejando dicho por qué.
 *
 * Pasa por función porque son tres cosas que tienen que ocurrir juntas: el
 * estado, el motivo y el registro de quién lo decidió. Sueltas, la que se
 * olvida es la del medio — y sin motivo la baja pesa como si fuera culpa del
 * vendedor.
 *
 * No exige permiso propio: dar de baja ya es una acción de la ficha del cliente
 * y esa puerta ya tiene su control. Lo que agrega es que quede escrito.
 */
CREATE OR REPLACE FUNCTION dar_de_baja_cliente(
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
    v_legajo UUID := mi_legajo_id();
    v_fila   clientes%ROWTYPE;
    v_motivo TEXT;
BEGIN
    UPDATE clientes
       SET estado         = 'baja',
           motivo_baja_id = p_motivo,
           baja_en        = COALESCE(baja_en, NOW()),
           baja_nota      = COALESCE(NULLIF(BTRIM(p_nota), ''), baja_nota),
           updated_at     = NOW()
     WHERE id = p_cliente
    RETURNING * INTO v_fila;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese abonado';
    END IF;

    SELECT nombre INTO v_motivo FROM motivos_baja WHERE id = p_motivo;

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion,
        entidad, entidad_id, datos
    ) VALUES (
        v_legajo,
        COALESCE(
            (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
               FROM usuarios_sistema u WHERE u.id = v_legajo),
            'Sistema'),
        (SELECT u.rol FROM usuarios_sistema u WHERE u.id = v_legajo),
        'cliente.baja',
        FORMAT('Dio de baja a %s%s', v_fila.nombre,
               COALESCE(' — ' || v_motivo, '')),
        'cliente', p_cliente::TEXT,
        jsonb_build_object('motivo_id', p_motivo, 'motivo', v_motivo, 'nota', p_nota)
    );

    -- La calidad de la cohorte de ese cliente cambia con esto. Se recalcula acá
    -- para que la ficha muestre el efecto sin esperar a la corrida de la noche.
    PERFORM evaluar_cohortes_de_cliente(p_cliente);

    RETURN v_fila;
END $$;

COMMENT ON FUNCTION dar_de_baja_cliente IS
    'Baja con motivo. El motivo decide si la pérdida le cuenta al vendedor en la calidad de su cohorte.';


-- =============================================================================
-- 2. El veredicto de cada venta
-- =============================================================================
/**
 * Cómo terminó cada venta a los 90 días.
 *
 * ── Por qué se guarda y no se calcula al vuelo ──
 *
 * Porque una cohorte cerrada tiene que poder explicarse renglón por renglón. Si
 * el veredicto se recalculara al abrirlo, un abonado que se reactivó en enero
 * aparecería como conservado dentro de una cohorte que se cerró en diciembre
 * contándolo como perdido — y el total no cuadraría con el detalle.
 *
 * Mientras la cohorte está abierta el veredicto se actualiza todos los días: es
 * lo que le permite al vendedor ver a quién tiene que ir a buscar. Al cerrarse
 * queda congelado.
 */
ALTER TABLE comision_ventas
    ADD COLUMN IF NOT EXISTS calidad_estado VARCHAR(14) NOT NULL DEFAULT 'en_seguimiento';
ALTER TABLE comision_ventas
    ADD COLUMN IF NOT EXISTS calidad_motivo TEXT;
ALTER TABLE comision_ventas
    ADD COLUMN IF NOT EXISTS calidad_en     TIMESTAMPTZ;

ALTER TABLE comision_ventas DROP CONSTRAINT IF EXISTS comision_ventas_calidad_check;
ALTER TABLE comision_ventas ADD CONSTRAINT comision_ventas_calidad_check
    CHECK (calidad_estado IN (
        'en_seguimiento',  -- la cohorte sigue abierta
        'conservado',      -- sigue siendo cliente
        'perdido',         -- llegó a la condición de retiro, o se fue por algo que sí cuenta
        'excluido'         -- se fue por algo que no es responsabilidad del vendedor
    ));

COMMENT ON COLUMN comision_ventas.calidad_estado IS
    'Cómo terminó la venta dentro de su cohorte. Se congela cuando la cohorte cierra.';


-- =============================================================================
-- 3. Arreglo: la cohorte se fijaba antes de tiempo
-- =============================================================================
/**
 * La 98 escribía `cohorte` con la fecha de creación de la fila aunque la venta
 * todavía no fuera comisionable, y después la dejaba fija.
 *
 * El efecto: una venta cargada en julio que recién se instala y activa en
 * septiembre quedaba en la cohorte de JULIO mientras se pagaba en el período de
 * SEPTIEMBRE. La cohorte de julio la iba a evaluar en octubre a una venta que
 * llevaba tres semanas de vida, y el vendedor perdía bono por un cliente que
 * todavía no había tenido tiempo de fallar.
 *
 * La corrección es que la cohorte nazca NULL y se fije en el momento en que la
 * venta se vuelve comisionable — que es cuando empieza a contar de verdad.
 *
 * Son dos cosas y hacen falta las dos: realinear lo que ya está cargado, y que
 * el generador deje de volver a escribirlo mal en la próxima corrida.
 *
 * El UPDATE se puede correr sin miedo porque todavía no existe ninguna cohorte
 * cerrada: esta migración es la que crea la tabla. De acá en adelante, una
 * cohorte cerrada no se toca más.
 */
UPDATE comision_ventas
   SET cohorte = CASE
                     WHEN comisionable_en IS NOT NULL
                     THEN DATE_TRUNC('month', comisionable_en)::DATE
                 END
 WHERE cohorte IS DISTINCT FROM CASE
                                    WHEN comisionable_en IS NOT NULL
                                    THEN DATE_TRUNC('month', comisionable_en)::DATE
                                END;


/**
 * El generador, otra vez. Cambia una sola línea: la que escribe la cohorte.
 *
 * Se copia entera y no se parchea porque una función en Postgres se reemplaza
 * completa; y queda en esta migración —en vez de editar la 99— porque las
 * migraciones ya corridas no se tocan: quien las ejecutó en orden tiene que
 * llegar al mismo lugar que quien las corra mañana desde cero.
 */
CREATE OR REPLACE FUNCTION generar_comisiones(p_cliente UUID DEFAULT NULL)
RETURNS TABLE (creadas INT, actualizadas INT, comisionables INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r RECORD;
    v_creadas INT := 0;
    v_actualizadas INT := 0;
    v_comisionables INT := 0;
    v_existe UUID;
    v_estado TEXT;
BEGIN
    FOR r IN
        SELECT
            p.id            AS prospecto_id,
            p.cliente_id,
            p.vendedor_id,
            p.ganado_en,
            p.tipo_operacion,
            c.plan_id       AS plan_activado,
            c.estado        AS estado_cliente,

            (SELECT MIN(COALESCE(i.alta_at, i.fecha::TIMESTAMPTZ))
               FROM instalaciones i
              WHERE i.client_id = p.cliente_id
                AND i.tipo = 'nueva'
                AND i.estado = 'hecha')            AS instalado_en,

            CASE WHEN c.estado <> 'baja'
                 THEN COALESCE(c.activado_en, c.fecha_instalacion::TIMESTAMPTZ)
            END                                     AS activado_en,

            (SELECT e.actualizado_en FROM v_expedientes e
              WHERE e.prospecto_id = p.id
                AND e.ok_datos AND e.ok_cedula_frontal
                AND e.ok_cedula_posterior AND e.ok_fotos AND e.ok_ubicacion
              LIMIT 1)                              AS documentado_en,

            (SELECT MIN(ct.fecha_inicio::TIMESTAMPTZ) FROM contratos ct
              WHERE ct.client_id = p.cliente_id
                AND ct.firma_estado = 'firmado')     AS contrato_en,

            (SELECT MIN(pg.fecha_pago::TIMESTAMPTZ) FROM pagos pg
              WHERE pg.client_id = p.cliente_id
                AND NOT pg.anulado)                  AS primer_pago_en,

            (SELECT sv.validado_en FROM solicitudes_validacion sv
              WHERE sv.prospecto_id = p.id
                AND sv.estado = 'aprobado'
              LIMIT 1)                               AS aprobado_en
        FROM prospectos p
        JOIN clientes c ON c.id = p.cliente_id
        WHERE p.estado = 'ganado'
          AND p.cliente_id IS NOT NULL
          AND p.tipo_operacion = 'nueva'
          AND (p_cliente IS NULL OR p.cliente_id = p_cliente)
    LOOP
        SELECT id, estado INTO v_existe, v_estado
          FROM comision_ventas
         WHERE cliente_id = r.cliente_id
         ORDER BY (estado <> 'anulada') DESC, creado_en DESC
         LIMIT 1;

        IF v_estado IN ('aprobada', 'pagada', 'anulada') THEN
            CONTINUE;
        END IF;

        DECLARE
            v_esquema UUID;
            v_reglas  comision_reglas%ROWTYPE;
            v_base    NUMERIC(12,2);
            v_comisionable TIMESTAMPTZ;
            v_espera  DATE;
            v_nuevo_estado TEXT;
            v_fecha_ref DATE;
        BEGIN
            v_fecha_ref := COALESCE(r.ganado_en::DATE, CURRENT_DATE);
            v_esquema := esquema_comisiones_vigente(v_fecha_ref);
            IF v_esquema IS NULL THEN CONTINUE; END IF;

            SELECT * INTO v_reglas FROM comision_reglas WHERE esquema_id = v_esquema;

            SELECT b.base INTO v_base
              FROM comision_bases_plan b
             WHERE b.esquema_id = v_esquema
               AND b.plan_id = r.plan_activado
               AND b.comisiona;

            v_comisionable := NULL;
            IF  (NOT v_reglas.requiere_aprobacion    OR r.aprobado_en    IS NOT NULL)
            AND (NOT v_reglas.requiere_documentacion OR r.documentado_en IS NOT NULL)
            AND (NOT v_reglas.requiere_contrato      OR r.contrato_en    IS NOT NULL)
            AND (NOT v_reglas.requiere_instalacion   OR r.instalado_en   IS NOT NULL)
            AND (NOT v_reglas.requiere_activacion    OR r.activado_en    IS NOT NULL)
            AND (NOT v_reglas.requiere_primer_pago   OR r.primer_pago_en IS NOT NULL)
            AND v_base IS NOT NULL
            THEN
                v_comisionable := GREATEST(
                    COALESCE(r.ganado_en, '-infinity'::TIMESTAMPTZ),
                    CASE WHEN v_reglas.requiere_aprobacion    THEN r.aprobado_en    END,
                    CASE WHEN v_reglas.requiere_documentacion THEN r.documentado_en END,
                    CASE WHEN v_reglas.requiere_contrato      THEN r.contrato_en    END,
                    CASE WHEN v_reglas.requiere_instalacion   THEN r.instalado_en   END,
                    CASE WHEN v_reglas.requiere_activacion    THEN r.activado_en    END,
                    CASE WHEN v_reglas.requiere_primer_pago   THEN r.primer_pago_en END
                );
            END IF;

            v_espera := NULL;
            IF r.instalado_en IS NOT NULL THEN
                v_espera := CASE
                    WHEN EXTRACT(DAY FROM r.instalado_en) >= v_reglas.dia_cortesia_desde
                    THEN (DATE_TRUNC('month', r.instalado_en) + INTERVAL '1 month')::DATE
                         + (v_reglas.pago_ventana_hasta - 1)
                    ELSE (DATE_TRUNC('month', r.instalado_en))::DATE
                         + (v_reglas.pago_ventana_hasta - 1)
                END;
            END IF;

            v_nuevo_estado := 'proyectada';
            IF v_comisionable IS NULL
               AND v_reglas.requiere_primer_pago
               AND r.primer_pago_en IS NULL
               AND r.instalado_en IS NOT NULL
               AND r.activado_en IS NOT NULL
               AND v_espera >= CURRENT_DATE
            THEN
                v_nuevo_estado := 'pendiente_validacion';
            END IF;

            IF v_comisionable IS NOT NULL THEN
                v_comisionables := v_comisionables + 1;
            END IF;

            INSERT INTO comision_ventas (
                prospecto_id, cliente_id, vendedor_id, plan_id, tipo_operacion,
                esquema_id, base, periodo, cohorte,
                ganado_en, aprobado_en, documentado_en, contrato_en,
                instalado_en, activado_en, primer_pago_en,
                comisionable_en, espera_pago_hasta, estado
            ) VALUES (
                r.prospecto_id, r.cliente_id, r.vendedor_id, r.plan_activado, r.tipo_operacion,
                v_esquema, v_base,
                DATE_TRUNC('month', COALESCE(v_comisionable, NOW()))::DATE,
                -- LA LÍNEA. Sin venta comisionable no hay cohorte: entra al grupo
                -- el mes en que empieza a contar, no el día que se cargó.
                CASE WHEN v_comisionable IS NOT NULL
                     THEN DATE_TRUNC('month', v_comisionable)::DATE END,
                r.ganado_en, r.aprobado_en, r.documentado_en, r.contrato_en,
                r.instalado_en, r.activado_en, r.primer_pago_en,
                v_comisionable, v_espera, v_nuevo_estado
            )
            ON CONFLICT (cliente_id) WHERE cliente_id IS NOT NULL AND estado <> 'anulada'
            DO UPDATE SET
                vendedor_id    = EXCLUDED.vendedor_id,
                plan_id        = EXCLUDED.plan_id,
                esquema_id     = EXCLUDED.esquema_id,
                base           = EXCLUDED.base,
                periodo        = EXCLUDED.periodo,
                -- Una vez que entró a un grupo, ahí se queda.
                cohorte        = COALESCE(comision_ventas.cohorte, EXCLUDED.cohorte),
                ganado_en      = EXCLUDED.ganado_en,
                aprobado_en    = EXCLUDED.aprobado_en,
                documentado_en = EXCLUDED.documentado_en,
                contrato_en    = EXCLUDED.contrato_en,
                instalado_en   = EXCLUDED.instalado_en,
                activado_en    = EXCLUDED.activado_en,
                primer_pago_en = EXCLUDED.primer_pago_en,
                comisionable_en = EXCLUDED.comisionable_en,
                espera_pago_hasta = EXCLUDED.espera_pago_hasta,
                estado = CASE WHEN comision_ventas.estado = 'generada'
                              THEN 'generada' ELSE EXCLUDED.estado END,
                actualizado_en = NOW();

            IF v_existe IS NULL THEN
                v_creadas := v_creadas + 1;
            ELSE
                v_actualizadas := v_actualizadas + 1;
            END IF;
        END;
    END LOOP;

    RETURN QUERY SELECT v_creadas, v_actualizadas, v_comisionables;
END $$;


-- =============================================================================
-- 4. Cuántos meses lleva sin pagar
-- =============================================================================
/**
 * La señal que define la calidad, según el punto 17.
 *
 * ── Por qué meses cumplidos y no diferencia de calendario ──
 *
 * Restar números de mes diría que del 31 de agosto al 1 de septiembre pasó "un
 * mes". Con `age()` pasa un día, que es lo que pasó de verdad. La diferencia
 * importa: con el umbral de retiro en 2, la cuenta de calendario adelantaría la
 * pérdida hasta dos meses y le sacaría el bono a alguien por clientes que
 * estaban al día.
 *
 * ── Desde cuándo se cuenta si nunca pagó ──
 *
 * Desde que se activó. Un abonado instalado hace tres meses que nunca pagó lleva
 * tres meses sin pagar; medirlo desde su último pago —que no existe— lo dejaría
 * en cero para siempre.
 */
CREATE OR REPLACE FUNCTION meses_sin_pago(p_cliente UUID, p_hasta DATE DEFAULT CURRENT_DATE)
RETURNS INT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ref DATE;
    v_edad INTERVAL;
BEGIN
    SELECT MAX(pg.fecha_pago)::DATE INTO v_ref
      FROM pagos pg
     WHERE pg.client_id = p_cliente
       AND NOT pg.anulado;

    IF v_ref IS NULL THEN
        SELECT COALESCE(c.activado_en::DATE, c.fecha_instalacion::DATE, c.created_at::DATE)
          INTO v_ref
          FROM clientes c WHERE c.id = p_cliente;
    END IF;

    IF v_ref IS NULL OR v_ref >= p_hasta THEN
        RETURN 0;
    END IF;

    v_edad := AGE(p_hasta, v_ref);
    RETURN (EXTRACT(YEAR FROM v_edad) * 12 + EXTRACT(MONTH FROM v_edad))::INT;
END $$;

COMMENT ON FUNCTION meses_sin_pago IS
    'Meses cumplidos desde el último pago no anulado. Si nunca pagó, desde que se activó.';


/**
 * El bono que corresponde a un porcentaje de calidad.
 */
CREATE OR REPLACE FUNCTION bono_de_calidad(p_esquema UUID, p_calidad NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT b.monto
           FROM comision_bonos_calidad b
          WHERE b.esquema_id = p_esquema
            AND p_calidad >= b.desde_pct
            AND p_calidad <= b.hasta_pct
          ORDER BY b.desde_pct DESC
          LIMIT 1),
        0
    )
$$;


-- =============================================================================
-- 5. La cohorte
-- =============================================================================
/**
 * Un grupo de ventas de un mes, con su calidad medida y su bono.
 *
 * ── Por qué no alcanza con contar las ventas cada vez ──
 *
 * Porque el bono es plata y tiene que quedar dicho de una vez: con qué esquema
 * se midió, cuántos clientes se evaluaron, cuántos se conservaron y qué tramo
 * salió. Recalcularlo en cada consulta significaría que el bono de agosto cambia
 * el día que alguien edite los tramos, tres meses después de haberlo cobrado.
 */
CREATE TABLE IF NOT EXISTS comision_cohortes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    vendedor_id UUID NOT NULL REFERENCES usuarios_sistema(id) ON DELETE CASCADE,
    -- El mes en que esas ventas se volvieron comisionables.
    cohorte     DATE NOT NULL,

    esquema_id  UUID REFERENCES comision_esquemas(id) ON DELETE SET NULL,

    -- ── El recuento ──
    -- `evaluables` = conservados + perdidos. Los excluidos quedan afuera de los
    -- dos lados de la división: no suman ni restan.
    evaluables  INT NOT NULL DEFAULT 0,
    conservados INT NOT NULL DEFAULT 0,
    perdidos    INT NOT NULL DEFAULT 0,
    excluidos   INT NOT NULL DEFAULT 0,

    calidad     NUMERIC(5,2) NOT NULL DEFAULT 0,
    bono        NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- Por qué el bono es el que es. Sirve sobre todo cuando es cero: "solo 6
    -- clientes evaluables, hacen falta 10" es una explicación; un cero pelado,
    -- una discusión.
    detalle     TEXT,

    -- ── El seguimiento ──
    cierra_el   DATE NOT NULL,
    estado      VARCHAR(8) NOT NULL DEFAULT 'abierta',

    -- ── La liquidación ──
    -- En qué período se le sumó al vendedor. No es el mes de la cohorte: para
    -- cuando se sabe el resultado, ese mes ya se pagó.
    periodo_liquidado DATE,
    liquidado_en      TIMESTAMPTZ,

    evaluado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cerrado_en  TIMESTAMPTZ,

    UNIQUE (vendedor_id, cohorte),
    CONSTRAINT comision_cohortes_estado_check CHECK (estado IN ('abierta', 'cerrada')),
    CONSTRAINT comision_cohortes_calidad_check CHECK (calidad >= 0 AND calidad <= 100)
);

ALTER TABLE comision_cohortes ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_comision_cohortes_pendientes
    ON comision_cohortes (estado, liquidado_en);

-- Leer: lo propio, o todo con permiso. Misma regla que las comisiones: el bono
-- de un compañero es información salarial de otra persona.
DROP POLICY IF EXISTS comision_cohortes_lectura ON comision_cohortes;
CREATE POLICY comision_cohortes_lectura ON comision_cohortes
    FOR SELECT TO authenticated
    USING (ve_comisiones_de_todos() OR vendedor_id = mi_legajo_id());

-- Escribir a mano: nadie. Una cohorte con el bono editado y los conteos sin
-- tocar es una cifra que no se puede explicar.
DROP POLICY IF EXISTS comision_cohortes_escritura ON comision_cohortes;
CREATE POLICY comision_cohortes_escritura ON comision_cohortes
    FOR ALL TO authenticated
    USING (false) WITH CHECK (false);


-- =============================================================================
-- 6. El evaluador
-- =============================================================================
/**
 * Mide las cohortes y cierra las que ya cumplieron su plazo.
 *
 * ── Qué hace en cada corrida ──
 *
 *   1. Anota el veredicto de cada venta: conservado, perdido o excluido.
 *   2. Cuenta, calcula el porcentaje y el bono que saldría.
 *   3. Si ya pasó `cierra_el`, congela todo y marca la cohorte como cerrada.
 *
 * Los pasos 1 y 2 se repiten todos los días mientras la cohorte esté abierta —es
 * lo que alimenta el "te faltan 2 clientes para el bono máximo"—. El 3 ocurre
 * una sola vez.
 *
 * ── Por qué pide permiso ──
 *
 * Porque el paso 3 asigna plata. La lectura no lo necesita: para eso está la
 * vista, que filtra por RLS y deja que cada vendedor vea la suya.
 *
 * @param p_vendedor  opcional, para una sola persona.
 * @param p_cohorte   opcional, para un solo mes.
 */
DROP FUNCTION IF EXISTS evaluar_cohortes(UUID, DATE);

CREATE FUNCTION evaluar_cohortes(
    p_vendedor UUID DEFAULT NULL,
    p_cohorte  DATE DEFAULT NULL
)
RETURNS TABLE (
    res_vendedor    UUID,
    res_cohorte     DATE,
    res_evaluables  INT,
    res_conservados INT,
    res_calidad     NUMERIC,
    res_bono        NUMERIC,
    res_estado      TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    g RECORD;
BEGIN
    IF NOT tiene_permiso_comision('comisiones.aprobar')
       AND NOT tiene_permiso_comision('comisiones.configurar') THEN
        RAISE EXCEPTION 'No tenés permiso para evaluar cohortes de calidad';
    END IF;

    FOR g IN
        SELECT cv.vendedor_id, cv.cohorte
          FROM comision_ventas cv
         WHERE cv.cohorte IS NOT NULL
           AND cv.vendedor_id IS NOT NULL
           AND cv.comisionable_en IS NOT NULL
           AND cv.estado <> 'anulada'
           AND (p_vendedor IS NULL OR cv.vendedor_id = p_vendedor)
           AND (p_cohorte  IS NULL OR cv.cohorte     = DATE_TRUNC('month', p_cohorte)::DATE)
           -- Una cohorte cerrada no se vuelve a mirar. Punto 16.
           AND NOT EXISTS (
               SELECT 1 FROM comision_cohortes cc
                WHERE cc.vendedor_id = cv.vendedor_id
                  AND cc.cohorte = cv.cohorte
                  AND cc.estado = 'cerrada')
         GROUP BY cv.vendedor_id, cv.cohorte
    LOOP
        DECLARE
            v_esquema   UUID;
            v_reglas    comision_reglas%ROWTYPE;
            v_cierra    DATE;
            v_cerrar    BOOLEAN;
            v_conserv   INT := 0;
            v_perdidos  INT := 0;
            v_excluidos INT := 0;
            v_evaluables INT := 0;
            v_calidad   NUMERIC := 0;
            v_bono      NUMERIC := 0;
            v_detalle   TEXT;
            v           RECORD;
        BEGIN
            -- El esquema con el que se midieron esas ventas, no el de hoy. Si por
            -- un cambio de versión a mitad de mes hubiera dos, manda el de la
            -- mayoría — igual que en el cálculo del período.
            SELECT cv.esquema_id INTO v_esquema
              FROM comision_ventas cv
             WHERE cv.vendedor_id = g.vendedor_id
               AND cv.cohorte = g.cohorte
               AND cv.comisionable_en IS NOT NULL
               AND cv.estado <> 'anulada'
             GROUP BY cv.esquema_id
             ORDER BY COUNT(*) DESC
             LIMIT 1;

            SELECT * INTO v_reglas FROM comision_reglas WHERE esquema_id = v_esquema;
            IF NOT FOUND THEN
                CONTINUE;  -- sin reglas no hay con qué medir
            END IF;

            -- 90 días contados desde que TERMINA el mes de la cohorte, para que
            -- el que entró el día 31 tenga el mismo plazo que el que entró el 1.
            v_cierra := (g.cohorte + INTERVAL '1 month')::DATE + v_reglas.dias_cohorte;
            v_cerrar := CURRENT_DATE >= v_cierra;

            -- ── El veredicto, venta por venta ──
            FOR v IN
                SELECT cv.id, cv.cliente_id,
                       c.estado AS estado_cliente,
                       mb.nombre AS motivo_baja,
                       COALESCE(mb.afecta_calidad, TRUE) AS baja_cuenta
                  FROM comision_ventas cv
                  LEFT JOIN clientes c      ON c.id = cv.cliente_id
                  LEFT JOIN motivos_baja mb ON mb.id = c.motivo_baja_id
                 WHERE cv.vendedor_id = g.vendedor_id
                   AND cv.cohorte = g.cohorte
                   AND cv.comisionable_en IS NOT NULL
                   AND cv.estado <> 'anulada'
            LOOP
                DECLARE
                    v_estado TEXT;
                    v_motivo TEXT;
                    v_meses  INT;
                BEGIN
                    IF v.cliente_id IS NULL THEN
                        -- Sin ficha no hay nada que medir. Fuera de la cuenta,
                        -- que es distinto de contarlo como perdido.
                        v_estado := 'excluido';
                        v_motivo := 'El abonado ya no está en el sistema';

                    ELSIF v.estado_cliente = 'baja' AND NOT v.baja_cuenta THEN
                        -- Punto 17: hay bajas que no son responsabilidad de quien
                        -- vendió. Salen del denominador, no del numerador.
                        v_estado := 'excluido';
                        v_motivo := COALESCE(v.motivo_baja, 'Baja que no afecta la calidad');

                    ELSIF v.estado_cliente = 'baja' THEN
                        v_estado := 'perdido';
                        v_motivo := COALESCE(v.motivo_baja, 'Dado de baja');

                    ELSE
                        v_meses := meses_sin_pago(v.cliente_id, LEAST(CURRENT_DATE, v_cierra));
                        IF v_meses >= v_reglas.meses_sin_pago_retiro THEN
                            -- La señal negativa fuerte del punto 17. No es la
                            -- falta de un mes: el prepago admite saltear un
                            -- período y volver.
                            v_estado := 'perdido';
                            v_motivo := FORMAT('%s meses sin pagar', v_meses);
                        ELSE
                            v_estado := 'conservado';
                            v_motivo := NULL;
                        END IF;
                    END IF;

                    IF v_estado = 'conservado' THEN
                        v_conserv := v_conserv + 1;
                    ELSIF v_estado = 'perdido' THEN
                        v_perdidos := v_perdidos + 1;
                    ELSE
                        v_excluidos := v_excluidos + 1;
                    END IF;

                    UPDATE comision_ventas
                       SET calidad_estado = v_estado,
                           calidad_motivo = v_motivo,
                           calidad_en     = NOW(),
                           actualizado_en = NOW()
                     WHERE id = v.id;
                END;
            END LOOP;

            v_evaluables := v_conserv + v_perdidos;

            IF v_evaluables > 0 THEN
                v_calidad := ROUND(v_conserv * 100.0 / v_evaluables, 2);
            END IF;

            -- ── El mínimo de clientes evaluables (punto 15) ──
            --
            -- Con 3 clientes, perder uno da 66 % y perder ninguno da 100 %: el
            -- bono se volvería una lotería que premia al que vendió poco.
            IF v_evaluables < v_reglas.min_clientes_cohorte THEN
                v_bono := 0;
                v_detalle := FORMAT(
                    '%s clientes evaluables; el bono pide al menos %s.',
                    v_evaluables, v_reglas.min_clientes_cohorte);
            ELSE
                v_bono := bono_de_calidad(v_esquema, v_calidad);
                v_detalle := FORMAT(
                    '%s de %s conservados (%s %%)%s',
                    v_conserv, v_evaluables, v_calidad,
                    CASE WHEN v_excluidos > 0
                         THEN FORMAT('; %s excluidos por motivo de baja', v_excluidos)
                         ELSE '' END);
            END IF;

            INSERT INTO comision_cohortes (
                vendedor_id, cohorte, esquema_id,
                evaluables, conservados, perdidos, excluidos,
                calidad, bono, detalle, cierra_el, estado,
                evaluado_en, cerrado_en
            ) VALUES (
                g.vendedor_id, g.cohorte, v_esquema,
                v_evaluables, v_conserv, v_perdidos, v_excluidos,
                v_calidad, v_bono, v_detalle, v_cierra,
                CASE WHEN v_cerrar THEN 'cerrada' ELSE 'abierta' END,
                NOW(),
                CASE WHEN v_cerrar THEN NOW() END
            )
            ON CONFLICT (vendedor_id, cohorte) DO UPDATE SET
                esquema_id  = EXCLUDED.esquema_id,
                evaluables  = EXCLUDED.evaluables,
                conservados = EXCLUDED.conservados,
                perdidos    = EXCLUDED.perdidos,
                excluidos   = EXCLUDED.excluidos,
                calidad     = EXCLUDED.calidad,
                bono        = EXCLUDED.bono,
                detalle     = EXCLUDED.detalle,
                cierra_el   = EXCLUDED.cierra_el,
                estado      = EXCLUDED.estado,
                evaluado_en = NOW(),
                cerrado_en  = COALESCE(comision_cohortes.cerrado_en, EXCLUDED.cerrado_en);

            IF v_cerrar THEN
                INSERT INTO auditoria_sistema (
                    usuario_id, usuario_nombre, usuario_rol, accion, descripcion,
                    entidad, entidad_id, datos
                ) VALUES (
                    mi_legajo_id(),
                    COALESCE(
                        (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                           FROM usuarios_sistema u WHERE u.id = mi_legajo_id()),
                        'Sistema'),
                    (SELECT u.rol FROM usuarios_sistema u WHERE u.id = mi_legajo_id()),
                    'comisiones.cohorte_cerrada',
                    FORMAT('Cerró la cohorte %s con %s %% de calidad y un bono de %s',
                           TO_CHAR(g.cohorte, 'MM/YYYY'), v_calidad, v_bono),
                    'comision_cohorte', NULL,
                    jsonb_build_object(
                        'vendedor', g.vendedor_id, 'cohorte', g.cohorte,
                        'evaluables', v_evaluables, 'conservados', v_conserv,
                        'perdidos', v_perdidos, 'excluidos', v_excluidos,
                        'calidad', v_calidad, 'bono', v_bono)
                );
            END IF;

            RETURN QUERY SELECT
                g.vendedor_id, g.cohorte, v_evaluables, v_conserv, v_calidad, v_bono,
                (CASE WHEN v_cerrar THEN 'cerrada' ELSE 'abierta' END)::TEXT;
        END;
    END LOOP;
END $$;

COMMENT ON FUNCTION evaluar_cohortes IS
    'Mide la calidad de cada cohorte y cierra las que cumplieron su plazo. Una cohorte cerrada no se vuelve a tocar.';


/**
 * Vuelve a medir las cohortes que contienen a un abonado.
 *
 * Es lo que se llama desde la ficha cuando alguien lo da de baja: sin esto, el
 * efecto sobre la calidad aparecería recién a la mañana siguiente y el que
 * cargó la baja no vería nada.
 *
 * Se traga los errores de permiso a propósito: dar de baja a un abonado no
 * puede fallar porque quien lo hace no administra comisiones.
 */
CREATE OR REPLACE FUNCTION evaluar_cohortes_de_cliente(p_cliente UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v RECORD;
BEGIN
    FOR v IN
        SELECT DISTINCT cv.vendedor_id, cv.cohorte
          FROM comision_ventas cv
         WHERE cv.cliente_id = p_cliente
           AND cv.cohorte IS NOT NULL
           AND cv.vendedor_id IS NOT NULL
    LOOP
        BEGIN
            PERFORM evaluar_cohortes(v.vendedor_id, v.cohorte);
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;
END $$;


-- =============================================================================
-- 7. El cierre paga el bono
-- =============================================================================
/**
 * Misma función de la 99, con dos cambios:
 *
 *   1. Antes de cerrar, evalúa las cohortes. Cerrar con los veredictos de ayer
 *      congelaría un bono viejo, y un período cerrado no se recalcula.
 *   2. Liquida los bonos de cohortes cerradas que todavía no se pagaron: los
 *      suma a `bono` y los marca con el período en que se fueron.
 *
 * ── Por qué el bucle ahora recorre más gente ──
 *
 * Porque un vendedor puede tener bono de la cohorte de agosto y ninguna venta en
 * noviembre. Con el bucle de la 99 —que solo miraba las ventas del período— ese
 * bono no se pagaba nunca y nadie se enteraba: no hay error, simplemente no
 * aparece el renglón.
 *
 * ── Qué bono entra en qué período ──
 *
 * El de las cohortes cuyo plazo VENCIÓ dentro del mes que se está cerrando. Se
 * mira `cierra_el` y no `cerrado_en` a propósito: la cohorte de agosto vence el
 * 30 de noviembre y pertenece a noviembre, la haya mirado el sistema ese día o
 * tres días después porque la tarea estaba apagada. Con la fecha de ejecución,
 * cada bono se atrasaría un mes entero cada vez que alguien cierra a mano.
 *
 * Y con el límite en el fin de mes, cerrar noviembre en enero no se lleva
 * puesto un bono que vencía en diciembre: ese espera a su propio período.
 */
DROP FUNCTION IF EXISTS cerrar_periodo_comisiones(DATE, UUID, BOOLEAN);

CREATE FUNCTION cerrar_periodo_comisiones(
    p_periodo DATE,
    p_vendedor UUID DEFAULT NULL,
    p_forzar BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (res_vendedor UUID, res_ventas INT, res_monto NUMERIC, res_estado TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_mes DATE := DATE_TRUNC('month', p_periodo)::DATE;
    v_legajo UUID := mi_legajo_id();
    v_reglas comision_reglas%ROWTYPE;
    v_desde DATE;
    -- El día siguiente al último de este período: todo lo que venció antes de
    -- esta fecha entra acá, lo demás espera al mes que viene.
    v_corte DATE;
    r RECORD;
BEGIN
    IF NOT tiene_permiso_comision('comisiones.aprobar')
       AND NOT tiene_permiso_comision('comisiones.configurar') THEN
        RAISE EXCEPTION 'No tenés permiso para cerrar períodos de comisión';
    END IF;

    SELECT * INTO v_reglas
      FROM comision_reglas
     WHERE esquema_id = esquema_comisiones_vigente(v_mes);

    v_desde := (v_mes + INTERVAL '1 month')::DATE + (COALESCE(v_reglas.dia_cierre, 5) - 1);

    IF NOT p_forzar AND CURRENT_DATE < v_desde THEN
        RAISE EXCEPTION
            'El período % se cierra a partir del %. Hasta entonces hay ventas en período de cortesía esperando su primer pago.',
            TO_CHAR(v_mes, 'MM/YYYY'), TO_CHAR(v_desde, 'DD/MM/YYYY');
    END IF;

    -- Los veredictos de calidad, al día. Un bono congelado con datos de ayer no
    -- se puede corregir después.
    PERFORM evaluar_cohortes(p_vendedor, NULL::DATE);

    v_corte := (v_mes + INTERVAL '1 month')::DATE;

    FOR r IN
        -- Los del período, más los que traen bono pendiente aunque no hayan
        -- vendido este mes.
        SELECT DISTINCT cv.vendedor_id
          FROM comision_ventas cv
         WHERE cv.periodo = v_mes
           AND cv.vendedor_id IS NOT NULL
           AND cv.estado NOT IN ('anulada')
           AND (p_vendedor IS NULL OR cv.vendedor_id = p_vendedor)
        UNION
        SELECT DISTINCT cc.vendedor_id
          FROM comision_cohortes cc
         WHERE cc.estado = 'cerrada'
           AND cc.liquidado_en IS NULL
           AND cc.bono > 0
           AND cc.cierra_el < v_corte
           AND (p_vendedor IS NULL OR cc.vendedor_id = p_vendedor)
    LOOP
        DECLARE
            v_calc RECORD;
            v_ya   comision_periodos%ROWTYPE;
            v_bono NUMERIC := 0;
        BEGIN
            SELECT * INTO v_ya
              FROM comision_periodos
             WHERE vendedor_id = r.vendedor_id AND periodo = v_mes;

            IF v_ya.estado IN ('aprobado', 'pagado') THEN
                -- Ya se autorizó el gasto: no se recalcula. El bono pendiente
                -- queda sin liquidar y lo toma el período siguiente.
                RETURN QUERY SELECT r.vendedor_id, v_ya.ventas_validas, v_ya.monto, v_ya.estado::TEXT;
                CONTINUE;
            END IF;

            SELECT * INTO v_calc FROM comision_de_periodo(r.vendedor_id, v_mes);

            SELECT COALESCE(SUM(cc.bono), 0) INTO v_bono
              FROM comision_cohortes cc
             WHERE cc.vendedor_id = r.vendedor_id
               AND cc.estado = 'cerrada'
               AND cc.liquidado_en IS NULL
               AND cc.bono > 0
               AND cc.cierra_el < v_corte;

            INSERT INTO comision_periodos (
                vendedor_id, periodo, esquema_id, ventas_validas,
                base_total, nivel, porcentaje, monto, bono, estado, cerrado_por, cerrado_en,
                notas
            ) VALUES (
                r.vendedor_id, v_mes, v_calc.esquema_id, v_calc.ventas,
                v_calc.base_total, v_calc.nivel, v_calc.porcentaje, v_calc.monto, v_bono,
                'cerrado', v_legajo, NOW(),
                CASE WHEN p_forzar THEN 'Cierre forzado antes de la fecha' END
            )
            ON CONFLICT (vendedor_id, periodo) DO UPDATE SET
                esquema_id     = EXCLUDED.esquema_id,
                ventas_validas = EXCLUDED.ventas_validas,
                base_total     = EXCLUDED.base_total,
                nivel          = EXCLUDED.nivel,
                porcentaje     = EXCLUDED.porcentaje,
                monto          = EXCLUDED.monto,
                -- Se SUMA, no se pisa: un segundo cierre del mismo mes no puede
                -- borrar un bono que ya se le había asignado, ni contarlo dos
                -- veces — de eso se encarga `liquidado_en`.
                bono           = comision_periodos.bono + EXCLUDED.bono,
                cerrado_por    = EXCLUDED.cerrado_por,
                cerrado_en     = NOW(),
                notas          = EXCLUDED.notas;

            -- Marcadas como liquidadas: la próxima corrida ya no las suma.
            UPDATE comision_cohortes cc
               SET periodo_liquidado = v_mes,
                   liquidado_en = NOW()
             WHERE cc.vendedor_id = r.vendedor_id
               AND cc.estado = 'cerrada'
               AND cc.liquidado_en IS NULL
               AND cc.bono > 0
               AND cc.cierra_el < v_corte;

            UPDATE comision_ventas cvu
               SET estado = 'generada', actualizado_en = NOW()
             WHERE cvu.periodo = v_mes
               AND cvu.vendedor_id = r.vendedor_id
               AND cvu.comisionable_en IS NOT NULL
               AND cvu.estado IN ('proyectada', 'pendiente_validacion');

            RETURN QUERY SELECT r.vendedor_id, v_calc.ventas, v_calc.monto + v_bono, 'cerrado'::TEXT;
        END;
    END LOOP;

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion, entidad, entidad_id, datos
    )
    SELECT u.id, TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))), u.rol,
           'comisiones.cerrar',
           FORMAT('Cerró el período de comisiones %s%s', TO_CHAR(v_mes, 'MM/YYYY'),
                  CASE WHEN p_forzar THEN ' (forzado)' ELSE '' END),
           'comision_periodo', NULL,
           jsonb_build_object('periodo', v_mes, 'vendedor', p_vendedor, 'forzado', p_forzar)
    FROM usuarios_sistema u WHERE u.id = v_legajo;
END $$;

COMMENT ON FUNCTION cerrar_periodo_comisiones IS
    'Congela el período —nivel, porcentaje, base y monto— y le suma los bonos de las cohortes que cerraron. No toca los ya aprobados o pagados.';


-- =============================================================================
-- 8. Lo que van a leer las pantallas
-- =============================================================================
-- Se recrea porque `cv.*` se expande al crear la vista: sin esto, las tres
-- columnas de calidad que agregó esta migración no aparecerían nunca.
DROP VIEW IF EXISTS v_comision_ventas;
CREATE VIEW v_comision_ventas WITH (security_invoker = true) AS
SELECT
    cv.*,
    c.nombre  AS cliente,
    p.nombre  AS prospecto,
    pl.nombre AS plan,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    NULLIF(CONCAT_WS(', ',
        CASE WHEN r.requiere_aprobacion    AND cv.aprobado_en    IS NULL THEN 'aprobación'   END,
        CASE WHEN r.requiere_documentacion AND cv.documentado_en IS NULL THEN 'documentación' END,
        CASE WHEN r.requiere_contrato      AND cv.contrato_en    IS NULL THEN 'contrato'     END,
        CASE WHEN r.requiere_instalacion   AND cv.instalado_en   IS NULL THEN 'instalación'  END,
        CASE WHEN r.requiere_activacion    AND cv.activado_en    IS NULL THEN 'activación'   END,
        CASE WHEN r.requiere_primer_pago   AND cv.primer_pago_en IS NULL THEN 'primer pago'  END,
        CASE WHEN cv.base IS NULL THEN 'base comisionable del plan' END
    ), '') AS le_falta,
    -- Cuántos meses lleva sin pagar HOY. Es lo que convierte la lista en algo
    -- accionable: no "este cliente se perdió", sino "a este le falta uno".
    CASE WHEN cv.cliente_id IS NOT NULL THEN meses_sin_pago(cv.cliente_id) END AS meses_sin_pago
FROM comision_ventas cv
LEFT JOIN clientes c          ON c.id  = cv.cliente_id
LEFT JOIN prospectos p        ON p.id  = cv.prospecto_id
LEFT JOIN planes_velocidad pl ON pl.id = cv.plan_id
LEFT JOIN usuarios_sistema u  ON u.id  = cv.vendedor_id
LEFT JOIN comision_reglas r   ON r.esquema_id = cv.esquema_id;

GRANT SELECT ON v_comision_ventas TO authenticated;


/**
 * Las cohortes con todo lo que hace falta para mostrarlas.
 *
 * Trae el tramo siguiente y cuántos clientes harían falta para alcanzarlo,
 * porque es la mitad del punto 21: "mantené 95 % o más para llegar al bono
 * máximo" solo se puede escribir si alguien calculó ese 95 %.
 */
DROP VIEW IF EXISTS v_comision_cohortes;
CREATE VIEW v_comision_cohortes WITH (security_invoker = true) AS
SELECT
    cc.*,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    e.nombre AS esquema,
    GREATEST(cc.cierra_el - CURRENT_DATE, 0) AS dias_restantes,
    sig.desde_pct AS siguiente_calidad,
    sig.monto     AS siguiente_bono,
    -- Cuántos de los perdidos habría que recuperar para saltar de tramo. Sale de
    -- despejar conservados/(conservados+perdidos) >= objetivo.
    CASE
        WHEN sig.desde_pct IS NULL OR cc.evaluables = 0 THEN NULL
        ELSE GREATEST(
            CEIL(cc.evaluables * sig.desde_pct / 100.0 - cc.conservados)::INT, 0)
    END AS faltan_para_siguiente,
    -- La otra razón por la que el bono puede ser cero, y la que no se arregla
    -- conservando clientes: hacen falta más ventas evaluables. Sin esta columna,
    -- una cohorte con 100 % de calidad y bono cero parece un error del sistema.
    GREATEST(COALESCE(r.min_clientes_cohorte, 0) - cc.evaluables, 0) AS faltan_clientes
FROM comision_cohortes cc
LEFT JOIN usuarios_sistema u  ON u.id = cc.vendedor_id
LEFT JOIN comision_esquemas e ON e.id = cc.esquema_id
LEFT JOIN comision_reglas r   ON r.esquema_id = cc.esquema_id
LEFT JOIN LATERAL (
    SELECT b.desde_pct, b.monto
      FROM comision_bonos_calidad b
     WHERE b.esquema_id = cc.esquema_id
       AND b.monto > cc.bono
     ORDER BY b.desde_pct
     LIMIT 1
) sig ON TRUE;

GRANT SELECT ON v_comision_cohortes TO authenticated;

COMMENT ON VIEW v_comision_cohortes IS
    'Calidad y bono por cohorte, con el tramo siguiente y cuánto falta para alcanzarlo.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Medir todo lo que haya:
--   SELECT * FROM evaluar_cohortes();
--
--   SELECT vendedor, cohorte, evaluables, conservados, perdidos, excluidos,
--          calidad, bono, estado, cierra_el, dias_restantes, detalle
--     FROM v_comision_cohortes ORDER BY cohorte DESC;
--
--   -- El detalle de una cohorte, renglón por renglón:
--   SELECT cliente, calidad_estado, calidad_motivo, meses_sin_pago
--     FROM v_comision_ventas WHERE cohorte = '2026-05-01' ORDER BY calidad_estado;
--
--   -- Una baja que NO le cuenta al vendedor:
--   SELECT dar_de_baja_cliente(
--       '<cliente>',
--       (SELECT id FROM motivos_baja WHERE NOT afecta_calidad LIMIT 1),
--       'Se mudó fuera del área de cobertura');
--
--   -- Y que el bono aparezca en la liquidación del mes en que cerró:
--   SELECT vendedor, periodo, monto, bono, total_a_pagar
--     FROM v_comision_periodos ORDER BY periodo DESC;
