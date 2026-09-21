-- =============================================================================
-- Migración 55 — La ficha de configuración manual, para las ONTs sin TR069
-- =============================================================================
-- El aprovisionamiento automático depende de que el ACS pueda hablarle a la
-- ONT. Cuando el modelo no soporta TR069 —y este ISP usa varios que no— esa
-- cadena se corta y el técnico tiene que entrar al equipo por su interfaz web y
-- escribir todo a mano: usuario y clave PPPoE, VLAN, nombre y clave del WiFi.
--
-- Hoy esos datos existen desperdigados —la clave PPPoE en la instalación, la
-- VLAN en el service-port, el WiFi en ningún lado— y el técnico los va juntando
-- de tres pantallas arriba de una escalera. Es donde aparece el error de tipeo
-- que después nadie relaciona con el alta.
--
-- Se guardan juntos, en la ONU, para poder mostrarlos como una sola ficha en el
-- momento de autorizarla y volver a verlos después cuando el abonado llame
-- preguntando su clave de WiFi.
-- =============================================================================

ALTER TABLE tipos_ont
    -- Si el modelo acepta configuración remota. NULL = no se sabe todavía, que
    -- no es lo mismo que "no soporta": con NULL se intenta igual y se aprende
    -- del resultado; con FALSE se va derecho a la ficha manual y no se hace
    -- perder tiempo al técnico esperando un intento que va a fallar.
    ADD COLUMN IF NOT EXISTS soporta_tr069 BOOLEAN;

COMMENT ON COLUMN tipos_ont.soporta_tr069 IS
    'Si el modelo acepta configuración remota por TR069. NULL = todavía no se sabe: se intenta y se aprende del resultado.';

ALTER TABLE onus
    -- Lo que el técnico tiene que escribir en la ONT cuando no hay TR069.
    ADD COLUMN IF NOT EXISTS ssid           VARCHAR(64),
    ADD COLUMN IF NOT EXISTS clave_wifi     VARCHAR(128),

    -- Cómo quedó configurada: por el sistema o a mano. Sirve para saber a quién
    -- creerle cuando la ONT tiene algo distinto de lo que dice la base.
    ADD COLUMN IF NOT EXISTS configurada_por VARCHAR(15)
        CHECK (configurada_por IS NULL OR configurada_por IN ('tr069', 'manual', 'mixta')),

    -- Cuándo el técnico confirmó que terminó de cargarla a mano. Sin esto, una
    -- ONT que quedó a medias se ve igual que una terminada.
    ADD COLUMN IF NOT EXISTS configurada_at TIMESTAMPTZ;

COMMENT ON COLUMN onus.clave_wifi IS
    'La clave del WiFi que se le configuró al equipo. Se guarda para poder dársela al abonado cuando llame, que es la consulta más frecuente del soporte.';

COMMENT ON COLUMN onus.configurada_por IS
    'tr069 = la configuró el sistema · manual = la cargó el técnico en el equipo · mixta = parte y parte.';
