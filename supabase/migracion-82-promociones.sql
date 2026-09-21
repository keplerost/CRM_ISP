-- =============================================================================
-- Migración 82 — Promociones
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué había ──
--
-- `clientes.promo_porcentaje`, `promo_meses` y `promo_desde`: un descuento que
-- se carga a mano en la ficha de cada abonado, DESPUÉS de que ya es cliente.
--
-- O sea que una promoción no existía como cosa: era un número suelto repetido en
-- cada ficha, sin nombre, sin fecha de vencimiento y sin forma de saber de dónde
-- salió. Con eso pasan tres cosas, y las tres se ven en la calle:
--
--   · El vendedor cotiza sin la promo, o con una que venció en febrero y él
--     sigue ofreciendo en marzo porque nadie le avisó.
--   · Cada vendedor la interpreta distinto: "dos meses al 50%" ¿desde la
--     instalación o desde la primera factura?
--   · No se puede responder "¿cuántas ventas cerró la promo de Navidad?".
--
-- ── Lo que agrega esto ──
--
-- La promoción pasa a ser una fila con nombre y vigencia. El cotizador muestra
-- las que están vivas HOY —las vencidas desaparecen solas— y al ganarse la venta
-- el descuento se copia solo a la ficha del abonado. Deja de depender de que
-- alguien se acuerde.
-- =============================================================================


-- =============================================================================
-- 1. El catálogo
-- =============================================================================
CREATE TABLE IF NOT EXISTS promociones (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre        VARCHAR(120) NOT NULL,
    -- Lo que se le dice al cliente. Va en la cotización tal cual se escriba acá,
    -- así que la redacta quien define la promo y no cada vendedor.
    descripcion   TEXT,

    -- Qué hace. Cuatro formas, y son las cuatro que el sistema de facturación
    -- puede realmente aplicar — no se inventa ninguna que después no se pueda
    -- cobrar:
    --
    --   porcentaje         → N% de descuento sobre la mensualidad, M meses.
    --   meses_gratis       → M meses sin pagar (es 100% por M meses).
    --   instalacion_gratis → no se cobra la instalación. No toca la mensualidad.
    --   precio_fijo        → una mensualidad promocional fija, M meses.
    tipo          VARCHAR(20) NOT NULL,

    -- El número que acompaña al tipo: el porcentaje, la cantidad de meses
    -- gratis, o el precio fijo. `instalacion_gratis` no lo usa.
    valor         NUMERIC(10, 2),

    -- Cuántos meses dura el beneficio sobre la mensualidad.
    meses_aplica  SMALLINT CHECK (meses_aplica IS NULL OR meses_aplica > 0),

    -- La vigencia de la CAMPAÑA: hasta cuándo se puede vender esta promo. Es
    -- distinto de `meses_aplica`, que es cuánto le dura al cliente que la tomó.
    -- Confundirlas es el error clásico: una promo de "3 meses de descuento"
    -- vendida hasta fin de mes son dos plazos distintos.
    vigente_desde DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta DATE,

    -- NULL = para todos los planes. Si hay filas en `promocion_planes`, solo
    -- para esos.
    activa        BOOLEAN NOT NULL DEFAULT TRUE,
    color         VARCHAR(7) NOT NULL DEFAULT '#d95926',

    creado_por    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT promociones_tipo_check CHECK (tipo IN (
        'porcentaje', 'meses_gratis', 'instalacion_gratis', 'precio_fijo'
    )),
    -- Cada tipo necesita su número. Sin esto se puede guardar una promo de
    -- "porcentaje" sin porcentaje, que en la cotización daría un descuento de
    -- cero y nadie entendería por qué.
    CONSTRAINT promociones_valor_coherente CHECK (
        (tipo = 'instalacion_gratis') OR (valor IS NOT NULL AND valor > 0)
    ),
    CONSTRAINT promociones_porcentaje_valido CHECK (
        tipo <> 'porcentaje' OR (valor > 0 AND valor <= 100)
    ),
    CONSTRAINT promociones_vigencia_coherente CHECK (
        vigente_hasta IS NULL OR vigente_hasta >= vigente_desde
    )
);

CREATE INDEX IF NOT EXISTS idx_promociones_vigentes
    ON promociones (vigente_desde, vigente_hasta) WHERE activa;

-- A qué planes aplica. Vacío = a todos.
CREATE TABLE IF NOT EXISTS promocion_planes (
    promocion_id UUID NOT NULL REFERENCES promociones(id)       ON DELETE CASCADE,
    plan_id      UUID NOT NULL REFERENCES planes_velocidad(id)  ON DELETE CASCADE,
    PRIMARY KEY (promocion_id, plan_id)
);


-- =============================================================================
-- 2. Dónde queda registrada
-- =============================================================================
ALTER TABLE cotizaciones
    ADD COLUMN IF NOT EXISTS promocion_id UUID REFERENCES promociones(id) ON DELETE SET NULL,
    -- El nombre se copia, como el del plan: si la promo se borra o se renombra,
    -- la cotización que el cliente tiene en la mano tiene que seguir diciendo
    -- qué se le prometió.
    ADD COLUMN IF NOT EXISTS promocion_nombre VARCHAR(120);

ALTER TABLE prospectos
    ADD COLUMN IF NOT EXISTS promocion_id UUID REFERENCES promociones(id) ON DELETE SET NULL;

-- ── Los tres montos que produce una promoción ──
--
-- Una promo de tres meses tiene tres precios distintos, y la cotización tiene
-- que guardar los tres. Colapsarlos en uno es el malentendido que termina en
-- reclamo al cuarto mes: el cliente creía que ese era el precio.
--
-- Se guardan CALCULADOS, no se recalculan al leer. La alternativa —guardar el
-- `promocion_id` y volver a aplicar la fórmula cada vez que se abre la
-- cotización— significa que si mañana se corrige la promoción, cambia
-- retroactivamente lo que dice un papel que el cliente ya tiene en la mano.
ALTER TABLE cotizaciones
    -- Lo que paga mientras dura la promo. NULL = no hay promo sobre la
    -- mensualidad (`instalacion_gratis` entra acá).
    ADD COLUMN IF NOT EXISTS precio_promocional NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS meses_promocion    SMALLINT,
    -- La parte mensual del primer pago. Es 0 con `meses_gratis`, y es lo que
    -- hace que el total del primer pago dé bien sin meter la lógica de los
    -- cuatro tipos adentro de una vista.
    ADD COLUMN IF NOT EXISTS primer_mes         NUMERIC(10, 2);


-- `v_cotizaciones` se creó con `c.*`, y Postgres expande el asterisco al crear
-- la vista: las columnas de arriba no aparecerían solas. Se recrea igual que
-- estaba salvo por los totales, que ahora contemplan la promoción.
DROP VIEW IF EXISTS v_cotizaciones;
CREATE VIEW v_cotizaciones WITH (security_invoker = true) AS
SELECT
    c.*,
    COALESCE(p.nombre, c.nombre)               AS cliente,
    COALESCE(p.telefono, c.telefono)           AS contacto,
    COALESCE(p.sector, c.sector)               AS zona,
    TRIM(CONCAT(u.nombre, ' ', u.apellido))    AS vendedor,

    -- Lo que paga el primer mes: la instalación y el equipo son de una sola vez.
    -- `primer_mes` manda cuando está cargado; las cotizaciones viejas —que no lo
    -- tienen— siguen dando el mismo número que antes.
    (COALESCE(c.primer_mes, c.precio_mensual)
     + c.costo_instalacion + c.costo_equipo - c.descuento) AS total_primer_pago,
    -- Y lo que paga de ahí en adelante: el promocional mientras dure.
    COALESCE(c.precio_promocional, c.precio_mensual)       AS total_mensual,
    -- El precio de lista, para poder decir los dos.
    c.precio_mensual                                        AS mensual_normal,

    (c.creado_en::DATE + c.validez_dias)        AS vence_el,
    (c.creado_en::DATE + c.validez_dias) < CURRENT_DATE AS vencida,

    (c.convertida_en IS NOT NULL OR c.prospecto_id IS NOT NULL) AS con_prospecto
FROM cotizaciones c
LEFT JOIN prospectos p       ON p.id = c.prospecto_id
LEFT JOIN usuarios_sistema u ON u.id = COALESCE(c.vendedor_id, c.creado_por);


-- =============================================================================
-- 3. Las que se pueden vender hoy
-- =============================================================================
DROP VIEW IF EXISTS v_promociones_vigentes;
CREATE VIEW v_promociones_vigentes WITH (security_invoker = true) AS
SELECT
    p.*,
    -- Los planes a los que aplica, como arreglo. Vacío = todos.
    COALESCE(
        (SELECT ARRAY_AGG(pp.plan_id) FROM promocion_planes pp WHERE pp.promocion_id = p.id),
        ARRAY[]::UUID[]
    ) AS planes,
    (p.vigente_hasta IS NOT NULL AND p.vigente_hasta < CURRENT_DATE) AS vencida,
    -- Cuántos días le quedan. Sirve para que el vendedor sepa que está por
    -- terminarse y pueda usarlo como argumento — que es a lo que sirve una
    -- promo con fecha.
    CASE WHEN p.vigente_hasta IS NULL THEN NULL
         ELSE (p.vigente_hasta - CURRENT_DATE) END AS dias_restantes,
    (SELECT COUNT(*) FROM cotizaciones c WHERE c.promocion_id = p.id)  AS cotizada_veces,
    (SELECT COUNT(*) FROM prospectos pr
      WHERE pr.promocion_id = p.id AND pr.estado = 'ganado')            AS ventas_cerradas
FROM promociones p
WHERE p.activa
  AND p.vigente_desde <= CURRENT_DATE
  AND (p.vigente_hasta IS NULL OR p.vigente_hasta >= CURRENT_DATE);

COMMENT ON VIEW v_promociones_vigentes IS
    'Las que se pueden vender hoy. Las vencidas no aparecen: el vendedor no puede ofrecer lo que ya terminó.';

-- Todas, incluidas las vencidas, para la pantalla de administración y para
-- medir cuál funcionó.
DROP VIEW IF EXISTS v_promociones;
CREATE VIEW v_promociones WITH (security_invoker = true) AS
SELECT
    p.*,
    COALESCE(
        (SELECT ARRAY_AGG(pp.plan_id) FROM promocion_planes pp WHERE pp.promocion_id = p.id),
        ARRAY[]::UUID[]
    ) AS planes,
    (SELECT STRING_AGG(pl.nombre, ', ' ORDER BY pl.nombre)
       FROM promocion_planes pp JOIN planes_velocidad pl ON pl.id = pp.plan_id
      WHERE pp.promocion_id = p.id) AS planes_nombres,
    (p.vigente_hasta IS NOT NULL AND p.vigente_hasta < CURRENT_DATE) AS vencida,
    (p.activa AND p.vigente_desde <= CURRENT_DATE
     AND (p.vigente_hasta IS NULL OR p.vigente_hasta >= CURRENT_DATE)) AS vigente,
    (SELECT COUNT(*) FROM cotizaciones c WHERE c.promocion_id = p.id) AS cotizada_veces,
    (SELECT COUNT(*) FROM prospectos pr
      WHERE pr.promocion_id = p.id AND pr.estado = 'ganado')           AS ventas_cerradas
FROM promociones p;


-- =============================================================================
-- 4. La promo llega sola a la ficha del abonado
-- =============================================================================
-- Hoy el descuento se carga a mano después de que el cliente existe. Ese paso es
-- donde se pierde: el vendedor prometió tres meses al 50% y en la ficha quedó
-- 30%, o no quedó nada.
--
-- El disparador se cuelga de `instalaciones` y no de `clientes` porque es la
-- instalación la que sabe de qué prospecto viene, y `finalizar_alta_instalacion`
-- le pone el `client_id` justo después de crear al abonado.
--
-- ── Cómo se traduce cada tipo ──
--
-- La facturación solo entiende `promo_porcentaje` + `promo_meses`. Los cuatro
-- tipos se convierten a eso:
--
--   porcentaje         → el porcentaje tal cual.
--   meses_gratis       → 100% durante `valor` meses.
--   precio_fijo        → el porcentaje que hace falta para llegar a ese precio.
--   instalacion_gratis → NO toca la mensualidad. Solo afectó la cotización.
--
-- Traducirlo acá y no en la pantalla es lo que garantiza que lo cotizado y lo
-- facturado sean lo mismo.
CREATE OR REPLACE FUNCTION aplicar_promo_al_cliente()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_promo   RECORD;
    v_precio  NUMERIC;
    v_pct     NUMERIC;
    v_meses   INT;
BEGIN
    IF NEW.client_id IS NULL OR OLD.client_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT pr.* INTO v_promo
      FROM prospectos p
      JOIN promociones pr ON pr.id = p.promocion_id
     WHERE p.instalacion_id = NEW.id
     LIMIT 1;

    IF NOT FOUND THEN RETURN NEW; END IF;

    -- El precio de referencia es el TOTAL con IVA, que es sobre lo que se cotizó.
    SELECT precio_total INTO v_precio FROM v_planes WHERE id = NEW.plan_id;

    IF v_promo.tipo = 'porcentaje' THEN
        v_pct := v_promo.valor;
        v_meses := v_promo.meses_aplica;

    ELSIF v_promo.tipo = 'meses_gratis' THEN
        v_pct := 100;
        v_meses := v_promo.valor::INT;

    ELSIF v_promo.tipo = 'precio_fijo' AND COALESCE(v_precio, 0) > 0 THEN
        -- Cuánto hay que descontar para que quede en el precio prometido.
        v_pct := ROUND(GREATEST(0, (1 - v_promo.valor / v_precio) * 100), 2);
        v_meses := v_promo.meses_aplica;

    ELSE
        -- `instalacion_gratis` y cualquier caso sin precio de referencia: no hay
        -- nada que descontar de la mensualidad.
        RETURN NEW;
    END IF;

    UPDATE clientes
       SET promo_porcentaje = v_pct,
           promo_meses      = v_meses,
           -- Desde la activación, no desde la venta: el cliente empieza a pagar
           -- cuando tiene el servicio.
           promo_desde      = COALESCE(activado_en::DATE, CURRENT_DATE)
     WHERE id = NEW.client_id;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_aplicar_promo ON instalaciones;
CREATE TRIGGER trg_aplicar_promo
    AFTER UPDATE OF client_id ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION aplicar_promo_al_cliente();


-- =============================================================================
-- 5. La promo viaja de la cotización al prospecto
-- =============================================================================
-- `convertir_cotizacion_en_prospecto` ya existía; se le agrega el traspaso de la
-- promoción. Sin esto, convertir perdía justamente lo que se le había prometido.
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
        RETURN COALESCE(c.prospecto_id, c.convertida_en);
    END IF;

    IF NULLIF(BTRIM(COALESCE(c.nombre, '')), '') IS NULL THEN
        RAISE EXCEPTION 'La cotización no tiene nombre: no se puede crear el prospecto';
    END IF;

    INSERT INTO prospectos (
        nombre, telefono, sector, plan_id, promocion_id, origen, estado,
        vendedor_id, creado_por, notas
    ) VALUES (
        c.nombre, c.telefono, c.sector, c.plan_id, c.promocion_id, 'local', 'cotizado',
        COALESCE(c.vendedor_id, c.creado_por), c.creado_por,
        'Viene de la cotización N° ' || c.numero
    )
    RETURNING id INTO v_prospecto;

    UPDATE cotizaciones
       SET prospecto_id = v_prospecto,
           convertida_en = v_prospecto,
           estado = CASE WHEN estado = 'borrador' THEN 'enviada' ELSE estado END
     WHERE id = p_cotizacion;

    RETURN v_prospecto;
END $$;


-- =============================================================================
-- 6. Seguridad
-- =============================================================================
ALTER TABLE promociones      ENABLE ROW LEVEL SECURITY;
ALTER TABLE promocion_planes ENABLE ROW LEVEL SECURITY;

-- Leer: todo el personal. El vendedor tiene que ver qué puede ofrecer, y una
-- promoción no es un secreto — se publica.
DROP POLICY IF EXISTS promociones_lectura ON promociones;
CREATE POLICY promociones_lectura ON promociones
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS promocion_planes_lectura ON promocion_planes;
CREATE POLICY promocion_planes_lectura ON promocion_planes
    FOR SELECT TO authenticated USING (true);

-- Crear y modificar: solo quien configura el catálogo. Si un vendedor pudiera
-- crear promociones, podría inventarse el descuento que necesita para cerrar —
-- que es exactamente lo que este módulo viene a evitar.
DROP POLICY IF EXISTS promociones_escritura ON promociones;
CREATE POLICY promociones_escritura ON promociones
    FOR ALL TO authenticated
    USING (cartera_completa())
    WITH CHECK (cartera_completa());

DROP POLICY IF EXISTS promocion_planes_escritura ON promocion_planes;
CREATE POLICY promocion_planes_escritura ON promocion_planes
    FOR ALL TO authenticated
    USING (cartera_completa())
    WITH CHECK (cartera_completa());
