# `lookup_client` — cómo configurarlo contra esta API

Para el proveedor del CRM.

---

## Primero: qué pasó en la prueba

```
Lo que devolvió tu API (HTTP 0)
"La integración no tiene configurado el endpoint \"lookup_client\""
```

**`HTTP 0` significa que no hubo pedido.** No es un timeout, ni un `401`, ni una
respuesta mal formada: el CRM nunca salió a la red, porque no tiene a dónde ir.
El mensaje que sigue lo dice con todas las letras — falta configurar el endpoint.

Por eso el `field_map` todavía no importa: mientras no haya llamada, no hay
respuesta que mapear. El aviso sobre `client.name` y `client.external_ref` es una
consecuencia del anterior, no una segunda falla.

La API está arriba y responde. Se comprueba en un segundo:

```bash
curl -H "X-API-Key: LA_LLAVE" \
  "https://TU-URL/api/v1/cliente/consultar-deuda?cedula=99900030"
```

---

## El endpoint

| | |
|---|---|
| **Método** | `GET` |
| **Ruta** | `/api/v1/cliente/consultar-deuda` |
| **Parámetro** | `cedula` en la query string |
| **Autenticación** | header `X-API-Key` (o `Authorization: Bearer`) |

```
GET {base}/api/v1/cliente/consultar-deuda?cedula={documento}
X-API-Key: sk_...
```

Se aceptan tres nombres para el mismo dato —`cedula`, `documento` e
`identificacion`— así que si el CRM ya arma la query con el suyo, funciona sin
tocar nada. También se puede buscar por `telefono` o por `cliente_id`.

**Sobre `telefono`:** si ese número figura en la ficha de dos abonados se
contesta `TELEFONO_AMBIGUO` en vez de elegir uno. Mostrarle la deuda del vecino a
quien comparte el celular de la casa es una falla de privacidad, no una
comodidad. Cuando pase, hay que pedir la cédula.

---

## La respuesta, tal cual sale

Abonado encontrado — **HTTP 200**:

```json
{
  "status": "success",
  "cliente": {
    "id": "9248d012-540b-4ca1-845b-8d21a548630a",
    "nombre": "DEMO CARTERA UNO",
    "cedula": "99900030",
    "estado_servicio": "ACTIVO",
    "codigo_pago": null
  },
  "deuda_total": 20.09,
  "facturas_pendientes": [
    {
      "factura_id": "ffe375d0-7898-43bb-b8ad-07f8cad89b51",
      "numero": 56,
      "mes": "agosto 2026",
      "monto": 20.09,
      "total_factura": 20.09,
      "fecha_vencimiento": "2026-08-17",
      "estado": "vencida"
    }
  ],
  "falla_masiva_sector": false,
  "incidencia": null
}
```

---

## El `field_map`

Los nombres no coinciden con los que espera el CRM, y para eso está el mapeo:

| Campo del CRM | Ruta en esta respuesta |
|---|---|
| `client.name` | `cliente.nombre` |
| `client.external_ref` | `cliente.id` |
| `client.document` | `cliente.cedula` |
| `client.status` | `cliente.estado_servicio` |
| `total_adeudado` | `deuda_total` |
| `facturas` | `facturas_pendientes` |
| `encontrado` | *derivado del HTTP* — ver abajo |

**`external_ref` tiene que ser `cliente.id`, no la cédula.** Es el UUID del
abonado, y es lo que los demás endpoints aceptan como `cliente_id`. La cédula
sirve para buscar; el `id` sirve para operar. Guardar la cédula como referencia
obliga a volver a buscar en cada paso, y se rompe el día que a alguien le
corrigen un dígito mal cargado.

Dentro de cada factura:

| Campo del CRM | Ruta |
|---|---|
| `invoice.id` | `factura_id` |
| `invoice.number` | `numero` |
| `invoice.amount` | `monto` |
| `invoice.due_date` | `fecha_vencimiento` |

**`monto` es lo que FALTA, no el total de la factura.** Cuando hubo un abono
parcial los dos valores difieren, y `total_factura` está al lado justamente para
que se vea la diferencia. Si el bot le lee el total a un abonado que ya entregó
la mitad, le cobra dos veces lo mismo.

---

## `encontrado` sale del código HTTP

Esta API no contesta `200` con `encontrado: false`. Usa el código:

| HTTP | `code` | Qué es |
|---|---|---|
| `200` | — | Existe. `encontrado = true` |
| `404` | `CLIENTE_NO_ENCONTRADO` | No existe. `encontrado = false` |
| `400` | `DATOS_INVALIDOS` | No se mandó ningún identificador |
| `409` | `TELEFONO_AMBIGUO` | Ese teléfono está en dos fichas |
| `401` / `403` | — | Llave ausente, inválida o revocada |

El cuerpo del `404`:

```json
{
  "status": "error",
  "code": "CLIENTE_NO_ENCONTRADO",
  "message": "No hay ningún abonado con la identificación 1799999999.",
  "hint": "Puede estar cargado con otra cédula, o ser el titular otra persona de la casa."
}
```

**El `404` es una respuesta, no una falla.** Si la integración lo trata como
error de transporte, va a reintentar y a mostrar "no se pudo consultar" cuando lo
correcto es decirle al cliente que esa cédula no figura. Los reintentos que sí
valen la pena son sobre `5xx`.

`code` es estable y está pensado para que el CRM ramifique sobre él; `message` y
`hint` están escritos para leerle al abonado y pueden cambiar de redacción.

---

## Dos campos que no estaban en la especificación

```json
"falla_masiva_sector": true,
"incidencia": {
  "mensaje": "Estamos trabajando en una rotura de fibra que afecta su sector...",
  "estimado": "2026-08-19T18:30:00Z"
}
```

Cuando `falla_masiva_sector` viene en `true`, el sistema ya sabe que ese sector
está caído. La respuesta correcta del bot es **leerle `incidencia.mensaje` y
cerrar** — no abrir ticket, no pedir que reinicie el equipo, no diagnosticar.

Es el único campo de toda la API cuyo propósito es que el bot *deje* de hacer
cosas, y es el que evita que un corte de fibra con 180 afectados genere 180
tickets sobre un problema que ya está en curso.

---

## Cómo saber que quedó bien

```bash
curl -H "X-API-Key: LA_LLAVE" \
  "https://TU-URL/api/v1/cliente/consultar-deuda?cedula=99900030"
```

Si devuelve el JSON de arriba, el endpoint está bien y lo que falte es mapeo. Si
sigue dando `HTTP 0`, el pedido no está saliendo y el problema está antes: URL
sin cargar, endpoint sin asociar a `lookup_client`, o la llamada bloqueada del
lado del CRM.

El resto de los endpoints está en `api-v1-resumen.md`.
