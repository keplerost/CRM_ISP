-- =============================================================================
-- Migración 20 — Bolsa de números libres
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Es idempotente.
--
-- El secuencial se consume al ARMAR el comprobante, no al enviarlo. Si después
-- hay que corregir un valor, ese número queda gastado aunque el SRI nunca haya
-- visto el comprobante.
--
-- Y ahí está la clave: el SRI solo conoce lo que recibió. Un número que se
-- reservó acá y nunca se transmitió está libre desde su punto de vista, así que
-- se puede devolver y reutilizar.
--
-- Reutilizar uno que el SRI SÍ recibió sería grave —rechaza el duplicado y el
-- comprobante nuevo se pierde—, por eso liberar está restringido a los que
-- nunca salieron.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sri_secuenciales_libres (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo_doc        VARCHAR(2) NOT NULL,
    establecimiento VARCHAR(3) NOT NULL,
    punto_emision   VARCHAR(3) NOT NULL,
    numero          BIGINT NOT NULL,

    motivo          TEXT,
    document_id     UUID REFERENCES electronic_documents(id) ON DELETE SET NULL,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- El mismo número no puede estar dos veces en la bolsa.
    UNIQUE (tipo_doc, establecimiento, punto_emision, numero)
);

COMMENT ON TABLE sri_secuenciales_libres IS
    'Números reservados que nunca llegaron al SRI. La próxima emisión los toma antes de pedir uno nuevo.';


-- =============================================================================
-- El secuencial sale primero de la bolsa
-- =============================================================================
-- Se toma el más chico para que la numeración quede lo más ordenada posible.
-- `FOR UPDATE SKIP LOCKED` evita que dos emisiones simultáneas se lleven el
-- mismo número: la segunda salta la fila bloqueada y sigue de largo.
CREATE OR REPLACE FUNCTION sri_next_secuencial(
    p_tipo  TEXT,
    p_estab TEXT DEFAULT '001',
    p_pto   TEXT DEFAULT '001'
)
RETURNS BIGINT AS $$
DECLARE
    v_numero BIGINT;
BEGIN
    DELETE FROM sri_secuenciales_libres
     WHERE id = (
         SELECT id
           FROM sri_secuenciales_libres
          WHERE tipo_doc = p_tipo
            AND establecimiento = p_estab
            AND punto_emision = p_pto
          ORDER BY numero
            FOR UPDATE SKIP LOCKED
          LIMIT 1
     )
    RETURNING numero INTO v_numero;

    IF v_numero IS NOT NULL THEN
        RETURN v_numero;
    END IF;

    -- Sin números libres, se sigue como siempre: el UPDATE ... RETURNING
    -- resuelve el incremento y la lectura bajo el lock de la fila.
    UPDATE sri_sequences
       SET ultimo_numero = ultimo_numero + 1
     WHERE tipo_doc = p_tipo
       AND establecimiento = p_estab
       AND punto_emision = p_pto
    RETURNING ultimo_numero INTO v_numero;

    IF v_numero IS NULL THEN
        INSERT INTO sri_sequences (tipo_doc, establecimiento, punto_emision, ultimo_numero)
        VALUES (p_tipo, p_estab, p_pto, 1)
        RETURNING ultimo_numero INTO v_numero;
    END IF;

    RETURN v_numero;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sri_next_secuencial IS
    'Devuelve el siguiente secuencial: primero uno liberado, si lo hay, y si no incrementa el contador. Siempre usar esto en vez de leer y sumar por separado.';


-- =============================================================================
-- Devolver un número a la bolsa
-- =============================================================================
CREATE OR REPLACE FUNCTION sri_liberar_secuencial(
    p_document_id UUID,
    p_motivo      TEXT DEFAULT NULL
)
RETURNS BIGINT AS $$
DECLARE
    d electronic_documents%ROWTYPE;
BEGIN
    SELECT * INTO d FROM electronic_documents WHERE id = p_document_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese comprobante';
    END IF;

    -- Un comprobante autorizado quedó registrado en el SRI para siempre: su
    -- número no vuelve nunca.
    IF d.estado = 'AUTORIZADO' OR d.numero_autorizacion IS NOT NULL THEN
        RAISE EXCEPTION 'El comprobante % está autorizado: su número no se puede reutilizar', d.clave_acceso;
    END IF;

    -- ENVIADO o NO_AUTORIZADO significa que el SRI lo recibió y lo tiene
    -- registrado con esa clave de acceso. Reutilizar el número haría que
    -- rechace el comprobante nuevo por duplicado.
    IF d.estado IN ('ENVIADO', 'NO_AUTORIZADO') THEN
        RAISE EXCEPTION 'El comprobante % llegó al SRI (estado %): su número no se puede reutilizar', d.clave_acceso, d.estado;
    END IF;

    INSERT INTO sri_secuenciales_libres (
        tipo_doc, establecimiento, punto_emision, numero, motivo, document_id
    )
    VALUES (
        d.tipo_doc, d.establecimiento, d.punto_emision, d.secuencial::BIGINT,
        COALESCE(p_motivo, 'Comprobante anulado antes de enviarse'), d.id
    )
    ON CONFLICT (tipo_doc, establecimiento, punto_emision, numero) DO NOTHING;

    UPDATE electronic_documents
       SET estado = 'ANULADO',
           mensaje_autorizacion = COALESCE(p_motivo, 'Anulado antes de enviarse; su número volvió a la bolsa')
     WHERE id = d.id;

    RETURN d.secuencial::BIGINT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sri_liberar_secuencial IS
    'Devuelve a la bolsa el número de un comprobante que nunca llegó al SRI. Falla si el comprobante fue recibido o autorizado.';


-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE sri_secuenciales_libres ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_sri_secuenciales_libres" ON sri_secuenciales_libres;
CREATE POLICY "auth_all_sri_secuenciales_libres" ON sri_secuenciales_libres
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- =============================================================================
-- Recuperar lo que ya quedó colgado
-- =============================================================================
-- Los borradores que nunca se firmaron ni se enviaron: su número vuelve a la
-- bolsa. Los que se firmaron quedan afuera —hay que confirmar con el SRI que no
-- los tiene antes de reutilizarlos—, y eso se hace desde la pantalla.
INSERT INTO sri_secuenciales_libres (
    tipo_doc, establecimiento, punto_emision, numero, motivo, document_id
)
SELECT d.tipo_doc, d.establecimiento, d.punto_emision, d.secuencial::BIGINT,
       'Borrador que nunca se envió', d.id
FROM electronic_documents d
WHERE d.estado = 'BORRADOR'
  AND d.numero_autorizacion IS NULL
ON CONFLICT (tipo_doc, establecimiento, punto_emision, numero) DO NOTHING;

UPDATE electronic_documents
   SET estado = 'ANULADO',
       mensaje_autorizacion = 'Borrador anulado; su número volvió a la bolsa'
 WHERE estado = 'BORRADOR'
   AND id IN (SELECT document_id FROM sri_secuenciales_libres WHERE document_id IS NOT NULL);
