-- =============================================================================
-- Migración 38 · Ficha completa de la OLT
-- =============================================================================
-- Hasta acá una OLT era nada más que "cómo me conecto": nombre, IP, puerto y
-- credenciales. Esta migración la convierte en el equipo completo — SNMP, TR069,
-- versiones detectadas, estado de alcance — y le agrega las dos cosas que uno
-- termina necesitando siempre y siempre tarde: el historial de quién cambió qué,
-- y los respaldos de configuración.
--
-- Idempotente: se puede correr varias veces sin romper nada.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Columnas nuevas de `olts`
-- -----------------------------------------------------------------------------
ALTER TABLE olts
    -- Identificador corto y ordenable. El UUID es correcto para la máquina pero
    -- inservible para un humano que quiere decir "andá a la 3".
    ADD COLUMN IF NOT EXISTS numero BIGSERIAL,

    -- ¿Se llega por túnel VPN? Cambia por completo el diagnóstico cuando no
    -- responde: si es por VPN, lo primero que hay que mirar es el túnel y no la
    -- OLT.
    ADD COLUMN IF NOT EXISTS via_vpn BOOLEAN DEFAULT FALSE,

    -- SNMP. Las comunidades se guardan cifradas igual que las contraseñas: dan
    -- lectura (y con la RW, escritura) a todo el equipo.
    ADD COLUMN IF NOT EXISTS snmp_ro_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS snmp_rw_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS snmp_puerto INT DEFAULT 161,
    ADD COLUMN IF NOT EXISTS snmp_trap BOOLEAN DEFAULT FALSE,

    ADD COLUMN IF NOT EXISTS iptv BOOLEAN DEFAULT FALSE,

    -- Versiones. Se cargan solas leyéndolas del equipo, no a mano: una versión
    -- tipeada por una persona es una versión que quedó vieja el día que alguien
    -- actualizó el firmware sin avisar. Justamente por eso el detector de
    -- inconsistencias compara esto contra lo que el equipo dice hoy.
    ADD COLUMN IF NOT EXISTS hw_version VARCHAR(60),
    ADD COLUMN IF NOT EXISTS sw_version VARCHAR(60),
    ADD COLUMN IF NOT EXISTS pon_tipos VARCHAR(60),
    ADD COLUMN IF NOT EXISTS versiones_at TIMESTAMPTZ,

    ADD COLUMN IF NOT EXISTS ntp_servers TEXT,
    ADD COLUMN IF NOT EXISTS tr069_perfil VARCHAR(80),
    ADD COLUMN IF NOT EXISTS tr069_interfaz VARCHAR(40) DEFAULT 'mgmt_ip',

    -- Último resultado del chequeo de alcance. Se cachea a propósito: el listado
    -- muestra el puntito verde de todas las OLTs y abrir una sesión SSH contra
    -- cada una para pintar un círculo sería carísimo, además de consumir las
    -- ranuras de sesión del equipo.
    ADD COLUMN IF NOT EXISTS estado VARCHAR(12) DEFAULT 'desconocido',
    ADD COLUMN IF NOT EXISTS estado_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS estado_latencia_ms INT,
    ADD COLUMN IF NOT EXISTS estado_detalle TEXT,

    ADD COLUMN IF NOT EXISTS notas TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE olts DROP CONSTRAINT IF EXISTS olts_estado_check;
ALTER TABLE olts
    ADD CONSTRAINT olts_estado_check
    CHECK (estado IN ('online', 'offline', 'desconocido'));

ALTER TABLE olts DROP CONSTRAINT IF EXISTS olts_tr069_interfaz_check;
ALTER TABLE olts
    ADD CONSTRAINT olts_tr069_interfaz_check
    CHECK (tr069_interfaz IN ('mgmt_ip', 'wan_ip', 'loopback', 'ninguna'));

-- El número tiene que ser único aunque la columna se haya agregado sobre filas
-- que ya existían.
CREATE UNIQUE INDEX IF NOT EXISTS olts_numero_key ON olts (numero);


-- -----------------------------------------------------------------------------
-- 2. Historial de cambios
-- -----------------------------------------------------------------------------
-- La pregunta que esto contesta es siempre la misma y siempre a destiempo:
-- "esto andaba el viernes, ¿qué se tocó?".
CREATE TABLE IF NOT EXISTS olt_historial (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id         UUID NOT NULL REFERENCES olts(id) ON DELETE CASCADE,
    accion         VARCHAR(20) NOT NULL DEFAULT 'editar',
    campo          VARCHAR(60),
    valor_antes    TEXT,
    valor_despues  TEXT,
    quien          TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS olt_historial_olt_idx
    ON olt_historial (olt_id, created_at DESC);


-- -----------------------------------------------------------------------------
-- 3. Respaldos de configuración
-- -----------------------------------------------------------------------------
-- El texto va en la fila y no en Storage: una configuración de OLT son decenas
-- de KB de texto plano, se quiere buscar dentro con SQL, y tenerla en la misma
-- base que el resto evita que un respaldo sobreviva a la fila que lo explica.
CREATE TABLE IF NOT EXISTS olt_backups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id      UUID NOT NULL REFERENCES olts(id) ON DELETE CASCADE,
    nombre      VARCHAR(120) NOT NULL,
    contenido   TEXT NOT NULL,
    bytes       INT GENERATED ALWAYS AS (LENGTH(contenido)) STORED,
    comando     TEXT,
    quien       TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS olt_backups_olt_idx
    ON olt_backups (olt_id, created_at DESC);


-- -----------------------------------------------------------------------------
-- 4. El historial se escribe solo
-- -----------------------------------------------------------------------------
-- Si dependiera de que cada endpoint se acuerde de registrar, el primero que se
-- agregue olvidándolo deja un cambio sin rastro — y es exactamente el cambio
-- que después nadie va a poder explicar.
CREATE OR REPLACE FUNCTION registrar_cambio_olt()
RETURNS TRIGGER AS $$
DECLARE
    antes    JSONB := to_jsonb(OLD);
    despues  JSONB := to_jsonb(NEW);
    clave    TEXT;
    v_antes  TEXT;
    v_desp   TEXT;
    autor    TEXT;
BEGIN
    BEGIN
        autor := COALESCE(auth.jwt() ->> 'email', auth.uid()::text);
    EXCEPTION WHEN OTHERS THEN
        autor := NULL;
    END;
    -- Sin JWT el cambio vino del middleware con service_role, que es como entra
    -- todo lo automático.
    autor := COALESCE(autor, 'sistema');

    FOR clave IN SELECT jsonb_object_keys(despues)
    LOOP
        CONTINUE WHEN clave IN ('id', 'numero', 'created_at', 'updated_at');

        -- El sondeo de alcance reescribe esto cada pocos minutos. Registrarlo
        -- ahogaría el historial en ruido y taparía los cambios que sí hizo una
        -- persona, que son los únicos que se vienen a buscar acá.
        CONTINUE WHEN clave IN ('estado', 'estado_at', 'estado_latencia_ms',
                                'estado_detalle', 'versiones_at');

        v_antes := antes ->> clave;
        v_desp  := despues ->> clave;
        CONTINUE WHEN v_antes IS NOT DISTINCT FROM v_desp;

        -- Una contraseña en el historial es una contraseña filtrada: el
        -- historial se muestra en pantalla y no tiene el candado que sí tiene el
        -- campo. Se registra QUE cambió, nunca a qué.
        IF clave LIKE '%encrypted%' THEN
            INSERT INTO olt_historial (olt_id, campo, valor_antes, valor_despues, quien)
            VALUES (NEW.id, clave, '••••••', '••••••', autor);
        ELSE
            INSERT INTO olt_historial (olt_id, campo, valor_antes, valor_despues, quien)
            VALUES (NEW.id, clave, v_antes, v_desp, autor);
        END IF;
    END LOOP;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_olt_historial ON olts;
CREATE TRIGGER trg_olt_historial
    BEFORE UPDATE ON olts
    FOR EACH ROW EXECUTE FUNCTION registrar_cambio_olt();


CREATE OR REPLACE FUNCTION registrar_alta_olt()
RETURNS TRIGGER AS $$
DECLARE
    autor TEXT;
BEGIN
    BEGIN
        autor := COALESCE(auth.jwt() ->> 'email', auth.uid()::text);
    EXCEPTION WHEN OTHERS THEN
        autor := NULL;
    END;

    INSERT INTO olt_historial (olt_id, accion, campo, valor_despues, quien)
    VALUES (NEW.id, 'alta', 'nombre', NEW.nombre, COALESCE(autor, 'sistema'));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_olt_alta ON olts;
CREATE TRIGGER trg_olt_alta
    AFTER INSERT ON olts
    FOR EACH ROW EXECUTE FUNCTION registrar_alta_olt();


-- -----------------------------------------------------------------------------
-- 5. Vista del listado
-- -----------------------------------------------------------------------------
-- Nunca expone las columnas cifradas. Para ver una credencial hay que pedirla al
-- middleware, que es el único que tiene la llave y el único que puede dejar
-- registrado que alguien la miró.
DROP VIEW IF EXISTS v_olts;
CREATE VIEW v_olts WITH (security_invoker = true) AS
SELECT
    o.id,
    o.numero,
    o.nombre,
    o.marca,
    o.ip_host,
    o.puerto_ssh,
    o.snmp_puerto,
    o.usuario,
    o.hw_version,
    o.sw_version,
    o.pon_tipos,
    o.versiones_at,
    o.activo,
    o.via_vpn,
    o.snmp_trap,
    o.iptv,
    o.ntp_servers,
    o.tr069_perfil,
    o.tr069_interfaz,
    o.notas,
    o.estado,
    o.estado_at,
    o.estado_latencia_ms,
    o.estado_detalle,
    o.created_at,
    o.updated_at,

    -- Se dice si el secreto está cargado, jamás cuál es. Un campo vacío y un
    -- campo con contenido son diagnósticos distintos y el formulario necesita
    -- distinguirlos sin ver el valor.
    (o.snmp_ro_encrypted IS NOT NULL AND o.snmp_ro_encrypted <> '') AS tiene_snmp_ro,
    (o.snmp_rw_encrypted IS NOT NULL AND o.snmp_rw_encrypted <> '') AS tiene_snmp_rw,
    (o.enable_password_encrypted IS NOT NULL AND o.enable_password_encrypted <> '') AS tiene_enable,

    -- Un estado de hace tres horas no es un estado. La pantalla necesita saber
    -- si el dato está fresco para no pintar de verde algo que nadie confirmó
    -- desde ayer.
    CASE
        WHEN o.estado_at IS NULL THEN NULL
        ELSE EXTRACT(EPOCH FROM (NOW() - o.estado_at))::INT
    END AS estado_hace_segundos,

    COALESCE(u.total, 0)    AS onus_total,
    COALESCE(u.online, 0)   AS onus_online,
    COALESCE(u.caidas, 0)   AS onus_caidas,
    COALESCE(b.backups, 0)  AS backups
FROM olts o
LEFT JOIN (
    SELECT
        olt_id,
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE estado = 'online')         AS online,
        COUNT(*) FILTER (WHERE estado IN ('los', 'offline', 'power_off')) AS caidas
    FROM onus
    GROUP BY olt_id
) u ON u.olt_id = o.id
LEFT JOIN (
    SELECT olt_id, COUNT(*) AS backups FROM olt_backups GROUP BY olt_id
) b ON b.olt_id = o.id;


DROP VIEW IF EXISTS v_olt_backups;
CREATE VIEW v_olt_backups WITH (security_invoker = true) AS
SELECT id, olt_id, nombre, comando, quien, bytes, created_at
FROM olt_backups;


-- -----------------------------------------------------------------------------
-- 6. RLS
-- -----------------------------------------------------------------------------
-- Escrito de forma explícita y no dentro de un bloque DO con SQL dinámico, aun
-- cuando el bloque sería más corto: el analizador estático de Supabase no puede
-- leer adentro de un EXECUTE y reporta estas tablas como si quedaran sin RLS.
--
-- Que una herramienta de seguridad no pueda verificar la seguridad es razón
-- suficiente para escribirlo de manera que sí pueda. Una advertencia que hay que
-- explicar cada vez termina siendo una advertencia que alguien ignora el día que
-- es de verdad.

ALTER TABLE olt_historial ENABLE ROW LEVEL SECURITY;
ALTER TABLE olt_backups   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_olt_historial" ON olt_historial;
CREATE POLICY "auth_all_olt_historial" ON olt_historial
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_all_olt_backups" ON olt_backups;
CREATE POLICY "auth_all_olt_backups" ON olt_backups
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
