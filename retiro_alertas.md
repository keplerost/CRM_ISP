# Cierre del ciclo del abonado y alertas en tiempo real

> Documento de diseño. Todavía **no está implementado**: acá se define qué hay que
> construir, por qué así y en qué orden. Lo que queda abierto está marcado con
> **⟶ decidir**.

Tres problemas que se tocan entre sí:

1. **El abonado que ya no es abonado.** Cuando el equipo vuelve a la bodega, su
   ficha queda como si nada hubiera pasado.
2. **El equipo que nunca vuelve.** El cliente se mudó, cambió de número y no hay
   con quién coordinar. Hoy no existe forma de cerrar ese caso.
3. **Enterarse tarde.** La ONT se apaga un martes y en la oficina se sabe el
   viernes, cuando el cliente llama —si llama—. Para entonces el equipo puede
   estar en otra ciudad.

---

## 1. Cerrar la ficha del abonado

> "Una vez que llegue a manos de oficina y pasar el equipo a inventario general,
> debe permitirme eliminar al cliente, o notificarme que debo colocar retirado."

### No borrar. Marcar como retirado.

No es una preferencia estética. Son cuatro cosas que se rompen:

| Si se borra la ficha… | qué se rompe |
|---|---|
| Los pagos apuntan a un cliente que no existe | La caja del mes pasado deja de cuadrar |
| Las facturas ya enviadas al SRI quedan huérfanas | Un comprobante emitido no se puede desvincular de su titular |
| Las comisiones pagadas pierden a quién correspondían | El día que se audite un pago a un vendedor, no hay contra qué compararlo |
| El historial desaparece | El mismo cliente vuelve en seis meses y nadie sabe que ya tuvo servicio, ni que se le quedó un equipo |

La última es la que más duele en un ISP: **el que se fue vuelve**. Borrarlo es
regalarle una ficha limpia.

La función correcta ya existe —`dar_de_baja_cliente(cliente, motivo, nota)` de la
migración 100, con su tabla `motivos_baja`—. Lo que falta no es la capacidad:
es que nadie la dispare en el momento en que corresponde.

### Cómo debería funcionar

Al **firmar el acta de entrega**, por cada equipo que venga de una orden de
retiro:

```
¿el abonado de ese retiro sigue con estado distinto de "baja"?
      │
      ├── sí  →  se ofrece cerrarlo ahí mismo:
      │            [ Marcar como retirado ] + motivo + nota
      │          y si no se hace en el momento, queda PENDIENTE
      │
      └── no  →  nada: ya estaba cerrado
```

**El pendiente es la parte importante.** Un botón no alcanza: quien recibe
material está contando ONTs, no pensando en el CRM. Por eso:

- Se crea una **notificación**: *"Ficha por cerrar — Ana Pérez: su equipo volvió
  a bodega el 14/08 y sigue como activa"*.
- Aparece una solapa **"Fichas por cerrar"** en la pantalla de retiros. Un
  pendiente tiene que vivir en una lista, no solo en una campana que se apaga.
- El aviso se repite **una vez por semana** hasta resolverse.

### Qué construir

| Pieza | Dónde |
|---|---|
| `v_fichas_por_cerrar` — equipo devuelto y abonado con estado ≠ baja | migración |
| `cerrar_ficha_abonado()` — envuelve `dar_de_baja_cliente` y deja rastro de que se cerró por retiro | migración |
| Aviso semanal | dentro de la tarea *Cartera*, que ya corre |
| Bloque en el diálogo de firma + solapa nueva | `RecibirEntregasPage`, `RetirosPage` |

**⟶ decidir:** ¿cerrar la ficha es **obligatorio** para firmar el acta, o un
pendiente postergable? *Recomiendo pendiente:* quien recibe el material no
siempre es quien decide dar de baja a un cliente, y bloquear la recepción por eso
dejaría equipos sin registrar en bodega — que es peor.

---

## 2. Cuando la ONT nunca se recupera

> "¿Qué pasaría si la ONT nunca se recupera? Existen casos que hasta de número
> celular cambian, o sea nunca se llega a coordinar nada. ¿Qué deberíamos hacer?"

### El problema no es cerrar: es distinguir

`cerrar_retiro_equipo(recuperado = false)` ya existe y exige motivo. Eso está
bien. El problema es que **cualquiera puede declarar un equipo perdido con un
clic y una palabra**, y hoy no se distinguen tres casos que no son lo mismo:

1. Se fue a otra ciudad y no hay a quién reclamarle → **pérdida real**
2. Está en la casa y se niega a entregarlo → **reclamable**
3. El técnico fue una vez, no había nadie, y lo dio por perdido → **no se intentó**

Mezclados, el indicador de "valor perdido" no sirve para decidir nada.

### La escalera con evidencia

El equipo no se declara perdido: **se agota un procedimiento** y recién ahí
alguien con autoridad lo cierra.

```
PASO 1 · Contacto      3 intentos por canales DISTINTOS, 24 h entre cada uno
                       (WhatsApp · llamada · Telegram · correo · portal)
                       Ya se registran en retiro_intentos.

PASO 2 · Visita        2 visitas en días y horarios distintos, con foto.
                       Una visita un martes a las 10 no prueba nada.

PASO 3 · Terceros      El vendedor que lo trajo —casi siempre tiene otro número
                       o conoce a la familia—, el vecino, el dueño si alquilaba.

PASO 4 · Verificación  Quien gestiona retiros revisa y firma el cierre con una
                       categoría.
```

Los pasos 1 a 3 **no bloquean**: son un checklist que muestra lo ya registrado.
El paso 4 sí exige algo en cada uno — o una anulación explícita del supervisor,
que queda guardada con su nombre.

### Las categorías de cierre

Reemplazan el texto libre de hoy, para que el número sirva:

| Categoría | Qué significa | Consecuencia |
|---|---|---|
| `mudanza_sin_aviso` | Se fue, no hay contacto | Pérdida + deuda de equipo en la ficha |
| `se_niega` | Localizable y no lo entrega | Pérdida **reclamable**, lista aparte |
| `equipo_dañado` | Volvió pero no sirve | Baja técnica, **no** es falla de recuperación |
| `equipo_robado` | Robo o siniestro | Pérdida, con número de denuncia |
| `cliente_falleció` | | Pérdida, sin reclamo |
| `zona_insegura` | No se puede ir | Pérdida, y marca la zona |
| `error_de_registro` | El equipo nunca estuvo ahí | **No** es pérdida: corrige el inventario |

La última importa más de lo que parece: hoy un equipo mal fichado se cierra como
"no recuperado" y ensucia el indicador para siempre.

### Lo que queda en la ficha del que se fue

- **Deuda de equipo**: el valor queda anotado en su ficha, separado de la deuda de
  servicio. No se factura ni va a cobranza —no es una venta— pero está a la vista.
- **Aviso al reingresar**: si esa cédula vuelve a aparecer en un prospecto, ventas
  avisa *"tuvo servicio hasta 03/2026 y quedó con una ONT sin devolver ($35)"*.
- La ficha se cierra con `mudanza_sin_aviso`, distinto de una baja normal.

**⟶ decidir:** ¿la deuda de equipo **impide** reactivar o solo avisa? *Recomiendo
avisar:* un bloqueo duro lo saltea alguien creando una ficha con otro nombre, y
ahí se pierde el rastro por completo.

---

## 3. Alertas en tiempo real

> "Que nos envíe un WhatsApp cuando detecte que el cliente se quedó sin potencia
> o desconectó el equipo […] permitir agregar varios números, para que no solo yo
> esté enterado sino también mis técnicos. Configurable, dentro de Ajustes."

Esto resuelve los dos problemas anteriores **antes de que existan**: una ONT que
se apaga y nadie reclama es, muchas veces, un equipo que se está yendo.

### La idea que hace que se use y no se silencie

**Una ONT sola que cae es sospechosa. Veinte a la vez es una fibra cortada.**

Si se manda un mensaje por cada ONT que se apaga, la primera noche de tormenta
llegan cuarenta y a la semana nadie los lee. Por eso la regla central no es
"avisar cuando algo se apaga" sino **agrupar por causa probable**:

| Lo detectado | Qué se manda |
|---|---|
| 1 ONT baja, el resto de su NAP bien | ⚠️ *"Ana Pérez (000132) sin señal desde las 14:20. Zona Centro. NAP-12 normal."* → **posible retiro o mudanza** |
| Varias ONTs de la misma NAP o PON | 🔴 *"Corte en NAP-12: 8 abonados desde las 14:18"* → **un solo mensaje** |
| Una OLT o un puerto entero | 🔴 *"OLT LA MANÁ puerto 1/2: 46 abonados"* → **un mensaje** |
| Potencia degradándose sin caer | 🟡 *"Ana Pérez: de −22 a −27 dBm en 7 días"* → resumen diario |
| Vuelve el servicio | ✅ *"NAP-12 recuperada: 8 de 8"* |

Esa distinción es la diferencia entre una herramienta que se usa y una que se
apaga a la semana.

### De dónde sale — ya existe

- `onus.estado` y `onus.rx_power_dbm` — el estado actual.
- **`onu_optica_historial`** (migración 41) — `rx_dbm`, `tx_dbm`, `medida_at`. Es
  lo que permite decir "bajó 5 dBm en una semana".
- La tarea **Lectura óptica**, que ya corre por intervalo y llena eso.
- El monitoreo **NMS** y `nodo_eventos`, para nodos y antenas.

Falta la capa de **reglas, destinos y anti-spam**.

---

### 3.1 Con qué mandar los WhatsApp

Cuatro caminos, y la configuración tiene que **dejarte elegir cuál** sin tocar
código. Hoy `config_mensajeria.whatsapp_via` acepta `manual`, `meta` y `twilio`;
hay que sumar `baileys` y `evolution`.

| Vía | Costo | Qué necesita | Riesgo | Sirve para alertas |
|---|---|---|---|---|
| **manual** | — | Nada | — | ❌ No hay nadie apretando el botón a las 3 a.m. |
| **Baileys** | Gratis | Escanear un QR con tu celular. Corre dentro del middleware | ⚠️ No oficial: Meta puede bloquear el número | ✅ Sí |
| **Evolution API** | Gratis | Un servicio aparte (Docker). Por dentro usa Baileys, o Cloud API | ⚠️ Mismo riesgo si va por Baileys | ✅ Sí |
| **Cloud API (Meta)** | Pago por conversación, con tramo gratis | Cuenta de empresa verificada y plantillas aprobadas | Ninguno | ✅ Sí |
| **Twilio** | Pago por mensaje | Cuenta Twilio | Ninguno | ✅ Sí |

#### Lo que hay que saber de cada uno antes de elegir

**Baileys** — la librería se conecta como si fuera WhatsApp Web con tu número.
Ventajas: gratis, sin límite de mensajes, sale desde el número que tus técnicos
ya conocen. Contras, que son reales:

- Es **no oficial**. Meta puede bloquear el número si detecta uso automatizado
  agresivo. Para alertas internas —decenas de mensajes por día a números
  conocidos— el riesgo es bajo; para difusión masiva es alto.
- La sesión vive en el proceso: si el middleware se reinicia hay que
  **guardar y restaurar el estado**, y si se cierra sesión desde el celular hay
  que volver a escanear el QR.
- El teléfono que escanea **no** tiene que estar prendido siempre (multi-device),
  pero si pasa mucho tiempo desconectado, WhatsApp cierra la sesión.

**Evolution API** — es un servidor aparte que envuelve Baileys y expone HTTP. La
diferencia práctica con Baileys directo:

- La sesión vive **fuera** de nuestro proceso. Si el middleware se reinicia por un
  deploy, WhatsApp no se cae con él. Eso solo ya justifica el servicio aparte.
- Trae panel para escanear el QR y ver el estado de la conexión, que es
  exactamente lo que no querés programar vos.
- Cuesta desplegar un contenedor más y mantenerlo.
- El riesgo de bloqueo es **el mismo** que Baileys: por debajo es lo mismo.

**Cloud API (Meta)** — la oficial. Sin riesgo de bloqueo, con entrega confiable.
Dos fricciones: verificación de la empresa, y que los mensajes que **inicia la
empresa** fuera de una ventana de 24 h necesitan una **plantilla aprobada**. Para
alertas internas a tus técnicos eso se resuelve registrando una plantilla como:

```
🔴 {{1}}
{{2}} abonados sin servicio desde las {{3}}.
Zona: {{4}}
```

Se aprueba una vez y después se usa siempre.

#### Cómo se elige, en la práctica

Un desplegable en Ajustes → Mensajería, y según lo elegido aparecen sus campos:

```
Enviar WhatsApp por:  ( ) Manual — solo abre el chat, sin automatismo
                      (•) Baileys — gratis, con tu propio número
                      ( ) Evolution API — gratis, servicio aparte
                      ( ) Cloud API de Meta — oficial, pago
                      ( ) Twilio — oficial, pago

  ┌─ Baileys ───────────────────────────────────────────┐
  │  Estado: ● conectado como +593 99 …                 │
  │  [ Ver QR para vincular ]   [ Cerrar sesión ]       │
  │  Última reconexión: hace 3 h                        │
  └─────────────────────────────────────────────────────┘
```

Y con Evolution:

```
  ┌─ Evolution API ─────────────────────────────────────┐
  │  URL del servidor   http://localhost:8080           │
  │  Instancia          hlfibra                         │
  │  API key            ••••••••••          [ Probar ]  │
  │  Estado: ● conectada                                │
  └─────────────────────────────────────────────────────┘
```

**Mi recomendación:** empezar por **Evolution API**. Es gratis como Baileys pero
no arrastra la sesión de WhatsApp adentro del middleware —que es donde más duele
un reinicio— y da el QR y el estado sin que haya que programarlos. Y el día que
tengas cuenta de Meta, se cambia el desplegable: los mensajes, las reglas y los
destinos no se tocan.

#### Cómo se construye para que el cambio sea un desplegable

Un **driver por vía**, con la misma interfaz, en la carpeta que ya existe para
esto:

```
middleware/src/drivers/whatsapp/
    index.js       elige el driver según config_mensajeria.whatsapp_via
    meta.js        graph.facebook.com          (ya existe, se muda acá)
    twilio.js      api.twilio.com              (ya existe, se muda acá)
    evolution.js   POST {url}/message/sendText/{instancia}
    baileys.js     @whiskeysockets/baileys, con la sesión en disco
    manual.js      devuelve el enlace wa.me, no envía
```

Todos exponen lo mismo:

```js
enviar({ numero, texto })   → { ok, id, error }
estado()                    → { conectado, como, detalle }
```

Con eso, agregar una vía nueva mañana es un archivo, y el resto del sistema no se
entera.

---

### 3.2 La configuración: Ajustes → Alertas

**a) A quién se le avisa** — varios destinos, cada uno con lo suyo:

| Nombre | Canal | Destino | Qué recibe | Horario |
|---|---|---|---|---|
| Yo (admin) | WhatsApp | 099… | Todo | 24 h |
| Edison (técnico) | WhatsApp | 099… | Cortes de red · individuales de su zona | 07–20 |
| Guardia nocturna | Telegram | chat | Solo cortes masivos | 20–07 |
| Soporte | Correo | soporte@… | Resumen diario | — |

Cada destino con un botón **"Enviar mensaje de prueba"**: es lo único que evita
descubrir que el número estaba mal el día del primer corte.

**b) Qué se considera alerta**

| Regla | Por defecto | Editable |
|---|---|---|
| ONT sin señal | avisar si sigue caída **10 minutos** | sí |
| Potencia crítica | por debajo de **−27 dBm** | sí |
| Degradación | **3 dBm** en 7 días | sí |
| Corte agrupado | **3 o más** ONTs de la misma NAP en 15 min | sí |
| Silencio nocturno | los individuales no salen entre 22 y 07 | sí |
| Tope | **20 mensajes por hora** en total | sí |

Los 10 minutos son el número más importante de la tabla: sin espera, un corte de
luz de dos minutos manda cien mensajes.

**c) Qué se está mandando** — el historial: a quién, cuándo, por qué y qué
contestó el proveedor. Sin esto, *"no me llegó nada"* es indiscutible.

### Qué construir

| Pieza | Qué es |
|---|---|
| `alerta_reglas` | Una fila por tipo, con umbral y si está activa |
| `alerta_destinos` | Números y canales, qué recibe cada uno y en qué horario |
| `alerta_eventos` | Lo detectado: entidad, tipo, cuándo empezó, cuándo se recuperó |
| `alerta_envios` | Cada mensaje, con la respuesta del proveedor |
| `detectar_alertas()` | Compara el estado actual contra el anterior y agrupa por NAP/PON/OLT |
| `drivers/whatsapp/*` | Los cinco de arriba, misma interfaz |
| `services/alertas.js` | Toma los eventos sin enviar, arma el texto y despacha |
| Tarea **Alertas** | Cada 5 minutos. La única de intervalo corto |
| `ajustes/AlertasPage.jsx` | Las tres secciones |
| `lib/alertas.js` | Los textos, funciones puras y probadas |

El texto de los mensajes va en un módulo puro con pruebas, por lo mismo que las
plantillas del retiro: lo va a leer una persona en el teléfono a las tres de la
mañana, y un mensaje mal armado a esa hora es una salida al pedo.

---

## Orden de implementación

| # | Qué | Por qué en este orden |
|---|---|---|
| **1** | Drivers de WhatsApp + elección en Ajustes | Habilita todo lo demás y sirve también para cobranza y soporte |
| **2** | Alertas: detección, reglas, destinos, tarea | Es lo único que **previene** pérdidas en vez de registrarlas |
| **3** | Cierre de ficha al recibir el acta | Chico, y cierra un circuito que ya está a medias |
| **4** | Categorías de cierre y checklist | Ordena lo que hoy es texto libre |
| **5** | Deuda de equipo y aviso al reingresar | Último: solo sirve cuando ya haya casos cerrados |

Cada uno es una migración numerada con sus pruebas en `supabase/pruebas` y
`middleware/test`, como el resto del módulo de cartera.

---

## Lo que queda por decidir

1. **Vía de WhatsApp** para arrancar: ¿Evolution API *(mi recomendación)*, Baileys
   directo, o esperar a tener Meta?
2. **Cierre de ficha**: ¿obligatorio para firmar el acta, o pendiente? *(recomiendo pendiente)*
3. **Deuda de equipo**: ¿bloquea la reactivación o solo avisa? *(recomiendo avisar)*
4. **Umbrales**: los de la tabla son un punto de partida. ¿10 minutos de espera
   antes de avisar es poco o mucho para tu red?
5. **El número que envía**: ¿el mismo con el que atendés a los clientes, o uno
   aparte? Con Baileys o Evolution conviene **uno aparte**: si ese número se
   bloquea, no se cae la atención al cliente.
