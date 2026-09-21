-- =============================================================================
-- Migración 119 — La deuda de los equipos que ya se habían dado por perdidos
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── Qué faltaba ──
--
-- La 118 anota la deuda del equipo al cerrar el retiro. Pero las órdenes que ya
-- estaban cerradas cuando se corrió quedaron en cero: el abonado que se mudó
-- con la ONT figuraba sin deuda, y el aviso al reingresar salía vacío.
--
-- ── Por qué esto no es un simple UPDATE ──
--
-- Porque sumar el valor de las órdenes perdidas a la deuda de cada abonado
-- funciona la primera vez y DUPLICA la deuda la segunda. Y estas migraciones se
-- vuelven a correr: es la regla de la casa, y ya pasó tres veces en este mismo
-- proyecto.
--
-- Tampoco sirve "asignar en vez de sumar": borraría las deudas que alguien ya
-- saldó a mano —el abonado apareció con el equipo— y las haría reaparecer en
-- cada corrida.
--
-- ── La solución: marcar cada orden que ya aportó ──
--
-- `deuda_aplicada` en la orden. El relleno toca solo las que no la tienen, y
-- ponerla es parte de la misma sentencia. Correrlo cien veces da lo mismo que
-- correrlo una, y de paso protege a futuro: ninguna orden puede sumar dos veces
-- su valor a la deuda de nadie.
-- =============================================================================

ALTER TABLE retiros_equipo
    ADD COLUMN IF NOT EXISTS deuda_aplicada BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN retiros_equipo.deuda_aplicada IS
    'Si el valor de esta orden ya se sumó a la deuda de equipo del abonado. Evita que un relleno o un reproceso lo cuente dos veces.';


-- =============================================================================
-- 1. Las que se cerraron antes de la 118
-- =============================================================================
-- Solo las que son pérdida de verdad: un equipo roto que volvió o un error de
-- registro no le deben nada a nadie.
WITH pendientes AS (
    SELECT re.id, re.cliente_id, re.valor
      FROM retiros_equipo re
      JOIN retiro_categorias cat ON cat.clave = re.categoria_cierre
     WHERE re.estado = 'no_recuperado'
       AND cat.es_perdida
       AND NOT re.deuda_aplicada
       AND COALESCE(re.valor, 0) > 0
       AND re.cliente_id IS NOT NULL
),
sumadas AS (
    UPDATE clientes c
       SET deuda_equipo = c.deuda_equipo + p.total,
           updated_at = NOW()
      FROM (SELECT cliente_id, SUM(valor) AS total FROM pendientes GROUP BY cliente_id) p
     WHERE c.id = p.cliente_id
    RETURNING c.id
)
UPDATE retiros_equipo
   SET deuda_aplicada = TRUE
 WHERE id IN (SELECT id FROM pendientes);


-- =============================================================================
-- 2. Y que los cierres nuevos la marquen
-- =============================================================================
-- Igual que la 118 salvo las dos líneas del bloque de la deuda.
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

    -- ── La deuda del equipo que no volvió ──
    -- Se marca la orden en la misma operación: así ni un reproceso ni un
    -- relleno pueden sumarla dos veces.
    IF NOT p_recuperado AND v_cat.es_perdida AND COALESCE(v_fila.valor, 0) > 0
       AND NOT v_fila.deuda_aplicada THEN
        UPDATE clientes
           SET deuda_equipo = deuda_equipo + v_fila.valor,
               updated_at = NOW()
         WHERE id = v_fila.cliente_id;

        UPDATE retiros_equipo SET deuda_aplicada = TRUE WHERE id = p_retiro
        RETURNING * INTO v_fila;
    END IF;

    IF NOT p_recuperado AND v_cat.cierra_ficha THEN
        PERFORM avisar_ficha_por_cerrar(v_fila.cliente_id);
    END IF;

    RETURN v_fila;
END $$;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- La deuda que quedó anotada, y de qué orden vino:
--   SELECT c.nombre, c.deuda_equipo, re.serie, re.categoria_cierre, re.deuda_aplicada
--     FROM clientes c
--     JOIN retiros_equipo re ON re.cliente_id = c.id AND re.estado = 'no_recuperado';
--
--   -- Correr esta migración de nuevo NO tiene que cambiar la deuda de nadie.
