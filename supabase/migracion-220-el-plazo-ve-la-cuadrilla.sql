-- =============================================================================
-- Migración 220 — El aviso de plazo ve la cuadrilla
-- =============================================================================
-- La 219 armaba el aviso "Plazo de atención" solo con `tecnico_id`. Un ticket
-- asignado a una cuadrilla entera —sin técnico individual— salía como
-- "SIN TÉCNICO ASIGNADO", y en la oficina lo leían como un ticket olvidado
-- cuando ya tenía quién vaya.
--
-- Ahora `v_plazos_trabajo` suma, al final, la cuadrilla y sus integrantes, y el
-- aviso los nombra. Las columnas se agregan AL FINAL a propósito: una vista
-- reemplazada solo puede crecer por la cola.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

CREATE OR REPLACE VIEW v_plazos_trabajo WITH (security_invoker = true) AS
WITH trabajos AS (
    SELECT
        'ticket'::TEXT        AS clase,
        t.id,
        t.numero::TEXT        AS numero,
        t.client_id,
        t.nombre              AS cliente,
        COALESCE(t.tipo_incidencia, 'otro') AS tipo,
        t.tecnico_id,
        t.estado,
        t.created_at          AS registrado_at,
        t.llegada_at,
        t.cerrado_at          AS cierre_at,
        (t.estado IN ('abierto', 'asignado', 'en_ruta') AND t.llegada_at IS NULL) AS pendiente,
        t.direccion,
        t.sector              AS zona,
        COALESCE(t.telefono_whatsapp, t.telefono) AS telefono,
        t.demora_motivo,
        t.demora_nota,
        t.cuadrilla_id
    FROM tickets t

    UNION ALL

    SELECT
        'instalacion'::TEXT,
        i.id,
        i.numero::TEXT,
        i.client_id,
        c.nombre,
        CASE i.tipo
            WHEN 'nueva'    THEN 'instalacion'
            WHEN 'traslado' THEN 'traslado'
            WHEN 'retiro'   THEN 'retiro'
            ELSE 'otro'
        END,
        i.tecnico_id,
        i.estado,
        i.created_at,
        i.llegada_at,
        i.alta_at,
        (i.estado IN ('nueva', 'revisando', 'lista_asignar', 'agendada', 'en_ruta', 'reprogramada')
         AND i.llegada_at IS NULL),
        COALESCE(i.direccion, c.direccion),
        c.zona,
        c.telefono_movil,
        i.demora_motivo,
        i.demora_nota,
        i.cuadrilla_id
    FROM instalaciones i
    LEFT JOIN clientes c ON c.id = i.client_id
    WHERE i.estado <> 'prospecto'
)
SELECT
    -- Las columnas de la 219, en el mismo orden.
    tr.clase, tr.id, tr.numero, tr.client_id, tr.cliente, tr.tipo, tr.tecnico_id,
    tr.estado, tr.registrado_at, tr.llegada_at, tr.cierre_at, tr.pendiente,
    tr.direccion, tr.zona, tr.telefono, tr.demora_motivo, tr.demora_nota,
    COALESCE(pa.nombre, po.nombre, tr.tipo)  AS tipo_nombre,
    COALESCE(pa.horas, po.horas, 24)         AS plazo_horas,
    tr.registrado_at + MAKE_INTERVAL(secs => COALESCE(pa.horas, po.horas, 24) * 3600) AS vence_at,
    tc.nombre AS tecnico,
    CASE WHEN tr.llegada_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (tr.llegada_at - tr.registrado_at)) / 60)::INT END AS minutos_espera,
    CASE
        WHEN tr.llegada_at IS NOT NULL
            THEN tr.llegada_at <= tr.registrado_at + MAKE_INTERVAL(secs => COALESCE(pa.horas, po.horas, 24) * 3600)
        WHEN tr.pendiente
             AND NOW() > tr.registrado_at + MAKE_INTERVAL(secs => COALESCE(pa.horas, po.horas, 24) * 3600)
            THEN FALSE
    END AS en_plazo,
    -- Nuevas (220): a qué cuadrilla se asignó y quiénes la forman, el líder
    -- primero.
    tr.cuadrilla_id,
    cu.nombre AS cuadrilla,
    (SELECT STRING_AGG(mt.nombre, ', ' ORDER BY (cm.rol = 'lider') DESC, mt.nombre)
       FROM cuadrilla_miembros cm
       JOIN tecnicos mt ON mt.id = cm.tecnico_id
      WHERE cm.cuadrilla_id = tr.cuadrilla_id) AS cuadrilla_integrantes
FROM trabajos tr
LEFT JOIN plazos_atencion pa ON pa.clave = tr.tipo
LEFT JOIN plazos_atencion po ON po.clave = 'otro'
LEFT JOIN tecnicos tc        ON tc.id = tr.tecnico_id
LEFT JOIN cuadrillas cu      ON cu.id = tr.cuadrilla_id;

GRANT SELECT ON v_plazos_trabajo TO authenticated;


-- El detalle del aviso, en un solo lugar: lo usa el alta del evento y el
-- refresco de los que ya están abiertos.
CREATE OR REPLACE FUNCTION detalle_plazo(p v_plazos_trabajo)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object(
        'numero',        p.numero,
        'tipo',          p.tipo,
        'tipo_nombre',   p.tipo_nombre,
        'tecnico',       p.tecnico,
        'cuadrilla',     p.cuadrilla,
        'integrantes',   p.cuadrilla_integrantes,
        'vence_at',      p.vence_at,
        'registrado_at', p.registrado_at,
        'direccion',     p.direccion,
        'telefono',      p.telefono
    ))
$$;

REVOKE ALL ON FUNCTION detalle_plazo(v_plazos_trabajo) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION detectar_plazos()
RETURNS TABLE (abiertos INT, cerrados INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_umbral   NUMERIC;
    v_abiertos INT := 0;
    v_cerrados INT := 0;
BEGIN
    SELECT COALESCE(umbral, 60) INTO v_umbral
      FROM alerta_reglas
     WHERE clave = 'plazo_atencion' AND activa;

    IF FOUND THEN
        INSERT INTO alerta_eventos (regla, entidad, entidad_id, etiqueta, zona, abonados, detalle, empezo_en)
        SELECT 'plazo_atencion', p.clase, p.id::TEXT, p.cliente, p.zona, 1, detalle_plazo(p), NOW()
          FROM v_plazos_trabajo p
         WHERE p.pendiente
           AND p.registrado_at > NOW() - INTERVAL '30 days'
           AND NOW() >= p.vence_at - MAKE_INTERVAL(mins => v_umbral::INT)
        ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL DO NOTHING;

        GET DIAGNOSTICS v_abiertos = ROW_COUNT;

        -- Los abiertos se mantienen al día: si después del primer aviso se le
        -- pone técnico o cuadrilla, el aviso de "vencido" ya lo dice.
        UPDATE alerta_eventos e
           SET detalle = detalle_plazo(p)
          FROM v_plazos_trabajo p
         WHERE e.regla = 'plazo_atencion'
           AND e.resuelto_en IS NULL
           AND p.clase = e.entidad AND p.id::TEXT = e.entidad_id
           AND e.detalle IS DISTINCT FROM detalle_plazo(p);
    END IF;

    UPDATE alerta_eventos e
       SET resuelto_en = NOW()
     WHERE e.regla = 'plazo_atencion'
       AND e.resuelto_en IS NULL
       AND NOT EXISTS (
           SELECT 1 FROM v_plazos_trabajo p
            WHERE p.clase = e.entidad AND p.id::TEXT = e.entidad_id AND p.pendiente
       );

    GET DIAGNOSTICS v_cerrados = ROW_COUNT;

    RETURN QUERY SELECT v_abiertos, v_cerrados;
END;
$$;

REVOKE ALL ON FUNCTION detectar_plazos() FROM PUBLIC, anon, authenticated;


-- Los avisos que ya están abiertos, corregidos ahora mismo.
UPDATE alerta_eventos e
   SET detalle = detalle_plazo(p)
  FROM v_plazos_trabajo p
 WHERE e.regla = 'plazo_atencion'
   AND e.resuelto_en IS NULL
   AND p.clase = e.entidad AND p.id::TEXT = e.entidad_id;
