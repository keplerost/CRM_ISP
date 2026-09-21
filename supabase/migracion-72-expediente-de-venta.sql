-- =============================================================================
-- Migración 72 — El expediente de venta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere la 70 y la 71.
--
-- Implementa los puntos 10 a 16 del requerimiento: GANADA deja de ser el final
-- de la venta y pasa a ser el comienzo del expediente.
--
--   GANADA → DOCUMENTACIÓN → CONTRATO → FIRMA → ORDEN → INSTALACIÓN → ACTIVACIÓN
--
-- ── La decisión de fondo ──
--
-- "LISTO PARA INSTALACIÓN" NO es un botón. Es una consulta.
--
-- Si fuera un botón, el vendedor con apuro lo apretaría igual y la orden llegaría
-- al backoffice sin la cédula. Acá el estado se calcula de lo que efectivamente
-- está cargado —documentos, ubicación, plan, contrato, firma— y la función que
-- manda la orden vuelve a verificarlo del lado del servidor. No hay forma de
-- saltearlo desde el navegador.
--
-- ── Sobre la firma ──
--
-- Todavía no tenés proveedor: está en trámite, con link y verificación
-- biométrica. Eso es un flujo ASÍNCRONO —se manda a firmar y el resultado vuelve
-- después— así que el modelo lo prevé desde ahora: `firma_referencia` guarda el
-- id del trámite y `firma_estado` su avance.
--
-- Mientras tanto el estado queda en `no_enviado` y el expediente no avanza.
-- NADA en este archivo llama firma electrónica a un dibujo en pantalla.
-- =============================================================================


-- =============================================================================
-- 1. El expediente
-- =============================================================================
CREATE TABLE IF NOT EXISTS expedientes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Uno por prospecto ganado. El UNIQUE evita que dos clics en "GANADA" abran
    -- dos expedientes y el vendedor cargue la cédula en el que no se va a usar.
    prospecto_id  UUID NOT NULL UNIQUE REFERENCES prospectos(id)   ON DELETE CASCADE,

    contrato_id   UUID REFERENCES contratos(id)     ON DELETE SET NULL,
    instalacion_id UUID REFERENCES instalaciones(id) ON DELETE SET NULL,
    cliente_id    UUID REFERENCES clientes(id)      ON DELETE SET NULL,

    -- PASO 1 — datos confirmados con el cliente delante.
    datos_confirmados_en TIMESTAMPTZ,

    -- PASO 4 — ubicación.
    latitud       NUMERIC(10, 7),
    longitud      NUMERIC(10, 7),

    -- La precisión en metros que informó el navegador. Es la columna que
    -- distingue una captura real de un número escrito a mano: la API de
    -- geolocalización SIEMPRE la devuelve, y un formulario manual no la tiene.
    precision_m   NUMERIC(8, 2),

    -- `gps` = lo dio el dispositivo · `manual` = lo escribió una persona.
    --
    -- Esto NO es una prueba criptográfica: quien quiera puede falsear la
    -- geolocalización de su propio navegador, y ningún sistema web puede
    -- impedirlo. Lo que sí garantiza es que el sistema nunca AFIRME que hubo
    -- captura cuando el dato se tipeó — que es lo que pediste.
    ubicacion_origen VARCHAR(6),
    ubicacion_en  TIMESTAMPTZ,
    ubicacion_por UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    estado        VARCHAR(12) NOT NULL DEFAULT 'abierto',
    enviado_en    TIMESTAMPTZ,
    notas         TEXT,

    creado_por    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT expedientes_estado_check CHECK (estado IN (
        'abierto', 'listo', 'enviado', 'cancelado'
    )),
    CONSTRAINT expedientes_ubicacion_origen_check CHECK (
        ubicacion_origen IS NULL OR ubicacion_origen IN ('gps', 'manual')
    ),
    -- La regla que hace cumplible "no fingir que se capturó".
    --
    -- Una ubicación marcada como `gps` SIN precisión no pudo salir del
    -- navegador: la API la entrega siempre. Si falta, el dato se tipeó y tiene
    -- que declararse `manual`.
    CONSTRAINT expedientes_gps_con_precision CHECK (
        ubicacion_origen IS DISTINCT FROM 'gps' OR precision_m IS NOT NULL
    ),
    -- Y una ubicación sin origen declarado no existe: o se sabe de dónde salió
    -- o no se guarda.
    CONSTRAINT expedientes_ubicacion_completa CHECK (
        (latitud IS NULL AND longitud IS NULL)
        OR (latitud IS NOT NULL AND longitud IS NOT NULL
            AND ubicacion_origen IS NOT NULL AND ubicacion_en IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_expedientes_estado ON expedientes (estado, creado_en DESC);

COMMENT ON COLUMN expedientes.precision_m IS
    'Metros de precisión que informó el navegador. Su ausencia en un origen "gps" es imposible: por eso hay un CHECK.';


-- =============================================================================
-- 2. Los documentos
-- =============================================================================
-- Cédula por las dos caras y fotos del domicilio. Cada archivo vive en el bucket
-- privado `expedientes`; acá va su ruta y su estado de validación.
CREATE TABLE IF NOT EXISTS expediente_documentos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expediente_id UUID NOT NULL REFERENCES expedientes(id) ON DELETE CASCADE,

    tipo          VARCHAR(20) NOT NULL,
    ruta          TEXT NOT NULL,

    -- `cargado` lo pone el vendedor al subir · `validado` lo pone backoffice
    -- cuando revisó que la cédula se lee y coincide con los datos.
    estado        VARCHAR(10) NOT NULL DEFAULT 'cargado',

    mime          VARCHAR(60),
    bytes         INT,

    subido_por    UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    subido_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    validado_por  UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    validado_en   TIMESTAMPTZ,
    notas         TEXT,

    CONSTRAINT expediente_documentos_tipo_check CHECK (tipo IN (
        'cedula_frontal', 'cedula_posterior',
        'fachada', 'referencia', 'lugar_instalacion', 'otro'
    )),
    CONSTRAINT expediente_documentos_estado_check CHECK (estado IN (
        'pendiente', 'cargado', 'validado', 'rechazado'
    ))
);

-- Una sola cédula frontal vigente por expediente. Sin esto, reemplazar una foto
-- borrosa deja las dos y nadie sabe cuál mirar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expediente_cedula_unica
    ON expediente_documentos (expediente_id, tipo)
    WHERE tipo IN ('cedula_frontal', 'cedula_posterior') AND estado <> 'rechazado';

CREATE INDEX IF NOT EXISTS idx_expediente_documentos
    ON expediente_documentos (expediente_id, tipo);


-- =============================================================================
-- 3. La firma del contrato
-- =============================================================================
-- Se reutiliza `contratos`, como pediste. Solo se le agregan las columnas del
-- trámite de firma.
ALTER TABLE contratos
    ADD COLUMN IF NOT EXISTS firma_estado     VARCHAR(12) NOT NULL DEFAULT 'no_enviado',
    -- Quién firma: 'interno' mientras no haya proveedor, o su nombre después.
    ADD COLUMN IF NOT EXISTS firma_proveedor  VARCHAR(40),
    -- El id del trámite en el proveedor. Es por donde vuelve el resultado.
    ADD COLUMN IF NOT EXISTS firma_referencia VARCHAR(120),
    ADD COLUMN IF NOT EXISTS firma_enviado_en TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS firma_en         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS firma_por        UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS firma_evidencia_url TEXT,
    ADD COLUMN IF NOT EXISTS version          SMALLINT NOT NULL DEFAULT 1,
    -- Huella del contenido al momento de mandarlo a firmar. Es lo que permite
    -- demostrar que lo firmado es lo que se generó y no una versión posterior.
    ADD COLUMN IF NOT EXISTS contenido_hash   VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contratos_firma_estado_check') THEN
        ALTER TABLE contratos ADD CONSTRAINT contratos_firma_estado_check
            CHECK (firma_estado IN ('no_enviado', 'enviado', 'firmado', 'rechazado', 'vencido'));
    END IF;
END $$;

COMMENT ON COLUMN contratos.firma_estado IS
    'Trámite de firma con proveedor externo. "firmado" solo lo pone la confirmación del proveedor, nunca la app.';


-- =============================================================================
-- 4. Los estados de la instalación
-- =============================================================================
-- El punto 17 pide once estados; había cinco.
ALTER TABLE instalaciones DROP CONSTRAINT IF EXISTS instalaciones_estado_check;
ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_estado_check
    CHECK (estado IN (
        -- Los que ya existían: no se renombra ninguno, para no tocar las filas
        -- que ya están cargadas ni el código que los consulta.
        'prospecto', 'agendada', 'en_curso', 'hecha', 'cancelada',
        -- Los nuevos del backoffice.
        'nueva', 'revisando', 'lista_asignar', 'en_ruta', 'no_realizada', 'reprogramada'
    ));


-- =============================================================================
-- 5. Qué le falta a cada expediente
-- =============================================================================
-- Acá se decide si está listo, y por eso es una vista y no una columna: se
-- recalcula sola cada vez que se sube un documento o se firma el contrato, sin
-- que nadie tenga que acordarse de actualizar un estado.
/**
 * Va con `CREATE OR REPLACE` y no con `DROP` + `CREATE`.
 *
 * De esta vista cuelgan otras que se crean DESPUÉS —v_instalaciones, v_tablero_vendedor y v_notificaciones—, así que un `DROP`
 * hace que volver a correr este archivo falle con "cannot drop view because
 * other objects depend on it". Y como el editor de Supabase corre el archivo
 * entero en una transacción, se cae la migración completa.
 *
 * `CREATE OR REPLACE` reemplaza la definición sin tocar a quien depende de ella.
 * Exige que las columnas sean las mismas, que es exactamente el caso cuando lo
 * que se reejecuta es este mismo archivo.
 */
CREATE OR REPLACE VIEW v_expedientes WITH (security_invoker = true) AS
SELECT
    e.*,
    p.nombre        AS cliente,
    p.telefono,
    p.direccion,
    p.sector,
    p.referencia    AS como_llegar,
    p.vendedor_id,
    p.plan_id,
    pl.nombre       AS plan,
    pl.precio       AS plan_precio,
    c.numero        AS contrato_numero,
    c.firma_estado,

    -- El checklist del punto 15, uno por uno.
    (e.datos_confirmados_en IS NOT NULL) AS ok_datos,
    EXISTS (SELECT 1 FROM expediente_documentos d
             WHERE d.expediente_id = e.id AND d.tipo = 'cedula_frontal'
               AND d.estado IN ('cargado', 'validado'))   AS ok_cedula_frontal,
    EXISTS (SELECT 1 FROM expediente_documentos d
             WHERE d.expediente_id = e.id AND d.tipo = 'cedula_posterior'
               AND d.estado IN ('cargado', 'validado'))   AS ok_cedula_posterior,
    EXISTS (SELECT 1 FROM expediente_documentos d
             WHERE d.expediente_id = e.id
               AND d.tipo IN ('fachada', 'referencia', 'lugar_instalacion')
               AND d.estado IN ('cargado', 'validado'))   AS ok_fotos,
    (e.latitud IS NOT NULL AND e.longitud IS NOT NULL)    AS ok_ubicacion,
    (p.plan_id IS NOT NULL)                                AS ok_plan,
    (e.contrato_id IS NOT NULL)                            AS ok_contrato,
    (c.firma_estado = 'firmado')                           AS ok_firma,

    -- Listo = todo lo anterior. Una sola definición, en un solo lugar.
    (
        e.datos_confirmados_en IS NOT NULL
        AND EXISTS (SELECT 1 FROM expediente_documentos d WHERE d.expediente_id = e.id
                     AND d.tipo = 'cedula_frontal'   AND d.estado IN ('cargado','validado'))
        AND EXISTS (SELECT 1 FROM expediente_documentos d WHERE d.expediente_id = e.id
                     AND d.tipo = 'cedula_posterior' AND d.estado IN ('cargado','validado'))
        AND EXISTS (SELECT 1 FROM expediente_documentos d WHERE d.expediente_id = e.id
                     AND d.tipo IN ('fachada','referencia','lugar_instalacion')
                     AND d.estado IN ('cargado','validado'))
        AND e.latitud IS NOT NULL AND e.longitud IS NOT NULL
        AND p.plan_id IS NOT NULL
        AND e.contrato_id IS NOT NULL
        AND c.firma_estado = 'firmado'
    ) AS completo
FROM expedientes e
JOIN prospectos p           ON p.id = e.prospecto_id
LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
LEFT JOIN contratos c        ON c.id = e.contrato_id;


-- =============================================================================
-- 6. Del expediente a la orden de instalación
-- =============================================================================
/**
 * Manda el expediente al backoffice.
 *
 * Vuelve a verificar el checklist acá dentro y no confía en lo que diga la
 * pantalla: el punto 15 dice que la instalación no se genera antes de la firma,
 * y una validación que solo vive en el navegador se saltea con la consola
 * abierta.
 *
 * Reutiliza `instalaciones` —la tabla que el backoffice ya usa— así que la orden
 * aparece en su bandeja sin que nadie copie nada, que es el punto 16.
 *
 * SECURITY DEFINER porque el vendedor no tiene permiso de escritura sobre
 * `instalaciones` (migración 71) y no debe tenerlo: puede disparar ESTA
 * operación validada, no escribir la tabla a mano.
 */
CREATE OR REPLACE FUNCTION enviar_expediente_a_instalaciones(p_expediente UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v   RECORD;
    v_instalacion UUID;
BEGIN
    SELECT * INTO v FROM v_expedientes WHERE id = p_expediente;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese expediente';
    END IF;

    IF v.instalacion_id IS NOT NULL THEN
        -- Ya se mandó. Devolver la orden existente en vez de crear otra evita
        -- que un doble clic genere dos visitas del técnico a la misma casa.
        RETURN v.instalacion_id;
    END IF;

    IF NOT v.completo THEN
        RAISE EXCEPTION 'El expediente está incompleto: falta %',
            CONCAT_WS(', ',
                CASE WHEN NOT v.ok_datos            THEN 'confirmar los datos' END,
                CASE WHEN NOT v.ok_cedula_frontal   THEN 'la cédula (frente)' END,
                CASE WHEN NOT v.ok_cedula_posterior THEN 'la cédula (dorso)' END,
                CASE WHEN NOT v.ok_fotos            THEN 'las fotos del domicilio' END,
                CASE WHEN NOT v.ok_ubicacion        THEN 'la ubicación' END,
                CASE WHEN NOT v.ok_plan             THEN 'el plan' END,
                CASE WHEN NOT v.ok_contrato         THEN 'generar el contrato' END,
                CASE WHEN NOT v.ok_firma            THEN 'la firma del contrato' END
            );
    END IF;

    -- La orden nace con todo lo que el vendedor ya cargó. El backoffice no
    -- vuelve a tipear nada: solo revisa, asigna técnico y pone fecha.
    INSERT INTO instalaciones (
        nombre, identificacion, telefono, telefono_whatsapp, email,
        direccion, referencia, sector, latitud, longitud,
        plan_id, precio_mensual, estado, fecha, notas
    )
    SELECT
        p.nombre, p.identificacion, p.telefono, p.telefono_whatsapp, p.email,
        p.direccion, p.referencia, p.sector, e.latitud, e.longitud,
        p.plan_id, pl.precio, 'nueva', CURRENT_DATE,
        CONCAT_WS(E'\n',
            'Venta de ' || COALESCE(TRIM(CONCAT(u.nombre, ' ', u.apellido)), 'un vendedor'),
            NULLIF(e.notas, ''),
            'Contrato ' || COALESCE(c.numero, c.id::TEXT)
        )
    FROM expedientes e
    JOIN prospectos p            ON p.id = e.prospecto_id
    LEFT JOIN planes_velocidad pl ON pl.id = p.plan_id
    LEFT JOIN usuarios_sistema u  ON u.id = p.vendedor_id
    LEFT JOIN contratos c         ON c.id = e.contrato_id
    WHERE e.id = p_expediente
    RETURNING id INTO v_instalacion;

    -- Las fotos del domicilio viajan con la orden: el técnico tiene que poder
    -- reconocer la casa antes de bajarse de la camioneta.
    INSERT INTO instalacion_fotos (instalacion_id, tipo, ruta, descripcion)
    SELECT v_instalacion,
           CASE d.tipo WHEN 'fachada' THEN 'fachada' ELSE 'otro' END,
           d.ruta,
           'Del expediente de venta'
      FROM expediente_documentos d
     WHERE d.expediente_id = p_expediente
       AND d.tipo IN ('fachada', 'referencia', 'lugar_instalacion');

    UPDATE expedientes
       SET instalacion_id = v_instalacion,
           estado         = 'enviado',
           enviado_en     = NOW(),
           actualizado_en = NOW()
     WHERE id = p_expediente;

    -- El prospecto queda apuntando a su instalación: es lo que después le deja
    -- ver el ESTADO sin ver la ficha (vista `v_mis_ventas_estado` de la 71).
    UPDATE prospectos SET instalacion_id = v_instalacion WHERE id =
        (SELECT prospecto_id FROM expedientes WHERE id = p_expediente);

    RETURN v_instalacion;
END $$;


-- =============================================================================
-- 7. El bucket de los expedientes
-- =============================================================================
-- Privado, con límite de tamaño y tipos permitidos. Una cédula NO puede quedar
-- en una URL pública adivinable — es el punto 25 del requerimiento.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'expedientes', 'expedientes', FALSE,
    5242880,  -- 5 MB: la app comprime antes de subir, igual que en tickets
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
    SET public = FALSE,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- La ruta es `<expediente_id>/<archivo>`, y la política lee esa primera carpeta
-- para preguntar por el expediente. Así el permiso del archivo es exactamente el
-- del expediente: no hay dos reglas que puedan discrepar.
--
-- Es distinto de los buckets viejos, donde la política decía solo
-- `bucket_id = 'documentos'` — o sea que cualquier usuario con sesión podía leer
-- cualquier archivo si adivinaba la ruta. Para cédulas eso no alcanza.
DROP POLICY IF EXISTS expedientes_leer ON storage.objects;
CREATE POLICY expedientes_leer ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'expedientes'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM expedientes)
    );

DROP POLICY IF EXISTS expedientes_subir ON storage.objects;
CREATE POLICY expedientes_subir ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'expedientes'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM expedientes)
    );

DROP POLICY IF EXISTS expedientes_borrar ON storage.objects;
CREATE POLICY expedientes_borrar ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'expedientes'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM expedientes)
    );


-- =============================================================================
-- 8. Seguridad
-- =============================================================================
ALTER TABLE expedientes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE expediente_documentos ENABLE ROW LEVEL SECURITY;

-- El expediente lo ve quien tiene la cartera y el vendedor dueño del prospecto.
-- El vendedor lo pierde cuando el prospecto se archiva —al activarse el
-- servicio— porque la subconsulta pasa por la política de `prospectos`.
DROP POLICY IF EXISTS expedientes_acceso ON expedientes;
CREATE POLICY expedientes_acceso ON expedientes
    FOR ALL TO authenticated
    USING (prospecto_id IN (SELECT id FROM prospectos))
    WITH CHECK (prospecto_id IN (SELECT id FROM prospectos));

DROP POLICY IF EXISTS expediente_documentos_acceso ON expediente_documentos;
CREATE POLICY expediente_documentos_acceso ON expediente_documentos
    FOR ALL TO authenticated
    USING (expediente_id IN (SELECT id FROM expedientes))
    WITH CHECK (expediente_id IN (SELECT id FROM expedientes));


-- =============================================================================
-- 9. El expediente se abre solo al ganar
-- =============================================================================
CREATE OR REPLACE FUNCTION abrir_expediente_al_ganar()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.estado = 'ganado' AND (OLD.estado IS DISTINCT FROM 'ganado') THEN
        INSERT INTO expedientes (prospecto_id, creado_por)
        VALUES (NEW.id, NEW.vendedor_id)
        ON CONFLICT (prospecto_id) DO NOTHING;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_abrir_expediente ON prospectos;
CREATE TRIGGER trg_abrir_expediente
    AFTER UPDATE OF estado ON prospectos
    FOR EACH ROW EXECUTE FUNCTION abrir_expediente_al_ganar();


-- =============================================================================
-- Revertir
-- =============================================================================
--   DROP TRIGGER IF EXISTS trg_abrir_expediente ON prospectos;
--   DROP FUNCTION IF EXISTS enviar_expediente_a_instalaciones(UUID);
--   DROP VIEW IF EXISTS v_expedientes;
--   DROP TABLE IF EXISTS expediente_documentos;
--   DROP TABLE IF EXISTS expedientes;
-- Las columnas de firma en `contratos` pueden quedar: no molestan.
