-- =============================================================================
-- Migración 05 — Datos del emisor que aparecen en el RIDE
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente.
--
-- El XML del SRI no lleva teléfono, correo ni logo del emisor, pero el RIDE
-- —la hoja que recibe el abonado— sí los muestra. Y el bloque de "Información
-- Adicional" cambia todos los meses (período facturado y fecha máxima de pago),
-- así que se guarda como plantilla con variables y se resuelve al emitir.
-- =============================================================================

ALTER TABLE sri_config
    ADD COLUMN IF NOT EXISTS telefono   VARCHAR(30),
    ADD COLUMN IF NOT EXISTS email      VARCHAR(200),
    -- Logo en base64 (data URL o base64 puro). Va en la base y no en un archivo
    -- para que el middleware siga siendo sin estado: se puede reinstalar sin
    -- perder la imagen.
    ADD COLUMN IF NOT EXISTS logo_b64   TEXT,

    -- Texto de "Información Adicional" con variables entre llaves.
    -- Las que se pueden usar están en middleware/src/sri/periodo.js.
    ADD COLUMN IF NOT EXISTS plantilla_info_adicional TEXT,

    -- Día del mes hasta el que se puede pagar sin corte.
    ADD COLUMN IF NOT EXISTS dia_maximo_pago INT DEFAULT 5
        CHECK (dia_maximo_pago BETWEEN 1 AND 28),

    -- 0 = se factura el mes en curso, -1 = el mes anterior (facturación vencida).
    ADD COLUMN IF NOT EXISTS meses_desplazado INT DEFAULT 0
        CHECK (meses_desplazado BETWEEN -1 AND 0);

COMMENT ON COLUMN sri_config.plantilla_info_adicional IS
    'Texto del bloque Información Adicional del comprobante. Admite {periodo_desde}, {periodo_hasta}, {fecha_maxima_pago}, {mes}, {anio}, {telefono}, {cliente}, {plan}.';

COMMENT ON COLUMN sri_config.meses_desplazado IS
    '0 = factura el mes en curso; -1 = factura el mes anterior (facturación vencida).';
