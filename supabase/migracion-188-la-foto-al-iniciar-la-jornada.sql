-- =============================================================================
-- Migración 188 — La foto al iniciar la jornada
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Qué resuelve ──
--
-- La jornada ya guardaba la hora de inicio (`inicio_at`), pero una hora sola no
-- prueba nada: la marca quien aprieta el botón, desde donde sea. Con una foto
-- del momento, quien dirige puede mirar el ingreso del día y ver de quién es y
-- en qué condiciones salió.
--
-- ── Por qué la foto NO bloquea ──
--
-- La app de campo trabaja sin señal: el técnico abre la orden en una zona sin
-- cobertura y el sistema encola lo que no pudo mandar. Si el inicio de jornada
-- dependiera de que la foto suba, el que no tiene señal no podría empezar a
-- trabajar — y empezaría igual, sin registrar nada, que es peor que no tener la
-- foto.
--
-- Por eso `foto_ingreso` es opcional en la base. La pantalla la pide y la sube
-- apenas puede; la jornada se abre con foto o sin ella, y la que falte se ve en
-- la revisión.
--
-- ── Por qué su propio bucket ──
--
-- Son fotos de los empleados, no de los abonados. Mezclarlas con `expedientes`
-- —donde viven las cédulas de los clientes— significaría que cualquier política
-- que se escriba para uno alcanza al otro, y son dos cosas con dueños, plazos
-- de guarda y motivos distintos. Separarlas hoy cuesta una línea; separarlas
-- dentro de un año cuesta migrar archivos.
-- =============================================================================


-- ── 1. Las columnas ──────────────────────────────────────────────────────────

ALTER TABLE jornadas
    ADD COLUMN IF NOT EXISTS foto_ingreso TEXT;

ALTER TABLE jornadas
    ADD COLUMN IF NOT EXISTS foto_ingreso_at TIMESTAMPTZ;

COMMENT ON COLUMN jornadas.foto_ingreso IS
    'Ruta de la foto de inicio dentro del bucket `jornadas`. NULL si todavía no se subió: la jornada se abre igual, sin señal no hay foto.';

COMMENT ON COLUMN jornadas.foto_ingreso_at IS
    'Cuándo se subió la foto. Es distinto de inicio_at: sin señal la jornada se abre y la foto llega después, y esa diferencia es un dato, no un error.';

/**
 * `v_jornadas` no se toca.
 *
 * Está definida con `j.*`, así que las dos columnas nuevas ya salen por ahí.
 * Recrearla para "agregarlas" sería reescribir una vista que no cambió.
 */


-- ── 2. El bucket ─────────────────────────────────────────────────────────────

/**
 * Privado, como todos los que llevan fotos de personas. Se mira con una URL
 * firmada que dura minutos, y pedirla queda registrado.
 */
INSERT INTO storage.buckets (id, name, public)
VALUES ('jornadas', 'jornadas', FALSE)
ON CONFLICT (id) DO NOTHING;


-- ── 3. Quién puede subir y quién puede mirar ─────────────────────────────────

/**
 * La carpeta es el id de la jornada, igual que en expedientes.
 *
 * Eso es lo que impide que alguien suba a una carpeta inventada o adivine una
 * ruta: si el primer tramo no corresponde a una jornada que existe, la política
 * lo rechaza.
 *
 * Quién ve la PANTALLA de revisión lo decide el permiso de la ruta
 * (`/soporte/jornadas`), no esto. Acá se protege el archivo suelto.
 */
DROP POLICY IF EXISTS jornadas_foto_subir ON storage.objects;
CREATE POLICY jornadas_foto_subir ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'jornadas'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM jornadas)
    );

DROP POLICY IF EXISTS jornadas_foto_leer ON storage.objects;
CREATE POLICY jornadas_foto_leer ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'jornadas'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM jornadas)
    );

/**
 * Reemplazar, sí. Borrar, no.
 *
 * Sacar de nuevo la foto porque salió movida es normal y tiene que poder
 * hacerse. Borrarla y dejar la jornada sin nada es otra cosa: es deshacer el
 * registro después de que alguien lo miró. Si hace falta quitar una, se hace
 * desde la consola y queda el rastro de quién lo pidió.
 */
DROP POLICY IF EXISTS jornadas_foto_reemplazar ON storage.objects;
CREATE POLICY jornadas_foto_reemplazar ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'jornadas'
        AND (storage.foldername(name))[1] IN (SELECT id::TEXT FROM jornadas)
    );
