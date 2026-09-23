# Instalar el sistema en un servidor

Guía completa, de un servidor vacío a un sistema funcionando con HTTPS.

Escrita **después** de instalarlo de verdad: cada advertencia que hay acá
corresponde a algo que efectivamente salió mal la primera vez.

```
                         Servidor (Debian 12)
   ┌───────────────────────────────────────────────────────────┐
   │  nginx  :80/:443                                          │
   │    ├── /            → web (archivos estáticos compilados) │
   │    └── /api         → middleware (Node, :4000)            │
   │                                                           │
   │  OpenVPN server :1194/tcp        (solo si hace falta)     │
   │    └── un túnel por MikroTik sin IP pública               │
   └───────────────────────────────────────────────────────────┘
              │                              │
              │ internet                     │ túneles
              ▼                              ▼
        Supabase (nube)            MikroTik ─── OLTs en su LAN
```

El middleware queda **dentro** de la red de la VPN, así que alcanza a los
routers —y a las OLTs detrás de ellos— sin exponer ningún puerto a internet.

---

## Antes de empezar

**El servidor.** Debian 12. Mínimo 1 GB de RAM (con 1 GB el instalador crea
swap solo, ver el paso 2), 25 GB de disco. Con 2 GB va más cómodo.

**Si vas a compartirlo con otro sistema**, leé primero
[Convivir con otro sistema](#convivir-con-otro-sistema). La respuesta corta es
que no conviene para una primera puesta en marcha.

**Si vas a mover el concentrador VPN de un servidor a otro**, ojo: cada MikroTik
tiene la IP del servidor escrita en su `connect-to`. Si los túneles se caen, a
los routers **sin IP pública no los alcanzás para reconfigurarlos** y hay que ir
físicamente a cada uno.

> Asignale una **IP reservada** al servidor desde el día uno. Es gratis mientras
> esté en uso y te deja mover, agrandar o reconstruir la máquina sin tocar un
> solo router. Mejor todavía: poné un **dominio** en `connect-to`.

---

## 1. Traer el proyecto

Si el repositorio es **privado** —lo normal— el servidor necesita su propia
llave de lectura. Es el primer obstáculo y aparece a los treinta segundos.

Como root, en el servidor:

```bash
apt update && apt install -y git
ssh-keygen -t ed25519 -C "$(hostname)" -f /root/.ssh/id_ed25519 -N ""
cat /root/.ssh/id_ed25519.pub
```

Copiá esa línea. En GitHub → tu repositorio → **Settings** → **Deploy keys** →
**Add deploy key**. Pegala y **no marques** "Allow write access": el servidor
solo tiene que leer.

De vuelta en el servidor:

```bash
git clone git@github.com:USUARIO/REPO.git /opt/smartolt
```

Si el repositorio es público, alcanza con la URL `https://`.

> No hace falta `chmod +x` sobre los scripts: ya vienen ejecutables del
> repositorio. Si se los ponés a mano, git los ve modificados y el próximo
> `git pull` se niega a pisarlos.

---

## 2. Instalar

```bash
cd /opt/smartolt/deploy
./install-app.sh --firewall
```

`--firewall` configura ufw. **Usalo solo si el servidor es exclusivo para este
sistema.** En uno compartido, corrélo sin la bandera y leé
[Convivir con otro sistema](#convivir-con-otro-sistema).

El instalador va por pasos numerados y dice en cuál está:

- **0/6 Revisa el servidor** — si hay otro servicio escuchando en 80 o 443, se
  niega y explica por qué, en vez de instalar un nginx que después no arranca.
- **1/6 a 3/6** — paquetes base, Node 22 y el usuario de servicio `smartolt`.
- **4/6 Dependencias y compilación** — acá **resuelve la memoria**: si hay poca,
  crea 2 GB de swap *y* le sube el techo de heap a Node. Sin las dos cosas el
  frontend no compila (ver [Problemas conocidos](#problemas-conocidos)).
- **5/6 y 6/6** — el servicio de systemd y nginx.
- Al final, si lo pediste, el firewall — permitiendo primero **todos** los
  puertos que ya estaban escuchando, para no cortar nada que estuviera andando.

Tarda unos minutos. El paso de compilación es el largo.

---

## 3. Las credenciales

Los `.env` se crean con los valores de ejemplo. Hay que completarlos con los de
tu instalación.

**No los copies a mano.** Las llaves de Supabase pasan los doscientos caracteres
y un error de tipeo se manifiesta como un fallo de conexión que parece de red.

Desde **tu máquina**, con el proyecto clonado, armá el pegado de una sola vez:

```bash
{
  echo "cat > /opt/smartolt/middleware/.env <<'EOF'"
  sed "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://TU-DOMINIO|" middleware/.env
  echo "EOF"
  echo
  echo "cat > /opt/smartolt/web/.env <<'EOF'"
  sed "s|^VITE_API_URL=.*|VITE_API_URL=https://TU-DOMINIO|" web/.env
  echo "EOF"
} > /tmp/para-el-servidor.txt
```

Abrí ese archivo, copiá todo, y pegalo en la consola del servidor **en el prompt
normal** (no dentro de `nano`). Reescribe los dos archivos completos.

Después, en el servidor:

```bash
chown smartolt:smartolt /opt/smartolt/middleware/.env /opt/smartolt/web/.env
chmod 600 /opt/smartolt/middleware/.env
```

> **`VITE_API_URL` es solo el dominio, sin `/api` al final.** El frontend le
> agrega `/api/...` a cada llamada. Si le ponés `/api`, las llamadas salen a
> `/api/api/...`, dan 404, y el sistema abre pero la barra de arriba dice
> *middleware no responde* y no se puede cambiar ninguna contraseña.

> El servicio corre como `smartolt`, no como root. Si creás los `.env` como root
> y les ponés `chmod 600` sin cambiar el dueño, el middleware no puede leerlos y
> falla con un error que no menciona los permisos.

**`CREDENTIALS_KEY` tiene que ser idéntica** a la de tu instalación anterior. Es
la frase con la que se cifran las contraseñas de OLTs y routers en la base; con
otra, el sistema no puede descifrar los equipos ya cargados.

Comprobá que quedó bien:

```bash
systemctl restart smartolt-middleware
curl -s http://127.0.0.1:4000/api/health
```

`configuracionFaltante` tiene que venir vacío.

---

## 4. HTTPS

**No es opcional si el técnico va a usar el celular.** Sobre HTTP el navegador
no da acceso a la cámara ni al GPS, y no instala la aplicación en el teléfono —
adiós foto de ingreso y adiós ubicación.

### Si el dominio apunta directo al servidor

```bash
DOMINIO=crm.tudominio.com
getent hosts "$DOMINIO"        # tiene que devolver la IP del servidor

apt install -y certbot python3-certbot-nginx
certbot --nginx -d "$DOMINIO" --redirect --agree-tos -m TU@CORREO --no-eff-email
```

### Si el dominio está en Cloudflare con la nube naranja

Certbot **no sirve acá**: Let's Encrypt valida conectándose al dominio, que
resuelve a Cloudflare y no a tu servidor.

Se reconoce el caso enseguida: el dominio resuelve a IPs de Cloudflare
(`104.x`, `172.67.x`) y el sitio da **error 521** al intentar HTTPS —
Cloudflare busca un 443 en el origen que todavía no existe.

El camino es un **certificado de origen**, que además dura 15 años en vez de 90
días:

1. Panel de Cloudflare → **SSL/TLS** → **Servidor de origen** →
   **Create Certificate**. Dejá los valores por defecto.
   **No cierres esa pantalla** hasta guardar los dos bloques: la clave privada
   no se vuelve a mostrar.

2. En el servidor:
   ```bash
   mkdir -p /etc/ssl/cloudflare && chmod 700 /etc/ssl/cloudflare
   nano /etc/ssl/cloudflare/origen.pem     # el certificado
   nano /etc/ssl/cloudflare/origen.key     # la clave privada
   chmod 600 /etc/ssl/cloudflare/origen.key
   ```

3. Instalá la configuración:
   ```bash
   cp /opt/smartolt/deploy/nginx-cloudflare.conf /etc/nginx/sites-available/smartolt
   sed -i 's/TU-DOMINIO/crm.tudominio.com/g' /etc/nginx/sites-available/smartolt
   nginx -t && systemctl reload nginx
   ```

4. En Cloudflare → **SSL/TLS** → **Información general** → modo
   **Completo (estricto)**.

   Con *Completo* a secas, Cloudflare cifra hacia tu servidor pero **no valida**
   el certificado: acepta cualquiera. El modo estricto es lo que le da sentido
   al certificado que acabás de instalar. Y con *Flexible*, el tramo
   Cloudflare→servidor viaja **sin cifrar** por internet — y por ahí pasan las
   contraseñas de las OLTs.

> **Copiá el archivo con `cp`; no pegues su contenido en la consola web.**
> Las consolas de los proveedores mezclan las líneas de los pegados largos. Lo
> peligroso es que el resultado puede quedar sintácticamente válido —`nginx -t`
> lo aprueba— y el problema aparece días después.

### Y después, apuntar el sistema al dominio

En los dos casos:

```bash
sed -i "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://crm.tudominio.com|" /opt/smartolt/middleware/.env
sed -i "s|^VITE_API_URL=.*|VITE_API_URL=https://crm.tudominio.com|" /opt/smartolt/web/.env
/opt/smartolt/deploy/actualizar.sh
```

Sin esto el frontend sigue llamando a la dirección vieja y el navegador bloquea
esas llamadas por mezclar HTTPS con HTTP.

Comprobá:

```bash
curl -sI  http://crm.tudominio.com  | head -1    # 301
curl -sI  https://crm.tudominio.com | head -1    # 200
curl -s   https://crm.tudominio.com/api/health
```

---

## 5. El concentrador VPN

Solo si tenés routers **sin IP pública**. Si todos los equipos tienen IP
pública, saltealo: el servidor les llega directo.

```bash
cd /opt/smartolt/deploy
./openvpn-server.sh
```

Te pregunta tres cosas:

| | |
|---|---|
| IP pública o dominio | la del servidor — los routers se conectan acá |
| Puerto | 1194 está bien |
| **Red VPN** | **elegila con cuidado**, ver abajo |

Queda escuchando en **TCP**, porque el cliente OpenVPN de RouterOS trabaja mucho
mejor así que sobre UDP.

### Elegir la red del túnel

`10.8.0.0/24` es el valor por defecto de OpenVPN y por eso mismo es el que más
choca. Si el ISP donde instalás ya lo usa, el servidor queda con dos caminos
hacia la misma red y los paquetes se van por el equivocado — el síntoma es que
*a veces anda*, que es el peor de todos.

El script comprueba tres cosas antes de aceptarla:

- que sea **privada** (10.x, 172.16-31.x o 192.168.x)
- que sea la dirección **de red** y no la de un equipo
- que **no se pise** con nada que el servidor ya tenga ruteado

Pero no puede saber qué usa el resto de tu infraestructura.

> Si vas a instalar esto en varios ISPs, **usá un segmento distinto en cada
> uno** (`10.66.0.0/24`, `10.67.0.0/24`…). El día que necesites conectarte a dos
> a la vez desde la misma computadora, con rangos iguales no vas a poder.

Ojo también con lo que ya existe alrededor: DigitalOcean usa `10.116.0.0/20`
para su red privada, y algunos sistemas de gestión usan `192.168.255.0/24`.

Lo elegido queda en `/etc/openvpn/smartolt.env` y los otros dos scripts lo leen
de ahí: no hay un segundo lugar donde acordarse de cambiarlo.

---

## 6. Agregar un MikroTik

Uno por router:

```bash
./agregar-cliente-vpn.sh sectorNuevo 10.66.0.11
```

Genera el certificado, le fija la IP, y deja en `/root/clientes-vpn/sectorNuevo/`
los archivos a subir al router más **el script listo para pegar** en su terminal.

En el MikroTik (WinBox):

1. **Files** → arrastrar `ca.crt`, `sectorNuevo.crt` y `sectorNuevo.key`
2. **New Terminal** → pegar el contenido de `mikrotik-sectorNuevo.rsc`

Comprobá desde el servidor:

```bash
ping 10.66.0.11
cat /var/log/openvpn/status.log      # quién está conectado
```

---

## 7. Las redes detrás de cada MikroTik

El paso anterior te deja hablando con el **router**. No alcanza para la OLT: la
OLT está en la LAN de ese router, y el servidor no sabe que esa red existe.

```
  Servidor ──túnel──► MikroTik 10.66.0.11
                        └── LAN 10.11.105.0/24 ──► OLT 10.11.105.2
                             ▲
                             └─ para llegar acá hace falta este paso
```

```bash
./agregar-red-cliente.sh sectorNuevo 10.11.105.0/24
```

Escribe las dos directivas que hacen falta —`route` en la configuración del
servidor y `iroute` en la del cliente— y reinicia OpenVPN. Con una sola de las
dos no funciona, y el síntoma es idéntico al de no haber hecho nada.

Del lado del MikroTik, si tenés filtro en `forward`, dejá pasar lo que llega
por la interfaz del túnel:

```
/ip firewall filter
add chain=forward in-interface=vpn-gestion action=accept \
    comment="Gestion desde el concentrador"
```

Comprobá:

```bash
ping 10.11.105.2
```

Sin argumentos, el script lista los clientes dados de alta y las redes ya
publicadas.

---

## 8. Cargar los equipos en la aplicación

**Red → Routers MikroTik → Nuevo**

| Campo | Valor |
|---|---|
| IP | la del túnel (`10.66.0.11`) o la pública, según el caso |
| Modo | API de RouterOS |
| Puerto | el que tengas en `/ip service` |

**OLT / GPON → OLTs → Nueva**, con su IP de la LAN.

---

## El correo de acceso

Para que el personal pueda recuperar su contraseña solo, sin pedírsela a quien
administra, hay que configurar dos cosas en el panel de Supabase. El sistema ya
trae el "¿Olvidaste tu contraseña?" en la pantalla de entrada; esto es lo que
falta del otro lado.

**Project Settings → Authentication → SMTP Settings** → *Enable Custom SMTP*, con
los mismos datos con los que el sistema ya manda las facturas:

| Campo | Valor |
|---|---|
| Host / Port | el de tu proveedor — con Gmail, `smtp.gmail.com` y `465` |
| Username | la cuenta que envía |
| Password | una **contraseña de aplicación**, no la del correo |
| Sender email | la misma cuenta del Username |

> Sin esto el envío igual funciona, pero lo hace el servidor de Supabase: tiene
> un límite bajo de correos por hora y cae en spam seguido. Sirve para probar,
> no para uso diario.

> El puerto 465 habla TLS desde el saludo. Si hay una casilla de cifrado, va
> activada: un 465 sin TLS no existe, y el error que devuelve —"Greeting never
> received"— no lo dice.

**Authentication → URL Configuration → Redirect URLs**, agregar:

```
https://TU-DOMINIO/nueva-clave
```

Sin eso Supabase rechaza el enlace por apuntar a una dirección no autorizada: el
correo llega y no sirve.

Y una condición que no es de configuración: **cada usuario necesita su correo
cargado**, y que sea uno al que de verdad entre. Si dos comparten uno, o si
alguien tiene el de la empresa que solo lee el dueño, la recuperación vuelve a
depender de quien administra.

---

## Actualizar

```bash
/opt/smartolt/deploy/actualizar.sh
```

Trae los cambios, reinstala dependencias **solo si cambiaron**, compila,
reinicia el middleware y termina mostrando el `/api/health`, que es lo único que
dice si quedó utilizable.

> **No uses `npm run build` suelto.** El frontend necesita más memoria de la que
> Node se da por defecto, y el script es el que se la da. Sin eso, en una
> máquina chica el build muere con `JavaScript heap out of memory` y cincuenta
> líneas de volcado de V8 que no dicen cuál es el problema.

---

## Comandos útiles

```bash
systemctl status smartolt-middleware      # estado
journalctl -u smartolt-middleware -f      # logs en vivo
systemctl restart smartolt-middleware     # reiniciar

curl -s http://127.0.0.1:4000/api/health  # qué le falta al middleware

systemctl status openvpn-server@server    # estado de la VPN
cat /var/log/openvpn/status.log           # quién está conectado
ufw status                                # reglas del firewall
```

---

## Problemas conocidos

Todos estos aparecieron en la primera instalación real y están resueltos en los
scripts. Se documentan porque el síntoma no siempre lleva a la causa.

**El instalador termina sin decir nada, sin instalar nada.**
Pasaba con una versión vieja del script, en un servidor limpio: un `grep` que no
encontraba nada hacía fallar la tubería y `set -e` mataba el script en silencio.
Si te pasa, actualizá el repositorio.

**`git pull` no trae los cambios y parece funcionar.**
Si hiciste `chmod +x` a mano sobre los scripts, git los ve modificados y se
niega a pisarlos. Avisa, pero el mensaje se pierde entre el resto de la salida.
Solución: `git checkout -- deploy/` y volver a hacer pull.

**`fatal: detected dubious ownership in repository`.**
El instalador hace `chown` del proyecto al usuario de servicio, y las
actualizaciones corren como root. Una vez:
```bash
git config --global --add safe.directory /opt/smartolt
```

**`JavaScript heap out of memory` al compilar.**
Node fija su techo de heap según la RAM **física**, y el swap no mueve ese
número. Hacen falta las dos cosas: swap *y* `--max-old-space-size`.
`install-app.sh` y `actualizar.sh` ya lo hacen; un `npm run build` a mano, no.

**El sitio muestra la página de bienvenida de nginx**, o
`conflicting server name "_"`.
Quedaron dos sitios declarando `server_name _` y nginx ignora uno. Mirá si hay
un `default` en `/etc/nginx/sites-enabled/` y borralo.

**Error 521 al entrar por HTTPS.**
El dominio está en Cloudflare con la nube naranja y tu nginx no escucha en 443.
Ver el paso 4.

**El navegador bloquea las llamadas a la API.**
`VITE_API_URL` o `CORS_ORIGIN` quedaron con la dirección vieja. Se ve en la
consola del navegador (F12) como *blocked by CORS policy*. Corregí los dos
`.env` y corré `actualizar.sh`.

**El técnico no puede sacar la foto ni compartir ubicación.**
Estás entrando por HTTP. El navegador solo da cámara y GPS sobre HTTPS.

**La barra de arriba dice «middleware no responde» y no se puede cambiar una
contraseña, pero `curl` al `/api/health` del servidor funciona.**
`VITE_API_URL` quedó con `/api` al final. El frontend ya agrega `/api/...` a
cada llamada, así que salen a `/api/api/...` y dan 404. Se ve en la consola del
navegador (F12 → Red) como un 404 con la ruta repetida. Tiene que ser solo el
dominio:
```bash
sed -i "s|^VITE_API_URL=.*|VITE_API_URL=https://crm.tudominio.com|" /opt/smartolt/web/.env
/opt/smartolt/deploy/actualizar.sh
```
`CORS_ORIGIN`, en cambio, sí es solo el dominio y nunca lleva `/api`.

---

## Convivir con otro sistema

Se puede, pero **no es por donde conviene empezar**. Si el servidor ya corre
algo que factura o da servicio a clientes:

- **El instalador se niega** si hay otro servicio en 80 o 443. Es a propósito.
- **No uses `--firewall`.** Levanta un "denegar por defecto" y si el otro
  sistema tiene un OpenVPN, le cortás todos los túneles de golpe — y a los
  routers sin IP pública ya no los alcanzás para arreglarlo.
- Para publicar los dos hay que darle a cada uno su `server_name` y que el
  servidor web existente haga de proxy hacia `127.0.0.1:4000`. Eso es
  configuración a mano y estos scripts no la hacen.

Un servidor aparte cuesta unos pocos dólares al mes y te deja apagar la máquina
si algo sale mal. Para una primera puesta en marcha, es la decisión correcta.
