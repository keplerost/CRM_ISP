-- =============================================================================
-- Migración 110 — La hora de los avisos, en la hora de acá
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El error ──
--
-- Se agendó un retiro para las 15:00 y la notificación decía:
--
--     DEMO CARTERA CUATRO — 14/08 20:00 · 0999000004
--
-- Cinco horas después. El dato guardado estaba bien —`agendado_para` es
-- `timestamptz` y adentro tenía las 15:00 de Ecuador—; lo que estaba mal era
-- cómo se escribía en el texto del aviso.
--
-- ── Por qué pasa ──
--
-- `TO_CHAR(timestamptz, ...)` convierte a la zona horaria de la SESIÓN, y la
-- sesión de una función que corre sola —desde la tarea de la noche o desde el
-- service_role— es la del servidor: UTC. La pantalla no tenía este problema
-- porque formatea en el navegador, que sí está en la hora de acá.
--
-- Es la peor clase de error de fecha: no falla, no avisa, y manda a alguien a
-- una casa a una hora que el abonado nunca dijo.
--
-- ── Cómo se arregla ──
--
-- La zona horaria pasa a ser configuración, en `config_general`, y una función
-- la devuelve. Cualquier texto que se arme en la base tiene que pasar por ahí:
-- dejarla escrita a mano dentro de una función la haría inencontrable el día
-- que este sistema se instale en otro país.
-- =============================================================================


-- =============================================================================
-- 1. La zona horaria, como configuración
-- =============================================================================
ALTER TABLE config_general
    ADD COLUMN IF NOT EXISTS zona_horaria TEXT NOT NULL DEFAULT 'America/Guayaquil';

COMMENT ON COLUMN config_general.zona_horaria IS
    'La zona horaria del ISP. Se usa para escribir fechas y horas en los textos que arma la base —notificaciones, mensajes—, que de otro modo saldrían en UTC. Las pantallas no la necesitan: formatean en el navegador.';


/**
 * La zona configurada, o la de Ecuador si nadie la tocó.
 *
 * El COALESCE no es decorativo: una base recién instalada puede no tener
 * todavía la fila de configuración, y `AT TIME ZONE NULL` devuelve NULL — el
 * aviso saldría sin hora en vez de con la hora mal, que es igual de inútil.
 */
CREATE OR REPLACE FUNCTION zona_horaria()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT NULLIF(BTRIM(zona_horaria), '') FROM config_general WHERE id = 1),
        'America/Guayaquil'
    )
$$;

COMMENT ON FUNCTION zona_horaria IS
    'La zona horaria del ISP para armar textos con fecha y hora dentro de la base.';


-- =============================================================================
-- 2. El recordatorio, con la hora bien
-- =============================================================================
-- Igual que en la 109 salvo el `AT TIME ZONE`. Se repite entera y no se parcha
-- porque una función se reemplaza completa: no hay forma de cambiarle una línea.
CREATE OR REPLACE FUNCTION recordar_retiros_agendados(p_horas INT DEFAULT 24)
RETURNS TABLE (avisadas INT, vencidas INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    r        RECORD;
    v_prox   INT := 0;
    v_venc   INT := 0;
    v_quien  UUID;
    v_zona   TEXT := zona_horaria();
BEGIN
    FOR r IN
        SELECT re.id, re.responsable_id, re.serie, re.agendado_para, re.agenda_nota,
               re.recordado_en, c.nombre AS cliente,
               COALESCE(c.telefono_movil, c.telefono) AS telefono,
               (re.agendado_para < NOW()) AS vencida
          FROM retiros_equipo re
          JOIN clientes c ON c.id = re.cliente_id
         WHERE re.estado IN ('pendiente', 'asignado')
           AND re.agendado_para IS NOT NULL
           AND re.agendado_para <= NOW() + (p_horas || ' hours')::INTERVAL
           AND (re.recordado_en IS NULL OR re.recordado_en < CURRENT_DATE)
    LOOP
        v_quien := r.responsable_id;

        IF v_quien IS NULL THEN
            SELECT id INTO v_quien
              FROM usuarios_sistema
             WHERE activo
               AND (permisos ? '*' OR permisos ? 'retiros.gestionar')
             ORDER BY creado_en
             LIMIT 1;
        END IF;

        PERFORM notificar(
            v_quien,
            CASE WHEN r.vencida THEN 'retiro_vencido' ELSE 'retiro_agendado' END,
            CASE WHEN r.vencida
                 THEN 'Se pasó la hora de un retiro'
                 ELSE 'Retiro agendado' END,
            r.cliente
                -- Acá está el arreglo: la hora se escribe en la zona del ISP.
                || ' — ' || TO_CHAR(r.agendado_para AT TIME ZONE v_zona, 'DD/MM HH24:MI')
                || COALESCE(' · ' || r.telefono, '')
                || COALESCE(E'\n' || r.agenda_nota, ''),
            '/campo/retiros',
            'retiro',
            r.id::TEXT
        );

        UPDATE retiros_equipo SET recordado_en = NOW() WHERE id = r.id;

        IF r.vencida THEN v_venc := v_venc + 1; ELSE v_prox := v_prox + 1; END IF;
    END LOOP;

    RETURN QUERY SELECT v_prox, v_venc;
END $$;

COMMENT ON FUNCTION recordar_retiros_agendados IS
    'Avisa al responsable de las citas de retiro próximas y de las que se pasaron, con la hora en la zona del ISP. Una vez por día por orden. Idempotente.';


-- =============================================================================
-- 3. Los avisos que ya salieron con la hora corrida
-- =============================================================================
-- Se borran los que generó la versión anterior. Corregir el texto uno por uno
-- sería adivinar cuáles estaban mal; y dejarlos sería peor: son avisos con una
-- hora que nadie dijo. Al volver a correr la tarea salen de nuevo, bien.
DELETE FROM notificaciones WHERE tipo IN ('retiro_agendado', 'retiro_vencido');

-- Y se libera la marca para que el próximo pasaje los vuelva a emitir.
UPDATE retiros_equipo
   SET recordado_en = NULL
 WHERE recordado_en IS NOT NULL
   AND estado IN ('pendiente', 'asignado');


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT zona_horaria();                        -- America/Guayaquil
--
--   -- La cita guardada y cómo se va a escribir:
--   SELECT agendado_para,
--          TO_CHAR(agendado_para AT TIME ZONE zona_horaria(), 'DD/MM HH24:MI') AS se_lee
--     FROM retiros_equipo WHERE agendado_para IS NOT NULL;
--
--   SELECT * FROM recordar_retiros_agendados();
--   SELECT titulo, detalle FROM notificaciones WHERE tipo LIKE 'retiro%';
