-- =============================================================================
-- Migración 109 — El retiro: quién lo hace, cuándo lo hace y que no se olvide
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Lo que faltaba ──
--
-- La 101 dejó la orden de retiro completa: se abre sola, se asigna, se registran
-- los intentos, se cierra y el equipo vuelve al inventario. Pero se probó con
-- datos y aparecieron cuatro huecos, todos del mismo tipo — cosas que el sistema
-- sabe y no le dice a nadie:
--
--   1. La orden se asignaba a un TÉCNICO y solo a un técnico. En la práctica el
--      equipo lo va a buscar quien esté disponible: a veces el técnico, a veces
--      el cobrador, a veces el dueño. Y lo que es peor: la orden asignada no
--      aparecía en ninguna pantalla del técnico, así que se le daba trabajo a
--      alguien que no tenía forma de enterarse.
--
--   2. Se asignaban de a una. Veinte órdenes para el mismo recorrido eran veinte
--      clics.
--
--   3. El abonado casi siempre dice CUÁNDO: "pasá el jueves a las tres". Eso se
--      escribía en la observación de un intento, donde no lo puede leer nadie
--      que no abra esa orden, y sobre todo donde no le puede recordar a nadie.
--
--   4. Y lo que sigue de eso: si la persona se olvida de ir, nadie se entera.
--      Cada olvido es un equipo que se queda en una casa.
--
-- ── Lo que agrega ──
--
--   · `responsable_id`  — quién se hace cargo, sea o no técnico.
--   · `agendado_para`   — cuándo pidió el abonado que lo pasen a buscar.
--   · `asignar_retiros_equipo()` — asignar muchas de una vez.
--   · `agendar_retiro_equipo()`  — anotar la cita.
--   · `recordar_retiros_agendados()` — el aviso, para que no se pierda.
--   · `v_retiro_gestiones` — todo lo que dijo el abonado, en una tabla, para
--     poder sacarlo a un archivo.
-- =============================================================================


-- =============================================================================
-- 1. Quién se hace cargo
-- =============================================================================
-- ── Por qué una columna nueva y no reemplazar `tecnico_id` ──
--
-- Porque son dos cosas distintas y las dos siguen haciendo falta. `tecnico_id`
-- es la persona en su rol de campo: la usa el tablero del técnico, el historial
-- de intentos y la política de RLS que ya existe. `responsable_id` es "de quién
-- es esta orden", y puede ser alguien que no es técnico.
--
-- Cuando el responsable ADEMÁS es técnico, se llenan las dos y todo lo que ya
-- funcionaba sigue funcionando igual. Cuando no lo es, `tecnico_id` queda vacío
-- y la orden igual tiene dueño.
ALTER TABLE retiros_equipo
    ADD COLUMN IF NOT EXISTS responsable_id UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL;

COMMENT ON COLUMN retiros_equipo.responsable_id IS
    'Quién se hace cargo de ir a buscar el equipo. Puede no ser técnico: un cobrador, alguien de oficina. Si además es técnico, tecnico_id queda apuntando al mismo.';

-- Los que ya estaban asignados a un técnico reciben su responsable, para que la
-- pantalla nueva no los muestre huérfanos.
UPDATE retiros_equipo re
   SET responsable_id = u.id
  FROM usuarios_sistema u
 WHERE u.tecnico_id = re.tecnico_id
   AND re.tecnico_id IS NOT NULL
   AND re.responsable_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_retiros_responsable
    ON retiros_equipo (responsable_id, estado) WHERE estado IN ('pendiente', 'asignado');


-- =============================================================================
-- 2. Cuándo dijo el abonado
-- =============================================================================
ALTER TABLE retiros_equipo
    ADD COLUMN IF NOT EXISTS agendado_para TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS agenda_nota   TEXT,
    -- Para no repetir el mismo aviso cada vez que corre la tarea.
    ADD COLUMN IF NOT EXISTS recordado_en  TIMESTAMPTZ;

COMMENT ON COLUMN retiros_equipo.agendado_para IS
    'La fecha y hora que pidió el abonado para que le retiren el equipo. Es el dato que dispara el recordatorio.';

COMMENT ON COLUMN retiros_equipo.agenda_nota IS
    'Lo que dijo el abonado con sus palabras: "después de las 6 que llego del trabajo", "el sábado en la mañana". La cita es la hora; esto es el contexto que evita el viaje al pedo.';

CREATE INDEX IF NOT EXISTS idx_retiros_agenda
    ON retiros_equipo (agendado_para) WHERE agendado_para IS NOT NULL;


-- =============================================================================
-- 3. Que el responsable pueda verla y trabajarla
-- =============================================================================
-- Las políticas de la 101 miraban al técnico y al vendedor. Ahora también al
-- responsable: sin esto, asignarle una orden a alguien que no es técnico le
-- daría trabajo que no puede ni leer.
DROP POLICY IF EXISTS retiros_equipo_lectura ON retiros_equipo;
CREATE POLICY retiros_equipo_lectura ON retiros_equipo
    FOR SELECT TO authenticated
    USING (
        puede_gestionar_retiros()
        OR tecnico_id = mi_tecnico_id()
        OR responsable_id = mi_legajo_id()
        OR vendedor_id = mi_legajo_id()
    );

DROP POLICY IF EXISTS retiro_intentos_lectura ON retiro_intentos;
CREATE POLICY retiro_intentos_lectura ON retiro_intentos
    FOR SELECT TO authenticated
    USING (
        puede_gestionar_retiros()
        OR EXISTS (
            SELECT 1 FROM retiros_equipo r
             WHERE r.id = retiro_intentos.retiro_id
               AND (r.tecnico_id = mi_tecnico_id()
                 OR r.responsable_id = mi_legajo_id()
                 OR r.vendedor_id = mi_legajo_id())
        )
    );


-- =============================================================================
-- 4. Asignar: de a una y de a muchas
-- =============================================================================
/**
 * Asigna una orden a una persona del sistema.
 *
 * Recibe el usuario y no el técnico. Si esa persona está vinculada a un técnico
 * se llena también `tecnico_id`, que es lo que hace que la orden le aparezca en
 * la app de campo; si no lo está, la trabaja desde la pantalla de retiros.
 *
 * Y avisa. Una asignación silenciosa es la razón por la que este agregado
 * existe: la orden estaba asignada desde ayer y la persona se enteró cuando
 * alguien se lo preguntó por teléfono.
 */
CREATE OR REPLACE FUNCTION asignar_retiro_a(p_retiro UUID, p_usuario UUID)
RETURNS retiros_equipo
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fila    retiros_equipo%ROWTYPE;
    v_tecnico UUID;
    v_quien   TEXT;
BEGIN
    IF NOT puede_gestionar_retiros() THEN
        RAISE EXCEPTION 'No tenés permiso para asignar retiros de equipo';
    END IF;

    SELECT u.tecnico_id, TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
      INTO v_tecnico, v_quien
      FROM usuarios_sistema u WHERE u.id = p_usuario AND u.activo;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Esa persona no existe o está dada de baja';
    END IF;

    UPDATE retiros_equipo
       SET responsable_id = p_usuario,
           tecnico_id     = COALESCE(v_tecnico, tecnico_id),
           estado         = CASE WHEN estado = 'pendiente' THEN 'asignado' ELSE estado END,
           asignado_en    = NOW()
     WHERE id = p_retiro
       AND estado IN ('pendiente', 'asignado')
    RETURNING * INTO v_fila;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Esa orden de retiro no existe o ya está cerrada';
    END IF;

    PERFORM notificar(
        p_usuario,
        'retiro_asignado',
        'Tenés un equipo por retirar',
        (SELECT c.nombre FROM clientes c WHERE c.id = v_fila.cliente_id)
            || COALESCE(' — ' || v_fila.serie, ''),
        '/campo/retiros',
        'retiro',
        v_fila.id::TEXT
    );

    RETURN v_fila;
END $$;

COMMENT ON FUNCTION asignar_retiro_a IS
    'Asigna la orden a una persona del sistema, técnica o no, y le avisa.';


/**
 * Lo mismo, para un recorrido entero.
 *
 * Devuelve cuántas se asignaron y cuántas se saltearon. Las salteadas no son un
 * error: una orden que se cerró mientras alguien armaba la lista no puede
 * asignarse, y frenar todo el lote por eso obligaría a empezar de nuevo.
 */
CREATE OR REPLACE FUNCTION asignar_retiros_equipo(p_retiros UUID[], p_usuario UUID)
RETURNS TABLE (asignadas INT, salteadas INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id  UUID;
    v_ok  INT := 0;
    v_no  INT := 0;
BEGIN
    IF NOT puede_gestionar_retiros() THEN
        RAISE EXCEPTION 'No tenés permiso para asignar retiros de equipo';
    END IF;

    FOREACH v_id IN ARRAY COALESCE(p_retiros, '{}')
    LOOP
        BEGIN
            PERFORM asignar_retiro_a(v_id, p_usuario);
            v_ok := v_ok + 1;
        EXCEPTION WHEN OTHERS THEN
            v_no := v_no + 1;
        END;
    END LOOP;

    RETURN QUERY SELECT v_ok, v_no;
END $$;

COMMENT ON FUNCTION asignar_retiros_equipo IS
    'Asigna varias órdenes a la misma persona. Devuelve cuántas entraron y cuántas se saltearon por estar cerradas.';


-- =============================================================================
-- 5. La cita
-- =============================================================================
/**
 * Anota cuándo pidió el abonado que lo pasen a buscar.
 *
 * La puede poner quien gestiona retiros y también el responsable de la orden:
 * es el que está hablando con el abonado cuando este dice "pasá el jueves".
 * Obligarlo a pedirle a la oficina que la cargue es lo que hace que la cita
 * termine en un papel.
 *
 * Reagendar borra el recordatorio anterior para que el aviso vuelva a salir con
 * la fecha nueva.
 */
CREATE OR REPLACE FUNCTION agendar_retiro_equipo(
    p_retiro UUID,
    p_cuando TIMESTAMPTZ,
    p_nota   TEXT DEFAULT NULL
)
RETURNS retiros_equipo
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_fila retiros_equipo%ROWTYPE;
BEGIN
    SELECT * INTO v_fila FROM retiros_equipo WHERE id = p_retiro;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa orden de retiro';
    END IF;

    IF NOT puede_gestionar_retiros()
       AND v_fila.responsable_id IS DISTINCT FROM mi_legajo_id()
       AND v_fila.tecnico_id IS DISTINCT FROM mi_tecnico_id() THEN
        RAISE EXCEPTION 'Esa orden de retiro no es tuya';
    END IF;

    IF v_fila.estado NOT IN ('pendiente', 'asignado') THEN
        RAISE EXCEPTION 'Esa orden ya está cerrada (%)', v_fila.estado;
    END IF;

    UPDATE retiros_equipo
       SET agendado_para = p_cuando,
           agenda_nota   = COALESCE(NULLIF(BTRIM(p_nota), ''), agenda_nota),
           recordado_en  = NULL
     WHERE id = p_retiro
    RETURNING * INTO v_fila;

    RETURN v_fila;
END $$;


-- =============================================================================
-- 6. El recordatorio
-- =============================================================================
/**
 * Avisa de las citas de hoy y de las que se pasaron.
 *
 * ── Las dos mitades ──
 *
 * LO QUE VIENE: la cita es hoy o dentro de las próximas horas. El aviso sale una
 * sola vez por orden, y `recordado_en` es lo que lo garantiza.
 *
 * LO QUE SE PASÓ: la hora ya pasó y la orden sigue abierta. Ese es el caso que
 * el pedido nombra —"si se olvida"— y por eso vuelve a avisar cada día hasta
 * que se cierre o se reagende. Una cita vencida en silencio es un equipo que se
 * queda en la casa.
 *
 * Si nadie se hizo cargo de la orden, el aviso va a quien gestiona retiros: sin
 * eso, la cita de una orden sin responsable no se la recuerda nadie.
 */
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
           -- La que ya se avisó hoy no se repite; la vencida vuelve mañana.
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
                || ' — ' || TO_CHAR(r.agendado_para, 'DD/MM HH24:MI')
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
    'Avisa al responsable de las citas de retiro próximas y de las que se pasaron. Una vez por día por orden. Idempotente.';


-- =============================================================================
-- 7. Lo que dijo el abonado, para poder sacarlo
-- =============================================================================
/**
 * Una fila por contacto, con lo que el abonado contestó.
 *
 * Es la materia prima del reporte: quién fue, qué día, con qué resultado y —lo
 * que más importa— qué dijo. Ahí está "pasá el jueves", "ya lo devolví en la
 * oficina" y "no lo voy a entregar", que es la información con la que se decide
 * si se insiste, si se cambia de horario o si se da por perdido.
 *
 * Las órdenes sin ningún intento también aparecen, con el contacto vacío: la
 * que nadie fue a visitar es justamente la que hay que ver en el reporte.
 */
DROP VIEW IF EXISTS v_retiro_gestiones;
CREATE VIEW v_retiro_gestiones AS
SELECT
    re.id                AS retiro_id,
    re.estado            AS estado_orden,
    c.nombre             AS cliente,
    c.codigo             AS cliente_codigo,
    COALESCE(c.telefono_movil, c.telefono) AS telefono,
    c.direccion,
    c.zona,
    re.serie,
    re.modelo,
    re.valor,
    re.meses_sin_pago,
    re.agendado_para,
    re.agenda_nota,
    TRIM(CONCAT(ur.nombre, ' ', COALESCE(ur.apellido, ''))) AS responsable,
    t.nombre             AS tecnico,
    i.creado_en          AS contacto_en,
    i.resultado,
    i.observacion,
    i.foto_url,
    re.observaciones     AS cierre_observaciones,
    re.motivo            AS motivo_cierre,
    re.cerrado_en
FROM retiros_equipo re
JOIN clientes c              ON c.id = re.cliente_id
LEFT JOIN retiro_intentos i  ON i.retiro_id = re.id
LEFT JOIN usuarios_sistema ur ON ur.id = re.responsable_id
LEFT JOIN tecnicos t         ON t.id = re.tecnico_id
WHERE puede_gestionar_retiros()
   OR re.tecnico_id = mi_tecnico_id()
   OR re.responsable_id = mi_legajo_id()
   OR re.vendedor_id = mi_legajo_id();

GRANT SELECT ON v_retiro_gestiones TO authenticated;

COMMENT ON VIEW v_retiro_gestiones IS
    'Cada contacto con el abonado por su equipo, con lo que dijo. Es lo que se exporta al reporte de recuperación.';


-- =============================================================================
-- 8. Que la orden muestre lo nuevo
-- =============================================================================
-- ── Por qué DROP y no CREATE OR REPLACE ──
--
-- Porque la versión que hay en la base se creó con `re.*`, y ese asterisco se
-- expandió con las columnas que la tabla tenía en la 101. Al recrearla ahora,
-- las tres nuevas se meterían ENTRE `cerrado_en` y `cliente`, y REPLACE no
-- puede mover columnas: falla con "cannot change name of view column cliente to
-- responsable_id". Se detectó corriendo la cadena entera en el arnés.
--
-- Dropearla es seguro: no cuelga ninguna vista de ella —lo único que la lee es
-- la pantalla de retiros— y se recrea acá mismo, en la misma transacción.
--
-- Y esta vez las columnas van enumeradas. Con `*`, la próxima columna que se le
-- agregue a la tabla vuelve a romper esto de la misma forma.
DROP VIEW IF EXISTS v_retiros_equipo;
CREATE VIEW v_retiros_equipo AS
SELECT
    re.id,
    re.cliente_id,
    re.vendedor_id,
    re.equipo_id,
    re.onu_id,
    re.serie,
    re.modelo,
    re.valor,
    re.fecha_instalacion,
    re.ultimo_pago,
    re.suspendido_en,
    re.meses_sin_pago,
    re.tecnico_id,
    re.responsable_id,
    re.intentos,
    re.estado,
    re.motivo,
    re.observaciones,
    re.evidencia_url,
    re.agendado_para,
    re.agenda_nota,
    re.recordado_en,
    re.creado_por,
    re.creado_en,
    re.asignado_en,
    re.cerrado_por,
    re.cerrado_en,
    c.nombre  AS cliente,
    COALESCE(c.telefono_movil, c.telefono) AS telefono,
    t.nombre  AS tecnico,
    TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))) AS vendedor,
    (CURRENT_DATE - re.creado_en::DATE)::INT AS dias_abierta,
    (SELECT MAX(i.creado_en) FROM retiro_intentos i WHERE i.retiro_id = re.id) AS ultimo_intento,
    TRIM(CONCAT(ur.nombre, ' ', COALESCE(ur.apellido, ''))) AS responsable,
    c.direccion,
    c.zona
FROM retiros_equipo re
LEFT JOIN clientes c          ON c.id = re.cliente_id
LEFT JOIN tecnicos t          ON t.id = re.tecnico_id
LEFT JOIN usuarios_sistema u  ON u.id = re.vendedor_id
LEFT JOIN usuarios_sistema ur ON ur.id = re.responsable_id
WHERE puede_gestionar_retiros()
   OR re.tecnico_id = mi_tecnico_id()
   OR re.responsable_id = mi_legajo_id()
   OR re.vendedor_id = mi_legajo_id();


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Asignar un recorrido entero a una persona:
--   SELECT * FROM asignar_retiros_equipo(
--       ARRAY(SELECT id FROM retiros_equipo WHERE estado = 'pendiente'),
--       (SELECT id FROM usuarios_sistema WHERE usuario = 'edison'));
--
--   -- Anotar la cita que pidió el abonado:
--   SELECT agendado_para FROM agendar_retiro_equipo(
--       '<orden>', NOW() + INTERVAL '2 hours', 'Dijo que después de las 6');
--
--   -- Y que el aviso salga:
--   SELECT * FROM recordar_retiros_agendados();
--   SELECT titulo, detalle FROM notificaciones WHERE tipo LIKE 'retiro%';
