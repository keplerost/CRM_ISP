-- =============================================================================
-- Migración 141 — El contrato empieza en la venta, no en el alta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- Los datos que pide el contrato de adhesión —si el abonado es adulto mayor, si
-- acepta someterse a arbitraje, la parroquia— solo se podían cargar en la ficha
-- del abonado, que existe DESPUÉS del alta.
--
-- Pero quien los sabe es el vendedor, en la puerta de la casa, cuando vende. Si
-- ahí no hay dónde anotarlos, alguien tiene que volver a preguntarlos días
-- después por teléfono, y en la práctica nadie lo hace: el contrato se imprime
-- con los huecos.
--
-- ── Lo que cambia ──
--
-- La orden de trabajo guarda los mismos datos, y al dar de alta se copian a la
-- ficha. Lo que el vendedor anotó en la calle es lo que sale impreso.
--
-- Además se distingue TERCERA EDAD de DISCAPACIDAD. El formulario de la ARCOTEL
-- las junta en una sola casilla —"¿El Abonado es adulto mayor o discapacitado?"—
-- y eso es lo que se imprime, pero el ISP necesita saber cuál de las dos: los
-- descuentos que fija la ley no son los mismos, y "adulto mayor" se puede
-- deducir de la cédula mientras que la discapacidad necesita carné.
-- =============================================================================

-- =============================================================================
-- Qué condición tiene el abonado
-- =============================================================================
/**
 * `condicion_especial` es el detalle; `tarifa_preferencial` es lo que se marca
 * en el contrato.
 *
 * Son dos campos y no uno porque responden preguntas distintas: el formulario
 * pregunta SÍ o NO, y la oficina necesita saber por qué. Mantener solo el
 * booleano perdería el motivo; mantener solo el detalle obligaría a traducirlo
 * en cada lugar que imprime.
 *
 * El disparador de más abajo los mantiene de acuerdo, así que no pueden
 * contradecirse.
 */
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'condicion_abonado') THEN
        CREATE TYPE condicion_abonado AS ENUM (
            'ninguna', 'tercera_edad', 'discapacidad', 'ambas'
        );
    END IF;
END $$;

ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS condicion_especial condicion_abonado NOT NULL DEFAULT 'ninguna';

COMMENT ON COLUMN clientes.condicion_especial IS
    'Por qué le corresponde tarifa preferencial. El contrato solo imprime SÍ o NO; esto dice cuál de las dos.';


-- =============================================================================
-- Los mismos datos, en la orden de trabajo
-- =============================================================================
/**
 * La orden ya tenía `canton` y `sector`. Faltan los otros tres del domicilio.
 *
 * `sector` no se reusa como parroquia: son cosas distintas —el sector es cómo
 * lo llama el ISP para agrupar su red, la parroquia es una división política— y
 * en el contrato va la segunda.
 */
ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS provincia VARCHAR(60),
    ADD COLUMN IF NOT EXISTS ciudad    VARCHAR(60),
    ADD COLUMN IF NOT EXISTS parroquia VARCHAR(60),
    ADD COLUMN IF NOT EXISTS condicion_especial condicion_abonado NOT NULL DEFAULT 'ninguna',
    ADD COLUMN IF NOT EXISTS tarifa_preferencial BOOLEAN,
    ADD COLUMN IF NOT EXISTS acepta_arbitraje    BOOLEAN,
    ADD COLUMN IF NOT EXISTS equipo_modalidad VARCHAR(14) NOT NULL DEFAULT 'arrendamiento';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instalaciones_equipo_modalidad_check') THEN
        ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_equipo_modalidad_check
            CHECK (equipo_modalidad IN ('arrendamiento', 'compra'));
    END IF;
END $$;


-- =============================================================================
-- El arbitraje que viene propuesto
-- =============================================================================
/**
 * ── Por qué esto es una preferencia del ISP y no un valor fijo ──
 *
 * El ISP puede querer que sus contratos salgan con el arbitraje ya aceptado, y
 * es una decisión legítima: se lo propone al abonado y este firma o no firma.
 *
 * Pero no puede ser un `DEFAULT TRUE` en la columna, y la diferencia importa:
 * el contrato dice que el Abonado "deberá señalarlo en forma expresa" y que
 * someterse "puede significar costos en los que debe incurrir el Abonado".
 * Además tiene su propia raya de firma, separada de las del pie.
 *
 * Con esto, el formulario del vendedor aparece con SÍ ya elegido —que es lo que
 * el ISP quiere— pero sigue siendo una respuesta que alguien confirmó en la
 * pantalla y que el abonado firma aparte. Si el abonado se niega, el vendedor lo
 * cambia ahí mismo.
 */
ALTER TABLE prestadores
    ADD COLUMN IF NOT EXISTS arbitraje_por_defecto BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN prestadores.arbitraje_por_defecto IS
    'Con qué valor aparece propuesta la casilla de arbitraje al vender. El abonado la firma aparte.';


-- =============================================================================
-- Que el detalle y la casilla no se contradigan
-- =============================================================================
/**
 * Si alguien marca "tercera edad", la casilla del contrato queda en SÍ.
 *
 * Sin esto, se podría guardar un abonado marcado como adulto mayor cuyo contrato
 * imprime NO en la casilla de tarifa preferencial. Nadie lo notaría hasta que el
 * abonado reclamara el descuento que le corresponde.
 *
 * Al revés no se fuerza: `tarifa_preferencial` puede quedar en SÍ con la
 * condición en 'ninguna', porque hay motivos que este catálogo no cubre y el
 * formulario admite un SÍ sin explicar por qué.
 */
CREATE OR REPLACE FUNCTION sincronizar_tarifa_preferencial()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.condicion_especial <> 'ninguna' THEN
        NEW.tarifa_preferencial := TRUE;
    ELSIF TG_OP = 'UPDATE' AND OLD.condicion_especial <> 'ninguna' THEN
        -- Se le quitó la condición: la casilla vuelve a NO, no a "sin responder".
        -- Alguien la respondió y la respuesta ahora es que no le corresponde.
        NEW.tarifa_preferencial := FALSE;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_tarifa_preferencial_cliente ON clientes;
CREATE TRIGGER trg_tarifa_preferencial_cliente
    BEFORE INSERT OR UPDATE OF condicion_especial ON clientes
    FOR EACH ROW EXECUTE FUNCTION sincronizar_tarifa_preferencial();

DROP TRIGGER IF EXISTS trg_tarifa_preferencial_orden ON instalaciones;
CREATE TRIGGER trg_tarifa_preferencial_orden
    BEFORE INSERT OR UPDATE OF condicion_especial ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION sincronizar_tarifa_preferencial();


-- =============================================================================
-- Que lo del vendedor llegue a la ficha
-- =============================================================================
/**
 * ── Por qué se extiende el disparador y no la función de alta ──
 *
 * `finalizar_alta_instalacion` es una función larga que ya pasó por seis
 * migraciones. Reescribirla entera para agregarle siete columnas es la manera
 * más fácil de romper algo que hoy funciona.
 *
 * `instalacion_actualiza_cliente` ya existe desde la 31 y ya hace exactamente
 * esto: copiar de la orden a la ficha lo que quedó al cerrar el trabajo. Agregar
 * los datos del contrato ahí es una línea más en el lugar donde ya vive esa
 * responsabilidad.
 *
 * Se copia con COALESCE en el sentido "la orden manda si dijo algo": el vendedor
 * preguntó en la casa, y eso vale más que un campo que quedó vacío en la ficha.
 * Pero lo que la orden dejó en blanco NO pisa lo que la oficina ya había
 * corregido.
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
               -- Lo que levantó el vendedor para el contrato.
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
               equipo_modalidad    = COALESCE(NEW.equipo_modalidad, equipo_modalidad)
         WHERE id = NEW.client_id;
    END IF;

    IF NEW.tipo = 'retiro' THEN
        UPDATE clientes SET estado = 'baja' WHERE id = NEW.client_id;
    END IF;

    RETURN NEW;
END $$;


-- =============================================================================
-- Que la orden pueda mostrarlos
-- =============================================================================
/**
 * Se envuelve `v_instalaciones` agregando las columnas nuevas.
 *
 * Es el mismo patrón de la 89 y la 91: se lee la definición vigente y se la
 * envuelve, en vez de reescribirla. Cualquier otra migración que haya agregado
 * columnas antes las conserva.
 */
DO $guarda$
DECLARE v_def TEXT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'v_instalaciones' AND column_name = 'acepta_arbitraje'
    ) THEN
        RAISE NOTICE 'v_instalaciones ya expone los datos del contrato: no se toca.';
        RETURN;
    END IF;

    SELECT pg_get_viewdef('v_instalaciones'::regclass, true) INTO v_def;
    EXECUTE 'CREATE OR REPLACE VIEW v_instalaciones WITH (security_invoker = true) AS '
         || 'SELECT v.*, ins.provincia, ins.ciudad, ins.parroquia, '
         || 'ins.condicion_especial, ins.tarifa_preferencial, ins.acepta_arbitraje, '
         || 'ins.equipo_modalidad '
         || 'FROM (' || rtrim(v_def, ';') || ') v '
         || 'JOIN instalaciones ins ON ins.id = v.id';
    RAISE NOTICE 'v_instalaciones expone los datos del contrato de adhesion.';
END $guarda$;

DO $$
DECLARE v_inv TEXT;
BEGIN
    SELECT COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                      WHERE option_name = 'security_invoker'), 'off')
      INTO v_inv FROM pg_class c WHERE c.relname = 'v_instalaciones' AND c.relkind = 'v';
    IF v_inv = 'true' THEN
        RAISE NOTICE 'COMPROBADO: v_instalaciones sigue aplicando RLS.';
    ELSE
        RAISE WARNING 'PELIGRO: v_instalaciones NO aplica RLS. Corre: ALTER VIEW v_instalaciones SET (security_invoker = true);';
    END IF;
END $$;


/**
 * Y que la ficha del abonado exponga la condición.
 *
 * Mismo motivo de siempre: guardar sin poder releer se ve igual que no guardar.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'condicion_especial'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone la condicion del abonado: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS '
         || 'SELECT v.*, cl.condicion_especial '
         || 'FROM (' || rtrim(pg_get_viewdef('v_clientes_ficha'::regclass, true), ';') || ') v '
         || 'JOIN clientes cl ON cl.id = v.id';
    RAISE NOTICE 'v_clientes_ficha expone la condicion del abonado.';
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Marcar una orden y ver que la casilla del contrato se pone sola:
--   UPDATE instalaciones SET condicion_especial = 'tercera_edad' WHERE numero = 1186;
--   SELECT condicion_especial, tarifa_preferencial FROM instalaciones WHERE numero = 1186;
--   -- tiene que dar tercera_edad / true
--
--   -- Con qué valor aparece propuesto el arbitraje:
--   SELECT razon_social, arbitraje_por_defecto FROM prestadores;
