# Los tres datos que pide el CRM, y de dónde salen

Cuando un CRM te pide **URL base**, **tipo de autenticación** y **token**, esto es
lo que hay que darle y cómo obtenerlo.

---

## 1 · Tipo de autenticación

**API Key en un header.** El sistema acepta las dos formas más comunes, así que
elegí la que su panel te ofrezca:

| Si el panel dice | Configurá |
|---|---|
| *API Key* · *Header* · *Custom header* | Nombre del header: **`X-API-Key`** · Valor: el token |
| *Bearer Token* · *Token* | Header: **`Authorization`** · Valor: **`Bearer sk_…`** |

Las dos funcionan igual. Si te deja elegir, usá `X-API-Key`: es más difícil de
confundir con una sesión de usuario.

**No** es OAuth, ni Basic, ni usuario y contraseña. Si el panel solo ofrece esas
tres, decile al proveedor que la API usa una llave en header.

---

## 2 · Token

Es la llave que emitís vos. **Se muestra una sola vez** y no se guarda en ningún
lado: si se pierde, se revoca y se emite otra.

### Cómo sacarla

1. **Ajustes → Gestión de personal**
2. Buscá al usuario cuya función va a cumplir el bot — para uno que cobra,
   atiende y vende, suele ser el **Super Administrador**
3. Apretá el ícono del **enchufe** 🔌
4. Ponele un nombre que reconozcas dentro de seis meses (*"CRM de WhatsApp"*)
5. **Generar**
6. **Copiala ahí mismo**

La llave empieza con `sk_` y tiene unos 46 caracteres.

### Si ya la generaste y no la copiaste

No se puede recuperar. Andá a **Ajustes → Integraciones**, revocá esa llave y
generá otra. Revocar la corta en el acto; el registro de lo que hizo queda.

### Cómo saber cuáles tenés

**Ajustes → Integraciones** muestra todas: su nombre, el prefijo (los primeros
caracteres, para reconocerlas), sus permisos, y cuándo se usó por última vez.

---

## 3 · URL base

Es la parte difícil, porque **depende de dónde corra el bot del CRM**.

La API vive en el puerto **4000** de la máquina donde corre el middleware, bajo
la ruta `/api/v1`.

### Preguntale al proveedor: ¿dónde corre su bot?

| Dónde corre | URL base |
|---|---|
| En tu misma PC | `http://localhost:4000/api/v1` |
| En otra PC de tu red | `http://TU-IP-LAN:4000/api/v1` |
| **En la nube** (lo más común) | Hace falta exponer el middleware — ver abajo |

Para saber tu IP de la red local:

```bash
ipconfig
```

Buscá *Dirección IPv4* de la placa que uses (Wi-Fi o Ethernet).

### Si el bot corre en la nube

Es el caso más común, y también el que no funciona con `localhost`: **para un
servidor en internet, `localhost` es él mismo, no tu PC.** Nunca va a llegar.

Hay dos caminos.

#### Para probar — un túnel

Te da una URL pública temporal sin configurar nada:

```bash
cloudflared tunnel --url http://localhost:4000
```

**Ya está instalado y armado en esta PC.** Para levantarlo:

```bash
npm run tunel
```

Imprime la URL base lista para copiar. Antes chequea que el middleware esté
arriba: si no lo está, te lo dice en vez de darte una URL que contesta 502.

Mientras esa ventana siga abierta, el túnel sigue vivo. Al cerrarla se cae.

**La URL cambia cada vez que lo levantás**, así que sirve para probar, no para
producción — cada reinicio hay que pasarle la nueva al proveedor. Y mientras uses
túnel, **no le cargues IPs permitidas a la llave**: la IP de origen cambia sola y
la llave dejaría de funcionar sin motivo aparente.

Si alguna vez hay que instalarlo de cero en otra máquina:

```powershell
winget install --id Cloudflare.cloudflared
```

En esta PC `winget` no está en el PATH; el ejecutable vive en
`%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe`.

#### Para producción — dominio y HTTPS

Hace falta:

1. Un **dominio** apuntando al servidor donde corre el middleware.
2. Un **certificado** (Let's Encrypt es gratis).
3. Publicar el puerto detrás de nginx — el archivo `deploy/nginx-smartolt.conf`
   ya trae el proxy armado hacia `127.0.0.1:4000`.

Ahí la URL queda `https://TU-DOMINIO/api/v1` y no cambia más.

**No lo publiques por HTTP plano.** La llave viaja en cada pedido y en HTTP viaja
legible: cualquiera en el camino se la queda.

---

## Probar antes de entregarlo

Con la URL y el token en la mano, comprobá que responde:

```bash
curl -H "X-API-Key: sk_TU_LLAVE" https://TU-URL/api/integracion/ping
```

Tiene que contestar algo así:

```json
{
  "ok": true,
  "llave": "CRM / Bot de WhatsApp",
  "permisos": ["clientes.ver", "facturacion.ver", "pagos.registrar", "…"],
  "pagos": "se acreditan al instante"
}
```

Si contesta eso, el proveedor puede empezar.

| Si contesta | Qué pasa |
|---|---|
| `401` *Falta la llave* | El header está mal escrito |
| `401` *La llave no es válida* | El token está mal copiado |
| `403` *fue revocada* | Esa llave ya no sirve, generá otra |
| No contesta nada | La URL no llega — es el problema de la sección 3 |

---

## Resumen para copiar y pegar

```
URL base       : https://TU-URL/api/v1
Autenticación  : API Key en header
Nombre header  : X-API-Key
Token          : sk_…   (Ajustes → Gestión de personal → 🔌 Generar)
```

Y adjuntale `docs/api-v1-resumen.md`, que es la referencia de los endpoints.

---

## Lo que NO tenés que darle

**Ni la clave de Supabase, ni la `service_role`, ni tu contraseña del sistema.**
La llave `sk_` es lo único que necesita, y está limitada a lo que vos le marcaste:
no puede eliminar abonados ni anular cobros, aunque quiera.

Si un proveedor te pide acceso a la base de datos directamente, no hace falta —
todo lo que necesita pasa por la API.
