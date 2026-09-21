#!/usr/bin/env bash
#
# Instala el sistema en un VPS Debian 12: Node, nginx, el middleware como
# servicio de systemd y el frontend compilado como archivos estáticos.
#
# Correr como root, desde /opt/smartolt/deploy:
#   ./install-app.sh
#
set -euo pipefail

RAIZ=/opt/smartolt
USUARIO=smartolt
PUERTO_API=4000

azul() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }
[[ -d "$RAIZ/middleware" ]] || { echo "No encuentro $RAIZ/middleware. ¿Copiaste el proyecto a $RAIZ?"; exit 1; }

azul "1/6  Paquetes base"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx ufw >/dev/null
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

azul "6/6  nginx y firewall"
install -m 644 "$RAIZ/deploy/nginx-smartolt.conf" /etc/nginx/sites-available/smartolt
ln -sf /etc/nginx/sites-available/smartolt /etc/nginx/sites-enabled/smartolt
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ok "nginx configurado"

ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
# El middleware NO se expone: solo se llega por nginx en /api.
ufw --force enable >/dev/null
ok "firewall activo (SSH y HTTP/HTTPS)"

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

  5. El concentrador VPN:
       ./openvpn-server.sh

EOF

aviso "Mientras los .env tengan valores de ejemplo, /api/health te dice qué falta."
