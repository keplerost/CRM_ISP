-- =============================================================================
-- Migración 99 — Comisiones: validación y cierre mensual (Fase 3)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Las tres cosas que trae ──
--
--   1. La ADMISIÓN de una solicitud, con el motivo interno separado del que ve
--      el vendedor.
--   2. El CIERRE del período: congela nivel, porcentaje y monto para que un
--      cambio posterior no reescriba lo que se pagó.
--   3. Aprobar, pagar y anular, cada uno con su permiso y su registro.
--
-- Después de esto el sistema ya puede pagar una comisión. Lo que todavía no
-- tiene es pantalla: eso es la Fase 6.
--
-- ── Por qué el cierre no es el último día del mes ──
--
-- Por el prepago. Una instalación del 27 tiene cortesía hasta el 5 del mes
-- siguiente, así que cerrar el 31 la contaría como venta fallida cuatro días
-- después de hecha. El cierre corre el día configurado del mes siguiente, y por
-- eso hace falta que sea una tarea aparte y no un disparador.
-- =============================================================================


-- =============================================================================
-- 1. Quién puede qué
-- =============================================================================
-- Cada una por separado: aprobar un gasto y ejecutarlo no deberían ser la misma
-- persona, aunque hoy lo sean. Tenerlos separados desde el principio permite
-- delegar uno sin el otro el día que haga falta, sin migrar nada.
CREATE OR REPLACE FUNCTION tiene_permiso_comision(p_clave TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? p_clave
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        TRUE
    )
$$;

COMMENT ON FUNCTION tiene_permiso_comision IS
    'Si quien pregunta tiene una clave de permiso. Igual que el resto del sistema: sin legajo no se bloquea, para no dejar inutilizable una instalación a medio migrar.';


-- =============================================================================
-- 2. La admisión de una solicitud
-- =============================================================================
/**
 * Si la solicitud de un prospecto se aprueba, y por qué.
 *
 * ── Por qué el motivo va partido en dos ──
 *
 * El punto 7 es explícito: el vendedor NO debe ver la información sensible que
 * se usó para decidir. Pero sí necesita saber qué hacer — no es lo mismo "no
 * aprobado" que "falta la copia de la cédula".
 *
 * `motivo_publico` es lo que se le dice al vendedor. `motivo_interno` es por qué
 * se decidió de verdad, y vive detrás de su propio permiso.
 *
 * Están en la misma fila y no en dos tablas porque son una sola decisión: dos
 * tablas se desincronizan, y la que se desincroniza siempre es la que nadie
 * mira.
 */
CREATE TABLE IF NOT EXISTS solicitudes_validacion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Una validación vigente por prospecto. El historial de cambios queda en
    -- `auditoria_sistema`, que es donde ya vive todo lo demás.
    prospecto_id UUID NOT NULL UNIQUE REFERENCES prospectos(id) ON DELETE CASCADE,

    estado VARCHAR(16) NOT NULL DEFAULT 'pendiente',

    motivo_publico TEXT,
    motivo_interno TEXT,

    validado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    validado_en  TIMESTAMPTZ,

    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT solicitudes_validacion_estado_check CHECK (estado IN (
        'pendiente',        -- entró y nadie la miró
        'revision_manual',  -- alguien la miró y necesita otra opinión
        'requiere_info',    -- falta algo del vendedor
        'aprobado',
        'rechazado'
    )),
    -- Rechazar sin decirle nada al vendedor lo deja llamando a la oficina para
    -- preguntar qué pasó. El motivo público es obligatorio cuando la respuesta
    -- es negativa.
    CONSTRAINT solicitudes_validacion_motivo_check
        CHECK (estado NOT IN ('rechazado', 'requiere_info') OR motivo_publico IS NOT NULL)
);

ALTER TABLE solicitudes_validacion ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_solicitudes_validacion_estado
    ON solicitudes_validacion (estado, creado_en);

/**
 * La tabla cruda la lee SOLO quien puede ver la validación sensible.
 *
 * Es la única forma de proteger `motivo_interno`: RLS filtra filas, no columnas.
 * El vendedor entra por la vista de abajo, que no la trae.
 */
DROP POLICY IF EXISTS solicitudes_validacion_lectura ON solicitudes_validacion;
CREATE POLICY solicitudes_validacion_lectura ON solicitudes_validacion
    FOR SELECT TO authenticated
    USING (tiene_permiso_comision('ventas.validacion_sensible'));

DROP POLICY IF EXISTS solicitudes_validacion_escritura ON solicitudes_validacion;
CREATE POLICY solicitudes_validacion_escritura ON solicitudes_validacion
    FOR ALL TO authenticated
    USING (false) WITH CHECK (false);


/**
 * Lo que puede ver el vendedor: el estado y qué hacer, nada más.
 *
 * SIN `security_invoker` a propósito. Con él, la vista heredaría la política de
 * arriba y le devolvería vacío justamente a quien tiene que usarla. El filtro
 * está en el WHERE: cada uno ve las validaciones de sus propios prospectos, y
 * quien tiene el permiso las ve todas.
 */
DROP VIEW IF EXISTS v_validaciones;
CREATE VIEW v_validaciones AS
SELECT
    sv.id,
    sv.prospecto_id,
    p.nombre       AS prospecto,
    p.vendedor_id,
    sv.estado,
    -- Lo que se le muestra al vendedor, en su idioma. El estado interno
    -- `revision_manual` no le dice nada útil: para él sigue en revisión.
    CASE sv.estado
        WHEN 'pendiente'       THEN 'En revisión'
        WHEN 'revision_manual' THEN 'En revisión'
        WHEN 'requiere_info'   THEN 'Requiere información adicional'
        WHEN 'aprobado'        THEN 'Aprobado'
        WHEN 'rechazado'       THEN 'No aprobado'
    END            AS estado_visible,
    sv.motivo_publico,
    sv.validado_en,
    sv.creado_en
FROM solicitudes_validacion sv
JOIN prospectos p ON p.id = sv.prospecto_id
WHERE tiene_permiso_comision('ventas.validacion_sensible')
   OR tiene_permiso_comision('comisiones.ver_todas')
   OR p.vendedor_id = mi_legajo_id();

GRANT SELECT ON v_validaciones TO authenticated;

COMMENT ON VIEW v_validaciones IS
    'Estado de admisión de una solicitud, sin el motivo interno. El vendedor ve las de sus prospectos; quien valida, todas.';


/**
 * Decide una solicitud.
 *
 * Pasa por función y no por UPDATE directo porque hay tres cosas que tienen que
 * ocurrir juntas: la decisión, el registro de quién la tomó, y el recálculo de
 * la comisión que depende de ella. Sueltas, la tercera se olvida.
 */
CREATE OR REPLACE FUNCTION validar_solicitud(
    p_prospecto UUID,
    p_estado    TEXT,
    p_publico   TEXT DEFAULT NULL,
    p_interno   TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_legajo UUID := mi_legajo_id();
    v_antes  solicitudes_validacion%ROWTYPE;
    v_id     UUID;
    v_cliente UUID;
BEGIN
    IF NOT tiene_permiso_comision('ventas.validar') THEN
        RAISE EXCEPTION 'No tenés permiso para validar solicitudes';
    END IF;

    IF p_estado IN ('rechazado', 'requiere_info') AND COALESCE(BTRIM(p_publico), '') = '' THEN
        RAISE EXCEPTION 'Hace falta un motivo para el vendedor: sin eso queda llamando a la oficina para preguntar qué pasó';
    END IF;

    SELECT * INTO v_antes FROM solicitudes_validacion WHERE prospecto_id = p_prospecto;

    INSERT INTO solicitudes_validacion (
        prospecto_id, estado, motivo_publico, motivo_interno, validado_por, validado_en
    ) VALUES (
        p_prospecto, p_estado, p_publico, p_interno, v_legajo,
        CASE WHEN p_estado = 'pendiente' THEN NULL ELSE NOW() END
    )
    ON CONFLICT (prospecto_id) DO UPDATE SET
        estado         = EXCLUDED.estado,
        motivo_publico = EXCLUDED.motivo_publico,
        motivo_interno = EXCLUDED.motivo_interno,
        validado_por   = EXCLUDED.validado_por,
        validado_en    = EXCLUDED.validado_en,
        actualizado_en = NOW()
    RETURNING id INTO v_id;

    -- Quién validó qué y con qué motivo. El punto 26 pide registrar
    -- explícitamente las validaciones sensibles.
    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion,
        entidad, entidad_id, datos
    )
    SELECT
        u.id, TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))), u.rol,
        'ventas.validar',
        FORMAT('Validó la solicitud como %s', p_estado),
        'solicitud', p_prospecto,
        jsonb_build_object(
            'antes', to_jsonb(v_antes),
            'estado', p_estado,
            'motivo_publico', p_publico,
            'motivo_interno', p_interno
        )
    FROM usuarios_sistema u WHERE u.id = v_legajo;

    -- La comisión de ese cliente depende de esto. Se recalcula acá para que la
    -- aprobación se refleje sin esperar a la corrida de la noche.
    SELECT cliente_id INTO v_cliente FROM prospectos WHERE id = p_prospecto;
    IF v_cliente IS NOT NULL THEN
        PERFORM generar_comisiones(v_cliente);
    END IF;

    RETURN v_id;
END $$;

COMMENT ON FUNCTION validar_solicitud IS
    'Aprueba, rechaza o devuelve una solicitud. Registra quién decidió y recalcula la comisión que dependía de ella.';


-- =============================================================================
-- 3. El generador aprende a leer la aprobación
-- =============================================================================
-- La 98 dejaba `aprobado_en` en NULL con un comentario que decía "la Fase 3 la
-- va a llenar". Es esta. Se reemplaza esa línea por la lectura real.
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

            -- Acá está la diferencia con la 98: la aprobación de admisión sale
            -- de la validación, no de un NULL.
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
-- 4. El período cerrado
-- =============================================================================
/**
 * Lo que se le pagó a un vendedor en un mes, congelado.
 *
 * Esta tabla es la respuesta a "¿por qué me pagaron esto en agosto?" dos años
 * después. Guarda el resultado Y las reglas con las que salió: nivel,
 * porcentaje, base total y la versión del esquema. Sin esa foto, reabrir agosto
 * en 2028 mostraría los números de 2028.
 */
CREATE TABLE IF NOT EXISTS comision_periodos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    vendedor_id UUID NOT NULL REFERENCES usuarios_sistema(id) ON DELETE CASCADE,
    periodo     DATE NOT NULL,

    esquema_id  UUID REFERENCES comision_esquemas(id) ON DELETE SET NULL,

    ventas_validas INT NOT NULL DEFAULT 0,
    base_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
    nivel       VARCHAR(30),
    porcentaje  NUMERIC(5,2) NOT NULL DEFAULT 0,
    monto       NUMERIC(12,2) NOT NULL DEFAULT 0,

    -- La Fase 4 lo completa. Va acá y no en otra tabla porque lo que se le paga
    -- a alguien en un mes es una sola cifra, y partirla en dos lugares es cómo
    -- se termina pagando una y olvidando la otra.
    bono        NUMERIC(12,2) NOT NULL DEFAULT 0,

    estado VARCHAR(10) NOT NULL DEFAULT 'cerrado',

    cerrado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    cerrado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    aprobado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    aprobado_en  TIMESTAMPTZ,
    pagado_por  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    pagado_en   TIMESTAMPTZ,

    notas TEXT,

    UNIQUE (vendedor_id, periodo),
    CONSTRAINT comision_periodos_estado_check CHECK (estado IN ('cerrado', 'aprobado', 'pagado'))
);

ALTER TABLE comision_periodos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comision_periodos_lectura ON comision_periodos;
CREATE POLICY comision_periodos_lectura ON comision_periodos
    FOR SELECT TO authenticated
    USING (ve_comisiones_de_todos() OR vendedor_id = mi_legajo_id());

-- Nadie escribe a mano: un período con el monto editado y las ventas sin tocar
-- es una cifra que no se puede explicar.
DROP POLICY IF EXISTS comision_periodos_escritura ON comision_periodos;
CREATE POLICY comision_periodos_escritura ON comision_periodos
    FOR ALL TO authenticated
    USING (false) WITH CHECK (false);


/**
 * Cierra un período.
 *
 * ── Cuándo se puede ──
 *
 * A partir del día de cierre del mes siguiente. Antes de eso hay ventas en
 * cortesía cuyo primer pago todavía se espera, y cerrar las contaría como
 * fallidas. `p_forzar` existe para poder cerrar a mano un mes viejo, y queda
 * anotado en la auditoría como cierre forzado.
 *
 * ── Qué congela ──
 *
 * El nivel, el porcentaje, la base total y el esquema. Y pasa las ventas del
 * período a `generada`, que es lo que impide que el generador las siga moviendo.
 *
 * Un período ya aprobado o pagado no se vuelve a cerrar. Recalcularlo sería
 * cambiar un pago hecho.
 */
-- Se borra antes de crearla: renombrar un parámetro OUT cambia el tipo de
-- retorno, y `CREATE OR REPLACE` no puede con eso. Sin este DROP, volver a
-- correr la migración falla con "cannot change return type".
DROP FUNCTION IF EXISTS cerrar_periodo_comisiones(DATE, UUID, BOOLEAN);

CREATE FUNCTION cerrar_periodo_comisiones(
    p_periodo DATE,
    p_vendedor UUID DEFAULT NULL,
    p_forzar BOOLEAN DEFAULT FALSE
)
/**
 * Los nombres de salida llevan `res_` a propósito.
 *
 * Un parámetro OUT llamado `estado` choca con la columna `estado` de
 * `comision_ventas` dentro de la misma función, y Postgres corta con "column
 * reference is ambiguous" — pero recién al ejecutarla, no al crearla. Lo mismo
 * con `monto` y `ventas`.
 *
 * Calificar cada columna también funcionaría, hasta que alguien agregue una
 * línea sin calificar. El prefijo hace que el choque sea imposible.
 */
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
    r RECORD;
BEGIN
    IF NOT tiene_permiso_comision('comisiones.aprobar')
       AND NOT tiene_permiso_comision('comisiones.configurar') THEN
        RAISE EXCEPTION 'No tenés permiso para cerrar períodos de comisión';
    END IF;

    SELECT * INTO v_reglas
      FROM comision_reglas
     WHERE esquema_id = esquema_comisiones_vigente(v_mes);

    -- El día de cierre es del mes SIGUIENTE al del período.
    v_desde := (v_mes + INTERVAL '1 month')::DATE + (COALESCE(v_reglas.dia_cierre, 5) - 1);

    IF NOT p_forzar AND CURRENT_DATE < v_desde THEN
        RAISE EXCEPTION
            'El período % se cierra a partir del %. Hasta entonces hay ventas en período de cortesía esperando su primer pago.',
            TO_CHAR(v_mes, 'MM/YYYY'), TO_CHAR(v_desde, 'DD/MM/YYYY');
    END IF;

    FOR r IN
        SELECT DISTINCT cv.vendedor_id
          FROM comision_ventas cv
         WHERE cv.periodo = v_mes
           AND cv.vendedor_id IS NOT NULL
           AND cv.estado NOT IN ('anulada')
           AND (p_vendedor IS NULL OR cv.vendedor_id = p_vendedor)
    LOOP
        DECLARE
            v_calc RECORD;
            v_ya   comision_periodos%ROWTYPE;
        BEGIN
            SELECT * INTO v_ya
              FROM comision_periodos
             WHERE vendedor_id = r.vendedor_id AND periodo = v_mes;

            IF v_ya.estado IN ('aprobado', 'pagado') THEN
                -- Ya se autorizó el gasto: no se recalcula.
                RETURN QUERY SELECT r.vendedor_id, v_ya.ventas_validas, v_ya.monto, v_ya.estado::TEXT;
                CONTINUE;
            END IF;

            SELECT * INTO v_calc FROM comision_de_periodo(r.vendedor_id, v_mes);

            INSERT INTO comision_periodos (
                vendedor_id, periodo, esquema_id, ventas_validas,
                base_total, nivel, porcentaje, monto, estado, cerrado_por, cerrado_en,
                notas
            ) VALUES (
                r.vendedor_id, v_mes, v_calc.esquema_id, v_calc.ventas,
                v_calc.base_total, v_calc.nivel, v_calc.porcentaje, v_calc.monto,
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
                cerrado_por    = EXCLUDED.cerrado_por,
                cerrado_en     = NOW(),
                notas          = EXCLUDED.notas;

            -- Las ventas contadas quedan `generada`: el generador ya no las
            -- mueve de período aunque después cambie algo del cliente.
            UPDATE comision_ventas cvu
               SET estado = 'generada', actualizado_en = NOW()
             WHERE cvu.periodo = v_mes
               AND cvu.vendedor_id = r.vendedor_id
               AND cvu.comisionable_en IS NOT NULL
               AND cvu.estado IN ('proyectada', 'pendiente_validacion');

            RETURN QUERY SELECT r.vendedor_id, v_calc.ventas, v_calc.monto, 'cerrado'::TEXT;
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
    'Congela el período: nivel, porcentaje, base y monto por vendedor. No toca los ya aprobados o pagados.';


-- =============================================================================
-- 5. Aprobar, pagar, anular
-- =============================================================================
/**
 * Mueve un período cerrado por la máquina de estados.
 *
 * Los tres pasos van en la misma función porque comparten todo salvo el permiso
 * y el estado destino, y tenerlos separados haría que la auditoría de uno se
 * escribiera distinto que la de los otros dos — que es como se descubre, un año
 * después, que uno de los tres no dejaba rastro.
 */
CREATE OR REPLACE FUNCTION mover_periodo_comisiones(
    p_periodo_id UUID,
    p_destino    TEXT,
    p_nota       TEXT DEFAULT NULL
)
RETURNS comision_periodos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_legajo UUID := mi_legajo_id();
    v_fila comision_periodos%ROWTYPE;
    v_permiso TEXT;
BEGIN
    SELECT * INTO v_fila FROM comision_periodos WHERE id = p_periodo_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese período';
    END IF;

    v_permiso := CASE p_destino
        WHEN 'aprobado' THEN 'comisiones.aprobar'
        WHEN 'pagado'   THEN 'comisiones.pagar'
        ELSE NULL
    END;

    IF v_permiso IS NULL THEN
        RAISE EXCEPTION 'Destino inválido: %', p_destino;
    END IF;

    IF NOT tiene_permiso_comision(v_permiso) THEN
        RAISE EXCEPTION 'No tenés permiso para esto (%)', v_permiso;
    END IF;

    -- El orden importa: no se paga lo que nadie autorizó.
    IF p_destino = 'aprobado' AND v_fila.estado <> 'cerrado' THEN
        RAISE EXCEPTION 'Solo se puede aprobar un período cerrado. Este está %.', v_fila.estado;
    END IF;
    IF p_destino = 'pagado' AND v_fila.estado <> 'aprobado' THEN
        RAISE EXCEPTION 'Solo se puede pagar un período aprobado. Este está %.', v_fila.estado;
    END IF;

    UPDATE comision_periodos
       SET estado = p_destino,
           aprobado_por = CASE WHEN p_destino = 'aprobado' THEN v_legajo ELSE aprobado_por END,
           aprobado_en  = CASE WHEN p_destino = 'aprobado' THEN NOW()   ELSE aprobado_en  END,
           pagado_por   = CASE WHEN p_destino = 'pagado'   THEN v_legajo ELSE pagado_por  END,
           pagado_en    = CASE WHEN p_destino = 'pagado'   THEN NOW()   ELSE pagado_en   END,
           notas = COALESCE(p_nota, notas)
     WHERE id = p_periodo_id
    RETURNING * INTO v_fila;

    -- Las ventas del período siguen al período: aprobado el período, aprobadas
    -- las ventas. Es lo que después impide que el generador las recalcule.
    UPDATE comision_ventas
       SET estado = CASE WHEN p_destino = 'pagado' THEN 'pagada' ELSE 'aprobada' END,
           actualizado_en = NOW()
     WHERE vendedor_id = v_fila.vendedor_id
       AND periodo = v_fila.periodo
       AND comisionable_en IS NOT NULL
       AND estado NOT IN ('anulada');

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion, entidad, entidad_id, datos
    )
    SELECT u.id, TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))), u.rol,
           'comisiones.' || p_destino,
           FORMAT('Marcó como %s la comisión de %s por %s',
                  p_destino, TO_CHAR(v_fila.periodo, 'MM/YYYY'), v_fila.monto),
           'comision_periodo', p_periodo_id,
           jsonb_build_object('monto', v_fila.monto, 'ventas', v_fila.ventas_validas, 'nota', p_nota)
    FROM usuarios_sistema u WHERE u.id = v_legajo;

    RETURN v_fila;
END $$;


/**
 * Anula una venta comisionable.
 *
 * El punto 11: una comisión aprobada NO se reduce sola porque el cliente se dio
 * de baja después. Esto es para fraude, duplicidad o error de carga, exige
 * motivo escrito y queda registrado. Anular un período ya pagado se permite
 * —los errores aparecen tarde— pero deja constancia de que la plata ya salió.
 */
CREATE OR REPLACE FUNCTION anular_comision_venta(p_venta UUID, p_motivo TEXT)
RETURNS comision_ventas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_legajo UUID := mi_legajo_id();
    v_fila comision_ventas%ROWTYPE;
BEGIN
    IF NOT tiene_permiso_comision('comisiones.anular') THEN
        RAISE EXCEPTION 'No tenés permiso para anular comisiones';
    END IF;

    IF COALESCE(BTRIM(p_motivo), '') = '' THEN
        RAISE EXCEPTION 'Hace falta el motivo. Nada financiero se modifica en silencio.';
    END IF;

    UPDATE comision_ventas
       SET estado = 'anulada',
           motivo_anulacion = p_motivo,
           anulada_por = v_legajo,
           anulada_en = NOW(),
           actualizado_en = NOW()
     WHERE id = p_venta
    RETURNING * INTO v_fila;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa venta comisionable';
    END IF;

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion, entidad, entidad_id, datos
    )
    SELECT u.id, TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))), u.rol,
           'comisiones.anular',
           FORMAT('Anuló una comisión de %s: %s', v_fila.base, p_motivo),
           'comision_venta', p_venta,
           jsonb_build_object('cliente', v_fila.cliente_id, 'periodo', v_fila.periodo,
                              'estado_anterior', v_fila.estado, 'motivo', p_motivo)
    FROM usuarios_sistema u WHERE u.id = v_legajo;

    RETURN v_fila;
END $$;


-- =============================================================================
-- 6. La cola de la oficina
-- =============================================================================
-- Períodos cerrados esperando autorización o pago, con el nombre al lado.
DROP VIEW IF EXISTS v_comision_periodos;
CREATE VIEW v_comision_periodos WITH (security_invoker = true) AS
SELECT
    cp.*,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    e.nombre AS esquema,
    e.modo   AS esquema_modo,
    cp.monto + cp.bono AS total_a_pagar
FROM comision_periodos cp
LEFT JOIN usuarios_sistema u  ON u.id = cp.vendedor_id
LEFT JOIN comision_esquemas e ON e.id = cp.esquema_id;

GRANT SELECT ON v_comision_periodos TO authenticated;


-- =============================================================================
-- 7. El interruptor de la tarea programada
-- =============================================================================
-- El cierre entra al mismo lugar que los cortes y la facturación. Apagado por
-- defecto: encender solo una tarea que mueve plata sin que nadie lo haya pedido
-- sería una sorpresa desagradable el día 5.
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS comisiones_automatico BOOLEAN DEFAULT FALSE;
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS comisiones_hora VARCHAR(5) DEFAULT '03:30';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Validar una solicitud:
--   SELECT validar_solicitud('<prospecto>', 'aprobado', 'Todo en orden', 'Verificación interna OK');
--
--   -- Cerrar el mes pasado (a partir del día 5 de este):
--   SELECT * FROM cerrar_periodo_comisiones(DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')::DATE);
--
--   SELECT vendedor, periodo, ventas_validas, nivel, porcentaje, monto, estado
--     FROM v_comision_periodos ORDER BY periodo DESC;
--
--   -- Y la cadena de autorización:
--   SELECT mover_periodo_comisiones('<periodo>', 'aprobado');
--   SELECT mover_periodo_comisiones('<periodo>', 'pagado');
