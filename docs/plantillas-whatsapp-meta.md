# Plantillas de WhatsApp para registrar en Meta

Los diez textos listos para pegar en el Administrador de WhatsApp, con sus
variables y sus ejemplos. También están en el sistema, en **Ajustes → Plantillas
de WhatsApp**, con un botón para copiar cada uno.

---

## Por qué esto no es opcional

La API oficial de WhatsApp solo entrega **texto libre** dentro de las 24 horas
siguientes al último mensaje que escribió **el abonado**. Fuera de esa ventana,
únicamente pasan plantillas aprobadas por Meta.

Y todos los avisos automáticos caen fuera de esa ventana, siempre: nadie le
escribe al ISP para que le avisen que se le vence la factura.

Qué pasaba antes de esto:

| Vía | Qué ocurría al mandar texto libre |
|---|---|
| Cloud API de Meta | Error `131047`. **El mensaje no salía**, y el sistema lo contaba como intento |
| Evolution / Baileys | Salía — y ese es el patrón por el que WhatsApp bloquea números no oficiales |

Ahora, si un aviso automático no tiene plantilla **aprobada**, el sistema **no
intenta** mandarlo por WhatsApp: se cae al SMS o al correo, que sí llegan, y deja
escrito el motivo.

---

## Antes de cargar la primera

**Categoría: Utilidad (`UTILITY`) en las diez.** Ninguna va como Marketing, y no
es un detalle administrativo:

- Utilidad se aprueba en minutos, cuesta menos y casi no genera bloqueos.
- Marketing se aprueba más lento y, cuando alguien la marca como spam, **le baja
  la calificación de calidad al número entero**. Con la calificación en rojo,
  Meta reduce el límite de mensajes y termina pausando plantillas.

Un aviso de corte no es publicidad. Registrarlo como Marketing es el camino más
corto para perder el número, que es justamente lo que se quiere evitar.

**Las cuatro reglas que hacen que Meta rechace una plantilla.** Las diez de acá
ya las cumplen; si escribís una nueva, la pantalla las verifica mientras
escribís:

1. El cuerpo **no puede empezar** con una variable.
2. El cuerpo **no puede terminar** con una variable.
3. No puede haber **dos variables seguidas** sin texto en el medio.
4. Las posiciones van `{{1}}`, `{{2}}`, `{{3}}`… **sin saltos y sin repetir**.

**El nombre de la empresa no va en el texto.** WhatsApp ya lo muestra arriba del
mensaje. Ponerlo gasta una variable, hace que el cuerpo empiece como Meta no
acepta, y no le dice nada nuevo a quien lo lee. Por eso ninguna de estas
plantillas tiene `{{empresa}}`, aunque el texto interno del sistema sí lo tenga.

---

## Cómo se carga cada una

1. Administrador de WhatsApp → **Herramientas de la cuenta → Plantillas de
   mensajes → Crear plantilla**.
2. Categoría **Utilidad**. Nombre e idioma: los de la tabla.
3. Pegá el cuerpo tal cual.
4. Cargá los valores de ejemplo (Meta los pide para revisar).
5. Enviar. Cuando la aprueben, volvé a **Ajustes → Plantillas de WhatsApp** y
   apretá **Ya la aprobaron**.

Hasta ese último paso el sistema sigue mandando ese aviso por SMS o correo.

---

## 1 · Factura del mes disponible

**Nombre:** `factura_generada` · **Idioma:** `es` · **Categoría:** Utilidad

```
Su factura de {{1}} por {{2}} ya está disponible. Vence el {{3}}. Puede consultarla o pagarla cuando guste.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | período | `agosto 2026` |
| `{{2}}` | total | `$20.00` |
| `{{3}}` | fecha de vencimiento | `15/08/2026` |

---

## 2 · Recordatorio antes del vencimiento

**Nombre:** `aviso_pago_recordatorio` · **Idioma:** `es` · **Categoría:** Utilidad

```
Le recordamos que su factura de {{1}} por {{2}} vence el {{3}}. Si ya realizó el pago, puede ignorar este mensaje.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | período | `agosto 2026` |
| `{{2}}` | total | `$20.00` |
| `{{3}}` | fecha de vencimiento | `15/08/2026` |

La frase final no es cortesía: es lo que evita que conteste el que ya pagó, y
cada respuesta innecesaria es una conversación que alguien tiene que atender.

---

## 3 · Factura vencida

**Nombre:** `aviso_pago_vencida` · **Idioma:** `es` · **Categoría:** Utilidad

```
Su factura de {{1}} se encuentra vencida. Saldo pendiente: {{2}}. Puede regularizarla hasta el {{3}} para mantener su servicio activo.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | período | `agosto 2026` |
| `{{2}}` | saldo | `$20.00` |
| `{{3}}` | fecha de corte | `25/08/2026` |

---

## 4 · Último aviso antes del corte

**Nombre:** `aviso_pago_ultimo` · **Idioma:** `es` · **Categoría:** Utilidad

```
Su servicio será suspendido el {{1}} por un saldo pendiente de {{2}}. Si ya realizó el pago, por favor comuníquese con nosotros para regularizarlo.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | fecha de corte | `25/08/2026` |
| `{{2}}` | saldo | `$20.00` |

Es la que más llamadas evita de todas, y también la que más cuesta si no sale.

---

## 5 · Servicio suspendido

**Nombre:** `servicio_suspendido` · **Idioma:** `es` · **Categoría:** Utilidad

```
Su servicio fue suspendido por un saldo pendiente de {{1}}. Al registrarse su pago se reactiva automáticamente. Para cualquier consulta puede comunicarse al {{2}}, con gusto lo atendemos.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | saldo | `$20.00` |
| `{{2}}` | teléfono del ISP | `099 123 4567` |

Dice **cómo** reactivar, no solo que se cortó. Un "su servicio fue suspendido" a
secas termina igual en una llamada, y encima con el abonado molesto.

---

## 6 · Pago recibido

**Nombre:** `pago_confirmado` · **Idioma:** `es` · **Categoría:** Utilidad

```
Recibimos su pago de {{1}}. Su saldo actual es {{2}}. Gracias por su preferencia.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | monto | `$20.00` |
| `{{2}}` | saldo | `$0.00` |

Evita las dos llamadas caras: la de "¿les llegó mi pago?" y la del que paga dos
veces porque no recibió acuse.

---

## 7 · Avería en el sector

**Nombre:** `averia_en_su_sector` · **Idioma:** `es` · **Categoría:** Utilidad

```
Estamos atendiendo una avería que afecta el servicio en su sector: {{1}}. {{2}} No es necesario que reinicie su equipo; le avisaremos apenas quede restablecido.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | título de la incidencia | `corte de fibra en la vía principal` |
| `{{2}}` | horario estimado | `Estimamos restablecerlo alrededor de las 21:30.` |

Esta es la que descarga el canal de soporte durante un corte masivo. El "no es
necesario que reinicie su equipo" está puesto a propósito: es lo que el abonado
hace doce veces mientras espera.

---

## 8 · Avería solucionada

**Nombre:** `averia_solucionada` · **Idioma:** `es` · **Categoría:** Utilidad

```
Le informamos que la avería que afectaba el servicio en su sector quedó solucionada y su conexión está restablecida. Si continúa sin servicio, escríbanos.
```

Sin variables, a propósito: menos partes móviles, aprobación más rápida y nada
que pueda llegar vacío.

---

## 9 · Mantenimiento programado

**Nombre:** `mantenimiento_programado` · **Idioma:** `es` · **Categoría:** Utilidad

```
Realizaremos un mantenimiento programado que puede interrumpir su servicio el {{1}}. Motivo: {{2}}. Disculpe las molestias que esto pueda ocasionar.
```

| Posición | Variable | Ejemplo |
|---|---|---|
| `{{1}}` | ventana | `20/08 de 02:00 a 05:00` |
| `{{2}}` | motivo | `mejora de la red en su sector` |

---

## 10 · Bienvenida

**Nombre:** `bienvenida_abonado` · **Idioma:** `es` · **Categoría:** Utilidad

```
Le damos la bienvenida. Su servicio de internet ya se encuentra activo. Ante cualquier consulta puede escribirnos por este mismo medio.
```

Sin variables. Además de dar la bienvenida hace algo útil: **abre la ventana de
24 horas** con el abonado nuevo si contesta, y dentro de esa ventana se le puede
escribir texto libre.

---

## El webhook de entrada

Sin webhook, el sistema no puede saber si la ventana de 24 h está abierta y
asume que no — que es lo seguro, pero deja de aprovecharla justo cuando existe:
cuando el abonado acaba de escribir pidiendo ayuda.

Con webhook llegan tres cosas:

| Qué | Para qué sirve |
|---|---|
| Los mensajes del abonado | Abren su ventana de 24 h. Dentro de ella, si un aviso todavía no tiene plantilla aprobada, sale como texto libre en vez de no salir |
| Los acuses de entrega | `enviado → entregado → leído`, o `fallido` con el motivo. Antes todo quedaba en "enviado" para siempre |
| Las bajas | Quien contesta **BAJA** deja de recibir avisos automáticamente |

### Darlo de alta

1. En **Ajustes → Mensajería**, cargá:
   - **Token de verificación** — inventalo, cualquier cadena larga. Se muestra en
     pantalla porque hay que copiarlo igual de los dos lados.
   - **App Secret** — el de tu app en Meta (Configuración → Básica). Se guarda
     cifrado y no se vuelve a ver.
2. En el panel de Meta, tu app → **WhatsApp → Configuración → Webhooks →
   Editar**:
   - **URL de devolución de llamada:**
     `https://TU-SERVIDOR/api/webhooks/whatsapp`
   - **Token de verificación:** el mismo que cargaste arriba.
3. Verificar y guardar. Meta pega una vez y espera que le devolvamos su desafío.
4. En **Campos del webhook**, suscribite a **`messages`**. Ese solo campo trae
   los mensajes entrantes y los acuses de entrega.

### Sobre el App Secret

Sin App Secret cargado, el webhook **acepta igual** —hay que poder darlo de alta
antes de terminar de configurar todo— pero procesa a medias:

- Los mensajes entrantes y los acuses se procesan.
- **Las bajas no.** Sin firma, cualquiera que descubra la URL podría mandar una
  "BAJA" falsa y dejar a un abonado sin enterarse de que le van a cortar.

Con el secreto cargado, todo aviso que no valide la firma se descarta con 401.

### Por qué el webhook contesta 200 casi siempre

Meta reintenta si no recibe 200 rápido, y después de varios reintentos fallidos
**da de baja la suscripción**. Esa es la forma de quedarse sin acuses de entrega
sin que nadie lo note. Por eso el webhook contesta primero y procesa después, y
un error nuestro con un mensaje no impide procesar los demás.

---

## Cuidar la calificación del número

Meta le pone a cada número una calificación de calidad — verde, amarilla, roja —
que sale de cuánta gente **bloquea** o **reporta** los mensajes. En rojo, baja el
límite diario de envíos; sostenido, Meta pausa las plantillas.

Lo que el sistema ya hace para cuidarla:

- **Respeta el opt-out.** El abonado con `avisos_activos` en falso no recibe
  nada, ni siquiera un aviso de corte. Es su decisión, y desoírla es la razón por
  la que la gente bloquea.
- **Atiende la baja por chat.** Quien contesta "BAJA" queda dado de baja solo.
  Ignorar una baja es, a la vuelta, lo que hace que después no salgan los avisos
  de corte para todos los demás: el que pide la baja y sigue recibiendo, bloquea.
- **Un solo aviso de cobranza por abonado**, el del nivel más urgente que le
  corresponda. Tres mensajes el mismo día por la misma deuda es lo que hace que
  dejen de leerse.
- **Los recordatorios salen a media mañana.** Un aviso de deuda a las seis de la
  mañana se recuerda distinto.
- **Los cortes masivos van de a lotes**, con un renglón por abonado y por
  momento: nadie recibe el mismo mensaje dos veces aunque la cola se reintente.

Lo que conviene sumar del lado del ISP:

- No registrar nada como Marketing.
- No usar esta vía para promociones. Si algún día hace falta, que sea con otro
  número: una promoción marcada como spam se lleva puesta la entrega de los
  avisos de corte, que son los que sostienen la cobranza.

---

## Si algo no sale

El sistema traduce los errores de Meta a algo accionable. Los que se ven:

| Qué dice | Qué hacer |
|---|---|
| "Pasaron más de 24 horas… solo se puede mandar una plantilla aprobada" | Falta aprobar esa plantilla. Registrala y marcala |
| "Esa plantilla no existe en Meta o está en otro idioma" | El `nombre_meta` o el idioma no coinciden con lo registrado |
| "La cantidad de variables no coincide" | El texto de acá y el aprobado allá tienen distinta cantidad de `{{n}}` |
| "Meta pausó o rechazó esa plantilla por calidad" | Mirá la calificación del número en el Administrador |
| "Se alcanzó el límite de envíos del número" | Meta lo levanta solo a medida que sube la calificación |

En **Ajustes → Plantillas de WhatsApp**, cualquier estado que no sea *Aprobada*
significa que ese aviso **hoy no sale por WhatsApp**.
