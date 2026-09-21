-- =============================================================================
-- Migración 62 — Los horarios de los automatismos salen del archivo del servidor
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- A qué hora se factura y a qué hora se corta a los morosos son decisiones del
-- ISP, no del que instaló el sistema. Hasta ahora vivían en middleware/.env: un
-- ISP que quiere cortar a las 9 y no a medianoche necesitaba una sesión SSH.
--
-- Nada de esto es secreto —no hay tokens ni claves— así que va en claro. Lo que
-- sí tiene es consecuencias: encender el corte automático deja gente sin
-- internet. Por eso todo arranca APAGADO y se enciende a propósito.
-- =============================================================================

CREATE TABLE IF NOT EXISTS config_tareas (
    id                      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Corte de las promesas de pago vencidas.
    cortes_automaticos      BOOLEAN,
    cortes_hora             VARCHAR(5),
    -- Tope por corrida: la red de seguridad ante una consulta que devuelva de
    -- más. Nunca deja sin internet a más que esto de una sola vez.
    cortes_limite           INT,

    -- Generación mensual de facturas. No emite nada ante el SRI.
    facturacion_automatica  BOOLEAN,
    facturacion_hora        VARCHAR(5),

    -- Medición del consumo de cada abonado.
    consumo_automatico      BOOLEAN,
    consumo_cada_minutos    INT,

    -- Monitoreo de red: sondeo de los nodos y aviso de caídas.
    nms_automatico          BOOLEAN,
    nms_cada_minutos        INT,
    nms_paquetes            INT,

    -- Lectura de potencia óptica de las OLTs, para el historial.
    optica_automatica       BOOLEAN,
    optica_cada_minutos     INT,

    -- Barrido de ONTs esperando autorización.
    esperando_automatico    BOOLEAN,
    esperando_cada_minutos  INT,

    actualizado_en          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Todo en NULL a propósito: NULL significa "usá lo del archivo". Así, correr
-- esta migración no cambia el comportamiento de ninguna instalación que ya
-- estaba funcionando. Los valores se van pisando uno por uno desde la pantalla.
INSERT INTO config_tareas (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- La hora tiene que ser HH:MM de verdad: un '25:99' guardado sin chistar
-- significa una tarea que no dispara nunca y nadie sabe por qué.
ALTER TABLE config_tareas DROP CONSTRAINT IF EXISTS config_tareas_horas_validas;
ALTER TABLE config_tareas
    ADD CONSTRAINT config_tareas_horas_validas CHECK (
        (cortes_hora      IS NULL OR cortes_hora      ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND
        (facturacion_hora IS NULL OR facturacion_hora ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    );

-- Los intervalos, en un rango con sentido. Cero o negativo haría un bucle que
-- consume el equipo entero; un número enorme es una tarea que no corre nunca.
ALTER TABLE config_tareas DROP CONSTRAINT IF EXISTS config_tareas_intervalos_validos;
ALTER TABLE config_tareas
    ADD CONSTRAINT config_tareas_intervalos_validos CHECK (
        (consumo_cada_minutos   IS NULL OR consumo_cada_minutos   BETWEEN 1 AND 1440) AND
        (nms_cada_minutos       IS NULL OR nms_cada_minutos       BETWEEN 1 AND 1440) AND
        (optica_cada_minutos    IS NULL OR optica_cada_minutos    BETWEEN 1 AND 1440) AND
        (esperando_cada_minutos IS NULL OR esperando_cada_minutos BETWEEN 1 AND 1440) AND
        (nms_paquetes           IS NULL OR nms_paquetes           BETWEEN 1 AND 20) AND
        (cortes_limite          IS NULL OR cortes_limite          BETWEEN 1 AND 100000)
    );

ALTER TABLE config_tareas ENABLE ROW LEVEL SECURITY;

-- Se puede leer desde el navegador: son horarios, no secretos, y la pantalla
-- los muestra igual. Escribir queda para el middleware, que además tiene que
-- reprogramar los temporizadores — un cambio escrito directo en la base no
-- surtiría efecto hasta el próximo reinicio.
DROP POLICY IF EXISTS config_tareas_lectura ON config_tareas;
CREATE POLICY config_tareas_lectura ON config_tareas
    FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE config_tareas IS
    'Horarios de los automatismos. Una sola fila. NULL en una columna = usar el valor del .env.';
