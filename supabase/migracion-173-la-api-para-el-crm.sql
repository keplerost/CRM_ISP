-- =============================================================================
-- Migración 173 — La puerta para el CRM: llaves de API y pagos reportados
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué problema resuelve ──
--
-- Hasta acá toda la API exige el access token de Supabase de una PERSONA del
-- personal. Un bot de WhatsApp no es una persona: no se loguea, no rota su
-- contraseña y no puede tener una sesión de ocho horas colgada. Darle el
-- usuario de alguien sería peor que abrir la API — cada cosa que haga el bot
-- quedaría firmada por un humano que no la hizo.
--
-- Lo que se agrega:
--
--   api_llaves       quién es el sistema externo, qué puede hacer y desde
--                    dónde. La llave NO se guarda: se guarda su huella.
--   api_llamadas     qué pidió, cuándo y con qué resultado. Sin esto, el día
--                    que un pago aparezca de la nada no hay a quién preguntarle.
--   pagos_reportados la bandeja de "el cliente dice que pagó". NO es un cobro:
--                    es una declaración que alguien tiene que verificar.
--
-- ── Por qué los pagos del bot no entran directo a caja ──
--
-- Un canal de WhatsApp es un lugar donde cualquiera escribe lo que quiere. Si
-- el bot pudiera saldar facturas con lo que le dicen, alcanzaría una captura
-- editada para quedar al día: la deuda se borra, el corte no se ejecuta y el
-- faltante recién aparece en la conciliación del mes siguiente — para entonces
-- ya está en el cierre de caja, en la comisión del vendedor y en el reporte de
-- ARCOTEL.
--
-- Por eso hay dos caminos, y la diferencia es QUIÉN afirma que la plata entró:
--
--   * Lo confirma la pasarela (Cuentadigital, PayPhone, Datafast…): el aviso
--     viene firmado por quien recibió el dinero. Se aplica solo, con
--     `aplicar_cobro`, igual que un cobro de ventanilla.
--   * Lo afirma el abonado por chat: queda reportado y espera. Cobranzas mira
--     el comprobante contra el extracto y confirma. Recién ahí es un cobro.
--
-- El bot contesta parecido en los dos casos, pero la contabilidad solo se mueve
-- cuando hay quien responda por la plata.
-- =============================================================================


-- =============================================================================
-- 1. Las llaves
-- =============================================================================
-- ── Por qué la llave no se guarda ──
--
-- Es el mismo criterio que las sesiones del portal (migración 64): se guarda la
-- huella HMAC calculada con `CREDENTIALS_KEY`, que vive en el .env del
-- middleware. Quien se lleve un volcado de la base no se lleva las llaves: para
-- probarlas contra la huella necesita también el archivo del servidor.
--
-- El `prefijo` sí se guarda en claro y a propósito: son los primeros caracteres
-- de la llave, lo único con lo que quien la creó puede reconocer cuál es cuál
-- en la pantalla. Sin eso, revocar la llave correcta entre tres es adivinar.
CREATE TABLE IF NOT EXISTS api_llaves (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Con qué se la reconoce: "Bot de WhatsApp", "Webhook Cuentadigital".
    nombre      VARCHAR(80) NOT NULL,
    prefijo     VARCHAR(16) NOT NULL,
    huella      TEXT NOT NULL UNIQUE,

    -- Qué puede hacer. Se usan los mismos nombres del catálogo de permisos del
    -- personal para que no haya dos vocabularios: `clientes.ver`,
    -- `facturacion.ver`, `pagos.registrar`, `soporte.crear`, `red.wifi`.
    permisos    TEXT[] NOT NULL DEFAULT '{}',

    -- Desde dónde puede llamar.
    --
    -- Vacío = desde cualquier lado, que es lo que hace falta mientras se prueba
    -- y cuando el CRM está en un servicio con IP de salida cambiante. Cargarla
    -- es la diferencia entre una llave filtrada que sirve desde cualquier café
    -- y una que solo sirve desde el servidor del proveedor.
    ips_permitidas TEXT[] NOT NULL DEFAULT '{}',

    -- A qué cuenta entra la plata que registre esta llave.
    --
    -- Va en la llave y no en cada pedido: si el sistema externo pudiera elegir
    -- la cuenta, un error suyo mandaría a la caja de la oficina plata que entró
    -- al banco, y la conciliación del mes siguiente no cerraría sin que nadie
    -- entienda por qué. Una llave = un lugar donde entra la plata.
    cuenta_id   UUID REFERENCES cuentas_pago(id) ON DELETE SET NULL,

    -- Si esta llave puede aplicar cobros sin que un humano los verifique.
    --
    -- FALSE es el valor de arranque y es el correcto para un bot de chat: lo
    -- que reporte queda en la bandeja. Se pone en TRUE solo para la llave del
    -- webhook de una pasarela, donde quien afirma que la plata entró es el que
    -- la recibió.
    confirma_pagos BOOLEAN NOT NULL DEFAULT FALSE,

    -- Si un pago confirmado por esta llave reactiva el servicio cortado.
    --
    -- Solo tiene efecto cuando el pago quedó CONFIRMADO — sea porque la llave
    -- confirma sola, sea porque cobranzas lo verificó. Un pago que espera
    -- verificación nunca reactiva nada: sería devolver el servicio a cambio de
    -- una promesa escrita en un chat.
    reactiva_servicio BOOLEAN NOT NULL DEFAULT FALSE,

    activa      BOOLEAN NOT NULL DEFAULT TRUE,
    notas       TEXT,

    creada_por  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ultimo_uso  TIMESTAMPTZ,
    revocada_at TIMESTAMPTZ,
    revocada_por UUID,
    motivo_revocacion TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_llaves_activa ON api_llaves (activa) WHERE activa;

COMMENT ON TABLE api_llaves IS
    'Sistemas externos autorizados a llamar a /api/integracion. La llave no se guarda: se guarda su huella HMAC con CREDENTIALS_KEY.';
COMMENT ON COLUMN api_llaves.confirma_pagos IS
    'TRUE solo para webhooks de pasarela: aplica el cobro sin verificacion humana. FALSE para bots de chat.';


-- =============================================================================
-- 2. El registro de lo que pidió
-- =============================================================================
-- ── Por qué se guarda hasta lo que salió bien ──
--
-- Porque la pregunta que llega no es "¿hubo un error?" sino "¿quién consultó la
-- deuda de esta cédula el martes?". Un log de errores no la contesta.
--
-- No se guarda el cuerpo del pedido: ahí viajan montos, teléfonos y a veces el
-- número de comprobante. Se guarda con QUÉ se buscó (la identificación) porque
-- es lo que permite reconstruir el caso, y nada más.
CREATE TABLE IF NOT EXISTS api_llamadas (
    id          BIGSERIAL PRIMARY KEY,
    llave_id    UUID REFERENCES api_llaves(id) ON DELETE SET NULL,
    -- El nombre se copia: si la llave se borra, el rastro tiene que seguir
    -- diciendo de quién era.
    llave_nombre VARCHAR(80),
    metodo      VARCHAR(8) NOT NULL,
    ruta        VARCHAR(200) NOT NULL,
    status      INTEGER,
    ms          INTEGER,
    ip          VARCHAR(60),
    identificacion VARCHAR(20),
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_llamadas_llave ON api_llamadas (llave_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_llamadas_fecha ON api_llamadas (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_llamadas_ident ON api_llamadas (identificacion)
    WHERE identificacion IS NOT NULL;


-- =============================================================================
-- 3. La bandeja de pagos reportados
-- =============================================================================
CREATE TABLE IF NOT EXISTS pagos_reportados (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    client_id   UUID REFERENCES clientes(id) ON DELETE SET NULL,
    -- Copiados al momento de reportar: el reporte tiene que poder leerse aunque
    -- la ficha del abonado cambie o se borre.
    cliente_nombre VARCHAR(150),
    identificacion VARCHAR(20),

    llave_id    UUID REFERENCES api_llaves(id) ON DELETE SET NULL,
    llave_nombre VARCHAR(80),

    monto       NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    forma_pago  VARCHAR(20) NOT NULL DEFAULT 'transferencia'
                CHECK (forma_pago IN ('efectivo', 'transferencia', 'deposito', 'tarjeta', 'otro')),
    n_transaccion VARCHAR(60),
    fecha_pago  DATE NOT NULL DEFAULT CURRENT_DATE,

    -- La referencia del sistema externo. Es lo que hace idempotente al endpoint.
    --
    -- Un bot reintenta: se cortó el enlace del servidor, el proveedor del CRM
    -- repite el webhook, el abonado manda el comprobante dos veces. Sin una
    -- clave del lado de afuera, cada reintento es un pago más y el abonado
    -- termina con saldo a favor que nadie le debe.
    referencia_externa VARCHAR(120),

    -- A dónde quedó el comprobante que mandó el abonado, si lo mandó.
    comprobante_url TEXT,
    notas       TEXT,

    estado      VARCHAR(12) NOT NULL DEFAULT 'pendiente'
                CHECK (estado IN ('pendiente', 'confirmado', 'rechazado')),

    -- El cobro que nació de este reporte, cuando se confirmó.
    pago_id     UUID REFERENCES pagos(id) ON DELETE SET NULL,

    verificado_por UUID,
    verificado_at  TIMESTAMPTZ,
    motivo_rechazo TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un reporte por referencia y por llave. Dos CRM distintos pueden usar el
-- número "1024" para cosas distintas; el mismo CRM, no.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pagos_reportados_referencia
    ON pagos_reportados (llave_id, referencia_externa)
    WHERE referencia_externa IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pagos_reportados_pendientes
    ON pagos_reportados (created_at DESC) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_pagos_reportados_cliente
    ON pagos_reportados (client_id, created_at DESC);

COMMENT ON TABLE pagos_reportados IS
    'Pagos que un sistema externo dice que ocurrieron. Mientras estan pendientes NO son un cobro: no suman a caja, no saldan facturas y no reactivan servicio.';


-- =============================================================================
-- 4. La vista que mira cobranza
-- =============================================================================
-- Trae la deuda del abonado al lado del reporte: quien verifica necesita saber
-- si el monto que dice haber pagado se parece a lo que debe. Un reporte de $20
-- sobre una deuda de $20 y uno de $20 sobre una deuda de $180 se miran
-- distinto, y sin esto hay que abrir la ficha en otra pestaña para saberlo.
DROP VIEW IF EXISTS v_pagos_reportados;
CREATE VIEW v_pagos_reportados WITH (security_invoker = true) AS
SELECT
    r.id,
    r.client_id,
    r.cliente_nombre,
    r.identificacion,
    r.llave_id,
    r.llave_nombre,
    r.monto,
    r.forma_pago,
    r.n_transaccion,
    r.fecha_pago,
    r.referencia_externa,
    r.comprobante_url,
    r.notas,
    r.estado,
    r.pago_id,
    r.verificado_por,
    r.verificado_at,
    r.motivo_rechazo,
    r.created_at,
    c.estado AS estado_servicio,
    c.telefono_movil,
    c.codigo_pago,
    c.zona,
    COALESCE(d.saldo, 0) AS deuda_actual
FROM pagos_reportados r
LEFT JOIN clientes c ON c.id = r.client_id
LEFT JOIN LATERAL (
    SELECT SUM(f.saldo) AS saldo
      FROM v_facturas_por_cobrar f
     WHERE f.client_id = r.client_id
) d ON TRUE;


-- =============================================================================
-- 5. Confirmar un reporte
-- =============================================================================
-- ── Por qué una función y no dos llamadas desde el servidor ──
--
-- Porque aplicar el cobro y marcar el reporte como confirmado tienen que pasar
-- juntos o no pasar. Si el middleware hiciera `aplicar_cobro` y después el
-- UPDATE, un corte en el medio deja un cobro registrado y un reporte que sigue
-- diciendo "pendiente": alguien lo confirma de nuevo y el abonado paga dos
-- veces. Adentro de una función es una sola transacción.
--
-- `p_cuenta_id` puede venir NULL: en ese caso se usa la de la llave. Se permite
-- pisarla porque quien verifica está mirando el extracto y a veces descubre que
-- la transferencia entró a una cuenta distinta de la que el bot suponía.
CREATE OR REPLACE FUNCTION confirmar_pago_reportado(
    p_id         UUID,
    p_usuario    UUID DEFAULT NULL,
    p_cuenta_id  UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_r        pagos_reportados%ROWTYPE;
    v_cuenta   UUID;
    v_cobro    JSONB;
BEGIN
    SELECT * INTO v_r FROM pagos_reportados WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese pago reportado';
    END IF;

    -- Confirmar dos veces es el error fácil: dos personas de cobranza mirando
    -- la misma bandeja. El segundo no cobra de nuevo, se entera.
    IF v_r.estado = 'confirmado' THEN
        RAISE EXCEPTION 'Ese pago ya fue confirmado';
    END IF;
    IF v_r.estado = 'rechazado' THEN
        RAISE EXCEPTION 'Ese pago fue rechazado: %', COALESCE(v_r.motivo_rechazo, 'sin motivo');
    END IF;
    IF v_r.client_id IS NULL THEN
        RAISE EXCEPTION 'El reporte no tiene abonado asociado: no se puede aplicar';
    END IF;

    SELECT COALESCE(p_cuenta_id, l.cuenta_id) INTO v_cuenta
      FROM api_llaves l WHERE l.id = v_r.llave_id;
    v_cuenta := COALESCE(v_cuenta, p_cuenta_id);

    -- El reparto entre facturas es el mismo que el de la ventanilla: de la más
    -- vieja a la más nueva, y lo que sobre queda a favor. Un cobro que entró por
    -- el chat no se imputa distinto que uno que entró por caja.
    v_cobro := aplicar_cobro(
        p_client_id       => v_r.client_id,
        p_monto           => v_r.monto,
        p_forma_pago      => v_r.forma_pago,
        p_cuenta_id       => v_cuenta,
        p_n_transaccion   => v_r.n_transaccion,
        p_fecha_pago      => v_r.fecha_pago,
        p_notas           => CONCAT_WS(' · ',
                                'Reportado por ' || COALESCE(v_r.llave_nombre, 'sistema externo'),
                                v_r.notas),
        p_comision        => 0,
        p_factura_id      => NULL,
        p_facturar        => NULL,
        p_activo_servicio => FALSE,
        p_solo_servicio   => TRUE,
        p_created_by      => p_usuario
    );

    UPDATE pagos_reportados
       SET estado         = 'confirmado',
           pago_id        = (v_cobro->>'pago_id')::UUID,
           verificado_por = p_usuario,
           verificado_at  = NOW()
     WHERE id = p_id;

    RETURN jsonb_build_object(
        'reporte_id', p_id,
        'cobro', v_cobro
    );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION confirmar_pago_reportado IS
    'Convierte un pago reportado en un cobro real. Aplica aplicar_cobro y marca el reporte en la misma transaccion.';


CREATE OR REPLACE FUNCTION rechazar_pago_reportado(
    p_id      UUID,
    p_motivo  TEXT,
    p_usuario UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    IF COALESCE(TRIM(p_motivo), '') = '' THEN
        RAISE EXCEPTION 'Hay que decir por qué se rechaza: es lo que el abonado va a preguntar';
    END IF;

    UPDATE pagos_reportados
       SET estado         = 'rechazado',
           motivo_rechazo = TRIM(p_motivo),
           verificado_por = p_usuario,
           verificado_at  = NOW()
     WHERE id = p_id AND estado = 'pendiente';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ese pago reportado no existe o ya fue resuelto';
    END IF;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- 6. RLS
-- =============================================================================
-- El middleware entra con la service_role key y pasa por encima de esto: son
-- las reglas para lo que el NAVEGADOR consulta directo.
--
-- Las llaves y sus llamadas no se leen desde el navegador ni siquiera para
-- mirar: la huella no sirve para entrar, pero la lista de qué integraciones
-- existen y desde qué IP llaman es justo el mapa que se necesita para atacarlas.
-- La pantalla las pide por el middleware, que decide con el permiso.
ALTER TABLE api_llaves       ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_llamadas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos_reportados ENABLE ROW LEVEL SECURITY;

-- La bandeja sí: es una cola de trabajo de cobranza y la pantalla la lee
-- directo, como el resto de las pantallas de cobros.
DROP POLICY IF EXISTS pagos_reportados_staff ON pagos_reportados;
CREATE POLICY pagos_reportados_staff ON pagos_reportados
    FOR SELECT TO authenticated USING (true);


-- =============================================================================
-- Comprobación
-- =============================================================================
--   SELECT nombre, prefijo, permisos, activa FROM api_llaves;
--   SELECT * FROM v_pagos_reportados WHERE estado = 'pendiente';
--   SELECT ruta, status, COUNT(*) FROM api_llamadas
--    WHERE created_at > NOW() - INTERVAL '1 day' GROUP BY 1,2 ORDER BY 3 DESC;
