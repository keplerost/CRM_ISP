-- =============================================================================
-- Migración 240 — Reabrir un ticket cerrado por error
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Un ticket resuelto no se podía volver atrás: la regla era abrir otro. Pero
-- cuando el técnico lo cierra por error (a los dos minutos de llegar, sin
-- solución), abrir otro ensucia los números y deja un "resuelto" falso.
--
-- `reabrir_ticket` lo vuelve atrás, solo para la oficina (administración o
-- quien tenga `soporte.asignar` o `soporte.ruta`) y diciendo por qué. Hay dos
-- maneras:
--
--   · sin fecha: vuelve a "En proceso" con la llegada que ya tenía, para que
--     el técnico lo termine ahora mismo;
--   · con fecha: vuelve a "Asignado" para ese día, como una visita nueva (sale,
--     llega y cierra otra vez).
--
-- En las dos se borran el cierre, la solución y la firma: el técnico tiene que
-- volver a poner la solución y hacer firmar al abonado. El motivo y quién lo
-- reabrió quedan en el historial del ticket (`ticket_eventos`).
-- =============================================================================

CREATE OR REPLACE FUNCTION reabre_tickets()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT rol IN ('super_admin', 'admin')
                OR permisos ? '*' OR permisos ? 'soporte.asignar' OR permisos ? 'soporte.ruta'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        FALSE
    )
$$;

GRANT EXECUTE ON FUNCTION reabre_tickets() TO authenticated;

CREATE OR REPLACE FUNCTION reabrir_ticket(p_id UUID, p_motivo TEXT, p_fecha DATE DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    t       tickets%ROWTYPE;
    v_nuevo TEXT;
    v_nota  TEXT;
BEGIN
    IF NOT reabre_tickets() THEN
        RAISE EXCEPTION 'Solo la oficina (administración, o quien asigna tickets u ordena las rutas) puede reabrir un ticket.'
            USING ERRCODE = '42501';
    END IF;
    IF length(BTRIM(COALESCE(p_motivo, ''))) < 5 THEN
        RAISE EXCEPTION 'Escribí por qué se reabre (al menos 5 letras).';
    END IF;

    SELECT * INTO t FROM tickets WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'El ticket no existe.';
    END IF;
    IF t.estado <> 'resuelto' THEN
        RAISE EXCEPTION 'El ticket #% no está resuelto (está %): no hace falta reabrirlo.', t.numero, t.estado;
    END IF;
    IF p_fecha IS NULL AND t.llegada_at IS NULL THEN
        RAISE EXCEPTION 'El ticket #% no tiene la llegada marcada: elegí una fecha para la nueva visita.', t.numero;
    END IF;
    IF p_fecha IS NOT NULL AND p_fecha < hoy_isp() THEN
        RAISE EXCEPTION 'La fecha de la nueva visita no puede ser anterior a hoy.';
    END IF;

    v_nota := 'Reabierto: ' || BTRIM(p_motivo);

    IF p_fecha IS NULL THEN
        v_nuevo := 'en_proceso';
        UPDATE tickets
           SET estado = 'en_proceso',
               cerrado_at = NULL, cerrado_por = NULL, solucion = NULL,
               firma_b64 = NULL, firmante_nombre = NULL, firmante_cedula = NULL,
               updated_at = NOW()
         WHERE id = p_id;
    ELSE
        v_nuevo := 'asignado';
        v_nota := v_nota || format(' · nueva visita el %s', to_char(p_fecha, 'DD/MM/YYYY'))
               || CASE WHEN t.llegada_at IS NOT NULL
                       THEN format(' (la anterior llegó el %s)', to_char(t.llegada_at AT TIME ZONE zona_horaria(), 'DD/MM/YYYY HH24:MI'))
                       ELSE '' END;
        UPDATE tickets
           SET estado = 'asignado',
               fecha_visita = p_fecha,
               cerrado_at = NULL, cerrado_por = NULL, solucion = NULL,
               firma_b64 = NULL, firmante_nombre = NULL, firmante_cedula = NULL,
               salida_at = NULL, llegada_at = NULL, llegada_lat = NULL, llegada_lng = NULL, llegada_precision_m = NULL,
               ruta_fecha = NULL, ruta_orden = NULL, reprogramar_desde = NULL,
               updated_at = NOW()
         WHERE id = p_id;
    END IF;

    -- El disparador de la 26 ya anotó el cambio de estado; se le pone el
    -- motivo y quién lo hizo.
    UPDATE ticket_eventos e
       SET nota = v_nota, created_by = auth.uid()
     WHERE e.id = (
        SELECT id FROM ticket_eventos
         WHERE ticket_id = p_id AND estado_anterior = 'resuelto' AND estado_nuevo = v_nuevo
         ORDER BY created_at DESC
         LIMIT 1);

    RETURN v_nuevo;
END;
$$;

REVOKE ALL ON FUNCTION reabrir_ticket(UUID, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reabrir_ticket(UUID, TEXT, DATE) TO authenticated;
