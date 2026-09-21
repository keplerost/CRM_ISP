-- =============================================================================
-- Migración 03 — Facturación electrónica SRI (Ecuador)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente.
--
-- Los comprobantes se apoyan en la tabla `clientes` de este sistema (creada en
-- la migración 02). El esquema de referencia hablaba de `clients` y
-- `service_contracts`; acá se usa lo que ya existe.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =============================================================================
-- Configuración del emisor  (una sola fila)
-- =============================================================================
CREATE TABLE IF NOT EXISTS sri_config (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Datos del emisor tal como los exige el SRI
    ruc                 VARCHAR(13) NOT NULL,
    razon_social        VARCHAR(300) NOT NULL,
    nombre_comercial    VARCHAR(300),
    dir_matriz          VARCHAR(300) NOT NULL,
    dir_establecimiento VARCHAR(300),
    contribuyente_especial VARCHAR(13),
    obligado_contabilidad BOOLEAN NOT NULL DEFAULT FALSE,
    agente_retencion    VARCHAR(10),
    regimen_microempresas BOOLEAN DEFAULT FALSE,

    -- 1 = pruebas, 2 = producción. Cambiarlo apunta a otros endpoints del SRI.
    ambiente            VARCHAR(1) NOT NULL DEFAULT '1' CHECK (ambiente IN ('1', '2')),
    -- 1 = emisión normal (la única en uso desde que se eliminó la contingencia)
    tipo_emision        VARCHAR(1) NOT NULL DEFAULT '1',

    -- Certificado .p12 en base64 y su clave. Van cifrados con la misma
    -- CREDENTIALS_KEY del middleware: la firma ocurre en el backend, nunca
    -- en el navegador.
    certificado_b64     TEXT,
    certificado_pass_encrypted TEXT,
    certificado_vence   DATE,

    -- SMTP para enviar el XML autorizado y el RIDE al comprador
    smtp_host           VARCHAR(200),
    smtp_port           INT DEFAULT 587,
    smtp_secure         BOOLEAN DEFAULT FALSE,
    smtp_user           VARCHAR(200),
    smtp_pass_encrypted TEXT,
    email_from          VARCHAR(200),
    email_from_name     VARCHAR(200),

    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Una sola configuración: el índice lo garantiza a nivel de base.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sri_config_unica ON sri_config ((TRUE));

COMMENT ON COLUMN sri_config.ambiente IS
    '1 = pruebas (celcer.sri.gob.ec), 2 = producción (cel.sri.gob.ec)';


-- =============================================================================
-- Secuenciales por tipo de comprobante y punto de emisión
-- =============================================================================
CREATE TABLE IF NOT EXISTS sri_sequences (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_doc      VARCHAR(2) NOT NULL,
    establecimiento VARCHAR(3) NOT NULL DEFAULT '001',
    punto_emision VARCHAR(3) NOT NULL DEFAULT '001',
    ultimo_numero BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tipo_doc, establecimiento, punto_emision)
);

INSERT INTO sri_sequences (tipo_doc, establecimiento, punto_emision) VALUES
    ('01', '001', '001'),   -- Factura
    ('03', '001', '001'),   -- Liquidación de compra
    ('04', '001', '001'),   -- Nota de crédito
    ('05', '001', '001'),   -- Nota de débito
    ('06', '001', '001'),   -- Guía de remisión
    ('07', '001', '001')    -- Comprobante de retención
ON CONFLICT (tipo_doc, establecimiento, punto_emision) DO NOTHING;


-- =============================================================================
-- Comprobantes electrónicos
-- =============================================================================
CREATE TABLE IF NOT EXISTS electronic_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tipo_doc            VARCHAR(2) NOT NULL
                        CHECK (tipo_doc IN ('01', '03', '04', '05', '06', '07')),
    ambiente            VARCHAR(1) NOT NULL DEFAULT '1',
    tipo_emision        VARCHAR(1) NOT NULL DEFAULT '1',

    -- Numeración
    establecimiento     VARCHAR(3) NOT NULL DEFAULT '001',
    punto_emision       VARCHAR(3) NOT NULL DEFAULT '001',
    secuencial          VARCHAR(9) NOT NULL,
    -- 49 dígitos. Es la identidad del comprobante ante el SRI.
    clave_acceso        VARCHAR(49) NOT NULL UNIQUE,

    fecha_emision       DATE NOT NULL DEFAULT CURRENT_DATE,

    -- Comprador
    client_id           UUID REFERENCES clientes(id) ON DELETE SET NULL,
    tipo_identificacion_comprador VARCHAR(2) NOT NULL DEFAULT '05',
    identificacion_comprador VARCHAR(20) NOT NULL,
    razon_social_comprador   VARCHAR(300) NOT NULL,
    direccion_comprador VARCHAR(300),
    email_comprador     VARCHAR(200),

    -- Totales
    total_sin_impuestos NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_descuento     NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_iva           NUMERIC(14,2) NOT NULL DEFAULT 0,
    propina             NUMERIC(14,2) NOT NULL DEFAULT 0,
    importe_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
    moneda              VARCHAR(20) NOT NULL DEFAULT 'DOLAR',
    forma_pago          VARCHAR(2) DEFAULT '01',

    -- Ciclo de vida ante el SRI
    estado              VARCHAR(15) NOT NULL DEFAULT 'BORRADOR'
                        CHECK (estado IN ('BORRADOR','FIRMADO','ENVIADO','AUTORIZADO','NO_AUTORIZADO','ANULADO')),
    numero_autorizacion VARCHAR(49),
    fecha_autorizacion  TIMESTAMP WITH TIME ZONE,
    mensaje_autorizacion TEXT,

    xml_sin_firma       TEXT,
    xml_firmado         TEXT,
    xml_autorizado      TEXT,

    enviado_por_email   BOOLEAN DEFAULT FALSE,
    fecha_envio_email   TIMESTAMP WITH TIME ZONE,

    -- Para notas de crédito/débito: a qué comprobante modifican
    doc_modificado_tipo VARCHAR(2),
    doc_modificado_numero VARCHAR(17),
    doc_modificado_fecha DATE,
    motivo              VARCHAR(300),

    observaciones       TEXT,
    created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE (tipo_doc, establecimiento, punto_emision, secuencial)
);

CREATE INDEX IF NOT EXISTS idx_docs_tipo_estado ON electronic_documents (tipo_doc, estado);
CREATE INDEX IF NOT EXISTS idx_docs_cliente     ON electronic_documents (client_id);
CREATE INDEX IF NOT EXISTS idx_docs_fecha       ON electronic_documents (fecha_emision DESC);


-- =============================================================================
-- Detalle de facturas, notas y liquidaciones
-- =============================================================================
CREATE TABLE IF NOT EXISTS document_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID NOT NULL REFERENCES electronic_documents(id) ON DELETE CASCADE,

    orden               INT NOT NULL DEFAULT 1,
    codigo_principal    VARCHAR(25),
    codigo_auxiliar     VARCHAR(25),
    descripcion         VARCHAR(300) NOT NULL,

    cantidad            NUMERIC(14,6) NOT NULL DEFAULT 1,
    precio_unitario     NUMERIC(14,6) NOT NULL DEFAULT 0,
    descuento           NUMERIC(14,2) NOT NULL DEFAULT 0,
    precio_total_sin_impuesto NUMERIC(14,2) NOT NULL DEFAULT 0,

    -- '2' = IVA. Los códigos de porcentaje los define el SRI:
    -- '0'=0%, '2'=12%, '3'=14%, '4'=15%, '6'=No objeto, '7'=Exento
    codigo_impuesto     VARCHAR(1) NOT NULL DEFAULT '2',
    codigo_porcentaje   VARCHAR(4) NOT NULL DEFAULT '4',
    tarifa_iva          NUMERIC(5,2) NOT NULL DEFAULT 15.00,
    base_imponible_iva  NUMERIC(14,2) NOT NULL DEFAULT 0,
    valor_iva           NUMERIC(14,2) NOT NULL DEFAULT 0,

    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_items_doc ON document_items (document_id, orden);


-- =============================================================================
-- Detalle de comprobantes de retención
-- =============================================================================
CREATE TABLE IF NOT EXISTS retencion_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID NOT NULL REFERENCES electronic_documents(id) ON DELETE CASCADE,

    -- '1' = Renta, '2' = IVA, '6' = ISD
    codigo              VARCHAR(1) NOT NULL,
    codigo_retencion    VARCHAR(5) NOT NULL,
    base_imponible      NUMERIC(14,2) NOT NULL DEFAULT 0,
    porcentaje_retener  NUMERIC(5,2) NOT NULL DEFAULT 0,
    valor_retenido      NUMERIC(14,2) NOT NULL DEFAULT 0,

    -- Comprobante sobre el que se practica la retención
    cod_doc_sustento    VARCHAR(2),
    num_doc_sustento    VARCHAR(17),
    fecha_emision_doc_sustento DATE,

    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retenciones_doc ON retencion_items (document_id);


-- =============================================================================
-- Secuencial atómico
-- =============================================================================
-- Dos emisiones simultáneas no pueden recibir el mismo número: el SRI rechaza
-- el duplicado y el comprobante se pierde. El UPDATE ... RETURNING resuelve el
-- incremento y la lectura en una sola operación, bajo el lock de la fila.
CREATE OR REPLACE FUNCTION sri_next_secuencial(
    p_tipo  TEXT,
    p_estab TEXT DEFAULT '001',
    p_pto   TEXT DEFAULT '001'
)
RETURNS BIGINT AS $$
DECLARE
    v_numero BIGINT;
BEGIN
    UPDATE sri_sequences
       SET ultimo_numero = ultimo_numero + 1
     WHERE tipo_doc = p_tipo
       AND establecimiento = p_estab
       AND punto_emision = p_pto
    RETURNING ultimo_numero INTO v_numero;

    IF v_numero IS NULL THEN
        INSERT INTO sri_sequences (tipo_doc, establecimiento, punto_emision, ultimo_numero)
        VALUES (p_tipo, p_estab, p_pto, 1)
        RETURNING ultimo_numero INTO v_numero;
    END IF;

    RETURN v_numero;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sri_next_secuencial IS
    'Devuelve el siguiente secuencial de forma atómica. Usar SIEMPRE esto en vez de leer y sumar por separado.';


-- =============================================================================
-- Vista para el listado
-- =============================================================================
CREATE OR REPLACE VIEW v_electronic_documents AS
SELECT
    d.*,
    c.nombre AS client_name,
    c.ip     AS client_ip,
    -- Número visible del comprobante: 001-001-000000123
    d.establecimiento || '-' || d.punto_emision || '-' || d.secuencial AS numero_comprobante
FROM electronic_documents d
LEFT JOIN clientes c ON c.id = d.client_id;


-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE sri_config           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sri_sequences        ENABLE ROW LEVEL SECURITY;
ALTER TABLE electronic_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE retencion_items      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'sri_config', 'sri_sequences', 'electronic_documents',
        'document_items', 'retencion_items'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS "auth_all_%1$s" ON %1$I', t);
        EXECUTE format(
            'CREATE POLICY "auth_all_%1$s" ON %1$I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            t
        );
    END LOOP;
END $$;


-- =============================================================================
-- updated_at automático
-- =============================================================================
DROP TRIGGER IF EXISTS trg_sri_config_updated_at ON sri_config;
CREATE TRIGGER trg_sri_config_updated_at
    BEFORE UPDATE ON sri_config
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();

DROP TRIGGER IF EXISTS trg_docs_updated_at ON electronic_documents;
CREATE TRIGGER trg_docs_updated_at
    BEFORE UPDATE ON electronic_documents
    FOR EACH ROW EXECUTE FUNCTION tocar_updated_at();
