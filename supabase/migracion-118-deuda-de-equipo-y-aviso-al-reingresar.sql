-- =============================================================================
-- Migración 118 — La deuda del equipo que no volvió, y el aviso cuando vuelven
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El problema ──
--
-- Alguien se va sin devolver la ONT, se le da de baja, y seis meses después
-- vuelve a pedir servicio. Nadie se entera: la ficha vieja quedó cerrada, el
-- vendedor carga un prospecto nuevo con la misma cédula, y se le instala otro
-- equipo a quien todavía tiene el anterior.
--
-- Eso pasa. Es una de las formas más caras de perder aparatos.
--
-- ── Qué hace esto ──
--
--   1. Anota el valor del equipo perdido en la ficha del abonado, aparte de la
--      deuda de servicio. No es una factura ni va a cobranza: es un hecho.
--   2. Cuando esa cédula reaparece en un prospecto, la pantalla de ventas lo
--      dice.
--
-- ── Y qué NO hace: bloquear ──
--
-- Por decisión explícita. Un bloqueo duro lo saltea alguien creando una ficha
-- con otro nombre, y ahí se pierde el rastro por completo. El vendedor decide;
-- lo único que cambia es que decide informado.
-- =============================================================================


-- =============================================================================
-- 1. La deuda, en la ficha
-- =============================================================================
ALTER TABLE clientes
    ADD COLUMN IF NOT EXISTS deuda_equipo NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (deuda_equipo >= 0);

COMMENT ON COLUMN clientes.deuda_equipo IS
    'Valor de los equipos que se le quedaron y no devolvió. Separado de la deuda de servicio a propósito: no se factura ni va a cobranza —no es una venta— pero tiene que estar a la vista el día que vuelva a pedir servicio.';

CREATE INDEX IF NOT EXISTS idx_clientes_deuda_equipo
    ON clientes (identificacion) WHERE deuda_equipo > 0;


-- =============================================================================
-- 2. Que el cierre del retiro la escriba
-- =============================================================================
-- Igual que la 115 salvo el bloque marcado. Se repite entera porque una función
-- se reemplaza completa: no hay forma de cambiarle unas líneas.
CREATE OR REPLACE FUNCTION cerrar_retiro_equipo(
    p_retiro      UUID,
    p_recuperado  BOOLEAN,
    p_motivo      TEXT DEFAULT NULL,
    p_observacion TEXT DEFAULT NULL,
    p_serie       TEXT DEFAULT NULL,
    p_almacen     UUID DEFAULT NULL,
    p_firma       TEXT DEFAULT NULL,
    p_firmante    TEXT DEFAULT NULL
)
RETURNS retiros_equipo
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fila    retiros_equipo%ROWTYPE;
    v_equipo  equipos%ROWTYPE;
    v_almacen UUID;
    v_legajo  UUID := mi_legajo_id();
    v_cat     retiro_categorias%ROWTYPE;
BEGIN
    SELECT * INTO v_fila FROM retiros_equipo WHERE id = p_retiro;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe esa orden de retiro';
    END IF;

    IF NOT puede_gestionar_retiros()
       AND v_fila.tecnico_id IS DISTINCT FROM mi_tecnico_id()
       AND v_fila.responsable_id IS DISTINCT FROM v_legajo THEN
        RAISE EXCEPTION 'Esa orden de retiro no es tuya';
    END IF;

    IF v_fila.estado NOT IN ('pendiente', 'asignado') THEN
        RAISE EXCEPTION 'Esa orden ya está cerrada (%)', v_fila.estado;
    END IF;

    IF p_recuperado AND COALESCE(BTRIM(p_firma), '') = '' THEN
        RAISE EXCEPTION 'Falta la firma de quien entrega el equipo';
    END IF;

    IF NOT p_recuperado THEN
        SELECT * INTO v_cat FROM retiro_categorias
         WHERE clave = COALESCE(NULLIF(BTRIM(p_motivo), ''), '—') AND activa;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Hace falta elegir por qué no se recuperó (categoría válida)';
        END IF;
    END IF;

    IF COALESCE(BTRIM(p_serie), '') <> '' THEN
        SELECT * INTO v_equipo FROM equipos
         WHERE UPPER(BTRIM(serie)) = UPPER(BTRIM(p_serie)) LIMIT 1;
    ELSIF v_fila.equipo_id IS NOT NULL THEN
        SELECT * INTO v_equipo FROM equipos WHERE id = v_fila.equipo_id;
    END IF;

    IF p_recuperado AND v_equipo.id IS NOT NULL THEN
        v_almacen := COALESCE(
            p_almacen,
            (SELECT a.id FROM almacenes a WHERE a.tecnico_id = v_fila.tecnico_id LIMIT 1),
            (SELECT a.id FROM almacenes a WHERE a.tipo = 'bodega' ORDER BY a.creado_en LIMIT 1)
        );

        UPDATE equipos
           SET estado = 'en_stock', cliente_id = NULL, instalacion_id = NULL, almacen_id = v_almacen
         WHERE id = v_equipo.id;

        INSERT INTO movimientos_inventario (
            tipo, articulo_id, equipo_id, cantidad, almacen_destino_id,
            costo_unit, motivo, usuario_id, usuario_nombre
        )
        SELECT 'devolucion', v_equipo.articulo_id, v_equipo.id, 1, v_almacen,
               NULLIF(v_fila.valor, 0),
               FORMAT('Retiro de equipo por falta de renovación (orden %s)', p_retiro),
               v_legajo,
               (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                  FROM usuarios_sistema u WHERE u.id = v_legajo);

    ELSIF NOT p_recuperado AND v_equipo.id IS NOT NULL THEN
        IF v_cat.clave = 'error_de_registro' THEN
            UPDATE equipos SET cliente_id = NULL, instalacion_id = NULL WHERE id = v_equipo.id;
        ELSE
            UPDATE equipos
               SET estado = 'baja', cliente_id = NULL, instalacion_id = NULL, almacen_id = NULL
             WHERE id = v_equipo.id;
        END IF;
    END IF;

    UPDATE retiros_equipo
       SET estado = CASE WHEN p_recuperado THEN 'recuperado' ELSE 'no_recuperado' END,
           categoria_cierre = CASE WHEN p_recuperado THEN NULL ELSE v_cat.clave END,
           motivo = COALESCE(NULLIF(BTRIM(p_motivo), ''), motivo),
           observaciones = COALESCE(NULLIF(BTRIM(p_observacion), ''), observaciones),
           firma_b64  = COALESCE(NULLIF(BTRIM(p_firma), ''), firma_b64),
           firmante   = COALESCE(NULLIF(BTRIM(p_firmante), ''), firmante),
           firmado_en = CASE WHEN COALESCE(BTRIM(p_firma), '') <> '' THEN NOW() ELSE firmado_en END,
           cerrado_por = v_legajo,
           cerrado_en = NOW()
     WHERE id = p_retiro
    RETURNING * INTO v_fila;

    /*
     * ── Lo que agrega esta migración ──
     *
     * El valor del equipo queda anotado en la ficha, y solo cuando la categoría
     * dice que es una pérdida de verdad: un aparato roto que volvió o un error
     * de registro no le deben nada a nadie.
     *
     * Se SUMA en vez de asignarse: un abonado puede haber perdido dos equipos
     * en dos episodios distintos, y el segundo no borra al primero.
     */
    IF NOT p_recuperado AND v_cat.es_perdida AND COALESCE(v_fila.valor, 0) > 0 THEN
        UPDATE clientes
           SET deuda_equipo = deuda_equipo + v_fila.valor,
               updated_at = NOW()
         WHERE id = v_fila.cliente_id;
    END IF;

    IF NOT p_recuperado AND v_cat.cierra_ficha THEN
        PERFORM avisar_ficha_por_cerrar(v_fila.cliente_id);
    END IF;

    RETURN v_fila;
END $$;


/**
 * Saldar la deuda del equipo.
 *
 * Pasa más de lo que uno cree: el abonado aparece meses después con la ONT en
 * la mano, o la paga para poder volver a contratar. Sin esta puerta, la deuda
 * quedaría para siempre y el aviso al reingresar se volvería ruido que todos
 * aprenden a ignorar.
 *
 * Queda en la auditoría porque es plata: alguien decidió borrar una deuda.
 */
CREATE OR REPLACE FUNCTION saldar_deuda_equipo(p_cliente UUID, p_nota TEXT DEFAULT NULL)
RETURNS clientes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fila   clientes%ROWTYPE;
    v_legajo UUID := mi_legajo_id();
    v_antes  NUMERIC;
BEGIN
    IF NOT puede_gestionar_retiros() THEN
        RAISE EXCEPTION 'No tenés permiso para saldar deudas de equipo';
    END IF;

    SELECT deuda_equipo INTO v_antes FROM clientes WHERE id = p_cliente;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese abonado';
    END IF;

    UPDATE clientes
       SET deuda_equipo = 0, updated_at = NOW()
     WHERE id = p_cliente
    RETURNING * INTO v_fila;

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion,
        entidad, entidad_id, datos
    ) VALUES (
        v_legajo,
        COALESCE((SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
                    FROM usuarios_sistema u WHERE u.id = v_legajo), 'Sistema'),
        (SELECT u.rol FROM usuarios_sistema u WHERE u.id = v_legajo),
        'cliente.deuda_equipo_saldada',
        FORMAT('Saldó la deuda de equipo de %s ($%s)', v_fila.nombre, v_antes),
        'cliente', p_cliente::TEXT,
        jsonb_build_object('monto', v_antes, 'nota', p_nota)
    );

    RETURN v_fila;
END $$;


-- =============================================================================
-- 3. El aviso cuando esa cédula vuelve
-- =============================================================================
/**
 * Antecedentes de una identificación.
 *
 * ── Por qué corre con privilegio ──
 *
 * Porque el que consulta es un vendedor cargando un prospecto, y el abonado
 * viejo casi nunca es suyo: puede haberlo traído otro vendedor, o puede ser de
 * hace tres años. Con `security_invoker` la política de clientes le devolvería
 * vacío justo en el caso que importa, y el aviso no saldría nunca.
 *
 * Por eso devuelve SOLO lo necesario para avisar —nombre, cuándo, por qué y
 * cuánto— y ninguna otra columna de la ficha.
 */
DROP VIEW IF EXISTS v_antecedentes_abonado;
CREATE VIEW v_antecedentes_abonado AS
SELECT
    c.identificacion,
    c.id            AS cliente_id,
    c.codigo,
    c.nombre,
    c.estado,
    c.baja_en,
    mb.nombre       AS motivo_baja,
    c.deuda_equipo,
    -- Lo último que se sabe de él como abonado.
    GREATEST(
        COALESCE(c.baja_en, c.updated_at),
        COALESCE(c.updated_at, c.created_at)
    )              AS ultima_actividad
FROM clientes c
LEFT JOIN motivos_baja mb ON mb.id = c.motivo_baja_id
WHERE c.identificacion IS NOT NULL
  AND BTRIM(c.identificacion) <> ''
  AND (c.estado = 'baja' OR c.deuda_equipo > 0);

GRANT SELECT ON v_antecedentes_abonado TO authenticated;

COMMENT ON VIEW v_antecedentes_abonado IS
    'Lo que hay que saber antes de darle servicio a alguien que ya fue abonado: cuándo se fue, por qué, y si quedó con un equipo sin devolver. Corre con privilegio para que el vendedor lo vea aunque el abonado viejo no sea suyo.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- La deuda que dejó cada uno:
--   SELECT nombre, estado, deuda_equipo FROM clientes WHERE deuda_equipo > 0;
--
--   -- Lo que va a ver el vendedor al escribir esa cédula:
--   SELECT nombre, estado, motivo_baja, deuda_equipo
--     FROM v_antecedentes_abonado WHERE identificacion = '9990002';
--
--   -- Y saldarla cuando aparezca con el equipo o lo pague:
--   SELECT deuda_equipo FROM saldar_deuda_equipo('<cliente>', 'Trajo la ONT a la oficina');
