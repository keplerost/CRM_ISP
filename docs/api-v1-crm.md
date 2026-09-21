# API v1 — contrato para el agente de IA del CRM

Implementa los 8 endpoints de `API.md`. Este documento es el que vale: describe
lo que el servidor hace de verdad, incluidas las dos cosas donde se apartó de la
especificación original y por qué.

**Base:** `https://TU-SERVIDOR:4000/api/v1`

---

## 0. Lo común a todo

### Autenticación

```
Authorization: Bearer sk_xxxxxxxxxxxxxxxxxxxxxxxx
```

También se acepta `X-API-Key: sk_...`. La llave se emite en **Ajustes →
Integraciones**, se muestra una sola vez y se puede restringir por IP.

### Respuesta exitosa

Siempre trae `status: "success"` y los campos del endpoint.

### Respuesta de error

```json
{
  "status": "error",
  "code": "CLIENTE_NO_ENCONTRADO",
  "message": "No hay ningún abonado con la identificación 1204567890.",
  "hint": "Puede estar cargado con otra cédula, o ser el titular otra persona de la casa."
}
```

**Ramificá por `code`, nunca por `message`.** El texto está escrito para
leérselo al usuario y puede mejorarse cuando alguien lo lea y no se entienda; el
código no cambia.

| `code` | HTTP | Qué pasó |
|---|---|---|
| `DATOS_INVALIDOS` | 400 | Falta un campo o tiene un formato que no se acepta |
| `NO_AUTORIZADO` | 401 | Falta la llave o no es válida |
| `SIN_PERMISO` | 403 | La llave no tiene ese permiso, o llama desde una IP no habilitada |
| `CLIENTE_NO_ENCONTRADO` | 404 | Esa cédula, teléfono o id no corresponde a ningún abonado |
| `TELEFONO_AMBIGUO` | 409 | El número está en la ficha de más de un abonado |
| `AVERIA_CONOCIDA` | 409 | Ya hay un corte abierto que explica lo que reporta |
| `YA_ES_ABONADO` | 409 | La cédula ya tiene servicio activo |
| `LIMITE_EXCEDIDO` | 429 | Cupo por minuto agotado; mirá `Retry-After` |
| `ERROR_INTERNO` | 500 | Problema nuestro. Reintentá con espera creciente |

`message` es apto para leerse en el chat en todos los casos, incluido el 500.

### Cómo se identifica al abonado

Casi todos los endpoints aceptan **cualquiera de las tres**:

| Campo | Cuándo usarlo |
|---|---|
| `cliente_id` | El más confiable. Lo devuelve `consultar-deuda` |
| `cedula` | Lo que el abonado dice cuando se lo pedís |
| `telefono` | Lo que ya tenés al abrir la conversación |

**Sobre `telefono`:** un teléfono identifica un aparato, no una persona. Si el
número está en la ficha de dos abonados —el celular de la casa figura en la del
padre y en la del hijo— la respuesta es `TELEFONO_AMBIGUO` y hay que pedir la
cédula. No se elige uno: mostrarle a alguien la deuda de otro no es una
comodidad, es una filtración.

Se acepta en cualquier formato: `0991234567`, `+593991234567`, `593991234567`.

### Cupos

- **120 por minuto** por llave, general.
- **6 por minuto** para lo que toca los equipos: `diagnostico-ont?en_vivo=1` y
  `cambiar-wifi`. Una OLT admite tres sesiones SSH y el técnico necesita una
  justo cuando está atendiendo un corte.

### Los ids son UUID

`"a3f1c8e2-..."`, no `1042`. Los ejemplos de `API.md` mostraban enteros; tratalos
como cadenas opacas y no asumas longitud ni formato.

---

## MÓDULO 1 — Pagos y facturación

### 1. Consulta de deuda

```
GET /api/v1/cliente/consultar-deuda?cedula=1204567890
GET /api/v1/cliente/consultar-deuda?telefono=0991234567
```

Permiso: `clientes.ver`

```json
{
  "status": "success",
  "cliente": {
    "id": "a3f1c8e2-…",
    "nombre": "Jefferson Oña",
    "cedula": "1204567890",
    "estado_servicio": "SUSPENDIDO_POR_CORTE",
    "codigo_pago": "10245"
  },
  "deuda_total": 10.00,
  "facturas_pendientes": [
    {
      "factura_id": "8f3c…",
      "numero": 9841,
      "mes": "Agosto 2026",
      "monto": 10.00,
      "total_factura": 10.00,
      "fecha_vencimiento": "2026-08-15",
      "estado": "vencida"
    }
  ],
  "falla_masiva_sector": false,
  "incidencia": null
}
```

`estado_servicio`: `ACTIVO` · `SUSPENDIDO_POR_CORTE` · `SUSPENDIDO` ·
`DADO_DE_BAJA`.

**`monto` es lo que FALTA, no el total de la factura.** Cuando hay un abono
parcial son distintos, y decirle al abonado el total lo hace pagar de nuevo lo
que ya entregó. Para eso está `total_factura` aparte.

**`falla_masiva_sector` manda sobre todo lo demás.** Cuando es `true`, `incidencia`
trae un `mensaje` listo para leer: hay un corte que el ISP ya conoce y que
afecta a este abonado. Contestá eso y cerrá — no diagnostiques ni abras ticket.

> **Sobre `ip_asignada`:** `API.md` la pedía y **no se devuelve**. No le sirve a
> quien pregunta por su factura, y sí le sirve a quien quiere hacerse pasar por
> él. Si hace falta para algo concreto, se agrega con su propio permiso.

---

### 2. Registrar un pago

```
POST /api/v1/pagos/registrar
```

Permiso: `pagos.registrar`

```json
{
  "cliente_id": "a3f1c8e2-…",
  "factura_id": "8f3c…",
  "monto": 10.00,
  "banco_origen": "Banco Pichincha",
  "num_comprobante": "92947292",
  "uuid_transaccion": "65702911-c699-4ac3-84e1-25f653fe9900",
  "hash_qr": "9aa587037b5c4441ffcff621f722c7e1",
  "fecha_transaccion": "2026-08-17 05:00:00",
  "forma_pago": "app",
  "depositante": "JOSE PEREZ",
  "verificado_por": "ocr_only",
  "comprobante_url": "https://.../comprobante.jpg",
  "origen": "BOT_WHATSAPP"
}
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `cliente_id` / `cedula` / `telefono` | sí (uno) | Ver *Cómo se identifica al abonado* |
| `monto` | sí | Mayor que cero. Tope de $100.000 |
| `fecha_transaccion` | no | **Tiene que empezar por el año** (ver abajo) |
| `forma_pago` | no | `app` · `cnb` · `deuna` · `spi` · `transferencia` · `deposito` · `efectivo` · `tarjeta` · `unknown` |
| `verificado_por` | **importa** | `bank_api` · `human` · `ocr_only` |
| `hash_qr` | recomendado | La mejor clave contra duplicados |
| `num_comprobante`, `banco_origen`, `depositante` | no | Es lo que se cruza contra el extracto |
| `factura_id` | no | Se valida que sea de ese abonado; si no, se ignora |
| `cuenta_destino` | **recomendado** | El número de cuenta al que entró la transferencia, leído del comprobante |

#### La fecha tiene que empezar por el año

`2026-08-17`, `2026-08-17 05:00:00` y `2026-08-17T05:00:00Z` se aceptan.
`15/08/2026` **se rechaza**, y es a propósito: `01/02/2026` es válido leído como
1 de febrero y como 2 de enero, JavaScript elige el segundo sin avisar, y el
cobro queda un mes corrido sin que nadie lo note hasta que la caja no cierre.

Con zona horaria explícita se convierte a la hora del ISP antes de quedarse con
el día: `2026-08-17T02:00:00Z` es el **16** en Ecuador, y registrarlo el 17
descuadra el cierre de los dos días.

#### `cuenta_destino` — a qué cuenta entró

El ISP puede tener más de una cuenta de cobro. Mandá el **número de cuenta tal
como figura en el comprobante** (con guiones o sin ellos, da igual: se comparan
solo los dígitos) y el sistema lo resuelve solo.

Si no lo mandás, se usa la cuenta fija que tenga configurada la llave — que
puede no ser a la que el abonado transfirió.

**Si el número no corresponde a ninguna cuenta del ISP, el pago se rechaza:**

```json
{
  "status": "error",
  "code": "CUENTA_DESCONOCIDA",
  "message": "La cuenta 1234567890 no es una cuenta de cobro de este ISP.",
  "hint": "Si el comprobante dice que la transferencia fue a esa cuenta, la plata no entró acá. No se registra."
}
```

No es una molestia: si el comprobante dice que el dinero fue a otro lado,
acreditarlo saldaría una factura con plata que nunca llegó.

#### `verificado_por` — cómo se comprobó

| Valor | Qué significa | ¿Acredita solo? |
|---|---|---|
| `bank_api` | Lo confirmó el banco | Sí |
| `qr_validado` | El QR del comprobante coincide con su texto y con la cuenta destino | Sí |
| `human` | Lo aprobó una persona del ISP | Sí |
| `ocr_only` | Solo se leyó la imagen | **No** — queda a verificar |

`qr_validado` es el que corresponde cuando el bot escanea el QR del comprobante
y lo compara contra los datos impresos: retocar el texto visible no cambia el QR,
así que una imagen editada no pasa esa prueba.

Sigue haciendo falta que la **llave** tenga habilitado acreditar sin verificación
humana. `verificado_por` solo puede bajar esa confianza, nunca subirla.

#### Los rieles se traducen

`app`, `spi` y `deuna` → `transferencia`. `cnb` → `deposito`. `unknown` → `otro`.

No es capricho: `forma_pago` termina en el reporte de ARCOTEL y en la
conciliación bancaria, y esos dos no saben qué es un "spi". **El riel no se
pierde**: queda en `origen` y en las notas del cobro, que es lo que necesita
quien concilia.

#### Cuándo se acredita — lo que cambia respecto de `API.md`

La especificación decía que este endpoint dispara el desbloqueo en el MikroTik y
contesta *"servicio restablecido"*. **Acá eso pasa solo con un pago confirmado.**

Hacen falta **dos** condiciones:

1. La **llave** tiene habilitado acreditar sin verificación humana. Se configura
   en Ajustes → Integraciones, por llave.
2. `verificado_por` es `bank_api`, `qr_validado` o `human`.
3. Se sabe **a qué cuenta entró** la plata — por `cuenta_destino` o por la cuenta
   por defecto de la llave. Sin ninguna de las dos, el pago queda pendiente.

`verificado_por: "ocr_only"` **siempre** queda a verificar, aunque la llave
acredite sola. Una imagen leída por OCR no es una confirmación: una captura se
edita en treinta segundos.

`verificado_por` solo puede **bajar** la confianza, nunca subirla. Si pudiera
subirla, alcanzaría con mandar `"human"` para saltarse la verificación — y
entonces la verificación no existiría. La palabra de quien llama no puede ser la
que decide si su propia palabra alcanza.

**Pago acreditado** (201):

```json
{
  "status": "success",
  "mensaje": "Pago registrado y servicio restablecido.",
  "transaccion_id": "REP-6b21a4c8",
  "reporte_id": "6b21a4c8-…",
  "pago_id": "1c9f…",
  "acreditado": true,
  "estado": "confirmado",
  "repetido": false,
  "saldo_restante": 0.00,
  "cuenta": "Pichincha Corriente",
  "facturas_saldadas": [{ "numero": "00001042", "monto": 10.00 }],
  "reactivacion": { "ok": true, "nota": "Se quitó 10.20.0.45 del corte en el router." }
}
```

**Pago a verificar** (201):

```json
{
  "status": "success",
  "mensaje": "Recibimos tu pago. Lo estamos validando y se acredita en cuanto se confirme.",
  "transaccion_id": "REP-6b21a4c8",
  "reporte_id": "6b21a4c8-…",
  "acreditado": false,
  "estado": "pendiente",
  "motivo_pendiente": "el comprobante solo fue leído por OCR",
  "saldo_restante": 10.00
}
```

**Decile al cliente lo que dice `mensaje`.** Prometer "ya está acreditado"
cuando `acreditado: false` genera el reclamo del día siguiente, cuando sigue
cortado.

Si `reactivacion.ok` es `false`, el cobro entró pero el abonado sigue sin
servicio: decí que se está restableciendo, y que el ISP lo vea.

#### Idempotencia — tres claves

Contesta **200** con `repetido: true` cuando ese pago ya estaba registrado. **No
es un error**: es la confirmación de que está y de que podés dejar de reintentar.

| Clave | Alcance |
|---|---|
| `hash_qr` | Global. Es la huella de la imagen: la comparten dos reportes del mismo comprobante aunque vengan de conversaciones distintas |
| `uuid_transaccion` | Global. El identificador que da el banco |
| `referencia_externa` | Por llave. Es interna del CRM |

`hash_qr` es la mejor de las tres porque no hay que acordarse de nada, y es la
única que atrapa al abonado que reenvía el comprobante de su vecino.

---

### 2b. ¿Este comprobante ya está registrado?

```
GET /api/v1/pagos/comprobante?hash_qr=9aa587037b5c4441ffcff621f722c7e1
GET /api/v1/pagos/comprobante?num_comprobante=92947292&cedula=1204567890
```

Permiso: `pagos.registrar`

Se pregunta **antes** de registrar, para mostrarle el aviso al abonado en
pantalla. No crea nada.

| Parámetro | |
|---|---|
| `hash_qr` | El más confiable. Identifica la imagen del comprobante |
| `uuid_transaccion` | El identificador del banco |
| `num_comprobante` | Pista, no certeza: dos bancos pueden emitir el mismo número |
| `cedula` / `cliente_id` / `telefono` | Opcional. Para saber si el comprobante es **de ese abonado o de otro** |

Al menos uno de los tres primeros es obligatorio; si no, `400 DATOS_INVALIDOS`.

**No registrado:**

```json
{
  "status": "success",
  "registrado": false,
  "puede_registrar": true,
  "mensaje": "Este comprobante todavía no está registrado."
}
```

**Ya registrado, del mismo abonado:**

```json
{
  "status": "success",
  "registrado": true,
  "estado": "pendiente",
  "reporte_id": "c706a5d1-…",
  "pago_id": null,
  "monto": 20.00,
  "fecha_pago": "2026-08-17",
  "registrado_el": "2026-08-19T16:41:02Z",
  "banco_origen": "Banco Pichincha",
  "del_mismo_abonado": true,
  "puede_reenviar": false,
  "coincidencia": "exacta",
  "mensaje": "Este comprobante ya lo recibimos y lo estamos validando. Te avisamos en cuanto se acredite."
}
```

Los tres campos que deciden el flujo:

- **`registrado`** — si ya lo tenemos.
- **`puede_reenviar`** — solo `true` cuando fue **rechazado**. Un comprobante que
  no se pudo leer tiene que poder reenviarse con una foto mejor; cerrarle la
  puerta ahí deja al abonado sin forma de acreditar un pago que sí hizo.
- **`del_mismo_abonado`** — `false` significa que el comprobante ya figura a
  nombre de **otro**. `null` es "no se preguntó por ningún abonado", que no es lo
  mismo: tratarlo como `false` acusaría de reenviar el comprobante ajeno a quien
  mandó el suyo.

**`mensaje` viene listo para mostrar.** Mostralo tal cual: si cada integración
redacta el suyo, una va a decir "ya se acreditó" sobre un comprobante que todavía
está en revisión.

#### Cuando el comprobante es de otro abonado

```json
{
  "registrado": true,
  "del_mismo_abonado": false,
  "mensaje": "Este comprobante ya figura registrado a nombre de otro abonado. Si creés que es un error, escribinos."
}
```

**No se dice de quién es, a propósito.** Es el caso del que reenvía el
comprobante del vecino: decirle "ya lo usó María Pérez" le confirma un dato de
otra persona que no tenía, y encima se lo confirma el propio ISP. El detalle
completo lo ve el ISP en su bandeja.

#### Sobre `coincidencia`

`"exacta"` cuando se encontró por `hash_qr` o `uuid_transaccion`.
`"por número de comprobante"` cuando fue solo por el número — ahí el mensaje es
más prudente, porque ese número no es único y podría ser otro pago.

---

## MÓDULO 2 — Ventas y captación

### 3. Validar cobertura

```
POST /api/v1/ventas/validar-cobertura
{ "latitud": -0.180653, "longitud": -78.467838, "tecnologia": "ftth" }
```

Permiso: `ventas.cobertura`

```json
{
  "status": "success",
  "tiene_cobertura": true,
  "caja_nap_cercana": "NAP-NORTE-04",
  "distancia_metros": 45,
  "puertos_disponibles": 6,
  "tecnologia": "ftth",
  "motivo": null,
  "opciones": [{ "nombre": "NAP-NORTE-04", "tipo": "nap", "distancia_metros": 45, "disponibles": 6 }]
}
```

Alcance: **250 m** en FTTH, **3000 m** en inalámbrico. Más que eso ya es obra, no
instalación.

**Una caja llena cuenta como sin cobertura**, aunque esté a diez metros. Si la
más cercana no tiene puertos pero hay otra dentro del alcance, gana la que tiene
lugar: al cliente le da igual de qué caja cuelga, y al técnico no le sirve que lo
manden a una sin puerto.

Cuando `tiene_cobertura` es `false`, **`motivo` dice cuál de las tres cosas
pasó** — no hay caja cerca, hay pero está llena, o no hay ninguna cargada en la
zona. Son ventas distintas: la segunda se cierra en cuanto se amplía.

### 4. Catálogo de planes

```
GET /api/v1/ventas/planes[?categoria=residencial]
```

Permiso: `ventas.planes`

```json
{
  "status": "success",
  "planes": [
    { "id": "…", "nombre": "Plan Hogar Fibra", "velocidad": "200 Mbps",
      "bajada_mbps": 200, "subida_mbps": 100, "precio": 20.00,
      "precio_incluye_iva": true, "categoria": "residencial" }
  ]
}
```

`precio_incluye_iva` existe para que el bot no tenga que adivinar si al precio
hay que sumarle el impuesto.

### 5. Agendar instalación

```
POST /api/v1/ventas/agendar-instalacion
```

Permiso: `ventas.solicitudes`

```json
{
  "prospecto": {
    "nombre": "Carmen Velez",
    "cedula": "1300000000",
    "telefono": "+593987654321",
    "direccion": "Av. Amazonas y Colón",
    "referencia": "Casa de dos pisos, portón verde",
    "coordenadas": "-0.180653, -78.467838"
  },
  "plan_id": "…",
  "fecha_programada": "2026-08-21",
  "franja_horaria": "10:00 - 12:00"
}
```

```json
{
  "status": "success",
  "orden_instalacion_id": "INS-4029",
  "instalacion_id": "…",
  "fecha": "2026-08-21",
  "franja": "manana",
  "repetido": false,
  "mensaje": "Instalación agendada correctamente."
}
```

**Crea una orden, no un abonado.** La ficha de cliente nace cuando el técnico
instala: crearla antes llenaría el padrón de gente que nunca se instaló, y esa
gente aparecería en la cartera, en las estadísticas y en la facturación mensual.

- Si esa cédula **ya es abonado** → `409 YA_ES_ABONADO`. Casi siempre quiere un
  traslado o un segundo servicio, y los dos se cotizan distinto: derivá a un
  asesor.
- Si **ya había una orden abierta** para esa cédula → `200` con `repetido: true`
  y el número de la que existe. Dos órdenes son dos cuadrillas al mismo lugar.
- `referencia` no es adorno: en un barrio sin nomenclatura es lo único con lo que
  el técnico llega.

---

## MÓDULO 3 — Soporte técnico

### 6. Crear ticket

```
POST /api/v1/soporte/crear-ticket
{
  "cliente_id": "…",
  "tipo_incidencia": "SIN_SERVICIO_LUZ_ROJA",
  "descripcion_bot": "El cliente indica que la ONT tiene la luz LOS en rojo.",
  "prioridad": "ALTA",
  "adjunto_url": "https://…/foto_los.jpg"
}
```

Permiso: `soporte.crear`

```json
{ "status": "success", "ticket_id": "TK-8821", "ticket_uuid": "…",
  "mensaje": "Ticket creado exitosamente y asignado a cuadrilla técnica." }
```

`tipo_incidencia` se traduce a una de cinco categorías internas para enrutar y
para no duplicar. **Lo específico no se pierde**: el texto crudo, la prioridad y
la foto quedan en la descripción, que es lo que lee el técnico antes de salir.

#### El 409 que descarga el canal de soporte

Si hay una **avería masiva conocida** que afecta a este abonado y lo que reporta
es falta de servicio, **no se abre el ticket**:

```json
{
  "status": "error",
  "code": "AVERIA_CONOCIDA",
  "message": "Ya conocemos esta falla: hay una avería abierta en su sector.",
  "hint": "Contestale con el mensaje de la incidencia. No hace falta abrir un reclamo.",
  "incidencia": { "titulo": "Fibra cortada en la vía a El Progreso",
                  "mensaje": "Tenemos una avería en tu sector: … Estimamos restablecerlo alrededor de las 22:30." }
}
```

**Tratalo como una respuesta válida, no como un fallo.** Es lo que evita que un
corte de fibra genere ciento ochenta tickets por la misma causa, cada uno
mandando un técnico a una casa donde no hay nada que arreglar.

Un reclamo por cambio de clave durante una avería sí se abre: solo se bloquean
los tipos que la avería explica.

### 7. Diagnóstico de la ONT

```
GET /api/v1/red/diagnostico-ont?cliente_id=…
GET /api/v1/red/diagnostico-ont?cedula=…&en_vivo=1
```

Permiso: `red.diagnostico`

```json
{
  "status": "success",
  "cliente_id": "…",
  "estado_ont": "ONLINE",
  "potencia_rx": "-21.5 dBm",
  "potencia_rx_valor": -21.5,
  "es_potencia_optima": true,
  "falla_masiva_sector": false,
  "resultado": "todo_ok",
  "mensaje": "De nuestro lado tu conexión está bien: el equipo está en línea y con buena señal…",
  "accion_sugerida": "reiniciar",
  "abrir_ticket": false,
  "en_vivo": false
}
```

**Por omisión no toca ningún equipo**: usa lo que la base ya sabe y contesta casi
todos los casos. Con `?en_vivo=1` abre SSH contra la OLT y pinguea desde el
router — ahí el cupo baja a 6 por minuto. Usalo cuando el rápido dice `todo_ok` y
el abonado insiste.

| `resultado` | Qué hace el bot |
|---|---|
| `averia_zona` | Informa. **No** abre ticket |
| `corte_por_deuda` | Ofrece el monto y las formas de pago |
| `sin_fibra` | Pide revisar el cable de la casa, luego escala |
| `equipo_apagado` | Pide revisar corriente y reintentar |
| `senal_baja` | Escala: hace falta visita |
| `sin_respuesta` | Ofrece reiniciar |
| `todo_ok` | Sugiere reiniciar el router WiFi del abonado |
| `sin_datos` | Escala |

`falla_masiva_sector` se evalúa **primero**: si hay un corte conocido, medirle la
potencia a esa ONT es gastar una sesión de la OLT para enterarse de lo que ya se
sabía.

### 8. Cambiar el WiFi

```
POST /api/v1/red/cambiar-wifi
{ "cliente_id": "…", "nuevo_ssid": "MiRedFibra_5G", "nueva_clave": "Seguridad2026*" }
```

Permiso: `red.wifi` · cupo de equipos (6/min)

```json
{ "status": "success", "aplicado": true, "estado": "aplicada",
  "mensaje": "Credenciales Wi-Fi actualizadas en el equipo remoto." }
```

**Mirá `aplicado`.** Cuando es `false` el cambio quedó registrado y se aplica
cuando el equipo se reporte:

```json
{ "status": "success", "aplicado": false, "estado": "pendiente",
  "mensaje": "El cambio quedó registrado y se aplica en cuanto el equipo se reporte. Por ahora seguí usando tu clave anterior." }
```

Decirle "listo" a alguien cuyo WiFi sigue con la clave vieja es peor que decirle
que va a demorar: se queda intentando conectarse con la nueva.

La clave va entre 8 y 63 caracteres — WPA2 no acepta menos de 8, y el equipo
rechazaría el cambio después, cuando el abonado ya se olvidó de que lo pidió.

---

## Lo que el ISP ve de su lado

- **Ajustes → Gestión de personal** — el camino corto: elegís al usuario que
  pidió la API, apretás el botón de la llave y se genera copiando **sus**
  permisos. Es una foto: si después cambian los permisos de esa persona, o se
  desactiva su usuario, la llave no se entera. Solo Administrador y Super
  Administrador.
- **Ajustes → Integraciones** — emitir y revocar llaves, afinar sus permisos, y
  el registro de cada llamada: qué ruta, con qué cédula, con qué resultado.
  Contesta "¿quién consultó los datos de este abonado el martes?".
- **Cobros → Pagos reportados** — la bandeja de lo que quedó a verificar, con el
  monto al lado de la deuda real y el banco y el depositante para cruzar contra
  el extracto.
- **Red → Cortes masivos** — de donde sale `falla_masiva_sector` y el `409` de
  los tickets.
