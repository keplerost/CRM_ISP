-- =============================================================================
-- Migración 139 — El contrato de adhesión de la ARCOTEL
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué es esto y por qué no alcanzaba con una plantilla de texto ──
--
-- El contrato que se firma en Ecuador no es texto libre: es un MODELO DE
-- ADHESIÓN inscrito en la ARCOTEL, con su fecha de inscripción impresa al pie.
-- El texto de las cláusulas no lo elige el ISP; lo que cambia entre un abonado y
-- otro son los datos y las casillas marcadas.
--
-- Es la misma situación del RIDE con el SRI: un contrato que dijera algo
-- distinto del modelo inscrito es un problema regulatorio, no una diferencia de
-- presentación.
--
-- Y no es UN documento: son cinco, y el abonado los firma todos.
--
--   CONTRATO      Las quince cláusulas. Firman prestador y abonado.
--   ANEXO 1f      Condiciones del servicio: plan, velocidades, tarifas.
--   ANEXO 2       Autorización de uso de datos personales. Firma el abonado.
--   ANEXO 3       Compra o arrendamiento de equipos.
--   ACTA          Entrega e instalación: qué se dejó, con qué serie.
--
-- ── Lo que agrega esta migración ──
--
-- Los datos que el formulario pide y el sistema todavía no guardaba. Sin ellos
-- el contrato sale con espacios en blanco justo donde la ARCOTEL exige un dato.
-- =============================================================================

-- =============================================================================
-- Los prestadores
-- =============================================================================
/**
 * Por qué es una tabla y no unas columnas más en `sri_config`.
 *
 * Porque son dos cosas distintas que hoy coinciden por casualidad. `sri_config`
 * es QUIÉN FACTURA: su RUC va en el XML que se manda al SRI y su certificado
 * firma los comprobantes. El prestador es QUIÉN PRESTA EL SERVICIO: su nombre va
 * en el contrato inscrito en la ARCOTEL.
 *
 * En esta instalación no son el mismo: las facturas salen a nombre de OR
 * IMPORTACIONES y el contrato está inscrito a nombre de HOME LINK-OR. Meterlos
 * en la misma fila obligaría a elegir cuál de los dos RUC es "el" RUC, y
 * cualquiera de las dos respuestas rompería algo.
 *
 * Además hay más de uno, y cada abonado pertenece a alguno.
 */
CREATE TABLE IF NOT EXISTS prestadores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    razon_social    VARCHAR(160) NOT NULL,
    nombre_comercial VARCHAR(120),
    ruc             VARCHAR(13),

    -- El domicilio del prestador, tal como lo pide la cláusula primera.
    direccion       TEXT,
    provincia       VARCHAR(60),
    canton          VARCHAR(60),
    ciudad          VARCHAR(60),
    parroquia       VARCHAR(60),

    telefono        VARCHAR(30),
    email           VARCHAR(120),
    web             VARCHAR(160),

    /**
     * Los canales de reclamo de la cláusula décima.
     *
     * Van aparte de los datos de contacto porque no son lo mismo: el correo
     * comercial puede ser uno y el de reclamos otro, y el que se imprime en el
     * contrato es el de reclamos — es el que el abonado va a usar cuando algo
     * salga mal, y el que la ARCOTEL revisa.
     */
    reclamos_email    VARCHAR(120),
    reclamos_telefono VARCHAR(30),
    reclamos_oficinas TEXT,
    reclamos_horario  VARCHAR(80),

    /**
     * La fecha en que se inscribió el modelo de contrato.
     *
     * Se imprime al pie de la última hoja. No es decorativa: es lo que permite
     * verificar que el papel que firmó el abonado corresponde a un modelo
     * aprobado, y cambia cada vez que se inscribe uno nuevo.
     */
    modelo_inscrito_el DATE,

    -- Lo que dicen las cláusulas cuarta y quinta. Es del modelo, no del abonado.
    vigencia_meses     INT NOT NULL DEFAULT 24,
    permanencia_meses  INT NOT NULL DEFAULT 24,

    -- El que se usa para el abonado que no tenga uno asignado.
    predeterminado  BOOLEAN NOT NULL DEFAULT FALSE,
    activo          BOOLEAN NOT NULL DEFAULT TRUE,

    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un solo predeterminado: con dos, el contrato de quien no tiene prestador
-- asignado saldría a nombre de uno u otro según el humor del planificador.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prestador_predeterminado
    ON prestadores ((TRUE)) WHERE predeterminado;

ALTER TABLE prestadores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_prestadores" ON prestadores;
CREATE POLICY "auth_all_prestadores" ON prestadores
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- A qué prestador pertenece cada abonado
-- =============================================================================
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS prestador_id UUID REFERENCES prestadores(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clientes_prestador ON clientes (prestador_id);


-- =============================================================================
-- Los datos del abonado que el formulario pide y no teníamos
-- =============================================================================
/**
 * El domicilio desglosado.
 *
 * La ficha tiene `direccion` como un texto suelto, que alcanza para llegar a la
 * casa. La cláusula primera pide provincia, cantón, ciudad y parroquia por
 * separado, y partir el texto a mano al momento de imprimir sería adivinar.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS provincia  VARCHAR(60),
    ADD COLUMN IF NOT EXISTS canton     VARCHAR(60),
    ADD COLUMN IF NOT EXISTS ciudad     VARCHAR(60),
    ADD COLUMN IF NOT EXISTS parroquia  VARCHAR(60);

/**
 * Adulto mayor o persona con discapacidad.
 *
 * No es un dato demográfico: da derecho a tarifa preferencial, y el formulario
 * obliga a marcarlo. Que hoy no exista significa que si alguno de los abonados
 * tiene ese derecho, nadie lo está aplicando.
 *
 * NULL = no se preguntó todavía, que es distinto de "no". Al imprimir un
 * contrato sin responder, ninguna de las dos casillas queda marcada — y así se
 * ve que falta, en vez de afirmar un "no" que nadie dijo.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS tarifa_preferencial BOOLEAN;

COMMENT ON COLUMN clientes.tarifa_preferencial IS
    'Adulto mayor o persona con discapacidad: da derecho a tarifa preferencial. NULL = sin preguntar.';

/**
 * Si acepta someterse a arbitraje (cláusula décima tercera).
 *
 * También NULL por defecto, y por una razón más fuerte: el formulario aclara que
 * el arbitraje "puede significar costos en los que debe incurrir el Abonado".
 * Marcar un SI que el abonado no eligió sería comprometerlo a un gasto.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS acepta_arbitraje BOOLEAN;

/**
 * Si el equipo se le arrienda o se le vende (anexo 3).
 *
 * El arrendamiento es lo normal y por eso es el valor por defecto: el router es
 * parte indispensable del servicio y el propio anexo dice que no se puede cobrar
 * por él. La compra aparece con los equipos adicionales.
 */
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS equipo_modalidad VARCHAR(14) NOT NULL DEFAULT 'arrendamiento';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clientes_equipo_modalidad_check') THEN
        ALTER TABLE clientes ADD CONSTRAINT clientes_equipo_modalidad_check
            CHECK (equipo_modalidad IN ('arrendamiento', 'compra'));
    END IF;
END $$;


-- =============================================================================
-- Lo que el anexo 1f pide del plan
-- =============================================================================
/**
 * Compartición y velocidad mínima efectiva.
 *
 * El anexo pide las cuatro velocidades —comercial y mínima efectiva, de bajada y
 * de subida— y el nivel de compartición. Hoy el plan solo guarda la comercial.
 *
 * Se dejan en NULL y no en un valor inventado: una velocidad mínima efectiva
 * puesta al azar es una promesa contractual que después hay que cumplir.
 */
ALTER TABLE planes_velocidad
    ADD COLUMN IF NOT EXISTS comparticion       VARCHAR(8),
    ADD COLUMN IF NOT EXISTS minima_bajada_kbps INT,
    ADD COLUMN IF NOT EXISTS minima_subida_kbps INT;

COMMENT ON COLUMN planes_velocidad.comparticion IS
    'Nivel de compartición que se declara en el anexo 1f: 1:1, 2:1, 4:1, 8:1.';


-- =============================================================================
-- El valor de instalación, que el anexo cobra por una sola vez
-- =============================================================================
/**
 * Por qué en el prestador y no en el plan.
 *
 * Porque es lo que se cobra por instalar, no por el plan: el mismo costo aplica
 * al que contrata el plan chico y al que contrata el grande. Y porque es el
 * número que el abonado deja de pagar si acepta la permanencia mínima — es una
 * condición del contrato, no una característica del servicio.
 */
ALTER TABLE prestadores
    ADD COLUMN IF NOT EXISTS valor_instalacion NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS plazo_instalacion VARCHAR(40) NOT NULL DEFAULT '24 horas',
    ADD COLUMN IF NOT EXISTS beneficios_permanencia TEXT;


-- =============================================================================
-- Los dos prestadores de esta instalación
-- =============================================================================
/**
 * Se siembran por RUC y no se pisan si ya están.
 *
 * Es la misma regla que las plantillas: el ISP va a completar lo que falta desde
 * la pantalla, y una migración que se reejecuta no puede borrarle eso.
 */
INSERT INTO prestadores (
    razon_social, nombre_comercial, ruc, direccion,
    provincia, canton, ciudad, parroquia,
    telefono, email, web,
    reclamos_email, reclamos_telefono, reclamos_oficinas, reclamos_horario,
    modelo_inscrito_el, valor_instalacion, beneficios_permanencia, predeterminado
)
SELECT
    'OÑA RIERA JEFFERSON FABIAN', 'HOME LINK-OR', '1250579925001',
    'Av. 19 de mayo y Eugenio Espejo',
    'Cotopaxi', 'La Maná', 'La Maná', 'La Maná',
    '0939145857', 'homelinknetor@gmail.com', 'https://cnet.net.ec/',
    'homelinknetor@gmail.com', '0986017616', 'Av. 19 de Mayo y Eugenio Espejo',
    '08:00am a 18:00pm',
    DATE '2025-10-16', 160.00,
    E'Instalación de servicio de internet\nSoporte técnico inmediato',
    TRUE
WHERE NOT EXISTS (SELECT 1 FROM prestadores WHERE ruc = '1250579925001');

/**
 * El segundo sale de `sri_config`, que es de donde vienen sus datos reales.
 *
 * Va incompleto a propósito: de este no se conocen ni la web ni los canales de
 * reclamo ni la fecha de inscripción de su modelo. Inventarlos sería imprimir en
 * un contrato datos que nadie verificó.
 */
INSERT INTO prestadores (
    razon_social, nombre_comercial, ruc, direccion,
    provincia, canton, ciudad, parroquia,
    telefono, email, predeterminado
)
SELECT
    s.razon_social, s.nombre_comercial, s.ruc,
    COALESCE(s.dir_establecimiento, s.dir_matriz),
    'Cotopaxi', 'La Maná', 'La Maná', 'La Maná',
    s.telefono, s.email, FALSE
FROM sri_config s
WHERE s.ruc IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM prestadores p WHERE p.ruc = s.ruc);


-- =============================================================================
-- Que la ficha del abonado pueda ver y guardar todo esto
-- =============================================================================
/**
 * Se agregan columnas AL FINAL de `v_clientes_ficha`.
 *
 * Es la vista que lee la pantalla del abonado. Ya pasó una vez: la 129 guardaba
 * bien las preferencias de avisos y la ficha seguía mostrando los valores de
 * fábrica, porque la vista no las exponía. Guardar sin poder releer se ve
 * exactamente igual que no guardar.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'prestador_id'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone los datos del contrato: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
        CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS
        SELECT
            c.id, c.nombre, c.router_id, c.onu_id, c.plan_id, c.ip, c.mac_address,
            c.usuario_ppp, c.estado, c.origen, c.velocidad_cruda, c.comentario,
            c.created_at, c.updated_at, c.tipo_identificacion, c.identificacion,
            c.email, c.telefono, c.direccion, c.precio_mensual, c.dia_facturacion,
            c.telefono_movil, c.codigo_pago, c.clave_ppp, c.latitud, c.longitud,
            c.notas, c.nap_id, c.puerto_nap, c.conectado_a_id, c.ip_administracion,
            c.tipo_antena, c.tipo_conexion, c.tipo_ip, c.red_ipv4, c.ipv6,
            c.ipv6_duid, c.rutas, c.descripcion_servicio, c.excluir_firewall,
            c.fecha_instalacion, c.factura_electronica, c.modalidad_pago,
            c.dia_generar_factura, c.tipo_impuesto, c.dias_gracia, c.aplicar_corte,
            c.descuento_tipo, c.descuento_porcentaje, c.descuento_documento,
            c.promo_porcentaje, c.promo_meses, c.promo_desde, c.telegram_chat_id,
            c.canal_preferido,
            p.nombre  AS plan,
            p.precio  AS plan_precio,
            p.bajada_kbps,
            p.subida_kbps,
            p.categoria      AS plan_categoria,
            p.tipo_impuesto  AS plan_tipo_impuesto,
            p.iva_porcentaje AS plan_iva_porcentaje,
            p.perfil_ppp     AS plan_perfil_ppp,
            r.nombre  AS router,
            o.sn      AS onu_serial,
            o.estado  AS onu_estado,
            o.rx_power_dbm,
            nap.nombre AS nap,
            ap.nombre  AS conectado_a,
            COALESCE(s.saldo, 0)               AS saldo,
            COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
            s.ultimo_pago,
            ct.id     AS contrato_id,
            ct.numero AS contrato_numero,
            ct.precio_mensual AS contrato_precio,
            c.codigo, c.zona, c.estado_desde, c.portal_clave, c.numero_orden,
            c.pasarela,
            c.baja_en,
            c.ultimo_pago_externo,
            c.cortar_tras_meses,
            c.avisos_activos,
            c.avisos_canales,
            c.avisos_pantalla,
            c.aviso_dias_1,
            c.aviso_dias_2,
            c.aviso_dias_3,
            c.aviso_factura_canales,
            c.aviso_pantalla_dias,
            -- Lo de esta migración, al final para no mover nada de lugar.
            c.prestador_id,
            c.provincia,
            c.canton,
            c.ciudad,
            c.parroquia,
            c.tarifa_preferencial,
            c.acepta_arbitraje,
            c.equipo_modalidad,
            pr.nombre_comercial AS prestador,
            pr.razon_social     AS prestador_razon_social
        FROM clientes c
        LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
        LEFT JOIN routers_mikrotik r   ON r.id = c.router_id
        LEFT JOIN onus o               ON o.id = c.onu_id
        LEFT JOIN puntos_red nap       ON nap.id = c.nap_id
        LEFT JOIN puntos_red ap        ON ap.id = c.conectado_a_id
        LEFT JOIN v_saldo_clientes s   ON s.client_id = c.id
        LEFT JOIN contratos ct         ON ct.client_id = c.id AND ct.estado = 'vigente'
        LEFT JOIN prestadores pr       ON pr.id = c.prestador_id
    $vista$;
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Los prestadores cargados y cuál es el que rige por defecto:
--   SELECT razon_social, nombre_comercial, ruc, predeterminado, modelo_inscrito_el
--     FROM prestadores ORDER BY predeterminado DESC;
--
--   -- Qué le falta a cada abonado para poder imprimirle el contrato:
--   SELECT nombre,
--          provincia IS NULL          AS sin_provincia,
--          tarifa_preferencial IS NULL AS sin_preguntar_preferencial,
--          acepta_arbitraje IS NULL    AS sin_preguntar_arbitraje
--     FROM clientes WHERE estado <> 'baja' LIMIT 20;
--
--   -- Y que la ficha pueda leerlo:
--   SELECT prestador, provincia, tarifa_preferencial FROM v_clientes_ficha LIMIT 3;
