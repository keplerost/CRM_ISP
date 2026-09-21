-- =============================================================================
-- Migración 178 — De quién se copiaron los permisos de una llave
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué se agrega y por qué ──
--
-- Las llaves de API se van a poder generar desde Gestión de personal: se elige
-- al usuario que la pidió y se copian SUS permisos a la llave.
--
-- Lo que se guarda acá es de dónde salió esa copia. Es un dato de rastro, no un
-- vínculo:
--
--   * Sirve para contestar "¿por qué esta llave puede registrar pagos?" —
--     porque se generó desde el usuario del cajero, que puede.
--   * NO ata la llave a la persona. Si mañana a ese usuario le sacan un permiso,
--     o si renuncia y se lo desactiva, la llave sigue exactamente igual.
--
-- ── Por qué una foto y no un vínculo vivo ──
--
-- Es la diferencia que decide todo el diseño. Con vínculo vivo, agregarle
-- `pagos.anular` a un empleado por un motivo cualquiera le daría en silencio esa
-- capacidad al bot de WhatsApp, y nadie que esté editando la pantalla de
-- personal está pensando en el bot. Con la foto, lo que la llave puede hacer se
-- cambia en un solo lugar: editando la llave.
--
-- Y hay un segundo motivo, más terrenal: si la llave muriera con el legajo, la
-- integración se cortaría el día que esa persona renuncie.
-- =============================================================================

ALTER TABLE api_llaves
    -- El legajo del que se copiaron los permisos. `ON DELETE SET NULL` a
    -- propósito: si se borra el usuario, la llave sigue funcionando y lo único
    -- que se pierde es saber de dónde salió.
    ADD COLUMN IF NOT EXISTS generada_desde UUID REFERENCES usuarios_sistema(id) ON DELETE SET NULL,

    -- El nombre, copiado. Sobrevive al borrado del legajo, que es justo cuando
    -- la pregunta "¿de quién salió esto?" se vuelve difícil de contestar.
    ADD COLUMN IF NOT EXISTS generada_desde_nombre VARCHAR(150);

COMMENT ON COLUMN api_llaves.generada_desde IS
    'De que legajo se copiaron los permisos al crearla. Es rastro, no vinculo: cambiarle los permisos a esa persona NO cambia los de la llave, y desactivarla no la apaga.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, generada_desde_nombre, permisos, activa FROM api_llaves;
