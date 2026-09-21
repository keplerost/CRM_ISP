-- =============================================================================
-- Migración 116 — Lo que llega a la bodega es stock, no material asignado
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El error ──
--
-- Se firmó el acta de una ONT recuperada, el equipo pasó a la bodega central…
-- y quedó con estado `asignado` en vez de `en_stock`.
--
-- ── Por qué ──
--
-- El disparador `aplicar_movimiento_inventario`, de la 69, decide el estado del
-- equipo mirando SOLO el tipo de movimiento:
--
--     WHEN NEW.tipo = 'transferencia' THEN 'asignado'
--
-- Y tenía razón para el caso que existía cuando se escribió: transferir era
-- despachar material a un técnico, y ahí "asignado" es exactamente lo que pasa.
-- Pero desde la 111 hay transferencias que van en el otro sentido —del técnico
-- de vuelta a la bodega, cuando se firma el acta— y esas no asignan nada:
-- devuelven material al stock.
--
-- ── Por qué importa y no es un detalle de vocabulario ──
--
-- Porque las pantallas de stock cuentan lo que está `en_stock`. Una ONT
-- recuperada que llega a la bodega marcada como `asignado` NO aparece como
-- disponible: nadie la va a usar en la próxima instalación, y se compra una
-- nueva teniendo esa en el estante.
--
-- Es el mismo problema que la 111 vino a resolver —el inventario mintiendo
-- sobre dónde está el material— un paso más adelante en el circuito.
--
-- ── El arreglo ──
--
-- El estado lo decide el DESTINO, no el tipo de movimiento:
--
--     a un almacén de técnico o vehículo  → asignado  (está en manos de alguien)
--     a una bodega o sucursal             → en_stock  (está disponible)
-- =============================================================================

CREATE OR REPLACE FUNCTION aplicar_movimiento_inventario()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_origen  NUMERIC := 0;
    v_destino NUMERIC := 0;
    v_tipo_destino TEXT;
BEGIN
    -- Cuánto sale y cuánto entra, según el tipo.
    IF NEW.tipo IN ('salida', 'consumo') THEN
        v_origen := NEW.cantidad;
    ELSIF NEW.tipo IN ('ingreso', 'devolucion') THEN
        v_destino := NEW.cantidad;
    ELSIF NEW.tipo = 'transferencia' THEN
        v_origen  := NEW.cantidad;
        v_destino := NEW.cantidad;
    ELSIF NEW.tipo = 'ajuste' THEN
        -- El ajuste lleva signo: positivo suma, negativo descuenta.
        v_destino := NEW.cantidad;
    END IF;

    IF v_origen <> 0 AND NEW.almacen_origen_id IS NOT NULL THEN
        INSERT INTO existencias (articulo_id, almacen_id, cantidad)
        VALUES (NEW.articulo_id, NEW.almacen_origen_id, -v_origen)
        ON CONFLICT (articulo_id, almacen_id)
        DO UPDATE SET cantidad = existencias.cantidad - v_origen;
    END IF;

    IF v_destino <> 0 AND NEW.almacen_destino_id IS NOT NULL THEN
        INSERT INTO existencias (articulo_id, almacen_id, cantidad)
        VALUES (NEW.articulo_id, NEW.almacen_destino_id, v_destino)
        ON CONFLICT (articulo_id, almacen_id)
        DO UPDATE SET cantidad = existencias.cantidad + v_destino;
    END IF;

    -- El equipo con serie se mueve con su movimiento. Dejarlo a cargo de la
    -- aplicación permitiría que el stock diga que la ONT está en el almacén de
    -- Juan y la ficha del equipo siga diciendo "bodega central".
    IF NEW.equipo_id IS NOT NULL THEN
        SELECT tipo INTO v_tipo_destino FROM almacenes WHERE id = NEW.almacen_destino_id;

        UPDATE equipos
           SET almacen_id     = CASE
                                  WHEN NEW.tipo = 'consumo' THEN NULL
                                  ELSE COALESCE(NEW.almacen_destino_id, almacen_id)
                                END,
               estado         = CASE
                                  WHEN NEW.tipo = 'consumo'    THEN 'instalado'
                                  WHEN NEW.tipo = 'devolucion' THEN 'en_stock'
                                  -- Acá está el arreglo: manda el destino.
                                  WHEN NEW.tipo = 'transferencia' THEN
                                       CASE WHEN v_tipo_destino IN ('tecnico', 'vehiculo')
                                            THEN 'asignado' ELSE 'en_stock' END
                                  ELSE estado
                                END,
               instalacion_id = COALESCE(NEW.instalacion_id, instalacion_id),
               actualizado_en = NOW()
         WHERE id = NEW.equipo_id;
    END IF;

    RETURN NEW;
END $$;

COMMENT ON FUNCTION aplicar_movimiento_inventario IS
    'Aplica el movimiento a las existencias y al equipo con serie. El estado del equipo lo decide el destino: en manos de un técnico queda asignado; en una bodega, en stock.';


-- =============================================================================
-- Lo que ya quedó mal
-- =============================================================================
-- Un equipo que está en una bodega o una sucursal y figura como `asignado` es
-- una contradicción: `asignado` significa "lo tiene alguien". Se corrige.
--
-- No toca los que están en almacenes de técnico ni en vehículos, que son los que
-- de verdad están asignados.
UPDATE equipos e
   SET estado = 'en_stock', actualizado_en = NOW()
  FROM almacenes a
 WHERE a.id = e.almacen_id
   AND e.estado = 'asignado'
   AND a.tipo IN ('bodega', 'sucursal');


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- No tiene que quedar ninguno:
--   SELECT e.serie, a.nombre, e.estado
--     FROM equipos e JOIN almacenes a ON a.id = e.almacen_id
--    WHERE e.estado = 'asignado' AND a.tipo IN ('bodega', 'sucursal');
--
--   -- Y el sentido inverso sigue funcionando: despachar a un técnico asigna.
--   SELECT e.serie, e.estado FROM equipos e
--     JOIN almacenes a ON a.id = e.almacen_id WHERE a.tipo = 'tecnico';
