-- =============================================================================
-- Migración 58 — El mismo modelo escrito de dos formas es un solo modelo
-- =============================================================================
-- La OLT reporta el mismo aparato como "H3-1s" en unas ONTs y "H3-1S" en otras.
-- No es un error del equipo: cada ONT devuelve el Equipment-ID como se lo
-- grabaron en fábrica, y ahí la capitalización varía entre lotes.
--
-- `v_tipos_ont` contaba las ONUs agrupando por el texto exacto. Con dos grafías
-- el tipo aparecía DOS VECES en el listado, con el total partido: cinco en una
-- fila y tres en otra, ninguna de las dos verdadera. Y la que se editara iba a
-- ser la única que mostrara la foto — la mitad de los abonados quedaría sin
-- imagen sin que nadie entendiera por qué.
--
-- Se agrupa sin distinguir mayúsculas, que es como ya se resolvía el vínculo en
-- `v_onu_tipo`. Las dos vistas tenían que usar el mismo criterio y no lo hacían.
-- =============================================================================

DROP VIEW IF EXISTS v_tipos_ont;
CREATE VIEW v_tipos_ont WITH (security_invoker = true) AS
SELECT
    t.*,
    COALESCE(v.enlazadas, 0) AS onus_enlazadas,
    COALESCE(m.por_modelo, 0) AS onus_por_modelo,
    COALESCE(v.enlazadas, 0) + COALESCE(m.por_modelo, 0) AS onus,
    p.nombre AS perfil_default
FROM tipos_ont t
LEFT JOIN planes_velocidad p ON p.id = t.perfil_default_id
LEFT JOIN (
    SELECT tipo_ont_id, COUNT(*) AS enlazadas
    FROM onus WHERE tipo_ont_id IS NOT NULL GROUP BY tipo_ont_id
) v ON v.tipo_ont_id = t.id
LEFT JOIN (
    -- Agrupado por el modelo en mayúsculas: "H3-1s" y "H3-1S" son el mismo
    -- aparato y tienen que sumar en una sola fila.
    SELECT UPPER(modelo) AS modelo_upper, COUNT(*) AS por_modelo
    FROM onus WHERE modelo IS NOT NULL AND tipo_ont_id IS NULL
    GROUP BY UPPER(modelo)
) m ON m.modelo_upper = UPPER(t.modelo);

COMMENT ON VIEW v_tipos_ont IS
    'Tipos de ONU con cuántas los usan. El modelo se compara sin distinguir mayúsculas: la OLT devuelve el Equipment-ID como se lo grabaron en fábrica y la capitalización varía entre lotes del mismo aparato.';


-- -----------------------------------------------------------------------------
-- Que no se puedan cargar dos veces
-- -----------------------------------------------------------------------------
-- El UNIQUE original es sobre (marca, modelo) y distingue mayúsculas, así que
-- deja crear "H3-1s" y "H3-1S" como si fueran aparatos distintos. Con los dos
-- cargados, la foto se le pone a uno y la mitad de los abonados no la muestra.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tipos_ont_modelo_upper
    ON tipos_ont (UPPER(marca), UPPER(modelo));
