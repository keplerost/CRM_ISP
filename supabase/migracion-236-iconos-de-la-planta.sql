-- =============================================================================
-- Migración 236 — Íconos en la planta externa
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
-- Requiere la 235 (capas y estilos).
--
-- Los puntos del mapa eran todos círculos. Ahora cada tipo, cada capa y cada
-- elemento puede llevar un ícono de telecomunicaciones: la NAP con el
-- triángulo del splitter, la manga como domo, la reserva como bobina, el
-- poste con su herraje A o J, la cámara con la X…
--
-- El catálogo de íconos vive en la aplicación (`web/src/lib/iconos.js`): acá se
-- guarda solo la clave. El orden es el mismo de siempre:
--
--     el propio del elemento  >  el de su capa  >  el de su tipo
-- =============================================================================

ALTER TABLE planta_estilos   ADD COLUMN IF NOT EXISTS icono VARCHAR(30) CHECK (icono IS NULL OR icono ~ '^[a-z_]{2,30}$');
ALTER TABLE planta_capas     ADD COLUMN IF NOT EXISTS icono VARCHAR(30) CHECK (icono IS NULL OR icono ~ '^[a-z_]{2,30}$');
ALTER TABLE planta_elementos ADD COLUMN IF NOT EXISTS icono VARCHAR(30) CHECK (icono IS NULL OR icono ~ '^[a-z_]{2,30}$');

-- El ícono de cada tipo, si nadie eligió otro.
UPDATE planta_estilos SET icono = v.icono
  FROM (VALUES ('e:nodo', 'nodo'), ('e:poste', 'poste'), ('e:nap', 'nap'), ('e:manga', 'manga_domo'),
               ('e:reserva', 'reserva'), ('e:splitter', 'splitter'), ('e:odf', 'odf'), ('e:otro', 'circulo')) AS v(clave, icono)
 WHERE planta_estilos.clave = v.clave AND planta_estilos.icono IS NULL;

-- Los postes que vinieron del KMZ con su herraje: con su letra.
UPDATE planta_elementos SET icono = CASE herraje WHEN 'A' THEN 'poste_a' WHEN 'J' THEN 'poste_j' END
 WHERE tipo = 'poste' AND herraje IN ('A', 'J') AND icono IS NULL;

-- La vista se arma con `e.*`: se recrea para que tome la columna nueva.
DROP VIEW IF EXISTS v_planta_elementos;
CREATE VIEW v_planta_elementos WITH (security_invoker = true) AS
SELECT e.*,
       p.nombre AS caja,
       ab.abonados,
       CASE WHEN e.capacidad IS NULL THEN NULL ELSE GREATEST(0, e.capacidad - COALESCE(ab.abonados, 0)) END AS libres
  FROM planta_elementos e
  LEFT JOIN puntos_red p ON p.id = e.punto_id
  LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS abonados FROM clientes c WHERE c.nap_id = e.punto_id
  ) ab ON e.punto_id IS NOT NULL;

GRANT SELECT ON v_planta_elementos TO authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, icono FROM planta_estilos ORDER BY clave;
--   SELECT icono, COUNT(*) FROM planta_elementos GROUP BY 1 ORDER BY 2 DESC;
