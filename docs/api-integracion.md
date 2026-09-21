# API de integración — CRM y bot de WhatsApp

Esta es la documentación que se le entrega al proveedor del CRM. Describe todo
lo que un sistema externo puede consultar y hacer contra el sistema del ISP.

---

## 1. Cómo se autentica

Cada sistema externo recibe una **llave de API**. Se emite desde
**Ajustes → Integraciones**, se muestra una sola vez y no se puede volver a ver:
si se pierde, se revoca y se emite otra.

La llave viaja en un header, en todos los pedidos:

```
X-API-Key: sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

También se acepta `Authorization: Bearer sk_...`, para clientes HTTP que solo
saben mandar ese header.

**Probá la llave antes de escribir nada más:**

```bash
curl -H "X-API-Key: sk_..." https://TU-SERVIDOR:4000/api/integracion/ping
```

```json
{
  "ok": true,
  "llave": "Bot de WhatsApp",
  "permisos": ["clientes.ver", "facturacion.ver", "pagos.registrar"],
  "pagos": "quedan a verificar"
}
```

El campo `pagos` dice qué va a pasar cuando registres un cobro con esta llave:
`quedan a verificar` o `se acreditan al instante`. Ver la sección 4.

### Permisos

Cada llave tiene solo lo que necesita. Si le falta uno, la respuesta es `403` y
dice cuál falta.

| Permiso            | Habilita                                  |
| ------------------ | ----------------------------------------- |
| `clientes.ver`     | `GET /clientes/:identificacion`           |
| `facturacion.ver`  | `GET /facturas/:identificacion`           |
| `pagos.registrar`  | `POST /pagos`                             |
| `red.diagnostico`  | `GET`/`POST /diagnostico/:cedula`, `POST /reiniciar-equipo` |
| `red.wifi`         | `POST /wifi`                              |
| `soporte.crear`    | `POST /tickets`                           |

### Límites

- **120 pedidos por minuto por llave.** Al pasarse, `429` con el header
  `Retry-After`. No es una defensa contra un ataque: es el freno al bucle de
  reintentos que consulta la misma cédula cuatro mil veces.
- **6 por minuto** para las operaciones que tocan los equipos: el diagnóstico
  profundo y el reinicio de la ONT. Una OLT admite tres sesiones SSH a la vez, y
  el técnico necesita una de ellas justo cuando está atendiendo un corte.
- La llave puede quedar restringida a una lista de IPs. Si el CRM cambia de
  servidor, hay que avisar antes: la llave deja de funcionar en el acto.

---

## 2. Consultar el estado de un abonado

Es lo primero que conviene pedir cuando alguien escribe "no tengo internet":
contesta el estado del servicio, la deuda, cuándo le toca el corte y si tiene un
plazo de pago acordado.

```bash
curl -H "X-API-Key: sk_..." \
  https://TU-SERVIDOR:4000/api/integracion/clientes/1712345678
```

```json
{
  "cliente": {
    "nombre": "María Pérez",
    "identificacion": "1712345678",
    "codigo_pago": "10245",
    "pasarela": "Cuentadigital"
  },
  "servicio": {
    "estado": "cortado",
    "plan": "Plan 100 Megas",
    "bajada_mbps": 100,
    "subida_mbps": 100,
    "precio": 25.0
  },
  "equipo": {
    "modelo": "HG8145V5",
    "serial_corto": "····A3F1",
    "en_linea": true,
    "senal": { "nivel": "buena", "texto": "Tu señal está bien" },
    "ssid": "FIBER-MPEREZ",
    "ultima_lectura": "2026-08-19T10:12:00Z"
  },
  "cuenta": {
    "saldo": 50.0,
    "facturas_pendientes": 2,
    "fecha_corte": "2026-08-15",
    "dias_gracia": 5
  },
  "promesa_vigente": null,
  "incidencia_activa": {
    "id": "3a91…",
    "tipo": "fibra_rota",
    "titulo": "Fibra cortada en la vía a El Progreso",
    "programada": false,
    "desde": "2026-08-19T19:40:00Z",
    "estimado": "2026-08-19T22:30:00Z",
    "mensaje": "Tenemos una avería en tu sector: Fibra cortada en la vía a El Progreso. Estimamos restablecerlo alrededor de las 19/08 22:30."
  }
}
```

**Cómo leerlo en el chat**

- `servicio.estado` es `activo`, `cortado` o `suspendido`.
- `equipo.en_linea: false` con `servicio.estado: "activo"` = el abonado está al
  día y el equipo no reporta. Ahí hay una falla real: corresponde abrir ticket
  (sección 7), no hablar de plata.
- `equipo.en_linea: true` con `servicio.estado: "cortado"` = el equipo está
  encendido pero el router le corta el tráfico. Es deuda: contestar con el saldo.
- `cuenta.fecha_corte` es el día en que le corresponde el corte. Si es futura,
  todavía está a tiempo.
- **`incidencia_activa` manda sobre todo lo demás.** Cuando no es `null`, hay un
  corte que el ISP ya conoce y que afecta a este abonado. Contestá su `mensaje`
  —viene armado para leerse tal cual— y **no** abras un ticket ni sigas
  diagnosticando: el equipo técnico ya está trabajando en eso. Es el único campo
  de toda esta API cuyo propósito es que el bot deje de hacer cosas.

**No se devuelven** la IP, la clave del PPPoE ni el serial completo del equipo:
nada de eso hace falta para vender ni para cobrar, y todo eso sirve para hacerse
pasar por el abonado.

---

## 3. Consultar facturas por cédula

```bash
curl -H "X-API-Key: sk_..." \
  https://TU-SERVIDOR:4000/api/integracion/facturas/1712345678
```

```json
{
  "cliente": {
    "nombre": "María Pérez",
    "identificacion": "1712345678",
    "codigo_pago": "10245",
    "estado_servicio": "cortado"
  },
  "total_pendiente": 50.0,
  "facturas": [
    {
      "id": "8f3c…",
      "numero": 1042,
      "concepto": "Servicio de internet — Julio 2026",
      "periodo": "2026-07-01",
      "emision": "2026-07-01",
      "vencimiento": "2026-07-10",
      "total": 25.0,
      "pagado": 0,
      "pendiente": 25.0,
      "estado": "vencida",
      "tiene_comprobante": true
    }
  ]
}
```

Por defecto vienen **solo las que tienen saldo**. Para el historial completo:

```
GET /api/integracion/facturas/1712345678?estado=todas
```

`estado` de cada factura: `pagada`, `vencida` o `pendiente`. El campo que importa
para cobrar es `pendiente`, no `total`: una factura puede tener un pago parcial.

---

## 4. Registrar un pago

```bash
curl -X POST https://TU-SERVIDOR:4000/api/integracion/pagos \
  -H "X-API-Key: sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "identificacion": "1712345678",
    "monto": 25.00,
    "forma_pago": "transferencia",
    "fecha_pago": "2026-08-19",
    "n_transaccion": "8842119",
    "referencia_externa": "wa-2026-08-19-000431",
    "comprobante_url": "https://tu-crm/archivos/comprobante-431.jpg",
    "notas": "Comprobante enviado por WhatsApp"
  }'
```

| Campo                | Obligatorio | Notas                                                              |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| `identificacion`     | sí          | cédula o RUC; se limpian puntos y guiones                          |
| `monto`              | sí          | mayor que cero                                                     |
| `forma_pago`         | no          | `efectivo` · `transferencia` · `deposito` · `tarjeta` · `otro`     |
| `fecha_pago`         | no          | `AAAA-MM-DD`. Por defecto hoy. **No puede ser futura**             |
| `n_transaccion`      | no          | el número del comprobante del banco                                |
| `referencia_externa` | **mandala** | la clave del CRM. Es lo que evita el pago duplicado                |
| `comprobante_url`    | no          | a dónde quedó la captura que mandó el abonado                      |
| `notas`              | no          | texto libre                                                        |

### Los dos caminos

Qué pasa con el pago **lo decide la llave, no este pedido**. Es deliberado: si el
sistema externo pudiera mandar `confirmado: true`, la diferencia entre las dos
cosas la decidiría quien llama, y entonces no existiría.

**a) Llave de bot — el pago queda a verificar** (`201`)

```json
{
  "repetido": false,
  "reporte_id": "6b21…",
  "estado": "pendiente",
  "confirmado": false,
  "mensaje": "Recibimos el reporte del pago. Lo verificamos y se acredita apenas se confirme."
}
```

El pago **todavía no salda nada**: la deuda del abonado sigue igual y el servicio
cortado sigue cortado. Cobranza lo ve en **Cobros → Pagos reportados**, lo cruza
contra el extracto y lo confirma. Recién ahí entra a caja.

Lo que el bot tiene que decirle al abonado es eso, y no "listo, ya está
acreditado". Prometer una acreditación que todavía no ocurrió genera el reclamo
al día siguiente, cuando sigue cortado.

**b) Llave de pasarela — el pago se acredita solo** (`201`)

```json
{
  "repetido": false,
  "reporte_id": "6b21…",
  "estado": "confirmado",
  "confirmado": true,
  "pago_id": "1c9f…",
  "facturas_saldadas": [
    { "numero": "00001042", "monto": 25.0 },
    { "numero": "00001071", "monto": 25.0 }
  ],
  "saldo_a_favor": 0,
  "reactivacion": { "ok": true, "nota": "Se quitó 10.20.0.45 del corte en el router.", "estado": "activo" }
}
```

El cobro se reparte entre las facturas de la más vieja a la más nueva, y lo que
sobra queda a favor del abonado (`saldo_a_favor`) para la próxima factura.

`reactivacion` aparece solo si la llave tiene habilitado reactivar. **Miralo**:
`ok: false` significa que el cobro entró pero el abonado sigue sin servicio — el
bot tiene que decir "tu pago se acreditó, estamos restableciendo el servicio" y
el ISP tiene que ver ese caso.

### Idempotencia — mandá siempre `referencia_externa`

Cuando la referencia ya estaba registrada, la respuesta es `200` (no `201`):

```json
{
  "repetido": true,
  "reporte_id": "6b21…",
  "estado": "pendiente",
  "pago_id": null,
  "mensaje": "Ese pago ya estaba registrado con la misma referencia. No se duplicó."
}
```

Eso **no es un error**: es la confirmación de que el pago está y de que podés
dejar de reintentar. Sin esta clave, cada reintento —un enlace que se cayó, un
webhook que la pasarela repite, el abonado que manda el comprobante dos veces—
es un cobro más, y el abonado termina con saldo a favor que nadie le debe.

Usá una referencia estable y única por pago: el id del mensaje, el id de la
transacción de la pasarela, lo que sea, mientras sea el mismo en el reintento.

---

## 5. Diagnosticar la conexión

Es lo que contesta "no tengo internet" sin pasar por una persona. **No devuelve
mediciones: devuelve una conclusión.**

```bash
curl -H "X-API-Key: sk_..."   https://TU-SERVIDOR:4000/api/integracion/diagnostico/1712345678
```

```json
{
  "cliente": { "nombre": "María Pérez", "identificacion": "1712345678" },
  "resultado": "sin_fibra",
  "mensaje": "Tu equipo no está recibiendo señal de fibra. Suele ser el cable de la casa: revisá que no esté doblado, pisado ni desconectado del equipo. Si está bien, mandamos un técnico.",
  "accion": "revisar_equipo",
  "abrir_ticket": true,
  "pasos": [{ "paso": "deuda", "valor": 0 }, { "paso": "ont", "estado": "los" }]
}
```

Los tres campos que usa el bot:

- **`mensaje`** — el texto tal cual, escrito para leerse en un chat. No lo
  reescribas: está pensado para que el abonado sepa qué hacer.
- **`accion`** — qué sigue: `informar` · `cobrar` · `revisar_equipo` ·
  `reiniciar` · `escalar`.
- **`abrir_ticket`** — si corresponde escalarlo. Cuando es `false`, abrir uno
  igual manda un técnico a una casa donde no hay nada que arreglar.

| `resultado`       | Qué pasa                                    | Qué hace el bot                       |
| ----------------- | ------------------------------------------- | ------------------------------------- |
| `averia_zona`     | corte conocido en su sector                 | informa; **no** abre ticket           |
| `corte_por_deuda` | suspendido por saldo                        | ofrece el monto y las formas de pago  |
| `sin_fibra`       | la ONT no ve señal óptica                   | pide revisar el cable, luego escala   |
| `equipo_apagado`  | la ONT no reporta                           | pide revisar corriente y reintentar   |
| `senal_baja`      | conectado, potencia por debajo de −28 dBm   | escala: hace falta una visita         |
| `sin_respuesta`   | en línea pero no contesta el ping           | ofrece reiniciar el equipo            |
| `todo_ok`         | de nuestro lado está bien                   | sugiere reiniciar su router WiFi      |
| `sin_datos`       | no hay con qué revisarlo                    | escala                                |

`pasos` trae lo que se fue descartando, para el registro del CRM. No lo muestres
al abonado.

### El diagnóstico profundo

El de arriba no toca ningún equipo. Cuando devuelve `todo_ok` y el abonado
insiste, este habla con la OLT y pinguea desde el router:

```bash
curl -X POST https://TU-SERVIDOR:4000/api/integracion/diagnostico/1712345678   -H "X-API-Key: sk_..."
```

Mismo formato de respuesta, con la señal leída en vivo. **Tarda segundos y está
limitado a 6 por minuto**: consume una de las tres sesiones SSH que admite una
OLT, y el técnico necesita esas sesiones justo durante un corte. No lo llames
por rutina.

### Reiniciar el equipo del abonado

```bash
curl -X POST https://TU-SERVIDOR:4000/api/integracion/reiniciar-equipo   -H "X-API-Key: sk_..."   -H "Content-Type: application/json"   -d '{ "identificacion": "1712345678" }'
```

Reinicia **su** ONT y solo la suya: el equipo se busca en su ficha, no se recibe
por parámetro. Es la acción que más llamadas resuelve, y la que el abonado ya
hace igual —peor— desenchufando el equipo. Tarda entre uno y dos minutos en
volver; decíselo, o va a escribir a los treinta segundos.

Si su equipo no admite reinicio remoto, contesta `400` con un mensaje que se le
puede leer tal cual.

---

## 6. Cambiar la clave del WiFi

```bash
curl -X POST https://TU-SERVIDOR:4000/api/integracion/wifi \
  -H "X-API-Key: sk_..." \
  -H "Content-Type: application/json" \
  -d '{ "identificacion": "1712345678", "clave": "MiClaveNueva2026", "ssid": "CASA-PEREZ" }'
```

- `clave`: entre 8 y 63 caracteres (WPA2 no acepta menos de 8).
- `ssid`: opcional, hasta 32 caracteres.
- Se puede mandar uno solo de los dos.

La respuesta distingue **dos cosas distintas** y el bot tiene que distinguirlas
también: que el cambio se aplicó en el equipo, o que quedó pedido para que
alguien lo haga. Decir "listo" cuando el WiFi sigue con la clave vieja es peor
que decir que va a demorar.

Si el abonado tiene un equipo que no admite el cambio remoto, la respuesta es
`400` con un mensaje que se le puede leer tal cual.

---

## 7. Abrir un reclamo

```bash
curl -X POST https://TU-SERVIDOR:4000/api/integracion/tickets \
  -H "X-API-Key: sk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "identificacion": "1712345678",
    "tipo": "sin_internet",
    "descripcion": "Desde ayer a la noche no navega. El equipo tiene la luz roja."
  }'
```

`tipo`: `sin_internet` · `lento` · `intermitente` · `cambio_clave` · `otro`.

`sin_internet` entra con prioridad alta; el resto, media.

```json
{
  "cliente": { "nombre": "María Pérez", "identificacion": "1712345678" },
  "ticket": { "id": "a71c…", "numero": 412 }
}
```

Si el abonado **ya tiene un reclamo abierto del mismo tipo**, la respuesta es
`400` y trae el número del que ya existe. Contestá con ese número —"ya lo estamos
viendo, es el N° 412"— en vez de abrir el quinto ticket por lo mismo: cada
duplicado manda un técnico más a la misma casa.

### El 409: ya sabemos de esta falla

Si hay una **avería abierta que afecta a este abonado** y el tipo es
`sin_internet`, `intermitente` o `lento`, no se abre ticket. La respuesta es
`409`:

```json
{
  "error": "Ya conocemos esta falla: hay una avería abierta en su sector.",
  "hint": "Contestale con el mensaje de la incidencia. No hace falta abrir un reclamo.",
  "ticket_creado": false,
  "incidencia": {
    "titulo": "Fibra cortada en la vía a El Progreso",
    "estimado": "2026-08-19T22:30:00Z",
    "mensaje": "Tenemos una avería en tu sector: Fibra cortada en la vía a El Progreso. Estimamos restablecerlo alrededor de las 19/08 22:30."
  }
}
```

Esto es lo que evita que un corte de fibra genere ciento ochenta tickets por la
misma causa. **Tratalo como una respuesta válida, no como un error**: contestá el
`mensaje` de la incidencia y cerrá la conversación.

Los tipos que la avería no explica —`cambio_clave`, `otro`— se abren normalmente
aunque haya un corte en curso: quien escribe por otra cosa durante una avería
sigue necesitando ser atendido.

### El abonado no tiene que enterarse dos veces

Cuando el ISP abre una avería, el sistema **ya le manda un mensaje** a todos los
afectados por su canal habitual (WhatsApp, SMS o correo), y otro cuando se
soluciona. Si tu bot además contesta la incidencia cuando el abonado escribe, es
correcto — pero no armes tu propia campaña de avisos masivos sobre esta API: se
duplicarían.

---

## 8. Errores

Todos tienen la misma forma:

```json
{
  "error": "No hay ningún abonado con la identificación 1712345678.",
  "hint": "Puede estar cargado con otra cédula, o ser el titular otra persona de la casa."
}
```

| Código | Qué pasó                                             | Qué hacer                                          |
| ------ | ---------------------------------------------------- | -------------------------------------------------- |
| `400`  | Falta un dato o está mal formado                     | El texto de `error` se le puede leer al abonado     |
| `401`  | Falta la llave, o no es válida                       | Revisar el header. No reintentar                    |
| `403`  | Llave revocada, sin ese permiso, o IP no habilitada  | Avisar al ISP. No reintentar                        |
| `404`  | No existe un abonado con esa cédula                  | Pedirle la cédula del titular del servicio          |
| `429`  | Se pasó del límite por minuto                        | Esperar lo que dice `Retry-After`                   |
| `502`  | El sistema no pudo hablar con la base o con un equipo| Reintentar con espera creciente                     |

El campo `hint`, cuando viene, está escrito para que se pueda mostrar tal cual.

**Sobre reintentar `POST /pagos`:** con `referencia_externa` es seguro reintentar
siempre. Sin ella, un reintento tras un timeout puede duplicar el cobro.

---

## 9. Del lado del ISP

- **Ajustes → Integraciones** — emitir y revocar llaves, y ver el registro de
  todo lo que pidió cada una (qué ruta, con qué cédula, con qué resultado). Es lo
  que contesta "¿quién consultó los datos de este abonado el martes?".
- **Cobros → Pagos reportados** — la bandeja de lo que el bot dice que se pagó.
  Cada fila muestra el monto reportado **al lado de la deuda real**, que es lo
  que permite ver de un vistazo si el comprobante tiene sentido. Al confirmar se
  elige a qué cuenta entró la plata y, si el abonado está cortado, si se le
  devuelve el servicio.

- **Red → Cortes masivos** — las averías y los mantenimientos que se le
  comunican a un sector. Es de donde sale el `incidencia_activa` que ve el bot y
  el `409` de los tickets. El monitoreo crea el borrador solo cuando detecta un
  nodo caído; abrirlo —que es lo que manda los mensajes— lo decide una persona,
  salvo que el ISP encienda la apertura automática.

Revocar una llave la corta en el acto. La fila no se borra: el rastro de lo que
hizo tiene que seguir existiendo aunque la integración ya no exista.
