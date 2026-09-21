#!/usr/bin/env bash
#
# Instala el concentrador OpenVPN: el punto al que se conectan los MikroTik que
# no tienen IP pública. Cada router recibe una IP fija de 10.8.0.0/24 y el
# middleware —que corre en este mismo VPS— los alcanza directo.
#
# Va sobre TCP a propósito: el cliente OpenVPN de RouterOS trabaja mucho mejor
# así que sobre UDP.
#
# Correr como root:
#   ./openvpn-server.sh
#
set -euo pipefail

RED_VPN="10.8.0.0"
MASCARA="255.255.255.0"
DIR_PKI=/etc/openvpn/pki
DIR_CCD=/etc/openvpn/ccd

azul() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }

if [[ -f /etc/openvpn/server/server.conf ]]; then
    echo "Ya hay un servidor OpenVPN configurado en /etc/openvpn/server/server.conf"
    echo "Si querés rehacerlo, borrá /etc/openvpn y volvé a correr este script."
    exit 1
fi

read -rp "IP pública o dominio del VPS: " PUBLICO
[[ -n "$PUBLICO" ]] || { echo "Hace falta la IP o el dominio"; exit 1; }
read -rp "Puerto [1194]: " PUERTO
PUERTO=${PUERTO:-1194}

azul "1/5  Paquetes"
apt-get update -qq
apt-get install -y -qq openvpn easy-rsa >/dev/null
ok "openvpn y easy-rsa"

azul "2/5  Autoridad certificadora"
make-cadir "$DIR_PKI" >/dev/null 2>&1 || true
cd "$DIR_PKI"

export EASYRSA_BATCH=1
export EASYRSA_REQ_CN="smartolt-vpn-ca"
./easyrsa init-pki >/dev/null
./easyrsa build-ca nopass >/dev/null
./easyrsa gen-req server nopass >/dev/null
./easyrsa sign-req server server >/dev/null
./easyrsa gen-dh >/dev/null
openvpn --genkey secret "$DIR_PKI/pki/ta.key"
ok "CA, certificado del servidor y clave TLS"

azul "3/5  Configuración del servidor"
mkdir -p "$DIR_CCD" /var/log/openvpn /etc/openvpn/server

cat > /etc/openvpn/server/server.conf <<EOF
# Concentrador VPN del Taller SmartOLT.
# TCP porque el cliente OpenVPN de RouterOS funciona mejor así.
port $PUERTO
proto tcp
dev tun

ca   $DIR_PKI/pki/ca.crt
cert $DIR_PKI/pki/issued/server.crt
key  $DIR_PKI/pki/private/server.key
dh   $DIR_PKI/pki/dh.pem
tls-auth $DIR_PKI/pki/ta.key 0

server $RED_VPN $MASCARA
topology subnet

# IPs fijas por router: cada archivo de acá lleva su ifconfig-push.
client-config-dir $DIR_CCD
# Permite rutas hacia las LAN detrás de cada MikroTik (las OLTs, por ejemplo).
client-to-client

# NO se empuja ruta por defecto: el MikroTik solo manda por el túnel el tráfico
# de gestión. Empujarla desviaría el tráfico de los clientes finales.

keepalive 10 60
persist-key
persist-tun

# RouterOS 7 negocia AES-256-CBC sin problema.
cipher AES-256-CBC
auth SHA256
data-ciphers AES-256-CBC:AES-256-GCM

user nobody
group nogroup

status /var/log/openvpn/status.log
log-append /var/log/openvpn/openvpn.log
verb 3
EOF
ok "server.conf"

azul "4/5  Ruteo y firewall"
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-smartolt-vpn.conf
sysctl -p /etc/sysctl.d/99-smartolt-vpn.conf >/dev/null

if command -v ufw >/dev/null; then
    ufw allow "$PUERTO"/tcp >/dev/null
    ok "puerto $PUERTO/tcp abierto"
fi

azul "5/5  Arrancar el servicio"
systemctl enable --now openvpn-server@server >/dev/null
sleep 2
systemctl is-active --quiet openvpn-server@server \
    && ok "openvpn-server@server corriendo" \
    || { echo "  El servicio no arrancó. Mirá: journalctl -u openvpn-server@server -n 50"; exit 1; }

# Se guarda para que agregar-cliente-vpn.sh sepa a dónde apuntar a los routers.
cat > /etc/openvpn/smartolt.env <<EOF
PUBLICO=$PUBLICO
PUERTO=$PUERTO
RED_VPN=$RED_VPN
EOF

azul "Concentrador listo"
cat <<EOF

  Servidor:  $PUBLICO:$PUERTO/tcp
  Red VPN:   $RED_VPN/24    (este VPS es 10.8.0.1)

  Para agregar un MikroTik:
      ./agregar-cliente-vpn.sh cliente01 10.8.0.11

  Quién está conectado:
      cat /var/log/openvpn/status.log

EOF
