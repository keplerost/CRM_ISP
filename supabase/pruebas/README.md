# Pruebas de migraciones

Corren las migraciones contra un **Postgres 16 de verdad**, en memoria, antes de
tocar la base del cliente.

```bash
cd supabase/pruebas
npm install     # una sola vez
npm test        # ~3 segundos
```

## Por qué existe

Las migraciones son el único código del proyecto que se ejecuta a mano, una vez,
contra producción. Si una falla a la mitad, lo que queda es un esquema roto en el
peor momento posible.

Y hay una clase de error que no se ve leyendo el archivo: **plpgsql compila el
cuerpo de una función recién cuando alguien la invoca**. Una columna ambigua o un
tipo que no cierra se crean sin una sola queja y explotan meses después, la
primera vez que alguien aprieta el botón. Ya pasó: la revisión del módulo de
comisiones se creó perfecta y no corría.

Por eso esto no solo aplica el SQL — lo **ejecuta**.

## Qué comprueba

1. Las **107 migraciones** aplican limpio, en orden, sobre una base vacía.
2. Que volver a correrlas **todas** no falle y no cambie ni una columna del
   esquema, que es lo que promete la cabecera de cada una.
3. Las **funciones se ejecutan**: `generar_comisiones`, `evaluar_cohortes`,
   `cerrar_periodo_comisiones`, `verificar_comisiones` y las demás.
4. Las **18 vistas** del módulo responden.
5. Una venta recorre el **circuito entero** y da el número correcto: 3 ventas ×
   base $10 = $30 al 20 % → **$6,00**, el mismo resultado que da `calcular()` en
   el navegador. Esa igualdad es la que sostiene el módulo: lo que el vendedor ve
   mientras vende y lo que la base paga a fin de mes.
6. Los **controles dicen que no** cuando corresponde: aprobar sin legajo, una
   vendedora aprobando su propia comisión, reaprobar un período ya pagado, dos
   comisiones para el mismo abonado.
7. La **auditoría** registra el valor anterior y el nuevo, y un `UPDATE` que no
   cambia nada no deja renglón.

## Cómo está armado

`base.mjs` levanta [PGlite](https://pglite.dev) —Postgres compilado a
WebAssembly— y le pone encima lo que Supabase trae puesto y una base pelada no
tiene: el esquema `auth` con su `uid()`, los roles `authenticated`/`anon`/
`service_role`, y el esquema `storage` con sus ayudantes. Sin eso las migraciones
fallarían por el entorno y no por su contenido.

`sesion(db, authId)` redefine `auth.uid()`. Todo el control de acceso del sistema
cuelga de esa función, así que cambiarla es la forma de probar los permisos sin
levantar un servidor de autenticación.

## Reejecutar es no hacer nada

Las 107 se pueden volver a correr, en orden, sobre una base ya migrada: **cero
errores y cero cambios en el esquema**. Eso último es la mitad difícil.

El problema no era solo que fallaran. Una migración vieja que se reejecuta puede
reemplazar una vista por su versión de hace un año **sin dar ningún error**, y
ahí el sistema sigue "funcionando" mientras las pantallas pierden columnas. Y hay
un caso peor: media docena de vistas están definidas con `tabla.*`, así que al
recrearlas absorben las columnas que las tablas ganaron después. Una de ellas
—`v_clientes_ficha`— habría empezado a exponer `portal_clave_hash`, el hash de la
clave del portal del abonado.

Por eso cada parte superada **se saltea sola**, con una condición que mira el
contenido y no un número de migración:

```sql
IF EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'v_clientes_ficha'
              AND column_name = 'plan_tipo_impuesto') THEN
    RETURN;   -- la cadena ya pasó por acá
END IF;
```

Ese marcador es una columna que **solo trae la versión nueva** de la vista. En una
instalación nueva no está —así que la migración corre y hace su trabajo—; en una
ya migrada sí está, y no se toca nada. El archivo no necesita saber qué vino
después de él.

La prueba `la cadena entera se puede volver a correr sin cambiar el esquema`
compara vistas, columnas, `security_invoker` y permisos antes y después. Lo que
verifica no es que no falle: es que **no cambie nada**.

## Lo que se arregló

Antes fallaban 27 al reejecutarse:

| # | Qué pasaba | Arreglo |
|---|---|---|
| 28 | `CREATE POLICY` sin `DROP` previo | el `DROP POLICY IF EXISTS` que faltaba |
| 46, 72, 73, 91, 92 | `DROP VIEW` de vistas de las que cuelgan otras creadas después | `CREATE OR REPLACE VIEW`, que no toca a los dependientes |
| 89, 91 | envolvían `v_instalaciones` para agregarle columnas y la segunda vez chocaban con su propia columna | guarda de existencia: si ya está, no hace nada |
| 52 | copiaba `vlans_olt.slot` y después borraba esa columna | la copia va en SQL dinámico, tras comprobar que la columna exista |
| 49 | resucitaba la columna y la vista que la 50 había quitado | se saltea si ya existe `puertos_pon`, con la que la 52 cerró ese rediseño |
| 37 | rehace `v_planes` y `v_clientes_ficha`, definidas con `*`, y de ellas cuelgan 14 vistas | fotografía las 14 con sus opciones, permisos y comentarios, suelta con CASCADE y las devuelve; comprueba que ninguna perdió el filtro de RLS |
| 8, 9, 10, 11, 13, 14, 18, 24, 25, 26, 30, 31, 34, 35, 48, 50, 67, 68 | rehacían vistas que una migración posterior redefinió con más columnas | cada parte superada se saltea sola, con el marcador de contenido de arriba |
| 10, 11, 37, 51, 69, 81, 83 | son las **últimas** que definen su vista, y al recrearla con `tabla.*` la ensanchaban | mismo marcador: si la vista ya está en su versión, no se toca |

La 37 es la más delicada y por eso vale leerla: es el único caso donde para poder
reejecutar hay que soltar catorce vistas ajenas y devolverlas intactas.

## Lo que sigue sin cubrirse

Que los **datos** sobrevivan. Acá la base arranca vacía: se verifica que el
esquema se construya igual y que reejecutar no lo mueva, no que una migración
respete las filas que ya existen.
