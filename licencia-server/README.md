# Servidor de licencias

El lado del **vendedor**. Esto no se instala en el cliente: corre en tu servidor
y es lo que habilita a cada ISP que te compró el sistema.

Hace dos cosas:

- **Le contesta a las instalaciones** que piden renovar, todos los días. Si el
  ISP está al día, les manda un permiso firmado; si no, un 402.
- **Te muestra la lista de tus clientes**: cuántos abonados tiene cada uno,
  hasta cuándo pagó, quién está por vencer y a quién le podés vender un plan más
  grande.

No tiene dependencias. Se copia la carpeta y corre.

## Puesta en marcha

**1. Generá el par de claves** (una sola vez, nunca más):

```
node ../middleware/scripts/licencia.mjs claves
```

Guardá la privada en `datos/licencia-privada.pem`. **Esa clave es el negocio**:
quien la tenga emite licencias eternas para cualquier instalación. Si se filtra,
hay que cambiar la clave pública en cada cliente, uno por uno.

La pública va en el `.env` de cada instalación que vendas, como
`LICENCIA_CLAVE_PUBLICA`.

**2. Levantalo:**

```
ADMIN_TOKEN=una-frase-larga-y-random npm start
```

Se niega a arrancar sin clave privada y sin token de administración. Es a
propósito: un servidor de licencias que levanta sin poder firmar parece sano
hasta que un cliente intenta renovar, y para entonces ya hay un ISP mirando un
cartel rojo.

**3. Abrí `http://localhost:4100/`** y pegá el token.

## La página para tus clientes

`http://tu-servidor:4100/mi-cuenta` — pasásela a cada ISP que te compre el
sistema. Entran con su código de instalación (lo ven en su propio sistema, en
Ajustes → Licencia) y consultan hasta cuándo pagaron, cuántos abonados tienen y
su historial de pagos. Sin llamarte.

Se identifican con el código y nada más. Es un UUID que solo ellos tienen, y lo
único que expone es su propia cuenta: no muestra otras instalaciones ni emite
ningún permiso. Ver que se debe es una cosa; emitirse la licencia, otra.

## El día a día

Cuando instalás el sistema en un cliente nuevo, **no hace falta darlo de alta**:
su copia empieza a pedir renovación sola y aparece en la lista, sin pagar. Le
ponés nombre, plan y precio, registrás el pago y queda habilitado.

Después, cada mes: **Pago** → listo. La instalación se renueva sola esa misma
noche.

### Los tres botones

| Botón | Para qué |
|---|---|
| **Pago** | Extiende la licencia. Reactiva si estaba suspendida. |
| **Editar** | Nombre, plan, precio, y el corte manual. |
| **Código** | Emite el permiso para pasárselo por WhatsApp. |

**Código** es el que salva el día que el cliente no tiene internet o su sistema
no llega hasta acá. Nunca puede depender de la red la única forma de
desbloquear a alguien.

## Decisiones que conviene conocer

**El pago extiende desde el vencimiento, no desde hoy.** El que paga con cinco
días de atraso no pierde esos días, y el que paga adelantado los suma. Contar
desde hoy le regalaría meses al que siempre paga tarde.

**El permiso vence unos días después del pago** (`LICENCIA_COLCHON_DIAS`, 5 por
defecto). Si el cliente se queda sin internet una semana, no se bloquea: su
último permiso todavía alcanza. Y del lado del cliente hay otros 3 días de
gracia. En total, un cliente al día tolera más de una semana sin poder
comunicarse con vos.

**Pasarse de abonados no bloquea nada.** Se marca *excedido* en la lista, para
que lo llames y le vendas el plan que le corresponde. Apagarle el sistema al
cliente que más creció sería castigar justo al mejor.

**La base es un archivo.** `datos/licencias.db`. Se respalda copiándolo — y
respaldalo, porque es la lista de quién te paga.

## Configuración

| Variable | Por defecto | Qué es |
|---|---|---|
| `PORT` | 4100 | |
| `ADMIN_TOKEN` | — | **Obligatorio.** La llave del panel. |
| `LICENCIA_CLAVE_PRIVADA` | `./datos/licencia-privada.pem` | |
| `LICENCIA_DB` | `./datos/licencias.db` | |
| `LICENCIA_COLCHON_DIAS` | 5 | Días de permiso más allá del pago. |

## Lo que falta si esto crece

Está pensado para las decenas de clientes que puede tener un vendedor, no para
miles. Si llega a eso, lo primero que hay que agregar es HTTPS por delante (hoy
el token de admin viaja en claro si lo exponés sin proxy) y un límite de
intentos en `/admin`.
