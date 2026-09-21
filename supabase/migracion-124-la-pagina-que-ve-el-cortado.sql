-- =============================================================================
-- Migración 124 — La página que ve el abonado cortado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué resuelve ──
--
-- Hoy el abonado cortado en La Maná va a parar a una página del sistema
-- anterior, servida en el puerto 999 del router. El día que ese sistema se
-- apague, el moroso va a ver un error de conexión en vez de un aviso: no va a
-- saber que le cortaron, ni cuánto debe, ni dónde pagar. Va a llamar preguntando
-- "no tengo internet", y alguien va a tener que explicárselo por teléfono, una
-- llamada por vez.
--
-- ── Por qué la página necesita configuración propia ──
--
-- Porque lo que dice tiene consecuencias. El monto que muestra es una cifra que
-- el abonado va a depositar, y el número que muestra es al que va a mandar el
-- comprobante. Los dos tienen que poder corregirse sin tocar código, y tiene que
-- poder decidirse cuáles cuentas se publican: la caja de la oficina no va en una
-- página que ve cualquiera que se conecte a la red.
-- =============================================================================

CREATE TABLE IF NOT EXISTS config_corte (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Si la página está en uso. Apagada, el servidor contesta que no está
    -- configurada en vez de mostrar una página a medio llenar.
    activa BOOLEAN NOT NULL DEFAULT FALSE,

    /**
     * A dónde manda el comprobante.
     *
     * Es el dato más importante de la página después del monto: sin él, el
     * abonado deposita y nadie se entera, así que sigue cortado y vuelve a
     * llamar. Va aparte del teléfono de la empresa porque el que atiende ventas
     * no es necesariamente el que concilia los depósitos.
     */
    whatsapp_pagos VARCHAR(30),
    telefono_pagos VARCHAR(30),

    titulo   VARCHAR(120) NOT NULL DEFAULT 'Tu servicio está suspendido',
    -- Por qué se le cortó, en las palabras del ISP. Se puede cambiar sin tocar
    -- código porque el tono de este mensaje es una decisión comercial.
    mensaje  TEXT NOT NULL DEFAULT
        'Tu servicio de internet fue suspendido por falta de pago. Apenas registremos tu pago se reactiva automáticamente.',

    -- Qué mostrar. Un ISP puede no querer publicar el monto exacto en una
    -- página sin contraseña, aunque solo la vea el dueño de esa conexión.
    mostrar_saldo    BOOLEAN NOT NULL DEFAULT TRUE,
    mostrar_facturas BOOLEAN NOT NULL DEFAULT TRUE,

    -- Lo que se le dice después de pagar. Es lo que evita la segunda llamada.
    aviso_despues_de_pagar TEXT NOT NULL DEFAULT
        'Enviá la foto del comprobante por WhatsApp y reactivamos tu servicio.',

    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO config_corte (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE config_corte ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_config_corte" ON config_corte;
CREATE POLICY "auth_all_config_corte" ON config_corte
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Qué cuentas se publican
-- =============================================================================
/**
 * ── Por qué no se publican todas ──
 *
 * Porque `cuentas_pago` incluye la caja de la oficina, y "depositá en Caja
 * Oficina" no significa nada para alguien sentado en su casa. Y porque un ISP
 * puede tener una cuenta que usa solo para transferencias entre socios.
 *
 * Arranca en FALSE para todas: publicar un número de cuenta es una decisión, no
 * un valor por defecto.
 */
ALTER TABLE cuentas_pago
    ADD COLUMN IF NOT EXISTS mostrar_en_corte BOOLEAN NOT NULL DEFAULT FALSE;

/**
 * La cédula o RUC del titular.
 *
 * En Ecuador el depósito se hace con el número de cuenta Y la identificación
 * del titular; el cajero la pide. Sin ella el abonado llega a la ventanilla y
 * no puede completar el depósito — y vuelve a llamar.
 */
ALTER TABLE cuentas_pago
    ADD COLUMN IF NOT EXISTS identificacion VARCHAR(20);

COMMENT ON COLUMN cuentas_pago.mostrar_en_corte IS
    'Si esta cuenta aparece en la página que ve el abonado cortado. Apagada por defecto: publicar un número de cuenta es una decisión.';


-- =============================================================================
-- Lo que la página necesita saber de un abonado
-- =============================================================================
/**
 * Todo lo de una ficha que la página muestra, buscado por dirección IP.
 *
 * ── Por qué una vista y no una consulta armada en el middleware ──
 *
 * Porque esta página la sirve un proceso que atiende peticiones SIN sesión: el
 * abonado no inicia sesión, solo abre el navegador. Teniendo la lista de
 * columnas acá, el día que alguien agregue un campo delicado a `clientes` no
 * termina publicado por accidente en la única pantalla del sistema que puede
 * ver cualquiera.
 *
 * Va sin `security_invoker`: la consulta el middleware con service_role, y esta
 * vista es justamente el recorte de lo que se puede publicar.
 */
/**
 * ── El guardián ──
 *
 * La 129 le agrega `avisos_pantalla` a esta vista: es lo que decide si a este
 * abonado se le muestra la página o se lo deja con el error de conexión. Volver
 * a correr este archivo se la llevaría, y no falla limpio — aborta con "cannot
 * drop columns from view" y deja la migración a medias.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_corte_abonado'
           AND column_name = 'avisos_pantalla'
    ) THEN
        RAISE NOTICE 'v_corte_abonado ya tiene una versión posterior a la 124: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_corte_abonado AS
SELECT
    c.id,
    c.codigo,
    c.nombre,
    c.ip,
    c.router_id,
    c.estado,
    c.estado_desde,
    c.telefono_movil,
    p.nombre                            AS plan,
    COALESCE(s.saldo, 0)                AS saldo,
    COALESCE(s.facturas_pendientes, 0)  AS facturas_pendientes,
    s.ultimo_pago
FROM clientes c
LEFT JOIN planes_velocidad p ON p.id = c.plan_id
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.ip IS NOT NULL AND c.ip <> ''
    $vista$;
END $guarda$;

COMMENT ON VIEW v_corte_abonado IS
    'El recorte publicable de una ficha, para la página que ve el abonado cortado. La lista de columnas es explícita a propósito.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Publicar las cuentas del banco y esconder la caja:
--   UPDATE cuentas_pago SET mostrar_en_corte = TRUE WHERE tipo = 'banco';
--
--   -- Poner el número al que se manda el comprobante y encender la página:
--   UPDATE config_corte
--      SET whatsapp_pagos = '0981864229', activa = TRUE WHERE id = 1;
--
--   -- Y ver qué le mostraría a una IP concreta:
--   SELECT nombre, estado, saldo, facturas_pendientes
--     FROM v_corte_abonado WHERE ip = '172.16.11.133';
