-- =============================================================================
-- Migración 219 — El plazo de cada trabajo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Los abonados se quejan de cuánto ESPERAN, y eso no se medía. La puntualidad
-- de la migración 92 compara la llegada con la hora agendada: si el reclamo
-- entra el lunes y se agenda para el jueves, el técnico llega "puntual" y el
-- abonado esperó tres días.
--
-- Ahora cada trabajo tiene un plazo según su tipo —sin internet, lentitud,
-- instalación…— contado desde que se registró, y se mide:
--
--   * la ESPERA del abonado: desde que se registró hasta que llegó el técnico;
--   * si se llegó DENTRO DEL PLAZO;
--   * POR QUÉ no, cuando no: el técnico que llega fuera de plazo elige el motivo
--     en la app antes de marcar la llegada;
--   * y se AVISA antes de que venza, por el mismo canal que las alertas de red.
--
-- ── Por qué el plazo cuenta desde que se registró y no desde la agenda ──
--
-- Porque es lo que siente el abonado. Contarlo desde la agenda dejaría esconder
-- la demora agendando lejos. La contra es que la espera incluye lo que tardó la
-- oficina en asignar: por eso la pantalla la muestra AL LADO de la puntualidad,
-- que sí es solo del técnico, y no en lugar de ella.
-- =============================================================================


-- =============================================================================
-- 1. Los plazos, por tipo de trabajo
-- =============================================================================
CREATE TABLE IF NOT EXISTS plazos_atencion (
    -- Las mismas claves que `tickets.tipo_incidencia`. Las instalaciones usan
    -- 'instalacion', 'traslado' y 'retiro' según su tipo; el resto cae en 'otro'.
    clave          VARCHAR(40) PRIMARY KEY,
    nombre         VARCHAR(80) NOT NULL,
    horas          NUMERIC(6,1) NOT NULL CHECK (horas > 0 AND horas <= 720),
    orden          SMALLINT NOT NULL DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE plazos_atencion IS
    'En cuántas horas desde que se registra un trabajo tiene que llegar el técnico, por tipo. Se edita en Soporte → Desempeño del equipo.';

-- Valores de partida. Se ajustan desde la pantalla; volver a correr esto no
-- pisa lo que se haya cambiado.
INSERT INTO plazos_atencion (clave, nombre, horas, orden) VALUES
    ('sin_internet',  'Sin internet',              4,  1),
    ('fibra_cortada', 'Fibra cortada',             4,  2),
    ('lentitud',      'Lentitud',                 24,  3),
    ('intermitencia', 'Intermitencia / se corta', 24,  4),
    ('potencia_baja', 'Potencia baja',            24,  5),
    ('senal_baja',    'Señal baja',               24,  6),
    ('equipo_danado', 'Equipo dañado',            24,  7),
    ('cambio_clave',  'Cambio de clave WiFi',     24,  8),
    ('instalacion',   'Instalación nueva',        72,  9),
    ('traslado',      'Traslado de domicilio',    72, 10),
    ('retiro',        'Retiro de equipos',        72, 11),
    ('otro',          'Otro',                     48, 12)
ON CONFLICT (clave) DO NOTHING;

/**
 * Quién puede cambiar los plazos.
 *
 * El que asigna los trabajos y el que administra. El técnico los ve —le sirve
 * saber cuánto tiene— pero no se los fija a sí mismo.
 */
CREATE OR REPLACE FUNCTION puede_editar_plazos()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'ajustes.editar' OR permisos ? 'soporte.asignar'
           FROM usuarios_sistema
          WHERE auth_id = auth.uid() AND activo
          LIMIT 1),
        FALSE
    )
$$;

ALTER TABLE plazos_atencion ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plazos_atencion_lectura ON plazos_atencion;
CREATE POLICY plazos_atencion_lectura ON plazos_atencion
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS plazos_atencion_edicion ON plazos_atencion;
CREATE POLICY plazos_atencion_edicion ON plazos_atencion
    FOR UPDATE TO authenticated
    USING (puede_editar_plazos()) WITH CHECK (puede_editar_plazos());

GRANT SELECT, UPDATE ON plazos_atencion TO authenticated;


-- =============================================================================
-- 1b. Por qué se llegó fuera de plazo
-- =============================================================================
-- Lo carga el técnico en la app al marcar la llegada, solo si ya se venció. Va
-- en la misma fila del trabajo y en el mismo guardado que la llegada: así viaja
-- junto por la cola sin señal y no puede quedar una llegada tarde sin su motivo
-- por un corte a la mitad.
--
-- No se exige con un disparador a propósito: la cola sin señal puede subir la
-- llegada horas después, con plazos que mientras tanto cambiaron, y rechazarla
-- haría perder la marca de llegada, que vale más. La que llega sin motivo se ve
-- en el tablero como "sin justificar".
ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS demora_motivo        VARCHAR(30),
    ADD COLUMN IF NOT EXISTS demora_nota          TEXT,
    ADD COLUMN IF NOT EXISTS demora_registrada_at TIMESTAMPTZ;

ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS demora_motivo        VARCHAR(30),
    ADD COLUMN IF NOT EXISTS demora_nota          TEXT,
    ADD COLUMN IF NOT EXISTS demora_registrada_at TIMESTAMPTZ;

-- Los mismos valores que `MOTIVOS_DEMORA` en web/src/lib/plazos.js.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_demora_motivo_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_demora_motivo_check
    CHECK (demora_motivo IS NULL OR demora_motivo IN
           ('asignado_tarde', 'cliente', 'trabajo_anterior', 'material', 'vehiculo', 'clima', 'otro'));

ALTER TABLE instalaciones DROP CONSTRAINT IF EXISTS instalaciones_demora_motivo_check;
ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_demora_motivo_check
    CHECK (demora_motivo IS NULL OR demora_motivo IN
           ('asignado_tarde', 'cliente', 'trabajo_anterior', 'material', 'vehiculo', 'clima', 'otro'));

COMMENT ON COLUMN tickets.demora_motivo IS
    'Por qué el técnico llegó fuera del plazo de su tipo. Lo elige en la app al marcar la llegada.';
COMMENT ON COLUMN instalaciones.demora_motivo IS
    'Por qué el técnico llegó fuera del plazo de su tipo. Lo elige en la app al marcar la llegada.';


-- =============================================================================
-- 2. Cada trabajo con su plazo
-- =============================================================================
-- Una fila por ticket o instalación con técnico o sin él: el que todavía no
-- tiene técnico es justamente el que más riesgo corre de vencerse.
--
--   pendiente     falta que llegue el técnico y el trabajo sigue abierto
--   vence_at      registrado + horas del plazo de su tipo
--   minutos_espera  registrado → llegada. Nulo si no marcó llegada.
--   en_plazo      TRUE/FALSE si ya se puede juzgar; NULL si todavía no o si se
--                 cerró sin marcar llegada (no se inventa ni a favor ni en contra)
-- Se borra antes de crearla: la 220 le agrega columnas, y un CREATE OR
-- REPLACE con menos columnas falla. Así esta migración se puede volver a
-- correr; la cadena vuelve a pasar por la 220 después. CASCADE se lleva
-- v_plazos_tecnico (se recrea abajo), detalle_plazo() de la 220 y
-- v_plazos_cuadrilla de la 222.
DROP VIEW IF EXISTS v_plazos_trabajo CASCADE;

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
        t.demora_nota
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
        i.demora_nota
    FROM instalaciones i
    LEFT JOIN clientes c ON c.id = i.client_id
    -- El prospecto todavía no es una orden: no hay nada que atender.
    WHERE i.estado <> 'prospecto'
)
SELECT
    tr.*,
    -- Un tipo que no está en la tabla usa el plazo de 'otro'; si tampoco está,
    -- un día. Nunca queda sin plazo.
    COALESCE(pa.nombre, po.nombre, tr.tipo)  AS tipo_nombre,
    COALESCE(pa.horas, po.horas, 24)         AS plazo_horas,
    tr.registrado_at + MAKE_INTERVAL(secs => COALESCE(pa.horas, po.horas, 24) * 3600) AS vence_at,
    tc.nombre AS tecnico,
    CASE WHEN tr.llegada_at IS NOT NULL
         THEN (EXTRACT(EPOCH FROM (tr.llegada_at - tr.registrado_at)) / 60)::INT END AS minutos_espera,
    CASE
        WHEN tr.llegada_at IS NOT NULL
            THEN tr.llegada_at <= tr.registrado_at + MAKE_INTERVAL(secs => COALESCE(pa.horas, po.horas, 24) * 3600)
        -- Sigue esperando y ya se pasó: se cuenta como fuera de plazo desde ya,
        -- sin esperar a que llegue. Si no, el que nunca va nunca falla.
        WHEN tr.pendiente
             AND NOW() > tr.registrado_at + MAKE_INTERVAL(secs => COALESCE(pa.horas, po.horas, 24) * 3600)
            THEN FALSE
    END AS en_plazo
FROM trabajos tr
LEFT JOIN plazos_atencion pa ON pa.clave = tr.tipo
LEFT JOIN plazos_atencion po ON po.clave = 'otro'
LEFT JOIN tecnicos tc        ON tc.id = tr.tecnico_id;

COMMENT ON VIEW v_plazos_trabajo IS
    'Cada ticket e instalación con su plazo según el tipo, cuánto esperó el abonado hasta la llegada del técnico y si se llegó dentro del plazo.';

GRANT SELECT ON v_plazos_trabajo TO authenticated;


-- =============================================================================
-- 3. Por técnico y por mes
-- =============================================================================
-- Se cuelga del mes de la llegada, o del vencimiento si nunca llegó: el trabajo
-- que se venció en marzo es de marzo aunque se atienda en abril.
CREATE OR REPLACE VIEW v_plazos_tecnico WITH (security_invoker = true) AS
WITH base AS (
    SELECT
        p.*,
        DATE_TRUNC('month', COALESCE(p.llegada_at, p.vence_at) AT TIME ZONE zona_horaria())::DATE AS mes
    FROM v_plazos_trabajo p
    WHERE p.tecnico_id IS NOT NULL
      AND (p.en_plazo IS NOT NULL OR p.minutos_espera IS NOT NULL)
),
-- Cuántos fuera de plazo por cada motivo: {"asignado_tarde": 2, "cliente": 1}.
motivos AS (
    SELECT tecnico_id, mes, jsonb_object_agg(demora_motivo, n) AS motivos
      FROM (SELECT tecnico_id, mes, demora_motivo, COUNT(*) AS n
              FROM base
             WHERE en_plazo = FALSE AND demora_motivo IS NOT NULL
             GROUP BY 1, 2, 3) m
     GROUP BY 1, 2
)
SELECT
    b.tecnico_id,
    b.mes,
    COUNT(*) FILTER (WHERE b.en_plazo IS NOT NULL)  AS con_plazo,
    COUNT(*) FILTER (WHERE b.en_plazo)              AS en_plazo,
    CASE WHEN COUNT(*) FILTER (WHERE b.en_plazo IS NOT NULL) > 0
         THEN ROUND(100.0 * COUNT(*) FILTER (WHERE b.en_plazo)
                    / COUNT(*) FILTER (WHERE b.en_plazo IS NOT NULL)) END AS pct_en_plazo,
    COUNT(*) FILTER (WHERE b.minutos_espera IS NOT NULL) AS con_espera,
    -- La mediana, como en el resto del tablero: un trabajo de tres días por un
    -- poste caído no puede hacer parecer lento a todo el mes.
    (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.minutos_espera)
        FILTER (WHERE b.minutos_espera IS NOT NULL))::INT AS espera_mediana_min,

    -- Los fuera de plazo, separados en tres: los que todavía esperan (no pueden
    -- justificar nada aún), los que llegaron con motivo y los que llegaron sin.
    COUNT(*) FILTER (WHERE b.en_plazo = FALSE)                                       AS fuera_plazo,
    COUNT(*) FILTER (WHERE b.en_plazo = FALSE AND b.llegada_at IS NULL)              AS esperando,
    COUNT(*) FILTER (WHERE b.en_plazo = FALSE AND b.llegada_at IS NOT NULL
                       AND b.demora_motivo IS NULL)                                  AS sin_justificar,
    COALESCE(MAX(m.motivos::TEXT)::JSONB, '{}'::JSONB)                               AS motivos
FROM base b
LEFT JOIN motivos m ON m.tecnico_id = b.tecnico_id AND m.mes = b.mes
GROUP BY 1, 2;

GRANT SELECT ON v_plazos_tecnico TO authenticated;


-- =============================================================================
-- 4. El aviso antes de que venza
-- =============================================================================
-- Una regla más de las alertas: se configura en Ajustes → Alertas como las
-- otras. El umbral es cuántos minutos antes del vencimiento se avisa.
--
-- De día por defecto: a las tres de la mañana nadie va a mandar un técnico, y
-- un aviso que no se puede atender enseña a ignorar los que sí. El evento no se
-- pierde: se manda apenas empieza la franja.
INSERT INTO alerta_reglas (clave, nombre, descripcion, espera_min, umbral, desde_hora, hasta_hora)
VALUES (
    'plazo_atencion',
    'Plazo de atención',
    'Un ticket o una instalación está por vencer su plazo sin que haya llegado el técnico. Los plazos por tipo se ajustan en Soporte → Desempeño del equipo.',
    0, 60, '07:00', '21:00'
)
ON CONFLICT (clave) DO NOTHING;

/**
 * Abre un evento por cada trabajo que entró en la ventana de aviso, y cierra los
 * que ya se atendieron.
 *
 * Lo llama el middleware en cada pasada de las alertas. Separado de
 * `detectar_alertas()` porque aquella mira la red y esta mira la agenda: que una
 * falle no tiene que apagar la otra.
 *
 * Solo trabajos de los últimos 30 días: uno olvidado hace meses no es una
 * urgencia, es una limpieza pendiente, y avisarlo de golpe taparía lo de hoy.
 */
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
        SELECT 'plazo_atencion', p.clase, p.id::TEXT, p.cliente, p.zona, 1,
               jsonb_strip_nulls(jsonb_build_object(
                   'numero',      p.numero,
                   'tipo',        p.tipo,
                   'tipo_nombre', p.tipo_nombre,
                   'tecnico',     p.tecnico,
                   'vence_at',    p.vence_at,
                   'registrado_at', p.registrado_at,
                   'direccion',   p.direccion,
                   'telefono',    p.telefono
               )),
               NOW()
          FROM v_plazos_trabajo p
         WHERE p.pendiente
           AND p.registrado_at > NOW() - INTERVAL '30 days'
           AND NOW() >= p.vence_at - MAKE_INTERVAL(mins => v_umbral::INT)
        ON CONFLICT (regla, entidad, entidad_id) WHERE resuelto_en IS NULL DO NOTHING;

        GET DIAGNOSTICS v_abiertos = ROW_COUNT;
    END IF;

    -- Se cierra cuando ya no está pendiente: llegó el técnico, se canceló o se
    -- borró. Si la regla se apagó, también: no tiene sentido dejar abiertos
    -- avisos que nadie va a mandar.
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

COMMENT ON FUNCTION detectar_plazos IS
    'Abre un evento de alerta por cada trabajo que está por vencer su plazo sin llegada del técnico, y cierra los ya atendidos. La llama el middleware junto con detectar_alertas().';

-- Solo la llama el middleware.
REVOKE ALL ON FUNCTION detectar_plazos() FROM PUBLIC, anon, authenticated;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT clave, nombre, horas FROM plazos_atencion ORDER BY orden;
--   SELECT clase, numero, cliente, tipo_nombre, vence_at, pendiente, minutos_espera, en_plazo
--     FROM v_plazos_trabajo ORDER BY registrado_at DESC LIMIT 20;
--   SELECT * FROM v_plazos_tecnico ORDER BY mes DESC;
--   SELECT * FROM detectar_plazos();
