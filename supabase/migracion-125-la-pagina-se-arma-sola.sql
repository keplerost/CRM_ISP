-- =============================================================================
-- Migración 125 — La página de corte se arma sola
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué cambia respecto de la 124 ──
--
-- La 124 dejó las cuentas apagadas por defecto, con el argumento de que publicar
-- un número de cuenta es una decisión. El argumento no era malo, pero el efecto
-- sí: un ISP que instala este sistema carga sus cuentas en Cobranza, arma su
-- ficha de empresa, y la página del cortado le sigue saliendo vacía sin que nada
-- le diga por qué. Termina siendo una pantalla más que hay que descubrir.
--
-- Una cuenta de banco existe PARA que le depositen. Que aparezca en la página
-- donde se le pide a alguien que deposite es lo esperable, no una sorpresa. La
-- que hay que proteger es la caja de la oficina, y esa nunca se publica —
-- "depositá en Caja Oficina" no significa nada para alguien sentado en su casa.
--
-- Así que se invierte: las de banco y billetera se publican salvo que alguien
-- diga que no.
-- =============================================================================

ALTER TABLE cuentas_pago
    ALTER COLUMN mostrar_en_corte SET DEFAULT TRUE;

COMMENT ON COLUMN cuentas_pago.mostrar_en_corte IS
    'Si esta cuenta aparece en la página que ve el abonado cortado. Encendida por defecto para bancos y billeteras: una cuenta existe para que le depositen. Las de efectivo nunca se publican.';


-- =============================================================================
-- Las que ya estaban cargadas
-- =============================================================================
/**
 * ── Por qué esto necesita una bandera y no se hace y listo ──
 *
 * Porque re-ejecutar la migración volvería a encender una cuenta que alguien
 * apagó a propósito, y esa persona no se enteraría: la cuenta reaparecería
 * publicada en una página que ella no mira. Una migración idempotente no puede
 * significar "vuelve a imponer mi criterio cada vez que corre".
 *
 * Con la bandera, el relleno pasa UNA vez —la primera— y a partir de ahí lo que
 * mande es lo que haya decidido el ISP.
 */
ALTER TABLE config_corte
    ADD COLUMN IF NOT EXISTS cuentas_inicializadas BOOLEAN NOT NULL DEFAULT FALSE;

DO $inicial$
BEGIN
    IF EXISTS (SELECT 1 FROM config_corte WHERE id = 1 AND cuentas_inicializadas) THEN
        RAISE NOTICE 'Las cuentas ya se inicializaron una vez: no se tocan.';
        RETURN;
    END IF;

    UPDATE cuentas_pago
       SET mostrar_en_corte = TRUE
     WHERE tipo IN ('banco', 'billetera');

    -- La caja nunca. No es una preferencia: es que no se puede depositar ahí
    -- desde una casa.
    UPDATE cuentas_pago
       SET mostrar_en_corte = FALSE
     WHERE tipo = 'efectivo';

    UPDATE config_corte SET cuentas_inicializadas = TRUE WHERE id = 1;
END $inicial$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, tipo, mostrar_en_corte FROM cuentas_pago ORDER BY tipo;
--
--   -- Y que volver a correr esta migración no pise una decisión:
--   UPDATE cuentas_pago SET mostrar_en_corte = FALSE WHERE nombre = 'Pichincha Ahorros';
--   -- (correr de nuevo el archivo)
--   SELECT nombre, mostrar_en_corte FROM cuentas_pago WHERE nombre = 'Pichincha Ahorros';
--   -- tiene que seguir en FALSE
