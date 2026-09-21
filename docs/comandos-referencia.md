# Referencia de comandos reales — OLT V-SOL, OLT Huawei, MikroTik

Este documento recopila los comandos **confirmados en vivo** contra el hardware real del taller
(no son comandos "de manual" — todos fueron probados y ajustados hasta funcionar contra los
equipos reales). Sirve como referencia rápida y como base para entender qué hace cada endpoint
del middleware.

---

## 1. OLT V-SOL (SSH, CLI estilo Cisco)

### 1.1 Login y modos

```
enable
<password del usuario>
configure terminal
```

Deja la sesión en `gpon-olt(config)#`. Para entrar a un puerto PON:

```
interface gpon 0/<puerto>          # ej. interface gpon 0/1
```

Prompt resultante: `gpon-olt(config-pon-0/1)#`.

### 1.2 Prueba de conexión / salud

```
enable
<password>
configure terminal
show version
```

### 1.3 Descubrimiento de ONUs

Dentro de `interface gpon 0/<puerto>`:

| Comando | Qué hace |
|---|---|
| `show onu state all` | Lista todas las ONUs registradas del puerto (índice, admin state, OMCC state, phase state, serial). |
| `show onu auto-find` | Lista ONUs nuevas detectadas sin registrar (vacío si no hay nada nuevo). |
| `show onu info all` | Modelo, perfil, tipo PON y modo de auth de todas las ONUs del puerto — usado para detectar modelos reales de ONT. |
| `show onu info <id>` | Igual que arriba pero para una sola ONU. |
| `show onu distance <id>` | Distancia en metros (`onu 18 Distance: 1m`). |
| `show onu statistics <id>` | Contadores de tráfico (Input/Output bytes/packets). |

### 1.4 Registro / aprovisionamiento

```
onu confirm                                  # confirma automáticamente lo que esté en la cola de auto-find
onu confirm line-profile <NOMBRE_PERFIL>     # variante con perfil de línea
```

Para dar servicio real (VLAN) a una ONU ya existente (secuencia validada, 3 pasos):

```
onu <id> tcont <tcontId>
onu <id> gemport <gemportId> tcont <tcontId>
onu <id> service-port <spId> gemport <gemportId> uservlan <VLAN> vlan <VLAN>
```

> **⚠️ Nota de campo**: la primera vez que se usa un `tcont` nuevo en un puerto, en el equipo del
> taller esto causó una caída breve (unos segundos) de **todo el puerto PON** ("PON down"),
> afectando momentáneamente a las demás ONUs de ese puerto. No se repitió en aprovisionamientos
> posteriores del mismo puerto.

### 1.5 Eliminar una ONU

```
no onu <id>
```

(También soporta `no onu all` o `no onu offline`, no usados por la app.)

### 1.6 Particularidad de la CLI V-SOL

La salida usa **códigos ANSI de movimiento de cursor** (`ESC[12C`, `ESC[27C`, etc.) para alinear
columnas en vez de espacios — el parser (`vsolOnuParser.js`) los reemplaza por `|` antes de
separar las columnas, en vez de usar regex basadas en espacios (que se rompen porque esos códigos
contienen dígitos).

---

## 2. OLT Huawei (MA5800, VRP)

### 2.1 Login y modos

```
enable
config
interface gpon <frame>/<slot>       # ej. interface gpon 0/1
```

Prompt resultante: `MA5800-X7(config-if-gpon-0/1)#`.

### 2.2 Particularidad de la CLI VRP — el "Enter extra"

Cuando un comando VRP tiene parámetros opcionales, la CLI muestra un hint de autocompletado en
vez de ejecutar de inmediato:

```
MA5800-X7(config-if-gpon-0/1)#display ont autofind 0
{ <cr>||<K> }:
```

Hace falta **un segundo Enter** (una línea vacía en la lista de comandos) para que el comando
realmente se ejecute. Todos los comandos `display ont ...` del middleware van seguidos de un
comando vacío `''` por este motivo.

### 2.3 Descubrimiento de ONTs

Dentro de `interface gpon <frame>/<slot>`:

| Comando | Qué hace |
|---|---|
| `display ont info <portid> all` | Lista las ONTs registradas del puerto (ONT-ID, SN, estado, descripción). `portid` es 0-15. |
| `display ont autofind <portid>` | ONTs nuevas sin registrar en ese puerto (responde "Failure: The automatically found ONTs do not exist" si no hay nada). |
| `display ont version <portid> <ontid>` | Modelo/versión — **solo si la ONT está online** (se lee vía OMCI en vivo). |
| `display ont optical-info <portid> <ontid>` | Potencia óptica Rx/Tx — solo si está online. |
| `display ont traffic <portid> <ontid>` | Tráfico en tiempo real — solo si está online. |

### 2.4 Registrar una ONT nueva

```
ont add <portid> <ontid> sn-auth <SN> omci
ont add <portid> <ontid> sn-auth <SN> omci desc <descripción>
```

`<ontid>` es un número libre 0-255 en ese puerto — el middleware lo calcula automáticamente
(primer ID no usado) antes de ejecutar el comando.

### 2.5 Eliminar una ONT

```
ont delete <portid> <ontid>
ont delete <portid> all       # elimina todas las del puerto (no usado por la app)
```

### 2.6 Perfiles y planes (modo `config`)

```
ont-lineprofile gpon profile-name "PROFILE_VLAN100"
 vlan-map 1 100
 commit
 quit

traffic table ip index 10 name "PLAN_100M" cir 10240 pir 102400 priority 6
```

---

## 3. MikroTik (REST API, RouterOS v7)

A diferencia de las OLTs, MikroTik **no se maneja por SSH** — se usa la **REST API** de RouterOS
v7 sobre HTTP (no la API binaria clásica del puerto 8728, que en la red del taller estaba
bloqueada por firewall).

- Base URL: `http://<ip>:<puerto>/rest`
- Autenticación: HTTP Basic Auth (usuario/password del router)
- Content-Type/Accept: `application/json`

| Acción | Método + ruta |
|---|---|
| Probar conexión | `GET /rest/system/identity` |
| Listar IP Pools | `GET /rest/ip/pool` |
| Crear IP Pool | `PUT /rest/ip/pool` `{name, ranges}` |
| Listar IP Addresses | `GET /rest/ip/address` |
| Crear IP Address | `PUT /rest/ip/address` `{address, interface, comment?}` |
| Listar bloqueos (address-list) | `GET /rest/ip/firewall/address-list` (filtrado por `list=CORTE_MOROSOS`) |
| Bloquear una IP | `PUT /rest/ip/firewall/address-list` `{list: "CORTE_MOROSOS", address, comment?}` |
| Restaurar servicio | `DELETE /rest/ip/firewall/address-list/<id>` |
| Crear regla de corte (una vez) | `PUT /rest/ip/firewall/filter` `{chain: "forward", "src-address-list": "CORTE_MOROSOS", action: "drop", comment: "SmartOLT-CorteMorosos"}` |

**Detección de fallo silencioso**: si la REST API no está realmente disponible en la ruta/red
desde donde se conecta el middleware, MikroTik responde con la página web normal (Webfig) en vez
de JSON — el driver detecta esto (`Content-Type` no-JSON / respuesta HTML) y lo reporta como
error explícito en vez de fallar de forma confusa.

---

## 4. Resumen de particularidades descubiertas en el taller

| Hallazgo | Sistema | Impacto |
|---|---|---|
| Los espacios de alineación son códigos ANSI, no espacios reales | V-SOL | Rompe cualquier parser basado en `\s+` — hay que reemplazar los códigos primero. |
| Los comandos con parámetros opcionales necesitan un "Enter" extra | Huawei VRP | Sin el segundo Enter, el comando nunca se ejecuta (se queda en el hint de autocompletado). |
| El primer `tcont` nuevo en un puerto puede tumbar el puerto PON completo brevemente | V-SOL | Evitar repetir sin necesidad; avisar antes de aprovisionar servicio por primera vez en un puerto. |
| `version` / `optical-info` / `traffic` de una ONT requieren que esté online | Huawei | Son lecturas OMCI en vivo, no hay forma de leerlas de un equipo offline. |
| El puerto 8728 (API binaria) puede estar bloqueado por firewall aunque el servicio esté habilitado | MikroTik | Usar la REST API (puerto 80/443) como alternativa si 8728 no es alcanzable. |
| MikroTik puede responder HTML en vez de JSON si la REST API no está realmente activa en esa ruta | MikroTik | Verificar `Content-Type` de la respuesta, no asumir JSON solo por el código 200. |
