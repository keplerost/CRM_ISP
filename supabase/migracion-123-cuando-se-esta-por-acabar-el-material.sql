-- =============================================================================
-- Migración 123 — Cuando se está por acabar el material
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── El problema ──
--
-- `articulos.stock_minimo` existe desde la 69 y se puede cargar desde la
-- pantalla de stock. No lo mira nadie. Es un número que se escribe y que no
-- produce ningún efecto: el material se acaba igual y se descubre el día que el
-- técnico llega al poste sin conector.
--
-- ── Por qué el mínimo no puede ser uno solo ──
--
-- Porque la bodega y la mochila del técnico no se miden con la misma vara. La
-- bodega necesita avisar cuando quedan 20 ONTs; el técnico, cuando le quedan 2.
-- Con un único mínimo por artículo pasa una de dos cosas: o el técnico vive en
-- alerta permanente porque nunca va a tener 20 ONTs encima, o el aviso de la
-- bodega se pone tan bajo que llega tarde.
--
-- Por eso el mínimo es por ALMACÉN, con el del artículo como respaldo para las
-- bodegas. Un almacén de técnico sin mínimo propio no alerta: no tiene sentido
-- reclamarle que ande con stock de depósito.
--
-- ── A quién le llega ──
--
-- El aviso de una bodega va a quien puede reponerla. El del almacén de un
-- técnico va al técnico —que es el que tiene que pedir material antes de salir—
-- y también a inventario, porque el que despacha necesita saber que va a tener
-- que preparar un pedido.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_minimos (
    almacen_id  UUID NOT NULL REFERENCES almacenes(id) ON DELETE CASCADE,
    articulo_id UUID NOT NULL REFERENCES articulos(id) ON DELETE CASCADE,

    -- Cuándo avisar. 0 es distinto de NULL: 0 significa "avisame apenas se
    -- acabe", y no tener fila significa "no controles este artículo acá".
    minimo      NUMERIC(12, 2) NOT NULL CHECK (minimo >= 0),

    -- Cuánto conviene reponer de una. Sin esto el aviso dice "faltan 3" y quien
    -- arma el pedido igual tiene que preguntar cuántos pedir.
    reponer     NUMERIC(12, 2) CHECK (reponer IS NULL OR reponer > 0),

    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (almacen_id, articulo_id)
);

COMMENT ON TABLE stock_minimos IS
    'El mínimo de cada artículo en cada almacén. La bodega y la mochila del técnico no se miden igual.';

ALTER TABLE stock_minimos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_stock_minimos" ON stock_minimos;
CREATE POLICY "auth_all_stock_minimos" ON stock_minimos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Lo que está por acabarse
-- =============================================================================
/**
 * Cada artículo de cada almacén que está en o por debajo de su mínimo.
 *
 * Se usa `<=` y no `<`: quedar exactamente en el mínimo YA es la señal. El
 * mínimo es el punto de reposición, no el punto de emergencia — si se avisara
 * al bajar de él, el aviso llegaría con una unidad de atraso, y con material que
 * tarda una semana en llegar esa unidad es una instalación que no se hace.
 *
 * Los almacenes inactivos y los artículos dados de baja no aparecen: nadie va a
 * reponer una bodega que se cerró.
 */
CREATE OR REPLACE VIEW v_stock_bajo WITH (security_invoker = true) AS
SELECT
    al.id            AS almacen_id,
    al.nombre        AS almacen,
    al.tipo          AS almacen_tipo,
    al.tecnico_id,
    t.nombre         AS tecnico,
    ar.id            AS articulo_id,
    ar.nombre        AS articulo,
    ar.codigo,
    ar.categoria,
    ar.unidad,
    COALESCE(ex.cantidad, 0)               AS cantidad,
    COALESCE(sm.minimo, ar.stock_minimo)   AS minimo,
    -- Cuánto falta para volver al mínimo. Es el número que va en el pedido.
    GREATEST(COALESCE(sm.minimo, ar.stock_minimo) - COALESCE(ex.cantidad, 0), 0) AS falta,
    COALESCE(sm.reponer, GREATEST(COALESCE(sm.minimo, ar.stock_minimo) - COALESCE(ex.cantidad, 0), 0)) AS sugerido,
    -- De dónde salió el mínimo, para poder entender un aviso que sorprenda.
    (sm.minimo IS NOT NULL)                AS minimo_propio,
    (COALESCE(ex.cantidad, 0) <= 0)        AS agotado
FROM almacenes al
CROSS JOIN articulos ar
LEFT JOIN existencias ex   ON ex.almacen_id = al.id AND ex.articulo_id = ar.id
LEFT JOIN stock_minimos sm ON sm.almacen_id = al.id AND sm.articulo_id = ar.id
LEFT JOIN tecnicos t       ON t.id = al.tecnico_id
WHERE al.activo
  AND ar.activo
  /**
   * Qué mínimo rige acá.
   *
   * Si el almacén tiene el suyo, ese. Si no, el del artículo — pero SOLO en
   * bodegas y sucursales. Un técnico o un vehículo sin mínimo propio no se
   * controla: medirle la mochila contra el mínimo del depósito lo dejaría en
   * alerta permanente, y una alerta que suena siempre no la mira nadie.
   */
  AND COALESCE(sm.minimo, CASE WHEN al.tipo IN ('bodega', 'sucursal') THEN ar.stock_minimo END) IS NOT NULL
  AND COALESCE(ex.cantidad, 0) <= COALESCE(sm.minimo, ar.stock_minimo)
  /**
   * Y que este almacén tenga algo que ver con este artículo.
   *
   * Sin esta condición, poner un mínimo global a un artículo lo reclama en TODA
   * bodega que exista, incluidas las que nunca lo tuvieron ni lo van a tener: la
   * sucursal que solo guarda herramientas pediría conectores de fibra. El aviso
   * se llenaría de renglones que nadie va a atender, y el que sí importa se
   * perdería en el medio.
   *
   * Tener una fila en `existencias` —aunque hoy diga cero— significa que ese
   * material pasó por acá alguna vez. Y un mínimo propio es alguien diciendo
   * explícitamente que acá se controla.
   */
  AND (ex.articulo_id IS NOT NULL OR sm.articulo_id IS NOT NULL);

COMMENT ON VIEW v_stock_bajo IS
    'Artículos en o por debajo de su mínimo, por almacén. El mínimo del almacén manda; el del artículo es el respaldo y solo aplica a bodegas.';


-- =============================================================================
-- El aviso
-- =============================================================================
/**
 * Avisa de lo que está por acabarse.
 *
 * ── Por qué un aviso por almacén y no uno por artículo ──
 *
 * Porque una bodega a la que se le acabaron ocho cosas produciría ocho
 * notificaciones idénticas, y a la tercera nadie las lee. Se manda una por
 * almacén, con la lista adentro: es un pedido de material, y un pedido es una
 * lista.
 *
 * Devuelve cuántos avisos mandó, para poder correrla a mano y ver que hizo algo.
 */
CREATE OR REPLACE FUNCTION avisar_stock_bajo()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    a         RECORD;
    u         RECORD;
    v_lista   TEXT;
    v_cuantos INT;
    v_avisos  INT := 0;
    v_titulo  TEXT;
BEGIN
    FOR a IN
        SELECT
            b.almacen_id,
            b.almacen,
            b.almacen_tipo,
            b.tecnico_id,
            COUNT(*)                                    AS cuantos,
            COUNT(*) FILTER (WHERE b.agotado)           AS agotados,
            STRING_AGG(
                b.articulo || ': ' || b.cantidad || ' ' || b.unidad ||
                CASE WHEN b.sugerido > 0
                     THEN ' (pedir ' || TRIM(TO_CHAR(b.sugerido, 'FM999999990.99')) || ')'
                     ELSE '' END,
                E'\n' ORDER BY b.agotado DESC, b.articulo
            )                                           AS lista
        FROM v_stock_bajo b
        GROUP BY b.almacen_id, b.almacen, b.almacen_tipo, b.tecnico_id
    LOOP
        v_cuantos := a.cuantos;
        v_lista := a.lista;

        v_titulo := CASE
            WHEN a.agotados > 0 THEN 'Sin material en ' || a.almacen
            ELSE 'Se está acabando el material en ' || a.almacen
        END;

        /**
         * Al técnico, si el almacén es suyo.
         *
         * Es el que tiene que pedir el material ANTES de salir a la ruta. Que
         * se entere por el aviso y no en el poste es la diferencia entre pasar
         * por la bodega a la mañana y perder la instalación.
         */
        IF a.tecnico_id IS NOT NULL THEN
            FOR u IN
                SELECT us.id FROM usuarios_sistema us
                 WHERE us.activo AND us.tecnico_id = a.tecnico_id
            LOOP
                PERFORM notificar(
                    u.id,
                    'stock_bajo',
                    'Te queda poco material',
                    'Antes de salir, pedí en bodega:' || E'\n' || v_lista,
                    '/campo/mi-almacen',
                    'almacen',
                    a.almacen_id::TEXT
                );
                v_avisos := v_avisos + 1;
            END LOOP;
        END IF;

        -- Y a los que reponen. También cuando el almacén es de un técnico: el
        -- que despacha necesita saber que va a tener que preparar ese pedido.
        FOR u IN
            SELECT us.id FROM usuarios_sistema us
             WHERE us.activo
               AND (us.permisos ? '*' OR us.permisos ? 'inventario.gestionar'
                    OR us.permisos ? 'inventario.ver')
        LOOP
            PERFORM notificar(
                u.id,
                'stock_bajo',
                v_titulo,
                v_cuantos || CASE WHEN v_cuantos = 1 THEN ' artículo' ELSE ' artículos' END ||
                ' en el mínimo o por debajo:' || E'\n' || v_lista,
                '/inventario/stock',
                'almacen',
                a.almacen_id::TEXT
            );
            v_avisos := v_avisos + 1;
        END LOOP;
    END LOOP;

    RETURN JSONB_BUILD_OBJECT('avisos', v_avisos);
END $$;

COMMENT ON FUNCTION avisar_stock_bajo IS
    'Un aviso por almacén con la lista de lo que falta. Al técnico si el almacén es suyo, y siempre a quien repone.';


-- =============================================================================
-- La tarea programada
-- =============================================================================
-- Apagada de fábrica, como el resto: se enciende desde Ajustes → Tareas cuando
-- el ISP decide, no el día que corre la migración.
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS stock_automatico BOOLEAN DEFAULT FALSE;
ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS stock_hora VARCHAR(5) DEFAULT '07:00';

COMMENT ON COLUMN config_tareas.stock_hora IS
    'A qué hora revisar el stock. Temprano a propósito: el aviso sirve si llega antes de que el técnico salga a la ruta.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Qué está por acabarse hoy:
--   SELECT almacen, articulo, cantidad, minimo, falta FROM v_stock_bajo
--    ORDER BY agotado DESC, falta DESC;
--
--   -- Ponerle un mínimo propio a la mochila de un técnico:
--   INSERT INTO stock_minimos (almacen_id, articulo_id, minimo, reponer)
--   SELECT al.id, ar.id, 2, 5
--     FROM almacenes al, articulos ar
--    WHERE al.tipo = 'tecnico' AND ar.nombre = 'Conector SC/APC'
--   ON CONFLICT (almacen_id, articulo_id) DO UPDATE SET minimo = 2, reponer = 5;
--
--   -- Y disparar los avisos a mano:
--   SELECT avisar_stock_bajo();
