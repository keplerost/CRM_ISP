-- =============================================================================
-- Migración 181 — El descuento que se acuerda en plata, no en porcentaje
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run.
-- Es idempotente: se puede volver a correr sin romper nada.
--
-- ── Por qué hace falta un tercer descuento ──
--
-- Ya hay dos, y ninguno sirve para esto:
--
--   · El de GRUPO PRIORITARIO (tercera edad, discapacidad) es de ley, es un
--     porcentaje fijado por norma y no se negocia.
--   · La PROMOCIÓN comercial es un porcentaje y VENCE a los N meses.
--
-- Lo que falta es el acuerdo puntual: el abonado antiguo que vuelve y pide que
-- se le respete lo que pagaba antes. Eso no es un porcentaje redondo ni una
-- promoción con fecha de fin — es un importe, y es para siempre hasta que
-- alguien lo saque.
--
-- El caso que lo origina, textual: «el cliente pagaba 23 pero por el IVA subió
-- a 23.10, esos 10 centavos se los ponemos en el descuento y la factura le sale
-- en $23 incluido IVA».
--
-- ── Por qué el importe es sobre el TOTAL y no sobre la base ──
--
-- Porque es lo que la persona tiene en la cabeza cuando lo carga: «que le
-- quede en 23». Nadie negocia sobre la base imponible.
--
-- Y la diferencia no es teórica. Con IVA del 15% sobre un precio de 23.10:
--
--   base = 23.10 / 1.15 = 20.09      total sin descuento = 23.10
--
--   Restando 0.10 a la BASE:   (20.09 − 0.10) × 1.15 = 22.99   ← un centavo de menos
--   Calculando hacia atrás:    objetivo 23.00 → base gravada 20.00 → total 23.00  ✓
--
-- Un centavo por factura, por abonado, todos los meses. Y peor que la plata: el
-- abonado que pidió pagar 23 recibe una factura de 22.99 y llama a preguntar.
--
-- El cálculo vive en el middleware (`repartirImpuesto`), no acá: esta migración
-- solo guarda el importe acordado.
-- =============================================================================


-- =============================================================================
-- 1. El importe acordado y por qué se acordó
-- =============================================================================
ALTER TABLE clientes
    /**
     * Cuánto se le baja del TOTAL de cada factura, con IVA ya incluido.
     *
     * NULL y 0 significan lo mismo —sin descuento— pero se deja NULL como
     * "nunca se configuró" para distinguirlo de "se configuró en cero", que es
     * lo que queda cuando alguien lo saca. En los informes se lee distinto.
     */
    ADD COLUMN IF NOT EXISTS descuento_fijo NUMERIC(10,2),

    /**
     * Por qué. No es opcional en la práctica.
     *
     * Un importe suelto en la ficha, sin explicación, dentro de seis meses no
     * lo puede justificar nadie: ni quien lo cargó se acuerda. Y es plata que
     * se deja de facturar todos los meses, así que en algún momento alguien va
     * a preguntar por qué este abonado paga menos.
     */
    ADD COLUMN IF NOT EXISTS descuento_fijo_motivo VARCHAR(160);

COMMENT ON COLUMN clientes.descuento_fijo IS
    'Importe fijo que se le descuenta del TOTAL de cada factura, con IVA incluido. El middleware calcula hacia atras cuanto sacarle a la base para que el total cierre exacto.';

COMMENT ON COLUMN clientes.descuento_fijo_motivo IS
    'Por que se le dio. Se muestra en la factura y es lo unico que justifica el descuento dentro de seis meses.';


-- =============================================================================
-- 2. Que no pueda ser negativo
-- =============================================================================
-- Un descuento negativo es un recargo, y un recargo cargado por accidente en el
-- campo del descuento le sube la factura a un abonado sin que nadie lo note.
-- Si algún día hacen falta recargos, van en su propio campo y con su propio
-- nombre en el papel.
ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_descuento_fijo_check;
ALTER TABLE clientes
    ADD CONSTRAINT clientes_descuento_fijo_check
    CHECK (descuento_fijo IS NULL OR descuento_fijo >= 0);


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   SELECT nombre, precio_mensual, descuento_fijo, descuento_fijo_motivo
--     FROM clientes
--    WHERE descuento_fijo IS NOT NULL AND descuento_fijo > 0;
--
--   -- Lo que se deja de facturar por mes:
--   SELECT COALESCE(SUM(descuento_fijo), 0) AS resignado_por_mes
--     FROM clientes
--    WHERE estado = 'activo' AND descuento_fijo > 0;
