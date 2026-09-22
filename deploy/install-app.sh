#!/usr/bin/env bash
#
# Instala el sistema en un VPS Debian 12: Node, nginx, el middleware como
# servicio de systemd y el frontend compilado como archivos estáticos.
#
# Correr como root, desde /opt/smartolt/deploy:
#   ./install-app.sh                  instala sin tocar el firewall
#   ./install-app.sh --firewall       además configura ufw (leer abajo)
#
# ── Por qué el firewall es opcional y antes no lo era ──
#
# La versión anterior terminaba con `ufw --force enable` permitiendo solo SSH y
# HTTP/HTTPS. En un servidor vacío eso está bien. En uno que ya trabaja, levanta
# un firewall que bloquea TODO lo demás — y "todo lo demás" puede ser el
# OpenVPN por el que entran los routers sin IP pública.
#
# Ese caso no es hipotético: se probó contra un VPS con MikroWISP y OpenVPN en
# el 1194, y esta línea habría cortado todos los túneles a la vez. Los routers
# sin IP pública solo se alcanzan POR ese túnel, así que recuperarlos habría
# sido ir físicamente a cada uno.
#
# Ahora el firewall no se toca salvo que se pida, y cuando se pide se permiten
# primero todos los puertos que ya estaban escuchando.
#
set -euo pipefail

RAIZ=/opt/smartolt
USUARIO=smartolt
PUERTO_API=4000

FIREWALL=no
for arg in "$@"; do
    case "$arg" in
        --firewall) FIREWALL=si ;;
        *) echo "Opción desconocida: $arg"; exit 1 ;;
    esac
done

azul() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }
error() { printf '\n\033[1;31m%s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }
[[ -d "$RAIZ/middleware" ]] || { echo "No encuentro $RAIZ/middleware. ¿Copiaste el proyecto a $RAIZ?"; exit 1; }

# ── 0. Mirar antes de tocar ──────────────────────────────────────────────────
#
# Todo lo que pueda hacer daño se comprueba ACÁ, antes de instalar el primer
# paquete. Un instalador que falla a la mitad deja un servidor peor que como lo
# encontró, y en uno que está trabajando eso es una salida de servicio.

azul "0/6  Revisando el servidor"

# `ss` puede no estar en una imagen mínima; sin él no se puede comprobar nada,
# y seguir a ciegas es justamente lo que se quiere evitar.
command -v ss >/dev/null || { apt-get update -qq && apt-get install -y -qq iproute2 >/dev/null; }

# El `|| true` del final NO es adorno.
#
# Con `set -euo pipefail`, un `grep` que no encuentra nada devuelve 1, eso hace
# fallar la tubería entera, y la asignación que la usa corta el script SIN
# IMPRIMIR NADA. El síntoma es el peor posible: el instalador dice "Revisando el
# servidor" y vuelve al prompt como si hubiera terminado bien.
#
# Y el caso en que no encuentra nada es justamente el bueno: un servidor limpio,
# con el puerto libre. O sea que esta comprobación —escrita para que el
# instalador fuera seguro en un servidor ocupado— rompía exactamente la
# instalación que venía a proteger. Pasó en el primer servidor donde se corrió.
quien_escucha() {
    ss -tlnpH "sport = :$1" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | sort -u | tr '\n' ' ' || true
}

# ¿Nginx estaba ANTES de que existiera este sistema en el servidor?
#
# No alcanza con `command -v nginx`: si una corrida anterior de este mismo
# instalador falló después de instalarlo —se quedó sin memoria compilando, por
# ejemplo— la siguiente lo encuentra ahí y lo trata como ajeno. Entonces no le
# saca el sitio por defecto de Debian, quedan dos `server_name _` peleando, y
# gana el de Debian: la IP muestra la página de bienvenida en vez del sistema.
#
# Pasó en la primera instalación real. La marca distingue los dos casos.
MARCA_NGINX=/etc/nginx/.instalado-por-smartolt
NGINX_YA=no
if command -v nginx >/dev/null && [[ ! -f "$MARCA_NGINX" ]]; then
    NGINX_YA=si
fi

for puerto in 80 443; do
    duenio="$(quien_escucha "$puerto")"
    if [[ -n "$duenio" && "$duenio" != *nginx* ]]; then
        error "El puerto $puerto ya lo está usando: $duenio"
        cat <<EOF

  Este instalador pone nginx en 80 y 443, y ahí ya hay otro servicio.
  Instalarlo igual no lo reemplaza: nginx no podría arrancar, y este
  servidor quedaría a medio configurar.

  Opciones:
    · Instalar el sistema en OTRO servidor (lo más simple y lo recomendado
      para una primera puesta en marcha).
    · Convivir: dejar el servicio que ya está en 80/443 y publicar este por
      un subdominio, con el servidor web que ya existe haciendo de proxy
      hacia el middleware en 127.0.0.1:$PUERTO_API. Eso es configuración a
      mano y no la hace este script.

EOF
        exit 1
    fi
done
ok "puertos 80 y 443 disponibles"

# El OpenVPN no lo toca este instalador, pero sí lo tocaría el firewall.
# Mismo cuidado que arriba: si no hay nada que listar, que la variable quede
# vacía en vez de matar el script.
PUERTOS_EN_USO="$(ss -tulnH 2>/dev/null | awk '{print $5}' | sed 's/.*://' | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ' || true)"
if ss -tulnH 2>/dev/null | grep -q ':1194'; then
    aviso "Hay un OpenVPN escuchando en 1194. No se va a tocar."
fi

# ── 1. Paquetes ──────────────────────────────────────────────────────────────

azul "1/6  Paquetes base"
apt-get update -qq
# `ufw` solo si se va a usar: instalarlo "por las dudas" deja en el servidor una
# herramienta que el próximo que pase puede habilitar sin saber lo de arriba.
PAQUETES="curl ca-certificates gnupg nginx"
[[ "$FIREWALL" == si ]] && PAQUETES="$PAQUETES ufw"
# shellcheck disable=SC2086
apt-get install -y -qq $PAQUETES >/dev/null
# Queda constancia de que nginx lo puso este instalador, para que una corrida
# futura sepa que el sitio por defecto es suyo y puede sacarlo.
if [[ "$NGINX_YA" == no ]]; then
    mkdir -p /etc/nginx && touch "$MARCA_NGINX"
fi
ok "nginx y utilidades"

azul "2/6  Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v)"

azul "3/6  Usuario de servicio"
if ! id "$USUARIO" &>/dev/null; then
    useradd --system --home "$RAIZ" --shell /usr/sbin/nologin "$USUARIO"
fi
ok "usuario $USUARIO"

azul "4/6  Dependencias y compilación"
# ── Memoria para compilar el frontend ────────────────────────────────────────
#
# Es lo que más memoria pide de todo el despliegue: el bundle principal son 2,6
# MB y Vite necesita varias veces eso para armarlo.
#
# En un droplet de 1 GB muere con "JavaScript heap out of memory" a los 475 MB.
# El mensaje asusta —cincuenta líneas de volcado de V8— pero la causa es simple:
# Node fija su techo de heap en aproximadamente la mitad de la RAM FÍSICA.
#
# Por eso hacen falta LAS DOS COSAS:
#
#   · swap                   memoria de respaldo para el sistema
#   · --max-old-space-size   sube el techo de V8, que el swap solo NO mueve
#
# Con swap y sin el flag, V8 sigue cortando en 475 MB sin tocar el swap. Con el
# flag y sin swap, el sistema se queda sin memoria de verdad y mata el proceso.
# Media solución no sirve de nada acá.

RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
ok "memoria: ${RAM_MB} MB de RAM, ${SWAP_MB} MB de swap"

if (( RAM_MB + SWAP_MB < 2600 )); then
    if [[ -f /swapfile ]]; then
        aviso "Ya hay /swapfile y la memoria sigue siendo justa."
    else
        aviso "Poca memoria para compilar: se crea un swap de 2 GB."
        # `fallocate` falla en algunos sistemas de archivos; `dd` siempre anda.
        fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
        chmod 600 /swapfile
        mkswap /swapfile >/dev/null
        swapon /swapfile
        # Permanente: el swap no es solo para compilar. Con 1 GB de RAM, el
        # middleware y nginx también agradecen el colchón — y si se perdiera al
        # reiniciar habría que acordarse de rehacerlo antes de cada
        # actualización, que es justo lo que nadie hace.
        grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
        SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
        ok "swap activo (${SWAP_MB} MB), y queda puesto al reiniciar"
    fi
fi

# El techo de V8: dos tercios de lo disponible, con un piso de 1536 MB que es lo
# que este bundle necesita para cerrar.
TECHO=$(( (RAM_MB + SWAP_MB) * 2 / 3 ))
(( TECHO < 1536 )) && TECHO=1536
export NODE_OPTIONS="--max-old-space-size=$TECHO"
ok "techo de memoria de Node: ${TECHO} MB"

# Los .env se crean vacíos si no existen: el instalador no inventa credenciales.
[[ -f "$RAIZ/middleware/.env" ]] || cp "$RAIZ/middleware/.env.example" "$RAIZ/middleware/.env"
[[ -f "$RAIZ/web/.env" ]] || cp "$RAIZ/web/.env.example" "$RAIZ/web/.env"

npm --prefix "$RAIZ/middleware" install --omit=dev --no-audit --no-fund
npm --prefix "$RAIZ/web" install --no-audit --no-fund
npm --prefix "$RAIZ/web" run build
chown -R "$USUARIO:$USUARIO" "$RAIZ"
chmod 600 "$RAIZ/middleware/.env"
ok "dependencias instaladas y frontend compilado"

azul "5/6  Servicio systemd"
install -m 644 "$RAIZ/deploy/smartolt-middleware.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now smartolt-middleware >/dev/null
ok "smartolt-middleware habilitado"

# ── 6. nginx ─────────────────────────────────────────────────────────────────

azul "6/6  nginx"
install -m 644 "$RAIZ/deploy/nginx-smartolt.conf" /etc/nginx/sites-available/smartolt
ln -sf /etc/nginx/sites-available/smartolt /etc/nginx/sites-enabled/smartolt

# El sitio por defecto se saca SOLO si nginx lo instalamos nosotros recién.
#
# Si nginx ya estaba, ese archivo puede ser el que sirve otra cosa en este
# servidor, y borrarlo la apaga. Cuando ya estaba, se avisa y se deja: dos
# `server_name _` conviven —gana el primero que nginx cargue— y eso es un
# problema de configuración, no una salida de servicio.
if [[ "$NGINX_YA" == no ]]; then
    rm -f /etc/nginx/sites-enabled/default
elif [[ -e /etc/nginx/sites-enabled/default ]]; then
    aviso "nginx ya estaba con un sitio 'default' y NO se tocó."
    echo "         Los dos declaran server_name _, así que nginx ignora uno de los"
    echo "         dos y probablemente gane el que ya estaba. Si esta máquina es"
    echo "         solo para el sistema, sacalo:"
    echo "             rm /etc/nginx/sites-enabled/default && systemctl reload nginx"
fi

nginx -t && systemctl reload nginx
ok "nginx configurado"

# ── 7. Firewall, solo si se pidió ────────────────────────────────────────────

if [[ "$FIREWALL" == si ]]; then
    azul "Firewall"
    aviso "Se van a permitir los puertos que YA estaban escuchando, además de SSH y HTTP/HTTPS."
    echo "         En uso ahora: $PUERTOS_EN_USO"
    echo

    ufw allow OpenSSH >/dev/null
    ufw allow 'Nginx Full' >/dev/null

    # Lo que ya estaba andando se permite antes de encender nada. Encender un
    # "denegar por defecto" sin esto es cortar la rama sobre la que se está
    # sentado: el propio SSH, el OpenVPN, el correo, lo que hubiera.
    for p in $PUERTOS_EN_USO; do
        ufw allow "$p" >/dev/null 2>&1 || true
    done

    ufw --force enable >/dev/null
    ok "firewall activo, conservando lo que ya escuchaba"
else
    aviso "El firewall NO se tocó. Si este servidor es solo para el sistema, corré:"
    echo "         ./install-app.sh --firewall"
fi

azul "Listo. Falta completar las credenciales:"
cat <<EOF

  1. nano $RAIZ/middleware/.env
       SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_KEY
       CORS_ORIGIN=https://TU-DOMINIO

  2. nano $RAIZ/web/.env
       VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
       VITE_API_URL=https://TU-DOMINIO/api      <-- la URL pública, no localhost
       VITE_DEMO_MODE=false

  3. Recompilar y reiniciar:
       npm --prefix $RAIZ/web run build
       systemctl restart smartolt-middleware

  4. HTTPS (recomendado):
       apt install -y certbot python3-certbot-nginx
       certbot --nginx -d TU-DOMINIO

  5. El concentrador VPN, solo si tenés routers sin IP pública:
       ./openvpn-server.sh

EOF

aviso "Mientras los .env tengan valores de ejemplo, /api/health te dice qué falta."
