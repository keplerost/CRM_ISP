#!/usr/bin/env bash
#
# Instala el concentrador OpenVPN: el punto al que se conectan los MikroTik que
# no tienen IP pública. Cada router recibe una IP fija de la red de gestión —
# 10.8.0.0/24 por defecto, se elige al instalar— y el
# middleware —que corre en este mismo VPS— los alcanza directo.
#
# Va sobre TCP a propósito: el cliente OpenVPN de RouterOS trabaja mucho mejor
# así que sobre UDP.
#
# Correr como root:
#   ./openvpn-server.sh
#
set -euo pipefail

# La red del túnel se pregunta al instalar. Ver el bloque "Red de gestión".
RED_VPN=""
MASCARA=""
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

# ── Red de gestión ───────────────────────────────────────────────────────────
#
# 10.8.0.0/24 es el valor de siempre de OpenVPN y funciona en la mayoría de las
# instalaciones. Pero es un rango privado como cualquier otro, y hay ISPs que ya
# lo usan para otra cosa. Si choca, el VPS tiene dos caminos hacia la misma red
# y los paquetes se van por la equivocada — el síntoma es que "a veces anda", que
# es el peor de todos.
#
# Por eso se pregunta, y por eso se comprueba contra lo que este servidor ya
# tiene ruteado en vez de confiar en que quien instala se acuerde de mirarlo.

mascara_de() {
    local p=$1
    local m=$(( 0xFFFFFFFF ^ ((1 << (32 - p)) - 1) ))
    printf '%d.%d.%d.%d' $(( (m >> 24) & 255 )) $(( (m >> 16) & 255 )) $(( (m >> 8) & 255 )) $(( m & 255 ))
}

a_entero() { IFS=. read -r a b c d <<< "$1"; echo $(( (a << 24) + (b << 16) + (c << 8) + d )); }

echo
echo "  Red privada para el túnel de gestión. Cada MikroTik recibe una IP de acá."
echo "  Tiene que ser una red que NO uses en ninguna parte de tu infraestructura."
read -rp "Red VPN [10.8.0.0/24]: " RED_CIDR
RED_CIDR=${RED_CIDR:-10.8.0.0/24}

[[ "$RED_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || {
    echo "Va en formato red/prefijo. Ej: 10.8.0.0/24"; exit 1; }

RED_VPN="${RED_CIDR%/*}"
PREFIJO="${RED_CIDR#*/}"
[[ "$PREFIJO" -ge 16 && "$PREFIJO" -le 29 ]] || {
    echo "El prefijo tiene que estar entre /16 y /29."
    echo "Con /30 no entran ni dos routers; más ancho que /16 es desperdiciar rango."
    exit 1; }
MASCARA=$(mascara_de "$PREFIJO")

# Que sea privada. Una red pública acá le robaría el tráfico a internet.
case "$RED_VPN" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) : ;;
    *) echo "Tiene que ser una red privada (10.x, 172.16-31.x o 192.168.x)."; exit 1 ;;
esac

# Que sea la dirección de red y no la de un equipo.
IFS=. read -r o1 o2 o3 o4 <<< "$RED_VPN"
IFS=. read -r m1 m2 m3 m4 <<< "$MASCARA"
RED_OK="$(( o1 & m1 )).$(( o2 & m2 )).$(( o3 & m3 )).$(( o4 & m4 ))"
[[ "$RED_VPN" == "$RED_OK" ]] || {
    echo "$RED_VPN no es la dirección de red de un /$PREFIJO. ¿Quisiste decir $RED_OK/$PREFIJO?"
    exit 1; }

# Y que no pise nada que este servidor ya conozca.
INICIO=$(a_entero "$RED_VPN")
FIN=$(( INICIO + 2 ** (32 - PREFIJO) - 1 ))
CHOQUE=""
while read -r destino; do
    [[ "$destino" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || continue
    o="${destino%/*}"; pp="${destino#*/}"
    oi=$(a_entero "$o"); of=$(( oi + 2 ** (32 - pp) - 1 ))
    (( INICIO <= of && oi <= FIN )) && CHOQUE="$CHOQUE $destino"
done < <(ip -4 route show 2>/dev/null | awk '{print $1}')

if [[ -n "$CHOQUE" ]]; then
    echo
    echo "  La red $RED_CIDR se pisa con lo que este servidor ya tiene ruteado:"
    for c in $CHOQUE; do echo "      $c"; done
    echo
    echo "  Elegí otra. Con dos caminos a la misma red, los paquetes se van por"
    echo "  el equivocado y el síntoma es que 'a veces anda'."
    exit 1
fi
# La .1 es del servidor y la .11 es la primera sugerida para un router: se
# calculan sobre la red elegida en vez de escribirlas a mano, que es lo que
# hacía que el resumen dijera 10.8.0.1 aunque la red fuera otra.
IP_VPS="${o1}.${o2}.${o3}.$(( o4 + 1 ))"
IP_EJEMPLO="${o1}.${o2}.${o3}.$(( o4 + 11 ))"
ok "red de gestión $RED_CIDR"

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
PREFIJO=$PREFIJO
IP_VPS=$IP_VPS
EOF

azul "Concentrador listo"
cat <<EOF

  Servidor:  $PUBLICO:$PUERTO/tcp
  Red VPN:   $RED_VPN/$PREFIJO    (este VPS es $IP_VPS)

  Para agregar un MikroTik:
      ./agregar-cliente-vpn.sh cliente01 $IP_EJEMPLO

  Quién está conectado:
      cat /var/log/openvpn/status.log

EOF
