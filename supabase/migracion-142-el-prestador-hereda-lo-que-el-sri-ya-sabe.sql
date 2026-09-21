-- =============================================================================
-- Migración 142 — El prestador hereda lo que el SRI ya sabe
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── La pregunta que resuelve ──
--
-- Si un ISP instala el sistema y carga sus datos de facturación electrónica,
-- ¿hace falta que además cargue un "prestador" a mano?
--
-- Para la mitad de los campos, no: el SRI ya los tiene. Para la otra mitad, sí,
-- y no hay forma de evitarlo. De los veinticuatro campos del prestador, `sri_config`
-- cubre seis:
--
--   razón social · nombre comercial · RUC · teléfono · correo · dirección
--
-- Los otros dieciocho no existen en la configuración del SRI porque son de otro
-- trámite ante otro regulador. Los que más importan:
--
--   LA FECHA DE INSCRIPCIÓN DEL MODELO ante la ARCOTEL. Es la que va al pie de
--   cada hoja y la que permite verificar que el contrato corresponde a un modelo
--   aprobado. El SRI no sabe nada de eso.
--
--   EL DOMICILIO DESGLOSADO. El SRI guarda la dirección como un texto suelto; el
--   contrato pide provincia, cantón, ciudad y parroquia por separado.
--
--   LOS CANALES DE RECLAMO Y LA WEB. La cláusula décima los exige, y el anexo 1f
--   pide la web dos veces. Un correo de facturación no es un canal de reclamo.
--
--   LAS CONDICIONES COMERCIALES: vigencia, permanencia, valor de instalación.
--
-- ── Lo que hace esta migración ──
--
-- Que los seis heredables se llenen y se mantengan solos, y que un ISP que
-- carga su SRI por primera vez ya tenga medio prestador hecho. Los otros
-- dieciocho se cargan una vez, en Ajustes.
-- =============================================================================

/**
 * Sincroniza el prestador con los datos de facturación.
 *
 * ── Por qué se compara el RUC ──
 *
 * Porque "quien factura" y "quien presta el servicio" coinciden casi siempre,
 * pero no necesariamente. En esta instalación no: las facturas salen a nombre de
 * un RUC y el contrato está inscrito a nombre de otro.
 *
 * Si los RUC coinciden, es el mismo negocio y los datos se mantienen al día
 * solos: el ISP corrige su razón social en un lugar y vale en los dos.
 *
 * Si difieren, son entidades distintas y no se toca nada. Copiar los datos de
 * una sobre la otra pondría en el contrato el nombre de quien no lo firma.
 */
CREATE OR REPLACE FUNCTION prestador_hereda_del_sri()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF NEW.ruc IS NULL OR TRIM(NEW.ruc) = '' THEN
        RETURN NEW;
    END IF;

    SELECT id INTO v_id FROM prestadores WHERE ruc = NEW.ruc LIMIT 1;

    /**
     * Si no hay ninguno con ese RUC, se crea — pero solo cuando NO existe
     * ningún prestador todavía.
     *
     * Es la diferencia entre un ISP que recién instala el sistema y uno que ya
     * tiene su prestador cargado con otro RUC. Al primero se le arma solo; al
     * segundo no se le agrega un segundo prestador que él no pidió y que
     * competiría por ser el predeterminado.
     */
    IF v_id IS NULL THEN
        IF EXISTS (SELECT 1 FROM prestadores) THEN
            RETURN NEW;
        END IF;

        INSERT INTO prestadores (
            razon_social, nombre_comercial, ruc, direccion, telefono, email, predeterminado
        ) VALUES (
            NEW.razon_social,
            NEW.nombre_comercial,
            NEW.ruc,
            COALESCE(NEW.dir_establecimiento, NEW.dir_matriz),
            NEW.telefono,
            NEW.email,
            TRUE
        );
        RETURN NEW;
    END IF;

    /**
     * Y si ya existe, se le refrescan los seis campos heredables.
     *
     * Se pisan aunque tengan valor: son los mismos datos, y tener dos versiones
     * de la razón social —una en cada pantalla— es cómo se llega a un contrato
     * que dice algo distinto de la factura del mismo mes.
     *
     * COALESCE en el otro sentido para no borrar: si el SRI todavía no tiene
     * teléfono, se conserva el que el prestador tenga cargado.
     */
    UPDATE prestadores SET
        razon_social     = COALESCE(NEW.razon_social, razon_social),
        nombre_comercial = COALESCE(NEW.nombre_comercial, nombre_comercial),
        telefono         = COALESCE(NEW.telefono, telefono),
        email            = COALESCE(NEW.email, email),
        direccion        = COALESCE(NEW.dir_establecimiento, NEW.dir_matriz, direccion),
        actualizado_en   = NOW()
    WHERE id = v_id;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_prestador_hereda_del_sri ON sri_config;
CREATE TRIGGER trg_prestador_hereda_del_sri
    AFTER INSERT OR UPDATE OF razon_social, nombre_comercial, ruc, telefono, email,
                              dir_matriz, dir_establecimiento
    ON sri_config
    FOR EACH ROW EXECUTE FUNCTION prestador_hereda_del_sri();


-- =============================================================================
-- Qué le falta a cada prestador para poder emitir contratos
-- =============================================================================
/**
 * La lista de lo que el SRI no puede darle.
 *
 * La pantalla de Ajustes la lee para mostrar qué falta, y sirve además como
 * documentación viva: si mañana se agrega un campo obligatorio al contrato, se
 * agrega acá y aparece solo en la pantalla.
 */
CREATE OR REPLACE VIEW v_prestadores_listos WITH (security_invoker = true) AS
SELECT
    p.*,
    -- Si coincide con quien factura, sus datos de identidad se mantienen solos.
    EXISTS (SELECT 1 FROM sri_config s WHERE s.ruc = p.ruc) AS hereda_del_sri,
    ARRAY_REMOVE(ARRAY[
        CASE WHEN p.modelo_inscrito_el IS NULL
             THEN 'La fecha en que inscribió el modelo de contrato ante la ARCOTEL' END,
        CASE WHEN p.provincia IS NULL OR p.canton IS NULL OR p.parroquia IS NULL
             THEN 'La provincia, el cantón y la parroquia del prestador' END,
        CASE WHEN p.web IS NULL OR TRIM(p.web) = ''
             THEN 'El sitio web, que el anexo 1f pide dos veces' END,
        CASE WHEN p.reclamos_email IS NULL AND p.reclamos_telefono IS NULL
             THEN 'Al menos un canal de reclamo (cláusula décima)' END,
        CASE WHEN p.reclamos_horario IS NULL OR TRIM(p.reclamos_horario) = ''
             THEN 'El horario de atención' END,
        CASE WHEN p.ruc IS NULL THEN 'El RUC' END
    ], NULL) AS le_falta
FROM prestadores p;

COMMENT ON VIEW v_prestadores_listos IS
    'Prestadores con la lista de lo que les falta para poder emitir un contrato de adhesión.';


-- =============================================================================
-- Que lo ya cargado quede al día
-- =============================================================================
/**
 * Se dispara la herencia una vez sobre lo que ya está.
 *
 * Sin esto, el ISP que ya tenía su SRI cargado tendría que entrar a esa pantalla
 * y guardar sin cambiar nada para que el disparador corriera.
 */
UPDATE sri_config SET updated_at = NOW() WHERE ruc IS NOT NULL;


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- Qué le falta a cada prestador:
--   SELECT razon_social, hereda_del_sri, le_falta FROM v_prestadores_listos;
--
--   -- Y que cambiar la razón social en el SRI la cambie en su prestador —solo
--   -- en el que tiene el mismo RUC—:
--   SELECT p.razon_social, p.ruc, s.razon_social AS segun_el_sri
--     FROM prestadores p LEFT JOIN sri_config s ON s.ruc = p.ruc;
