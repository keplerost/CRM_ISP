-- =============================================================================
-- Migración 200 — Los proveedores de factura electrónica
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- Fuera de Ecuador la factura electrónica se emite a través de un proveedor
-- autorizado en cada país (OpenFactura en Chile, Alegra en Colombia, Nubefact
-- en Perú…). Acá se guarda, por país y proveedor, lo que cada uno pide para
-- conectarse. Qué campos pide cada uno vive en el middleware
-- (lib/proveedoresFactura.js).
--
-- Las claves (API key, token, contraseña) van cifradas con la CREDENTIALS_KEY
-- del middleware, igual que las de los routers y las OLTs: no se leen desde el
-- navegador.
--
-- Ecuador no usa esta tabla: el SRI se configura en `sri_config`.
-- =============================================================================

CREATE TABLE IF NOT EXISTS factura_proveedores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pais                VARCHAR(2)  NOT NULL,
    proveedor           VARCHAR(40) NOT NULL,

    -- El que se usa para emitir. Uno solo por país (ver el índice de abajo).
    activo              BOOLEAN     NOT NULL DEFAULT FALSE,
    modo_prueba         BOOLEAN     NOT NULL DEFAULT TRUE,

    -- Lo que no es secreto: razón social, RUT, serie, código postal…
    datos               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- { "api_key": "<cifrado>", ... }. Nunca sale del middleware.
    secretos_cifrados   JSONB       NOT NULL DEFAULT '{}'::jsonb,

    actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pais, proveedor)
);

-- Un solo proveedor activo por país: con dos, no habría forma de saber por
-- cuál sale cada comprobante.
CREATE UNIQUE INDEX IF NOT EXISTS idx_factura_proveedores_un_activo
    ON factura_proveedores (pais) WHERE activo;

-- Solo el middleware, con service_role. Sin políticas: nadie la lee desde el
-- navegador, ni siquiera un usuario con sesión.
ALTER TABLE factura_proveedores ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE factura_proveedores IS
    'Conexión con el proveedor de factura electrónica de cada país. Los secretos van cifrados.';

-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT pais, proveedor, activo, modo_prueba, datos FROM factura_proveedores;
