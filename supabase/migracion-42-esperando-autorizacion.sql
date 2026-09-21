-- =============================================================================
-- Migración 42 · ONTs esperando autorización
-- =============================================================================
-- El resultado del barrido se guarda en vez de consultarse al abrir la pantalla.
--
-- La diferencia es lo que se siente al usarlo: consultando en vivo, cada vez que
-- alguien abre el tablero espera quince segundos y le pega a todas las OLTs.
-- Guardado, la pantalla pinta al instante lo último que se escaneó y dice de
-- cuándo es — que es la información honesta y además la útil.
--
-- Idempotente.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Lo que está esperando ahora mismo
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onts_esperando (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    olt_id      UUID NOT NULL REFERENCES olts(id) ON DELETE CASCADE,
    sn          VARCHAR(50) NOT NULL,
    slot        INT,
    puerto      INT,
    modelo      VARCHAR(60),
    -- Cuándo la vio el equipo por primera vez. Es dato del equipo, no nuestro:
    -- una ONT puede llevar semanas esperando que alguien la autorice.
    detectada   TIMESTAMPTZ,
    -- Cuándo la confirmamos por última vez. Sirve para borrar las que ya no
    -- están sin tener que vaciar la tabla en cada pasada.
    visto_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (olt_id, sn)
);

CREATE INDEX IF NOT EXISTS onts_esperando_olt_idx ON onts_esperando (olt_id);

COMMENT ON TABLE onts_esperando IS
    'ONTs conectadas a la fibra que ninguna persona autorizó todavía. Se confirma cada una contra la cola viva de la OLT: el registro SNMP del equipo conserva entradas de ONTs que ya salieron, y publicarlas haría salir a buscar equipos que no están.';


-- -----------------------------------------------------------------------------
-- 2. Cómo fue el último barrido de cada OLT
-- -----------------------------------------------------------------------------
-- En tabla aparte y no como columnas de `olts` a propósito: `olts` tiene un
-- disparador que registra cada cambio en el historial, y un barrido cada cinco
-- minutos lo llenaría de ruido hasta tapar los cambios que hizo una persona.
CREATE TABLE IF NOT EXISTS olt_escaneos (
    olt_id      UUID PRIMARY KEY REFERENCES olts(id) ON DELETE CASCADE,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    encontradas INT NOT NULL DEFAULT 0,
    descartadas INT NOT NULL DEFAULT 0,
    puertos     INT NOT NULL DEFAULT 0,
    ms          INT,
    -- Un barrido que falló NO es un barrido con cero resultados. Mostrar "sin
    -- ONTs nuevas" cuando en realidad no se pudo consultar se lee como una
    -- buena noticia y es lo contrario.
    error       TEXT
);


-- -----------------------------------------------------------------------------
-- 3. Vista para el tablero
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_esperando_autorizacion;
CREATE VIEW v_esperando_autorizacion WITH (security_invoker = true) AS
SELECT
    o.id            AS olt_id,
    o.numero,
    o.nombre        AS olt,
    o.activo,
    (o.snmp_ro_encrypted IS NOT NULL AND o.snmp_ro_encrypted <> '') AS tiene_snmp,

    e.at            AS escaneada_at,
    e.error         AS escaneo_error,
    e.puertos       AS puertos_consultados,
    e.descartadas,
    e.ms            AS escaneo_ms,
    CASE WHEN e.at IS NULL THEN NULL
         ELSE EXTRACT(EPOCH FROM (NOW() - e.at))::INT END AS escaneada_hace_segundos,

    COALESCE(n.cuantas, 0) AS esperando
FROM olts o
LEFT JOIN olt_escaneos e ON e.olt_id = o.id
LEFT JOIN (
    SELECT olt_id, COUNT(*) AS cuantas FROM onts_esperando GROUP BY olt_id
) n ON n.olt_id = o.id;


-- -----------------------------------------------------------------------------
-- 4. RLS
-- -----------------------------------------------------------------------------
-- Explícito y no dentro de un bloque DO con SQL dinámico: el analizador estático
-- de Supabase no puede leer adentro de un EXECUTE y reporta estas tablas como si
-- quedaran sin RLS. Ya pasó con la migración 38 y se corrigió ahí; acá me olvidé
-- de aplicar la misma lección.
--
-- Una advertencia que hay que explicar cada vez termina siendo una advertencia
-- que alguien ignora el día que es de verdad.

ALTER TABLE onts_esperando ENABLE ROW LEVEL SECURITY;
ALTER TABLE olt_escaneos   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_onts_esperando" ON onts_esperando;
CREATE POLICY "auth_all_onts_esperando" ON onts_esperando
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_all_olt_escaneos" ON olt_escaneos;
CREATE POLICY "auth_all_olt_escaneos" ON olt_escaneos
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
