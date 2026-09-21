# Las 10 plantillas — para el CRM y para aprobar en Meta

Generado desde la base del ISP. **Es lo que el sistema manda de verdad**: si un
`purpose` cambia acá, este documento hay que volver a generarlo.

---

## Cómo se usa este documento

Cada plantilla tiene **dos identidades**, y las dos hacen falta:

| | Para qué |
|---|---|
| **Nombre en Meta** | Con ese nombre se registra la plantilla en el Administrador de WhatsApp |
| **Nombre en el CRM** (`purpose`) | Es lo que el sistema del ISP manda para pedir ese aviso |

El flujo es:

1. Registrás la plantilla en **Meta** con su nombre, su idioma, su categoría y el
   texto de este documento.
2. Cuando Meta la aprueba, la das de alta en **tu CRM** con el `purpose`
   indicado, apuntando a esa plantilla.
3. El sistema del ISP manda `purpose` + variables; tu CRM elige la plantilla y
   rellena.

---

## Antes de cargar la primera

**Categoría UTILITY en las diez.** Ninguna va como Marketing:

- Utilidad se aprueba en minutos, cuesta menos y casi no genera bloqueos.
- Marketing se aprueba más lento y, cuando alguien la marca como spam, **baja la
  calificación de calidad del número entero**. Con la calificación en rojo, Meta
  reduce el límite de mensajes y termina pausando plantillas.

Un aviso de corte no es publicidad.

**Las cuatro reglas por las que Meta rechaza una plantilla.** Los textos de acá ya
las cumplen; si los modificás, revisalas:

1. El cuerpo **no puede empezar** con una variable.
2. El cuerpo **no puede terminar** con una variable.
3. No puede haber **dos variables seguidas** sin texto en el medio.
4. Las posiciones van `{{1}}`, `{{2}}`, `{{3}}`… sin saltos y sin repetir.

**El nombre de la empresa no va en el texto.** WhatsApp ya lo muestra arriba del
mensaje. Ponerlo gasta una variable, hace que el cuerpo empiece como Meta no
acepta, y no le dice nada nuevo a quien lo lee.

**Las variables viajan por nombre, no por posición.** El sistema manda
`{ "saldo": "$20.00" }`, no un arreglo. La tabla de cada plantilla dice qué
nombre corresponde a cada `{{n}}` del texto de Meta — esa correspondencia es lo
único que hay que respetar al armar la plantilla del lado del CRM.

## 1 · Nueva factura generada

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `invoice_issued` |
| **Nombre en Meta** | `factura_generada` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Avisa que ya se emitió la factura del mes.

Acá el texto es todo el mensaje: no hay logo ni botones. Conviene que entre en 160 caracteres — más largo, la operadora lo parte en varios SMS y cobra cada uno.

**Texto para Meta** — pegar tal cual:

```
Su factura de {{1}} por {{2}} ya está disponible. Vence el {{3}}. Puede consultarla o pagarla cuando guste.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `periodo` | agosto 2026 |
| `{{2}}` | `total` | $20.00 |
| `{{3}}` | `fecha_vencimiento` | 15/08/2026 |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "invoice_issued",
  "variables": {
    "periodo": "agosto 2026",
    "total": "$20.00",
    "fecha_vencimiento": "15/08/2026"
  }
}
```

---

## 2 · Aviso de pago SMS 1

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `dunning_reminder` |
| **Nombre en Meta** | `aviso_pago_recordatorio` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Recordatorio antes del vencimiento.

Acá el texto es todo el mensaje: no hay logo ni botones. Conviene que entre en 160 caracteres — más largo, la operadora lo parte en varios SMS y cobra cada uno.

**Texto para Meta** — pegar tal cual:

```
Le recordamos que su factura de {{1}} por {{2}} vence el {{3}}. Si ya realizó el pago, puede ignorar este mensaje.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `periodo` | agosto 2026 |
| `{{2}}` | `total` | $20.00 |
| `{{3}}` | `fecha_vencimiento` | 15/08/2026 |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "dunning_reminder",
  "variables": {
    "periodo": "agosto 2026",
    "total": "$20.00",
    "fecha_vencimiento": "15/08/2026"
  }
}
```

---

## 3 · Aviso de pago SMS 2

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `dunning_due` |
| **Nombre en Meta** | `aviso_pago_vencida` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Recordatorio con la factura ya vencida.

Acá el texto es todo el mensaje: no hay logo ni botones. Conviene que entre en 160 caracteres — más largo, la operadora lo parte en varios SMS y cobra cada uno.

**Texto para Meta** — pegar tal cual:

```
Su factura de {{1}} se encuentra vencida. Saldo pendiente: {{2}}. Puede regularizarla hasta el {{3}} para mantener su servicio activo.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `periodo` | agosto 2026 |
| `{{2}}` | `saldo` | $20.00 |
| `{{3}}` | `fecha_corte` | 25/08/2026 |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "dunning_due",
  "variables": {
    "periodo": "agosto 2026",
    "saldo": "$20.00",
    "fecha_corte": "25/08/2026"
  }
}
```

---

## 4 · Aviso de pago SMS 3

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `dunning_suspension` |
| **Nombre en Meta** | `aviso_pago_ultimo` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

El último antes del corte, con la fecha exacta.

Acá el texto es todo el mensaje: no hay logo ni botones. Conviene que entre en 160 caracteres — más largo, la operadora lo parte en varios SMS y cobra cada uno.

**Texto para Meta** — pegar tal cual:

```
Su servicio será suspendido el {{1}} por un saldo pendiente de {{2}}. Si ya realizó el pago, por favor comuníquese con nosotros para regularizarlo.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `fecha_corte` | 25/08/2026 |
| `{{2}}` | `saldo` | $20.00 |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "dunning_suspension",
  "variables": {
    "fecha_corte": "25/08/2026",
    "saldo": "$20.00"
  }
}
```

---

## 5 · Corte de servicio

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `service_suspended` |
| **Nombre en Meta** | `servicio_suspendido` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Se manda en el momento del corte. Tiene que decir cómo reactivar, no solo que se cortó.

**Texto para Meta** — pegar tal cual:

```
Su servicio fue suspendido por un saldo pendiente de {{1}}. Al registrarse su pago se reactiva automáticamente. Para cualquier consulta puede comunicarse al {{2}}, con gusto lo atendemos.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `saldo` | $20.00 |
| `{{2}}` | `telefono` | 099 123 4567 |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "service_suspended",
  "variables": {
    "saldo": "$20.00",
    "telefono": "099 123 4567"
  }
}
```

---

## 6 · Confirmación de pago

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `payment_confirmed` |
| **Nombre en Meta** | `pago_confirmado` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Evita la llamada de "¿les llegó mi pago?".

**Texto para Meta** — pegar tal cual:

```
Recibimos su pago de {{1}}. Su saldo actual es {{2}}. Gracias por su preferencia.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `monto` | $20.00 |
| `{{2}}` | `saldo` | $0.00 |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "payment_confirmed",
  "variables": {
    "monto": "$20.00",
    "saldo": "$0.00"
  }
}
```

---

## 7 · Aviso de avería en la zona

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `outage_started` |
| **Nombre en Meta** | `averia_en_su_sector` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Sale a todos los abonados afectados apenas se abre la incidencia. Es el mensaje que evita que el canal de soporte se tape.

**Texto para Meta** — pegar tal cual:

```
Estamos atendiendo una avería que afecta el servicio en su sector: {{1}}. {{2}} No es necesario que reinicie su equipo; le avisaremos apenas quede restablecido.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `titulo` | corte de fibra en la vía principal |
| `{{2}}` | `estimado` | Estimamos restablecerlo alrededor de las 21:30. |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "outage_started",
  "variables": {
    "titulo": "corte de fibra en la vía principal",
    "estimado": "Estimamos restablecerlo alrededor de las 21:30."
  }
}
```

---

## 8 · Aviso de avería solucionada

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `outage_resolved` |
| **Nombre en Meta** | `averia_solucionada` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Va solo a quien recibió el aviso de la avería. Es lo que hace que el abonado deje de reiniciar el router.

**Texto para Meta** — pegar tal cual:

```
Le informamos que la avería que afectaba el servicio en su sector quedó solucionada y su conexión está restablecida. Si continúa sin servicio, escríbanos.
```

**Sin variables.** Menos partes móviles, aprobación más rápida y nada que pueda llegar vacío.

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "outage_resolved",
  "variables": {}
}
```

---

## 9 · Aviso de mantenimiento programado

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `maintenance_scheduled` |
| **Nombre en Meta** | `mantenimiento_programado` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

Se manda ANTES del corte, con la ventana. Un mantenimiento avisado no genera reclamos; el mismo corte sin avisar, sí.

**Texto para Meta** — pegar tal cual:

```
Realizaremos un mantenimiento programado que puede interrumpir su servicio el {{1}}. Motivo: {{2}}. Disculpe las molestias que esto pueda ocasionar.
```

| Posición | Nombre de la variable | Ejemplo |
|---|---|---|
| `{{1}}` | `ventana` | 20/08 de 02:00 a 05:00 |
| `{{2}}` | `titulo` | mejora de la red en su sector |

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "maintenance_scheduled",
  "variables": {
    "ventana": "20/08 de 02:00 a 05:00",
    "titulo": "mejora de la red en su sector"
  }
}
```

---

## 10 · Bienvenida

| | |
|---|---|
| **Nombre en el CRM** (`purpose`) | `welcome_subscriber` |
| **Nombre en Meta** | `bienvenida_abonado` |
| **Idioma** | `es` |
| **Categoría** | **UTILITY** |

El primer mensaje del abonado nuevo.

**Texto para Meta** — pegar tal cual:

```
Le damos la bienvenida. Su servicio de internet ya se encuentra activo. Ante cualquier consulta puede escribirnos por este mismo medio.
```

**Sin variables.** Menos partes móviles, aprobación más rápida y nada que pueda llegar vacío.

Lo que el sistema le manda al CRM:

```json
{
  "phone": "593991234567",
  "purpose": "welcome_subscriber",
  "variables": {}
}
```

---

## Resumen

| Aviso | `purpose` | Nombre en Meta | Variables |
|---|---|---|---|
| Nueva factura generada | `invoice_issued` | `factura_generada` | periodo, total, fecha_vencimiento |
| Aviso de pago SMS 1 | `dunning_reminder` | `aviso_pago_recordatorio` | periodo, total, fecha_vencimiento |
| Aviso de pago SMS 2 | `dunning_due` | `aviso_pago_vencida` | periodo, saldo, fecha_corte |
| Aviso de pago SMS 3 | `dunning_suspension` | `aviso_pago_ultimo` | fecha_corte, saldo |
| Corte de servicio | `service_suspended` | `servicio_suspendido` | saldo, telefono |
| Confirmación de pago | `payment_confirmed` | `pago_confirmado` | monto, saldo |
| Aviso de avería en la zona | `outage_started` | `averia_en_su_sector` | titulo, estimado |
| Aviso de avería solucionada | `outage_resolved` | `averia_solucionada` | — |
| Aviso de mantenimiento programado | `maintenance_scheduled` | `mantenimiento_programado` | ventana, titulo |
| Bienvenida | `welcome_subscriber` | `bienvenida_abonado` | — |

---

## Los dos que más rinden

**`outage_started`** y **`outage_resolved`**. Un corte de fibra que afecta a 180
abonados genera unos 40 mensajes al canal de soporte en los primeros diez
minutos, todos preguntando lo mismo. Avisarles antes de que pregunten es la
diferencia entre atender el corte y atender el teléfono.

El texto de `outage_started` dice "no es necesario que reinicie su equipo" a
propósito: es lo que el abonado hace doce veces mientras espera.

---

## Qué pasa si falta alguna

El sistema del ISP no la manda por WhatsApp: se cae al SMS o al correo del
abonado, y queda escrito el motivo. **No se intenta igual** — mandar un
`purpose` que el CRM no conoce termina en un rechazo y el abonado no recibe nada
por ningún lado.
