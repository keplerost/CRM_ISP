#!/usr/bin/env bash
#
# Enseña al concentrador a llegar a una red que está DETRÁS de un MikroTik.
#
#   ./agregar-red-cliente.sh <nombre-vpn> <red/prefijo>
#   ./agregar-red-cliente.sh laMana2 10.11.105.0/24
#
# ── Qué problema resuelve ──
#
# `agregar-cliente-vpn.sh` le da al router su IP fija del túnel: 10.8.0.11, y
# desde el VPS se le hace ping. Eso alcanza para hablar con el ROUTER.
#
# No alcanza para la OLT. La OLT está en la LAN de ese router —10.11.105.2, por
# decir algo— y el VPS no tiene idea de que esa red existe ni de por dónde se
# llega. El paquete sale por la ruta por defecto, hacia internet, y se pierde.
#
# Hacen falta dos cosas, y las dos las escribe este script:
#
#   route  en la configuración del servidor   → "10.11.105.0/24 se alcanza por
#                                                el túnel", para el kernel del VPS
#   iroute en el archivo del cliente          → "y el que la tiene es ESTE router",
#                                                para OpenVPN
#
# Con una sola de las dos no funciona, y el síntoma es el mismo que no tener
# ninguna: no hay respuesta. Es la razón por la que esto es un script y no una
# instrucción en el README — dos archivos distintos que hay que tocar juntos es
# exactamente lo que se olvida a medias.
#
set -euo pipefail

DIR_CCD=/etc/openvpn/ccd
CONF=/etc/openvpn/server/server.conf
MARCA="# --- redes de clientes (agregar-red-cliente.sh) ---"

azul() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }
[[ -f "$CONF" ]] || { echo "No encuentro $CONF. Primero corré openvpn-server.sh"; exit 1; }

NOMBRE=${1:-}
RED_CIDR=${2:-}

if [[ -z "$NOMBRE" || -z "$RED_CIDR" ]]; then
    echo "Uso: $0 <nombre-vpn> <red/prefijo>"
    echo "Ej:  $0 laMana2 10.11.105.0/24"
    echo
    echo "Clientes VPN dados de alta:"
    ls -1 "$DIR_CCD" 2>/dev/null | sed 's/^/  /' || echo "  (ninguno)"
    echo
    echo "Redes ya publicadas:"
    grep -h '^iroute ' "$DIR_CCD"/* 2>/dev/null | awk '{print "  " $2 " " $3}' | sort -u || echo "  (ninguna)"
    exit 1
fi

[[ -f "$DIR_CCD/$NOMBRE" ]] || {
    echo "No existe el cliente VPN '$NOMBRE'."
    echo "Dalo de alta primero:  ./agregar-cliente-vpn.sh $NOMBRE 10.8.0.X"
    exit 1
}

# ── La red, validada ─────────────────────────────────────────────────────────

[[ "$RED_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || {
    echo "La red va en formato red/prefijo. Ej: 10.11.105.0/24"
    exit 1
}

RED="${RED_CIDR%/*}"
PREFIJO="${RED_CIDR#*/}"

[[ "$PREFIJO" -ge 8 && "$PREFIJO" -le 30 ]] || {
    echo "El prefijo tiene que estar entre /8 y /30"
    exit 1
}

# Prefijo a máscara. OpenVPN las quiere en formato largo: 255.255.255.0.
#
# Se calcula con aritmética de bits y no armando los octetos a mano: la versión
# por octetos necesita un caso especial para el 0 y es donde se cuelan los
# errores de borde (/8, /30).
mascara_de() {
    local p=$1
    local m=$(( 0xFFFFFFFF ^ ((1 << (32 - p)) - 1) ))
    printf '%d.%d.%d.%d' $(( (m >> 24) & 255 )) $(( (m >> 16) & 255 )) $(( (m >> 8) & 255 )) $(( m & 255 ))
}
MASCARA=$(mascara_de "$PREFIJO")

# Que la dirección sea la de la RED y no la de un equipo.
#
# `10.11.105.2/24` es un error clásico y silencioso: OpenVPN lo acepta, arma la
# ruta mal y después nada responde. Se comprueba acá porque el síntoma —"no
# llega"— es idéntico al de no haber corrido este script, y ahí se pierde media
# tarde buscando en el lugar equivocado.
IFS=. read -r o1 o2 o3 o4 <<< "$RED"
IFS=. read -r m1 m2 m3 m4 <<< "$MASCARA"
RED_OK="$(( o1 & m1 )).$(( o2 & m2 )).$(( o3 & m3 )).$(( o4 & m4 ))"
[[ "$RED" == "$RED_OK" ]] || {
    echo "$RED no es la dirección de red de un /$PREFIJO."
    echo "Con esa máscara, la red es $RED_OK — ¿quisiste decir $RED_OK/$PREFIJO?"
    exit 1
}

# ── Se escribe en los dos lados ──────────────────────────────────────────────

azul "Publicando $RED/$PREFIJO a través de $NOMBRE"

if grep -q "^iroute $RED $MASCARA\$" "$DIR_CCD/$NOMBRE"; then
    aviso "El cliente ya tenía esta red. No se duplica."
else
    echo "iroute $RED $MASCARA" >> "$DIR_CCD/$NOMBRE"
    ok "iroute agregado a $DIR_CCD/$NOMBRE"
fi

# En la configuración del servidor, dentro de un bloque marcado: así se ve de
# un vistazo qué puso este script y qué estaba de antes.
grep -q "^$MARCA\$" "$CONF" || printf '\n%s\n' "$MARCA" >> "$CONF"

if grep -q "^route $RED $MASCARA\$" "$CONF"; then
    aviso "El servidor ya tenía la ruta. No se duplica."
else
    echo "route $RED $MASCARA" >> "$CONF"
    ok "route agregado a $CONF"
fi

# ── Aplicar ──────────────────────────────────────────────────────────────────

# El `route` del servidor solo se lee al arrancar: recargar no alcanza. El
# `iroute` sí se aplica cuando el cliente se reconecta — y reiniciar el servidor
# los reconecta a todos, así que un solo reinicio cubre las dos cosas.
SERVICIO=$(systemctl list-units --type=service --no-legend 'openvpn*' | awk '{print $1}' | head -1)
if [[ -n "$SERVICIO" ]]; then
    systemctl restart "$SERVICIO"
    ok "$SERVICIO reiniciado (los túneles se reconectan solos en unos segundos)"
else
    aviso "No encontré el servicio de OpenVPN. Reinicialo a mano para aplicar."
fi

cat <<EOF

  Del lado del MikroTik, la LAN tiene que dejar pasar lo que viene del túnel.
  Si tenés filtro en forward, agregá:

    /ip firewall filter
    add chain=forward in-interface=vpn-gestion action=accept \\
        comment="Gestion desde el concentrador"

  Y NO enmascarar ese tráfico: si lo pasás por masquerade hacia la LAN, la OLT
  ve al router y no al VPS, y las respuestas vuelven igual — pero el día que
  quieras filtrar por origen, no vas a poder distinguir quién preguntó.

  Comprobar desde este VPS:

    ping $RED_OK$( [[ "$PREFIJO" == 24 ]] && echo " (o la IP de la OLT, ej ${o1}.${o2}.${o3}.2)" )

  Si responde, cargá la OLT en la aplicación con su IP de la LAN.

EOF
