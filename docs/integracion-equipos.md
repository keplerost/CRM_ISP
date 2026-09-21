# Flujo de integración — MikroTik, OLT y TR-069 / GenieACS

Cómo la interfaz llega hasta los equipos: qué camino toma cada pedido, qué está funcionando hoy,
y qué falta para lo que todavía no se puede hacer.

---

## 1. Por dónde va cada cosa

Hay dos caminos y la diferencia no es de estilo: es de qué puede llegar a dónde.

```
                    ┌──────────────────────────────────────┐
   Navegador ──────►│ Supabase (PostgREST + RLS)           │  datos
                    │  clientes, facturas, tickets, consumo │
                    └──────────────────────────────────────┘

                    ┌──────────────────────────────────────┐      ┌──────────────┐
   Navegador ──────►│ Middleware (Express, red del ISP)    │─────►│ MikroTik     │ API 8728/8729
                    │  /api/mikrotik  /api/herramientas    │─────►│ OLT          │ SSH / Telnet
                    │  /api/consumo   /api/sri             │─────►│ SMTP, SRI    │
                    └──────────────────────────────────────┘      └──────────────┘
```

**Lo que es dato va directo a Supabase.** El navegador consulta y escribe con la clave anónima y
RLS protege las filas. Meter esas consultas en el middleware agregaría un salto sin ganar nada.

**Lo que toca un equipo pasa por el middleware, siempre.** No por prolijidad: el navegador no
puede abrir un socket TCP a la API de RouterOS ni una sesión SSH, y aunque pudiera, las
credenciales de los equipos estarían en la máquina de quien abra la pantalla.

Las contraseñas de los equipos se guardan cifradas (`password_encrypted`, `lib/crypto.js`) y solo
se descifran dentro del middleware, en memoria, para armar la conexión.

---

## 2. MikroTik — RouterOS API

### 2.1 Los dos modos y por qué existen

`services/mikrotikService.js` elige el driver por router:

| Modo | Puerto | Driver | Cuándo |
|---|---|---|---|
| `binaria` | 8728 / 8729 (TLS) | `drivers/mikrotikApi.js` | Lo normal en un ISP: IP pública y puerto de API |
| `rest` | 80 / 443 | `drivers/mikrotik.js` | Donde el 8728 está bloqueado por firewall |

Sin `modo_api` cargado se deduce del puerto. Los dos drivers exponen la misma interfaz, así que
las rutas no se enteran de cuál se está usando.

**La API binaria es la que soporta todo.** La REST de RouterOS no expone las herramientas
(`/ping`, `/tool/traceroute`, `/tool/bandwidth-test`), así que esas funciones avisan con un
mensaje claro en vez de fallar con un error de protocolo:

```js
export const ping = (r, datos) => (soloBinaria('Ping')(r), binaria.ping(r, datos))
```

### 2.2 Conexiones: una cola por equipo

`conConexion()` no abre una sesión por operación. Cada router tiene una cola
(`enCola('mikrotik:<clave>')`) y una conexión reutilizada. Abrir una sesión por cada entrada de
una address-list agota el límite de sesiones del equipo en segundos — pasó, y por eso está así.
Ante un fallo la conexión se descarta, porque puede haber quedado inservible a mitad de una
respuesta.

### 2.3 Comandos que se usan hoy

| Función | Comando RouterOS |
|---|---|
| Cortar / reconectar | `/ip/firewall/address-list/{add,remove}` |
| Redirección a la página de pago | `/ip/firewall/nat` |
| Velocidades | `/queue/simple/{print,add}` |
| Importar clientes | `/ppp/secret/print`, `/ip/dhcp-server/lease/print` |
| Consumo | `/queue/simple/print` → campo `bytes` |
| Sesiones PPPoE | `/ppp/active/print` |
| Ping | `/ping =address= =count=` |
| Traceroute | `/tool/traceroute =address= =count=1 =max-hops=` |
| Kick PPPoE | `/ppp/active/print ?name=` + `/ppp/active/remove` |
| Dispositivos conectados | `/ip/arp/print` |
| Cambiar WiFi | `/interface/wireless/security-profiles/set`, `/interface/wireless/set` |
| Reiniciar | `/system/reboot` |

`count` y `max-hops` son obligatorios en ping y traceroute: sin ellos RouterOS responde para
siempre y la conexión queda colgada hasta el tiempo de espera.

### 2.4 Cómo se agrega una herramienta nueva

Tres archivos, en este orden:

1. **`drivers/mikrotikApi.js`** — el comando:
   ```js
   export const loQueSea = (router, { algo }) =>
     conConexion(router, (conn) => conn.write('/ruta/del/comando', [`=param=${algo}`]))
   ```
2. **`services/mikrotikService.js`** — exponerlo, con `soloBinaria()` si es una herramienta.
3. **`routes/herramientas.routes.js`** — la ruta, envuelta en `registrando()` para que quede en
   `comandos_ejecutados`.

### 2.5 La regla que evita el accidente

**Las rutas de herramientas reciben el id del CLIENTE, nunca la IP ni el id del router.** El
middleware lee su ficha y deduce el objetivo:

```js
const { cliente, equipo } = await contexto(req.params.clientId)
const destino = req.body?.destino || cliente.ip || cliente.ip_administracion
```

Si la pantalla mandara la IP, un id equivocado le reiniciaría el equipo al vecino. Con este
diseño, el peor caso es un error que no encuentra al cliente.

### 2.6 Usuario recomendado en el router

No usar `admin`. Crear un usuario con un grupo acotado:

```
/user group add name=gestion policy=read,write,api,test,!local,!telnet,!ssh,!ftp,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=gestion group=gestion password=<larga> address=<IP-del-middleware>/32
/ip service set api address=<IP-del-middleware>/32
/ip service set api-ssl address=<IP-del-middleware>/32
```

`address=` es lo que más importa: limita la API a la IP del middleware. Sin eso, el puerto 8728
expuesto a internet es un intento de fuerza bruta permanente.

> **Estado hoy:** los dos routers cargados no responden desde la máquina de desarrollo —
> `FTTH LA MANA` devuelve *Username or password is invalid* y `PROGRESO` no contesta en el 8728.
> Hasta resolver eso, el consumo y las herramientas no tienen con qué trabajar.

---

## 3. OLT

`services/oltService.js` habla por SSH/Telnet con un driver por marca (Huawei, V-SOL). Los
comandos confirmados contra el hardware real están en `comandos-referencia.md`.

Lo que ya se usa desde la ficha:

- `leerMetricas()` → potencia óptica de la ONU, que es lo que contesta el botón **Señal /
  potencia** cuando el abonado es de fibra.
- El parser de Huawei lee `Last down cause`, que distingue un corte de energía (*dying gasp*) de
  una fibra cortada. Sin eso, las dos fallas se ven igual: "ONU offline".

Una lectura contra la OLT tarda segundos, así que la ficha muestra el valor guardado en `onus` y
consulta en vivo solo cuando alguien aprieta el botón.

### 3.1 Qué perfil se le pone a una ONT nueva

En la OLT hay **dos** perfiles por ONT, y cada uno depende de otra cosa:

| | De qué depende | Qué define |
|---|---|---|
| `srv-profile` | el **modelo** de la ONT | cuántos ETH y POTS, y si tiene puerto **IPHOST** — sin IPHOST no hay TR-069 |
| `ont-lineprofile` | el **servicio** | VLAN, gemport y si `TR069 management` está en Enable |

El srv-profile se resuelve **por nombre**: `oltFicha.js` busca entre los perfiles del equipo el
que se llame igual que el modelo que reportó la ONT, sin distinguir mayúsculas. En La Maná eso
empareja solo 12 de los 14 modelos del catálogo — incluido `H3-1S` con el perfil `H3-1s`.

Por eso `tipos_ont` **no** guarda a qué perfil corresponde cada modelo, y `perfil_default_id`
quedó sin uso: un ID de perfil es local a un equipo. El perfil 7 de La Maná no es el perfil 7 de
otra OLT — lo mismo que ya advierte `olt.routes.js` sobre las plantillas de autorización. El
catálogo de modelos es global; un número de perfil no puede serlo.

De ahí la regla al sumar una OLT: **el srv-profile se llama igual que el modelo de ONT**. Con
eso, un modelo registrado una vez sirve para todos los equipos sin configurar nada por OLT. Si
algún día un equipo no puede respetar el nombre, la salida es una tabla puente
(`tipo_ont` × `olt` → nombre de perfil) para esa excepción, no volver al ID.

Es además lo único que sobrevive al cambio de marca: en ZTE el equivalente del srv-profile es el
`onu-type`, que también se identifica por nombre y no tiene ID numérico. Los comandos ZTE todavía
no están relevados —hoy `oltService` levanta *"Todavía no se lee ... de una OLT ZTE"*— pero el
emparejamiento por nombre ya funciona igual en las dos marcas.

Ojo con una confusión fácil: las F680/F660/F6600 del catálogo son **ONUs** ZTE colgadas de una OLT
Huawei, y eso funciona hoy. Una **OLT** ZTE es otra cosa y no tiene driver.

---

## 4. TR-069 / GenieACS — lo que falta

### 4.1 Qué resuelve y qué no

TR-069 es el protocolo para administrar el equipo **del abonado** (la ONT, el router de su casa).
Es lo único que permite:

- Cambiar el SSID y la clave WiFi de una ONT (hoy solo se puede si su CPE es un MikroTik).
- Listar los dispositivos conectados **dentro de la casa** (hoy se ve el ARP del router del ISP,
  que dice cuántas IP tiene tomadas, no qué aparatos hay detrás de su WiFi).
- Reiniciar el equipo del abonado sin reiniciar el router de borde.
- Leer la potencia óptica desde la ONT además de desde la OLT.

**No reemplaza nada de lo que ya funciona.** El corte, las velocidades y el consumo siguen siendo
del MikroTik.

### 4.2 Cómo se conecta

```
   ONT del abonado ──── Inform periódico ────► GenieACS (CWMP :7547)
                                                    │
   Middleware ──── NBI HTTP :7557 ────────────► GenieACS
       │  POST /devices/<id>/tasks?connection_request
       └─ escribe en comandos_ejecutados
```

El equipo del abonado se reporta solo cada N minutos. Para actuar en el momento, GenieACS usa un
*connection request*: le avisa a la ONT que se conecte ahora. Eso significa que **el equipo tiene
que ser alcanzable desde GenieACS** — si está detrás de NAT sin puerto abierto, la acción queda
encolada hasta el próximo Inform. Es la diferencia entre "cambia la clave ahora" y "cambia la
clave en algún momento de la próxima hora", y hay que decírselo al operador.

### 4.3 Pasos concretos

**a) Levantar GenieACS** (servidor propio, junto al middleware):

```bash
npm install -g genieacs
# genieacs-cwmp :7547   genieacs-nbi :7557   genieacs-fs :7567   genieacs-ui :3000
```

Necesita MongoDB. Los cuatro procesos van con systemd.

**b) Que las ONT sepan a dónde reportar.** Se configura en el perfil de la OLT, no ONT por ONT.
En Huawei, dentro del `ont-srvprofile`, se habilita el WAN de gestión TR-069 y se apunta a:

```
http://<ip-de-genieacs>:7547
```

**c) Agregar el driver.** El patrón ya existe: `drivers/mikrotikApi.js` y `drivers/olt*.js` son
adaptadores a un equipo. Falta `drivers/genieacs.js`:

```js
// Cambiar SSID y clave de una ONT por TR-069.
export async function cambiarWifi(deviceId, { ssid, clave }) {
  const res = await fetch(`${NBI}/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'setParameterValues',
      parameterValues: [
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', ssid, 'xsd:string'],
        ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', clave, 'xsd:string'],
      ],
    }),
  })
  if (!res.ok) throw new Error(`GenieACS devolvió ${res.status}`)
  return res.json()
}
```

Parámetros que interesan:

| Qué | Parámetro TR-069 |
|---|---|
| SSID | `InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID` |
| Clave WiFi | `…WLANConfiguration.1.KeyPassphrase` |
| Dispositivos en la casa | `InternetGatewayDevice.LANDevice.1.Hosts.Host.` |
| Potencia óptica RX | `InternetGatewayDevice.WANDevice.1.X_…_GponInterfaceConfig.RXPower` |
| Reiniciar | tarea `reboot` |

**d) Vincular el abonado con su equipo.** Falta una columna `clientes.acs_device_id`. El id de
GenieACS suele ser `<OUI>-<ProductClass>-<SerialNumber>`, y el serial ya está en `onus.sn`, así
que se puede resolver por serie en la primera sincronización.

**e) Enganchar en las rutas.** `herramientas.routes.js` ya tiene la forma:

```js
router.post('/:clientId/wifi', async (req, res) => {
  const { cliente, equipo } = await contexto(req.params.clientId)

  // Con ONT y ACS configurado va por TR-069; si no, al MikroTik del abonado.
  const porAcs = cliente.acs_device_id && config.acs.url

  await registrando(req, { clientId: cliente.id, comando: 'cambiar_wifi', ... }, () =>
    porAcs
      ? acs.cambiarWifi(cliente.acs_device_id, req.body)
      : mk.cambiarWifi(equipo, req.body),
  )
})
```

El registro en `comandos_ejecutados` no cambia: es el mismo comando visto desde la ficha, sin
importar por dónde salió.

### 4.4 Orden sugerido

1. GenieACS levantado y **una** ONT reportando. Sin eso, lo demás es teoría.
2. Sincronizar `acs_device_id` por número de serie contra `onus.sn`.
3. Lectura primero: potencia y lista de hosts. Es reversible y valida el camino completo.
4. Recién después la escritura: SSID, clave, reboot.

Empezar por la escritura es la forma de descubrir que el ACS no llega al equipo dejando a un
abonado sin WiFi.

---

## 5. RADIUS — la alternativa para el consumo

Hoy el consumo sale de restar contadores de las simple queues, con los tres problemas que eso
trae (contador que se reinicia, cola que se recrea, lecturas espaciadas). Está resuelto y probado,
pero es una aproximación.

Con RADIUS (FreeRADIUS + `/radius` en el MikroTik) el propio equipo reporta el acumulado de cada
sesión en los paquetes de *accounting*: no hay que restar nada y el momento exacto de cada
desconexión queda registrado. Si en algún momento se monta, cambia una sola función —el
recolector— porque `repartir()` y `sumar_consumo()` ya trabajan sobre "cuánto consumió cada
abonado en este intervalo", sin saber de dónde salió el número.

`sesiones_conexion.fuente` ya distingue `mikrotik` de `radius` para poder convivir durante la
transición.

---

## 6. Requisitos de red

| Desde | Hacia | Puerto | Para qué |
|---|---|---|---|
| Middleware | MikroTik | 8728 / 8729 | API de RouterOS |
| Middleware | OLT | 22 / 23 | SSH / Telnet |
| Middleware | SRI | 443 | Recepción y autorización |
| Middleware | SMTP | 465 / 587 | Envío de comprobantes y mensajes |
| ONT del abonado | GenieACS | 7547 | Inform de TR-069 |
| GenieACS | ONT del abonado | 7547 | Connection request |
| Middleware | GenieACS | 7557 | NBI |

**La app tiene que servirse por HTTPS.** No es una recomendación: la ubicación del navegador
—que usa la confirmación de llegada del técnico— está bloqueada fuera de un contexto seguro.
En `localhost` funciona por excepción, pero servida por IP de red local (`http://192.168.x.x`)
va a fallar siempre, y no por un error del código.
