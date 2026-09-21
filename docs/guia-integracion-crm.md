# Guía paso a paso — conectar el CRM / bot de WhatsApp

Todo lo que hay que hacer, en orden, del lado del ISP.

Son **dos direcciones independientes** y conviene no mezclarlas:

| | |
|---|---|
| **El CRM consulta y cobra** (secciones 1–6) | Le das una llave y consume tu API |
| **Tu sistema le pasa avisos al CRM** (sección 7) | Le das los avisos y él los entrega por WhatsApp |

La primera funciona sola. La segunda es opcional.

---

## Índice

1. [Antes de empezar](#1-antes-de-empezar)
2. [Emitir la llave](#2-emitir-la-llave-ajustes--gestión-de-personal)
3. [Configurar qué puede hacer](#3-configurar-qué-puede-hacer-ajustes--integraciones)
4. [Entregarle los datos al proveedor](#4-entregarle-los-datos-al-proveedor)
5. [Probar que funciona](#5-probar-que-funciona)
6. [El día a día](#6-el-día-a-día)
7. [Los avisos por WhatsApp](#7-los-avisos-por-whatsapp)
8. [Cortes masivos](#8-cortes-masivos)

---

## 1. Antes de empezar

### Las migraciones

Se pegan en Supabase → SQL Editor → New query → Run, **en orden**:

| | |
|---|---|
| `173-la-api-para-el-crm` | Llaves, registro de llamadas y bandeja de pagos |
| `174-el-corte-masivo-se-avisa-solo` | Incidencias masivas |
| `175-lo-que-manda-el-bot-con-el-comprobante` | Banco, depositante, hash del QR |
| `176-las-plantillas-aprobadas-de-whatsapp` | Plantillas de Meta |
| `177-el-webhook-que-abre-la-ventana` | Webhook de entrada |
| `178-la-llave-que-nace-de-un-usuario` | Generar la llave desde un legajo |
| `179-el-comprobante-validado-por-su-qr` | `qr_validado` y cuenta de destino |
| `180-el-whatsapp-que-sale-por-un-crm` | Salida por un CRM externo |

Para comprobar que están todas:

```bash
npm run check:migraciones
```

Lee la base y dice cuál falta, columna por columna. No modifica nada.

### Que el middleware esté corriendo

```bash
npm run dev
```

Levanta la API en `localhost:4000` y la web en `localhost:5173`.

**Dos cosas que cuestan tiempo si no se saben:**

- **Si el middleware está caído, la pantalla no guarda nada.** Los cambios se
  pierden sin avisar.
- **Si tocaste código del middleware, hay que reiniciarlo.** El navegador se
  actualiza solo; el servidor no. Un cambio que "no aparece" casi siempre es
  esto.

---

## 2. Emitir la llave (Ajustes → Gestión de personal)

La llave se genera **desde el legajo de la persona cuya función va a cumplir**.
No se crean usuarios para esto: si es para cobros, sale de finanzas o
administración; si es para campo, de un técnico.

1. **Ajustes → Gestión de personal**
2. Buscá al usuario y apretá el ícono del **enchufe** 🔌
3. Ponele un nombre (*"CRM / Bot de WhatsApp"*)
4. **Generar**
5. **Copiá la llave ahora.** Se muestra una sola vez y no se guarda en ningún
   lado.

### Qué permisos se lleva

Los que **esa persona** tenga, cruzados con los que tienen sentido desde afuera:

| Permiso | Habilita |
|---|---|
| `clientes.ver` | Consultar estado y deuda |
| `facturacion.ver` | Consultar facturas |
| `pagos.registrar` | Registrar pagos y consultar comprobantes |
| `red.diagnostico` | Diagnosticar la conexión y reiniciar la ONT |
| `red.wifi` | Cambiar SSID y clave |
| `soporte.crear` | Abrir tickets |
| `ventas.cobertura` · `ventas.planes` · `ventas.solicitudes` | Vender |

**Nunca se lleva** `clientes.eliminar` ni `pagos.anular`, aunque el usuario los
tenga. Nada que se opere desde un chat tiene por qué poder borrar un abonado o
revertir un cobro.

Para un bot que hace de todo, el único legajo que suele cubrir las nueve cosas es
el **Super Administrador**.

### Es una foto, no un vínculo

Los permisos se copian **en ese momento**. Si mañana cambian los de esa persona,
la llave no cambia. Si renuncia y se desactiva su usuario, la llave sigue
funcionando. Lo que la llave puede hacer se cambia editando la llave.

---

## 3. Configurar qué puede hacer (Ajustes → Integraciones)

**Ajustes → Integraciones → Editar** en la llave.

### Acreditar los pagos al instante

Apagado, todo lo que el bot registre cae en **Cobros → Pagos reportados** y
alguien lo confirma. Encendido, entra a la caja directo.

Aun encendido, hacen falta **tres** condiciones para que un pago se acredite
solo:

**1. Que el método de verificación alcance.**

| `verificado_por` | ¿Acredita? |
|---|---|
| `bank_api` — lo confirmó el banco | Sí |
| `qr_validado` — el QR del comprobante coincide con su texto y con la cuenta | Sí |
| `human` — lo aprobó una persona | Sí |
| `ocr_only` — solo se leyó la imagen | **No, queda a verificar** |

`qr_validado` es el que corresponde cuando el bot escanea el QR del comprobante
y lo compara contra los datos impresos: retocar el texto visible no cambia el
QR, así que una imagen editada no pasa esa prueba.

Ese campo solo puede **bajar** la confianza, nunca subirla: si el sistema externo
pudiera mandar `"human"` para saltearse la verificación, la verificación no
existiría.

**2. Que se sepa a qué cuenta entró la plata.**

El bot manda `cuenta_destino` con el número que leyó del comprobante, y el
sistema lo resuelve contra tus cuentas. Corriente y ahorros se distinguen solas.

Si el número **no** es de ninguna cuenta tuya, el pago se **rechaza** con
`CUENTA_DESCONOCIDA` — esa plata no entró acá.

Si el pago **no dice** a qué cuenta fue y la llave no tiene cuenta por defecto,
queda **pendiente** en vez de acreditarse mal.

**3. Que la llave lo tenga habilitado.** El interruptor de arriba.

### Cuenta por defecto — opcional

Dejala vacía si el bot informa la cuenta en cada pago: ahí gana el comprobante y
esta no se usa nunca. Solo sirve como red por si alguno llega sin decirlo.

### Reactivar el servicio del cortado

Al acreditarse, le quita la IP del address-list de corte en el MikroTik y lo pasa
a activo. Es lo único de todo esto que el bot no puede hacer por su cuenta.

Si el router no responde, el cobro **igual queda registrado** y la respuesta lo
dice — así se ve el caso en vez de perderse.

### IPs permitidas

Vacío = desde cualquier lado. Cargalas cuando el proveedor tenga su servidor
definitivo: es el mayor salto de seguridad por el menor esfuerzo.

---

## 4. Entregarle los datos al proveedor

| Qué | Valor |
|---|---|
| URL base | `https://TU-DOMINIO/api/v1` |
| Llave | la que copiaste en el paso 2 |
| Header | `X-API-Key` (o `Authorization: Bearer`) |
| Documentación | `docs/api-v1-resumen.md` y `docs/api-v1-crm.md` |

**Vos le das, él pega.** En su panel. Del CRM no se pega nada acá — salvo lo de
la sección 7, que es la dirección contraria.

### Sobre la URL

Depende de dónde corra su bot:

| Dónde corre | URL base |
|---|---|
| En tu misma PC | `http://localhost:4000/api/v1` |
| Otra PC de tu red | `http://TU-IP-LAN:4000/api/v1` |
| En la nube | Hace falta exponer el middleware |

En el último caso, para probar alcanza con un túnel:

```bash
cloudflared tunnel --url http://localhost:4000
```

Para producción hace falta dominio y HTTPS. **No lo publiques por HTTP plano**:
la llave viaja en cada pedido.

### Qué pedirle

1. **Las IPs desde las que va a llamar**, para restringir la llave.
2. **Que confirme que llega**: `GET /api/integracion/ping` con la llave.
3. **Que respete `hash_qr`, `repetido` y `acreditado`.** Son los tres campos
   donde una integración mal hecha duplica cobros o promete acreditaciones que no
   ocurrieron.

---

## 5. Probar que funciona

### La llave responde

```bash
curl -H "X-API-Key: sk_..." http://localhost:4000/api/integracion/ping
```

Devuelve sus permisos y si sus pagos se acreditan o quedan a verificar.

### Consultar un abonado

```bash
curl -H "X-API-Key: sk_..." \
  "http://localhost:4000/api/v1/cliente/consultar-deuda?cedula=1204567890"
```

### Registrar un pago de prueba

Usá **un abonado de prueba y un monto chico**: si la llave acredita al instante,
esto crea un cobro real.

```bash
curl -X POST http://localhost:4000/api/v1/pagos/registrar \
  -H "X-API-Key: sk_..." -H "Content-Type: application/json" \
  -d '{"cedula":"99900030","monto":0.01,"forma_pago":"app",
       "hash_qr":"prueba-1","cuenta_destino":"2100300272",
       "verificado_por":"qr_validado","origen":"PRUEBA"}'
```

Mirá `acreditado` y `cuenta` en la respuesta. Después borralo desde **Cobros →
Pagos registrados** con el botón de eliminar — que es para el cobro que nunca
debió existir, distinto de anular.

---

## 6. El día a día

| Pantalla | Para qué |
|---|---|
| **Cobros → Pagos reportados** | Lo que quedó a verificar, con el monto al lado de la deuda real, el banco y el depositante para cruzar contra el extracto |
| **Ajustes → Integraciones → Registro de llamadas** | Qué pidió el bot, con qué cédula y con qué resultado |
| **Cobros → Pagos registrados** | El cierre del día, con lo del bot mezclado con lo de ventanilla |

### Si algo falla

| Síntoma | Causa |
|---|---|
| El bot recibe `403` | Llave revocada, sin ese permiso, o IP no habilitada. El mensaje dice cuál |
| Los pagos quedan pendientes | La respuesta trae `motivo_pendiente`: la llave, el método, o que falta la cuenta |
| `CUENTA_DESCONOCIDA` | El comprobante dice que la plata fue a una cuenta que no es tuya |
| La pantalla no guarda | El middleware no está corriendo |
| Un cambio no aparece | Falta reiniciar el middleware |

---

## 7. Los avisos por WhatsApp

Esto es **la dirección contraria**: los avisos que manda tu sistema (factura
emitida, recordatorio, corte, pago recibido, avería).

Hay dos formas, y la decisión es sobre **cuántos números** vas a tener.

### El problema de fondo

Si el bot le habla al cliente desde un número y el aviso de corte sale desde
otro, el abonado recibe mensajes de dos números que dicen ser el mismo
proveedor. Eso confunde, y lo que la gente hace cuando se confunde es bloquear.
Los bloqueos bajan la calificación de calidad del número, y con la calificación
en rojo Meta recorta los envíos.

### Opción A — que los entregue el CRM *(un solo número)*

Tu sistema decide **qué** avisar y **cuándo**; el CRM lo entrega por el número
que ya usa. Las plantillas las aprueba y mantiene el proveedor.

**Ajustes → Mensajería → Por dónde sale → CRM externo:**

| Campo | |
|---|---|
| Nombre | Cómo se llama, para los mensajes de error |
| URL | El endpoint que te dio el proveedor |
| Cabecera | `X-API-Key` o `Authorization` |
| Llave | La que generó el CRM. Se cifra y no se vuelve a ver |

El botón **Guardar está al final de la página**, no dentro de la tarjeta: hay uno
solo para WhatsApp, SMS, correo y alertas.

Después, en **Ajustes → Plantillas de WhatsApp**, columna *En el CRM*, tiene que
estar cargado el `purpose` de cada aviso. Los diez ya vienen con el suyo.

**Un aviso sin `purpose` no sale por esta vía**: se cae al SMS o al correo y
queda escrito el motivo.

Lo que le mandás al proveedor:

- `docs/plantillas-para-el-crm.md` — las 10 plantillas con su nombre en Meta, su
  `purpose`, el texto para pegar, las variables y el JSON exacto que va a
  recibir.
- `docs/salida-whatsapp-crm.md` — el contrato: formato del cuerpo, qué se espera
  de vuelta, y cómo se manejan los errores.

**El costo honesto:** dependés de ellos para que salga un aviso de corte. Si su
servicio se cae, esos avisos no salen — pero el sistema cae solo a SMS o correo,
sin que nadie haga nada.

### Opción B — tu propio número *(dos números)*

Tu sistema manda directo por la Cloud API de Meta.

1. **Ajustes → Mensajería** → vía **Cloud API de Meta** → token permanente y
   Phone Number ID.
2. Cargá el **token de verificación** (lo inventás vos) y el **App Secret**.
3. En Meta → WhatsApp → Configuración → Webhooks: URL
   `https://TU-DOMINIO/api/webhooks/whatsapp`, ese token, y suscribite a
   `messages`.
4. **Ajustes → Plantillas de WhatsApp**: registrá las 10 en el Administrador de
   Meta y marcalas como aprobadas.

Con esta vía además llegan los **acuses de entrega** y se sabe si la **ventana de
24 h** está abierta.

**Mientras las plantillas estén sin aprobar, esos avisos no salen por WhatsApp**:
fuera de la ventana de 24 h, Meta solo entrega plantillas.

### Cuidar la calificación del número

Vale para las dos opciones:

- **Todas las plantillas como UTILITY**, nunca Marketing. Una marca de spam en una
  plantilla de marketing baja la calificación del número entero.
- **Respetá el opt-out.** El abonado con los avisos apagados no recibe nada, ni
  siquiera el de corte. Es su decisión, y desoírla es la razón por la que la gente
  bloquea.
- **No uses esta vía para promociones.** Si algún día hace falta, que sea con otro
  número: una promoción marcada como spam se lleva puesta la entrega de los avisos
  de corte.

---

## 8. Cortes masivos

**Red → Cortes masivos.** Se elige el alcance —una zona, una caja NAP, un nodo, un
puerto PON— y la pantalla dice **a cuántos abonados alcanza antes** de mandar
nada.

Nace en borrador: abrirla es lo que dispara los avisos.

En **Ajustes → Tareas programadas** hay dos interruptores, los dos apagados:

- **Aviso de cortes masivos** — manda lo que esté encolado.
- **Apertura automática** — deja que el monitoreo abra la incidencia solo cuando
  un nodo lleva caído más que el umbral. Es lo único del sistema que le escribe a
  cientos de abonados sin que nadie apriete nada.

Con el segundo apagado, el monitoreo igual crea los borradores: podés mirar un
mes de "qué habría mandado" antes de encenderlo.

### Y esto alimenta al bot

`consultar-deuda` y `diagnostico-ont` devuelven **`falla_masiva_sector`**, y
`crear-ticket` contesta **`409 AVERIA_CONOCIDA`** en vez de abrir el ticket
número ciento ochenta por la misma causa.

Es el único lugar de toda la API cuyo propósito es que el bot **deje** de hacer
cosas.

---

## Comandos útiles

```bash
npm run dev                # levanta middleware y web
npm run check:migraciones  # qué migraciones faltan, columna por columna
npm run plantillas:crm     # regenera docs/plantillas-para-el-crm.md desde la base
npm test                   # la suite del middleware
```

## Los documentos

| Archivo | Para quién |
|---|---|
| `datos-para-el-crm.md` | Vos — de dónde sacar la URL, el tipo de auth y el token |
| `api-v1-resumen.md` | El proveedor del CRM — referencia rápida |
| `api-v1-crm.md` | El proveedor — detalle de cada endpoint |
| `plantillas-para-el-crm.md` | El proveedor — las 10 plantillas |
| `salida-whatsapp-crm.md` | El proveedor — contrato de la vía de salida |
| `guia-integracion-crm.md` | Vos — esta guía |
