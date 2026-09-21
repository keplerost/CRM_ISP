-- =============================================================================
-- Migración 28 — Comunicaciones, documentos, consumo, auditoría y comandos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 27. Es idempotente.
--
-- Es el esquema completo de los módulos que faltan en la ficha del abonado. Van
-- juntos en una migración porque comparten la misma idea: todo lo que se le hace
-- a un cliente —un mensaje, un documento, un corte, un reinicio de su router—
-- tiene que quedar escrito, con quién lo hizo y cuándo.
--
-- Sin eso, cuando el abonado dice "yo nunca autoricé que me cambien el plan" o
-- "a mí nadie me avisó del corte", la discusión es palabra contra palabra.
-- =============================================================================


-- =============================================================================
-- 0. El ticket toma el correo de quien reclama
-- =============================================================================
-- Faltaba en el alta y hace falta para mandarle el acta de cierre. Como el
-- ticket copia los datos del abonado, también copia el correo: si mañana la
-- ficha cambia, el ticket sigue diciendo a dónde se le escribió.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email VARCHAR(150);

-- `v_tickets` se define con `t.*`: sin rehacerla, la columna nueva existe en la
-- tabla y no llega a la pantalla.
DROP VIEW IF EXISTS v_tickets;

CREATE VIEW v_tickets WITH (security_invoker = true) AS
SELECT
    t.*,
    LPAD(t.numero::TEXT, 6, '0')          AS codigo,
    nap.nombre                            AS nap,
    torre.nombre                          AS torre,
    tec.nombre                            AS tecnico,
    tec.telefono                          AS tecnico_telefono,
    cua.nombre                            AS cuadrilla,
    c.nombre                              AS cliente,
    c.plan_id,
    c.estado                              AS estado_cliente,
    EXTRACT(EPOCH FROM (COALESCE(t.cerrado_at, NOW()) - t.created_at)) / 3600 AS horas_abierto,
    (t.estado NOT IN ('resuelto', 'cancelado')
     AND t.fecha_visita IS NOT NULL
     AND t.fecha_visita < CURRENT_DATE)   AS visita_atrasada,
    (SELECT COUNT(*) FROM ticket_adjuntos a WHERE a.ticket_id = t.id) AS adjuntos,
    EXTRACT(EPOCH FROM (t.llegada_at - t.salida_at)) / 60 AS minutos_en_ruta,
    EXTRACT(EPOCH FROM (COALESCE(t.cerrado_at, NOW()) - t.llegada_at)) / 60 AS minutos_en_sitio,
    CASE
        WHEN t.llegada_lat IS NOT NULL AND t.latitud IS NOT NULL THEN
            ROUND((6371000 * 2 * ASIN(SQRT(
                POWER(SIN(RADIANS(t.llegada_lat - t.latitud) / 2), 2) +
                COS(RADIANS(t.latitud)) * COS(RADIANS(t.llegada_lat)) *
                POWER(SIN(RADIANS(t.llegada_lng - t.longitud) / 2), 2)
            )))::NUMERIC, 0)
    END AS llegada_distancia_m
FROM tickets t
LEFT JOIN puntos_red nap   ON nap.id   = t.nap_id
LEFT JOIN puntos_red torre ON torre.id = t.torre_id
LEFT JOIN tecnicos tec     ON tec.id   = t.tecnico_id
LEFT JOIN cuadrillas cua   ON cua.id   = t.cuadrilla_id
LEFT JOIN clientes c       ON c.id     = t.client_id;


-- =============================================================================
-- 1. Comunicaciones omnicanal
-- =============================================================================
-- Un solo historial para los cuatro canales. Partirlo por canal obligaría a
-- consultar cuatro tablas para responder "¿qué se le dijo a este abonado?", que
-- es la única pregunta que importa.
CREATE TABLE IF NOT EXISTS plantillas_mensaje (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre   VARCHAR(100) NOT NULL,
    canal    VARCHAR(15) NOT NULL CHECK (canal IN ('email', 'whatsapp', 'telegram', 'sms', 'cualquiera')),
    asunto   VARCHAR(200),
    cuerpo   TEXT NOT NULL,
    -- Marcadores que se reemplazan al enviar: {{nombre}}, {{saldo}}, {{fecha}}…
    -- Se declaran para poder mostrarle al operador qué acepta la plantilla.
    variables TEXT[],
    activa   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE plantillas_mensaje IS
    'Textos preparados para avisos frecuentes: aviso de corte, promesa por vencer, factura lista.';

CREATE TABLE IF NOT EXISTS comunicaciones (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id  UUID REFERENCES clientes(id) ON DELETE CASCADE,
    ticket_id  UUID REFERENCES tickets(id)  ON DELETE SET NULL,
    factura_id UUID REFERENCES facturas(id) ON DELETE SET NULL,

    canal     VARCHAR(15) NOT NULL CHECK (canal IN ('email', 'whatsapp', 'telegram', 'sms')),
    -- 'saliente' es lo que mandamos; 'entrante', lo que contesta el abonado.
    direccion VARCHAR(10) NOT NULL DEFAULT 'saliente' CHECK (direccion IN ('saliente', 'entrante')),
    -- A qué dirección o número fue. Se copia: el teléfono de la ficha cambia y
    -- el historial tiene que seguir diciendo a dónde se mandó.
    destino   VARCHAR(200),
    asunto    VARCHAR(300),
    cuerpo    TEXT,

    plantilla_id UUID REFERENCES plantillas_mensaje(id) ON DELETE SET NULL,
    -- TRUE cuando lo disparó el sistema (aviso de corte, factura emitida) y no
    -- una persona. Es lo que separa "se le avisó" de "alguien le escribió".
    automatico BOOLEAN NOT NULL DEFAULT FALSE,

    estado VARCHAR(12) NOT NULL DEFAULT 'pendiente'
           CHECK (estado IN ('pendiente', 'enviado', 'entregado', 'leido', 'fallido')),
    -- El id que devuelve el proveedor. Es lo que permite conciliar después el
    -- acuse de entrega o de lectura con el mensaje que lo originó.
    proveedor_id  VARCHAR(200),
    error         TEXT,

    enviado_at   TIMESTAMP WITH TIME ZONE,
    entregado_at TIMESTAMP WITH TIME ZONE,
    leido_at     TIMESTAMP WITH TIME ZONE,

    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comunicaciones_cliente ON comunicaciones (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comunicaciones_estado  ON comunicaciones (estado) WHERE estado IN ('pendiente', 'fallido');


-- =============================================================================
-- 2. Gestión documental
-- =============================================================================
-- El archivo va al bucket; acá queda de qué es, de quién y quién puede verlo.
CREATE TABLE IF NOT EXISTS documentos (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    categoria VARCHAR(30) NOT NULL DEFAULT 'otro'
              CHECK (categoria IN (
                  'cedula_frontal', 'cedula_reverso', 'contrato', 'acta_entrega',
                  'planilla_servicio', 'foto_instalacion', 'otro'
              )),
    nombre    VARCHAR(200) NOT NULL,
    ruta      TEXT NOT NULL,
    mime      VARCHAR(100),
    tamano    BIGINT,

    -- Una cédula no se le muestra al cliente en su portal ni se comparte por
    -- WhatsApp sin querer: por eso lo interno es el valor por defecto.
    visible_cliente BOOLEAN NOT NULL DEFAULT FALSE,

    -- Firma electrónica del contrato, cuando la hay.
    firmado_at     TIMESTAMP WITH TIME ZONE,
    firmante_nombre VARCHAR(150),

    notas      TEXT,
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documentos_cliente ON documentos (client_id, categoria);

-- Inventario de lo que se le entregó. Va aparte del documento porque lo que se
-- reclama en una baja son las series, no el PDF del acta.
CREATE TABLE IF NOT EXISTS equipos_cliente (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    documento_id UUID REFERENCES documentos(id) ON DELETE SET NULL,

    tipo   VARCHAR(30) NOT NULL DEFAULT 'ont'
           CHECK (tipo IN ('ont', 'router', 'antena', 'cpe', 'switch', 'otro')),
    marca  VARCHAR(60),
    modelo VARCHAR(80),
    serie  VARCHAR(100),
    mac    VARCHAR(20),

    -- Si es del ISP se reclama en la baja; si lo compró el abonado, no.
    propiedad VARCHAR(10) NOT NULL DEFAULT 'isp' CHECK (propiedad IN ('isp', 'cliente')),
    estado    VARCHAR(15) NOT NULL DEFAULT 'entregado'
              CHECK (estado IN ('entregado', 'devuelto', 'perdido', 'dañado')),

    entregado_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    devuelto_at  TIMESTAMP WITH TIME ZONE,
    notas        TEXT,
    created_by   UUID,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_equipos_cliente ON equipos_cliente (client_id);
CREATE INDEX IF NOT EXISTS idx_equipos_serie   ON equipos_cliente (serie) WHERE serie IS NOT NULL;


-- =============================================================================
-- 3. Consumo diario y sesiones
-- =============================================================================
-- Un renglón por abonado y día. Guardar cada muestra de los contadores haría
-- una tabla de millones de filas para responder una pregunta que siempre es
-- "cuánto bajó este mes".
CREATE TABLE IF NOT EXISTS consumo_diario (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    fecha     DATE NOT NULL,

    subida_bytes  BIGINT NOT NULL DEFAULT 0,
    bajada_bytes  BIGINT NOT NULL DEFAULT 0,

    -- Cómo estuvo el servicio ese día. Es lo que pinta la gráfica de colores:
    -- verde cuando estaba con promesa, azul con tráfico normal, rojo cortado.
    estado_servicio VARCHAR(15) NOT NULL DEFAULT 'activo'
                    CHECK (estado_servicio IN ('activo', 'promesa', 'cortado', 'suspendido')),

    fuente VARCHAR(15) NOT NULL DEFAULT 'mikrotik'
           CHECK (fuente IN ('mikrotik', 'radius', 'olt', 'manual')),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Un solo renglón por cliente y día: el recolector corre varias veces y tiene
-- que poder actualizar en vez de duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_consumo_dia ON consumo_diario (client_id, fecha);
CREATE INDEX IF NOT EXISTS idx_consumo_fecha ON consumo_diario (fecha);

COMMENT ON TABLE consumo_diario IS
    'Consumo agregado por día. La auditoría de un reclamo por facturación se contesta con esto.';

CREATE TABLE IF NOT EXISTS sesiones_conexion (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clientes(id) ON DELETE CASCADE,

    usuario   VARCHAR(100),
    ip        VARCHAR(45),
    mac       VARCHAR(20),
    nas       VARCHAR(100),

    inicio TIMESTAMP WITH TIME ZONE NOT NULL,
    fin    TIMESTAMP WITH TIME ZONE,

    subida_bytes BIGINT DEFAULT 0,
    bajada_bytes BIGINT DEFAULT 0,
    motivo_desconexion VARCHAR(60),

    fuente VARCHAR(15) NOT NULL DEFAULT 'mikrotik'
           CHECK (fuente IN ('mikrotik', 'radius')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sesiones_cliente ON sesiones_conexion (client_id, inicio DESC);


-- =============================================================================
-- 4. Comandos ejecutados sobre los equipos
-- =============================================================================
-- Cada ping, reinicio o cambio de clave que se dispara desde la ficha. Es lo
-- que permite responder "¿por qué se le cortó el WiFi a las 3 de la tarde?" con
-- un registro y no con una suposición.
CREATE TABLE IF NOT EXISTS comandos_ejecutados (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clientes(id) ON DELETE SET NULL,

    destino_tipo VARCHAR(15) NOT NULL DEFAULT 'mikrotik'
                 CHECK (destino_tipo IN ('mikrotik', 'olt', 'cpe', 'sistema')),
    destino_id   UUID,
    destino_nombre VARCHAR(150),

    comando    VARCHAR(40) NOT NULL,
    parametros JSONB NOT NULL DEFAULT '{}'::JSONB,
    salida     TEXT,
    exito      BOOLEAN NOT NULL DEFAULT TRUE,
    error      TEXT,
    duracion_ms INTEGER,

    created_by UUID,
    ip_origen  VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comandos_cliente ON comandos_ejecutados (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comandos_fallidos ON comandos_ejecutados (created_at DESC) WHERE NOT exito;


-- =============================================================================
-- 5. Bitácora de auditoría
-- =============================================================================
-- Quién cambió qué y cuándo. La escriben disparadores y no la aplicación: un
-- cambio hecho desde un script o desde el panel de Supabase también tiene que
-- quedar registrado, y si dependiera de la pantalla bastaría con no usarla.
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    categoria VARCHAR(30) NOT NULL,
    accion    VARCHAR(15) NOT NULL CHECK (accion IN ('crear', 'modificar', 'eliminar')),
    entidad   VARCHAR(40) NOT NULL,
    entidad_id UUID,
    client_id UUID,

    descripcion TEXT,
    -- Solo lo que cambió, no la fila entera: un diff de tres campos se lee, uno
    -- de cuarenta no lo mira nadie.
    antes   JSONB,
    despues JSONB,

    actor_id     UUID,
    actor_email  VARCHAR(150),
    ip_origen    VARCHAR(45),
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_cliente  ON audit_logs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entidad  ON audit_logs (entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_audit_fecha    ON audit_logs (created_at DESC);


-- --- Quién está haciendo el cambio ------------------------------------------
-- Con service_role o desde un script no hay usuario: queda en NULL y la
-- descripción dice "sistema". Es preferible a inventar un responsable.
-- SECURITY DEFINER las dos: `audit_logs` es de solo lectura para `authenticated`
-- —una bitácora que se puede escribir a mano no sirve de bitácora— así que el
-- disparador que la llena tiene que escribir con los permisos de su dueño. Sin
-- eso, cualquier cobro hecho desde la pantalla aborta con "new row violates
-- row-level security policy for table audit_logs" y no se guarda nada. Ver la 155.
CREATE OR REPLACE FUNCTION audit_actor()
RETURNS TABLE (id UUID, email TEXT, ip TEXT)
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY SELECT
        NULLIF(current_setting('request.jwt.claims', TRUE)::JSONB ->> 'sub', '')::UUID,
        current_setting('request.jwt.claims', TRUE)::JSONB ->> 'email',
        SPLIT_PART(
            COALESCE(current_setting('request.headers', TRUE)::JSONB ->> 'x-forwarded-for', ''),
            ',', 1
        );
EXCEPTION WHEN OTHERS THEN
    -- Fuera de PostgREST esos ajustes no existen. No es un error: es un cambio
    -- hecho por un proceso interno.
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::TEXT;
END;
$$ LANGUAGE plpgsql STABLE;


-- --- El disparador genérico --------------------------------------------------
CREATE OR REPLACE FUNCTION audit_cambios()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_antes   JSONB := '{}'::JSONB;
    v_despues JSONB := '{}'::JSONB;
    v_actor   RECORD;
    v_cliente UUID;
    v_id      UUID;
    v_accion  TEXT;
    v_campos  TEXT[] := COALESCE(TG_ARGV, ARRAY[]::TEXT[]);
    k         TEXT;
BEGIN
    SELECT * INTO v_actor FROM audit_actor() LIMIT 1;

    IF TG_OP = 'DELETE' THEN
        v_accion  := 'eliminar';
        v_antes   := to_jsonb(OLD);
        v_id      := OLD.id;
    ELSIF TG_OP = 'INSERT' THEN
        v_accion  := 'crear';
        v_despues := to_jsonb(NEW);
        v_id      := NEW.id;
    ELSE
        v_accion := 'modificar';
        v_id     := NEW.id;

        -- Solo los campos que cambiaron. Si se declararon campos en el
        -- disparador, únicamente esos: en `clientes` interesan la IP, el plan y
        -- el estado, no que se haya tocado `updated_at`.
        FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW))
        LOOP
            CONTINUE WHEN k IN ('updated_at', 'created_at');
            CONTINUE WHEN CARDINALITY(v_campos) > 0 AND NOT (k = ANY(v_campos));
            IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
                v_antes   := v_antes   || jsonb_build_object(k, to_jsonb(OLD) -> k);
                v_despues := v_despues || jsonb_build_object(k, to_jsonb(NEW) -> k);
            END IF;
        END LOOP;

        -- Nada que registrar: un UPDATE que no cambió ninguno de los campos
        -- vigilados solo ensuciaría la bitácora.
        IF v_despues = '{}'::JSONB THEN
            RETURN NULL;
        END IF;
    END IF;

    -- De qué abonado es. Las tablas que no lo tienen quedan sin cliente.
    BEGIN
        v_cliente := COALESCE(
            (to_jsonb(COALESCE(NEW, OLD)) ->> 'client_id')::UUID,
            CASE WHEN TG_TABLE_NAME = 'clientes' THEN v_id END
        );
    EXCEPTION WHEN OTHERS THEN
        v_cliente := NULL;
    END;

    INSERT INTO audit_logs (
        categoria, accion, entidad, entidad_id, client_id,
        antes, despues, actor_id, actor_email, ip_origen
    )
    VALUES (
        TG_TABLE_NAME, v_accion, TG_TABLE_NAME, v_id, v_cliente,
        NULLIF(v_antes, '{}'::JSONB), NULLIF(v_despues, '{}'::JSONB),
        v_actor.id, v_actor.email, NULLIF(v_actor.ip, '')
    );

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;


-- --- Qué se vigila -----------------------------------------------------------
-- Lo que tiene consecuencias para el abonado o para la caja. Las tablas de
-- lectura —consumo, sesiones— quedan afuera: se llenan solas y auditarlas
-- multiplicaría la bitácora sin agregar nada.
DROP TRIGGER IF EXISTS trg_audit_facturas ON facturas;
CREATE TRIGGER trg_audit_facturas
    AFTER INSERT OR UPDATE OR DELETE ON facturas
    FOR EACH ROW EXECUTE FUNCTION audit_cambios();

DROP TRIGGER IF EXISTS trg_audit_pagos ON pagos;
CREATE TRIGGER trg_audit_pagos
    AFTER INSERT OR UPDATE OR DELETE ON pagos
    FOR EACH ROW EXECUTE FUNCTION audit_cambios();

DROP TRIGGER IF EXISTS trg_audit_promesas ON promesas_pago;
CREATE TRIGGER trg_audit_promesas
    AFTER INSERT OR UPDATE OR DELETE ON promesas_pago
    FOR EACH ROW EXECUTE FUNCTION audit_cambios();

-- En clientes solo lo que importa: la IP, el plan, el estado, el precio y la
-- configuración de cobro. Auditar la fila entera registraría cada visita que
-- toca un teléfono.
DROP TRIGGER IF EXISTS trg_audit_clientes ON clientes;
CREATE TRIGGER trg_audit_clientes
    AFTER UPDATE ON clientes
    FOR EACH ROW EXECUTE FUNCTION audit_cambios(
        'ip', 'plan_id', 'estado', 'precio_mensual', 'usuario_ppp', 'clave_ppp',
        'nap_id', 'puerto_nap', 'conectado_a_id', 'tipo_conexion',
        'modalidad_pago', 'dia_facturacion', 'aplicar_corte', 'factura_electronica',
        'descuento_tipo', 'descuento_porcentaje', 'promo_porcentaje', 'promo_meses'
    );

DROP TRIGGER IF EXISTS trg_audit_comunicaciones ON comunicaciones;
CREATE TRIGGER trg_audit_comunicaciones
    AFTER INSERT ON comunicaciones
    FOR EACH ROW EXECUTE FUNCTION audit_cambios();

DROP TRIGGER IF EXISTS trg_audit_comandos ON comandos_ejecutados;
CREATE TRIGGER trg_audit_comandos
    AFTER INSERT ON comandos_ejecutados
    FOR EACH ROW EXECUTE FUNCTION audit_cambios();


-- =============================================================================
-- 6. Vistas de lectura
-- =============================================================================
CREATE OR REPLACE VIEW v_audit_logs WITH (security_invoker = true) AS
SELECT
    a.*,
    c.nombre AS cliente,
    COALESCE(a.actor_email, 'sistema') AS actor,
    -- Los campos que cambiaron, listos para mostrar sin recorrer el JSON.
    ARRAY(SELECT jsonb_object_keys(COALESCE(a.despues, a.antes, '{}'::JSONB))) AS campos
FROM audit_logs a
LEFT JOIN clientes c ON c.id = a.client_id;

CREATE OR REPLACE VIEW v_comunicaciones WITH (security_invoker = true) AS
SELECT
    m.*,
    c.nombre AS cliente,
    p.nombre AS plantilla
FROM comunicaciones m
LEFT JOIN clientes c            ON c.id = m.client_id
LEFT JOIN plantillas_mensaje p  ON p.id = m.plantilla_id;

-- Consumo por mes, que es como se mira: la gráfica pide el día, el resumen y la
-- auditoría piden el total.
CREATE OR REPLACE VIEW v_consumo_mensual WITH (security_invoker = true) AS
SELECT
    client_id,
    DATE_TRUNC('month', fecha)::DATE AS mes,
    SUM(subida_bytes)  AS subida_bytes,
    SUM(bajada_bytes)  AS bajada_bytes,
    SUM(subida_bytes + bajada_bytes) AS total_bytes,
    COUNT(*) FILTER (WHERE estado_servicio = 'cortado')   AS dias_cortado,
    COUNT(*) FILTER (WHERE estado_servicio = 'promesa')   AS dias_con_promesa,
    COUNT(*) AS dias_con_registro
FROM consumo_diario
GROUP BY client_id, DATE_TRUNC('month', fecha);


-- =============================================================================
-- 7. Permisos
-- =============================================================================
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'plantillas_mensaje','comunicaciones','documentos','equipos_cliente',
        'consumo_diario','sesiones_conexion','comandos_ejecutados','audit_logs'
    ]
    LOOP
        EXECUTE FORMAT('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE FORMAT('DROP POLICY IF EXISTS %I ON %I', 'auth_all_' || t, t);
        EXECUTE FORMAT(
            'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE)',
            'auth_all_' || t, t
        );
    END LOOP;
END $$;

-- La bitácora se lee, no se corrige: un registro de auditoría que se puede
-- editar no sirve como registro de auditoría.
--
-- Las dos líneas de DROP son a propósito: la primera borra la política vieja que
-- esta migración reemplaza, y la segunda borra la nueva por si el archivo ya se
-- corrió antes. Sin la segunda, reejecutarlo falla con "policy already exists".
DROP POLICY IF EXISTS auth_all_audit_logs ON audit_logs;
DROP POLICY IF EXISTS audit_logs_lectura ON audit_logs;
CREATE POLICY audit_logs_lectura ON audit_logs
    FOR SELECT TO authenticated USING (TRUE);


-- =============================================================================
-- 8. Plantillas de arranque
-- =============================================================================
INSERT INTO plantillas_mensaje (nombre, canal, asunto, cuerpo, variables)
SELECT * FROM (VALUES
    ('Aviso de corte', 'cualquiera', 'Su servicio será suspendido',
     'Estimado/a {{nombre}}: su servicio de internet registra un saldo pendiente de {{saldo}}. Para evitar la suspensión, puede cancelar hasta el {{fecha}}. Gracias.',
     ARRAY['nombre','saldo','fecha']),
    ('Promesa por vencer', 'cualquiera', 'Su compromiso de pago vence mañana',
     'Estimado/a {{nombre}}: le recordamos que su compromiso de pago por {{saldo}} vence el {{fecha}}. Si ya canceló, haga caso omiso de este mensaje.',
     ARRAY['nombre','saldo','fecha']),
    ('Factura disponible', 'email', 'Su factura de {{periodo}} está lista',
     'Estimado/a {{nombre}}: adjuntamos su factura correspondiente a {{periodo}} por {{total}}. Gracias por su preferencia.',
     ARRAY['nombre','periodo','total']),
    ('Técnico en camino', 'whatsapp', NULL,
     'Hola {{nombre}}, le informamos que nuestro técnico {{tecnico}} está en camino a su domicilio por el reporte N° {{ticket}}.',
     ARRAY['nombre','tecnico','ticket']),
    ('Servicio restablecido', 'cualquiera', 'Servicio restablecido',
     'Estimado/a {{nombre}}: su servicio fue restablecido. Si continúa con inconvenientes, escríbanos.',
     ARRAY['nombre'])
) AS v(nombre, canal, asunto, cuerpo, variables)
WHERE NOT EXISTS (SELECT 1 FROM plantillas_mensaje);
