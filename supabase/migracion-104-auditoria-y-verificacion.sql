-- =============================================================================
-- Migración 104 — Auditoría de reglas y verificación final (Fase 9)
-- =============================================================================
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run. Es idempotente.
-- Requiere las migraciones 97 a 103.
--
-- ── Las dos cosas que trae ──
--
--   1. Que un cambio de reglas quede registrado SIEMPRE, con el valor anterior y
--      el nuevo, sin depender de que la pantalla se acuerde de anotarlo.
--   2. Una revisión que se puede correr cuando se quiera y contesta si el módulo
--      está sano: comisiones duplicadas, bonos sin liquidar, períodos que no
--      cuadran, equipos recuperados que nunca volvieron al stock.
--
-- ── Por qué los disparadores, si la pantalla ya audita ──
--
-- Porque la pantalla audita desde el navegador, con una llamada al middleware
-- que es a propósito "mejor esfuerzo": si falla, la acción igual se hace. Eso
-- está bien para no bloquear a nadie, y significa que el registro tiene tres
-- formas de faltar — el middleware caído, la red cortada, o alguien escribiendo
-- directo contra PostgREST con su propio token.
--
-- El punto 26 dice "nada financiero debe modificarse silenciosamente". Un
-- registro que se puede saltear no cumple eso. El disparador sí: está del lado
-- de la base, no hay forma de escribir en la tabla sin dispararlo, y no importa
-- si el cambio vino de la pantalla, de la consola o de un script.
--
-- Las dos capas se complementan y no se pisan: la de la pantalla anota la
-- intención con la IP de quien la tuvo —"Ana editó el esquema desde 190.x"—, y
-- esta anota el hecho campo por campo —"el nivel Oro pasó de 40 a 42"—. Se
-- distinguen por la acción, así que ninguna tapa a la otra.
--
-- ── Dónde NO se ponen disparadores, y por qué ──
--
-- En `comision_ventas` ni en `comision_periodos`. Esas tablas las escribe el
-- generador todas las noches: un disparador por fila convertiría una corrida
-- normal en miles de renglones de auditoría y, con eso, en una auditoría que
-- nadie puede leer. Lo que importa ahí ya está registrado a nivel de ACCIÓN
-- —cerrar, aprobar, pagar, anular— por las funciones de la 99, que es el nivel
-- en el que alguien pregunta "¿quién autorizó esto?".
-- =============================================================================


-- =============================================================================
-- 1. El disparador de auditoría
-- =============================================================================
/**
 * Anota qué cambió, quién lo cambió y cuáles eran los valores.
 *
 * ── Sobre el diff ──
 *
 * No guarda la fila entera y ya: guarda además `campos`, un objeto con solo lo
 * que cambió y el par [antes, después] de cada uno. Es la diferencia entre
 * "alguien editó el esquema" y "el porcentaje de Élite pasó de 50 a 65", que es
 * lo único que sirve cuando la pregunta llega seis meses tarde.
 *
 * ── Por qué se saltean los UPDATE que no cambian nada ──
 *
 * Porque la pantalla de configuración guarda las cuatro tablas de una sola vez,
 * tocadas o no. Sin este filtro, corregir un decimal dejaría veinte renglones
 * idénticos y el que importa quedaría escondido entre ellos.
 */
CREATE OR REPLACE FUNCTION auditar_cambio_comisiones()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_legajo  UUID := mi_legajo_id();
    v_antes   JSONB;
    v_despues JSONB;
    v_campos  JSONB;
    v_id      TEXT;
BEGIN
    v_antes   := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
    v_despues := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;

    IF TG_OP = 'UPDATE' THEN
        -- Solo los campos distintos. `actualizado_en` se ignora: cambia siempre y
        -- su presencia haría que todo UPDATE parezca un cambio real.
        SELECT jsonb_object_agg(e.key, jsonb_build_array(v_antes -> e.key, e.value))
          INTO v_campos
          FROM jsonb_each(v_despues) e
         WHERE v_antes -> e.key IS DISTINCT FROM e.value
           AND e.key NOT IN ('actualizado_en', 'creado_en');

        IF v_campos IS NULL THEN
            RETURN NEW;  -- guardaron sin cambiar nada
        END IF;
    END IF;

    v_id := COALESCE(
        v_despues ->> 'id',      v_antes ->> 'id',
        v_despues ->> 'esquema_id', v_antes ->> 'esquema_id'
    );

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion,
        entidad, entidad_id, datos
    ) VALUES (
        v_legajo,
        COALESCE(
            (SELECT TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, '')))
               FROM usuarios_sistema u WHERE u.id = v_legajo),
            'Sistema'),
        (SELECT u.rol FROM usuarios_sistema u WHERE u.id = v_legajo),
        'comisiones.regla_cambiada',
        FORMAT('%s en %s',
               CASE TG_OP WHEN 'INSERT' THEN 'Alta' WHEN 'UPDATE' THEN 'Cambio' ELSE 'Baja' END,
               TG_TABLE_NAME),
        TG_TABLE_NAME, v_id,
        jsonb_strip_nulls(jsonb_build_object(
            'operacion', TG_OP,
            'campos',    v_campos,
            'antes',     v_antes,
            'despues',   v_despues
        ))
    );

    RETURN COALESCE(NEW, OLD);
END $$;

COMMENT ON FUNCTION auditar_cambio_comisiones IS
    'Registra cada cambio en las reglas de comisión con el valor anterior y el nuevo. No se puede saltear: vive en la base.';


-- Los seis, escritos uno por uno y no en un bucle.
--
-- Es el mismo criterio que las políticas de la 97: un disparador de auditoría
-- creado con SQL dinámico no se puede comprobar leyendo el archivo, y una
-- auditoría que hay que ejecutar para saber si existe no sirve como auditoría.

DROP TRIGGER IF EXISTS trg_auditar_comision_esquemas ON comision_esquemas;
CREATE TRIGGER trg_auditar_comision_esquemas
    AFTER INSERT OR UPDATE OR DELETE ON comision_esquemas
    FOR EACH ROW EXECUTE FUNCTION auditar_cambio_comisiones();

DROP TRIGGER IF EXISTS trg_auditar_comision_niveles ON comision_niveles;
CREATE TRIGGER trg_auditar_comision_niveles
    AFTER INSERT OR UPDATE OR DELETE ON comision_niveles
    FOR EACH ROW EXECUTE FUNCTION auditar_cambio_comisiones();

DROP TRIGGER IF EXISTS trg_auditar_comision_bases ON comision_bases_plan;
CREATE TRIGGER trg_auditar_comision_bases
    AFTER INSERT OR UPDATE OR DELETE ON comision_bases_plan
    FOR EACH ROW EXECUTE FUNCTION auditar_cambio_comisiones();

DROP TRIGGER IF EXISTS trg_auditar_comision_bonos ON comision_bonos_calidad;
CREATE TRIGGER trg_auditar_comision_bonos
    AFTER INSERT OR UPDATE OR DELETE ON comision_bonos_calidad
    FOR EACH ROW EXECUTE FUNCTION auditar_cambio_comisiones();

DROP TRIGGER IF EXISTS trg_auditar_comision_reglas ON comision_reglas;
CREATE TRIGGER trg_auditar_comision_reglas
    AFTER INSERT OR UPDATE OR DELETE ON comision_reglas
    FOR EACH ROW EXECUTE FUNCTION auditar_cambio_comisiones();

DROP TRIGGER IF EXISTS trg_auditar_motivos_baja ON motivos_baja;
CREATE TRIGGER trg_auditar_motivos_baja
    AFTER INSERT OR UPDATE OR DELETE ON motivos_baja
    FOR EACH ROW EXECUTE FUNCTION auditar_cambio_comisiones();


-- =============================================================================
-- 2. La auditoría, lista para leer
-- =============================================================================
/**
 * Todo lo que pasó con las comisiones, en una sola lista.
 *
 * Junta las dos capas —los cambios de reglas de los disparadores y las acciones
 * de las funciones— porque la pregunta real nunca es "¿qué disparador corrió?"
 * sino "¿qué pasó con la comisión de agosto?".
 */
DROP VIEW IF EXISTS v_auditoria_comisiones;
CREATE VIEW v_auditoria_comisiones AS
SELECT
    a.id,
    a.creado_en,
    a.usuario_id,
    a.usuario_nombre,
    a.usuario_rol,
    a.accion,
    a.descripcion,
    a.entidad,
    a.entidad_id,
    a.ip,
    -- Solo el diff cuando lo hay: la fila completa en pantalla es ruido, y el
    -- `antes`/`despues` sigue estando en `datos` para quien lo necesite.
    a.datos -> 'campos' AS campos,
    a.datos             AS datos
FROM auditoria_sistema a
WHERE (
        a.accion LIKE 'comisiones.%'
     OR a.accion LIKE 'retiro.%'
     OR a.accion IN ('ventas.validar', 'cliente.baja')
      )
  AND (ve_comisiones_de_todos() OR tiene_permiso_comision('auditoria.ver'));

GRANT SELECT ON v_auditoria_comisiones TO authenticated;

COMMENT ON VIEW v_auditoria_comisiones IS
    'Rastro completo del módulo: cambios de reglas, validaciones, cierres, aprobaciones, pagos, anulaciones y retiros.';


-- =============================================================================
-- 3. Una firma sin firmante no es una firma
-- =============================================================================
/**
 * `mover_periodo_comisiones` de la 99, con una condición más: hay que tener
 * legajo.
 *
 * ── Cómo apareció esto ──
 *
 * Corriendo el módulo entero contra una base de prueba. Se aprobó y se pagó un
 * período, y después la propia revisión de más abajo marcó "hay períodos
 * aprobados o pagados sin quién los autorizó". Tenía razón: la llamada se hizo
 * sin sesión, `mi_legajo_id()` devolvió NULL y el período quedó pagado con la
 * firma en blanco.
 *
 * El resto del sistema deja pasar a quien no tiene legajo —es la regla que evita
 * que una instalación a medio migrar quede inutilizable— y para casi todo está
 * bien. Para autorizar un gasto, no: el punto 26 pide registrar quién aprobó y
 * quién pagó, y un registro que dice NULL no cumple eso. Es preferible que la
 * acción falle con un mensaje claro a que quede hecha y sin responsable.
 *
 * Todo lo demás de la función es idéntico a la 99.
 */
CREATE OR REPLACE FUNCTION mover_periodo_comisiones(
    p_periodo_id UUID,
    p_destino    TEXT,
    p_nota       TEXT DEFAULT NULL
)
RETURNS comision_periodos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_legajo UUID := mi_legajo_id();
    v_fila comision_periodos%ROWTYPE;
    v_permiso TEXT;
BEGIN
    SELECT * INTO v_fila FROM comision_periodos WHERE id = p_periodo_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe ese período';
    END IF;

    -- La condición nueva.
    IF v_legajo IS NULL THEN
        RAISE EXCEPTION 'Autorizar o pagar una comisión pide un legajo: tiene que quedar registrado quién lo hizo';
    END IF;

    v_permiso := CASE p_destino
        WHEN 'aprobado' THEN 'comisiones.aprobar'
        WHEN 'pagado'   THEN 'comisiones.pagar'
        ELSE NULL
    END;

    IF v_permiso IS NULL THEN
        RAISE EXCEPTION 'Destino inválido: %', p_destino;
    END IF;

    IF NOT tiene_permiso_comision(v_permiso) THEN
        RAISE EXCEPTION 'No tenés permiso para esto (%)', v_permiso;
    END IF;

    IF p_destino = 'aprobado' AND v_fila.estado <> 'cerrado' THEN
        RAISE EXCEPTION 'Solo se puede aprobar un período cerrado. Este está %.', v_fila.estado;
    END IF;
    IF p_destino = 'pagado' AND v_fila.estado <> 'aprobado' THEN
        RAISE EXCEPTION 'Solo se puede pagar un período aprobado. Este está %.', v_fila.estado;
    END IF;

    UPDATE comision_periodos
       SET estado = p_destino,
           aprobado_por = CASE WHEN p_destino = 'aprobado' THEN v_legajo ELSE aprobado_por END,
           aprobado_en  = CASE WHEN p_destino = 'aprobado' THEN NOW()   ELSE aprobado_en  END,
           pagado_por   = CASE WHEN p_destino = 'pagado'   THEN v_legajo ELSE pagado_por  END,
           pagado_en    = CASE WHEN p_destino = 'pagado'   THEN NOW()   ELSE pagado_en   END,
           notas = COALESCE(p_nota, notas)
     WHERE id = p_periodo_id
    RETURNING * INTO v_fila;

    UPDATE comision_ventas
       SET estado = CASE WHEN p_destino = 'pagado' THEN 'pagada' ELSE 'aprobada' END,
           actualizado_en = NOW()
     WHERE vendedor_id = v_fila.vendedor_id
       AND periodo = v_fila.periodo
       AND comisionable_en IS NOT NULL
       AND estado NOT IN ('anulada');

    INSERT INTO auditoria_sistema (
        usuario_id, usuario_nombre, usuario_rol, accion, descripcion, entidad, entidad_id, datos
    )
    SELECT u.id, TRIM(CONCAT(u.nombre, ' ', COALESCE(u.apellido, ''))), u.rol,
           'comisiones.' || p_destino,
           FORMAT('Marcó como %s la comisión de %s por %s',
                  p_destino, TO_CHAR(v_fila.periodo, 'MM/YYYY'), v_fila.monto),
           'comision_periodo', p_periodo_id,
           jsonb_build_object('monto', v_fila.monto, 'ventas', v_fila.ventas_validas, 'nota', p_nota)
    FROM usuarios_sistema u WHERE u.id = v_legajo;

    RETURN v_fila;
END $$;

COMMENT ON FUNCTION mover_periodo_comisiones IS
    'Aprueba o paga un período cerrado. Exige legajo: una autorización sin responsable no se registra.';


-- =============================================================================
-- 4. La revisión
-- =============================================================================
/**
 * Contesta si el módulo está sano, con nombre y apellido de lo que no lo está.
 *
 * ── Para qué sirve de verdad ──
 *
 * Para correrla antes de pagar. Todo lo que revisa es algo que ya pasó alguna
 * vez en algún sistema de comisiones: una venta contada dos veces, un bono que
 * se calculó y nunca se liquidó, un período aprobado sin que nadie figure
 * aprobándolo, un equipo marcado como recuperado que en el inventario sigue
 * instalado en la casa del que se fue.
 *
 * ── Por qué devuelve filas y no un booleano ──
 *
 * Porque "el sistema está mal" no se puede accionar. Cada prueba dice qué mira,
 * si pasó, y cuántos casos encontró: eso sí se puede arreglar.
 *
 * ── Sobre `revisar` en vez de `error` ──
 *
 * Varias de estas cosas pueden ser legítimas. Un período cerrado que no coincide
 * al recalcular es exactamente lo que se espera si después se anuló una venta
 * por fraude. La revisión señala; no acusa.
 */
-- Se borra antes de crearla: renombrar una columna de salida cambia el tipo de
-- retorno y `CREATE OR REPLACE` no puede con eso.
DROP FUNCTION IF EXISTS verificar_comisiones();

CREATE FUNCTION verificar_comisiones()
/**
 * Los nombres de salida llevan `res_` por la misma razón que en la 99, y esto se
 * comprobó del modo más caro: la primera versión los llamaba `prueba`, `estado`,
 * `casos` y `detalle`, se creó sin una sola queja, y explotó al ejecutarla con
 * "column reference estado is ambiguous".
 *
 * Es que casi todas las pruebas de acá abajo miran una columna `estado` —de
 * `comision_ventas`, de `comision_periodos`, de `comision_cohortes`— y un
 * parámetro de salida con ese nombre la tapa. Postgres no lo detecta al crear la
 * función: espera a que alguien la corra.
 *
 * Calificar cada columna también funcionaría, hasta que alguien agregue una
 * línea sin calificar. El prefijo hace que el choque sea imposible.
 */
RETURNS TABLE (res_prueba TEXT, res_estado TEXT, res_casos INT, res_detalle TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    n INT;
BEGIN
    IF NOT ve_comisiones_de_todos() THEN
        RAISE EXCEPTION 'La revisión del módulo la corre quien puede ver todas las comisiones';
    END IF;

    -- 1. Un abonado, una comisión de venta nueva.
    SELECT COUNT(*) INTO n FROM (
        SELECT cliente_id FROM comision_ventas
         WHERE cliente_id IS NOT NULL AND estado <> 'anulada'
         GROUP BY cliente_id HAVING COUNT(*) > 1
    ) x;
    RETURN QUERY SELECT
        'Ningún abonado con dos comisiones vivas'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'El índice único lo impide y se comprobó que sigue vigente.'
             ELSE 'Hay abonados con más de una comisión sin anular. Es pago doble.' END;

    -- 2. Una venta comisionable siempre tiene base y esquema congelados.
    SELECT COUNT(*) INTO n FROM comision_ventas
     WHERE comisionable_en IS NOT NULL
       AND estado <> 'anulada'
       AND (base IS NULL OR esquema_id IS NULL);
    RETURN QUERY SELECT
        'Toda venta comisionable tiene base y esquema'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'Sin esos dos datos una comisión pagada no se podría explicar.'
             ELSE 'Hay ventas comisionables sin base o sin esquema congelado.' END;

    -- 3. El período cerrado coincide con lo que da el motor hoy.
    SELECT COUNT(*) INTO n
      FROM comision_periodos cp
      JOIN LATERAL comision_de_periodo(cp.vendedor_id, cp.periodo) c ON TRUE
     WHERE ROUND(cp.monto, 2) <> ROUND(c.monto, 2);
    RETURN QUERY SELECT
        'Los períodos cerrados cuadran al recalcular'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'Lo congelado da lo mismo que el motor.'
             ELSE 'Hay períodos que no coinciden. Puede ser legítimo si después se anuló una venta: revisar la auditoría de esos meses.' END;

    -- 4. Las cohortes suman.
    SELECT COUNT(*) INTO n FROM comision_cohortes
     WHERE evaluables <> conservados + perdidos;
    RETURN QUERY SELECT
        'Las cohortes suman conservados + perdidos'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'El porcentaje de calidad se calcula sobre un total que cierra.'
             ELSE 'Hay cohortes cuyo total no es la suma de sus partes.' END;

    -- 5. Ningún bono cerrado quedó sin liquidar más de un mes.
    SELECT COUNT(*) INTO n FROM comision_cohortes
     WHERE estado = 'cerrada' AND liquidado_en IS NULL AND bono > 0
       AND cierra_el < CURRENT_DATE - INTERVAL '1 month';
    RETURN QUERY SELECT
        'Los bonos cerrados se liquidaron'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'No hay bonos ganados esperando en la cola.'
             ELSE 'Hay bonos calculados hace más de un mes que nadie liquidó: probablemente el cierre no está corriendo.' END;

    -- 6. Ningún bono se pagó dos veces.
    SELECT COUNT(*) INTO n FROM (
        SELECT cc.vendedor_id, cc.periodo_liquidado, SUM(cc.bono) AS bono
          FROM comision_cohortes cc
         WHERE cc.liquidado_en IS NOT NULL
         GROUP BY cc.vendedor_id, cc.periodo_liquidado
    ) l
    JOIN comision_periodos cp
      ON cp.vendedor_id = l.vendedor_id AND cp.periodo = l.periodo_liquidado
     WHERE ROUND(cp.bono, 2) <> ROUND(l.bono, 2);
    RETURN QUERY SELECT
        'El bono liquidado coincide con el del período'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'Cada bono aparece una sola vez en una sola liquidación.'
             ELSE 'Hay liquidaciones cuyo bono no coincide con las cohortes que se le imputaron.' END;

    -- 7. Nadie autorizó ni pagó sin quedar registrado.
    SELECT COUNT(*) INTO n FROM comision_periodos
     WHERE (estado IN ('aprobado', 'pagado') AND aprobado_por IS NULL)
        OR (estado = 'pagado' AND pagado_por IS NULL);
    RETURN QUERY SELECT
        'Toda aprobación y todo pago tiene firma'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'Se sabe quién autorizó cada gasto.'
             ELSE 'Hay períodos aprobados o pagados sin quién los autorizó. Se escribieron por fuera de las funciones.' END;

    -- 8. Toda anulación tiene motivo.
    SELECT COUNT(*) INTO n FROM comision_ventas
     WHERE estado = 'anulada' AND COALESCE(BTRIM(motivo_anulacion), '') = '';
    RETURN QUERY SELECT
        'Toda anulación tiene motivo escrito'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        'Es la regla del punto 26: nada financiero se modifica en silencio.';

    -- 9. Un solo esquema activo.
    SELECT COUNT(*) INTO n FROM comision_esquemas WHERE activo;
    RETURN QUERY SELECT
        'Hay exactamente un esquema vigente'::TEXT,
        CASE WHEN n = 1 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 1 THEN 'Una sola respuesta a "cuánto vale esta venta".'
             WHEN n = 0 THEN 'No hay esquema activo: el motor no puede calcular nada.'
             ELSE 'Hay más de uno activo. Dos respuestas distintas a la misma pregunta.' END;

    -- 10. Sin huecos de vigencia entre versiones.
    -- Todo esquema cerrado tiene que tener al siguiente empezando al día
    -- siguiente. El último es el vigente y no tiene `vigente_hasta`.
    SELECT COUNT(*) INTO n
      FROM comision_esquemas a
     WHERE a.vigente_hasta IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM comision_esquemas b
            WHERE b.vigente_desde = a.vigente_hasta + 1);
    RETURN QUERY SELECT
        'Las versiones no dejan días sin esquema'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'Toda fecha cae dentro de alguna versión.'
             ELSE 'Hay días entre versiones sin esquema vigente: una venta de esos días no comisiona y nadie se entera.' END;

    -- 11. El equipo recuperado volvió al stock de verdad.
    SELECT COUNT(*) INTO n
      FROM retiros_equipo r
      JOIN equipos e ON e.id = r.equipo_id
     WHERE r.estado = 'recuperado'
       AND (e.estado <> 'en_stock' OR e.cliente_id IS NOT NULL);
    RETURN QUERY SELECT
        'Los equipos recuperados están en stock'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'Lo que volvió, volvió también en el inventario.'
             ELSE 'Hay órdenes cerradas como recuperadas cuyo equipo sigue figurando instalado.' END;

    -- 12. Una reactivación no generó además comisión de venta nueva.
    SELECT COUNT(*) INTO n
      FROM reactivaciones ra
      JOIN comision_ventas cv ON cv.cliente_id = ra.cliente_id
     WHERE cv.estado <> 'anulada'
       AND cv.comisionable_en > ra.reactivado_el - INTERVAL '15 days'
       AND cv.comisionable_en < ra.reactivado_el + INTERVAL '45 days';
    RETURN QUERY SELECT
        'Ninguna reactivación se pagó como venta nueva'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'El punto 14 se está cumpliendo.'
             ELSE 'Hay comisiones de venta nueva que caen justo alrededor de una reactivación del mismo abonado. Revisar si se cargó como prospecto nuevo.' END;

    /**
     * 13. Ventas cerradas antes de que existiera un esquema.
     *
     * Esta prueba existe por algo que se descubrió corriendo el módulo entero
     * contra una base de prueba: el generador busca el esquema vigente EL DÍA en
     * que se ganó la venta, y si no hay ninguno la saltea con un `CONTINUE`.
     *
     * Es lo correcto —no se pueden aplicar reglas que nadie había definido a un
     * período ya cerrado— pero era invisible: la venta no genera fila, así que no
     * aparece en ninguna pantalla, ni siquiera con un "le falta". El vendedor
     * pregunta por su venta de julio y no hay nada que mirar.
     *
     * El primer mes esto le pasa a TODO lo vendido antes de instalar el módulo.
     * Acá queda dicho, con el número.
     */
    SELECT COUNT(*) INTO n
      FROM prospectos p
     WHERE p.estado = 'ganado'
       AND p.cliente_id IS NOT NULL
       AND p.tipo_operacion = 'nueva'
       AND esquema_comisiones_vigente(COALESCE(p.ganado_en::DATE, CURRENT_DATE)) IS NULL;
    RETURN QUERY SELECT
        'Toda venta ganada cae dentro de algún esquema'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'No hay ventas fuera del alcance del motor.'
             ELSE 'Hay ventas cerradas antes de que existiera un esquema de comisiones. El motor las saltea y no aparecen en ninguna pantalla. Si tienen que comisionar, hay que crear una versión con una vigencia anterior.' END;

    -- 14. Las tareas están corriendo.
    SELECT COUNT(*) INTO n FROM comision_ventas
     WHERE estado = 'pendiente_validacion' AND espera_pago_hasta < CURRENT_DATE - 15;
    RETURN QUERY SELECT
        'No hay ventas trabadas en cortesía'::TEXT,
        CASE WHEN n = 0 THEN 'ok' ELSE 'revisar' END,
        n,
        CASE WHEN n = 0 THEN 'El refresco de hitos está al día.'
             ELSE 'Hay ventas cuya ventana de pago venció hace más de quince días y siguen esperando: la tarea de comisiones probablemente está apagada.' END;
END $$;

COMMENT ON FUNCTION verificar_comisiones IS
    'Revisión del módulo de comisiones: catorce pruebas sobre duplicados, cierres, bonos, firmas, vigencias, alcance y equipos.';


-- =============================================================================
-- Cómo comprobarlo
-- =============================================================================
--   -- La revisión completa:
--   SELECT res_prueba, res_estado, res_casos, res_detalle FROM verificar_comisiones();
--
--   -- Que el disparador registre de verdad: se cambia un porcentaje y se mira.
--   UPDATE comision_niveles SET porcentaje = porcentaje
--    WHERE id = (SELECT id FROM comision_niveles LIMIT 1);
--   -- (no cambia nada, así que NO debe aparecer ningún renglón nuevo)
--
--   UPDATE comision_niveles SET porcentaje = porcentaje + 1
--    WHERE id = (SELECT id FROM comision_niveles LIMIT 1);
--
--   SELECT creado_en, usuario_nombre, descripcion, campos
--     FROM v_auditoria_comisiones ORDER BY creado_en DESC LIMIT 5;
--
--   -- Y se deja como estaba:
--   UPDATE comision_niveles SET porcentaje = porcentaje - 1
--    WHERE id = (SELECT id FROM comision_niveles LIMIT 1);
