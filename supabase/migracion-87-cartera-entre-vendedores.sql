-- =============================================================================
-- Migración 87 — Cada vendedor ve lo suyo
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
--
-- ── El agujero ──
--
-- La migración 70 cerró la cartera de ABONADOS: el vendedor pierde al cliente
-- cuando la venta se activa. Eso funciona.
--
-- Lo que quedó abierto es todo lo de ANTES de que sean clientes. Se comprobó
-- creando un vendedor nuevo, sin un solo prospecto propio, y preguntándole a la
-- base con su token:
--
--     ve 16 prospectos ajenos, con nombre y teléfono
--     ¿puede EDITARLOS?  SÍ
--     ¿puede BORRARLOS?  SÍ
--
-- La lista de prospectos ES la base comercial. Que un vendedor se la lleve
-- entera —o se la borre a otro— es el mismo problema del que se venía
-- cuidando, por una puerta que no se había mirado.
--
-- ── De dónde viene ──
--
-- No fue un descuido de la 70: fue una decisión de la 67, escrita cuando el
-- módulo comercial recién nacía, y que decía esto en su comentario:
--
--     "acá no hay ningún escalón de privilegio que proteger: lo peor que puede
--      hacer alguien es cargar un prospecto de más"
--
-- Era razonable entonces y dejó de serlo cuando el módulo creció: hoy esas
-- tablas tienen teléfonos, montos, motivos de pérdida y las metas de cada uno.
--
-- ── Por qué no se notaba ──
--
-- Porque hay un solo vendedor cargado. Con uno solo, "todos los prospectos" y
-- "mis prospectos" son el mismo conjunto y el sistema se ve perfecto. El día que
-- entre el segundo, cada uno abre la app con la cartera del otro adentro.
-- =============================================================================


-- =============================================================================
-- 1. Quién puede ver más allá de lo suyo
-- =============================================================================
-- El permiso ya existe: `ventas.equipo` — "Ver el equipo completo y fijar
-- metas". Es exactamente esta distinción, así que no se inventa nada nuevo.
CREATE OR REPLACE FUNCTION ve_todo_el_equipo()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (SELECT permisos ? '*' OR permisos ? 'ventas.equipo'
           FROM usuarios_sistema WHERE auth_id = auth.uid() AND activo LIMIT 1),
        -- Sin legajo se permite, igual que el resto de los ayudantes: una
        -- instalación sin la migración 66 no puede quedarse sin módulo comercial.
        TRUE
    )
$$;

COMMENT ON FUNCTION ve_todo_el_equipo IS
    'TRUE para quien dirige el equipo comercial. El vendedor raso ve solo lo suyo.';


-- =============================================================================
-- 2. Prospectos
-- =============================================================================
-- La regla nueva tiene tres partes y las tres importan:
--
--   1. Administración ve todo, siempre.
--   2. Quien dirige el equipo ve lo del equipo, pero NO lo archivado — eso sigue
--      siendo cartera de abonados y se rige por la 70.
--   3. El vendedor ve lo suyo y no archivado.
--
-- ── Los huérfanos ──
--
-- Un prospecto sin `vendedor_id` ni `creado_por` —cargado por un script, o de
-- antes de que existiera el campo— no es de nadie. Con la regla nueva lo verían
-- solo administración y quien dirige el equipo, que son justamente los que
-- pueden asignarlo. Dejarlo visible para todos sería mantener el agujero abierto
-- para el caso más fácil de provocar: crear un prospecto sin dueño.
DROP POLICY IF EXISTS prospectos_personal  ON prospectos;
DROP POLICY IF EXISTS prospectos_lectura   ON prospectos;
DROP POLICY IF EXISTS prospectos_escritura ON prospectos;

CREATE POLICY prospectos_lectura ON prospectos
    FOR SELECT TO authenticated
    USING (
        cartera_completa()
        OR (
            archivado_en IS NULL
            AND (
                ve_todo_el_equipo()
                OR vendedor_id = mi_legajo_id()
                OR creado_por  = mi_legajo_id()
            )
        )
    );

-- Escribir sigue la misma regla. Va con `FOR ALL` —que incluye DELETE— porque
-- el vendedor tiene que poder corregir y descartar lo suyo; lo que ya no puede
-- es tocar lo ajeno, que era la mitad más grave del agujero.
CREATE POLICY prospectos_escritura ON prospectos
    FOR ALL TO authenticated
    USING (
        cartera_completa()
        OR (
            archivado_en IS NULL
            AND (
                ve_todo_el_equipo()
                OR vendedor_id = mi_legajo_id()
                OR creado_por  = mi_legajo_id()
            )
        )
    )
    WITH CHECK (
        cartera_completa()
        OR (
            archivado_en IS NULL
            AND (
                ve_todo_el_equipo()
                -- Al crear uno nuevo se exige que quede a nombre de quien lo
                -- crea. Sin esto, un vendedor podría cargar prospectos a nombre
                -- de otro y después "descubrirlos" en la lista del otro.
                OR vendedor_id = mi_legajo_id()
                OR creado_por  = mi_legajo_id()
            )
        )
    );


-- =============================================================================
-- 3. Lo que cuelga del prospecto
-- =============================================================================
-- Las actividades —llamadas, visitas, seguimientos— son el detalle de la
-- gestión: con quién habló, qué le dijeron, cuándo vuelve. Tenían `USING (true)`.
--
-- No se les repite la regla: heredan la del prospecto. Así, el día que la de
-- arriba cambie, esta cambia sola. Repetirla sería garantizar que dentro de seis
-- meses digan cosas distintas.
DROP POLICY IF EXISTS prospecto_actividades_personal ON prospecto_actividades;
DROP POLICY IF EXISTS prospecto_actividades_acceso   ON prospecto_actividades;

CREATE POLICY prospecto_actividades_acceso ON prospecto_actividades
    FOR ALL TO authenticated
    USING (prospecto_id IN (SELECT id FROM prospectos))
    WITH CHECK (prospecto_id IN (SELECT id FROM prospectos));

-- `expedientes` y `expediente_documentos` (migración 72) ya heredaban así, con
-- la misma subconsulta. No hay que tocarlos: quedan bien solos.


-- =============================================================================
-- 4. Metas
-- =============================================================================
-- La meta de un vendedor es su número: cuánto le pidieron y cuánto lleva.
-- Estaba abierta, y eso convierte el tablero en un ranking — que es
-- exactamente lo que el diseño del rol quiso evitar cuando se decidió no darle
-- `ventas.equipo` al vendedor.
DROP POLICY IF EXISTS metas_venta_personal ON metas_venta;
DROP POLICY IF EXISTS metas_venta_lectura  ON metas_venta;
DROP POLICY IF EXISTS metas_venta_escritura ON metas_venta;

CREATE POLICY metas_venta_lectura ON metas_venta
    FOR SELECT TO authenticated
    USING (cartera_completa() OR ve_todo_el_equipo() OR vendedor_id = mi_legajo_id());

-- Fijar la meta NO es cosa del vendedor. Sin esta separación, el medido elige
-- la vara: bastaba con bajarse la meta para llegar siempre.
CREATE POLICY metas_venta_escritura ON metas_venta
    FOR ALL TO authenticated
    USING (cartera_completa() OR ve_todo_el_equipo())
    WITH CHECK (cartera_completa() OR ve_todo_el_equipo());


-- =============================================================================
-- 5. Verificaciones de cobertura
-- =============================================================================
-- Cada consulta lleva dirección y coordenadas de alguien que preguntó por
-- servicio. Es una lista de interesados con domicilio: cartera en formato crudo.
DROP POLICY IF EXISTS verificaciones_cobertura_personal ON verificaciones_cobertura;
DROP POLICY IF EXISTS verificaciones_cobertura_acceso   ON verificaciones_cobertura;

CREATE POLICY verificaciones_cobertura_acceso ON verificaciones_cobertura
    FOR ALL TO authenticated
    USING (
        cartera_completa()
        OR ve_todo_el_equipo()
        -- La columna se llama `verificado_por`, no `creado_por`: la verificación
        -- la firma quien la hizo, que puede no ser quien cargó la fila.
        OR verificado_por = mi_legajo_id()
        -- Las atadas a un prospecto siguen al prospecto.
        OR prospecto_id IN (SELECT id FROM prospectos)
    )
    WITH CHECK (
        cartera_completa() OR ve_todo_el_equipo() OR verificado_por = mi_legajo_id()
    );


-- =============================================================================
-- 6. Zonas de cobertura: esta SÍ queda abierta para leer
-- =============================================================================
-- Hasta dónde llega la red no es información de nadie en particular: todo
-- vendedor la necesita para saber si puede vender en una calle, y no dice nada
-- de ningún cliente.
--
-- Lo que se cierra es escribirla. Que un vendedor pueda ampliar el polígono de
-- cobertura es que pueda vender donde no hay red, y esa promesa la termina
-- pagando el técnico que va a instalar algo imposible.
DROP POLICY IF EXISTS zonas_cobertura_personal   ON zonas_cobertura;
DROP POLICY IF EXISTS zonas_cobertura_lectura    ON zonas_cobertura;
DROP POLICY IF EXISTS zonas_cobertura_escritura  ON zonas_cobertura;

CREATE POLICY zonas_cobertura_lectura ON zonas_cobertura
    FOR SELECT TO authenticated USING (true);

CREATE POLICY zonas_cobertura_escritura ON zonas_cobertura
    FOR ALL TO authenticated
    USING (cartera_completa())
    WITH CHECK (cartera_completa());


-- =============================================================================
-- 7. Aviso sobre lo que ya está cargado
-- =============================================================================
-- Un prospecto sin dueño deja de verlo el vendedor raso. Hoy no hay ninguno,
-- pero esta migración puede correrse en otra instalación donde sí los haya, y
-- ahí desaparecerían de la pantalla sin explicación.
DO $$
DECLARE
    v_huerfanos INT;
BEGIN
    SELECT COUNT(*) INTO v_huerfanos
      FROM prospectos
     WHERE vendedor_id IS NULL AND creado_por IS NULL AND archivado_en IS NULL;

    IF v_huerfanos > 0 THEN
        RAISE WARNING
            'Hay % prospectos sin vendedor ni creador. Desde ahora solo los ven administración y quien dirige el equipo. Asignalos en Ventas → Prospectos.',
            v_huerfanos;
    ELSE
        RAISE NOTICE 'Ningún prospecto quedó sin dueño: nadie pierde nada de vista.';
    END IF;
END $$;


-- =============================================================================
-- Cómo comprobar que quedó bien
-- =============================================================================
-- Entrando como un vendedor que no tenga prospectos propios:
--
--   SELECT count(*) FROM prospectos;    -- 0
--   SELECT count(*) FROM metas_venta;   -- solo la suya
--   DELETE FROM prospectos WHERE id = '<uno ajeno>';   -- 0 filas
--
-- Y como supervisor de ventas —que tiene `ventas.equipo`— tiene que seguir
-- viendo los de todo el equipo.
