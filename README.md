# Taller SmartOLT

Sistema web de gestión de OLTs GPON (Huawei / V-SOL) y routers MikroTik, al estilo SmartOLT.

Especificación original en [`docs/smart.md`](docs/smart.md).
Comandos reales validados contra el hardware en [`docs/comandos-referencia.md`](docs/comandos-referencia.md).

---

## Arquitectura

```
  navegador
     │
     ├──────────────► Supabase        (auth + PostgreSQL + RLS)
     │                                 CRUD de OLTs, ONUs, perfiles, planes…
     │
     └──────────────► middleware      (Node + Express)
                          │
                          ├── SSH ───► OLT Huawei (MA5800 / VRP)
                          ├── SSH ───► OLT V-SOL
                          └── REST ──► MikroTik (RouterOS v7)
```

El navegador no puede hablar SSH ni la API binaria de RouterOS, así que todo lo que toca
la red pasa por el middleware. Lo que es puro CRUD va directo a Supabase, protegido por RLS.

| Carpeta | Qué es |
|---|---|
| `web/` | Frontend — Vite + React + Tailwind |
| `supabase/migracion-*.sql` | Migraciones, en orden. Todas idempotentes |
| `middleware/` | API de red — Node + Express + ssh2 |
| `supabase/` | `schema.sql` con las 8 tablas, RLS y datos de ejemplo |
| `docs/` | Especificación del taller y referencia de comandos |

---

## Puesta en marcha rápida

Desde la raíz del proyecto, una sola vez:

```bash
npm install            # dependencias de la raíz
npm run install:all    # dependencias de web/ y middleware/
```

Y para levantar todo (web + middleware en una sola terminal):

```bash
npm run dev
```

- Web → http://localhost:5173
- Middleware → http://localhost:4000

`npm run dev:web` y `npm run dev:api` levantan cada uno por separado.

> Antes de poder loguearte hay que completar los `.env` con los datos reales de
> Supabase — los pasos están abajo. Mientras tengan los valores de ejemplo, la web
> muestra un aviso y `/api/health` lista qué falta.

---

## Puesta en marcha detallada

### 1. Supabase

1. Creá un proyecto en [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → pegá todo `supabase/schema.sql` → **Run**.
3. **Authentication → Users → Add user** → creá el usuario de prueba (email + password,
   marcando *Auto Confirm User*).
4. **Project Settings → API** → anotá:
   - `Project URL`
   - `anon` key (va al frontend)
   - `service_role` key (va **solo** al middleware)

Las migraciones (`supabase/migracion-*.sql`) se pegan en el SQL Editor **en orden
numérico**. Antes de correrlas contra la base del cliente se pueden probar contra
un Postgres real en memoria:

```bash
cd supabase/pruebas
npm install
npm test
```

Aplica la cadena completa, **ejecuta** las funciones —crear una función no prueba
que corra: plpgsql compila el cuerpo recién al invocarla— y verifica el circuito
de comisiones de punta a punta. Ver `supabase/pruebas/README.md`.

### 2. Middleware

```bash
cd middleware
npm install
cp .env.example .env      # completá SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y CREDENTIALS_KEY
npm run dev
```

Queda escuchando en `http://localhost:4000`. Verificá con `GET /api/health` —
te dice si falta algo del `.env`.

Los parsers de las OLTs y el cifrado tienen tests con salidas representativas de los
equipos reales:

```bash
npm test
```

> `CREDENTIALS_KEY` es la passphrase con la que se cifran las contraseñas de los equipos.
> Si la cambiás, las credenciales ya guardadas dejan de poder descifrarse y hay que
> volver a cargarlas desde la UI.

### 3. Frontend

```bash
cd web
npm install
cp .env.example .env      # completá VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY y VITE_API_URL
npm run dev
```

Abre en `http://localhost:5173`. Entrá con el usuario que creaste en el paso 1.3.

---

## Hoja de ruta del taller

| Fase | Qué se hace | Dónde mirar |
|---|---|---|
| **1** Base de datos e interfaz | Tablas + RLS, login, layout | `supabase/schema.sql`, `web/src/components/layout/` |
| **2** Integración MikroTik | Endpoint de red, crear un IP Pool desde la web | `middleware/src/drivers/mikrotik.js`, `web/src/components/mikrotik/` |
| **3** Integración OLT y ONUs | Plantillas SSH, flujo detectar → perfil → registrar → guardar | `middleware/src/drivers/`, `web/src/components/onus/` |
| **4** Panel de métricas | Potencia óptica en vivo, alerta bajo -27 dBm | `web/src/components/olt/ONUStatsCard.jsx` |

### Checkpoint de Fase 1

- [ ] Las 8 tablas existen en Supabase con RLS activado.
- [ ] Login funciona con el usuario de prueba y redirige al Dashboard.
- [ ] Sidebar/Navbar visibles y con navegación entre páginas.
- [ ] Se puede crear una fila de prueba en `olts` desde la UI y verla listada.
- [ ] Intentar leer `olts` **sin** estar autenticado falla (RLS protegiendo los datos).

---

## Endpoints del middleware

Todos requieren el header `Authorization: Bearer <access_token de Supabase>`
(salvo `/api/health`). Se puede desactivar con `REQUIRE_AUTH=false` para probar con curl.

### General

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/health` | Estado del servicio y qué falta configurar |
| `POST` | `/api/crypto/encrypt` | Cifra una contraseña de equipo antes de guardarla |

### OLT

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/olt/:id/test` | Prueba de conexión (`display version` / `show version`) |
| `GET` | `/api/olt/:id/onus?puerto=N` | ONUs registradas del puerto |
| `GET` | `/api/olt/:id/autofind?puerto=N` | ONUs sin registrar (sin `puerto`, barre todos) |
| `POST` | `/api/olt/:id/onus` | Registra la ONU en la OLT y la guarda en Supabase |
| `POST` | `/api/olt/:id/onus/servicio` | VLAN de servicio (tcont → gemport → service-port, V-SOL) |
| `DELETE` | `/api/olt/:id/onus/:onuId?puerto=N` | Baja de la ONU en la OLT y en la base |
| `GET` | `/api/olt/:id/onus/:onuId/metricas?puerto=N` | Potencia óptica, distancia y alerta |
| `POST` | `/api/olt/:id/line-profiles` | Crea el line profile en la OLT y lo guarda |
| `POST` | `/api/olt/:id/traffic-tables` | Aplica un plan como traffic table |
| `POST` | `/api/olt/:id/cli` | Comandos crudos (escotilla para el taller) |
| `GET` | `/api/olt/sesiones` | Cuántas sesiones SSH mantiene abiertas el middleware |
| `POST` | `/api/olt/sesiones/cerrar` | Suelta esas sesiones ahora, sin esperar el tiempo de inactividad |

#### Una sola sesión SSH por OLT

Antes cada operación abría su propio login: escanear un puerto, leer la potencia
y registrar una ONU eran tres entradas y tres salidas seguidas en el registro
del equipo. En una OLT que admite tres sesiones simultáneas eso deja al operador
a un paso del `exceed max sessions`.

Ahora se hace login una vez y la sesión se reutiliza, con dos salvaguardas sin
las cuales esto sería peor que el problema que resuelve:

| Salvaguarda | Por qué |
|---|---|
| El estado se normaliza al reutilizar | La CLI es con estado —`enable` → `config` → `interface gpon 0/1`—. Una sesión que quedó dentro de un puerto ejecutaría los comandos siguientes ahí adentro sin que nada lo delate |
| Una sesión reutilizada que falla se descarta y se reintenta con una nueva | Ante cualquier cosa rara, el peor caso es exactamente el comportamiento anterior: una sesión fresca |

Volver al punto de partida es distinto en cada marca y lo dice el driver: `end`
en V-SOL, dos `quit` en Huawei. **Ni uno más** — en el nivel de usuario, `quit`
cierra la sesión.

Se cierran al apagar el proceso y tras `SSH_SESION_IDLE_MS` sin uso. Si algo
sale mal se puede volver al comportamiento de antes con
`SSH_SESION_PERSISTENTE=false`.

### MikroTik

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/mikrotik/:id/test` | Identidad, modelo y versión |
| `GET`/`POST`/`DELETE` | `/api/mikrotik/:id/pools` | IP Pools |
| `GET`/`POST`/`DELETE` | `/api/mikrotik/:id/addresses` | IP Addresses |
| `GET` | `/api/mikrotik/:id/interfaces` | Interfaces del router |
| `GET`/`POST`/`DELETE` | `/api/mikrotik/:id/bloqueos` | Address-list `CORTE_MOROSOS` |
| `POST` | `/api/mikrotik/:id/redireccion-pago` | Regla NAT de aviso de pago |
| `GET`/`POST` | `/api/mikrotik/:id/queues` | Simple Queues |
| `GET` | `/api/mikrotik/:id/ppp-profiles` | Perfiles PPP, con el límite que aplica cada uno |

### Alta en campo

Los cuatro pasos del asistente que tocan la red. Reciben el id de la
**instalación**, no el del equipo: a qué OLT preguntarle y en qué router
escribir sale de la orden de trabajo, no del celular del técnico.

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/instalaciones/:id/lectura` | Potencia de la ONT en la OLT, o señal y CCQ del CPE en la radio |
| `GET` | `/api/instalaciones/:id/ip-libre` | Primera IP sin usar del pool o del segmento del nodo |
| `POST` | `/api/instalaciones/:id/aprovisionar` | Crea o corrige el secret PPPoE / la reserva DHCP |
| `POST` | `/api/instalaciones/:id/pruebas` | Ping desde el router y test de ancho de banda |

Cada una guarda lo que respondió el equipo en la fila de la instalación. Es lo
que permite que el técnico se quede sin señal a mitad del trabajo y retome donde
estaba en vez de empezar de cero.

### Gestión de red e IPAM

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/ipam/routers/salud` | Estado de cada CCR con su CPU, memoria y uptime |
| `POST` | `/api/ipam/subredes/:id/sincronizar` | Vuelca del router lo que está **configurado** en el bloque |
| `POST` | `/api/ipam/subredes/:id/escanear` | Averigua qué está **conectado**: pasivo por ARP o activo con `ip-scan` |
| `GET` | `/api/ipam/subredes/:id/libre` | Primera dirección sin usar del bloque |

### Monitoreo de red (NMS)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/nms/estado` | Resumen del watchdog y cuántos nodos hay en cada estado |
| `POST` | `/api/nms/sondear` | Fuerza una pasada completa |
| `POST` | `/api/nms/nodos/:id/probar` | Sondea un nodo suelto **sin** registrarlo en el historial |

### Facturación electrónica (SRI)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET`/`PUT` | `/api/sri/config` | Datos del emisor, plantilla del período y SMTP |
| `POST` | `/api/sri/facturas` | Emite la factura: secuencial, clave de acceso y XML |
| `POST` | `/api/sri/documentos/:id/procesar` | Firma, envía y consulta la autorización de una pasada |
| `GET` | `/api/sri/documentos/:id/xml` | XML autorizado (o el firmado, o el borrador) |
| `GET` | `/api/sri/documentos/:id/ride` | RIDE en PDF (`?descargar=1` para bajarlo) |
| `POST` | `/api/sri/documentos/:id/email` | Manda el XML autorizado y el RIDE al comprador |
| `POST` | `/api/sri/certificado` | Sube y valida el `.p12` de firma |
| `POST` | `/api/sri/probar-firma` · `/api/sri/probar-smtp` | Pruebas sin tocar comprobantes |

Las migraciones `supabase/migracion-03…08` crean las tablas de facturación y cobros;
hay que correrlas en orden desde el SQL Editor. El flujo de instalación necesita
además la `migracion-31` y su `31b`, que crea el bucket de las fotos. La `b` va
aparte porque el SQL Editor corre todo en una transacción: si el proyecto no deja
crear buckets por SQL, el error tiraría abajo también las tablas.

### Clientes

`Clientes` se despliega en cuatro secciones:

| Ruta | Qué hay |
|---|---|
| `/clientes` | Listado de abonados; el nombre abre su ficha |
| `/clientes/:id` | Ficha completa: resumen, servicio, facturación, cobros, instalaciones y contratos |
| `/clientes/mapa` | Mapa (Leaflet + OpenStreetMap) con un punto por abonado, coloreado por estado |
| `/clientes/instalaciones` | Prospectos y trabajos nuevos |
| `/clientes/instalaciones/:id` | La orden de trabajo: factibilidad, agenda y condiciones |
| `/clientes/contratos` | Contratos, con uno solo vigente por cliente |

La ficha carga cada pestaña bajo demanda: abre con el resumen y recién pide las
facturas cuando alguien entra a Facturación.

### De prospecto a usuario activo

`Usuarios` son los abonados que tienen servicio. El que llama pidiendo internet
todavía no es ninguno de los dos, y darlo de alta antes de saber si le llega
ensucia el padrón con gente que nunca se instaló. Por eso el recorrido empieza
en otro lado:

1. **Instalaciones → Nuevo trabajo.** Nombre, cédula, teléfono, dirección,
   coordenadas y tecnología (FTTH o inalámbrico). Queda como *prospecto*, sin
   ficha de cliente.
2. **Factibilidad.** `cobertura_cercana` devuelve las cajas NAP o las torres más
   próximas con su ocupación real —los abonados colgados **más** las
   instalaciones que ya reservaron un puerto—, y con eso se decide si es
   factible, si necesita obra o si no llega.
3. **Agenda.** Fecha, franja, técnico o cuadrilla, y las condiciones que cierra
   la oficina: plan, precio y día de facturación.
4. **Alta en campo.** El técnico abre `/instalaciones/:id/alta` en el celular y
   recorre cinco pasos: leer el equipo (QR o a mano), medir la señal contra la
   OLT o la radio, asignar los parámetros de red, correr las pruebas y tomar la
   firma con las fotos.
5. **Finalizar alta.** `finalizar_alta_instalacion` crea la ficha del abonado
   con todo lo que se configuró y cierra la visita. Desde ese momento aparece en
   Usuarios y entra a facturación.

El paso 5 es una función de la base y no un UPDATE desde la pantalla: son dos
tablas que tienen que quedar consistentes, y perder la señal entre una escritura
y la otra dejaría un cliente activo sin instalación cerrada.

El asistente vive fuera del layout de escritorio —se usa con una mano, en la
vereda— y cada paso guarda contra el servidor apenas termina.

#### La velocidad en PPPoE la pone el perfil

Un abonado por PPPoE no se limita con una Simple Queue sino con el perfil PPP
con el que se crea su secret. Por eso cada plan guarda, en `perfil_ppp`, con qué
perfil del router se corresponde: los nombres casi nunca coinciden, porque el
plan se llama como se vende (`PLAN_100M`) y el perfil como lo nombró quien
configuró el equipo (`PLAN PRO 300Mbps`).

Se elige en **Perfiles y planes → Planes de velocidad**, de una lista leída del
router — el nombre tiene que ser exacto, y escribirlo a mano con una mayúscula
distinta es lo mismo que dejarlo vacío.

Un plan sin perfil asignado no bloquea el alta: el secret se crea con el perfil
por defecto y el técnico recibe el aviso en la respuesta. Dejar al abonado sin
servicio para proteger un límite de caudal sería el peor de los dos errores,
pero conviene revisarlo — hasta que se corrija, ese cliente navega sin tope.

## Servicios / Planes de Internet

El catálogo de lo que se vende, en `/servicios/planes`. Es la única pantalla que
toca las dos mitades del negocio a la vez —lo que el abonado contrata y lo que
el equipo aplica— y por eso el plan se edita **solo ahí**: tenerlo en dos
lugares garantiza que tarde o temprano digan cosas distintas.

| | Qué define |
|---|---|
| **Comercial** | Nombre, categoría (residencial/corporativo), precio, indicador de IVA y código de facturación |
| **Técnico** | Bajada/subida en Mbps, perfil PPP, traffic table de la OLT, caudal garantizado, prioridad y ráfaga |
| **Disponibilidad** | En qué routers se ofrece, con aprovisionamiento del perfil por API |

### El IVA sale del plan y la ficha puede desviarse

Un precio de 25 con IVA incluido y uno de 25 más IVA son dos productos
distintos, y antes solo se distinguían en la ficha de cada abonado: al dar de
alta había que acordarse de ponerlo, y el primero que se olvidaba facturaba mal.

Ahora el plan trae el valor por defecto —de dónde viene la venta— y la ficha
manda cuando dice algo, porque hay abonados exentos y no por eso se les cambia
el plan. El listado muestra base, IVA y total a facturar calculados.

### Dónde se limita a cada abonado

Lo decide **cómo conecta**, no con qué tecnología le llega el servicio:

| `tipo_conexion` | Dónde se limita | Con qué |
|---|---|---|
| `pppoe` | En la OLT | Traffic table del plan. El perfil PPP se crea con `rate-limit=""` |
| `ip` | En el MikroTik | Simple Queue del abonado: max-limit, limit-at, prioridad y ráfaga |

La distinción parece un matiz y no lo es: **un sector de fibra administrado con
IPv4 fija se limita en el MikroTik igual que un radioenlace**. No hace falta
duplicar el plan comercial — alcanza con que esos abonados tengan
*Tipo de conexión: IP* en su ficha de servicio, y la cola se les aplica con los
parámetros del mismo plan.

#### Quién controla el caudal en PPPoE

Cada plan lo elige, porque conviven: un plan puede controlarse desde la OLT en
un nodo y desde el router en otro —una cabecera sin OLT, un equipo heredado, una
OLT que no soporta el caudal que se vende—.

| `control_pppoe` | El perfil PPP queda | Si está al revés |
|---|---|---|
| `olt` (por defecto) | Sin `rate-limit` | Un límite acá compite con la traffic table y gana el menor |
| `mikrotik` | Con el `rate-limit` del plan | Sin límite, el abonado navega sin tope |

Con la OLT al mando el perfil va **sin límite a propósito**, y esa es la parte
contraintuitiva: un perfil de plan sin velocidad parece un error, y quien "lo
arregle" cargándole un límite crea un segundo tope que no aparece en ninguna
pantalla. Por eso la revisión no compara contra la velocidad sino contra lo que
el plan espera, y reporta los dos desvíos posibles por separado.

Cuando limita el router, el `rate-limit` se arma con la forma que devuelven los
propios equipos —`150M/150M 0/0 0/0 10/10 8/8 0/0`— y no con la de la
documentación, que difiere entre versiones en si la prioridad es un valor o un
par. El formato es posicional: los huecos van en `0/0`, y lo que esté a medio
configurar se omite con su motivo antes que arriesgar una cadena malformada, que
haría que RouterOS rechace el perfil entero.

### Cambiar un plan y que llegue a los abonados

Subir un plan de 100 a 300 megas en la base no le cambia la velocidad a nadie:
eso vive en los equipos. Y llega distinto según cómo se conecte cada uno:

| | Dónde está el límite | Qué hace falta |
|---|---|---|
| **PPPoE** | El perfil PPP, **uno solo** compartido por todos | Corregir el perfil en el router, una vez |
| **IP fija** | La Simple Queue de cada abonado | Reescribirlas de a una |

El botón **A los clientes**, en cada plan, se ocupa de lo segundo y verifica lo
primero: compara el `rate-limit` del perfil con lo que dice el plan y avisa si
difieren, que es la forma de enterarse de que alguien se olvidó de tocar el
router.

Abre primero en modo vista previa —a cuántos afecta y en qué equipos— porque es
una operación que se aprieta una vez y toca la conexión de cientos de personas.

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/planes/:id/impacto` | A cuántos afectaría. No toca nada |
| `POST` | `/api/planes/:id/sincronizar` | Reescribe las colas |
| `GET` | `/api/planes/:id/routers` | Dónde se ofrece y cómo quedó su perfil en cada equipo |
| `POST` | `/api/planes/:id/aprovisionar` | Crea o corrige el perfil PPP en los routers asignados |

#### La cola es más que un máximo

El botón **Cola** de cada plan configura lo que el `max-limit` no dice: hasta
cuánto puede pasarse el abonado por un rato (ráfaga), desde qué caudal se le
habilita, por cuántos segundos, qué se le garantiza cuando la red está cargada y
a quién se atiende primero.

Nada de eso tiene valor por defecto, y no es una omisión: cuántos segundos puede
un abonado pasarse de su plan es una decisión comercial del ISP. Un plan sin
esto configurado es un `max-limit` y nada más, que es como funcionaba antes.

Dos reglas que el equipo real impuso a los golpes:

- **La ráfaga es todo o nada.** RouterOS no acepta un `burst-limit` suelto:
  exige también el umbral y la duración. Si falta uno rechaza la cola **entera**,
  y el abonado se queda sin que se le aplique ni siquiera su velocidad. Por eso
  una ráfaga a medio configurar se omite y se avisa, en vez de mandarse.
- **RouterOS escribe la subida primero.** Un plan se habla al revés —"100 megas"
  es la bajada—. Cada par se da vuelta al salir; invertirlo le daría al abonado
  la subida como bajada, que anda pero no carga nada.

### Cobros

Los pagos son CRUD puro, así que la web habla directo con Supabase y no pasan por el
middleware — salvo "registrar pago y activar", que quita al abonado del address-list
de morosos y sí toca la red.

| Dónde | Qué hace |
|---|---|
| `/pagos` → Registrar pago | Busca al abonado, aplica el cobro contra una factura y elige cuenta de destino |
| `/pagos` → Pagos registrados | Cierre del día: total cobrado, neto de comisiones y desglose por cuenta |
| `/pagos` → Promesas de pago | Compromisos de pago, con las vencidas marcadas y el botón de volver a cortar |
| `GET /api/pagos/:id/recibo` | Recibo en PDF: original y copia en la misma hoja |
| Facturación → Configuración | Las cuentas de cobro (caja, bancos, billeteras) |

Una factura nunca se marca como "pagada": el saldo sale de sumar los pagos aplicados
(`v_facturas_por_cobrar`). Así un cobro parcial no necesita ningún estado intermedio.

#### Pagos que entran desde afuera

El bot de WhatsApp y el CRM registran cobros por `POST /api/integracion/pagos`. Lo que
pasa con ese pago **lo decide la llave, no el pedido**:

| Quién afirma que la plata entró | Qué pasa |
|---|---|
| El abonado, por chat | Queda en `pagos_reportados`. No salda nada hasta que cobranza lo verifique |
| La pasarela, por webhook | Se aplica con `aplicar_cobro`, igual que un cobro de ventanilla |

Está así porque un canal de chat es un lugar donde cualquiera escribe lo que quiere: si
el bot pudiera saldar facturas con una captura, la deuda se borraría, el corte no se
ejecutaría y el faltante recién aparecería en la conciliación del mes siguiente — ya
metido en el cierre de caja, en la comisión del vendedor y en el reporte de ARCOTEL.

La bandeja está en **Cobros → Pagos reportados**, con el monto reportado al lado de la
deuda real. Confirmar llama a `confirmar_pago_reportado()`, que aplica el cobro y marca
el reporte en la misma transacción — si fueran dos llamadas, un corte en el medio
dejaría un cobro hecho y un reporte que sigue diciendo "pendiente", y alguien lo
confirmaría de nuevo.

#### WhatsApp: fuera de la ventana de 24 h solo pasan plantillas

La API oficial solo entrega **texto libre** dentro de las 24 horas siguientes al
último mensaje del abonado. Todos los avisos automáticos caen fuera: nadie le
escribe al ISP para que le avisen que se le vence la factura.

El driver mandaba `type: "text"` siempre. Con la Cloud API eso devuelve el error
`131047` y **el mensaje no sale** — el abonado no se entera de que le van a
cortar y el sistema lo cuenta como intento. Con las vías no oficiales sí sale, y
ahí el riesgo es peor: un número no oficial mandando avisos masivos es el patrón
por el que WhatsApp bloquea.

`plantillas_whatsapp` (migración 176) guarda, para cada texto del sistema, cómo
se llama su versión aprobada en Meta y **en qué orden van sus variables** — las
nuestras tienen nombre (`{{saldo}}`), las de Meta son posicionales (`{{2}}`).

La regla: **sin plantilla aprobada, el aviso automático no se intenta por
WhatsApp.** Se cae al SMS o al correo, que sí llegan, y queda escrito el motivo.
Intentarlo daría error, el abonado no recibiría nada, y el sistema habría
contado WhatsApp como canal utilizable.

Todas se registran como **UTILITY**, nunca Marketing: una marca de spam en una
plantilla de marketing baja la calificación de calidad del número entero, y con
la calificación en rojo Meta reduce el límite de envíos y termina pausando
plantillas.

Pantalla: **Ajustes → Plantillas de WhatsApp**. Los diez textos listos para pegar
en el Administrador de Meta están en
[`docs/plantillas-whatsapp-meta.md`](docs/plantillas-whatsapp-meta.md).

#### El webhook de entrada

`POST /api/webhooks/whatsapp` — va afuera del guardián de sesión y del de
licencia, como el de firma: quien golpea es el servidor de Meta, y si no recibe
200 rápido reintenta y después **da de baja la suscripción**. Por eso contesta
antes de procesar.

Trae tres cosas, y las tres faltaban:

| Qué llega | Qué resuelve |
|---|---|
| `messages[]` | Abre la **ventana de 24 h** (`ventanas_whatsapp`). Dentro de ella, un aviso sin plantilla sale como texto en vez de no salir |
| `statuses[]` | Los acuses. Todo el código decía "el acuse real llega por webhook" y no llegaba nadie: cada mensaje quedaba en `enviado` para siempre |
| "BAJA" | Apaga `avisos_activos`. Quien pide la baja y sigue recibiendo, bloquea — y los bloqueos bajan la calificación del número, que es lo que después pausa las plantillas |

La firma (`X-Hub-Signature-256`) se verifica contra el App Secret sobre el cuerpo
**crudo**. Sin App Secret cargado el webhook acepta igual —hay que poder darlo de
alta antes de configurar todo— pero **no aplica las bajas**: sin firma, cualquiera
que descubra la URL dejaría a un abonado sin avisos.

#### Corte automático de promesas vencidas

Una promesa puede habilitar el servicio hasta la fecha acordada. Si esa fecha pasa sin
pago, el middleware corta solo — una vez al día, a la hora de `CORTES_HORA`.

| Salvaguarda | Por qué |
|---|---|
| Solo corta a quien sigue debiendo | Si pagó, queda afuera aunque nadie haya cerrado la promesa |
| Salta a quien no tiene router o IP | No se puede cortar a ciegas; queda listado para hacerlo a mano |
| Tope de `CORTES_LIMITE` por corrida | Una consulta que devuelva de más no puede dejar sin internet a todos |

Viene apagado (`CORTES_AUTOMATICOS=false` en `.env.example`): dejar sin servicio a un
abonado no es algo que deba empezar a pasar solo por instalar el sistema.
`GET /api/pagos/cortes` muestra a quién cortaría sin tocar nada, y el botón
**Cortar ahora** de la pestaña Promesas lo ejecuta sin esperar a la hora.

### API de integración (CRM y bot de WhatsApp)

Sistemas de terceros entran por `/api/integracion` con una **llave de API**, no con la
sesión de Supabase de una persona: un bot no se loguea, y darle el usuario de un
empleado deja cada cosa que hace firmada por alguien que no la hizo.

| Endpoint | Permiso | Qué devuelve |
|---|---|---|
| `GET /api/integracion/ping` | — | Prueba de la llave y qué puede hacer |
| `GET /api/integracion/clientes/:cedula` | `clientes.ver` | Estado del servicio, deuda, fecha de corte, promesa vigente |
| `GET /api/integracion/facturas/:cedula` | `facturacion.ver` | Facturas con saldo; `?estado=todas` para el historial |
| `POST /api/integracion/pagos` | `pagos.registrar` | Registra el cobro (ver arriba) |
| `POST /api/integracion/wifi` | `red.wifi` | Cambia SSID y clave por TR-069 |
| `POST /api/integracion/tickets` | `soporte.crear` | Abre un reclamo |

- La llave **no se guarda**: se guarda su huella HMAC con `CREDENTIALS_KEY`, igual que
  las sesiones del portal. Se muestra una sola vez al emitirla.
- `referencia_externa` en `POST /pagos` hace el endpoint idempotente. Sin ella, cada
  reintento del CRM es un cobro más.
- Todo queda en `api_llamadas`, incluido lo que salió bien: la pregunta que llega
  después no es "¿hubo un error?" sino "¿quién consultó esta cédula el martes?".
- Se emiten y revocan en **Ajustes → Integraciones** (permiso `config.integraciones`).

Hay **dos superficies** sobre los mismos servicios, y la diferencia importa:

| | Para quién | Forma de respuesta |
|---|---|---|
| `/api/v1` | El agente de IA del CRM. Es el contrato de `API.md` | `{status, code, message}` |
| `/api/integracion` | Integraciones propias y webhooks de pasarela | `{error, hint}` |

`/api/v1` existe porque del otro lado hay un LLM que ramifica por `code`, no por
el texto — y porque `message` se le lee al usuario final tal cual, así que ningún
error de ahí nombra una tabla ni devuelve un mensaje de Postgres. Las dos usan
los mismos servicios: no hay dos implementaciones de "cuánto debe este abonado".

Dos cosas donde `/api/v1` se aparta a propósito de lo que pedía `API.md`:

- **El pago no desbloquea el MikroTik por defecto.** Hacen falta dos condiciones:
  que la llave tenga permitido acreditar sin verificación humana, y que
  `verificado_por` sea `bank_api` o `human`. Un `ocr_only` —una imagen leída por
  el bot— queda siempre a verificar. `verificado_por` solo puede BAJAR la
  confianza que da la llave: si pudiera subirla, alcanzaría con mandar `"human"`
  para saltearse la verificación.
- **No se devuelve la IP del abonado.** No le sirve a quien pregunta por su
  factura y sí a quien quiere hacerse pasar por él.

Documentación para entregar al proveedor:
[`docs/api-v1-crm.md`](docs/api-v1-crm.md) (el contrato del CRM) y
[`docs/api-integracion.md`](docs/api-integracion.md) (la superficie propia).

### Cortes masivos: avisar al sector antes de que el sector escriba

Se corta una fibra troncal a las 19:40 y cuelgan de ella 180 abonados. En diez
minutos entran cuarenta mensajes al WhatsApp de soporte diciendo lo mismo, y el
canal queda tapado para el que tenía otra falla. El monitoreo **ya sabía** que el
nodo se cayó: lo que faltaba era decírselo a los afectados.

| Concepto | Qué es |
|---|---|
| `incidencias_masivas` | La avería o el mantenimiento: qué pasó, a quiénes afecta, hasta cuándo se estima |
| `incidencia_avisos` | Un renglón por abonado y por momento (`apertura` / `resolucion`), con índice único |
| `afectados_por_alcance()` | Quiénes están adentro. Por zona, caja NAP, nodo, OLT+puerto PON, router o lista |

El alcance se dice como se piensa el problema, no como una lista de cédulas. Con
alcance por **nodo** el recorrido es recursivo: si cae la torre, entran también
los abonados de las sectoriales que cuelgan de ella.

**Las tres salvaguardas**, porque un mensaje a 180 personas no se puede desenviar:

1. **Nace en `borrador`.** Existe, con su lista de afectados calculada, y no
   salió nada. Abrirla es un acto aparte, con el número de afectados en el
   diálogo de confirmación.
2. **El umbral de minutos.** El monitoreo solo abre una incidencia sola si el
   nodo lleva caído más que `incidencias_minutos` (15 por omisión). Un enlace de
   radio que parpadea con la lluvia vuelve antes y nadie se entera.
3. **Índice único por (incidencia, abonado, momento).** La cola se reintenta, el
   servidor se reinicia y alguien puede apretar "avisar" dos veces: nadie recibe
   el mismo mensaje dos veces.

Los avisos se **encolan**, no se mandan: 180 mensajes de golpe hacen que el
proveedor devuelva 429 a la mitad. La tarea *Aviso de cortes masivos* los drena
de a lotes.

Los dos interruptores vienen **apagados** y son distintos:
`incidencias_cola_activa` manda lo encolado; `incidencias_automatico` deja que el
monitoreo abra la incidencia por su cuenta — lo único del sistema que le escribe
a cientos de abonados sin que ninguna persona apriete nada. Con el segundo
apagado, el monitoreo igual crea los borradores: se puede mirar un mes de "qué
habría mandado" antes de encenderlo.

El "ya está solucionado" va **solo a quien recibió el aviso de la avería**.
Avisarle de la solución a quien nunca supo del problema le cuenta que estuvo sin
servicio, y genera la consulta que no existía.

Pantalla: **Red → Cortes masivos**. Permiso `red.incidencias`, aparte de
`red.monitoreo_ver`: mirar qué nodos están caídos es una cosa, escribirle a un
sector en nombre del ISP es otra.

---

## Gestión de Red e IPAM

Agrupa todo lo que es infraestructura, no abonados:

| Ruta | Qué hay |
|---|---|
| `/red/routers` | Los equipos: alta, edición, CPU/memoria/uptime en vivo e importar/exportar clientes |
| `/red/redes` | Redes IPv4: los bloques, su ocupación, el mapa de direcciones y los pools del router |
| `/red/auditoria` | Barrido de una subred para encontrar lo que nadie registró |
| `/red/shaping` | Dónde se limita el caudal de cada abonado, y quién queda sin límite |
| `/bloqueos` | Cortes / morosos |

Los routers y el direccionamiento están separados a propósito. Antes vivían en
la misma pantalla y eran dos preguntas distintas: para encontrar un pool había
que bajar por una tabla de equipos. `/mikrotik` redirige a `/red/routers` para
no romper enlaces guardados.

### El IPAM no materializa las direcciones libres

Un /24 son 254 filas por subred que habría que mantener sincronizadas para
dibujar una grilla. Lo que se guarda es lo que **alguien decidió** —esta IP es
de este abonado, esta otra está reservada para el gateway— y el resto se
calcula. El mapa lo arma el navegador restando lo ocupado al bloque.

El bloque se guarda con el tipo `CIDR` de Postgres y no como texto. En los
tickets las IPs sí son texto a propósito —quien atiende el teléfono escribe lo
que le dictan y una IP a medias no puede hacer fallar el reclamo— pero acá es al
revés: una subred mal escrita se propaga a cada dirección que se asigne desde
ella.

### Sincronizar no es lo mismo que escanear

| | Qué mira | Qué encuentra |
|---|---|---|
| **Sincronizar** | Lo que el router tiene **configurado**: direcciones, leases, secrets, sesiones | Lo declarado |
| **Escanear** | Lo que está **conectado**: tabla ARP o `ip-scan` | Lo real |

La diferencia entre las dos listas es para lo que existe la auditoría: una IP
que responde y que nadie asignó es un equipo sin registrar o alguien que se puso
una dirección que no le tocaba. Queda guardada y marcada en el mapa, para que el
hallazgo sea trabajo pendiente y no una pantalla que se cierra y se olvida.

El barrido pasivo viene por defecto: lee el ARP del router y no genera un solo
paquete hacia los abonados. El activo recorre el rango dirección por dirección y
encuentra también lo que está callado, pero es tráfico real contra la red de
producción.

---

## Monitoreo de red en tiempo real (NMS / Watchdog)

Una sola pantalla en `/monitoreo`: el tablero y el inventario eran la misma
pregunta hecha dos veces —se veía una caída y había que cambiar de pantalla para
saber de qué torre colgaba o para probarla—.

El listado muestra, por nodo, el equipo, su estado y cuántos abonados cuelgan
del sitio: **online** (con sesión abierta ahora), **activos** y **suspendidos**.
Una base caída con cero abonados es un aviso; la misma con ochenta es una
emergencia, y sin esa columna se veían igual.

Cada fila tiene ping inmediato —que no se registra en el historial—, edición,
detalle, pausa del monitoreo, gráfico y baja. El alta abre en un modal: el
formulario se usa una vez por equipo y el listado se mira todos los días.

Tres decisiones que definen cómo funciona:

**Se pinguea desde el router, no desde el servidor.** Una antena de torre casi
nunca es alcanzable desde donde corre el middleware. Preguntarle al equipo que
sí tiene ruta es la diferencia entre monitorear la red y monitorear la
conectividad del servidor.

**Un nodo hijo no alerta si su padre está caído.** Cuando se corta la fibra de
una torre, sus veinte antenas caen a la vez. Veinte mensajes al técnico a las
tres de la mañana no informan nada que el primero no dijera, y hacen que la
próxima vez nadie los lea. La caída del hijo se registra igual —con quién la
causó— pero no se avisa. Por eso los padres se sondean **antes** que los hijos:
si el hijo se evalúa primero, el padre todavía figura arriba.

**No haber podido preguntar no es estar caído.** Si el router intermedio no
contesta, el nodo queda en "sin datos" y no en DOWN. Reportarlo como caído
mandaría un técnico a una torre que está perfecta.

### El historial son intervalos, no muestras

Guardar una fila por ping cada minuto son 43.000 filas por nodo por mes para
contestar "¿cuánto estuvo caído?". Se guarda un intervalo por estado —desde
cuándo, hasta cuándo— y el uptime sale de sumarlos. Un nodo estable genera dos
filas al mes.

La consecuencia está a la vista en el gráfico del nodo: cada punto es la última
latencia medida dentro de un tramo, no una muestra por ping. Se dice en la
pantalla en vez de dibujar una línea suave que aparente una resolución que no
existe.

El watchdog viene apagado (`NMS_AUTOMATICO=false`). Encenderlo antes de cargar
el árbol de dependencias hace que el primer corte mande una alerta por cada
antena; se enciende cuando el inventario ya tiene los padres asignados.

---

## Particularidades del hardware real

Estas cuatro cosas se descubrieron probando contra los equipos y están resueltas en el
código. Vale la pena conocerlas antes de tocar los drivers:

| Hallazgo | Sistema | Dónde está resuelto |
|---|---|---|
| Las columnas se alinean con códigos ANSI de cursor, no con espacios | V-SOL | `middleware/src/lib/ansi.js` |
| Los comandos con parámetros opcionales necesitan un Enter extra | Huawei VRP | `display()` en `drivers/huawei.js` |
| El primer `tcont` nuevo en un puerto puede tumbar el puerto PON | V-SOL | Aviso en `ONUProvisionForm.jsx` |
| El puerto 8728 puede estar bloqueado aunque la API esté habilitada | MikroTik | Se usa la REST API (80/443) |
| Webfig responde HTML con código 200 si la REST API no está activa | MikroTik | Chequeo de `Content-Type` en `drivers/mikrotik.js` |

---

## Seguridad

- Las contraseñas de OLTs y routers se guardan cifradas con AES-256-GCM. La clave vive
  solo en el `.env` del middleware; el navegador nunca la ve.
- La `service_role` key de Supabase es exclusiva del middleware — bypassea RLS por diseño.
  Nunca la pongas en `web/.env`.
- El middleware valida el access token de Supabase en cada request (`REQUIRE_AUTH`).
  Dejarlo abierto equivale a exponer las OLTs y la base entera.
