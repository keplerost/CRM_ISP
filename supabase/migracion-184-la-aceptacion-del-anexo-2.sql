-- =============================================================================
-- Migración 184 — La aceptación del anexo 2 no se podía responder
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── El agujero ──
--
-- El ANEXO 2 (ACEPTACIÓN DE USO DE DATOS PERSONALES) imprime un par de casillas
-- SI/NO que salen de `respuestas.datos_personales`, y eso se arma así:
--
--     datos_personales: cliente.acepta_datos_personales ?? null,   ← ficha
--     datos_personales: null,                                      ← orden
--
-- La columna `acepta_datos_personales` NUNCA SE CREÓ. En la 139 se agregó
-- `acepta_arbitraje` y esta quedó afuera. Como se lee con `??`, leer una columna
-- inexistente da `undefined`, `undefined ?? null` da `null`, y el anexo sale con
-- las dos casillas vacías. Sin error, sin aviso, siempre.
--
-- Y desde la orden ni siquiera se intentaba: el valor estaba escrito `null` a
-- mano.
--
-- Resultado: el anexo 2 se firmaba siempre en blanco y había que marcarlo a
-- lapicera. Que es lo que este formulario existe para evitar.
--
-- ── Por qué se guarda la respuesta y no se asume que sí ──
--
-- Porque es una autorización para usar los datos del abonado con fines
-- comerciales Y para consultar su información en los burós de crédito. Traerla
-- marcada en SI por defecto sería registrar un consentimiento que nadie dio, y
-- la propia norma dice que se puede revocar "sin que el prestador pueda
-- condicionar o establecer requisitos para tal fin".
--
-- Por eso NULL —"todavía no se le preguntó"— es un estado válido y distinto de
-- false, y por eso el anexo sigue imprimiendo las dos casillas vacías mientras
-- nadie conteste.
-- =============================================================================


-- =============================================================================
-- 1. La respuesta, en las dos tablas
-- =============================================================================
-- Las mismas columnas en `clientes` e `instalaciones`, como el resto: el
-- vendedor lo pregunta en la puerta de la casa y al dar de alta viaja solo a la
-- ficha.
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS acepta_datos_personales BOOLEAN;

ALTER TABLE instalaciones
    ADD COLUMN IF NOT EXISTS acepta_datos_personales BOOLEAN;

COMMENT ON COLUMN clientes.acepta_datos_personales IS
    'Anexo 2: si autoriza el uso comercial de sus datos y la consulta a buros de credito. NULL = todavia no se le pregunto, y el anexo sale con las dos casillas vacias. No se asume SI: es un consentimiento, no un tramite.';

COMMENT ON COLUMN instalaciones.acepta_datos_personales IS
    'Anexo 2 respondido en la venta. Viaja a la ficha al dar de alta.';


-- =============================================================================
-- 2. Que viaje al cerrar el alta
-- =============================================================================
-- `finalizar_alta_instalacion` copia campo por campo, así que una columna nueva
-- no llega sola a la ficha. Sin esto, el vendedor pregunta, el abonado firma el
-- anexo, y al dar de alta la respuesta se pierde: la ficha queda en NULL y una
-- reimpresión del contrato sale en blanco contradiciendo el papel firmado.
--
-- Se agrega con un UPDATE posterior en vez de tocar la función entera: la 183 la
-- acaba de reescribir y volver a hacerlo arriesga perder el SECURITY DEFINER,
-- que es la piedra que ya se pisó una vez y dejó el alta rota para todos los
-- técnicos.
CREATE OR REPLACE FUNCTION alta_copia_aceptacion_anexo2()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Solo al momento de cerrarse, y solo si la orden trae respuesta. El
    -- COALESCE protege lo que ya tenga la ficha: un abonado viejo que se muda no
    -- pierde el consentimiento que dio en su día porque la orden de traslado
    -- venga sin responder.
    IF NEW.estado = 'hecha'
       AND NEW.client_id IS NOT NULL
       AND NEW.acepta_datos_personales IS NOT NULL THEN
        UPDATE clientes
           SET acepta_datos_personales =
                   COALESCE(acepta_datos_personales, NEW.acepta_datos_personales)
         WHERE id = NEW.client_id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_alta_copia_anexo2 ON instalaciones;
CREATE TRIGGER trg_alta_copia_anexo2
    AFTER UPDATE ON instalaciones
    FOR EACH ROW
    WHEN (NEW.estado = 'hecha')
    EXECUTE FUNCTION alta_copia_aceptacion_anexo2();

COMMENT ON FUNCTION alta_copia_aceptacion_anexo2 IS
    'Lleva a la ficha la respuesta del anexo 2 que se dio en la venta. No pisa la que el abonado ya tenia.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, acepta_datos_personales FROM clientes;
--
--   -- Los que firmaron el anexo sin que nadie les preguntara (todos, hasta hoy):
--   SELECT COUNT(*) FROM clientes WHERE acepta_datos_personales IS NULL;
