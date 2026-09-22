#!/usr/bin/env bash
#
# Da de alta un MikroTik en el concentrador VPN.
#
#   ./agregar-cliente-vpn.sh <nombre> <ip-fija>
#   ./agregar-cliente-vpn.sh cliente01 10.8.0.11
#
# Genera el certificado, le fija la IP y deja listos:
#   - los archivos a subir al router (Files → arrastrar por WinBox)
#   - el script para pegar en la terminal del MikroTik
#
set -euo pipefail

DIR_PKI=/etc/openvpn/pki
DIR_CCD=/etc/openvpn/ccd
SALIDA=/root/clientes-vpn

azul() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }
[[ -f /etc/openvpn/smartolt.env ]] || { echo "Primero corré openvpn-server.sh"; exit 1; }
# shellcheck source=/dev/null
source /etc/openvpn/smartolt.env

# Instalaciones anteriores a la red configurable no tienen estos dos campos en
# su env. Se completan con lo que era fijo entonces, así el script sigue
# funcionando en un servidor viejo sin obligar a reinstalar el concentrador.
PREFIJO=${PREFIJO:-24}
IP_VPS=${IP_VPS:-$(echo "$RED_VPN" | sed 's/\.0$/.1/')}

NOMBRE=${1:-}
IP_FIJA=${2:-}

if [[ -z "$NOMBRE" || -z "$IP_FIJA" ]]; then
    echo "Uso: $0 <nombre> <ip-fija>"
    echo "Ej:  $0 cliente01 10.8.0.11"
    echo
    echo "IPs ya asignadas:"
    grep -h ifconfig-push "$DIR_CCD"/* 2>/dev/null | awk '{print "  " $2}' | sort -V || echo "  (ninguna)"
    exit 1
fi

[[ "$NOMBRE" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "El nombre solo puede tener letras, números, guion y guion bajo"; exit 1; }
[[ -f "$DIR_PKI/pki/issued/$NOMBRE.crt" ]] && { echo "Ya existe un cliente llamado '$NOMBRE'"; exit 1; }

if grep -qs "ifconfig-push $IP_FIJA " "$DIR_CCD"/* 2>/dev/null; then
    echo "La IP $IP_FIJA ya está asignada a otro cliente"
    exit 1
fi

azul "Generando certificado para $NOMBRE"
cd "$DIR_PKI"
export EASYRSA_BATCH=1
./easyrsa gen-req "$NOMBRE" nopass >/dev/null
./easyrsa sign-req client "$NOMBRE" >/dev/null
ok "certificado firmado"

# La IP fija hace que el router sea siempre alcanzable en la misma dirección,
# que es la que se carga en la aplicación.
echo "ifconfig-push $IP_FIJA 255.255.255.0" > "$DIR_CCD/$NOMBRE"
ok "IP fija $IP_FIJA"

mkdir -p "$SALIDA/$NOMBRE"
cp "$DIR_PKI/pki/ca.crt"                  "$SALIDA/$NOMBRE/ca.crt"
cp "$DIR_PKI/pki/issued/$NOMBRE.crt"      "$SALIDA/$NOMBRE/$NOMBRE.crt"
cp "$DIR_PKI/pki/private/$NOMBRE.key"     "$SALIDA/$NOMBRE/$NOMBRE.key"
chmod 600 "$SALIDA/$NOMBRE"/*
ok "archivos en $SALIDA/$NOMBRE"

SCRIPT="$SALIDA/$NOMBRE/mikrotik-$NOMBRE.rsc"
cat > "$SCRIPT" <<EOF
# ============================================================
#  VPN de gestión — $NOMBRE
#  Pegar en la terminal del MikroTik (New Terminal en WinBox).
#
#  ANTES: subir estos archivos al router (Files → arrastrar)
#     ca.crt
#     $NOMBRE.crt
#     $NOMBRE.key
# ============================================================

/certificate import file-name=ca.crt passphrase=""
/certificate import file-name=$NOMBRE.crt passphrase=""
/certificate import file-name=$NOMBRE.key passphrase=""

/interface ovpn-client
add name=vpn-gestion connect-to=$PUBLICO port=$PUERTO protocol=tcp mode=ip \\
    user=$NOMBRE password="" certificate=$NOMBRE.crt_0 \\
    cipher=aes256-cbc auth=sha256 \\
    add-default-route=no disabled=no comment="Gestion SmartOLT"

# Permitir la API solo desde la VPN. Cambiá 8728 si usás otro puerto.
/ip service set api address=${RED_VPN}/${PREFIJO}

/ip firewall filter
add chain=input src-address=${RED_VPN}/${PREFIJO} protocol=tcp dst-port=8728 \\
    action=accept comment="API desde VPN de gestion" place-before=0

# ============================================================
#  add-default-route=no es CRITICO: sin eso el router manda TODO
#  el trafico de los clientes por la VPN y les corta el servicio.
#
#  Verificar:
#     /interface ovpn-client print status
#     /ping ${IP_VPS}
#
#  En la aplicacion, cargar este router con:
#     IP:     $IP_FIJA
#     Modo:   API de RouterOS
#     Puerto: el que tengas en /ip service
# ============================================================
EOF
ok "script en $SCRIPT"

azul "Cliente $NOMBRE listo — IP $IP_FIJA"
cat <<EOF

  1. Copiá los certificados a tu PC:
       scp -r root@$PUBLICO:$SALIDA/$NOMBRE ./

  2. Subí al MikroTik (WinBox → Files): ca.crt, $NOMBRE.crt, $NOMBRE.key

  3. Pegá el contenido de mikrotik-$NOMBRE.rsc en New Terminal

  4. Verificá desde este VPS:
       ping $IP_FIJA

  5. Cargalo en la aplicación con IP $IP_FIJA

EOF
