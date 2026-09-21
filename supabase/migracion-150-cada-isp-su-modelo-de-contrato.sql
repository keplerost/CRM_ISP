-- =============================================================================
-- Migración 150 — Cada ISP con su modelo de contrato
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Lo que estaba mal razonado ──
--
-- El texto de las cláusulas estaba en el código, con este argumento: "es un
-- modelo inscrito ante la ARCOTEL, no lo redacta el ISP".
--
-- Es verdad a medias. El modelo se inscribe POR PRESTADOR: cada ISP presenta el
-- suyo y le aprueban ese. Comparten la estructura que exige el regulador —las
-- mismas quince cláusulas, las mismas casillas— pero el texto no es idéntico
-- entre uno y otro.
--
-- Con las cláusulas en el código, el segundo ISP que instalara el sistema
-- firmaría contratos con el texto del primero. Eso es peor que dejar editar.
--
-- ── Lo que NO se vuelve editable, y por qué ──
--
-- La ESTRUCTURA. La lista de diez servicios de la cláusula segunda, las seis
-- formas de pago, las causales de terminación, los canales de la ARCOTEL y las
-- casillas SI/NO no son redacción: son el formulario que el regulador exige.
-- Cada cláusula declara qué bloque le corresponde y el generador lo dibuja.
--
-- Así, editar el texto no puede romper el formulario, que es exactamente lo que
-- pasaría con un campo de texto libre.
-- =============================================================================

CREATE TABLE IF NOT EXISTS clausulas_contrato (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    /**
     * De quién es esta cláusula.
     *
     * NULL = del MODELO BASE, el que trae el sistema. Es el que usa el ISP que
     * todavía no cargó el suyo, y el que se copia cuando quiere partir de algo
     * en vez de escribir quince cláusulas desde cero.
     */
    prestador_id UUID REFERENCES prestadores(id) ON DELETE CASCADE,

    orden   INT NOT NULL,
    numeral VARCHAR(60) NOT NULL,
    titulo  VARCHAR(120) NOT NULL,

    -- El cuerpo. Se parte en tres porque el formulario intercala bloques: el
    -- texto va antes del bloque, los cierres después.
    texto   TEXT,
    cierre  TEXT,
    cierre2 TEXT,

    /** Los apartados numerados (7.1, 7.2…). Un elemento por párrafo. */
    numerales JSONB NOT NULL DEFAULT '[]'::JSONB,

    /**
     * Qué bloque del formulario va en el medio.
     *
     * No es texto: es la parte que el regulador define y que el generador dibuja
     * con sus casillas. Por eso es una clave y no una redacción.
     */
    bloque VARCHAR(20)
        CHECK (bloque IS NULL OR bloque IN (
            'servicios', 'formas_pago', 'reclamos', 'causales', 'paquetes'
        )),
    bloque_final VARCHAR(20)
        CHECK (bloque_final IS NULL OR bloque_final IN ('canales_arcotel')),

    /** La casilla SI/NO que responde el abonado, si esta cláusula lleva una. */
    condicion VARCHAR(30)
        CHECK (condicion IS NULL OR condicion IN (
            'renovacion_automatica', 'permanencia', 'arbitraje', 'empaquetamiento'
        )),
    etiqueta_condicion VARCHAR(120),

    /** La cláusula de arbitraje lleva su propia raya de firma. */
    raya_firma BOOLEAN NOT NULL DEFAULT FALSE,

    /** El título de la lista que se arma con datos —los beneficios de la quinta—. */
    lista_titulo VARCHAR(120),
    lista_campo  VARCHAR(30),

    activa BOOLEAN NOT NULL DEFAULT TRUE,

    creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT clausulas_numerales_arreglo CHECK (jsonb_typeof(numerales) = 'array')
);

/**
 * El orden no se repite dentro de un mismo modelo.
 *
 * Dos cláusulas en la misma posición salen impresas en un orden que decide el
 * planificador de consultas, y eso cambia de una impresión a la siguiente: el
 * mismo contrato saldría con las cláusulas en distinto orden.
 *
 * Son dos índices porque `prestador_id` NULL no se compara con igualdad y un
 * índice único común dejaría repetir el orden en el modelo base.
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_clausulas_orden_prestador
    ON clausulas_contrato (prestador_id, orden) WHERE prestador_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clausulas_orden_base
    ON clausulas_contrato (orden) WHERE prestador_id IS NULL;

ALTER TABLE clausulas_contrato ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clausulas_contrato_auth ON clausulas_contrato;
CREATE POLICY clausulas_contrato_auth ON clausulas_contrato
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- El modelo base
-- =============================================================================
/**
 * Las catorce cláusulas que hoy están en el código.
 *
 * Se siembran solo si no hay ninguna: reejecutar la migración no puede
 * devolverle el texto de fábrica al ISP que redactó el suyo.
 *
 * La PRIMERA no está acá y no es un olvido: es la de los comparecientes, que no
 * tiene redacción —son las dos cajas de datos del prestador y del abonado— y la
 * dibuja el generador siempre igual.
 */
INSERT INTO clausulas_contrato
    (prestador_id, orden, numeral, titulo, texto, cierre, cierre2, numerales,
     bloque, bloque_final, condicion, etiqueta_condicion, raya_firma,
     lista_titulo, lista_campo)
SELECT * FROM (VALUES
(NULL::UUID, 2, 'CLÁUSULA SEGUNDA', 'Objeto',
 'El Prestador del servicio se compromete a proporcionar al Abonado el/los siguiente(s) servicio(s), para lo cual el Prestador dispone de los correspondientes títulos habilitantes otorgados por la ARCOTEL, de conformidad con el ordenamiento jurídico vigente:',
 'Las Condiciones Técnicas del/los servicio(s) que el Abonado va a contratar se encuentran detalladas en el Anexo N° 1f, el cual forma parte integrante del presente contrato.',
 NULL, '[]'::JSONB, 'servicios', NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 3, 'CLÁUSULA TERCERA', 'Anexos',
 'Es parte integrante del presente CONTRATO el Anexo 1 que contiene las "Condiciones particulares del Servicio". El Anexo 2 "Aceptación de uso de datos personales". El Anexo 3 "Compra o arrendamiento de Equipos". Acta de Entrega/Instalación.',
 NULL, NULL, '[]'::JSONB, NULL, NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 4, 'CLÁUSULA CUARTA', 'Vigencia del Contrato',
 'El presente contrato tendrá una duración de {{vigencia}} y entrará en vigencia, a partir de la fecha de instalación y prestación efectiva del servicio. La fecha inicial considerada para facturación para cada uno de los servicios contratados debe ser la de la activación de servicio. Las partes se comprometen a respetar el plazo de vigencia pactado. El Abonado acepta la renovación automática sucesiva del contrato en las mismas condiciones de este contrato, independientemente de su derecho a terminar la relación contractual conforme la legislación aplicable, o solicitar en cualquier tiempo, con hasta quince (15) días de antelación a la fecha de renovación, su decisión de no renovación:',
 'Cuando un contrato contemple renovación automática como una de sus condiciones, ésta será notificada por el prestador con quince (15) días de anticipación a su renovación a los medios de contacto registrados por el usuario. Para la renovación no se podrán exigir requisitos adicionales a los previamente solicitados al momento de la contratación inicial.',
 NULL, '[]'::JSONB, NULL, NULL, 'renovacion_automatica', NULL, FALSE, NULL, NULL),

(NULL, 5, 'CLÁUSULA QUINTA', 'Permanencia mínima',
 '¿El Abonado se acoge al periodo de permanencia mínima de {{permanencia_ofrecida}} en la prestación del servicio contratado?',
 'La permanencia mínima se acuerda, sin perjuicio de que el abonado/suscriptor conforme lo determina la Ley Orgánica de Telecomunicaciones, pueda dar por terminado el contrato en forma unilateral y anticipada, y en cualquier tiempo previa notificación por medios físicos, telefónicos o electrónicos al prestador, con por lo menos (15) días calendario de anticipación. El contrato terminará quince (15) días calendario posteriores a la fecha de presentación de la solicitud.',
 NULL, '[]'::JSONB, NULL, NULL, 'permanencia', NULL, FALSE,
 'Los beneficios de la permanencia mínima son:', 'beneficios'),

(NULL, 6, 'CLÁUSULA SEXTA', 'Tarifa y forma de pago',
 'Las tarifas o valores mensuales a ser cancelados por cada uno de los servicios contratados por el Abonado estará determinada en la ficha de cada servicio, que constan en el Anexo 1f y el pago se realizará, de la siguiente forma:',
 'La tarifa correspondiente al servicio contratado y efectivamente prestado estará dentro de los techos tarifarios señalados por la ARCOTEL y en los títulos habilitantes correspondientes, en caso de que se establezcan, de conformidad con el ordenamiento jurídico vigente. En caso de que el Abonado desee cambiar su modalidad de pago a otra de las disponibles, deberá comunicar al Prestador del servicio con quince (15) días de anticipación. El Prestador del servicio, luego de haber sido comunicado, instrumentará la nueva forma de pago. Cuando las actividades de recaudación se realicen directamente con el personal, infraestructura, aplicativos y desarrollos tecnológicos propios de la prestadora, ésta no podrá cobrar valor alguno al abonado, suscriptor o cliente por comisión de servicios y no aplica en caso de coactiva.',
 NULL, '[]'::JSONB, 'formas_pago', NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 7, 'CLÁUSULA SEPTIMA', 'Instalación', NULL, NULL, NULL,
 to_jsonb(ARRAY[
   '7.1 Todos los equipos con que se prestan EL SERVICIO son de propiedad de EL Prestador. El Abonado los tiene en calidad de custodio, por tal motivo es su obligación velar por ellos y cuidar que se conserven en buen estado. Sin perjuicio de su responsabilidad.',
   '7.2 Si en las fechas establecidas de común acuerdo no pudieran llevarse a cabo las actividades programadas para la instalación y puesta en marcha del SERVICIO por causas atribuibles al Abonado, esta se reprogramará conforme la disponibilidad de trabajos del Prestador.',
   '7.3 Realizada la instalación del SERVICIO, El Prestador levantará un Acta de entrega/instalación del o de los servicios y le notificará al Abonado.',
   '7.4 Si EL Abonado introduce cambios que varíen el diseño físico, mecánico o eléctrico de los equipos, El Prestador quedará facultado para interrumpir el servicio que involucre a la unidad afectada y retirar el equipo instalado. EL Abonado deberá responder por las consecuencias y daños que los cambios y/o la adición y/o modificación hayan ocasionado al Prestador, y el reembolso de todos los gastos que resulte necesario efectuar.',
   '7.5 Las modificaciones en los lugares de instalación o en las obras de infraestructura que se hagan necesarias para la instalación, serán realizadas por el Abonado conforme descripción del Prestador.'
 ]), NULL, NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 8, 'CLÁUSULA OCTAVA', 'Compra, Arrendamiento de Equipos',
 'Adicional al servicio contratado, objeto de este contrato y sin que este sea requisito para la prestación del servicio, el Prestador entrega en calidad de arrendamiento o venta, equipos accesorios para ser usados con el servicio, conforme el detalle, especificaciones y precio que se describen en el ANEXO 3. Para equipos en arriendo, al momento de la entrega de los equipos o terminación del contrato se considerará el deterioro normal y depreciación de los mismos. En caso de terminación del contrato, cuando se trate de adquisición de los equipos el Abonado deberá cancelar únicamente las cuotas pendientes.',
 'El prestador del servicio no podrá cobrar por el arrendamiento de equipos cuando estos sean parte fundamental e indispensable en la prestación del servicio. Únicamente lo podrá hacer cuando estos sean considerados equipos adicionales solicitados por el abonado, suscriptor o cliente. En los casos de renovación del contrato, el prestador propenderá al cambio del equipo, cuando este haya alcanzado la obsolescencia tecnológica que impida garantizar la calidad y las condiciones en la prestación del servicio contratado, sin costo adicional para el caso de los equipos que sean parte fundamental e indispensable en la prestación del servicio.',
 NULL,
 to_jsonb(ARRAY[
   '8.1 Mantenimiento o Reposición: Equipos de propiedad del Abonado: El servicio de mantenimiento de los equipos de propiedad del Abonado empleados en la prestación del servicio estará a cargo de su propietario y por lo tanto EL Prestador no está obligado a realizar mantenimiento o reposición, salvo el caso de obligaciones de garantía por venta de equipos previamente acordada por las partes.',
   '8.2 Mantenimiento o Reposición: Equipos de propiedad del Prestador entregados en calidad de arrendamiento: El servicio de mantenimiento no tendrá cargo alguno para el Abonado y contemplará toda reparación, ajuste, cambio de partes, reemplazo o reposición de los equipos cuyas fallas resulten por el uso normal y apropiado del mismo y de vicios en los equipos, sin perjuicio de las consecuencias previstas en EL CONTRATO para los casos de incumplimiento de las obligaciones por parte del Abonado, respecto al buen uso, cuidado de los equipos y cumplimiento de las obligaciones relacionadas al canon de arrendamiento y devolución al finalizar el período de servicio.',
   '8.3 Mantenimiento o Reposición: Equipos de propiedad de EL Prestador entregados en calidad de préstamos: El servicio de mantenimiento no tendrá cargo alguno para el Abonado y contemplará toda reparación, ajuste, cambio de partes, reemplazo o reposición de los equipos cuyas fallas resulten por el uso normal y apropiado del mismo y de vicios en los equipos, sin perjuicio de las consecuencias previstas en EL CONTRATO, para los casos de incumplimiento de las obligaciones por parte del Abonado, respecto al buen uso, cuidado de los equipos entregados en custodia y devolución al finalizar el periodo de servicio.'
 ]), NULL, NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 9, 'CLÁUSULA NOVENA', 'Uso de información personal',
 'Los datos personales que los Abonados/Suscriptores proporcionen al Prestador de servicios del régimen general de telecomunicaciones, no podrán ser usados para la promoción comercial de servicios o productos, inclusive de la propia operadora; salvo autorización y consentimiento expreso del Abonado, el que constará como instrumento separado y distinto al presente contrato de prestación de servicios (contrato de adhesión) a través de medios físicos o electrónicos. En dicho instrumento se deberá dejar constancia expresa de los datos personales o información que están expresamente autorizados; el plazo de la autorización y el objetivo que esta utilización persigue, conforme lo dispuesto en el artículo 121 del Reglamento General a la Ley Orgánica de Telecomunicaciones. La autorización de uso de los datos personales e información aquí consignada para fines de promoción y comercial de los productos y servicios que la empresa oferta exclusivamente a sus Abonados/Suscriptores, así como para consultar y referir la información crediticia del Abonado, consta expresamente en el Anexo 2.',
 NULL, NULL,
 to_jsonb(ARRAY[
   'Privacidad y protección de datos personales.- El uso, tratamiento y protección de los datos personales debe regirse estrictamente por lo establecido en la Ley Orgánica de Protección de Datos Personales, su Reglamento General y las directrices emitidas por la Autoridad de Protección de Datos. Toda la información personal que se recopile, procese o almacene debe manejarse con total transparencia, seguridad y respeto a los derechos de los titulares de los datos. Se debe garantizar que los datos serán utilizados únicamente para los fines contractuales para la prestación del servicio y adicionalmente para los que el usuario ha dado su consentimiento explícito, informado, y siempre en cumplimiento con el marco legal vigente. Los datos contenidos en las guías telefónicas de telefonía fija se considerarán datos de fuentes accesibles al público. No obstante, los abonados tendrán derecho a que sus datos personales sean excluidos gratuitamente de dichas guías, a partir de su solicitud explícita y por cualquier mecanismo de atención disponible por el prestador.'
 ]), NULL, NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 10, 'CLÁUSULA DECIMA', 'Reclamos y soporte técnico',
 'El Abonado podrá requerir soporte técnico o presentar reclamos al Prestador de servicios a través de los siguientes medios o puntos:',
 'En el caso en que su queja, reclamo o solicitud no hayan sido resueltos por el prestador del servicio, en relación a la calidad del servicio prestado, a errores de facturación de los servicios, facturación de servicios no contratados, cobros indebidos, o en general por cualquier irregularidad que se hubiere producido en relación con el servicio contratado, los abonados, clientes o suscriptores podrán presentar las mismas a través de cualquiera de los siguientes canales de atención:',
 NULL, '[]'::JSONB, 'reclamos', 'canales_arcotel', NULL, NULL, FALSE, NULL, NULL),

(NULL, 11, 'CLÁUSULA DECIMA PRIMERA', 'Normativa Aplicable',
 'En la prestación del servicio, se entienden incluidos todos los derechos y obligaciones de los Abonados/Suscriptores, establecidos en las normas jurídicas aplicables, así como también los derechos y obligaciones de los Prestadores de servicios de telecomunicaciones y/o servicios de radiodifusión por suscripción, dispuestos en el marco regulatorio.',
 NULL, NULL, '[]'::JSONB, NULL, NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 12, 'CLÁUSULA DECIMA SEGUNDA', 'Causales y Mecanismos de Terminación del contrato',
 'Las partes acuerdan recíprocamente que EL CONTRATO se terminará por la ejecución total de las obligaciones derivadas del mismo; por acuerdo mutuo y que conste por escrito, o cuando ocurra alguna de las siguientes causales:',
 'Los abonados, suscriptores o clientes tienen el derecho de terminar su contrato de manera anticipada y unilateral en cualquier momento, sin importar el plazo de vigencia establecido. Pueden hacerlo a través de cualquier medio físico, telefónico o electrónico, simplemente notificando al prestador su decisión con al menos quince (15) días calendario de anticipación a la finalización del periodo de facturación en curso. Esta terminación unilateral no generará multas, penalidades, recargos de valores o costos adicionales de ninguna naturaleza.',
 'Los saldos pendientes de pago relacionados con cualquiera de los conceptos como, prestación del servicio, equipo terminal, condición de permanencia mínima, y la entrega cualquier equipo provisto al abonado, suscriptor o cliente, no podrán ser impedimento para el libre ejercicio del derecho a la terminación unilateral del contrato, por parte del abonado, suscriptor o cliente, manteniendo únicamente la obligación de pago por los servicios efectivamente prestados y condiciones contratadas hasta la terminación del contrato, los cuales podrán ser recaudados por el prestador a través de los mecanismos y procedimiento legales correspondientes.',
 '[]'::JSONB, 'causales', NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 13, 'CLÁUSULA DÉCIMA TERCERA', 'Controversias',
 'Las diferencias que surjan de la ejecución del presente contrato, podrán ser resueltas por mutuo acuerdo entre las partes, sin perjuicio de que el Abonado acuda con su reclamo, queja o denuncia, ante las autoridades administrativas que correspondan. De no llegarse a una solución, cualquiera de las partes podrá acudir ante los jueces competentes. No obstante, lo indicado las partes pueden pactar adicionalmente, someter sus controversias ante un centro de mediación o arbitraje, si así lo deciden expresamente, en cuyo caso el Abonado deberá señalarlo en forma expresa.',
 NULL, NULL,
 to_jsonb(ARRAY[
   'El Abonado, en caso de conflicto, acepta someterse a la mediación o arbitraje (puede significar costos en los que debe incurrir el Abonado – No aplica a Empresas Públicas prestadoras de servicios de telecomunicaciones)'
 ]), NULL, NULL, 'arbitraje', 'Firma de aceptación-sujeción a arbitraje:', TRUE, NULL, NULL),

(NULL, 14, 'CLAUSULA DECIMA CUARTA', 'Notificaciones y Domicilio',
 'Las notificaciones que corresponda, serán entregadas en el domicilio de cada una de las partes señalado en la cláusula primera del presente contrato. Cualquier cambio de domicilio debe ser comunicado por escrito a la otra parte en un plazo de 10 días, a partir del día siguiente en que el cambio se efectúe.',
 NULL, NULL, '[]'::JSONB, NULL, NULL, NULL, NULL, FALSE, NULL, NULL),

(NULL, 15, 'CLAUSULA DECIMA QUINTA', 'Empaquetamiento de servicios',
 'La contratación incluye empaquetamiento de servicios:',
 NULL, NULL, '[]'::JSONB, 'paquetes', NULL, 'empaquetamiento', NULL, FALSE, NULL, NULL)
) AS v
WHERE NOT EXISTS (SELECT 1 FROM clausulas_contrato WHERE prestador_id IS NULL);


-- =============================================================================
-- Copiar el modelo base a un prestador, para que lo edite
-- =============================================================================
/**
 * ── Por qué se copia en vez de editar el base ──
 *
 * Porque el base es de dónde parten todos. Un ISP que lo edite directamente le
 * cambiaría el contrato a los demás — y en una instalación con dos prestadores,
 * como pasa acá, eso significa que el segundo firmaría con el modelo del
 * primero.
 *
 * Copiar deja al que edita con su propio juego y al base intacto para el
 * siguiente.
 */
CREATE OR REPLACE FUNCTION copiar_modelo_a_prestador(p_prestador UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_n INT;
BEGIN
    IF p_prestador IS NULL THEN
        RAISE EXCEPTION 'Falta decir a qué prestador copiarle el modelo';
    END IF;

    -- Reejecutarlo no duplica: si ya tiene cláusulas propias, se deja como está.
    IF EXISTS (SELECT 1 FROM clausulas_contrato WHERE prestador_id = p_prestador) THEN
        RETURN 0;
    END IF;

    INSERT INTO clausulas_contrato
        (prestador_id, orden, numeral, titulo, texto, cierre, cierre2, numerales,
         bloque, bloque_final, condicion, etiqueta_condicion, raya_firma,
         lista_titulo, lista_campo, activa)
    SELECT p_prestador, orden, numeral, titulo, texto, cierre, cierre2, numerales,
           bloque, bloque_final, condicion, etiqueta_condicion, raya_firma,
           lista_titulo, lista_campo, activa
      FROM clausulas_contrato
     WHERE prestador_id IS NULL
     ORDER BY orden;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;


-- =============================================================================
-- Qué cláusulas le tocan a cada prestador
-- =============================================================================
/**
 * Las propias si las tiene; si no, las del modelo base.
 *
 * `es_propia` le dice a la pantalla si está mirando su modelo o el que trae el
 * sistema — sin eso, alguien editaría creyendo que cambia el suyo y estaría
 * cambiando el de todos.
 */
CREATE OR REPLACE VIEW v_clausulas_prestador WITH (security_invoker = true) AS
SELECT
    p.id AS prestador_id,
    p.razon_social,
    c.id AS clausula_id,
    c.orden, c.numeral, c.titulo, c.texto, c.cierre, c.cierre2, c.numerales,
    c.bloque, c.bloque_final, c.condicion, c.etiqueta_condicion, c.raya_firma,
    c.lista_titulo, c.lista_campo, c.activa,
    (c.prestador_id IS NOT NULL) AS es_propia
FROM prestadores p
JOIN clausulas_contrato c
  ON c.prestador_id = p.id
 OR (c.prestador_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM clausulas_contrato x WHERE x.prestador_id = p.id))
WHERE c.activa
ORDER BY p.id, c.orden;

COMMENT ON VIEW v_clausulas_prestador IS
    'Las cláusulas que le corresponden a cada prestador: las suyas si las cargó, o las del modelo base.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- El modelo base:
--   SELECT orden, numeral, titulo FROM clausulas_contrato
--    WHERE prestador_id IS NULL ORDER BY orden;
--
--   -- Qué usa cada prestador hoy:
--   SELECT razon_social, COUNT(*) AS clausulas, BOOL_OR(es_propia) AS tiene_el_suyo
--     FROM v_clausulas_prestador GROUP BY razon_social;
--
--   -- Darle su propio juego a uno para que lo edite:
--   SELECT copiar_modelo_a_prestador('<id del prestador>');
