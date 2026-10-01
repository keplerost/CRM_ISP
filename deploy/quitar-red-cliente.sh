#!/usr/bin/env bash
#
# Lo contrario de agregar-red-cliente.sh: deja de publicar una red.
#
#   ./quitar-red-cliente.sh <nombre-vpn> <red/prefijo>
#   ./quitar-red-cliente.sh LOS_RIOS 10.10.7.0/24
#
# Saca el `iroute` del archivo del cliente y el `route` del servidor, y
# reinicia OpenVPN. Es para corregir una red cargada por error: una mal
# escrita no da ningún aviso, solo queda una ruta que no lleva a ningún lado.
#
set -euo pipefail

DIR_CCD=/etc/openvpn/ccd
CONF=/etc/openvpn/server/server.conf

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }

NOMBRE=${1:-}
RED_CIDR=${2:-}
if [[ -z "$NOMBRE" || -z "$RED_CIDR" ]]; then
    echo "Uso: $0 <nombre-vpn> <red/prefijo>"
    echo
    echo "Redes publicadas, por cliente:"
    for f in "$DIR_CCD"/*; do
        [[ -f "$f" ]] || continue
        awk -v n="$(basename "$f")" '/^iroute/ {print "  " n ": " $2 " " $3}' "$f"
    done
    exit 1
fi

[[ -f "$DIR_CCD/$NOMBRE" ]] || { echo "No existe el cliente VPN '$NOMBRE'."; exit 1; }
[[ "$RED_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo "Va como red/prefijo. Ej: 10.10.7.0/24"; exit 1; }

RED="${RED_CIDR%/*}"
PREFIJO="${RED_CIDR#*/}"
M=$(( 0xFFFFFFFF ^ ((1 << (32 - PREFIJO)) - 1) ))
MASCARA="$(( (M >> 24) & 255 )).$(( (M >> 16) & 255 )).$(( (M >> 8) & 255 )).$(( M & 255 ))"

if grep -q "^iroute $RED $MASCARA\$" "$DIR_CCD/$NOMBRE"; then
    sed -i "/^iroute ${RED//./\\.} ${MASCARA//./\\.}\$/d" "$DIR_CCD/$NOMBRE"
    ok "iroute quitado de $DIR_CCD/$NOMBRE"
else
    aviso "$NOMBRE no tenía publicada $RED_CIDR."
fi

# La ruta del servidor se saca solo si ningún otro cliente sigue publicando esa
# red. Si dos la tuvieran —un error en sí mismo—, sacarla dejaría al otro sin
# camino.
if grep -qs "^iroute $RED $MASCARA\$" "$DIR_CCD"/*; then
    aviso "Otro cliente sigue publicando $RED_CIDR: la ruta del servidor se deja."
elif grep -q "^route $RED $MASCARA\$" "$CONF"; then
    sed -i "/^route ${RED//./\\.} ${MASCARA//./\\.}\$/d" "$CONF"
    ok "route quitado de $CONF"
fi

[[ "${SIN_REINICIO:-}" == 1 ]] && exit 0

systemctl restart openvpn-server@server && ok "OpenVPN reiniciado (los túneles se reconectan solos)"
