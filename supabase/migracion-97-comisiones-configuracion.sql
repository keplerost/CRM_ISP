-- =============================================================================
-- Migración 97 — Comisiones: configuración (Fase 1)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué hace esta migración y qué NO ──
--
-- Crea SOLO la configuración: cuánto vale cada plan para el vendedor, los
-- escalones, los bonos y las reglas del período. No calcula ni una comisión, no
-- toca prospectos y no crea ninguna deuda con nadie. Después de correrla el
-- sistema se comporta exactamente igual que antes.
--
-- El motor de cálculo es la Fase 2 y vive en la 99. Esto es lo que ese motor va
-- a leer.
--
-- ── Por qué todo cuelga de un "esquema" ──
--
-- Porque el requisito más difícil de agregar después es el punto 25: no
-- modificar períodos históricos. Si las bases y los porcentajes vivieran en
-- columnas sueltas, subir la base del plan de 500 megas en noviembre cambiaría
-- lo que se pagó en agosto — y nadie se enteraría hasta que un vendedor
-- reclamara.
--
-- Con un esquema fechado, cambiar una regla no edita nada: crea una versión
-- nueva. Los períodos viejos siguen apuntando a la suya.
--
-- ── Sobre los valores iniciales ──
--
-- Son los del documento del requerimiento, mapeados a los planes que existen de
-- verdad en esta base. No están quemados en código: quedan cargados como datos y
-- se editan desde Configuración → Ventas → Comisiones e Incentivos.
-- =============================================================================


-- =============================================================================
-- 1. El esquema: una versión del plan de comisiones
-- =============================================================================
CREATE TABLE IF NOT EXISTS comision_esquemas (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    nombre   VARCHAR(80) NOT NULL,
    notas    TEXT,

    -- Desde cuándo rige. Una venta usa el esquema vigente EL DÍA en que se
    -- volvió comisionable, no el vigente hoy.
    vigente_desde DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta DATE,

    /**
     * Cómo se aplica el porcentaje del nivel alcanzado.
     *
     *   retroactivo — llegar a 26 ventas aplica el 45 % a las 26.
     *   progresivo  — cada tramo cobra su propio porcentaje.
     *
     * El punto 5 del requerimiento pide poder cambiar entre los dos sin
     * reprogramar. Por eso es un dato y no dos funciones distintas.
     */
    modo     VARCHAR(12) NOT NULL DEFAULT 'retroactivo',

    activo   BOOLEAN NOT NULL DEFAULT TRUE,

    creado_por     UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT comision_esquemas_modo_check CHECK (modo IN ('retroactivo', 'progresivo')),
    CONSTRAINT comision_esquemas_vigencia_check
        CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);

-- RLS acá mismo, no al final: si la migración se cortara en el medio, la tabla
-- ya existiría sin protección. Sin políticas, RLS niega todo — el estado seguro.
ALTER TABLE comision_esquemas ENABLE ROW LEVEL SECURITY;

-- Un solo esquema activo por vez. Dos activos significarían dos respuestas
-- distintas a "cuánto le toca a esta venta", y el motor elegiría una por orden
-- de inserción — que es la peor forma de decidir plata.
--
-- El índice va sobre `activo` con la condición `WHERE activo`: solo entran las
-- filas en TRUE, y todas valen lo mismo, así que la unicidad deja pasar una sola.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comision_esquema_activo
    ON comision_esquemas (activo) WHERE activo;


-- =============================================================================
-- 2. Base comisionable por plan
-- =============================================================================
/**
 * Cuánto vale cada plan para el vendedor.
 *
 * ── Por qué no es una columna en `planes_velocidad` ──
 *
 * Porque el precio del plan cambia por razones comerciales —una promoción, un
 * ajuste de inflación, una guerra de precios con el vecino— y la base
 * comisionable no tiene por qué moverse con él. El punto 3 lo pide explícito: un
 * abonado puede pagar $17,50 con la promo del 50 % mientras la base sigue
 * siendo $20.
 *
 * Como columna del plan, además, no habría forma de tener dos valores para dos
 * períodos distintos, y ahí se cae el punto 25 entero.
 */
CREATE TABLE IF NOT EXISTS comision_bases_plan (
    esquema_id UUID NOT NULL REFERENCES comision_esquemas(id) ON DELETE CASCADE,
    plan_id    UUID NOT NULL REFERENCES planes_velocidad(id) ON DELETE CASCADE,

    base       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (base >= 0),
    -- Un plan puede quedar fuera del esquema sin borrar la fila: así se
    -- conserva cuánto valía cuando sí comisionaba.
    comisiona  BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (esquema_id, plan_id)
);


-- RLS acá mismo, no al final: si la migración se cortara en el medio, la tabla
-- ya existiría sin protección. Sin políticas, RLS niega todo — el estado seguro.
ALTER TABLE comision_bases_plan ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 3. Escalones
-- =============================================================================
CREATE TABLE IF NOT EXISTS comision_niveles (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    esquema_id UUID NOT NULL REFERENCES comision_esquemas(id) ON DELETE CASCADE,

    orden      SMALLINT NOT NULL,
    nombre     VARCHAR(30) NOT NULL,

    desde_ventas SMALLINT NOT NULL CHECK (desde_ventas >= 0),
    -- Vacío = sin techo. Es el último escalón, el que no tiene "hasta".
    hasta_ventas SMALLINT,

    porcentaje NUMERIC(5,2) NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),

    UNIQUE (esquema_id, orden),
    CONSTRAINT comision_niveles_rango_check
        CHECK (hasta_ventas IS NULL OR hasta_ventas >= desde_ventas)
);


-- RLS acá mismo, no al final: si la migración se cortara en el medio, la tabla
-- ya existiría sin protección. Sin políticas, RLS niega todo — el estado seguro.
ALTER TABLE comision_niveles ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 4. Bono de calidad de cartera
-- =============================================================================
CREATE TABLE IF NOT EXISTS comision_bonos_calidad (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    esquema_id UUID NOT NULL REFERENCES comision_esquemas(id) ON DELETE CASCADE,

    orden      SMALLINT NOT NULL,
    -- Los tramos van en porcentaje de calidad de la cohorte: 70 a 79,99 → $10.
    desde_pct  NUMERIC(5,2) NOT NULL CHECK (desde_pct >= 0 AND desde_pct <= 100),
    hasta_pct  NUMERIC(5,2) NOT NULL CHECK (hasta_pct >= 0 AND hasta_pct <= 100),

    monto      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),

    UNIQUE (esquema_id, orden),
    CONSTRAINT comision_bonos_rango_check CHECK (hasta_pct >= desde_pct)
);


-- RLS acá mismo, no al final: si la migración se cortara en el medio, la tabla
-- ya existiría sin protección. Sin políticas, RLS niega todo — el estado seguro.
ALTER TABLE comision_bonos_calidad ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 5. Las reglas del período
-- =============================================================================
/**
 * Todo lo que el punto 2 pide no quemar en código.
 *
 * ── Sobre los interruptores de requisito ──
 *
 * Los seis `requiere_*` son la respuesta al riesgo que bloquea todo lo demás:
 * hoy `contratos`, `expediente_documentos` y `pagos` están vacías en esta base.
 * Si el motor exigiera contrato y primer pago desde el día uno, NINGUNA venta
 * llegaría nunca a comisionable y todos los vendedores verían cero para siempre
 * — sin ningún mensaje que explicara por qué.
 *
 * Se arranca exigiendo lo que esta operación ya puede demostrar —instalación y
 * activación, que es mucho más estricto que "el vendedor la marcó ganada"— y los
 * demás se encienden desde la pantalla a medida que facturación y admisión
 * entren en régimen.
 *
 * Encender un requisito NO afecta períodos ya cerrados: los cerrados quedan
 * congelados con su propio esquema.
 */
CREATE TABLE IF NOT EXISTS comision_reglas (
    esquema_id UUID PRIMARY KEY REFERENCES comision_esquemas(id) ON DELETE CASCADE,

    -- ── Qué hace falta para que una venta comisione ──
    requiere_aprobacion    BOOLEAN NOT NULL DEFAULT FALSE,
    requiere_documentacion BOOLEAN NOT NULL DEFAULT FALSE,
    requiere_contrato      BOOLEAN NOT NULL DEFAULT FALSE,
    requiere_instalacion   BOOLEAN NOT NULL DEFAULT TRUE,
    requiere_activacion    BOOLEAN NOT NULL DEFAULT TRUE,
    requiere_primer_pago   BOOLEAN NOT NULL DEFAULT FALSE,

    -- ── Prepago: cortesía y ventana de pago ──
    --
    -- Instalado del 25 en adelante, el primer pago se espera recién del 1 al 5
    -- del mes siguiente. Sin esto, una instalación del 27 parecería una mala
    -- venta cuatro días después de hecha.
    dia_cortesia_desde   SMALLINT NOT NULL DEFAULT 25 CHECK (dia_cortesia_desde BETWEEN 1 AND 31),
    pago_ventana_desde   SMALLINT NOT NULL DEFAULT 1  CHECK (pago_ventana_desde BETWEEN 1 AND 31),
    pago_ventana_hasta   SMALLINT NOT NULL DEFAULT 5  CHECK (pago_ventana_hasta BETWEEN 1 AND 31),

    -- ── Cierre ──
    --
    -- El día del mes SIGUIENTE en que se cierra el período. No el último día del
    -- mes: para entonces las ventas del 25 en adelante todavía están en cortesía.
    dia_cierre           SMALLINT NOT NULL DEFAULT 5 CHECK (dia_cierre BETWEEN 1 AND 28),

    -- ── Cohortes y calidad ──
    dias_cohorte         SMALLINT NOT NULL DEFAULT 90 CHECK (dias_cohorte BETWEEN 30 AND 365),
    min_clientes_cohorte SMALLINT NOT NULL DEFAULT 10 CHECK (min_clientes_cohorte >= 0),

    -- ── Cartera ──
    meses_sin_pago_suspension SMALLINT NOT NULL DEFAULT 1 CHECK (meses_sin_pago_suspension >= 1),
    meses_sin_pago_retiro     SMALLINT NOT NULL DEFAULT 2 CHECK (meses_sin_pago_retiro >= 1),

    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    CONSTRAINT comision_reglas_ventana_check CHECK (pago_ventana_hasta >= pago_ventana_desde),
    CONSTRAINT comision_reglas_retiro_check
        CHECK (meses_sin_pago_retiro > meses_sin_pago_suspension)
);


-- RLS acá mismo, no al final: si la migración se cortara en el medio, la tabla
-- ya existiría sin protección. Sin políticas, RLS niega todo — el estado seguro.
ALTER TABLE comision_reglas ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 6. Motivos de baja
-- =============================================================================
/**
 * Por qué se fue un cliente, y si eso le cuenta al vendedor.
 *
 * El punto 17 es la parte del requerimiento que más protege al vendedor: que un
 * abonado se mude fuera de cobertura o que la empresa no haya podido sostener el
 * servicio no es culpa de quien vendió. Sin este catálogo, toda baja pesaría
 * igual y el bono de calidad terminaría castigando a quien vende en las zonas
 * más difíciles — que suele ser el que más trabaja.
 */
CREATE TABLE IF NOT EXISTS motivos_baja (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre  VARCHAR(80) NOT NULL UNIQUE,
    -- FALSE = no le cuenta al vendedor en la calidad de su cohorte.
    afecta_calidad BOOLEAN NOT NULL DEFAULT TRUE,
    orden   SMALLINT NOT NULL DEFAULT 0,
    activo  BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- RLS acá mismo, no al final: si la migración se cortara en el medio, la tabla
-- ya existiría sin protección. Sin políticas, RLS niega todo — el estado seguro.
ALTER TABLE motivos_baja ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 7. Quién puede qué
-- =============================================================================
/**
 * Configurar comisiones es tocar plata de otros.
 *
 * Se resuelve con una función y no con un `permisos ? '...'` suelto en cada
 * política porque son seis tablas: repetir la expresión seis veces es la forma
 * de que dentro de un año una diga algo distinto de las otras cinco.
 */
CREATE OR REPLACE FUNCTION puede_configurar_comisiones()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'comisiones.configurar'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        -- Sin legajo no se bloquea: misma regla que el resto del sistema, para
        -- que una instalación a medio migrar no quede inutilizable.
        TRUE
    )
$$;

COMMENT ON FUNCTION puede_configurar_comisiones IS
    'TRUE si quien pregunta puede editar el esquema de comisiones: bases, escalones, bonos y reglas.';


/**
 * El esquema que rige en una fecha.
 *
 * Con fecha, devuelve el que estaba vigente ese día — que es como el motor tiene
 * que preguntarlo, porque una venta de agosto se paga con las reglas de agosto
 * aunque hoy sea diciembre.
 *
 * Sin fecha, el de hoy.
 */
CREATE OR REPLACE FUNCTION esquema_comisiones_vigente(p_fecha DATE DEFAULT CURRENT_DATE)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id
      FROM comision_esquemas
     WHERE vigente_desde <= p_fecha
       AND (vigente_hasta IS NULL OR vigente_hasta >= p_fecha)
     ORDER BY activo DESC, vigente_desde DESC
     LIMIT 1
$$;

COMMENT ON FUNCTION esquema_comisiones_vigente IS
    'El esquema de comisiones que regía en esa fecha. El motor lo consulta con la fecha de la venta, no con la de hoy.';


-- =============================================================================
-- 8. Seguridad
-- =============================================================================
-- Leer: cualquiera con sesión. El vendedor NECESITA ver los escalones y las
-- bases para saber cuánto vale su próxima venta y cuánto le falta para el nivel
-- siguiente — es la mitad del punto 20. Acá no hay datos de ningún abonado.
--
-- Escribir: solo quien puede configurar. Todo lo demás es plata.
--
-- ── Por qué esto está escrito seis veces y no en un bucle ──
--
-- La primera versión recorría las seis tablas con un `DO $$ ... EXECUTE
-- format(...)`. Funcionaba —al terminar, RLS quedaba activo en las seis— pero
-- estaba mal igual: dentro de SQL dinámico, ni el analizador de Supabase ni un
-- `grep` ni una persona leyendo el archivo pueden comprobar que una tabla quedó
-- protegida. El linter avisó exactamente eso, y tenía razón.
--
-- Una política de seguridad que hay que ejecutar para saber si existe no sirve
-- como política de seguridad. Prefiero seis bloques repetidos y verificables a
-- uno elegante que hay que correr para creerle.

-- ── comision_esquemas ──
DROP POLICY IF EXISTS comision_esquemas_lectura ON comision_esquemas;
CREATE POLICY comision_esquemas_lectura ON comision_esquemas
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS comision_esquemas_escritura ON comision_esquemas;
CREATE POLICY comision_esquemas_escritura ON comision_esquemas
    FOR ALL TO authenticated
    USING (puede_configurar_comisiones()) WITH CHECK (puede_configurar_comisiones());

-- ── comision_bases_plan ──
DROP POLICY IF EXISTS comision_bases_plan_lectura ON comision_bases_plan;
CREATE POLICY comision_bases_plan_lectura ON comision_bases_plan
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS comision_bases_plan_escritura ON comision_bases_plan;
CREATE POLICY comision_bases_plan_escritura ON comision_bases_plan
    FOR ALL TO authenticated
    USING (puede_configurar_comisiones()) WITH CHECK (puede_configurar_comisiones());

-- ── comision_niveles ──
DROP POLICY IF EXISTS comision_niveles_lectura ON comision_niveles;
CREATE POLICY comision_niveles_lectura ON comision_niveles
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS comision_niveles_escritura ON comision_niveles;
CREATE POLICY comision_niveles_escritura ON comision_niveles
    FOR ALL TO authenticated
    USING (puede_configurar_comisiones()) WITH CHECK (puede_configurar_comisiones());

-- ── comision_bonos_calidad ──
DROP POLICY IF EXISTS comision_bonos_calidad_lectura ON comision_bonos_calidad;
CREATE POLICY comision_bonos_calidad_lectura ON comision_bonos_calidad
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS comision_bonos_calidad_escritura ON comision_bonos_calidad;
CREATE POLICY comision_bonos_calidad_escritura ON comision_bonos_calidad
    FOR ALL TO authenticated
    USING (puede_configurar_comisiones()) WITH CHECK (puede_configurar_comisiones());

-- ── comision_reglas ──
DROP POLICY IF EXISTS comision_reglas_lectura ON comision_reglas;
CREATE POLICY comision_reglas_lectura ON comision_reglas
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS comision_reglas_escritura ON comision_reglas;
CREATE POLICY comision_reglas_escritura ON comision_reglas
    FOR ALL TO authenticated
    USING (puede_configurar_comisiones()) WITH CHECK (puede_configurar_comisiones());

-- ── motivos_baja ──
DROP POLICY IF EXISTS motivos_baja_lectura ON motivos_baja;
CREATE POLICY motivos_baja_lectura ON motivos_baja
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS motivos_baja_escritura ON motivos_baja;
CREATE POLICY motivos_baja_escritura ON motivos_baja
    FOR ALL TO authenticated
    USING (puede_configurar_comisiones()) WITH CHECK (puede_configurar_comisiones());


-- =============================================================================
-- 9. La vista que lee la pantalla
-- =============================================================================
-- El esquema vigente con todo adentro. Existe para que la pantalla de
-- configuración —y después el tablero del vendedor— hagan una consulta en vez de
-- cinco, y para que nadie tenga que repetir la lógica de "cuál es el vigente".
DROP VIEW IF EXISTS v_comision_esquema;
CREATE VIEW v_comision_esquema WITH (security_invoker = true) AS
SELECT
    e.*,
    r.requiere_aprobacion, r.requiere_documentacion, r.requiere_contrato,
    r.requiere_instalacion, r.requiere_activacion, r.requiere_primer_pago,
    r.dia_cortesia_desde, r.pago_ventana_desde, r.pago_ventana_hasta,
    r.dia_cierre, r.dias_cohorte, r.min_clientes_cohorte,
    r.meses_sin_pago_suspension, r.meses_sin_pago_retiro,
    (SELECT COUNT(*) FROM comision_niveles n WHERE n.esquema_id = e.id) AS niveles,
    (SELECT COUNT(*) FROM comision_bases_plan b WHERE b.esquema_id = e.id AND b.comisiona) AS planes_comisionables,
    (SELECT MAX(monto) FROM comision_bonos_calidad c WHERE c.esquema_id = e.id) AS bono_maximo
FROM comision_esquemas e
LEFT JOIN comision_reglas r ON r.esquema_id = e.id;

GRANT SELECT ON v_comision_esquema TO authenticated;

-- Las bases con el nombre y el precio del plan al lado. La pantalla necesita
-- mostrar los dos juntos: el punto de todo esto es que se vea que la base NO es
-- el precio.
DROP VIEW IF EXISTS v_comision_bases;
CREATE VIEW v_comision_bases WITH (security_invoker = true) AS
SELECT
    b.esquema_id,
    b.plan_id,
    b.base,
    b.comisiona,
    p.nombre        AS plan,
    p.precio        AS precio_sin_iva,
    ROUND(p.precio * (1 + COALESCE(p.iva_porcentaje, 0) / 100.0), 2) AS precio_comercial,
    p.bajada_kbps,
    p.activo        AS plan_activo
FROM comision_bases_plan b
JOIN planes_velocidad p ON p.id = b.plan_id;

GRANT SELECT ON v_comision_bases TO authenticated;


-- =============================================================================
-- 10. Los valores iniciales
-- =============================================================================
-- Se cargan una sola vez. Si ya hay un esquema, esta migración no toca nada:
-- volver a correrla no puede pisar valores que alguien ya ajustó a mano.
DO $$
DECLARE
    v_esquema UUID;
BEGIN
    IF EXISTS (SELECT 1 FROM comision_esquemas) THEN
        RAISE NOTICE 'Ya existe un esquema de comisiones: no se toca nada.';
        RETURN;
    END IF;

    INSERT INTO comision_esquemas (nombre, modo, vigente_desde, activo, notas)
    VALUES (
        'Plan de comisiones 2026 — V1',
        'retroactivo',
        DATE_TRUNC('month', CURRENT_DATE)::DATE,
        TRUE,
        'Valores iniciales del requerimiento. Arranca exigiendo instalación y activación; '
        'contrato, documentación, aprobación y primer pago quedan apagados hasta que esos '
        'módulos tengan datos reales.'
    )
    RETURNING id INTO v_esquema;

    -- ── Escalones ──
    INSERT INTO comision_niveles (esquema_id, orden, nombre, desde_ventas, hasta_ventas, porcentaje)
    VALUES
        (v_esquema, 1, 'Inicial',  1, 10,   20),
        (v_esquema, 2, 'Bronce',  11, 15,   30),
        (v_esquema, 3, 'Plata',   16, 20,   35),
        (v_esquema, 4, 'Oro',     21, 25,   40),
        (v_esquema, 5, 'Platino', 26, 30,   45),
        (v_esquema, 6, 'Élite',   31, NULL, 50);

    -- ── Bonos de calidad ──
    INSERT INTO comision_bonos_calidad (esquema_id, orden, desde_pct, hasta_pct, monto)
    VALUES
        (v_esquema, 1,  0,     69.99,  0),
        (v_esquema, 2, 70,     79.99, 10),
        (v_esquema, 3, 80,     84.99, 20),
        (v_esquema, 4, 85,     89.99, 30),
        (v_esquema, 5, 90,     94.99, 40),
        (v_esquema, 6, 95,    100,    50);

    -- ── Reglas ──
    INSERT INTO comision_reglas (esquema_id) VALUES (v_esquema);

    -- ── Bases por plan ──
    --
    -- Los valores del requerimiento, emparejados por velocidad con los planes
    -- que existen en esta base. Los precios cargados están SIN IVA —$17,39 es
    -- $20,00 con IVA— así que la tabla del documento coincide.
    --
    -- Todo plan que no esté en la lista entra con base 0 y sin comisionar: es
    -- mejor que aparezca en la pantalla pidiendo un valor a que comisione un
    -- monto inventado.
    INSERT INTO comision_bases_plan (esquema_id, plan_id, base, comisiona)
    SELECT
        v_esquema,
        p.id,
        CASE
            WHEN p.bajada_kbps >= 512000 THEN 20    -- 500 Mbps
            WHEN p.bajada_kbps >= 409600 THEN 17    -- 400 Mbps
            WHEN p.bajada_kbps >= 307200 THEN 14    -- 300 Mbps
            WHEN p.bajada_kbps >= 153600 THEN 12    -- 150 Mbps
            WHEN p.bajada_kbps >=  51200 THEN 10    --  50 Mbps
            ELSE 0
        END,
        p.activo AND p.bajada_kbps >= 51200
    FROM planes_velocidad p;

    -- ── Motivos de baja ──
    INSERT INTO motivos_baja (nombre, afecta_calidad, orden) VALUES
        ('Problema técnico atribuible a la empresa', FALSE, 1),
        ('Mudanza fuera de cobertura',               FALSE, 2),
        ('Fuerza mayor',                             FALSE, 3),
        ('Error administrativo',                     FALSE, 4),
        ('Fallecimiento del titular',                FALSE, 5),
        ('Abandono temprano',                        TRUE,  6),
        ('Nunca realizó el pago requerido',          TRUE,  7),
        ('Documentación irregular',                  TRUE,  8),
        ('Incumplimiento de política comercial',     TRUE,  9),
        ('Se fue a la competencia',                  TRUE, 10),
        ('Sin motivo registrado',                    TRUE, 11)
    ON CONFLICT (nombre) DO NOTHING;

    RAISE NOTICE 'Esquema de comisiones inicial creado: %', v_esquema;
END $$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, modo, vigente_desde, niveles, planes_comisionables, bono_maximo
--     FROM v_comision_esquema WHERE activo;
--
--   SELECT plan, precio_comercial, base, comisiona
--     FROM v_comision_bases ORDER BY bajada_kbps;
--
--   SELECT nombre, desde_ventas, hasta_ventas, porcentaje
--     FROM comision_niveles ORDER BY orden;
--
-- Y que el motor sepa con qué reglas pagar una venta de agosto:
--   SELECT esquema_comisiones_vigente('2026-08-15');
