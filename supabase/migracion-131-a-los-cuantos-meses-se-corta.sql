-- =============================================================================
-- Migración 131 — A los cuántos meses se corta
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Por qué un sí/no no alcanzaba ──
--
-- `aplicar_corte` era un interruptor: se corta o no se corta. Eso deja afuera
-- los dos casos que un ISP tiene siempre:
--
--   EL QUE PAGA CADA DOS O TRES MESES. Con el interruptor encendido se lo corta
--   al primer mes, aunque su acuerdo sea otro. Con el interruptor apagado no se
--   lo corta nunca, ni aunque deje de pagar del todo. Ninguna de las dos es la
--   realidad de ese abonado.
--
--   EL QUE TIENE EL SERVICIO GRATIS. Ese sí es "nunca", y ahora se puede decir
--   sin que se confunda con "todavía no decidimos".
--
-- ── Por qué se conserva la columna vieja ──
--
-- Porque la leen tres vistas, el importador de padrón y la plantilla de
-- migración. Sacarla obligaría a tocar todo eso en la misma migración, y
-- cualquier lugar que se olvide dejaría de funcionar sin dar error. Se mantiene
-- sincronizada por disparador: `aplicar_corte` pasa a ser la respuesta a "¿se
-- corta alguna vez?", que es lo que esos lugares preguntan de verdad.
-- =============================================================================

ALTER TABLE clientes
    /**
     * Meses de atraso a partir de los cuales se corta.
     *
     * 0 es "nunca": el del servicio gratis, el institucional, el enlace crítico.
     * Se usa 0 y no NULL a propósito — NULL se lee como "no lo decidí", y esto
     * es una decisión que alguien tomó.
     */
    ADD COLUMN IF NOT EXISTS cortar_tras_meses INT NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clientes_cortar_tras_meses_check') THEN
        ALTER TABLE clientes ADD CONSTRAINT clientes_cortar_tras_meses_check
            CHECK (cortar_tras_meses BETWEEN 0 AND 12);
    END IF;
END $$;

COMMENT ON COLUMN clientes.cortar_tras_meses IS
    'Meses de atraso a partir de los cuales se le corta. 0 = nunca (servicio gratis, institucional). Se mantiene coherente con aplicar_corte por disparador.';

-- Lo que ya estaba decidido con el interruptor, dicho en meses. Los que tenían
-- el corte encendido se cortan al primer mes, que es lo que hacían.
UPDATE clientes SET cortar_tras_meses = CASE WHEN aplicar_corte THEN 1 ELSE 0 END
 WHERE cortar_tras_meses = 1 AND NOT aplicar_corte;


-- =============================================================================
-- Que las dos columnas no puedan contradecirse
-- =============================================================================
/**
 * Mantiene `aplicar_corte` y `cortar_tras_meses` diciendo lo mismo.
 *
 * Se sincroniza en las DOS direcciones porque hay código que escribe cada una:
 * la pantalla nueva escribe los meses, y el importador de padrón —que sigue
 * mirando la columna vieja— escribe el booleano.
 *
 * Sin esto, importar un abonado con `aplicar_corte = no` lo dejaría con
 * `cortar_tras_meses = 1`, y se lo cortaría al mes pese a lo que decía el
 * archivo. Es la clase de contradicción que no da error y se descubre cuando
 * alguien se queda sin internet.
 */
CREATE OR REPLACE FUNCTION sincronizar_corte_del_abonado()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Al crear, manda lo que se haya escrito explícitamente. Si vino el
        -- booleano en falso y los meses en su valor por defecto, gana el
        -- booleano: quien lo mandó estaba diciendo algo.
        IF NOT NEW.aplicar_corte AND NEW.cortar_tras_meses = 1 THEN
            NEW.cortar_tras_meses := 0;
        ELSE
            NEW.aplicar_corte := (NEW.cortar_tras_meses > 0);
        END IF;
        RETURN NEW;
    END IF;

    -- Al actualizar, manda la columna que cambió.
    IF NEW.cortar_tras_meses IS DISTINCT FROM OLD.cortar_tras_meses THEN
        NEW.aplicar_corte := (NEW.cortar_tras_meses > 0);
    ELSIF NEW.aplicar_corte IS DISTINCT FROM OLD.aplicar_corte THEN
        NEW.cortar_tras_meses := CASE
            -- Al reactivar el corte se vuelve a un mes, que es el valor con el
            -- que ese interruptor siempre trabajó.
            WHEN NEW.aplicar_corte THEN GREATEST(OLD.cortar_tras_meses, 1)
            ELSE 0
        END;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sincronizar_corte ON clientes;
CREATE TRIGGER trg_sincronizar_corte
    BEFORE INSERT OR UPDATE ON clientes
    FOR EACH ROW EXECUTE FUNCTION sincronizar_corte_del_abonado();


-- =============================================================================
-- A quién le tocaría el corte hoy
-- =============================================================================
/**
 * Los abonados que pasaron su propio umbral de meses.
 *
 * ── Por qué esto existe si el corte por mora todavía no se automatiza ──
 *
 * Porque la configuración sin una lista que la muestre es una promesa: alguien
 * elige "4 meses vencidos" y no tiene forma de saber si eso hace algo. Con la
 * lista, la decisión se puede revisar hoy —y el día que se automatice el corte,
 * esta es la consulta que va a leer.
 *
 * Hoy el único corte automático es el de las promesas de pago incumplidas.
 */
DO $guarda$
BEGIN
    -- La 132 le agrega `vence_desde` y las exclusiones que hacen falta para
    -- cortar de verdad. Reejecutar esto la devolvería a esta versión —que solo
    -- servía para revisar la configuración— y abortaría con "cannot drop
    -- columns from view".
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_a_cortar_por_mora'
           AND column_name = 'vence_desde'
    ) THEN
        RAISE NOTICE 'v_clientes_a_cortar_por_mora ya tiene una versión posterior a la 131: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
CREATE OR REPLACE VIEW v_clientes_a_cortar_por_mora AS
SELECT
    c.id            AS cliente_id,
    c.codigo,
    c.nombre,
    c.estado,
    c.ip,
    c.router_id,
    c.cortar_tras_meses,
    meses_sin_pago(c.id) AS meses_sin_pago,
    COALESCE(s.saldo, 0) AS saldo,
    s.ultimo_pago
FROM clientes c
LEFT JOIN v_saldo_clientes s ON s.client_id = c.id
WHERE c.estado = 'activo'
  -- Cero es nunca: el servicio gratis y el institucional no entran acá.
  AND c.cortar_tras_meses > 0
  AND COALESCE(s.saldo, 0) > 0
  AND meses_sin_pago(c.id) >= c.cortar_tras_meses
    $vista$;
END $guarda$;

COMMENT ON VIEW v_clientes_a_cortar_por_mora IS
    'Abonados activos que pasaron su propio umbral de meses de atraso. Es la lista que leería el corte por mora cuando se automatice.';


-- =============================================================================
-- Y la ficha, que no estaba mostrando nada de esto
-- =============================================================================
/**
 * ── El error que esto corrige ──
 *
 * La pantalla del abonado lee `v_clientes_ficha`, y las columnas de avisos que
 * agregaron la 129 y la 130 nunca se sumaron a esa vista. El efecto es de los
 * peores que hay: guardar FUNCIONABA —los valores quedaban bien en `clientes`—
 * pero al reabrir la ficha, la pantalla mostraba los valores de fábrica.
 *
 * O sea que alguien configuraba "solo WhatsApp", volvía a entrar, veía "todos
 * los canales", y lo corregía otra vez. Nada falla, nada avisa, y la pantalla
 * contradice a la base sin que ninguna de las dos esté rota.
 *
 * Las columnas van AL FINAL y la lista es explícita —no `c.*`— porque `clientes`
 * tiene `portal_clave_hash` y un `SELECT *` lo publicaría en la ficha.
 */
DO $guarda$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'v_clientes_ficha'
           AND column_name = 'cortar_tras_meses'
    ) THEN
        RAISE NOTICE 'v_clientes_ficha ya expone las columnas de avisos: no se toca.';
        RETURN;
    END IF;

    EXECUTE $vista$
        CREATE OR REPLACE VIEW v_clientes_ficha WITH (security_invoker = true) AS
        SELECT
            c.id, c.nombre, c.router_id, c.onu_id, c.plan_id, c.ip, c.mac_address,
            c.usuario_ppp, c.estado, c.origen, c.velocidad_cruda, c.comentario,
            c.created_at, c.updated_at, c.tipo_identificacion, c.identificacion,
            c.email, c.telefono, c.direccion, c.precio_mensual, c.dia_facturacion,
            c.telefono_movil, c.codigo_pago, c.clave_ppp, c.latitud, c.longitud,
            c.notas, c.nap_id, c.puerto_nap, c.conectado_a_id, c.ip_administracion,
            c.tipo_antena, c.tipo_conexion, c.tipo_ip, c.red_ipv4, c.ipv6,
            c.ipv6_duid, c.rutas, c.descripcion_servicio, c.excluir_firewall,
            c.fecha_instalacion, c.factura_electronica, c.modalidad_pago,
            c.dia_generar_factura, c.tipo_impuesto, c.dias_gracia, c.aplicar_corte,
            c.descuento_tipo, c.descuento_porcentaje, c.descuento_documento,
            c.promo_porcentaje, c.promo_meses, c.promo_desde, c.telegram_chat_id,
            c.canal_preferido,
            p.nombre  AS plan,
            p.precio  AS plan_precio,
            p.bajada_kbps,
            p.subida_kbps,
            p.categoria      AS plan_categoria,
            p.tipo_impuesto  AS plan_tipo_impuesto,
            p.iva_porcentaje AS plan_iva_porcentaje,
            p.perfil_ppp     AS plan_perfil_ppp,
            r.nombre  AS router,
            o.sn      AS onu_serial,
            o.estado  AS onu_estado,
            o.rx_power_dbm,
            nap.nombre AS nap,
            ap.nombre  AS conectado_a,
            COALESCE(s.saldo, 0)               AS saldo,
            COALESCE(s.facturas_pendientes, 0) AS facturas_pendientes,
            s.ultimo_pago,
            ct.id     AS contrato_id,
            ct.numero AS contrato_numero,
            ct.precio_mensual AS contrato_precio,
            c.codigo, c.zona, c.estado_desde, c.portal_clave, c.numero_orden,
            c.pasarela,
            c.baja_en,
            c.ultimo_pago_externo,
            -- Lo de la 129, la 130 y esta, que la ficha necesita para poder
            -- mostrar lo que hay guardado.
            c.cortar_tras_meses,
            c.avisos_activos,
            c.avisos_canales,
            c.avisos_pantalla,
            c.aviso_dias_1,
            c.aviso_dias_2,
            c.aviso_dias_3,
            c.aviso_factura_canales,
            c.aviso_pantalla_dias
        FROM clientes c
        LEFT JOIN planes_velocidad p   ON p.id = c.plan_id
        LEFT JOIN routers_mikrotik r   ON r.id = c.router_id
        LEFT JOIN onus o               ON o.id = c.onu_id
        LEFT JOIN puntos_red nap       ON nap.id = c.nap_id
        LEFT JOIN puntos_red ap        ON ap.id = c.conectado_a_id
        LEFT JOIN v_saldo_clientes s   ON s.client_id = c.id
        LEFT JOIN contratos ct         ON ct.client_id = c.id AND ct.estado = 'vigente'
    $vista$;
END $guarda$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El del servicio gratis:
--   UPDATE clientes SET cortar_tras_meses = 0 WHERE codigo = 7;
--
--   -- El que paga cada tres meses:
--   UPDATE clientes SET cortar_tras_meses = 3 WHERE codigo = 12;
--
--   -- Y a quién le tocaría el corte hoy:
--   SELECT nombre, meses_sin_pago, cortar_tras_meses, saldo
--     FROM v_clientes_a_cortar_por_mora ORDER BY meses_sin_pago DESC;
