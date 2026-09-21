-- =============================================================================
-- Migración 98 — Comisiones: el motor de cálculo (Fase 2)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué hace y qué NO ──
--
-- Crea el registro de ventas comisionables y el generador que lo mantiene, más
-- las funciones que calculan cuánto le toca a un vendedor en un período.
--
-- NO cierra períodos, NO aprueba, NO paga y NO le muestra nada a nadie: eso es
-- la Fase 3 y la Fase 6. Después de correr esto, el sistema sabe calcular una
-- comisión pero todavía no puede pagarla, que es exactamente el orden en que
-- conviene construirlo.
--
-- ── Las dos capas, y por qué están separadas ──
--
--   El HECHO       `comision_ventas` y `generar_comisiones()`. Recorre los
--                  prospectos ganados y anota qué hitos alcanzó cada venta:
--                  aprobada, instalada, activada, con primer pago. Escribe
--                  fechas, no opiniones. Es idempotente: correrlo mil veces da
--                  lo mismo que correrlo una.
--
--   El CÁLCULO     `comision_de_periodo()`. Cuenta las ventas válidas del mes,
--                  busca el nivel y aplica el porcentaje. No guarda nada: se
--                  responde cada vez que se pregunta.
--
-- Están separadas porque una es reversible y la otra no. Los hitos se pueden
-- recalcular siempre; el cierre de un período —Fase 3— congela el resultado y no
-- se vuelve a tocar.
--
-- ── Lo que este motor NO hace a propósito ──
--
-- No genera comisión porque alguien marcó un prospecto como "ganado". Eso es lo
-- que el punto 8 del requerimiento prohíbe explícitamente, y es la razón de que
-- exista toda esta maquinaria en vez de un `SELECT COUNT(*) WHERE estado =
-- 'ganado'`.
-- =============================================================================


-- =============================================================================
-- 1. De qué tipo es la operación
-- =============================================================================
-- Una reactivación NO es una venta nueva (punto 14). Hoy no había forma de
-- distinguirlas: un cliente que vuelve y uno que llega por primera vez se ven
-- igual desde `prospectos`.
--
-- El valor por defecto es 'nueva' porque es lo que son todos los prospectos
-- cargados hasta hoy. Marcar una reactivación es una acción explícita.
ALTER TABLE prospectos
    ADD COLUMN IF NOT EXISTS tipo_operacion VARCHAR(14) NOT NULL DEFAULT 'nueva';

ALTER TABLE prospectos DROP CONSTRAINT IF EXISTS prospectos_tipo_operacion_check;
ALTER TABLE prospectos ADD CONSTRAINT prospectos_tipo_operacion_check
    CHECK (tipo_operacion IN ('nueva', 'reactivacion'));


-- =============================================================================
-- 2. El registro de ventas comisionables
-- =============================================================================
/**
 * Una fila por venta que puede generar comisión.
 *
 * ── Por qué guarda la base y el esquema, en vez de mirarlos cada vez ──
 *
 * Porque una comisión pagada tiene que poder explicarse dentro de dos años.
 * Si la base se leyera de `comision_bases_plan` en el momento de la consulta,
 * subir el precio del plan de 500 megas en noviembre cambiaría lo que dice
 * agosto — y el vendedor tendría razón en desconfiar del sistema.
 *
 * Se congelan cuando la venta se vuelve comisionable, no antes: hasta entonces
 * todavía puede cambiar de plan.
 */
CREATE TABLE IF NOT EXISTS comision_ventas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- De dónde salió. El prospecto es el origen comercial; el cliente es lo que
    -- terminó siendo. Los dos hacen falta: el primero para el embudo, el
    -- segundo para no pagar dos veces por la misma persona.
    prospecto_id UUID REFERENCES prospectos(id) ON DELETE SET NULL,
    cliente_id   UUID REFERENCES clientes(id)   ON DELETE SET NULL,
    vendedor_id  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    -- El plan con el que quedó ACTIVADO, no el cotizado. Es el que genera
    -- ingreso real, y entre la cotización y la instalación se cambia seguido.
    plan_id UUID REFERENCES planes_velocidad(id) ON DELETE SET NULL,

    tipo_operacion VARCHAR(14) NOT NULL DEFAULT 'nueva',

    -- ── Lo congelado ──
    esquema_id UUID REFERENCES comision_esquemas(id) ON DELETE SET NULL,
    base       NUMERIC(12,2),

    -- A qué mes pertenece. Es el mes en que la venta se volvió comisionable, no
    -- el que se cargó el prospecto: una venta de julio que se instaló en agosto
    -- se paga con agosto.
    periodo DATE,
    -- La cohorte de calidad arranca igual al período y no se mueve aunque el
    -- período se recalcule: el punto 16 pide no mezclar clientes de meses
    -- distintos.
    cohorte DATE,

    -- ── Los hitos. Fechas, no banderas ──
    --
    -- Una bandera dice "sí"; una fecha dice "sí, el 27 de agosto", que es lo
    -- que permite decidir si entró en la ventana de cortesía y reconstruir
    -- después por qué se pagó lo que se pagó.
    ganado_en       TIMESTAMPTZ,
    aprobado_en     TIMESTAMPTZ,
    documentado_en  TIMESTAMPTZ,
    contrato_en     TIMESTAMPTZ,
    instalado_en    TIMESTAMPTZ,
    activado_en     TIMESTAMPTZ,
    primer_pago_en  TIMESTAMPTZ,

    -- Cuándo quedaron cumplidos TODOS los requisitos que exigía su esquema.
    comisionable_en TIMESTAMPTZ,
    -- Hasta cuándo se le espera el primer pago, con la cortesía aplicada.
    espera_pago_hasta DATE,

    estado VARCHAR(22) NOT NULL DEFAULT 'proyectada',

    -- ── La anulación ──
    -- El punto 11: una comisión aprobada no se reduce sola porque el cliente se
    -- dio de baja. Se anula por fraude, duplicidad o error, con motivo escrito.
    motivo_anulacion TEXT,
    anulada_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    anulada_en  TIMESTAMPTZ,

    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT comision_ventas_estado_check CHECK (estado IN (
        'proyectada',           -- le faltan requisitos, o el período sigue abierto
        'pendiente_validacion', -- cumple todo menos el primer pago, en cortesía
        'generada',             -- el período cerró y quedó contada
        'aprobada',
        'pagada',
        'anulada'
    )),
    CONSTRAINT comision_ventas_tipo_check CHECK (tipo_operacion IN ('nueva', 'reactivacion')),
    -- Anular sin decir por qué es exactamente la modificación silenciosa que el
    -- punto 26 prohíbe.
    CONSTRAINT comision_ventas_anulacion_check
        CHECK (estado <> 'anulada' OR motivo_anulacion IS NOT NULL)
);

ALTER TABLE comision_ventas ENABLE ROW LEVEL SECURITY;

/**
 * Un abonado genera UNA sola comisión de venta nueva. Para siempre.
 *
 * Esta es la barrera que de verdad impide pagar dos veces lo mismo, y está en
 * la base y no en el código a propósito: un índice no se olvida de correr, no
 * tiene una rama que no se probó y no se saltea desde la consola.
 *
 * Se excluyen las anuladas para poder rehacer una venta que se anuló por error.
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_comision_ventas_cliente
    ON comision_ventas (cliente_id)
    WHERE cliente_id IS NOT NULL AND estado <> 'anulada';

-- Y un prospecto tampoco genera dos. Cubre el caso de dos vendedores que
-- cargaron a la misma persona: son dos prospectos, un solo cliente, y el índice
-- de arriba deja pasar el primero que llegue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comision_ventas_prospecto
    ON comision_ventas (prospecto_id)
    WHERE prospecto_id IS NOT NULL AND estado <> 'anulada';

CREATE INDEX IF NOT EXISTS idx_comision_ventas_periodo
    ON comision_ventas (vendedor_id, periodo) WHERE estado <> 'anulada';


-- =============================================================================
-- 3. Quién ve las comisiones de quién
-- =============================================================================
CREATE OR REPLACE FUNCTION ve_comisiones_de_todos()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'comisiones.ver_todas'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        TRUE
    )
$$;

COMMENT ON FUNCTION ve_comisiones_de_todos IS
    'TRUE si quien pregunta puede ver las comisiones de todo el equipo. El vendedor ve solo las suyas.';

-- Leer: lo propio, o todo con permiso. La comisión de un compañero es
-- información salarial de otra persona.
DROP POLICY IF EXISTS comision_ventas_lectura ON comision_ventas;
CREATE POLICY comision_ventas_lectura ON comision_ventas
    FOR SELECT TO authenticated
    USING (ve_comisiones_de_todos() OR vendedor_id = mi_legajo_id());

-- Escribir directo: NADIE, ni siquiera el Super Admin.
--
-- No es desconfianza: es que una fila escrita a mano no tendría la base
-- congelada, ni el esquema, ni los hitos, y el período la contaría igual. Todo
-- pasa por las funciones, que sí dejan el registro completo y auditable.
DROP POLICY IF EXISTS comision_ventas_escritura ON comision_ventas;
CREATE POLICY comision_ventas_escritura ON comision_ventas
    FOR ALL TO authenticated
    USING (false) WITH CHECK (false);


-- =============================================================================
-- 4. El generador de hitos
-- =============================================================================
/**
 * Recorre las ventas y anota hasta dónde llegó cada una.
 *
 * ── Qué NO toca ──
 *
 * Las filas en `aprobada`, `pagada` o `anulada`. El punto 11 es explícito: una
 * comisión ya cerrada no se reduce automáticamente porque el cliente después
 * deje de pagar. Si este generador las recalculara, una baja en noviembre
 * cambiaría un pago hecho en septiembre — en silencio y sin que nadie lo pida.
 *
 * ── Por qué es un MERGE por cliente y no un INSERT ──
 *
 * Porque va a correr todos los días desde el crontab. Un INSERT crearía una fila
 * nueva en cada corrida; el `ON CONFLICT` sobre el índice único del cliente hace
 * que la segunda corrida actualice la primera.
 *
 * @param p_cliente  opcional, para recalcular una sola venta.
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

            -- ── Instalación ──
            -- El alta cerrada del abonado. Un traslado o una reparación no
            -- cuentan: la venta se instaló una sola vez.
            (SELECT MIN(COALESCE(i.alta_at, i.fecha::TIMESTAMPTZ))
               FROM instalaciones i
              WHERE i.client_id = p.cliente_id
                AND i.tipo = 'nueva'
                AND i.estado = 'hecha')            AS instalado_en,

            -- ── Activación ──
            -- `activado_en` si está; si no, la fecha de instalación del servicio.
            -- Un cliente dado de baja no se considera activado: la venta no
            -- llegó a sostenerse.
            CASE WHEN c.estado <> 'baja'
                 THEN COALESCE(c.activado_en, c.fecha_instalacion::TIMESTAMPTZ)
            END                                     AS activado_en,

            -- ── Documentación ──
            -- Del expediente, y solo si están las cuatro piezas. `completo` no
            -- sirve acá porque incluye contrato y firma, que son requisitos
            -- aparte y con su propio interruptor.
            (SELECT e.actualizado_en FROM v_expedientes e
              WHERE e.prospecto_id = p.id
                AND e.ok_datos AND e.ok_cedula_frontal
                AND e.ok_cedula_posterior AND e.ok_fotos AND e.ok_ubicacion
              LIMIT 1)                              AS documentado_en,

            -- ── Contrato firmado ──
            (SELECT MIN(ct.fecha_inicio::TIMESTAMPTZ) FROM contratos ct
              WHERE ct.client_id = p.cliente_id
                AND ct.firma_estado = 'firmado')     AS contrato_en,

            -- ── Primer pago ──
            -- El primero que entró y no está anulado. Un pago anulado no es un
            -- pago: si contara, anular y volver a cobrar movería la comisión.
            (SELECT MIN(pg.fecha_pago::TIMESTAMPTZ) FROM pagos pg
              WHERE pg.client_id = p.cliente_id
                AND NOT pg.anulado)                  AS primer_pago_en,

            -- ── Aprobación de admisión ──
            -- La Fase 3 la va a llenar. Hoy no existe la tabla, así que queda
            -- NULL y su interruptor está apagado.
            NULL::TIMESTAMPTZ                        AS aprobado_en
        FROM prospectos p
        JOIN clientes c ON c.id = p.cliente_id
        WHERE p.estado = 'ganado'
          AND p.cliente_id IS NOT NULL
          -- Una reactivación no es una venta nueva.
          AND p.tipo_operacion = 'nueva'
          AND (p_cliente IS NULL OR p.cliente_id = p_cliente)
    LOOP
        /**
         * ¿Ya existe, y en qué estado? Las cerradas no se tocan.
         *
         * ── Por qué las ANULADAS también se saltean ──
         *
         * La primera versión buscaba `estado <> 'anulada'`, para poder rehacer
         * una venta anulada por error. El efecto real era el opuesto: como el
         * índice único excluye las anuladas, el generador no la encontraba, la
         * daba por inexistente y le creaba una fila nueva. Es decir que anular
         * por fraude duraba hasta la próxima corrida del crontab.
         *
         * Una anulación es una decisión administrativa con motivo escrito. Que
         * una tarea automática la deshaga en silencio es exactamente lo que el
         * punto 26 prohíbe. Rehacerla tiene que ser un acto explícito de alguien
         * con permiso, no un efecto secundario de la noche.
         */
        SELECT id, estado INTO v_existe, v_estado
          FROM comision_ventas
         WHERE cliente_id = r.cliente_id
         -- Si hubiera una viva y una anulada vieja, manda la viva.
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
            -- El esquema que regía cuando se ganó la venta. No el de hoy: una
            -- venta de agosto se paga con las reglas de agosto.
            v_fecha_ref := COALESCE(r.ganado_en::DATE, CURRENT_DATE);
            v_esquema := esquema_comisiones_vigente(v_fecha_ref);

            IF v_esquema IS NULL THEN
                CONTINUE;  -- sin esquema vigente no hay nada que calcular
            END IF;

            SELECT * INTO v_reglas FROM comision_reglas WHERE esquema_id = v_esquema;

            SELECT b.base INTO v_base
              FROM comision_bases_plan b
             WHERE b.esquema_id = v_esquema
               AND b.plan_id = r.plan_activado
               AND b.comisiona;

            -- ── ¿Cumple todos los requisitos que exige SU esquema? ──
            --
            -- Se evalúa requisito por requisito con su interruptor. Apagado
            -- significa "no hace falta", no "se da por cumplido": la diferencia
            -- importa cuando se enciende después.
            v_comisionable := NULL;
            IF  (NOT v_reglas.requiere_aprobacion    OR r.aprobado_en    IS NOT NULL)
            AND (NOT v_reglas.requiere_documentacion OR r.documentado_en IS NOT NULL)
            AND (NOT v_reglas.requiere_contrato      OR r.contrato_en    IS NOT NULL)
            AND (NOT v_reglas.requiere_instalacion   OR r.instalado_en   IS NOT NULL)
            AND (NOT v_reglas.requiere_activacion    OR r.activado_en    IS NOT NULL)
            AND (NOT v_reglas.requiere_primer_pago   OR r.primer_pago_en IS NOT NULL)
            AND v_base IS NOT NULL
            THEN
                -- Se vuelve comisionable cuando se cumplió el ÚLTIMO requisito,
                -- no cuando se cumplió el primero.
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

            -- ── La cortesía del prepago ──
            --
            -- Instalado del día de cortesía en adelante, el primer pago se
            -- espera recién en la ventana del mes siguiente. Sin esto una
            -- instalación del 27 parecería una mala venta cuatro días después.
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

            -- ── El estado ──
            v_nuevo_estado := 'proyectada';
            IF v_comisionable IS NULL
               AND v_reglas.requiere_primer_pago
               AND r.primer_pago_en IS NULL
               AND r.instalado_en IS NOT NULL
               AND r.activado_en IS NOT NULL
               AND v_espera >= CURRENT_DATE
            THEN
                -- Cumple todo menos el pago, y todavía está en su ventana.
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
                DATE_TRUNC('month', COALESCE(v_comisionable, NOW()))::DATE,
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
                -- El período se mueve mientras la venta no esté cerrada; la
                -- cohorte NO: una vez que un cliente entró en el grupo de
                -- agosto, ahí se queda aunque su comisión se recalcule.
                periodo        = EXCLUDED.periodo,
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
                -- Una venta ya contada en un cierre no vuelve a 'proyectada'.
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

COMMENT ON FUNCTION generar_comisiones IS
    'Recorre los prospectos ganados y actualiza qué hitos alcanzó cada venta. Idempotente. No toca comisiones aprobadas ni pagadas.';


-- =============================================================================
-- 5. Cuánto le toca a un vendedor
-- =============================================================================
/**
 * El nivel que corresponde a una cantidad de ventas.
 */
CREATE OR REPLACE FUNCTION nivel_comision(p_esquema UUID, p_ventas INT)
RETURNS comision_niveles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT * FROM comision_niveles
     WHERE esquema_id = p_esquema
       AND p_ventas >= desde_ventas
       AND (hasta_ventas IS NULL OR p_ventas <= hasta_ventas)
     ORDER BY desde_ventas DESC
     LIMIT 1
$$;


/**
 * La comisión de un vendedor en un período.
 *
 * ── Los dos modos ──
 *
 *   retroactivo  el porcentaje del nivel alcanzado se aplica a TODA la base del
 *                período. 26 ventas al 45 % pagan el 45 % sobre las 26.
 *
 *   progresivo   cada venta cobra el porcentaje del tramo en el que cae según su
 *                orden. Las primeras 10 al 20 %, las siguientes 5 al 30 %, etc.
 *
 * En progresivo las ventas se ordenan por cuándo se volvieron comisionables. No
 * por monto: ordenarlas por base pondría las caras en los tramos altos y
 * cambiaría el total según cómo se mire la misma lista.
 *
 * No guarda nada. El resultado se congela recién al cerrar el período, en la
 * Fase 3.
 */
CREATE OR REPLACE FUNCTION comision_de_periodo(p_vendedor UUID, p_periodo DATE)
RETURNS TABLE (
    ventas INT,
    base_total NUMERIC,
    nivel TEXT,
    porcentaje NUMERIC,
    monto NUMERIC,
    esquema_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_esquema UUID;
    v_modo TEXT;
    v_ventas INT;
    v_base NUMERIC := 0;
    v_nivel comision_niveles%ROWTYPE;
    v_monto NUMERIC := 0;
    v_mes DATE := DATE_TRUNC('month', p_periodo)::DATE;
BEGIN
    /**
     * De quién es esta plata.
     *
     * La función es SECURITY DEFINER —tiene que serlo para poder leer la
     * configuración— y eso significa que corre saltándose RLS. Sin esta
     * verificación, un vendedor podía llamarla con el id de un compañero desde
     * la consola del navegador y ver cuánto cobra.
     *
     * La vista que la usa filtra por RLS y nunca llega acá con un vendedor
     * ajeno; el agujero era la llamada directa.
     */
    IF NOT ve_comisiones_de_todos() AND p_vendedor IS DISTINCT FROM mi_legajo_id() THEN
        RAISE EXCEPTION 'No podés ver la comisión de otro vendedor';
    END IF;

    -- Todas las ventas del período comparten esquema: lo fija la fecha en que
    -- se ganaron, y un período es un mes. Si por un cambio de versión a mitad
    -- de mes hubiera dos, gana el de la mayoría — y el cierre de la Fase 3 deja
    -- constancia de cuál se usó.
    SELECT cv.esquema_id INTO v_esquema
      FROM comision_ventas cv
     WHERE cv.vendedor_id = p_vendedor
       AND cv.periodo = v_mes
       AND cv.comisionable_en IS NOT NULL
       AND cv.estado NOT IN ('anulada')
     GROUP BY cv.esquema_id
     ORDER BY COUNT(*) DESC
     LIMIT 1;

    IF v_esquema IS NULL THEN
        RETURN QUERY SELECT 0, 0::NUMERIC, NULL::TEXT, 0::NUMERIC, 0::NUMERIC, NULL::UUID;
        RETURN;
    END IF;

    SELECT e.modo INTO v_modo FROM comision_esquemas e WHERE e.id = v_esquema;

    SELECT COUNT(*), COALESCE(SUM(cv.base), 0) INTO v_ventas, v_base
      FROM comision_ventas cv
     WHERE cv.vendedor_id = p_vendedor
       AND cv.periodo = v_mes
       AND cv.comisionable_en IS NOT NULL
       AND cv.estado NOT IN ('anulada');

    IF v_ventas = 0 THEN
        RETURN QUERY SELECT 0, 0::NUMERIC, NULL::TEXT, 0::NUMERIC, 0::NUMERIC, v_esquema;
        RETURN;
    END IF;

    v_nivel := nivel_comision(v_esquema, v_ventas);

    IF v_modo = 'progresivo' THEN
        SELECT COALESCE(SUM(x.base * n.porcentaje / 100.0), 0) INTO v_monto
          FROM (
              SELECT cv.base,
                     ROW_NUMBER() OVER (ORDER BY cv.comisionable_en, cv.id) AS pos
                FROM comision_ventas cv
               WHERE cv.vendedor_id = p_vendedor
                 AND cv.periodo = v_mes
                 AND cv.comisionable_en IS NOT NULL
                 AND cv.estado NOT IN ('anulada')
          ) x
          JOIN comision_niveles n
            ON n.esquema_id = v_esquema
           AND x.pos >= n.desde_ventas
           AND (n.hasta_ventas IS NULL OR x.pos <= n.hasta_ventas);
    ELSE
        v_monto := v_base * COALESCE(v_nivel.porcentaje, 0) / 100.0;
    END IF;

    RETURN QUERY SELECT
        v_ventas,
        v_base,
        v_nivel.nombre::TEXT,
        COALESCE(v_nivel.porcentaje, 0),
        ROUND(v_monto, 2),
        v_esquema;
END $$;

COMMENT ON FUNCTION comision_de_periodo IS
    'Cuánto le toca a un vendedor en un mes, con el modo del esquema. No guarda nada: el resultado se congela al cerrar el período.';


-- =============================================================================
-- 6. Lo que van a leer las pantallas
-- =============================================================================
-- Las ventas con el nombre de todo al lado. `security_invoker` para que el
-- vendedor vea solo las suyas: la política de la tabla ya lo resuelve y la vista
-- tiene que respetarla.
DROP VIEW IF EXISTS v_comision_ventas;
CREATE VIEW v_comision_ventas WITH (security_invoker = true) AS
SELECT
    cv.*,
    c.nombre  AS cliente,
    p.nombre  AS prospecto,
    pl.nombre AS plan,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    -- Qué le falta para comisionar. Es la columna que evita la pregunta
    -- "¿por qué esta venta no me cuenta?".
    NULLIF(CONCAT_WS(', ',
        CASE WHEN r.requiere_aprobacion    AND cv.aprobado_en    IS NULL THEN 'aprobación'   END,
        CASE WHEN r.requiere_documentacion AND cv.documentado_en IS NULL THEN 'documentación' END,
        CASE WHEN r.requiere_contrato      AND cv.contrato_en    IS NULL THEN 'contrato'     END,
        CASE WHEN r.requiere_instalacion   AND cv.instalado_en   IS NULL THEN 'instalación'  END,
        CASE WHEN r.requiere_activacion    AND cv.activado_en    IS NULL THEN 'activación'   END,
        CASE WHEN r.requiere_primer_pago   AND cv.primer_pago_en IS NULL THEN 'primer pago'  END,
        CASE WHEN cv.base IS NULL THEN 'base comisionable del plan' END
    ), '') AS le_falta
FROM comision_ventas cv
LEFT JOIN clientes c          ON c.id  = cv.cliente_id
LEFT JOIN prospectos p        ON p.id  = cv.prospecto_id
LEFT JOIN planes_velocidad pl ON pl.id = cv.plan_id
LEFT JOIN usuarios_sistema u  ON u.id  = cv.vendedor_id
LEFT JOIN comision_reglas r   ON r.esquema_id = cv.esquema_id;

GRANT SELECT ON v_comision_ventas TO authenticated;


-- El resumen por vendedor y mes, con la comisión ya calculada. Es lo que
-- alimenta el tablero del vendedor y la comparación del Super Admin.
/**
 * Esta va con `CREATE OR REPLACE` y no con `DROP` + `CREATE`, a diferencia de la
 * de arriba.
 *
 * ── Por qué la diferencia ──
 *
 * Porque de esta cuelga otra: la migración 102 hace que el tablero comercial lea
 * la comisión de acá. Con `DROP`, volver a correr esta migración —algo que su
 * propia cabecera promete que se puede hacer— fallaría con "cannot drop view
 * because other objects depend on it", y como el editor de Supabase corre el
 * archivo entero en una transacción, se caería la migración completa.
 *
 * `CREATE OR REPLACE` reemplaza la definición sin tocar a quien depende de ella.
 * Solo funciona si las columnas son las mismas, que es exactamente el caso al
 * reejecutar el mismo archivo.
 *
 * La de arriba (`v_comision_ventas`) sigue con DROP porque la 100 le agrega
 * columnas, y `CREATE OR REPLACE` no puede quitar columnas: ahí el DROP es lo
 * único que funciona, y no hay nadie colgado de ella.
 */
CREATE OR REPLACE VIEW v_comision_resumen WITH (security_invoker = true) AS
SELECT
    g.vendedor_id,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    g.periodo,
    g.ventas_validas,
    g.pendientes,
    g.ventas_totales,
    -- El conteo y el monto salen del MISMO lugar: la función. Antes la vista
    -- sumaba las bases por su cuenta y además llamaba a la función, así que
    -- había dos columnas `base_total` —la vista no compilaba— y, peor, dos
    -- respuestas posibles a la misma pregunta.
    c.base_total,
    c.nivel,
    c.porcentaje,
    c.monto,
    c.esquema_id
FROM (
    SELECT
        cv.vendedor_id,
        cv.periodo,
        COUNT(*) FILTER (WHERE cv.comisionable_en IS NOT NULL) AS ventas_validas,
        COUNT(*) FILTER (WHERE cv.comisionable_en IS NULL
                           AND cv.estado = 'pendiente_validacion') AS pendientes,
        COUNT(*) AS ventas_totales
    FROM comision_ventas cv
    WHERE cv.estado <> 'anulada'
    GROUP BY cv.vendedor_id, cv.periodo
) g
LEFT JOIN usuarios_sistema u ON u.id = g.vendedor_id
-- LATERAL: una sola llamada por vendedor y mes. Con `(f(x)).*` en el SELECT,
-- Postgres la ejecuta una vez por cada columna que se expande.
LEFT JOIN LATERAL comision_de_periodo(g.vendedor_id, g.periodo) c ON TRUE;

GRANT SELECT ON v_comision_resumen TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT * FROM generar_comisiones();
--
--   SELECT vendedor, cliente, plan, base, estado, le_falta
--     FROM v_comision_ventas ORDER BY periodo DESC;
--
--   SELECT vendedor, periodo, ventas_validas, base_total, nivel, porcentaje, monto
--     FROM v_comision_resumen ORDER BY periodo DESC;
--
-- Y que una venta no pueda contarse dos veces:
--   INSERT INTO comision_ventas (cliente_id) VALUES ('<uno que ya esté>');
--   -- ERROR: duplicate key value violates unique constraint
