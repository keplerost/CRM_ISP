-- =============================================================================
-- Migración 90 — Tipos de evidencia y avisos de red
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Dos cosas que quedaron a medias del módulo del técnico:
--
--   1. El pedido listaba seis tipos de foto y la tabla acepta cinco, que no son
--      los mismos.
--   2. La campana avisa de expedientes e instalaciones, pero no de la red. El
--      técnico se entera de que se cayó la torre solo si entra al tablero.
-- =============================================================================


-- =============================================================================
-- 1. Las evidencias que faltaban
-- =============================================================================
-- Faltaban `roseta`, `exterior` y `velocidad`. Sin ellas el técnico las cargaba
-- como "otra", y tres meses después nadie puede buscar "la foto del nivel
-- óptico de esta casa" — que es justo cuando se la necesita, discutiendo un
-- reclamo.
--
-- `foto` se conserva aunque no esté en la pantalla: es el valor por defecto de
-- la columna y hay filas viejas que lo usan. Sacarlo rompería el CHECK contra
-- datos que ya existen.
ALTER TABLE instalacion_fotos
    DROP CONSTRAINT IF EXISTS instalacion_fotos_tipo_check;
ALTER TABLE instalacion_fotos
    ADD CONSTRAINT instalacion_fotos_tipo_check CHECK (tipo IN (
        'foto',       -- el valor por defecto, de antes de que hubiera tipos
        'fachada',
        'exterior',   -- la instalación por fuera: acometida, sujeción al poste
        'cableado',
        'roseta',
        'equipo',     -- la ONT o el router instalado
        'potencia',   -- el nivel óptico medido
        'velocidad',  -- la prueba de velocidad en pantalla
        'otro'
    ));


-- =============================================================================
-- 2. Avisar cuando se cae un nodo
-- =============================================================================
-- ── A quién se avisa ──
--
-- Al técnico asignado al nodo, y a quien opera la red. No a todo el mundo: una
-- campana que suena para cosas que uno no puede atender se apaga en dos días, y
-- después no suena para lo que sí importa.
--
-- ── Y a quién NO ──
--
-- Cuando la caída se explica por la del padre. Un corte de fibra en cabecera
-- tira veinte nodos; veinte avisos por un solo problema es exactamente cómo se
-- consigue que nadie lea el próximo. Se avisa por la causa, no por cada
-- consecuencia.
--
-- Es la misma regla que ya aplica el tablero al contar incidencias, y tiene que
-- ser la misma: si el tablero muestra una y la campana manda veinte, una de las
-- dos está mintiendo.
CREATE OR REPLACE FUNCTION notificar_estado_nodo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_usuario   UUID;
    v_titulo    TEXT;
    v_detalle   TEXT;
    v_tipo      TEXT;
    v_duracion  INT;
BEGIN
    -- Solo los cambios de estado, y solo los que son noticia.
    IF NEW.estado IS NOT DISTINCT FROM OLD.estado THEN RETURN NEW; END IF;
    IF NOT NEW.avisar THEN RETURN NEW; END IF;

    IF NEW.estado = 'down' THEN
        -- ¿Es consecuencia de que su padre está caído? Entonces no es noticia.
        IF EXISTS (
            SELECT 1 FROM nodos_red p
             WHERE p.id = NEW.padre_id AND p.estado = 'down'
        ) THEN
            RETURN NEW;
        END IF;

        v_tipo   := 'red.caida';
        v_titulo := NEW.nombre || ' sin conexión';
        v_detalle := 'Dejó de responder. '
                  || clientes_de_nodo(NEW.id)::TEXT || ' cliente(s) posiblemente afectados.';

    ELSIF NEW.estado = 'up' AND OLD.estado IN ('down', 'warning') THEN
        v_tipo   := 'red.recuperado';
        v_titulo := NEW.nombre || ' recuperado';
        -- Cuánto estuvo mal. Es el dato que se pregunta después, y sale del
        -- intervalo que ya venía abierto.
        SELECT (EXTRACT(EPOCH FROM (NOW() - e.desde)) / 60)::INT INTO v_duracion
          FROM nodo_eventos e
         WHERE e.nodo_id = NEW.id AND e.hasta IS NULL
         ORDER BY e.desde DESC LIMIT 1;
        v_detalle := CASE
            WHEN v_duracion IS NULL THEN 'Volvió a responder.'
            WHEN v_duracion < 60 THEN 'Volvió a responder. Estuvo ' || v_duracion || ' minutos sin servicio.'
            ELSE 'Volvió a responder. Estuvo ' || (v_duracion / 60) || 'h ' || (v_duracion % 60) || 'm sin servicio.'
        END;

    ELSE
        -- `warning` no avisa: un enlace que sube y baja de latencia mandaría
        -- avisos toda la tarde. Se ve en el tablero, que es donde corresponde.
        RETURN NEW;
    END IF;

    -- El técnico del nodo, si tiene uno asignado.
    SELECT u.id INTO v_usuario
      FROM usuarios_sistema u
     WHERE u.tecnico_id = NEW.tecnico_id AND u.activo
     LIMIT 1;

    IF v_usuario IS NOT NULL THEN
        PERFORM notificar(v_usuario, v_tipo, v_titulo, v_detalle,
                          '/campo/red?nodo=' || NEW.id, 'nodo', NEW.id::TEXT);
    END IF;

    -- Y quien opera la red. Se excluye al de arriba para no mandarle dos.
    FOR v_usuario IN
        SELECT u.id FROM usuarios_sistema u
         WHERE u.activo
           AND (u.permisos ? '*' OR u.permisos ? 'red.monitoreo')
           AND (NEW.tecnico_id IS NULL OR u.tecnico_id IS DISTINCT FROM NEW.tecnico_id)
    LOOP
        PERFORM notificar(v_usuario, v_tipo, v_titulo, v_detalle,
                          '/monitoreo', 'nodo', NEW.id::TEXT);
    END LOOP;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notificar_nodo ON nodos_red;
CREATE TRIGGER trg_notificar_nodo
    AFTER UPDATE OF estado ON nodos_red
    FOR EACH ROW EXECUTE FUNCTION notificar_estado_nodo();

COMMENT ON FUNCTION notificar_estado_nodo IS
    'Avisa por la campana cuando un nodo se cae o se recupera. No avisa de las caídas que son consecuencia de la del padre: un corte de fibra en cabecera mandaría veinte avisos por un solo problema.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
-- Con nodos cargados:
--
--   UPDATE nodos_red SET estado = 'down' WHERE nombre = '<uno>';
--   SELECT titulo, detalle FROM notificaciones ORDER BY creado_en DESC LIMIT 3;
--
-- Y que el hijo de un nodo caído NO genere aviso propio.
