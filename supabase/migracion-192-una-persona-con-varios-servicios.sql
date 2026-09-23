-- =============================================================================
-- Migración 192 — Una persona, varios servicios
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- Una persona con dos servicios —la casa y el local, o la casa y la de la
-- madre— no es un caso raro en un ISP. Es de todos los meses.
--
-- Pero `idx_clientes_identificacion_unica` impide dos abonados activos con la
-- misma cédula, así que el segundo servicio se cargaba como se podía: el nombre
-- con un "-2" pegado al apellido y la cédula vacía, porque el índice la
-- rechazaba.
--
-- Eso rompe tres cosas a la vez, y ninguna se ve hasta que se necesita:
--
--   · La FACTURA sale a nombre de "JUAN PEREZ-2" y sin dirección. El nombre y
--     la dirección se toman de la ficha tal cual están.
--   · El CONTRATO de ARCOTEL no se puede emitir: exige identificación.
--   · El PORTAL no lo deja entrar, porque reconoce al abonado por su cédula.
--
-- ── Por qué existía el índice ──
--
-- No era capricho. El portal busca al abonado por su cédula con `maybeSingle()`,
-- que falla si hay más de una fila. Con dos fichas iguales el ingreso quedaba
-- ambiguo: no había forma de saber cuál cuenta abrir.
--
-- Esa parte se resuelve en el middleware, que ahora lista los servicios de la
-- persona y abre la sesión sobre uno, con posibilidad de cambiar entre ellos
-- sin volver a autenticarse. Acá solo se saca la barrera.
--
-- ── Lo que se pierde, y cómo se compensa ──
--
-- Sin índice único, la base ya no impide cargar dos veces a la MISMA persona
-- por error. Es una pérdida real.
--
-- Se compensa donde corresponde: al dar de alta, la pantalla avisa que esa
-- cédula ya tiene servicios y muestra cuáles, para que quien carga decida si
-- está duplicando o agregando. Un aviso que se puede leer es mejor que un
-- rechazo que obliga a inventar un "-2".
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La cédula puede repetirse
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_clientes_identificacion_unica;

-- Se conserva el índice, sin la unicidad: el portal busca por este campo en
-- cada ingreso y sin índice sería un recorrido de toda la tabla.
CREATE INDEX IF NOT EXISTS idx_clientes_identificacion
    ON clientes (identificacion)
    WHERE identificacion IS NOT NULL AND identificacion <> '';


-- -----------------------------------------------------------------------------
-- 2. Cómo se distingue un servicio de otro
-- -----------------------------------------------------------------------------

/**
 * Para qué es este servicio: "Casa", "Local", "Bodega".
 *
 * Es lo que se intentaba decir con el "-2" del nombre, pero en su propio campo.
 * La diferencia importa: el nombre se imprime en la factura y en el contrato, y
 * esto no sale en ningún documento — se ve solo en las pantallas internas.
 *
 * Queda libre a propósito. Cada ISP nombra distinto lo mismo, y una lista
 * cerrada obliga a elegir mal cuando aparece el caso que no estaba previsto.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS referencia_servicio TEXT;

COMMENT ON COLUMN clientes.referencia_servicio IS
    'Para qué es este servicio (Casa, Local, Bodega). Uso interno: NO sale en factura ni contrato.';


-- -----------------------------------------------------------------------------
-- 3. Que el listado pueda verla
-- -----------------------------------------------------------------------------
-- `v_clientes_ficha` es lo que lee la pantalla de abonados, y NO hereda las
-- columnas nuevas: su `SELECT c.*` se expandió a una lista fija el día que se
-- creó. Agregar la columna a la tabla y no a la vista deja el campo invisible,
-- sin ningún error — el mismo problema que costó la migración 189.
--
-- Se usa el patrón de la 144: envolver la definición actual y sumar la columna
-- al final con un JOIN de vuelta a `clientes`. Así no hay que repetir la lista
-- entera —que ya pasó de setenta columnas— ni arriesgarse a perder alguna por
-- el camino. Y `CREATE OR REPLACE` lo acepta porque la nueva va última: solo
-- se pueden agregar columnas al final, nunca en el medio.

DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'referencia_servicio'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone la referencia del servicio: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS '
         || 'SELECT v.*, rs.referencia_servicio '
         || 'FROM (' || rtrim(pg_get_viewdef('v_clientes_ficha'::regclass, true), ';') || ') v '
         || 'JOIN clientes rs ON rs.id = v.id';
    RAISE NOTICE 'v_clientes_ficha expone la referencia del servicio.';
END $guarda$;


-- -----------------------------------------------------------------------------
-- 4. Limpiar lo que se cargó con el "-2"
-- -----------------------------------------------------------------------------
-- Solo informa. La corrección no se hace sola a propósito: hay que decidir caso
-- por caso cuál es la cédula y la dirección de cada servicio, y eso no se puede
-- adivinar desde acá.
--
-- Lo que devuelve esta consulta es la lista de fichas a revisar: sacarles el
-- sufijo del nombre, ponerles su cédula —que ahora sí se puede repetir— y su
-- dirección.

SELECT id,
       nombre,
       identificacion,
       direccion,
       ip,
       'Sacar el sufijo del nombre, cargar cédula y dirección' AS que_hacer
  FROM clientes
 WHERE nombre ~ '-[0-9]+$'
    OR (identificacion IS NULL OR identificacion = '')
 ORDER BY nombre;
