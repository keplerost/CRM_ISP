# Salida de WhatsApp por un CRM externo

Contrato que debe implementar cualquier CRM que quiera entregar los avisos del
ISP por WhatsApp. **No está atado a ningún proveedor**: es un endpoint, una
llave, y una forma de cuerpo.

---

## Por qué existe

El sistema puede mandar WhatsApp por su cuenta —Cloud API de Meta, Evolution,
Baileys o Twilio— pero eso obliga al ISP a tener **su propio número**, con su
reputación y sus plantillas aprobadas.

Muchos ISP ya tienen un CRM que le habla al cliente por WhatsApp. Y ahí aparece
el problema de fondo: si el bot escribe desde un número y el aviso de corte desde
otro, el abonado recibe mensajes de **dos números que dicen ser el mismo
proveedor**. Eso confunde, y lo que la gente hace cuando se confunde es bloquear.
Los bloqueos bajan la calificación de calidad del número, y con la calificación en
rojo Meta recorta los envíos — o sea que termina afectando justo a los avisos de
cobranza que sostienen la caja.

Con esta vía el reparto queda claro:

| | |
|---|---|
| **El sistema del ISP** | Decide **qué** avisar y **cuándo**. Tiene las facturas, los cortes y las averías |
| **El CRM** | Lo **entrega**, por el número que ya usa, con sus plantillas aprobadas |

---

## Lo que el sistema envía

```
POST {url configurada}
{cabecera configurada}: {llave}
Content-Type: application/json
```

La cabecera es configurable: `X-API-Key` por omisión, o `Authorization` (en cuyo
caso se antepone `Bearer ` si la llave no lo trae).

```json
{
  "phone": "593991234567",
  "purpose": "dunning_suspension",
  "variables": {
    "nombre": "José Pérez",
    "saldo": "$20.00",
    "fecha_corte": "25/08/2026",
    "empresa": "CNET Soluciones",
    "telefono": "099 123 4567"
  },
  "text": "CNET Soluciones: su servicio se suspende el 25/08/2026 por $20.00 pendiente…",
  "external_ref": "aviso-1042"
}
```

| Campo | | |
|---|---|---|
| `phone` | siempre | Formato internacional, solo dígitos |
| `purpose` | siempre | Cómo se llama ese aviso **del lado del CRM** |
| `variables` | siempre | Por **nombre**, no por posición |
| `text` | opcional | El mensaje ya armado. Usalo solo si la conversación está abierta |
| `external_ref` | opcional | Referencia del ISP, para conciliar |

### Por qué no se manda el texto ya armado

Porque fuera de la ventana de 24 horas WhatsApp **solo entrega plantillas
aprobadas por Meta**, y las plantillas aprobadas son las del CRM. Si mandáramos
el texto listo, el CRM tendría que adivinar a qué plantilla suya corresponde — y
esos avisos, que son casi todos, no se podrían enviar nunca.

Por eso viaja `purpose` más las variables. **El CRM elige la plantilla y
rellena.** El `text` va como cortesía por si la conversación está abierta.

### Por qué las variables van por nombre

Porque el orden se rompe en silencio. Con posiciones, el día que alguien reordene
una plantilla el saldo termina en el lugar de la fecha y el abonado recibe *"vence
el $20.00"*. Con nombres, una variable que falte se nota; una que sobre, se
ignora.

---

## Lo que el sistema espera de vuelta

**Aceptado** — cualquier `2xx`:

```json
{ "ok": true, "queued": true, "queue_id": "90a02957-…" }
```

Se guarda `queue_id` (o `id`) como identificador del proveedor, para poder
conciliar después.

**Rechazado con 2xx** — para los CRM que aceptan lotes y detallan por mensaje:

```json
{ "ok": true, "results": [{ "queued": false, "reason": "Contacto con opt-out" }] }
```

Si el primer resultado trae `queued: false`, se toma como **fallo** y el aviso se
cae al canal siguiente. `reason` queda escrito en el historial.

**Rechazado con error:**

| HTTP | Qué hace el sistema |
|---|---|
| `401` · `403` | *"El CRM rechazó la llave"* → revisar la configuración |
| Otro `4xx`/`5xx` | Se registra el código y el `error` si viene |
| Sin respuesta en 15 s | Se corta y se cae al canal siguiente |

**Un fallo nunca pierde el aviso.** El sistema prueba el resto de los canales del
abonado —SMS, correo— y deja escrito el motivo. Lo que no hace es darlo por
enviado.

---

## Los `purpose` que hay que dar de alta

Cada aviso del sistema se mapea a un nombre del lado del CRM, en **Ajustes →
Plantillas de WhatsApp**. Vienen precargados los de cobranza, que son los que
todos los CRM tienen resueltos:

| Aviso del sistema | `purpose` sugerido | Variables |
|---|---|---|
| Recordatorio antes del vencimiento | `dunning_reminder` | nombre, periodo, total, fecha_vencimiento |
| Factura vencida | `dunning_due` | nombre, periodo, saldo, fecha_corte |
| Último aviso antes del corte | `dunning_suspension` | nombre, saldo, fecha_corte |
| Servicio suspendido | `dunning_suspension` | nombre, saldo, telefono |
| Pago recibido | `payment_confirmed` | nombre, monto, saldo |

Y estos **hay que crearlos**, porque no son parte del vocabulario habitual de
cobranza:

| Aviso del sistema | Variables | Por qué importa |
|---|---|---|
| Factura del mes disponible | periodo, total, fecha_vencimiento | Evita la consulta de "¿cuánto es este mes?" |
| **Avería en el sector** | titulo, estimado | **El que más descarga el canal de soporte** durante un corte masivo |
| **Avería solucionada** | — | Hace que el abonado deje de reiniciar el router |
| Mantenimiento programado | ventana, titulo | Un mantenimiento avisado no genera reclamos |
| Bienvenida | — | Abre la ventana de 24 h con el abonado nuevo |

Los dos de avería son los que más rinden: un corte de fibra que afecta a 180
abonados genera 40 mensajes al canal de soporte en diez minutos. Avisarles antes
de que pregunten es la diferencia.

**Todos deben registrarse en Meta como categoría UTILITY**, nunca Marketing. Una
marca de spam en una plantilla de marketing baja la calificación de calidad del
número entero.

Los textos sugeridos para cada uno están en `docs/plantillas-whatsapp-meta.md`.

---

## Configurarlo

**Ajustes → Mensajería** → vía **CRM externo**:

| Campo | |
|---|---|
| Nombre | Cómo se llama, para los mensajes de error |
| URL | El endpoint completo |
| Cabecera | `X-API-Key` o `Authorization` |
| Llave | La que dio el CRM. Se guarda cifrada y no se vuelve a ver |

Después, en **Ajustes → Plantillas de WhatsApp**, cargá el `purpose` de cada
aviso.

**Un aviso sin `purpose` no sale por esta vía**: se cae al SMS o al correo y
queda escrito el motivo. Es a propósito — mandarlo sin saber qué plantilla usar
haría que el CRM lo rechace y el abonado no reciba nada.

---

## Lo que esta vía no hace

**No recibe.** Los mensajes que el abonado le escribe al CRM se quedan en el CRM.
El webhook de entrada del sistema (`/api/webhooks/whatsapp`) es para cuando el
ISP manda por su propio número con la Cloud API de Meta.

Eso significa que con esta vía el sistema **no sabe si la ventana de 24 h está
abierta** — y no le hace falta, porque quien decide entre plantilla y texto libre
es el CRM, que sí tiene la conversación.

**No maneja el opt-out del CRM.** El sistema respeta el suyo (`avisos_activos` de
cada abonado) antes de mandar nada. Si el CRM además tiene su propia lista, esos
mensajes van a volver rechazados con su motivo — y eso está bien: la baja que
pidió el abonado vale por los dos lados.
