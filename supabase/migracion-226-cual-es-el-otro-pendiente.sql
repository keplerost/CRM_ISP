-- =============================================================================
-- Migración 226 — Cuál es el "otro" pendiente
-- =============================================================================
-- Igual que con los tickets (221): elegir "Otro" como tipo de pendiente no
-- decía nada en la lista. Ahora se escribe cuál —"entregar factura impresa",
-- "actualizar correo"—, aparte del detalle.
--
-- Idempotente: se puede correr dos veces.
-- =============================================================================

ALTER TABLE pendientes ADD COLUMN IF NOT EXISTS tipo_otro TEXT;

COMMENT ON COLUMN pendientes.tipo_otro IS
    'Con tipo = ''otro'': cuál es, en pocas palabras. Aparte del detalle.';

-- El que pasa de un ticket "Otro" trae lo que se había escrito ahí.
UPDATE pendientes p
   SET tipo_otro = t.incidencia_otro
  FROM tickets t
 WHERE p.ticket_origen = t.id AND p.tipo = 'otro' AND p.tipo_otro IS NULL
   AND NULLIF(BTRIM(t.incidencia_otro), '') IS NOT NULL;
