-- =============================================================================
-- Migración 57 — El bucket de las fotos de los modelos de ONT
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- Requiere la migración 56. Es idempotente.
--
-- Va aparte de la 56 por la misma razón que los otros buckets: si el proyecto
-- no deja crearlos por SQL, el error tiraría abajo también las columnas. Si
-- falla, se crea a mano en Storage → New bucket, nombre `tipos-onu`, PÚBLICO.
--
-- Público, al revés que `documentos`. Acá no hay datos de nadie: es la foto de
-- un modelo de equipo, la misma que está en el catálogo del fabricante. Y
-- público significa que la imagen se muestra con un <img src> normal, sin pedir
-- una URL firmada cada vez que se abre la ficha de un abonado — que es donde se
-- va a ver, y se abre todo el día.
--
-- Se carga una vez por modelo y se ve en todos los abonados que lo tengan: el
-- técnico que atiende un reclamo ve de qué equipo le están hablando antes de
-- salir.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'tipos-onu', 'tipos-onu', TRUE,
    2097152,  -- 2 MB: la foto de un equipo, no un catálogo entero
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
    SET public             = EXCLUDED.public,
        file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Lectura para cualquiera: es lo que hace que la foto se vea sin firmar la URL.
DROP POLICY IF EXISTS "tipos_onu_leer" ON storage.objects;
CREATE POLICY "tipos_onu_leer" ON storage.objects
    FOR SELECT TO public
    USING (bucket_id = 'tipos-onu');

-- Subir y borrar, solo con sesión.
DROP POLICY IF EXISTS "tipos_onu_subir" ON storage.objects;
CREATE POLICY "tipos_onu_subir" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'tipos-onu');

DROP POLICY IF EXISTS "tipos_onu_reemplazar" ON storage.objects;
CREATE POLICY "tipos_onu_reemplazar" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id = 'tipos-onu');

DROP POLICY IF EXISTS "tipos_onu_borrar" ON storage.objects;
CREATE POLICY "tipos_onu_borrar" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'tipos-onu');


-- -----------------------------------------------------------------------------
-- Cada ONU con su modelo resuelto
-- -----------------------------------------------------------------------------
-- El vínculo `onus.tipo_ont_id` casi nunca está puesto: las ONUs se dan de alta
-- con el modelo que reporta el equipo, como texto. Resolverlo por ese texto es
-- lo que permite mostrar la foto sin tener que enlazar noventa filas a mano.
--
-- Se prefiere el vínculo explícito cuando existe: si alguien lo corrigió a
-- mano, sabe más que el texto que reportó la ONT.
DROP VIEW IF EXISTS v_onu_tipo;
CREATE VIEW v_onu_tipo WITH (security_invoker = true) AS
SELECT
    o.id AS onu_id,
    o.sn,
    o.modelo AS modelo_reportado,
    t.id     AS tipo_id,
    t.marca,
    t.modelo,
    t.imagen_url,
    t.puertos_ethernet,
    t.wifi_ssids,
    t.puertos_fxs,
    t.catv,
    t.capacidad,
    t.soporta_tr069,
    (o.tipo_ont_id IS NOT NULL) AS enlazado_a_mano
FROM onus o
LEFT JOIN tipos_ont t
       ON t.id = o.tipo_ont_id
       OR (o.tipo_ont_id IS NULL AND UPPER(t.modelo) = UPPER(o.modelo));

COMMENT ON VIEW v_onu_tipo IS
    'Cada ONU con las características de su modelo. El modelo se resuelve por el vínculo explícito si existe y, si no, por el texto que reportó el equipo — que es lo que hay en la práctica.';


-- -----------------------------------------------------------------------------
-- La ficha de la ONU, con el WiFi que se le configuró
-- -----------------------------------------------------------------------------
-- `v_onus_clientes` enumera sus columnas una por una, así que las que agregó la
-- migración 55 —ssid, clave_wifi, configurada_por— no llegan a la pantalla. Sin
-- esto, el WiFi que el técnico cargó a mano queda guardado y no se puede ver, y
-- el soporte sigue sin poder contestar la pregunta más frecuente: "¿cuál es mi
-- clave?".
DROP VIEW IF EXISTS v_onus_clientes;
CREATE VIEW v_onus_clientes WITH (security_invoker = true) AS
SELECT
    u.id                AS onu_id,
    u.olt_id,
    o.nombre            AS olt,
    o.numero            AS olt_numero,
    u.sn,
    u.frame,
    u.slot,
    u.puerto,
    u.onu_index,
    u.estado            AS onu_estado,
    u.causa_caida,
    u.causa_caida_cruda,
    u.ultima_caida,
    u.rx_power_dbm,
    u.tx_power_dbm,
    u.distancia_m,
    u.ultima_lectura,
    u.autorizada_at,
    u.created_at,

    -- El nombre que tiene anotado la OLT en la descripción de la ONT.
    u.nombre_cliente    AS nombre_en_la_olt,
    u.descripcion_olt,
    u.direccion,
    u.contacto,
    u.zona,
    u.odb,
    u.modelo,
    u.vlan,
    u.line_profile_olt,
    u.srv_profile_olt,
    u.srv_profile_nombre,
    u.ficha_leida_at,

    -- Lo que se le configuró al equipo. La clave del WiFi es la consulta más
    -- frecuente del soporte y hasta ahora no estaba en ninguna pantalla.
    u.ssid,
    u.clave_wifi,
    u.configurada_por,
    u.configurada_at,

    u.plan_id           AS plan_id_onu,
    u.plan_velocidad,

    c.id                AS client_id,
    c.nombre            AS cliente,
    c.identificacion,
    c.estado            AS cliente_estado,
    c.origen            AS cliente_origen,
    c.plan_id,
    p.nombre            AS plan,
    p.bajada_kbps,
    p.subida_kbps,

    -- Una ONT que sirve a alguien que no está en el sistema: hay servicio dado
    -- y nadie a quien facturarle.
    (c.id IS NULL)      AS sin_abonado,

    -- Señal por debajo del umbral del taller. Se calcula acá para que la regla
    -- viva en un solo lugar y no en cada pantalla que quiera preguntarla.
    (u.rx_power_dbm IS NOT NULL AND u.rx_power_dbm < -27) AS senal_baja,

    -- Cómo se escribe su ubicación en el equipo: gpon-onu_0/6/9:17.
    'gpon-onu_' || u.frame || '/' || u.slot || '/' || u.puerto || ':' || u.onu_index AS ruta_onu
FROM onus u
LEFT JOIN olts o              ON o.id = u.olt_id
LEFT JOIN clientes c          ON c.onu_id = u.id
LEFT JOIN planes_velocidad p  ON p.id = COALESCE(c.plan_id, u.plan_id);
