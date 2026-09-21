-- =============================================================================
-- Migración 80 — Cotizador
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué falta hoy ──
--
-- Cotizar ya existe, pero solo desde la ficha de un prospecto. O sea que para
-- decirle un precio a alguien hay que cargarlo primero.
--
-- Eso no coincide con cómo pasa en la realidad: entra uno al local o llama
-- preguntando "¿cuánto sale?", y todavía no es un prospecto — es alguien
-- averiguando. Obligar a cargarlo antes produce dos cosas malas a la vez: una
-- base llena de curiosos que nadie va a volver a llamar, o —lo más común— un
-- precio dicho de memoria y anotado en ningún lado.
--
-- Con esto se arma la cotización primero. Si la persona se interesa, se la
-- convierte en prospecto con la cotización ya adentro. Si no, quedó el registro
-- de que se pidió precio y por cuánto.
--
-- ── Y una puerta lateral que quedó abierta ──
--
-- `cotizaciones` conservaba la política de la migración 67: `USING (true)`,
-- cualquiera con sesión. Con la cotización suelta pasa a guardar nombre y
-- teléfono de gente que preguntó, así que ahora es cartera y va cerrada como el
-- resto.
-- =============================================================================


-- =============================================================================
-- 1. La cotización puede vivir sin prospecto
-- =============================================================================
ALTER TABLE cotizaciones ALTER COLUMN prospecto_id DROP NOT NULL;

ALTER TABLE cotizaciones
    -- A quién se le cotizó, cuando todavía no es prospecto. Un solo nombre y un
    -- teléfono: lo mínimo para poder volver a llamarlo, y nada más. Pedirle la
    -- cédula a alguien que está averiguando un precio es cómo se pierde la
    -- conversación.
    ADD COLUMN IF NOT EXISTS nombre     VARCHAR(150),
    ADD COLUMN IF NOT EXISTS telefono   VARCHAR(30),
    ADD COLUMN IF NOT EXISTS sector     VARCHAR(100),

    -- Quién cotizó. `creado_por` ya existía pero es el usuario del sistema; esto
    -- es el vendedor al que le corresponde la oportunidad, que puede diferir
    -- cuando cotiza alguien de oficina para un vendedor de calle.
    ADD COLUMN IF NOT EXISTS vendedor_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    -- El prospecto que salió de esta cotización, si se convirtió. Es el vínculo
    -- al revés de `prospecto_id`: aquel es "cotizo para este prospecto", este es
    -- "de esta cotización nació ese prospecto".
    ADD COLUMN IF NOT EXISTS convertida_en UUID REFERENCES prospectos(id) ON DELETE SET NULL;

-- Una cotización tiene que poder identificar a alguien: o cuelga de un prospecto
-- o trae un nombre. Sin ninguno de los dos es un papel sin destinatario.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cotizaciones_tiene_destinatario') THEN
        ALTER TABLE cotizaciones ADD CONSTRAINT cotizaciones_tiene_destinatario
            CHECK (prospecto_id IS NOT NULL OR NULLIF(BTRIM(COALESCE(nombre, '')), '') IS NOT NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cotizaciones_vendedor
    ON cotizaciones (vendedor_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_sueltas
    ON cotizaciones (creado_en DESC) WHERE prospecto_id IS NULL;


-- =============================================================================
-- 2. La vista con los totales ya calculados
-- =============================================================================
-- El total se calcula acá y no en la pantalla para que el número que ve el
-- cliente en el WhatsApp, el que aparece en la lista y el que se use en
-- cualquier reporte sean el mismo. Un total recalculado en tres lugares termina
-- discrepando en el redondeo.
DROP VIEW IF EXISTS v_cotizaciones;
CREATE VIEW v_cotizaciones WITH (security_invoker = true) AS
SELECT
    c.*,
    COALESCE(p.nombre, c.nombre)               AS cliente,
    COALESCE(p.telefono, c.telefono)           AS contacto,
    COALESCE(p.sector, c.sector)               AS zona,
    TRIM(CONCAT(u.nombre, ' ', u.apellido))    AS vendedor,

    -- Lo que paga el primer mes: la instalación y el equipo son de una sola vez.
    (c.precio_mensual + c.costo_instalacion + c.costo_equipo - c.descuento) AS total_primer_pago,
    -- Y lo que paga de ahí en adelante.
    c.precio_mensual                            AS total_mensual,

    (c.creado_en::DATE + c.validez_dias)        AS vence_el,
    (c.creado_en::DATE + c.validez_dias) < CURRENT_DATE AS vencida,

    (c.convertida_en IS NOT NULL OR c.prospecto_id IS NOT NULL) AS con_prospecto
FROM cotizaciones c
LEFT JOIN prospectos p       ON p.id = c.prospecto_id
LEFT JOIN usuarios_sistema u ON u.id = COALESCE(c.vendedor_id, c.creado_por);


-- =============================================================================
-- 3. Convertir la cotización en prospecto
-- =============================================================================
/**
 * De "vino a preguntar" a "es una oportunidad".
 *
 * Va como función y no como dos escrituras desde la pantalla porque son tres
 * cosas que tienen que pasar juntas: crear el prospecto, apuntarle la cotización
 * y marcar la cotización como convertida. Si se cortara en el medio quedaría un
 * prospecto sin su cotización —y el vendedor volvería a armar el precio, quizás
 * distinto.
 */
CREATE OR REPLACE FUNCTION convertir_cotizacion_en_prospecto(p_cotizacion UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c   RECORD;
    v_prospecto UUID;
BEGIN
    SELECT * INTO c FROM cotizaciones WHERE id = p_cotizacion;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa cotización';
    END IF;

    IF c.prospecto_id IS NOT NULL OR c.convertida_en IS NOT NULL THEN
        -- Ya tiene prospecto. Se devuelve el que hay en vez de crear otro: dos
        -- clics no pueden producir dos fichas de la misma persona.
        RETURN COALESCE(c.prospecto_id, c.convertida_en);
    END IF;

    IF NULLIF(BTRIM(COALESCE(c.nombre, '')), '') IS NULL THEN
        RAISE EXCEPTION 'La cotización no tiene nombre: no se puede crear el prospecto';
    END IF;

    INSERT INTO prospectos (
        nombre, telefono, sector, plan_id, origen, estado,
        vendedor_id, creado_por, notas
    ) VALUES (
        c.nombre, c.telefono, c.sector, c.plan_id, 'local', 'cotizado',
        COALESCE(c.vendedor_id, c.creado_por), c.creado_por,
        'Viene de la cotización N° ' || c.numero
    )
    RETURNING id INTO v_prospecto;

    -- El prospecto nace en `cotizado` y no en `nuevo` a propósito: ya tiene el
    -- precio en la mano, que es exactamente lo que significa esa etapa. Ponerlo
    -- en `nuevo` haría que el tablero pida "contactarlo" a alguien con quien ya
    -- se habló.

    UPDATE cotizaciones
       SET prospecto_id = v_prospecto,
           convertida_en = v_prospecto,
           estado = CASE WHEN estado = 'borrador' THEN 'enviada' ELSE estado END
     WHERE id = p_cotizacion;

    RETURN v_prospecto;
END $$;


-- =============================================================================
-- 4. Seguridad
-- =============================================================================
-- La política de la 67 dejaba leer todas las cotizaciones a cualquiera con
-- sesión. Con nombre y teléfono adentro, eso es cartera.
DROP POLICY IF EXISTS cotizaciones_personal ON cotizaciones;
DROP POLICY IF EXISTS cotizaciones_acceso ON cotizaciones;
CREATE POLICY cotizaciones_acceso ON cotizaciones
    FOR ALL TO authenticated
    USING (
        cartera_completa()
        OR vendedor_id = mi_legajo_id()
        OR creado_por  = mi_legajo_id()
        -- Las que cuelgan de un prospecto siguen la regla del prospecto: cuando
        -- este se archiva al activarse la venta, su cotización se va con él.
        OR prospecto_id IN (SELECT id FROM prospectos)
    )
    WITH CHECK (
        cartera_completa()
        OR vendedor_id = mi_legajo_id()
        OR creado_por  = mi_legajo_id()
    );

-- Las cotizaciones que ya existen quedan atribuidas a quien las creó, para que
-- su autor no las pierda de vista al aplicarse la política.
UPDATE cotizaciones SET vendedor_id = creado_por
 WHERE vendedor_id IS NULL AND creado_por IS NOT NULL;
