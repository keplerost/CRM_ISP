-- =============================================================================
-- Migración 143 — La red de acceso y el tipo de cuenta se eligen
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué se estaba adivinando ──
--
-- El anexo 1f pide dos cosas que el sistema venía DEDUCIENDO:
--
--   LA RED DE ACCESO. El anexo ofrece cinco —par de cobre, fibra óptica,
--   coaxial, inalámbrico y otros— y el sistema marcaba fibra si el abonado tenía
--   ONT, e inalámbrico en cualquier otro caso. El que da servicio por coaxial o
--   por par de cobre firmaba un contrato que decía "Inalámbrico".
--
--   EL TIPO DE CUENTA. El anexo ofrece cuatro —residencial, corporativo,
--   cibercafé y otros tipos— y se sacaba de la categoría del plan, que solo
--   tiene tres y no incluye cibercafé. El cibercafé firmaba como residencial.
--
-- ── Por qué van en el abonado y no en el plan ──
--
-- Porque describen a QUIÉN se le vende, no QUÉ se le vende. El mismo plan de
-- 150 megas se le vende a una casa y a un cibercafé; el mismo plan se entrega
-- por fibra en el centro y por inalámbrico en el campo. Atarlo al plan obligaría
-- a duplicar cada plan por cada combinación.
--
-- ── Y por qué se pueden dejar vacíos ──
--
-- Porque la deducción de hoy acierta en la mayoría de los casos, y obligar a
-- responder dos campos más en cada alta para confirmar lo que el sistema ya sabe
-- es la clase de fricción que termina en que alguien elija cualquier cosa para
-- salir del paso. Vacío = se deduce como hasta ahora; lleno = manda lo elegido.
-- =============================================================================

/**
 * Las cinco redes de acceso del anexo, y los cuatro tipos de cuenta.
 *
 * Se guardan como claves y no como el texto impreso: el contrato puede cambiar
 * de redacción —"Fibra óptica" y "FIBRA ÓPTICA" son el mismo dato— y comparar
 * contra un texto con tilde en el código es una fuente de errores silenciosos.
 */
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'red_de_acceso') THEN
        CREATE TYPE red_de_acceso AS ENUM (
            'par_cobre', 'fibra', 'coaxial', 'inalambrico', 'otros'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tipo_de_cuenta') THEN
        CREATE TYPE tipo_de_cuenta AS ENUM (
            'residencial', 'corporativo', 'cibercafe', 'otros'
        );
    END IF;
END $$;

/**
 * Sin valor por defecto, y esa es la decisión importante.
 *
 * NULL significa "que lo deduzca el sistema, como hasta ahora". Un DEFAULT
 * 'fibra' pondría esa palabra en el contrato de todos los abonados
 * inalámbricos que nadie revisó, y quedaría escrito como si alguien lo hubiera
 * elegido.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS red_acceso  red_de_acceso,
    ADD COLUMN IF NOT EXISTS tipo_cuenta tipo_de_cuenta;

ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS red_acceso  red_de_acceso,
    ADD COLUMN IF NOT EXISTS tipo_cuenta tipo_de_cuenta;

COMMENT ON COLUMN clientes.red_acceso IS
    'Red de acceso que declara el anexo 1f. NULL = se deduce de la tecnología del abonado.';

COMMENT ON COLUMN clientes.tipo_cuenta IS
    'Tipo de cuenta del anexo 1f. NULL = se deduce de la categoría del plan.';


-- =============================================================================
-- Que lo del vendedor llegue a la ficha
-- =============================================================================
/**
 * Se le agregan los dos campos al mismo disparador de la 141.
 *
 * Misma regla: lo que la orden dejó vacío no pisa lo que la oficina corrigió.
 */
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
               -- Lo de esta migración.
               red_acceso  = COALESCE(NEW.red_acceso, red_acceso),
               tipo_cuenta = COALESCE(NEW.tipo_cuenta, tipo_cuenta)
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
         WHERE table_name = 'v_instalaciones' AND column_name = 'red_acceso'
    ) THEN
        RAISE NOTICE 'v_instalaciones ya expone la red de acceso: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_instalaciones WITH (security_invoker = true) AS '
         || 'SELECT v.*, ia.red_acceso, ia.tipo_cuenta '
         || 'FROM (' || rtrim(pg_get_viewdef('v_instalaciones'::regclass, true), ';') || ') v '
         || 'JOIN instalaciones ia ON ia.id = v.id';
    RAISE NOTICE 'v_instalaciones expone la red de acceso y el tipo de cuenta.';
END $guarda$;

DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'red_acceso'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone la red de acceso: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS '
         || 'SELECT v.*, ca.red_acceso, ca.tipo_cuenta '
         || 'FROM (' || rtrim(pg_get_viewdef('v_clientes_ficha'::regclass, true), ';') || ') v '
         || 'JOIN clientes ca ON ca.id = v.id';
    RAISE NOTICE 'v_clientes_ficha expone la red de acceso y el tipo de cuenta.';
END $guarda$;

DO $$
DECLARE v_inv TEXT;
BEGIN
    FOR v_inv IN SELECT unnest(ARRAY['v_instalaciones', 'v_clientes_ficha']) LOOP
        IF COALESCE((SELECT option_value FROM pg_class c,
                            pg_options_to_table(c.reloptions)
                      WHERE c.relname = v_inv AND option_name = 'security_invoker'), 'off') <> 'true'
        THEN
            RAISE WARNING 'PELIGRO: % NO aplica RLS. Corre: ALTER VIEW % SET (security_invoker = true);',
                v_inv, v_inv;
        ELSE
            RAISE NOTICE 'COMPROBADO: % sigue aplicando RLS.', v_inv;
        END IF;
    END LOOP;
END $$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Cuántos abonados tienen la red declarada y cuántos se deducen:
--   SELECT COALESCE(red_acceso::TEXT, '(se deduce)') AS red, COUNT(*)
--     FROM clientes WHERE estado <> 'baja' GROUP BY 1 ORDER BY 2 DESC;
--
--   -- Y los cibercafés, que antes firmaban como residenciales:
--   SELECT nombre FROM clientes WHERE tipo_cuenta = 'cibercafe';
