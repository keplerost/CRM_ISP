-- Licencia del sistema.
--
-- Este sistema se vende: cada ISP compra su instalación y paga por mes según
-- cuántos abonados administra. Esta tabla guarda el permiso que lo habilita.
--
-- Es UNA SOLA FILA. No hay licencias por sucursal ni por usuario: se licencia
-- la instalación entera, que es lo que se vende.
--
-- El permiso viene firmado desde afuera y acá solo se guarda. La instalación no
-- puede fabricarse una licencia a sí misma: puede leer esta tabla, escribirla,
-- borrarla — y sin la firma correcta nada de eso la habilita.

CREATE TABLE IF NOT EXISTS licencia (
    id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Identifica esta instalación ante el emisor de licencias. Se genera sola
    -- la primera vez y no cambia nunca: es lo que ata el permiso a ESTA copia
    -- del sistema y no a otra. Copiar la base a otro servidor se lleva el mismo
    -- identificador, que es justamente lo que permite detectarlo.
    instalacion         UUID NOT NULL DEFAULT gen_random_uuid(),

    -- El permiso firmado, tal como lo emitió el vendedor. Opaco para la base:
    -- quien lo interpreta y verifica su firma es el middleware.
    token               TEXT,

    -- Cuándo se pudo hablar por última vez con el emisor. No es lo mismo que la
    -- validez: el permiso sigue valiendo aunque hoy no haya internet, y esto es
    -- lo que permite explicar por qué no se renovó.
    ultimo_contacto     TIMESTAMPTZ,
    ultimo_error        TEXT,

    creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La fila existe desde el arranque, sin licencia todavía. Así el identificador
-- de instalación queda fijado el primer día —hay algo que informarle al
-- vendedor para que emita el permiso— y no depende de que alguien entre a la
-- pantalla de licencia.
INSERT INTO licencia (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- La lee el frontend para saber si mostrar la pantalla de bloqueo. El token va
-- incluido a propósito: está firmado, así que exponerlo no habilita nada —
-- verificarlo exige la clave pública, y falsificarlo, la privada del vendedor.
ALTER TABLE licencia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS licencia_lectura ON licencia;
CREATE POLICY licencia_lectura ON licencia
    FOR SELECT TO authenticated
    USING (true);

-- Escribir queda solo para el middleware, que entra con service_role y no pasa
-- por RLS. Que un usuario pueda pegar un token desde el navegador sería un
-- camino directo a activar el sistema sin pagarlo.
DROP POLICY IF EXISTS licencia_escritura ON licencia;

COMMENT ON TABLE licencia IS
    'Licencia de esta instalación: una fila, con el permiso firmado por el vendedor.';
COMMENT ON COLUMN licencia.instalacion IS
    'Identificador de esta copia del sistema. Se le informa al vendedor para emitir el permiso.';
COMMENT ON COLUMN licencia.token IS
    'Permiso firmado (payload.firma). Sin firma válida no habilita nada.';
