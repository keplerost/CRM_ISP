-- =============================================================================
-- Migración 26 — Tickets de soporte y trabajo en campo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 25.
--
-- ── Volver a correrla no rompe nada ──
--
-- Partes de esta migración quedaron superadas: `v_tickets` se redefinió en la
-- 28, con más columnas. Reemplazar esa versión por la de acá dejaría a las
-- pantallas sin lo que hoy usan.
--
-- Por eso cada una de esas partes se saltea sola. La condición no mira números
-- de migración —este archivo no tiene por qué saber qué vino después— sino el
-- CONTENIDO: si la vista ya tiene la columna que solo trae la versión nueva, no
-- se toca.
--
-- El reclamo entra por teléfono o por WhatsApp y hoy vive en un cuaderno: quién
-- llamó, qué le pasa, a quién se le mandó y si se resolvió. Cuando el abonado
-- vuelve a llamar a los tres días, nadie sabe qué se hizo la primera vez.
--
-- Un ticket es eso mismo pero con historia. Tres decisiones de fondo:
--
-- 1. El ticket copia los datos del abonado en vez de solo apuntarlo. Al técnico
--    en la calle le tiene que servir aunque el cliente cambie de dirección
--    después, y hay reclamos de gente que todavía no es cliente.
--
-- 2. Los datos técnicos cambian según la tecnología. Un reclamo de fibra habla
--    de NAP, puerto y potencia; uno de radio, de torre, frecuencia y señal.
--    Están las dos familias de columnas y la aplicación muestra la que
--    corresponde: partirlo en dos tablas complicaría cada consulta para ahorrar
--    unas columnas nulas.
--
-- 3. El estado se guarda, pero cada cambio deja rastro en `ticket_eventos`. Sin
--    el historial no se puede responder "¿cuánto tardamos?" ni "¿quién lo cerró
--    sin ir?".
-- =============================================================================


-- =============================================================================
-- Técnicos y cuadrillas
-- =============================================================================
CREATE TABLE IF NOT EXISTS tecnicos (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre         VARCHAR(150) NOT NULL,
    identificacion VARCHAR(20),
    telefono       VARCHAR(30),
    email          VARCHAR(150),

    -- Para que el técnico entre a la app y vea solo lo suyo. Puede estar vacío:
    -- hay técnicos que no usan el sistema y a los que se les asigna igual.
    user_id        UUID,

    especialidad   VARCHAR(20) NOT NULL DEFAULT 'ambas'
                   CHECK (especialidad IN ('ftth', 'wireless', 'ambas')),
    activo         BOOLEAN NOT NULL DEFAULT TRUE,
    notas          TEXT,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE tecnicos IS
    'Quién puede recibir una orden de trabajo. `user_id` lo conecta con su usuario de la app, si lo tiene.';

CREATE TABLE IF NOT EXISTS cuadrillas (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre     VARCHAR(100) NOT NULL UNIQUE,
    zona       VARCHAR(100),
    vehiculo   VARCHAR(100),
    activo     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE cuadrillas IS
    'Equipos de dos o más técnicos que salen juntos. Un ticket se asigna a una cuadrilla o a un técnico suelto.';

CREATE TABLE IF NOT EXISTS cuadrilla_miembros (
    cuadrilla_id UUID NOT NULL REFERENCES cuadrillas(id) ON DELETE CASCADE,
    tecnico_id   UUID NOT NULL REFERENCES tecnicos(id)   ON DELETE CASCADE,
    rol          VARCHAR(20) NOT NULL DEFAULT 'tecnico'
                 CHECK (rol IN ('lider', 'tecnico', 'ayudante')),
    PRIMARY KEY (cuadrilla_id, tecnico_id)
);


-- =============================================================================
-- Tickets
-- =============================================================================
CREATE TABLE IF NOT EXISTS tickets (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Número corto para decirlo por radio o por teléfono.
    numero     BIGSERIAL,

    -- Paso 1 — quién reclama ------------------------------------------------
    -- El vínculo sirve para la ficha; los datos copiados, para el papel del
    -- técnico. Un reclamo de alguien que todavía no es cliente va sin vínculo.
    client_id      UUID REFERENCES clientes(id) ON DELETE SET NULL,
    identificacion VARCHAR(20),
    nombre         VARCHAR(150) NOT NULL,
    telefono       VARCHAR(30),
    telefono_whatsapp VARCHAR(30),

    -- Paso 2 — dónde queda -------------------------------------------------
    direccion  VARCHAR(300),
    referencia TEXT,
    sector     VARCHAR(100),
    canton     VARCHAR(100),
    latitud    NUMERIC(10,7),
    longitud   NUMERIC(10,7),

    -- Paso 3 — datos técnicos ----------------------------------------------
    tecnologia VARCHAR(10) NOT NULL DEFAULT 'ftth'
               CHECK (tecnologia IN ('ftth', 'wireless')),

    -- FTTH
    nap_id       UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    puerto_nap   VARCHAR(20),
    ont_modelo   VARCHAR(100),
    ont_serie    VARCHAR(100),
    potencia_dbm NUMERIC(6,2),

    -- Wireless
    torre_id      UUID REFERENCES puntos_red(id) ON DELETE SET NULL,
    -- Texto y no INET a propósito: quien atiende el teléfono escribe lo que le
    -- dictan, y una IP a medias no puede hacer fallar el registro del reclamo.
    cpe_ip        VARCHAR(45),
    frecuencia    VARCHAR(30),
    senal_dbm     NUMERIC(6,2),
    antena_modelo VARCHAR(100),

    -- Paso 4 — diagnóstico y agenda ----------------------------------------
    tipo_incidencia VARCHAR(40) NOT NULL DEFAULT 'sin_internet',
    descripcion     TEXT,
    prioridad       VARCHAR(10) NOT NULL DEFAULT 'media'
                    CHECK (prioridad IN ('alta', 'media', 'baja')),

    fecha_visita  DATE,
    franja        VARCHAR(10) CHECK (franja IN ('manana', 'tarde', 'exacta')),
    hora_visita   TIME,
    tecnico_id    UUID REFERENCES tecnicos(id)   ON DELETE SET NULL,
    cuadrilla_id  UUID REFERENCES cuadrillas(id) ON DELETE SET NULL,

    -- Ciclo de vida ---------------------------------------------------------
    estado VARCHAR(15) NOT NULL DEFAULT 'abierto'
           CHECK (estado IN ('abierto', 'asignado', 'en_ruta', 'en_proceso', 'resuelto', 'cancelado')),

    -- Cierre ----------------------------------------------------------------
    solucion         TEXT,
    -- Qué se verificó antes de irse. Guardado como objeto para poder cambiar la
    -- lista sin migrar la tabla: los tickets viejos conservan la que tenían.
    checklist        JSONB NOT NULL DEFAULT '{}'::JSONB,
    firma_b64        TEXT,
    firmante_nombre  VARCHAR(150),
    firmante_cedula  VARCHAR(20),
    material_usado   TEXT,
    motivo_cancelacion TEXT,

    cerrado_at TIMESTAMP WITH TIME ZONE,
    cerrado_por UUID,

    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE tickets IS
    'Reclamos y órdenes de trabajo. Los datos del abonado se copian: el papel del técnico tiene que servir aunque la ficha cambie después.';
COMMENT ON COLUMN tickets.checklist IS
    'Lo verificado en el cierre, como {"potencia_ok": true, ...}. En JSON para poder cambiar la lista sin migrar.';

CREATE INDEX IF NOT EXISTS idx_tickets_estado    ON tickets (estado, prioridad, fecha_visita);
CREATE INDEX IF NOT EXISTS idx_tickets_cliente   ON tickets (client_id);
CREATE INDEX IF NOT EXISTS idx_tickets_tecnico   ON tickets (tecnico_id) WHERE estado NOT IN ('resuelto', 'cancelado');
CREATE INDEX IF NOT EXISTS idx_tickets_cuadrilla ON tickets (cuadrilla_id) WHERE estado NOT IN ('resuelto', 'cancelado');


-- =============================================================================
-- Historial de estados
-- =============================================================================
-- Sin esto no se puede responder cuánto se tardó ni quién lo cerró sin haber
-- ido: el estado actual solo dice dónde está, no cómo llegó.
CREATE TABLE IF NOT EXISTS ticket_eventos (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    estado_anterior VARCHAR(15),
    estado_nuevo    VARCHAR(15) NOT NULL,
    nota       TEXT,
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_eventos ON ticket_eventos (ticket_id, created_at);

-- El rastro lo deja la base, no la pantalla: un cambio hecho desde un script o
-- desde el panel de Supabase también tiene que quedar registrado.
CREATE OR REPLACE FUNCTION ticket_registra_estado()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO ticket_eventos (ticket_id, estado_anterior, estado_nuevo, nota, created_by)
        VALUES (NEW.id, NULL, NEW.estado, 'Ticket creado', NEW.created_by);
        RETURN NEW;
    END IF;

    IF NEW.estado IS DISTINCT FROM OLD.estado THEN
        INSERT INTO ticket_eventos (ticket_id, estado_anterior, estado_nuevo, created_by)
        VALUES (NEW.id, OLD.estado, NEW.estado, NEW.cerrado_por);
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ticket_estado_ins ON tickets;
CREATE TRIGGER trg_ticket_estado_ins
    AFTER INSERT ON tickets
    FOR EACH ROW EXECUTE FUNCTION ticket_registra_estado();

DROP TRIGGER IF EXISTS trg_ticket_estado_upd ON tickets;
CREATE TRIGGER trg_ticket_estado_upd
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION ticket_registra_estado();


-- =============================================================================
-- Evidencia: fotos del trabajo
-- =============================================================================
-- Las fotos van al bucket de Storage; acá queda la ruta y de qué es cada una.
-- Guardar la imagen en la tabla haría que cada consulta del listado arrastre
-- megabytes.
CREATE TABLE IF NOT EXISTS ticket_adjuntos (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id  UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tipo       VARCHAR(20) NOT NULL DEFAULT 'foto'
               CHECK (tipo IN ('foto', 'potencia', 'antes', 'despues', 'otro')),
    ruta       TEXT NOT NULL,
    descripcion VARCHAR(200),
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_adjuntos ON ticket_adjuntos (ticket_id);


-- =============================================================================
-- La vista que usa la aplicación
-- =============================================================================
-- Resuelve los nombres que el técnico necesita leer —la caja, la torre, quién
-- va— y calcula lo que se pregunta siempre: cuánto lleva abierto y si la visita
-- ya se pasó de fecha.
DO $guarda$
BEGIN
    /**
     * Si la vista ya tiene `email`, la cadena siguió y esta versión quedó
     * atrás: la 28 la redefinió con más columnas. Recrearla desde acá se
     * las sacaría a las pantallas que hoy las usan.
     *
     * Por eso no se toca. Y por eso la pregunta es por el CONTENIDO de la vista
     * y no por un número de migración: este archivo no necesita saber nada del
     * futuro, le alcanza con mirar cómo está la vista hoy.
     */
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_tickets'
           AND column_name = 'email'
    ) THEN
        RAISE NOTICE 'v_tickets ya está en su versión de la 28: no se toca.';
        RETURN;
    END IF;

    EXECUTE 'DROP VIEW IF EXISTS v_tickets';
    EXECUTE $vista$
CREATE VIEW v_tickets WITH (security_invoker = true) AS
SELECT
    t.*,
    LPAD(t.numero::TEXT, 6, '0')          AS codigo,
    nap.nombre                            AS nap,
    torre.nombre                          AS torre,
    tec.nombre                            AS tecnico,
    tec.telefono                          AS tecnico_telefono,
    cua.nombre                            AS cuadrilla,
    c.nombre                              AS cliente,
    c.plan_id,
    c.estado                              AS estado_cliente,
    -- Cuánto lleva sin resolverse. Es la métrica que se mira para saber si el
    -- soporte va al día o se está acumulando.
    EXTRACT(EPOCH FROM (COALESCE(t.cerrado_at, NOW()) - t.created_at)) / 3600 AS horas_abierto,
    (t.estado NOT IN ('resuelto', 'cancelado')
     AND t.fecha_visita IS NOT NULL
     AND t.fecha_visita < CURRENT_DATE)   AS visita_atrasada,
    (SELECT COUNT(*) FROM ticket_adjuntos a WHERE a.ticket_id = t.id) AS adjuntos
FROM tickets t
LEFT JOIN puntos_red nap  ON nap.id  = t.nap_id
LEFT JOIN puntos_red torre ON torre.id = t.torre_id
LEFT JOIN tecnicos tec    ON tec.id  = t.tecnico_id
LEFT JOIN cuadrillas cua  ON cua.id  = t.cuadrilla_id
LEFT JOIN clientes c      ON c.id    = t.client_id
$vista$;
END $guarda$;

COMMENT ON VIEW v_tickets IS
    'Tickets con los nombres resueltos y el tiempo abierto. Es lo que leen el listado y la ficha del técnico.';


-- =============================================================================
-- Permisos
-- =============================================================================
ALTER TABLE tecnicos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuadrillas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuadrilla_miembros ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_eventos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_adjuntos    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['tecnicos','cuadrillas','cuadrilla_miembros','tickets','ticket_eventos','ticket_adjuntos']
    LOOP
        EXECUTE FORMAT('DROP POLICY IF EXISTS %I ON %I', t || '_autenticados', t);
        EXECUTE FORMAT(
            'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE)',
            t || '_autenticados', t
        );
    END LOOP;
END $$;
