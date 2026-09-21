-- =============================================================================
-- Migración 148 — La firma del contrato: electrónica por API, o manual
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- El contrato se firma de dos maneras y las dos tienen que convivir:
--
--   ELECTRÓNICA   El sistema pide un enlace al proveedor, el abonado firma con
--                 huella y reconocimiento facial, y el proveedor avisa. Nadie
--                 toca nada: el contrato pasa a firmado solo.
--
--   MANUAL        Se imprime, el abonado firma en papel, la oficina sube el
--                 escaneo y lo valida. Recién ahí queda firmado.
--
-- ── Las tres cosas que hacen que esto no se trabe ──
--
-- UN INTERRUPTOR GENERAL. Si el proveedor deja de funcionar por días, se apaga
-- la API entera desde Ajustes y todo el mundo firma en papel. Sin tocar código.
--
-- UN CAMINO DE SALIDA POR CONTRATO. Que el interruptor esté encendido no puede
-- dejar a nadie esperando: si la llamada falla —timeout, servicio caído, error
-- de red— ese contrato puntual puede pasar a manual sin apagar nada para los
-- demás.
--
-- UN TIEMPO MÁXIMO. Configurable. Pasado ese tiempo el trámite se marca vencido
-- y se ofrece la firma manual. El sistema NUNCA queda esperando indefinidamente
-- una respuesta que puede no llegar nunca.
--
-- ── Por qué una tabla nueva y no más columnas en `contratos` ──
--
-- Porque el contrato se firma ANTES del alta, cuando `contratos` todavía no
-- existe: en este sistema la venta vive en la orden de trabajo hasta que el
-- abonado se da de alta. Un trámite de firma atado a `contratos` obligaría a
-- crear el contrato —y el cliente— antes de saber si el abonado va a firmar.
--
-- Y porque un contrato se puede mandar a firmar más de una vez: falla la API, se
-- reintenta, después se pasa a manual. Con columnas sueltas cada intento pisaría
-- al anterior y se perdería el rastro de qué se intentó.
-- =============================================================================

-- =============================================================================
-- El interruptor general
-- =============================================================================
CREATE TABLE IF NOT EXISTS config_firma (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    /**
     * Si se usa la API del proveedor.
     *
     * Apagado por defecto y a propósito: mientras no haya proveedor contratado,
     * encenderlo haría que cada intento de firma llame a un servicio que no
     * existe y espere el timeout completo antes de ofrecer el papel.
     */
    api_habilitada BOOLEAN NOT NULL DEFAULT FALSE,

    proveedor      VARCHAR(40),
    api_url        TEXT,
    -- La clave va cifrada, como el resto de las credenciales del sistema.
    api_key_encrypted TEXT,

    /**
     * Cuánto se espera antes de sugerir el papel.
     *
     * Son dos esperas distintas y por eso son dos números:
     *
     *   `timeout_segundos` es cuánto se aguanta la LLAMADA para pedir el
     *   enlace. Si el proveedor no contesta en ese lapso, se corta y se ofrece
     *   la firma manual en el acto — el vendedor está con el cliente delante.
     *
     *   `vigencia_horas` es cuánto vale el enlace ya enviado. El abonado se
     *   lleva el enlace y firma más tarde; pasado ese plazo el trámite se marca
     *   vencido y se puede volver a intentar o pasar a papel.
     */
    timeout_segundos INT NOT NULL DEFAULT 30 CHECK (timeout_segundos BETWEEN 5 AND 300),
    vigencia_horas   INT NOT NULL DEFAULT 72 CHECK (vigencia_horas BETWEEN 1 AND 720),

    /**
     * Quién puede autorizar la firma manual.
     *
     * No es cualquiera: habilitar el papel saltea la biometría, así que tiene
     * que quedar registrado quién lo permitió. Se guarda como lista de roles
     * para que el ISP la ajuste sin tocar código.
     */
    roles_autorizan JSONB NOT NULL DEFAULT '["super_admin", "admin"]'::JSONB,

    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT config_firma_roles_arreglo CHECK (jsonb_typeof(roles_autorizan) = 'array')
);

INSERT INTO config_firma (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE config_firma ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS config_firma_auth ON config_firma;
CREATE POLICY config_firma_auth ON config_firma
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- El trámite de firma
-- =============================================================================
CREATE TABLE IF NOT EXISTS firmas_contrato (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    /**
     * De qué cuelga.
     *
     * De la ORDEN mientras la venta no está dada de alta, del CONTRATO cuando
     * ya existe, y del abonado en cuanto lo haya. Los tres pueden convivir: es
     * el mismo trámite visto desde donde cada pantalla lo busca.
     */
    instalacion_id UUID REFERENCES instalaciones(id) ON DELETE CASCADE,
    contrato_id    UUID REFERENCES contratos(id)     ON DELETE CASCADE,
    client_id      UUID REFERENCES clientes(id)      ON DELETE CASCADE,

    metodo VARCHAR(16) NOT NULL
        CHECK (metodo IN ('electronica_api', 'manual')),

    /**
     * En qué anda.
     *
     *   pendiente  Se creó el trámite y todavía no salió.
     *   enviado    El proveedor dio el enlace y el abonado lo tiene.
     *   firmado    Confirmado. Es el único estado que cierra el trámite.
     *   rechazado  El abonado se negó, o el proveedor lo rechazó.
     *   vencido    Pasó la vigencia sin firmar.
     *   fallido    No se pudo ni empezar: la API no contestó.
     */
    estado VARCHAR(12) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'enviado', 'firmado', 'rechazado', 'vencido', 'fallido')),

    -- ── Lo de la firma electrónica ────────────────────────────────────────
    proveedor            VARCHAR(40),
    referencia_proveedor VARCHAR(160),
    enlace_firma         TEXT,
    enviado_en           TIMESTAMPTZ,
    vence_en             TIMESTAMPTZ,
    /** El error tal como lo devolvió la API, para reclamarle al proveedor. */
    error_api            TEXT,

    -- ── Lo de la firma manual ─────────────────────────────────────────────
    /**
     * Quién habilitó el papel y cuándo.
     *
     * Es el dato que justifica haber salteado la biometría. Sin él, un contrato
     * firmado a mano en un sistema con firma electrónica encendida no tiene
     * explicación.
     */
    autorizado_por        UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    autorizado_en         TIMESTAMPTZ,
    motivo_manual         TEXT,

    /** Quién recibió el papel en oficina y comprobó que está firmado. */
    validado_por          UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    validado_en           TIMESTAMPTZ,
    documento_firmado_url TEXT,

    -- ── Común a los dos ───────────────────────────────────────────────────
    fecha_firma  TIMESTAMPTZ,
    firmante_nombre VARCHAR(150),
    firmante_identificacion VARCHAR(20),

    /**
     * Huella del contrato que se mandó a firmar.
     *
     * Es lo que permite demostrar que lo firmado es lo que se generó y no una
     * versión posterior. El contrato se arma con el plan y el precio del
     * momento, y esos cambian.
     */
    contenido_hash VARCHAR(64),

    creado_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Un trámite sin nada a lo que referirse no sirve para nada.
    CONSTRAINT firmas_tiene_dueno CHECK (
        instalacion_id IS NOT NULL OR contrato_id IS NOT NULL OR client_id IS NOT NULL
    ),

    /**
     * Lo que hace que "firmado" signifique algo.
     *
     * Cada método exige lo suyo. Sin esto, un contrato podría quedar en firmado
     * sin enlace del proveedor ni escaneo del papel — es decir, firmado porque
     * alguien apretó un botón.
     */
    CONSTRAINT firmas_firmado_completo CHECK (
        estado <> 'firmado'
        OR (
            fecha_firma IS NOT NULL
            AND (
                (metodo = 'electronica_api' AND referencia_proveedor IS NOT NULL)
             OR (metodo = 'manual'
                 AND documento_firmado_url IS NOT NULL
                 AND validado_por IS NOT NULL)
            )
        )
    ),

    /** Y el papel exige que alguien lo haya habilitado. */
    CONSTRAINT firmas_manual_autorizada CHECK (
        metodo <> 'manual' OR autorizado_por IS NOT NULL OR estado = 'pendiente'
    )
);

CREATE INDEX IF NOT EXISTS idx_firmas_instalacion ON firmas_contrato (instalacion_id);
CREATE INDEX IF NOT EXISTS idx_firmas_contrato    ON firmas_contrato (contrato_id);
CREATE INDEX IF NOT EXISTS idx_firmas_cliente     ON firmas_contrato (client_id);

/**
 * Los que están esperando respuesta, que es lo que hay que vigilar.
 *
 * Es el índice que usa la tarea que vence los trámites viejos: sin él, esa
 * tarea recorrería toda la tabla cada vez.
 */
CREATE INDEX IF NOT EXISTS idx_firmas_esperando
    ON firmas_contrato (vence_en) WHERE estado IN ('pendiente', 'enviado');

ALTER TABLE firmas_contrato ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS firmas_contrato_auth ON firmas_contrato;
CREATE POLICY firmas_contrato_auth ON firmas_contrato
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Quién puede habilitar el papel
-- =============================================================================
/**
 * Si quien pregunta puede autorizar una firma manual.
 *
 * Sigue el criterio del resto del sistema: sin legajo cargado no se bloquea,
 * para no dejar inutilizable una instalación a medio migrar. Lo que no hace es
 * dejar pasar a alguien que SÍ tiene legajo y cuyo rol no está en la lista.
 */
CREATE OR REPLACE FUNCTION puede_autorizar_firma_manual()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT u.permisos ? '*'
             OR u.permisos ? 'contratos.firma_manual'
             OR (SELECT roles_autorizan FROM config_firma WHERE id = 1) ? u.rol
           FROM usuarios_sistema u
          WHERE u.auth_id = auth.uid() AND u.activo
          LIMIT 1),
        TRUE
    )
$$;

COMMENT ON FUNCTION puede_autorizar_firma_manual IS
    'Si quien pregunta puede habilitar la firma en papel. Habilitar el papel saltea la biometría: por eso no es cualquiera.';


/**
 * Y se comprueba del lado del servidor.
 *
 * Esconder el botón en la pantalla no alcanza: quien tenga la clave del
 * navegador puede escribir en la tabla igual. La autorización es justamente lo
 * que hay que poder demostrar después.
 */
CREATE OR REPLACE FUNCTION firma_manual_requiere_autorizacion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Solo cuando se está ESTAMPANDO la autorización, no en cada guardado.
    IF NEW.autorizado_por IS NOT NULL
       AND (TG_OP = 'INSERT' OR OLD.autorizado_por IS DISTINCT FROM NEW.autorizado_por)
       AND NOT puede_autorizar_firma_manual() THEN
        RAISE EXCEPTION
            'Tu usuario no puede habilitar la firma en papel. Pedíselo a un administrador: habilitar el papel saltea la verificación biométrica y tiene que quedar registrado quién lo permitió.';
    END IF;

    NEW.actualizado_en := NOW();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_firma_manual_autorizacion ON firmas_contrato;
CREATE TRIGGER trg_firma_manual_autorizacion
    BEFORE INSERT OR UPDATE ON firmas_contrato
    FOR EACH ROW EXECUTE FUNCTION firma_manual_requiere_autorizacion();


-- =============================================================================
-- Que el contrato refleje su firma
-- =============================================================================
/**
 * Al firmarse el trámite, el contrato queda firmado.
 *
 * `contratos` ya tenía sus columnas de firma desde la 72 y las pantallas viejas
 * las leen. Se mantienen al día en vez de reemplazarlas: romper eso obligaría a
 * tocar código que hoy funciona.
 */
CREATE OR REPLACE FUNCTION firma_actualiza_contrato()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.contrato_id IS NULL OR NEW.estado IS NOT DISTINCT FROM OLD.estado THEN
        RETURN NEW;
    END IF;

    UPDATE contratos
       SET firma_estado = CASE NEW.estado
               WHEN 'firmado'   THEN 'firmado'
               WHEN 'enviado'   THEN 'enviado'
               WHEN 'rechazado' THEN 'rechazado'
               WHEN 'vencido'   THEN 'vencido'
               ELSE firma_estado
           END,
           firma_proveedor  = COALESCE(NEW.proveedor, firma_proveedor),
           firma_referencia = COALESCE(NEW.referencia_proveedor, firma_referencia),
           firma_enviado_en = COALESCE(NEW.enviado_en, firma_enviado_en),
           firma_en         = COALESCE(NEW.fecha_firma, firma_en),
           firma_evidencia_url = COALESCE(NEW.documento_firmado_url, firma_evidencia_url),
           contenido_hash   = COALESCE(NEW.contenido_hash, contenido_hash)
     WHERE id = NEW.contrato_id;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_firma_actualiza_contrato ON firmas_contrato;
CREATE TRIGGER trg_firma_actualiza_contrato
    AFTER INSERT OR UPDATE OF estado ON firmas_contrato
    FOR EACH ROW EXECUTE FUNCTION firma_actualiza_contrato();


-- =============================================================================
-- Vencer lo que nadie firmó
-- =============================================================================
/**
 * Marca vencidos los trámites cuyo enlace ya no vale.
 *
 * La corre el middleware junto con el resto de las tareas. Es lo que evita que
 * un enlace de hace un mes siga figurando como "esperando al abonado": mientras
 * dice eso, nadie le ofrece el papel y el contrato no se firma nunca.
 */
CREATE OR REPLACE FUNCTION vencer_firmas_pendientes()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_n INT;
BEGIN
    UPDATE firmas_contrato
       SET estado = 'vencido', actualizado_en = NOW()
     WHERE estado IN ('pendiente', 'enviado')
       AND vence_en IS NOT NULL
       AND vence_en < NOW();

    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;


-- =============================================================================
-- Lo que las pantallas preguntan
-- =============================================================================
/**
 * El estado de firma de cada venta, con lo que hace falta para decidir.
 *
 * `puede_pasar_a_manual` es la respuesta a la única pregunta que importa en la
 * pantalla: ¿le ofrezco el papel? Se calcula acá y no en el navegador porque
 * depende del interruptor general, del estado del trámite y del rol de quien
 * mira — tres cosas que la pantalla no debería tener que combinar sola.
 */
CREATE OR REPLACE VIEW v_firmas_contrato WITH (security_invoker = true) AS
SELECT
    f.*,
    c.api_habilitada,
    c.timeout_segundos,
    c.vigencia_horas,

    -- Nombres, para no resolverlos de a uno en la pantalla.
    ua.nombre AS autorizado_por_nombre,
    uv.nombre AS validado_por_nombre,

    (f.estado = 'firmado') AS esta_firmado,

    /**
     * Cuándo tiene sentido ofrecer el papel.
     *
     * Con la API apagada, siempre. Con la API encendida, solo cuando el camino
     * electrónico no llegó a buen puerto: falló, venció o lo rechazaron. Nunca
     * sobre uno ya firmado.
     */
    (
        f.estado <> 'firmado'
        AND puede_autorizar_firma_manual()
        AND (
            NOT c.api_habilitada
            OR f.estado IN ('fallido', 'vencido', 'rechazado')
        )
    ) AS puede_pasar_a_manual,

    -- Los que están esperando y ya se pasaron: la pantalla los muestra en rojo
    -- aunque la tarea de vencimiento todavía no haya corrido.
    (f.estado IN ('pendiente', 'enviado') AND f.vence_en IS NOT NULL AND f.vence_en < NOW())
        AS esperando_de_mas
FROM firmas_contrato f
CROSS JOIN config_firma c
LEFT JOIN usuarios_sistema ua ON ua.id = f.autorizado_por
LEFT JOIN usuarios_sistema uv ON uv.id = f.validado_por
WHERE c.id = 1;

COMMENT ON VIEW v_firmas_contrato IS
    'Trámites de firma con el interruptor general y si corresponde ofrecer la firma en papel.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El interruptor y los tiempos:
--   SELECT api_habilitada, timeout_segundos, vigencia_horas, roles_autorizan
--     FROM config_firma;
--
--   -- Los trámites en curso:
--   SELECT metodo, estado, esperando_de_mas, puede_pasar_a_manual
--     FROM v_firmas_contrato ORDER BY creado_en DESC;
--
--   -- Y que "firmado" no se pueda poner sin respaldo:
--   INSERT INTO firmas_contrato (instalacion_id, metodo, estado)
--   VALUES ('<orden>', 'manual', 'firmado');
--   -- tiene que fallar por firmas_firmado_completo
