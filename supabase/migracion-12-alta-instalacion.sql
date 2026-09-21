-- =============================================================================
-- Migración 12 — La instalación da de alta al cliente
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 11. Es idempotente.
--
-- Cuando el técnico vuelve y marca la instalación como hecha, el cliente ya
-- tiene servicio. Que alguien además tenga que entrar a la ficha a escribir la
-- fecha y ponerlo en activo es un paso que se olvida — y entonces el abonado
-- queda "suspendido" en el sistema mientras navega.
--
-- Va como disparador y no en la pantalla a propósito: así vale igual si la
-- instalación se carga desde la ficha del cliente, desde la agenda general o
-- desde una importación.
-- =============================================================================

CREATE OR REPLACE FUNCTION instalacion_actualiza_cliente()
RETURNS TRIGGER AS $$
BEGIN
    -- Solo cuenta la visita terminada. Una agendada todavía no instaló nada.
    IF NEW.estado <> 'hecha' THEN
        RETURN NEW;
    END IF;

    -- Un alta o un traslado fijan la fecha de instalación del servicio: es la
    -- fecha desde la que el abonado tiene internet en ese domicilio.
    IF NEW.tipo IN ('nueva', 'traslado') THEN
        UPDATE clientes
           SET fecha_instalacion = NEW.fecha,
               -- Una reparación o una revisión no cambian el estado: el cliente
               -- puede estar cortado por mora y seguir estándolo después de que
               -- le arreglen el cable.
               estado = CASE WHEN NEW.tipo = 'nueva' THEN 'activo' ELSE estado END,
               -- Si la visita anotó una dirección o coordenadas propias, se
               -- copian: es dónde está puesto el servicio de verdad.
               direccion = COALESCE(NEW.direccion, direccion),
               latitud   = COALESCE(NEW.latitud, latitud),
               longitud  = COALESCE(NEW.longitud, longitud)
         WHERE id = NEW.client_id;
    END IF;

    -- Un retiro deja al cliente de baja: se le sacaron los equipos.
    IF NEW.tipo = 'retiro' THEN
        UPDATE clientes SET estado = 'baja' WHERE id = NEW.client_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION instalacion_actualiza_cliente IS
    'Al marcar una instalación como hecha, completa la fecha de instalación del cliente y lo da de alta (o de baja, si fue un retiro).';

DROP TRIGGER IF EXISTS trg_instalacion_alta ON instalaciones;
CREATE TRIGGER trg_instalacion_alta
    AFTER INSERT OR UPDATE OF estado, fecha, tipo ON instalaciones
    FOR EACH ROW EXECUTE FUNCTION instalacion_actualiza_cliente();


-- =============================================================================
-- Completar lo que ya está cargado
-- =============================================================================
-- Los clientes que ya tienen una instalación hecha registrada pero sin fecha en
-- la ficha: se les copia la de su primera visita.
UPDATE clientes c
   SET fecha_instalacion = i.fecha
  FROM (
      SELECT DISTINCT ON (client_id) client_id, fecha
      FROM instalaciones
      WHERE estado = 'hecha' AND tipo IN ('nueva', 'traslado')
      ORDER BY client_id, fecha
  ) i
 WHERE i.client_id = c.id
   AND c.fecha_instalacion IS NULL;
