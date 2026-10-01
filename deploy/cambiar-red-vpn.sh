#!/usr/bin/env bash
#
# Cambia la red del túnel de gestión: 10.66.0.0/24 → otra.
#
#   ./cambiar-red-vpn.sh preparar <red/prefijo>     paso 1: no cambia nada
#   ./cambiar-red-vpn.sh aplicar  <red/prefijo>     paso 2: cambia el servidor
#
# ── Cuándo hace falta ──
#
# Cuando la red elegida al instalar choca con una que el ISP ya usa adentro de
# algún MikroTik. El router tiene dos caminos a la misma red, y los paquetes se
# van por el equivocado: "a veces anda".
#
# ── Por qué en dos pasos ──
#
# Cada MikroTik deja entrar a su API SOLO desde la red del túnel (es lo que
# pega `agregar-cliente-vpn.sh`: `/ip service set api address=...` y un accept
# en input). Si se cambia el servidor primero, los routers reciben su IP nueva,
# pero rechazan al sistema desde la red nueva — y quedan inalcanzables, sin
# camino para arreglarlos a distancia.
#
#   preparar  arma, por cada MikroTik, los comandos que habilitan la red NUEVA
#             además de la vieja. Se pegan en cada router ANTES de aplicar.
#   aplicar   respalda /etc/openvpn, cambia la red del servidor y la IP de cada
#             router (conserva el último número: .11 sigue siendo .11) y
#             reinicia OpenVPN.
#
# Después de aplicar hay que cambiar la IP de cada router en el sistema, y
# apretar "Configurar el equipo" para que la página del cortado apunte al
# servidor en la red nueva. El script lo recuerda al terminar, con las IPs.
#
set -euo pipefail

DIR_CCD=/etc/openvpn/ccd
CONF=/etc/openvpn/server/server.conf
ENV=/etc/openvpn/smartolt.env
SALIDA=/root/clientes-vpn

azul() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }
[[ -f "$CONF" && -f "$ENV" ]] || { echo "No hay servidor OpenVPN instalado con openvpn-server.sh"; exit 1; }

PASO=${1:-}
NUEVA=${2:-}
[[ "$PASO" == preparar || "$PASO" == aplicar ]] && [[ -n "$NUEVA" ]] || {
    echo "Uso: $0 preparar <red/prefijo>    (primero)"
    echo "     $0 aplicar  <red/prefijo>    (después de pegar los comandos en cada MikroTik)"
    exit 1
}

# shellcheck source=/dev/null
source "$ENV"
PREFIJO=${PREFIJO:-24}
VIEJA_RED=$RED_VPN
VIEJO_PREFIJO=$PREFIJO

a_entero() { local a b c d; IFS=. read -r a b c d <<< "$1"; echo $(( (a << 24) + (b << 16) + (c << 8) + d )); }
a_ip() { echo "$(( ($1 >> 24) & 255 )).$(( ($1 >> 16) & 255 )).$(( ($1 >> 8) & 255 )).$(( $1 & 255 ))"; }
mascara_de() { a_ip $(( 0xFFFFFFFF ^ ((1 << (32 - $1)) - 1) )); }

# ── La red nueva, validada como al instalar ──────────────────────────────────

[[ "$NUEVA" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || { echo "Va como red/prefijo. Ej: 10.67.0.0/24"; exit 1; }
RED="${NUEVA%/*}"
PRE="${NUEVA#*/}"
(( PRE >= 16 && PRE <= 29 )) || { echo "El prefijo tiene que estar entre /16 y /29."; exit 1; }
case "$RED" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) : ;;
    *) echo "Tiene que ser una red privada (10.x, 172.16-31.x o 192.168.x)."; exit 1 ;;
esac
MASCARA=$(mascara_de "$PRE")
INICIO=$(a_entero "$RED")
M=$(a_entero "$MASCARA")
(( (INICIO & M) == INICIO )) || { echo "$RED no es la dirección de red de un /$PRE. ¿Quisiste decir $(a_ip $(( INICIO & M )))/$PRE?"; exit 1; }
FIN=$(( INICIO + 2 ** (32 - PRE) - 1 ))

[[ "$RED/$PRE" == "$VIEJA_RED/$VIEJO_PREFIJO" ]] && { echo "Esa ya es la red del túnel."; exit 1; }

# Que no pise nada: ni lo que el servidor ya tiene ruteado (salvo el propio
# túnel, que es justo lo que se cambia), ni las redes publicadas detrás de los
# MikroTik, que pueden no estar ruteadas si algún cliente está desconectado.
CHOQUE=""
while read -r destino; do
    [[ "$destino" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || continue
    [[ "$destino" == "$VIEJA_RED/$VIEJO_PREFIJO" ]] && continue
    oi=$(a_entero "${destino%/*}"); of=$(( oi + 2 ** (32 - ${destino#*/}) - 1 ))
    (( INICIO <= of && oi <= FIN )) && CHOQUE="$CHOQUE $destino"
done < <(
    {
        ip -4 route show 2>/dev/null | awk '{print $1}'
        grep -h '^iroute' "$DIR_CCD"/* 2>/dev/null | while read -r _ r m; do
            bits=0; for o in ${m//./ }; do while (( o )); do bits=$(( bits + (o & 1) )); o=$(( o >> 1 )); done; done
            echo "$r/$bits"
        done
    } | sort -u
)
[[ -z "$CHOQUE" ]] || { echo "La red $NUEVA se pisa con:$CHOQUE"; echo "Elegí otra."; exit 1; }

# ── Cada router, con su IP nueva ─────────────────────────────────────────────

VIEJO_INICIO=$(a_entero "$VIEJA_RED")
declare -A IP_NUEVA IP_VIEJA
for f in "$DIR_CCD"/*; do
    [[ -f "$f" ]] || continue
    n=$(basename "$f")
    vieja=$(awk '/^ifconfig-push/ {print $2}' "$f")
    [[ -n "$vieja" ]] || continue
    desplazamiento=$(( $(a_entero "$vieja") - VIEJO_INICIO ))
    nueva=$(( INICIO + desplazamiento ))
    (( desplazamiento > 1 && nueva < FIN )) || {
        echo "$n ($vieja) no entra en $NUEVA: la red nueva es más chica. Elegí un prefijo más ancho."
        exit 1
    }
    IP_VIEJA[$n]=$vieja
    IP_NUEVA[$n]=$(a_ip "$nueva")
done
IP_VPS_NUEVA=$(a_ip $(( INICIO + 1 )))

# ── Paso 1: preparar ─────────────────────────────────────────────────────────

if [[ "$PASO" == preparar ]]; then
    azul "Paso 1 de 2 — habilitar $NUEVA en cada MikroTik"
    for n in "${!IP_NUEVA[@]}"; do
        mkdir -p "$SALIDA/$n"
        rsc="$SALIDA/$n/cambio-red-$n.rsc"
        cat > "$rsc" <<EOF
# ============================================================
#  Cambio de la red del túnel — $n
#  $VIEJA_RED/$VIEJO_PREFIJO → $NUEVA
#
#  Pegar en la terminal de este MikroTik ANTES de aplicar el
#  cambio en el servidor. Deja la API abierta a las DOS redes,
#  así el sistema no se queda afuera en el medio.
# ============================================================

/ip service set api address=$VIEJA_RED/$VIEJO_PREFIJO,$NUEVA

/ip firewall filter
add chain=input src-address=$NUEVA protocol=tcp dst-port=8728 \\
    action=accept comment="API desde VPN de gestion ($NUEVA)" place-before=0

# Cuando todo ande con la red nueva, se puede sacar la vieja:
#   /ip service set api address=$NUEVA
#   /ip firewall filter remove [find src-address="$VIEJA_RED/$VIEJO_PREFIJO" dst-port=8728]
EOF
        ok "$n: $rsc"
    done
    cat <<EOF

  Pegá cada archivo en la terminal de SU MikroTik (o copialo con WinSCP).
  Cuando estén todos, aplicá:

      $0 aplicar $NUEVA

  Si un router no lo tiene pegado, va a quedar inalcanzable para el sistema
  hasta que alguien entre por WinBox y le habilite la red nueva a mano.

EOF
    exit 0
fi

# ── Paso 2: aplicar ──────────────────────────────────────────────────────────

azul "Paso 2 de 2 — cambiar el servidor a $NUEVA"

RESPALDO="/root/respaldo-openvpn-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$RESPALDO" -C / etc/openvpn
ok "respaldo de /etc/openvpn en $RESPALDO"

sed -i "s|^server .*|server $RED $MASCARA|" "$CONF"
ok "server.conf: server $RED $MASCARA"

for n in "${!IP_NUEVA[@]}"; do
    sed -i "s|^ifconfig-push .*|ifconfig-push ${IP_NUEVA[$n]} $MASCARA|" "$DIR_CCD/$n"
    ok "$n: ${IP_VIEJA[$n]} → ${IP_NUEVA[$n]}"
done

sed -i -e "s|^RED_VPN=.*|RED_VPN=$RED|" -e "s|^IP_VPS=.*|IP_VPS=$IP_VPS_NUEVA|" "$ENV"
if grep -q '^PREFIJO=' "$ENV"; then
    sed -i "s|^PREFIJO=.*|PREFIJO=$PRE|" "$ENV"
else
    echo "PREFIJO=$PRE" >> "$ENV"
fi
ok "smartolt.env: RED_VPN=$RED PREFIJO=$PRE IP_VPS=$IP_VPS_NUEVA"

systemctl restart openvpn-server@server
ok "OpenVPN reiniciado"

cat <<EOF

  El servidor ya está en $NUEVA (este VPS es $IP_VPS_NUEVA).

  Falta, en el sistema (MikroTik → editar cada router):
EOF
for n in "${!IP_NUEVA[@]}"; do
    printf '      %-18s IP %s  →  %s\n' "$n" "${IP_VIEJA[$n]}" "${IP_NUEVA[$n]}"
done
cat <<EOF

  Y en cada uno, "Revisar el equipo" → aplicar: corrige la página del cortado
  para que apunte a $IP_VPS_NUEVA.

  Si algo salió mal, para volver atrás:
      tar -xzf $RESPALDO -C / && systemctl restart openvpn-server@server

EOF
