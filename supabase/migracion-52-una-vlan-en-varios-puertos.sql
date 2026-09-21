-- =============================================================================
-- Migración 52 — Una VLAN puede estar en varios puertos
-- =============================================================================
-- La 48 guardó la relación puerto → VLAN adentro de `vlans_olt`, con la VLAN
-- como clave: UNIQUE (olt_id, vlan). Eso dice dos cosas, y solo una es cierta:
--
--     un puerto tiene UNA VLAN predeterminada    ✔ cierto
--     una VLAN es la de UN SOLO puerto           ✘ falso
--
-- En esta OLT la VLAN 200 es la de los siete puertos que tienen abonados. Con
-- la clave puesta en la VLAN, anotar los siete escribía siete veces la misma
-- fila: quedaba el último y los otros seis desaparecían en silencio. El
-- importador informaba "7 importadas" y en la base había una.
--
-- El error no era el conteo. Era que seis puertos quedaban sin VLAN
-- predeterminada, y un alta en cualquiera de ellos no podía deducir su segmento.
--
-- La relación se muda a su propia tabla, con la clave donde corresponde: el
-- puerto. `vlans_olt` se queda con lo que sí es de la VLAN —para qué sirve y
-- cómo se llama— y deja de hablar de puertos.
-- =============================================================================

CREATE TABLE IF NOT EXISTS puertos_pon (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    olt_id      UUID NOT NULL REFERENCES olts(id) ON DELETE CASCADE,
    slot        INT NOT NULL,
    puerto      INT NOT NULL,

    -- La VLAN que este puerto usa por defecto. No es una FK a vlans_olt: el
    -- equipo puede estar usando una VLAN que nadie anotó todavía, y negarse a
    -- registrar el puerto por eso sería perder el dato que más cuesta conseguir.
    vlan        INT CHECK (vlan IS NULL OR vlan BETWEEN 1 AND 4094),

    descripcion TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Un puerto, una fila. Dos filas diciendo cosas distintas del mismo puerto
    -- es una contradicción que el sistema tendría que resolver adivinando, y
    -- adivinaría distinto según cómo ordene la base.
    UNIQUE (olt_id, slot, puerto)
);

CREATE INDEX IF NOT EXISTS idx_puertos_pon_olt  ON puertos_pon (olt_id);
CREATE INDEX IF NOT EXISTS idx_puertos_pon_vlan ON puertos_pon (olt_id, vlan) WHERE vlan IS NOT NULL;

COMMENT ON TABLE puertos_pon IS
    'Qué VLAN usa por defecto cada puerto PON. Vive aparte de vlans_olt porque varios puertos pueden compartir una VLAN — en esta red la 200 es la de todos — y con la clave puesta en la VLAN solo se podía registrar uno.';


/**
 * Lo que ya estaba anotado, a su lugar nuevo. Son pocas filas y ninguna se
 * pierde: las que no tenían puerto no describían un puerto.
 *
 * ── Por qué va dentro de un bloque y con SQL dinámico ──
 *
 * Porque más abajo esta misma migración BORRA `vlans_olt.slot` y
 * `vlans_olt.puerto`. La segunda vez que alguien corra este archivo, esas
 * columnas ya no existen y un `SELECT slot FROM vlans_olt` ni siquiera llega a
 * ejecutarse: falla al analizarse, y se lleva puesta la migración entera.
 *
 * Con la comprobación delante, la copia se hace solo mientras haya algo que
 * copiar. Y el `EXECUTE` es lo que permite que el SQL se analice recién cuando
 * corresponde: escrito directo, Postgres lo revisa al leer el archivo, exista o
 * no la columna.
 */
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'vlans_olt' AND column_name = 'slot'
    ) THEN
        EXECUTE $copia$
            INSERT INTO puertos_pon (olt_id, slot, puerto, vlan, descripcion)
            SELECT olt_id, slot, puerto, vlan, descripcion
            FROM vlans_olt
            WHERE slot IS NOT NULL AND puerto IS NOT NULL
            ON CONFLICT (olt_id, slot, puerto) DO NOTHING
        $copia$;
    ELSE
        RAISE NOTICE 'vlans_olt ya no tiene slot/puerto: la migración de datos ya se hizo.';
    END IF;
END $$;

-- La vista vieja lee `vlans_olt.slot`, así que hay que soltarla antes de quitar
-- la columna. Se vuelve a crear más abajo leyendo de la tabla nueva; entre las
-- dos operaciones no existe, y por eso van en la misma migración.
DROP VIEW IF EXISTS v_vlan_por_puerto;

-- Y `vlans_olt` deja de hablar de puertos. Dejarlas ahí sin uso sería tener el
-- dato en dos lados, que es cómo se termina con dos respuestas distintas a la
-- misma pregunta.
DROP INDEX IF EXISTS idx_vlans_olt_puerto;
ALTER TABLE vlans_olt DROP COLUMN IF EXISTS slot;
ALTER TABLE vlans_olt DROP COLUMN IF EXISTS puerto;

COMMENT ON TABLE vlans_olt IS
    'Para qué usa el ISP cada VLAN de una OLT. La existencia de la VLAN se lee del equipo; esto es lo que la explica. De qué puerto es la predeterminada vive en puertos_pon.';


-- -----------------------------------------------------------------------------
-- La cadena completa, ahora desde el puerto
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_vlan_por_puerto;
CREATE VIEW v_vlan_por_puerto WITH (security_invoker = true) AS
SELECT
    p.olt_id,
    o.nombre        AS olt,
    p.slot,
    p.puerto,
    p.vlan,
    v.uso,
    COALESCE(p.descripcion, v.descripcion) AS descripcion,

    s.id            AS subred_id,
    s.nombre        AS subred,
    s.cidr,
    s.tipo          AS subred_tipo,
    s.gateway,
    s.pool_router,
    s.router_id,
    r.nombre        AS router,

    (SELECT COUNT(*) FROM ip_addresses i
      WHERE i.ip_address::INET << network(s.cidr))     AS anotadas,
    CASE WHEN s.cidr IS NULL THEN NULL
         ELSE (2 ^ (32 - masklen(s.cidr)) - 2)::INT END AS direcciones_del_bloque,

    (s.id IS NULL)  AS sin_subred
FROM puertos_pon p
JOIN olts o                  ON o.id = p.olt_id
LEFT JOIN vlans_olt v        ON v.olt_id = p.olt_id AND v.vlan = p.vlan
LEFT JOIN subredes s         ON s.vlan = p.vlan
                            AND s.activo
                            AND (s.olt_id = p.olt_id OR s.olt_id IS NULL)
LEFT JOIN routers_mikrotik r ON r.id = s.router_id
WHERE p.vlan IS NOT NULL;

COMMENT ON VIEW v_vlan_por_puerto IS
    'Puerto PON → VLAN → subred. Es lo que consulta el paso de red de una instalación para no preguntarle nada al técnico.';


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
-- Explícito y fuera de bloques DO: el analizador de Supabase no lee adentro de
-- un EXECUTE y reporta la tabla como si quedara sin RLS.

ALTER TABLE puertos_pon ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all_puertos_pon" ON puertos_pon;
CREATE POLICY "auth_all_puertos_pon" ON puertos_pon
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
