-- =============================================================================
-- Migración 223 — La ruta se ordena sola
-- =============================================================================
-- La ruta del día (216) se ordenaba por prioridad, fecha y franja, sin mirar
-- dónde queda cada abonado. Con los datos del 10/11/2026, la de la cuadrilla
-- TROOPER sumaba 122 km en línea recta; ordenada por cercanía, 61. La mitad del
-- combustible y del tiempo, yendo de punta a punta.
--
-- Soporte → Rutas ya tenía "Ordenar automáticamente", pero alguien tenía que
-- tocarlo cada día. Ahora lo hace el middleware cada pocos minutos con la
-- misma regla: primero lo que está en curso, después lo urgente, después por
-- franja, y dentro de cada tramo el más cercano al anterior.
--
-- ── Lo manual manda ──
--
-- Si la oficina o el jefe de grupo ordenan una ruta a mano, el automático no
-- la toca más ese día. Para distinguir un orden del otro se agrega
-- `ruta_auto`: TRUE si lo puso el automático.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

ALTER TABLE tickets       ADD COLUMN IF NOT EXISTS ruta_auto BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE instalaciones ADD COLUMN IF NOT EXISTS ruta_auto BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tickets.ruta_auto IS
    'TRUE si el orden de la ruta (ruta_fecha/ruta_orden) lo puso el ordenamiento automático; FALSE si lo fijó una persona.';

ALTER TABLE config_tareas
    ADD COLUMN IF NOT EXISTS rutas_automatico   BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS rutas_cada_minutos INT     NOT NULL DEFAULT 10;

COMMENT ON COLUMN config_tareas.rutas_automatico IS
    'Ordenar solas las rutas del día por urgencia, franja y cercanía. Encendida de fábrica: no le escribe a nadie y respeta lo ordenado a mano.';


-- =============================================================================
-- 1. El orden manual marca que es manual
-- =============================================================================
-- El mismo `ordenar_ruta` de la 216, con `ruta_auto = FALSE` al fijar.
CREATE OR REPLACE FUNCTION ordenar_ruta(p_items JSONB, p_motivo TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_oficina BOOLEAN := ordena_rutas();
    v_tec     UUID := mi_tecnico_id();
    v_fecha   DATE := hoy_isp();
    v_mis     UUID[];
    it        RECORD;
    u         RECORD;
BEGIN
    IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'No hay trabajos que ordenar.';
    END IF;

    IF NOT v_oficina THEN
        SELECT array_agg(m.cuadrilla_id) INTO v_mis
          FROM cuadrilla_miembros m
         WHERE m.tecnico_id = v_tec AND jefe_de_grupo(m.cuadrilla_id, v_fecha) = v_tec;
        IF v_mis IS NULL THEN
            RAISE EXCEPTION 'La ruta la ordena la oficina o el jefe de grupo del día.' USING ERRCODE = '42501';
        END IF;
        IF NULLIF(BTRIM(p_motivo), '') IS NULL THEN
            RAISE EXCEPTION 'Contá por qué cambiás el orden: queda registrado.';
        END IF;
    END IF;

    FOR it IN
        SELECT e->>'tipo' AS tipo, (e->>'id')::uuid AS id, ord::int AS orden
          FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(e, ord)
    LOOP
        IF it.tipo = 'ticket' THEN
            UPDATE tickets SET ruta_fecha = v_fecha, ruta_orden = it.orden, ruta_auto = FALSE
             WHERE id = it.id
               AND (v_oficina OR tecnico_id = v_tec OR cuadrilla_id = ANY(v_mis));
        ELSIF it.tipo = 'instalacion' THEN
            UPDATE instalaciones SET ruta_fecha = v_fecha, ruta_orden = it.orden, ruta_auto = FALSE
             WHERE id = it.id
               AND (v_oficina OR tecnico_id = v_tec OR cuadrilla_id = ANY(v_mis));
        END IF;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Uno de los trabajos no es de tu cuadrilla.' USING ERRCODE = '42501';
        END IF;
    END LOOP;

    INSERT INTO ruta_cambios (fecha, usuario_id, motivo, items)
    VALUES (v_fecha, mi_usuario_id(), NULLIF(BTRIM(p_motivo), ''), p_items);

    IF NOT v_oficina THEN
        FOR u IN SELECT id FROM usuarios_sistema
                  WHERE activo AND rol IN ('super_admin', 'admin', 'jefe_tecnico')
        LOOP
            PERFORM notificar(u.id, 'ruta_cambiada',
                (SELECT nombre FROM tecnicos WHERE id = v_tec) || ' cambió el orden de la ruta',
                LEFT(BTRIM(p_motivo), 200), '/soporte/rutas', 'ruta', v_fecha::text || ':' || v_tec::text);
        END LOOP;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION ordenar_ruta(JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ordenar_ruta(JSONB, TEXT) TO authenticated;


-- =============================================================================
-- 2. Qué rutas hay hoy, y cuáles se ordenaron a mano
-- =============================================================================
-- Las mismas que dibuja `rutas_del_dia`: una por cuadrilla activa y una por
-- cada técnico que no está en ninguna.
CREATE OR REPLACE FUNCTION rutas_a_ordenar()
RETURNS TABLE (
    clase      TEXT,
    id         UUID,
    nombre     TEXT,
    hoy        DATE,
    tecnicos   UUID[],
    cuadrillas UUID[],
    manual     BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH grupos AS (
        SELECT 'cuadrilla'::text AS clase, cu.id, cu.nombre::text AS nombre,
               COALESCE((SELECT array_agg(m.tecnico_id) FROM cuadrilla_miembros m
                          WHERE m.cuadrilla_id = cu.id), '{}') AS tecnicos,
               ARRAY[cu.id] AS cuadrillas
          FROM cuadrillas cu
         WHERE cu.activo
        UNION ALL
        SELECT 'tecnico', t.id, t.nombre::text, ARRAY[t.id], '{}'::uuid[]
          FROM tecnicos t
         WHERE t.activo
           AND NOT EXISTS (SELECT 1 FROM cuadrilla_miembros m WHERE m.tecnico_id = t.id)
    )
    SELECT g.clase, g.id, g.nombre, hoy_isp(), g.tecnicos, g.cuadrillas,
           -- Alguien la ordenó a mano hoy: se respeta.
           EXISTS (
               SELECT 1 FROM tickets t
                WHERE t.ruta_fecha = hoy_isp() AND t.ruta_orden IS NOT NULL AND NOT t.ruta_auto
                  AND t.estado IN ('asignado', 'en_ruta', 'en_proceso')
                  AND (t.tecnico_id = ANY(g.tecnicos) OR t.cuadrilla_id = ANY(g.cuadrillas))
           ) OR EXISTS (
               SELECT 1 FROM instalaciones i
                WHERE i.ruta_fecha = hoy_isp() AND i.ruta_orden IS NOT NULL AND NOT i.ruta_auto
                  AND i.estado IN ('agendada', 'en_ruta', 'en_curso', 'reprogramada')
                  AND (i.tecnico_id = ANY(g.tecnicos) OR i.cuadrilla_id = ANY(g.cuadrillas))
           ) AS manual
      FROM grupos g
$$;

REVOKE ALL ON FUNCTION rutas_a_ordenar() FROM PUBLIC, anon, authenticated;


-- =============================================================================
-- 3. Guardar el orden automático
-- =============================================================================
/**
 * Como `ordenar_ruta`, pero para el middleware: sin usuario, sin motivo, y sin
 * pisar nunca un orden puesto a mano. Devuelve cuántos trabajos ordenó.
 */
CREATE OR REPLACE FUNCTION ordenar_ruta_auto(p_items JSONB)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fecha DATE := hoy_isp();
    v_n     INT := 0;
    v_fila  INT;
    it      RECORD;
BEGIN
    IF jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'Se esperaba una lista de trabajos.';
    END IF;

    FOR it IN
        SELECT e->>'tipo' AS tipo, (e->>'id')::uuid AS id, ord::int AS orden
          FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(e, ord)
    LOOP
        IF it.tipo = 'ticket' THEN
            UPDATE tickets SET ruta_fecha = v_fecha, ruta_orden = it.orden, ruta_auto = TRUE
             WHERE id = it.id
               AND NOT (ruta_fecha = v_fecha AND ruta_orden IS NOT NULL AND NOT ruta_auto);
        ELSIF it.tipo = 'instalacion' THEN
            UPDATE instalaciones SET ruta_fecha = v_fecha, ruta_orden = it.orden, ruta_auto = TRUE
             WHERE id = it.id
               AND NOT (ruta_fecha = v_fecha AND ruta_orden IS NOT NULL AND NOT ruta_auto);
        END IF;
        GET DIAGNOSTICS v_fila = ROW_COUNT;
        v_n := v_n + v_fila;
    END LOOP;

    RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION ordenar_ruta_auto(JSONB) FROM PUBLIC, anon, authenticated;
