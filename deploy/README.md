# Despliegue en un VPS

Cómo dejar el sistema corriendo en un VPS Debian, junto con el concentrador
OpenVPN que da acceso a los MikroTik sin IP pública.

```
                            VPS (Debian)
   ┌───────────────────────────────────────────────────────────┐
   │  nginx  :80/:443                                          │
   │    ├── /            → web (archivos estáticos)            │
   │    └── /api         → middleware (Node, :4000)            │
   │                                                            │
   │  OpenVPN server :1194/tcp                                 │
   │    └── 10.8.0.0/24 → un túnel por MikroTik                │
   └───────────────────────────────────────────────────────────┘
              │                              │
              │ internet                     │ túneles
              ▼                              ▼
        Supabase (nube)            MikroTik 10.8.0.6, .7, .8…
                                      └── OLTs en la LAN
```

El middleware queda **dentro** de la red de la VPN, así que alcanza a todos los
routers —y a las OLTs detrás de ellos— sin exponer ningún puerto a internet.

---

## Antes de empezar

Si estás migrando desde otro VPS, leé esto primero:

- Al cambiar de VPS **cambia la IP pública**, y cada MikroTik tiene esa IP en
  `connect-to`. Si los túneles se caen, a los routers sin IP pública **no los
  alcanzás para reconfigurarlos**.
- Solución: pasá la **Reserved IP** de DigitalOcean al VPS nuevo, o —mejor a
  futuro— usá un **dominio** en `connect-to` en vez de la IP.
- Levantá el VPS nuevo en paralelo y dá de baja el viejo recién cuando el nuevo
  esté probado.

**Requisitos del VPS:** Debian 12, 1 vCPU, 2 GB RAM, 25 GB. Con eso sobra.

---

## 1. Preparar el servidor

Como root:

```bash
apt update && apt install -y git
git clone <URL-DE-TU-REPO> /opt/smartolt
cd /opt/smartolt/deploy
chmod +x *.sh
```

Si no tenés el proyecto en un repositorio, subilo con `scp` a `/opt/smartolt`.

---

## 2. Instalar la aplicación

```bash
./install-app.sh
```

Instala Node 22, nginx, crea el usuario de servicio, instala dependencias,
compila el frontend y deja el middleware corriendo con systemd.

Al terminar te pide completar los `.env`:

```bash
nano /opt/smartolt/middleware/.env    # SUPABASE_URL, SERVICE_ROLE_KEY, CREDENTIALS_KEY
nano /opt/smartolt/web/.env           # VITE_SUPABASE_URL, ANON_KEY, VITE_API_URL
```

> `VITE_API_URL` tiene que ser la URL pública, por ejemplo
> `https://gestion.tuempresa.com/api` — no `localhost`.

Después:

```bash
cd /opt/smartolt/web && npm run build
systemctl restart smartolt-middleware
```

---

## 3. Instalar el concentrador OpenVPN

```bash
./openvpn-server.sh
```

Te pregunta la IP o dominio público y el puerto. Deja el servidor escuchando en
**TCP** —RouterOS trabaja mejor así— con la red que elijas y IPs fijas por
cliente.

---

## 4. Agregar un MikroTik

Uno por router:

```bash
./agregar-cliente-vpn.sh cliente01 10.8.0.11
```

Genera el certificado, fija la IP y **te imprime el script listo para pegar** en
el MikroTik, más los archivos a subir al router.

---

## 5. Cargar el router en la aplicación

En la web: **MikroTik → Nuevo router**

| Campo | Valor |
|---|---|
| IP | la de la VPN (`10.8.0.11`) |
| Modo | API de RouterOS |
| Puerto | el que uses en `/ip service` |

El middleware está en la misma red que el túnel, así que llega directo.

---

## Comandos útiles

```bash
systemctl status smartolt-middleware      # estado
journalctl -u smartolt-middleware -f      # logs en vivo
systemctl restart smartolt-middleware     # reiniciar

systemctl status openvpn-server@server    # estado de la VPN
cat /var/log/openvpn/status.log           # quién está conectado
```

---

## Actualizar el sistema

```bash
cd /opt/smartolt
git pull
npm --prefix middleware install
npm --prefix web install && npm --prefix web run build
systemctl restart smartolt-middleware
```

---

## Nota

Estos scripts están escritos para Debian 12 pero **no fueron probados contra un
VPS real**. Revisalos antes de correrlos en producción; cada uno hace lo que dice
su encabezado y son cortos a propósito para que se puedan leer enteros.


---

## Las redes detrás de cada MikroTik

`agregar-cliente-vpn.sh` le da al router su IP fija del túnel, y con eso el VPS
ya le habla. **Eso no alcanza para la OLT**: la OLT está en la LAN de ese
router, y el VPS no sabe que esa red existe.

```
  VPS ──túnel──► MikroTik 10.8.0.11
                   └── LAN 10.11.105.0/24 ──► OLT 10.11.105.2
                        ▲
                        └─ para llegar acá hace falta este paso
```

Se publica así:

```bash
./agregar-red-cliente.sh laMana2 10.11.105.0/24
```

El script escribe las dos directivas que hacen falta —`route` en la
configuración del servidor y `iroute` en el archivo del cliente— y reinicia
OpenVPN. Con una sola de las dos no funciona, y el síntoma es idéntico al de no
haber hecho nada: no hay respuesta.

Del lado del MikroTik, si tenés filtro en `forward`, dejá pasar lo que llega
por la interfaz de la VPN.

Sin argumentos, el script lista los clientes dados de alta y las redes ya
publicadas.

---

## Cambiar la red del túnel

`10.8.0.0/24` es el valor por defecto y funciona en la mayoría de las
instalaciones. Pero es un rango privado como cualquier otro: si el ISP donde
instalás ya lo usa, hay dos caminos hacia la misma red y los paquetes se van por
el equivocado. El síntoma es que *a veces anda*, que es el peor de todos.

**No hay que editar ningún archivo.** `openvpn-server.sh` lo pregunta al
instalar:

```
  Red privada para el túnel de gestión. Cada MikroTik recibe una IP de acá.
  Tiene que ser una red que NO uses en ninguna parte de tu infraestructura.
Red VPN [10.8.0.0/24]: 10.66.0.0/24
```

Y antes de aceptarla comprueba tres cosas:

- que sea **privada** (10.x, 172.16-31.x o 192.168.x)
- que sea la dirección **de red** y no la de un equipo
- que **no se pise** con nada que ese servidor ya tenga ruteado

Lo elegido queda en `/etc/openvpn/smartolt.env`, y los otros dos scripts lo
leen de ahí: no hay un segundo lugar donde acordarse de cambiarlo.

> En un servidor instalado antes de que esto fuera configurable, el env no tiene
> el prefijo. Los scripts asumen `/24`, que es lo que era entonces, así que
> siguen funcionando sin reinstalar nada.
