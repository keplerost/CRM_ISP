# API del ISP — resumen de endpoints

Referencia rápida. El detalle de cada campo, con ejemplos de request y response,
está en `api-v1-crm.md`.

**Base:** `https://TU-SERVIDOR:4000/api/v1`

---

## Autenticación

```
X-API-Key: sk_xxxxxxxxxxxxxxxxxxxxxxxx
```

También se acepta `Authorization: Bearer sk_...`.

La llave se emite del lado del ISP, se muestra **una sola vez** y puede quedar
restringida a una lista de IPs. Cada llave lleva sus propios permisos: si le
falta el de una ruta, esa ruta contesta `403`.

---

## Ejemplo completo: registrar un pago

```bash
curl -X POST https://TU-SERVIDOR/api/v1/pagos/registrar   -H "X-API-Key: sk_..." -H "Content-Type: application/json"   -d '{
    "cedula": "1204567890",
    "monto": 20.00,
    "forma_pago": "app",
    "banco_origen": "Banco Pichincha",
    "cuenta_destino": "2100300272",
    "num_comprobante": "92947292",
    "hash_qr": "9aa587037b5c4441ffcff621f722c7e1",
    "uuid_transaccion": "65702911-c699-4ac3-84e1-25f653fe9900",
    "fecha_transaccion": "2026-08-19 14:32:00",
    "depositante": "JOSE PEREZ",
    "verificado_por": "qr_validado",
    "comprobante_url": "https://.../comprobante.jpg",
    "origen": "BOT_WHATSAPP"
  }'
```

Acreditado (`201`):

```json
{
  "status": "success",
  "mensaje": "Pago registrado y servicio restablecido.",
  "transaccion_id": "REP-308b0090",
  "reporte_id": "308b0090-…",
  "pago_id": "1c9f…",
  "acreditado": true,
  "estado": "confirmado",
  "repetido": false,
  "cuenta": "Pichincha Corriente",
  "saldo_restante": 0,
  "facturas_saldadas": [{ "numero": "00001042", "monto": 20.00 }],
  "reactivacion": { "ok": true, "nota": "Se quitó 10.20.0.45 del corte en el router." }
}
```

Repetido (`200`) — mismo `reporte_id`, y `repetido: true`:

```json
{
  "status": "success",
  "mensaje": "Este comprobante ya lo habíamos recibido y lo estamos validando. No se duplicó el pago.",
  "reporte_id": "308b0090-…",
  "acreditado": false,
  "estado": "pendiente",
  "repetido": true,
  "saldo_restante": 0
}
```

---

## Los endpoints

| # | Método y ruta | Permiso | Qué hace |
|---|---|---|---|
| 1 | `GET /cliente/consultar-deuda` | `clientes.ver` **o** `facturacion.ver` | Estado del servicio, deuda total y facturas pendientes |
| 2 | `POST /pagos/registrar` | `pagos.registrar` | Registra un pago. Mandá `hash_qr`, `verificado_por` y `cuenta_destino` |
| 2b | `GET /pagos/comprobante` | `pagos.registrar` | **Consulta** si un comprobante ya está registrado. No crea nada |
| 3 | `POST /ventas/validar-cobertura` | `ventas.cobertura` | Si hay caja con puerto libre cerca de unas coordenadas |
| 4 | `GET /ventas/planes` | `ventas.planes` | Catálogo de planes activos |
| 5 | `POST /ventas/agendar-instalacion` | `ventas.solicitudes` | Crea la orden y reserva el cupo en la agenda |
| 6 | `POST /soporte/crear-ticket` | `soporte.crear` | Abre un reclamo |
| 7 | `GET /red/diagnostico-ont` | `red.diagnostico` | Diagnóstico de la conexión, con conclusión |
| 8 | `POST /red/cambiar-wifi` | `red.wifi` | Cambia SSID y clave por TR-069 |

Además: `GET /api/integracion/ping` — prueba la llave y devuelve sus permisos.

---

## Cómo se identifica al abonado

Casi todos aceptan **cualquiera de las tres**:

| | |
|---|---|
| `cliente_id` | El más confiable. Lo devuelve `consultar-deuda` |
| `cedula` | Lo que el abonado dice cuando se lo pedís |
| `telefono` | Lo que ya tenés al abrir la conversación |

**Sobre `telefono`:** identifica un aparato, no una persona. Si el número figura
en la ficha de dos abonados, la respuesta es `409 TELEFONO_AMBIGUO` y hay que
pedir la cédula. No se elige uno: mostrarle a alguien la deuda de otro es una
filtración, no una comodidad.

Se acepta en cualquier formato: `0991234567`, `+593991234567`, `593991234567`.

Los ids son **UUID** (`"a3f1c8e2-…"`), no enteros. Tratalos como cadenas opacas.

---

## Formato de respuesta

Éxito — siempre `status: "success"` más los campos del endpoint.

Error:

```json
{
  "status": "error",
  "code": "CLIENTE_NO_ENCONTRADO",
  "message": "No hay ningún abonado con la identificación 1204567890.",
  "hint": "Puede estar cargado con otra cédula, o ser el titular otra persona de la casa."
}
```

**Ramificá por `code`, nunca por `message`.** El texto está escrito para leérselo
al usuario y puede mejorarse; el código no cambia.

| `code` | HTTP | |
|---|---|---|
| `DATOS_INVALIDOS` | 400 | Falta un campo o el formato no se acepta |
| `NO_AUTORIZADO` | 401 | Falta la llave o no es válida |
| `SIN_PERMISO` | 403 | La llave no tiene ese permiso, o la IP no está habilitada |
| `CLIENTE_NO_ENCONTRADO` | 404 | Esa cédula, teléfono o id no existe |
| `TELEFONO_AMBIGUO` | 409 | El número está en la ficha de más de un abonado |
| `AVERIA_CONOCIDA` | 409 | Hay un corte abierto que explica lo que reporta |
| `YA_ES_ABONADO` | 409 | La cédula ya tiene servicio activo |
| `LIMITE_EXCEDIDO` | 429 | Cupo agotado; mirá el header `Retry-After` |
| `ERROR_INTERNO` | 500 | Problema nuestro. Reintentá con espera creciente |

`message` es apto para mostrarle al abonado en todos los casos, incluido el 500.

---

## Cupos

- **120 pedidos por minuto** por llave.
- **6 por minuto** para lo que toca los equipos: `diagnostico-ont?en_vivo=1` y
  `cambiar-wifi`. Una OLT admite tres sesiones SSH y el técnico necesita una
  justo cuando está atendiendo un corte.

---

## Las cinco cosas que hay que leer antes de programar

### 1 · `falla_masiva_sector` manda sobre todo lo demás

`consultar-deuda` y `diagnostico-ont` lo devuelven. Cuando es `true`, hay un
corte que el ISP **ya conoce** y que afecta a ese abonado: viene un `mensaje`
listo para leer. Contestá eso y cerrá la conversación — no diagnostiques ni abras
ticket.

Es el único campo de toda esta API cuyo propósito es que el bot **deje** de hacer
cosas. Es lo que evita que un corte de fibra genere ciento ochenta tickets por la
misma causa.

### 2 · Un pago registrado no siempre está acreditado

`POST /pagos/registrar` devuelve `acreditado: true|false`. Se acredita solo
cuando se dan **tres** condiciones:

1. La llave tiene habilitado acreditar sin verificación humana.
2. `verificado_por` es `bank_api`, `qr_validado` o `human`.
3. Se sabe **a qué cuenta entró** la plata.

Si falta alguna, el pago queda registrado pero **pendiente**, y la respuesta trae
`motivo_pendiente` diciendo cuál.

**`verificado_por` — cómo se comprobó:**

| Valor | Qué significa | ¿Acredita solo? |
|---|---|---|
| `bank_api` | Lo confirmó el banco | Sí |
| `qr_validado` | El QR del comprobante coincide con su texto y con la cuenta destino | Sí |
| `human` | Lo aprobó una persona del ISP | Sí |
| `ocr_only` | Solo se leyó la imagen | **No** — queda a verificar |

`qr_validado` es el que corresponde cuando el bot escanea el QR y lo compara
contra los datos impresos: retocar el texto visible no cambia el QR, así que una
imagen editada no pasa esa prueba.

Este campo solo puede **bajar** la confianza que da la llave, nunca subirla.

**`cuenta_destino` — a qué cuenta entró:**

Mandá el **número de cuenta tal como figura en el comprobante** (con guiones o
sin ellos, se comparan solo los dígitos). El ISP puede tener más de una cuenta y
el abonado transfiere a la que quiere; sin este dato el pago **no se acredita**,
queda esperando que alguien elija la cuenta a mano.

Si el número **no corresponde a ninguna cuenta del ISP**, el pago se rechaza:

```json
{
  "status": "error",
  "code": "CUENTA_DESCONOCIDA",
  "message": "La cuenta 1234567890 no es una cuenta de cobro de este ISP."
}
```

No es una molestia: si el comprobante dice que el dinero fue a otro lado,
acreditarlo saldaría una factura con plata que nunca llegó.

La respuesta devuelve `cuenta` con el nombre ya resuelto, para que puedas
confirmar que el número se interpretó como esperabas.

**Decile al abonado lo que dice `mensaje`.** Prometer "ya está acreditado" cuando
`acreditado` es `false` genera el reclamo del día siguiente, cuando sigue cortado.

### 3 · Un comprobante repetido no es un error

`POST /pagos/registrar` contesta **200** con `repetido: true` cuando ese
comprobante ya estaba. **No es un fallo**: es la confirmación de que está
registrado y de que hay que **dejar de reintentar**. Un pago nuevo contesta 201.

Para preguntar *antes* de registrar está `GET /pagos/comprobante`. Ahí:

- `puede_reenviar` es `true` **solo** si fue rechazado — ahí conviene pedir otra
  foto.
- `del_mismo_abonado: false` significa que el comprobante ya figura a nombre de
  **otro**. No se dice de quién, a propósito.

**Mandá siempre `hash_qr`.** Es la huella de la imagen: no hay que acordarse de
generarla y es la única que identifica una transferencia concreta.
`num_comprobante` por sí solo no deduplica — dos bancos pueden emitir el mismo
número.

### 4 · La fecha tiene que empezar por el año

`2026-08-17`, `2026-08-17 05:00:00` y `2026-08-17T05:00:00Z` se aceptan.
`15/08/2026` **se rechaza**.

No es rigidez: `01/02/2026` es válido leído como 1 de febrero y como 2 de enero,
JavaScript elige uno sin avisar, y el cobro queda un mes corrido sin que nadie lo
note hasta que la caja no cierre.

### 5 · El 409 de los tickets es una respuesta válida

Si hay una avería conocida que afecta al abonado y reporta falta de servicio,
`POST /soporte/crear-ticket` contesta `409 AVERIA_CONOCIDA` con la incidencia
adentro. **No abras el ticket**: contestá el `mensaje` de la incidencia.

Un reclamo por cambio de clave durante una avería sí se abre — solo se bloquean
los tipos que la avería explica.

---

## Resultados de `diagnostico-ont`

Devuelve una **conclusión**, no mediciones. Los tres campos que usa el bot:
`mensaje` (texto para leer tal cual), `accion_sugerida` y `abrir_ticket`.

| `resultado` | Qué hace el bot |
|---|---|
| `averia_zona` | Informa. **No** abre ticket |
| `corte_por_deuda` | Ofrece el monto y las formas de pago |
| `sin_fibra` | Pide revisar el cable de la casa, luego escala |
| `equipo_apagado` | Pide revisar corriente y reintentar |
| `senal_baja` | Escala: hace falta visita técnica |
| `sin_respuesta` | Ofrece reiniciar el equipo |
| `todo_ok` | Sugiere reiniciar el router WiFi del abonado |
| `sin_datos` | Escala |

Por omisión no toca ningún equipo. Con `?en_vivo=1` abre SSH contra la OLT y
pinguea desde el router — ahí rige el cupo de 6 por minuto. Usalo cuando el
rápido dice `todo_ok` y el abonado insiste.

---

## Lo que esta API no devuelve

La IP del abonado, su clave PPPoE y el serial completo de su equipo. Nada de eso
hace falta para vender ni para cobrar, y todo eso sirve para hacerse pasar por
él.

---

## Registro

Cada llamada queda registrada del lado del ISP con la ruta, la cédula
consultada, el resultado y la IP de origen. Contesta "¿quién consultó los datos
de este abonado el martes?".
