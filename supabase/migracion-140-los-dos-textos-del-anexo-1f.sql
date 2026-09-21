-- =============================================================================
-- Migración 140 — Los dos textos del anexo 1f que son del ISP
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente: se puede volver a ejecutar sin romper nada.
--
-- ── Qué se estaba imprimiendo mal ──
--
-- Al comparar el PDF generado contra el modelo del Excel, línea por línea, doce
-- textos del anexo 1f no coincidían. Diez eran la estructura de la tabla de
-- tarifas —ya corregida en el generador—. Los otros dos son datos del ISP que no
-- teníamos dónde guardar, y por eso salían con un texto inventado:
--
--   BENEFICIO POR PERMANENCIA. El modelo dice "INSTALACIÓN GRATIS", que no es lo
--   mismo que la lista de beneficios de la cláusula quinta. Son dos campos
--   distintos del formulario: la cláusula enumera qué gana el abonado por
--   quedarse, y el anexo dice el beneficio concreto que se le acredita.
--
--   COSTO DE NO CUMPLIRLA. "EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN". Es la
--   consecuencia económica de irse antes, y cada ISP la redacta a su manera —hay
--   quien cobra el equipo, quien prorratea—.
--
-- Ninguno de los dos se puede inventar: son las dos frases del anexo que dicen
-- qué gana y qué pierde el abonado según cuánto se quede.
-- =============================================================================

ALTER TABLE prestadores
    ADD COLUMN IF NOT EXISTS beneficio_anexo TEXT,
    ADD COLUMN IF NOT EXISTS costo_no_permanencia TEXT;

COMMENT ON COLUMN prestadores.beneficio_anexo IS
    'El beneficio concreto que el anexo 1f acredita por la permanencia mínima. Distinto de la lista de la cláusula quinta.';

COMMENT ON COLUMN prestadores.costo_no_permanencia IS
    'Qué paga el abonado si no acepta la permanencia mínima o no la completa.';

/**
 * Se completan solo los que están vacíos.
 *
 * Es la misma regla de siempre: el ISP los va a editar desde la pantalla, y una
 * migración que se reejecuta no puede devolverle el texto de fábrica.
 */
UPDATE prestadores SET
    beneficio_anexo = COALESCE(beneficio_anexo, 'INSTALACIÓN GRATIS'),
    costo_no_permanencia = COALESCE(
        costo_no_permanencia,
        'EL ABONADO PAGARÁ EL COSTO DE INSTALACIÓN (Se detalla en "Tarifas")'
    );


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT razon_social, beneficio_anexo, costo_no_permanencia FROM prestadores;
