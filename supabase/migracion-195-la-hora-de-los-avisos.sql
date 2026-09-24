-- =============================================================================
-- Migración 195 — La hora a la que salen los avisos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- La facturación corre a la 01:30 y el corte por mora a las 05:00, porque son
-- las horas en que la red está tranquila y nadie está usando el sistema. Pero
-- los avisos salían EN ESE MISMO MOMENTO, así que al abonado le llegaba un
-- mensaje a la una y media de la madrugada.
--
-- Una abonada pidió el retiro del servicio por eso. No por la deuda: por el
-- susto. Un mensaje a esa hora se lee como una emergencia familiar, no como una
-- factura — y para cuando lo abre, ya se llevó el sobresalto.
--
-- ── Lo que se agrega ──
--
-- Una franja en la que se le puede escribir a un abonado. Lo que se genere
-- fuera de ella no se pierde ni se manda tarde a propósito: queda en la cola
-- que ya existe, con la hora a la que corresponde salir.
--
-- ── Lo que NO respeta la franja, y por qué ──
--
-- Los avisos que responden a algo que la persona acaba de hacer: el comprobante
-- de un pago, la respuesta a su ticket. Si alguien paga a las once de la noche
-- quiere su confirmación en el momento, no a la mañana siguiente — está
-- esperando con el teléfono en la mano.
--
-- La franja es para lo que el sistema decide por su cuenta: la factura nueva,
-- el corte, los recordatorios de pago.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. La franja
-- -----------------------------------------------------------------------------

ALTER TABLE config_mensajeria
    ADD COLUMN IF NOT EXISTS avisos_desde TEXT NOT NULL DEFAULT '08:00',
    ADD COLUMN IF NOT EXISTS avisos_hasta TEXT NOT NULL DEFAULT '20:00';

COMMENT ON COLUMN config_mensajeria.avisos_desde IS
    'Desde qué hora se le puede escribir a un abonado. Lo generado antes espera.';
COMMENT ON COLUMN config_mensajeria.avisos_hasta IS
    'Hasta qué hora. Lo generado después sale a la mañana siguiente.';


-- -----------------------------------------------------------------------------
-- 2. Cuándo le toca salir a cada aviso encolado
-- -----------------------------------------------------------------------------

/**
 * A partir de cuándo se puede mandar.
 *
 * NULL significa "ya" —es lo que había hasta ahora, y así siguen funcionando
 * los avisos ya encolados sin tocar ninguna fila—. Con fecha, la cola lo saltea
 * hasta que llegue el momento.
 */
ALTER TABLE avisos_pendientes
    ADD COLUMN IF NOT EXISTS enviar_desde TIMESTAMPTZ;

COMMENT ON COLUMN avisos_pendientes.enviar_desde IS
    'No mandarlo antes de esta hora. NULL = se puede mandar ya.';

-- El índice de la cola tiene que poder saltear lo que todavía no toca sin
-- recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS idx_avisos_pendientes_cuando
    ON avisos_pendientes (enviar_desde, creado_en) WHERE procesado_en IS NULL;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT avisos_desde, avisos_hasta FROM config_mensajeria;
--
--   -- Qué hay esperando su hora:
--   SELECT tipo, COUNT(*), MIN(enviar_desde) AS el_primero
--     FROM avisos_pendientes
--    WHERE procesado_en IS NULL AND enviar_desde > NOW()
--    GROUP BY tipo;


-- -----------------------------------------------------------------------------
-- 3. Que la cola saltee lo que todavía no toca
-- -----------------------------------------------------------------------------
-- `v_avisos_a_enviar` es lo que lee el drenaje cada pocos segundos. Sin esta
-- condición, un aviso encolado para las 08:00 saldría igual en la próxima
-- pasada y toda la franja no serviría de nada.
--
-- Se envuelve la definición actual en vez de reescribirla: la vista tiene más
-- de treinta columnas y seis JOIN, y copiarla a mano para agregar una línea es
-- pedir que se pierda alguna por el camino.

DO $guarda$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.views
         WHERE table_schema = 'public' AND table_name = 'v_avisos_a_enviar'
    ) THEN
        RAISE NOTICE 'v_avisos_a_enviar todavía no existe: no hay nada que ajustar.';
        RETURN;
    END IF;

    -- Ya filtrada: se reconoce porque el texto de la vista menciona la columna.
    IF pg_get_viewdef('v_avisos_a_enviar'::regclass, true) LIKE '%enviar_desde%' THEN
        RAISE NOTICE 'v_avisos_a_enviar ya respeta la hora: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW v_avisos_a_enviar AS '
         || 'SELECT v.* FROM (' || rtrim(pg_get_viewdef('v_avisos_a_enviar'::regclass, true), ';') || ') v '
         || 'JOIN avisos_pendientes ap ON ap.id = v.aviso_id '
         || 'WHERE ap.enviar_desde IS NULL OR ap.enviar_desde <= NOW()';
    RAISE NOTICE 'v_avisos_a_enviar respeta la hora de cada aviso.';
END $guarda$;
