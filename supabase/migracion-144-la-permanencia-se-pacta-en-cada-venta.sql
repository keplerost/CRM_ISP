-- =============================================================================
-- Migración 144 — La permanencia se pacta en cada venta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que estaba mal planteado ──
--
-- La permanencia mínima y el valor de instalación se guardaban en el PRESTADOR,
-- como si fueran una política única del ISP. No lo son: son la contrapartida de
-- un trato, y el trato cambia en cada venta.
--
--   El que PAGA la instalación no se ata a nada. Ya puso el dinero; exigirle
--   además dos años de permanencia sería cobrarle dos veces lo mismo.
--
--   El que NO la paga se acoge a la permanencia. La instalación gratis es
--   justamente el beneficio que la cláusula quinta declara a cambio.
--
--   Un local comercial puede pactar un año con instalación gratis, que no es
--   ninguna de las dos anteriores.
--
-- Con un solo valor en el prestador, los tres firmaban el mismo contrato: el que
-- pagó la instalación quedaba atado 24 meses sin haber recibido el beneficio, y
-- eso es lo que un abonado puede impugnar.
--
-- ── Lo que hace esta migración ──
--
-- Los mueve al abonado y a la orden, dejando el del prestador como valor
-- sugerido. Vacío = se usa el del prestador, que es lo que vale hoy para todos.
-- =============================================================================

/**
 * `NULL` no es cero, y la diferencia es todo.
 *
 * NULL   = no se pactó nada distinto; vale lo que diga el prestador.
 * 0      = se pactó expresamente que NO hay permanencia, o que la instalación no
 *          se cobra.
 *
 * Un DEFAULT 0 diría que todos los abonados de hoy pactaron no tener
 * permanencia, y eso no es lo que firmaron.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS permanencia_meses INT
        CHECK (permanencia_meses IS NULL OR permanencia_meses >= 0),
    ADD COLUMN IF NOT EXISTS valor_instalacion NUMERIC(12,2)
        CHECK (valor_instalacion IS NULL OR valor_instalacion >= 0);

ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS permanencia_meses INT
        CHECK (permanencia_meses IS NULL OR permanencia_meses >= 0),
    ADD COLUMN IF NOT EXISTS valor_instalacion NUMERIC(12,2)
        CHECK (valor_instalacion IS NULL OR valor_instalacion >= 0);

COMMENT ON COLUMN clientes.permanencia_meses IS
    'Permanencia pactada con ESTE abonado. NULL = la del prestador. 0 = se pactó sin permanencia (paga la instalación).';

COMMENT ON COLUMN clientes.valor_instalacion IS
    'Lo que se le cobró de instalación. NULL = el del prestador. 0 = instalación gratis.';


-- =============================================================================
-- Que lo pactado en la venta llegue a la ficha
-- =============================================================================
CREATE OR REPLACE FUNCTION instalacion_actualiza_cliente()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.client_id IS NULL OR NEW.estado <> 'hecha' THEN
        RETURN NEW;
    END IF;

    IF NEW.tipo IN ('nueva', 'traslado') THEN
        UPDATE clientes
           SET fecha_instalacion = NEW.fecha,
               estado = CASE WHEN NEW.tipo = 'nueva' THEN 'activo' ELSE estado END,
               direccion = COALESCE(NEW.direccion, direccion),
               latitud   = COALESCE(NEW.latitud, latitud),
               longitud  = COALESCE(NEW.longitud, longitud),
               provincia = COALESCE(NEW.provincia, provincia),
               canton    = COALESCE(NEW.canton, canton),
               ciudad    = COALESCE(NEW.ciudad, ciudad),
               parroquia = COALESCE(NEW.parroquia, parroquia),
               condicion_especial = CASE
                   WHEN NEW.condicion_especial <> 'ninguna' THEN NEW.condicion_especial
                   ELSE condicion_especial
               END,
               tarifa_preferencial = COALESCE(NEW.tarifa_preferencial, tarifa_preferencial),
               acepta_arbitraje    = COALESCE(NEW.acepta_arbitraje, acepta_arbitraje),
               equipo_modalidad    = COALESCE(NEW.equipo_modalidad, equipo_modalidad),
               red_acceso  = COALESCE(NEW.red_acceso, red_acceso),
               tipo_cuenta = COALESCE(NEW.tipo_cuenta, tipo_cuenta),
               -- Lo pactado en la venta. Es de las cosas que MÁS importa que
               -- viajen: define a qué se ató el abonado y qué se le cobró.
               permanencia_meses = COALESCE(NEW.permanencia_meses, permanencia_meses),
               valor_instalacion = COALESCE(NEW.valor_instalacion, valor_instalacion)
         WHERE id = NEW.client_id;
    END IF;

    IF NEW.tipo = 'retiro' THEN
        UPDATE clientes SET estado = 'baja' WHERE id = NEW.client_id;
    END IF;

    RETURN NEW;
END $$;


-- =============================================================================
-- Que las pantallas puedan verlos
-- =============================================================================
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'v_instalaciones' AND column_name = 'permanencia_meses'
    ) THEN
        RAISE NOTICE 'v_instalaciones ya expone la permanencia: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_instalaciones WITH (security_invoker = true) AS '
         || 'SELECT v.*, ip.permanencia_meses, ip.valor_instalacion '
         || 'FROM (' || rtrim(pg_get_viewdef('v_instalaciones'::regclass, true), ';') || ') v '
         || 'JOIN instalaciones ip ON ip.id = v.id';
    RAISE NOTICE 'v_instalaciones expone la permanencia y el valor de instalacion.';
END $guarda$;

DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'permanencia_meses'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone la permanencia: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS '
         || 'SELECT v.*, cp.permanencia_meses, cp.valor_instalacion '
         || 'FROM (' || rtrim(pg_get_viewdef('v_clientes_ficha'::regclass, true), ';') || ') v '
         || 'JOIN clientes cp ON cp.id = v.id';
    RAISE NOTICE 'v_clientes_ficha expone la permanencia y el valor de instalacion.';
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Qué se pactó con cada quien, y quiénes siguen con lo del prestador:
--   SELECT nombre,
--          COALESCE(permanencia_meses::TEXT, '(la del prestador)') AS permanencia,
--          COALESCE(valor_instalacion::TEXT, '(el del prestador)') AS instalacion
--     FROM clientes WHERE estado <> 'baja' LIMIT 20;
--
--   -- Los que pagaron la instalación no deberían tener permanencia:
--   SELECT nombre, valor_instalacion, permanencia_meses
--     FROM clientes
--    WHERE valor_instalacion > 0 AND permanencia_meses > 0;
--   -- si sale alguno, es un contrato que cobra dos veces lo mismo
