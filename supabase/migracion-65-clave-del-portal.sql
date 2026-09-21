-- =============================================================================
-- Migración 65 — El abonado puede tener contraseña
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- Hasta ahora se entraba al portal solo con un código por WhatsApp. Funciona,
-- pero tiene dos agujeros:
--
--   Depende de que el celular esté bien cargado. El abonado que cambió de
--   número y no avisó queda afuera de su propio portal, y no puede resolverlo.
--
--   Depende de que WhatsApp salga solo. Un ISP en modo manual no puede estar
--   despachando códigos a mano todo el día.
--
-- Con contraseña, el código pasa a ser la puerta de entrada la primera vez y la
-- forma de recuperarla — que es para lo que sirve de verdad. Las dos conviven:
-- ninguna reemplaza a la otra.
-- =============================================================================

ALTER TABLE clientes
    -- scrypt, con sal por cliente. Nunca la contraseña, ni su sha256: hay tablas
    -- precalculadas de sha256 de contraseñas comunes que ya existen hechas.
    ADD COLUMN IF NOT EXISTS portal_clave_hash    TEXT,
    ADD COLUMN IF NOT EXISTS portal_clave_puesta  TIMESTAMPTZ;

COMMENT ON COLUMN clientes.portal_clave_hash IS
    'Contraseña del portal, con scrypt. Opcional: también se entra con el código por WhatsApp.';
COMMENT ON COLUMN clientes.portal_clave_puesta IS
    'Cuándo la definió. NULL = todavía entra solo con el código.';

-- -----------------------------------------------------------------------------
-- Lo que NO hace esta migración, y por qué
-- -----------------------------------------------------------------------------
--
-- No rehace `v_clientes_ficha`. En este proyecto ya hubo dos bugs por vistas
-- definidas con `SELECT c.*`, que congelan las columnas del día que se
-- crearon; el reflejo sería rehacerla para que las nuevas aparezcan.
--
-- Acá ese congelamiento es JUSTO LO QUE SE QUIERE: el hash de la contraseña no
-- tiene por qué llegar al navegador del personal. Al no rehacer la vista, no
-- llega — y esa es la protección más sólida, porque no depende de que nadie se
-- acuerde de excluir la columna en el futuro.
--
-- Quien sí la necesita es el middleware, que lee la tabla directo con
-- service_role.

-- Segunda barrera, para el acceso directo a la tabla desde el navegador: aunque
-- alguien consulte `clientes` en vez de la vista, esa columna no sale.
REVOKE SELECT (portal_clave_hash) ON clientes FROM anon, authenticated;
