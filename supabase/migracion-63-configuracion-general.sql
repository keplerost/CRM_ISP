-- =============================================================================
-- Migración 63 — La marca del sistema
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Este sistema se vende. El ISP que lo compra no quiere que sus técnicos entren
-- todos los días a una pantalla que dice el nombre del proveedor: quiere ver el
-- suyo, con su logo.
--
-- Es distinto de los datos de la empresa (migración 04): aquellos son los que
-- salen impresos en la factura y los valida el SRI. Esto es lo que se ve en
-- pantalla, y puede ser otra cosa — el nombre comercial, o directamente el
-- nombre que le dieron internamente al sistema.
-- =============================================================================

CREATE TABLE IF NOT EXISTS config_general (
    id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Lo que se ve al entrar y en la pestaña del navegador.
    nombre_sistema  VARCHAR(60),
    -- Debajo del nombre, en el login. Sirve para distinguir instalaciones:
    -- "producción" y "pruebas" en dos pestañas iguales terminan mal.
    lema            VARCHAR(80),
    -- Data URL, como el logo de la factura. Es una sola imagen chica y evita
    -- montar almacenamiento de archivos para esto.
    logo_b64        TEXT,

    /*
     * La moneda.
     *
     * Se guarda el símbolo y no solo el código porque es lo que se imprime, y
     * porque no siempre coinciden: en Ecuador es USD pero se escribe "$", no
     * "US$". El código queda para cuando haya que hablar con una pasarela de
     * pago, que sí lo pide.
     */
    moneda_simbolo  VARCHAR(5)  NOT NULL DEFAULT '$',
    moneda_codigo   VARCHAR(3)  NOT NULL DEFAULT 'USD',

    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO config_general (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE config_general ENABLE ROW LEVEL SECURITY;

-- Se lee desde el navegador y ANTES de iniciar sesión: el nombre y el logo
-- tienen que estar en la pantalla de login, que es justo donde todavía no hay
-- usuario. Nada de esto es secreto — es lo que cualquiera ve al abrir el
-- sistema.
DROP POLICY IF EXISTS config_general_lectura ON config_general;
CREATE POLICY config_general_lectura ON config_general
    FOR SELECT TO anon, authenticated
    USING (true);

-- Escribir queda solo para el middleware, con service_role.
COMMENT ON TABLE config_general IS
    'La marca del sistema: lo que se ve en pantalla. Distinto de los datos fiscales de la empresa.';
COMMENT ON COLUMN config_general.moneda_simbolo IS
    'Lo que se imprime antes del monto. En Ecuador es $ aunque la moneda sea USD.';
