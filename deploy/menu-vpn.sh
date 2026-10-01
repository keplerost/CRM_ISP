#!/usr/bin/env bash
#
# El túnel VPN, con menú.
#
#   menu-vpn            (después de la primera actualización queda como comando)
#   bash /opt/smartolt/deploy/menu-vpn.sh
#
# ── Por qué existe ──
#
# Los tres scripts de abajo hacen el trabajo, pero piden los datos como
# argumentos y en un formato exacto: el nombre del cliente tal cual, la red con
# `.0` y su prefijo. En la consola web de DigitalOcean, con el celular en la
# otra mano mirando el router, eso es justo lo que sale mal.
#
# Este menú no hace nada nuevo: pregunta, completa lo que se puede deducir y
# llama a los mismos scripts. Así hay una sola forma de hacer cada cosa, y lo que
# ya está probado en ellos sigue valiendo.
#
set -uo pipefail

DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
DIR_CCD=/etc/openvpn/ccd
CONF=/etc/openvpn/server/server.conf
ENV=/etc/openvpn/smartolt.env
ESTADO=/var/log/openvpn/status.log
SALIDA=/root/clientes-vpn
PUERTO_CORTE=8090
TITULO="ZenithCore — Túnel VPN"

[[ $EUID -eq 0 ]] || { echo "Correr como root (sudo menu-vpn)"; exit 1; }

if ! command -v whiptail >/dev/null; then
    echo "Instalando whiptail, que es lo que dibuja el menú…"
    apt-get install -y whiptail >/dev/null || { echo "No se pudo instalar whiptail"; exit 1; }
fi

# ── Ayudantes ────────────────────────────────────────────────────────────────

mensaje() { whiptail --title "$TITULO" --msgbox "$1" "${2:-12}" 72; }

pedir() { # pedir "pregunta" "valor sugerido" → imprime lo escrito; falla si cancela
    whiptail --title "$TITULO" --inputbox "$1" 12 72 "${2:-}" 3>&1 1>&2 2>&3
}

confirmar() { whiptail --title "$TITULO" --yesno "$1" "${2:-12}" 72; }

instalado() { [[ -f "$CONF" ]]; }

clientes() { ls -1 "$DIR_CCD" 2>/dev/null; }

# Corre un script mostrando su salida, y espera Enter: si la pantalla se
# redibujara enseguida, el mensaje de error se perdería antes de leerlo.
correr() {
    clear
    "$@"
    local rc=$?
    echo
    read -rp "  Enter para volver al menú… " _
    return $rc
}

a_entero() { local a b c d; IFS=. read -r a b c d <<< "$1"; echo $(( (a << 24) + (b << 16) + (c << 8) + d )); }
a_ip() { echo "$(( ($1 >> 24) & 255 )).$(( ($1 >> 16) & 255 )).$(( ($1 >> 8) & 255 )).$(( $1 & 255 ))"; }

# "10.10.7.254/24" → "10.10.7.0/24". También acepta la red ya escrita bien, o
# una IP sola (se toma /24). Es la forma en que la ve quien mira el router.
normalizar_red() {
    local entrada=${1// /} ip prefijo
    [[ "$entrada" == */* ]] || entrada="$entrada/24"
    ip=${entrada%/*}
    prefijo=${entrada#*/}
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && "$prefijo" =~ ^[0-9]{1,2}$ ]] || return 1
    (( prefijo >= 8 && prefijo <= 30 )) || return 1
    local o; for o in ${ip//./ }; do (( o <= 255 )) || return 1; done
    local mascara=$(( 0xFFFFFFFF ^ ((1 << (32 - prefijo)) - 1) ))
    echo "$(a_ip $(( $(a_entero "$ip") & mascara )))/$prefijo"
}

# La próxima IP libre del túnel, para no tener que ir a buscarla.
ip_sugerida() {
    [[ -f "$ENV" ]] || return 0
    # shellcheck source=/dev/null
    local RED_VPN="" ; source "$ENV"
    local base=${RED_VPN%.*} usadas
    usadas=$(grep -h '^ifconfig-push' "$DIR_CCD"/* 2>/dev/null | awk '{print $2}' | awk -F. '{print $4}')
    local n
    for n in $(seq 11 250); do
        grep -qx "$n" <<< "$usadas" || { echo "$base.$n"; return; }
    done
}

# ── Opciones ─────────────────────────────────────────────────────────────────

instalar_servidor() {
    if instalado; then
        mensaje "El servidor OpenVPN ya está instalado.\n\nSi lo que querés es conectar otro MikroTik, es la opción 2."
        return
    fi
    confirmar "Se va a instalar el servidor OpenVPN en este VPS.\n\nVa a preguntar la IP pública (o el dominio), el puerto y la red del túnel. Para la red, aceptá la que propone salvo que choque con alguna que ya uses." 14 || return
    correr bash "$DIR/openvpn-server.sh"
}

agregar_usuario() {
    instalado || { mensaje "Primero instalá el servidor (opción 1)."; return; }

    local nombre ip
    nombre=$(pedir "Nombre del MikroTik (uno por router).\n\nSolo letras, números, guion y guion bajo. Ej: LOS_RIOS" "") || return
    [[ "$nombre" =~ ^[a-zA-Z0-9_-]+$ ]] || { mensaje "\"$nombre\" no sirve: solo letras, números, guion y guion bajo."; return; }
    clientes | grep -qx "$nombre" && { mensaje "Ya hay un MikroTik llamado $nombre."; return; }

    ip=$(pedir "IP fija de $nombre dentro del túnel.\n\nEs la que después se carga en el sistema como IP del router. Se propone la próxima libre." "$(ip_sugerida)") || return

    correr bash "$DIR/agregar-cliente-vpn.sh" "$nombre" "$ip" || return

    local rsc="$SALIDA/$nombre/mikrotik-$nombre.rsc"
    if [[ -f "$rsc" ]]; then
        mensaje "Listo. Lo que va al MikroTik quedó en:\n\n  $SALIDA/$nombre/\n\nEn la pantalla siguiente está el script para pegar en su terminal. En el sistema, cargá el router con la IP $ip." 14
        whiptail --title "Pegar en la terminal de $nombre" --scrolltext --textbox "$rsc" 30 100
    fi
}

agregar_red() {
    instalado || { mensaje "Primero instalá el servidor (opción 1)."; return; }

    local lista=() c
    while read -r c; do [[ -n "$c" ]] && lista+=("$c" ""); done < <(clientes)
    (( ${#lista[@]} )) || { mensaje "Todavía no hay ningún MikroTik dado de alta (opción 2)."; return; }

    local cliente
    cliente=$(whiptail --title "$TITULO" --menu "¿Detrás de qué MikroTik está la red?" 18 72 8 "${lista[@]}" 3>&1 1>&2 2>&3) || return

    local escrita red
    escrita=$(pedir "Red de los abonados (o de la OLT) detrás de $cliente.\n\nSe puede poner como está en el router, ej: 10.10.7.254/24.\nSi son varias, se agregan de a una." "") || return
    red=$(normalizar_red "$escrita") || { mensaje "\"$escrita\" no es una red válida. Ej: 10.10.7.254/24 o 10.10.7.0/24"; return; }

    confirmar "Se va a publicar la red $red a través de $cliente.\n\nAl terminar se reinicia OpenVPN: todos los túneles se cortan unos segundos y se reconectan solos.\n\n¿Seguir?" 14 || return
    correr bash "$DIR/agregar-red-cliente.sh" "$cliente" "$red"
}

ver_estado() {
    instalado || { mensaje "El servidor OpenVPN no está instalado."; return; }

    local txt c ip redes conectado
    txt="MIKROTIK            IP TÚNEL        CONECTADO   REDES\n"
    txt+="──────────────────────────────────────────────────────────────────\n"
    while read -r c; do
        [[ -n "$c" ]] || continue
        ip=$(awk '/^ifconfig-push/ {print $2}' "$DIR_CCD/$c")
        redes=$(awk '/^iroute/ {print $2 "/" $3}' "$DIR_CCD/$c" | while IFS=/ read -r r m; do
            local bits=0 o; for o in ${m//./ }; do while (( o )); do bits=$(( bits + (o & 1) )); o=$(( o >> 1 )); done; done
            printf '%s/%s ' "$r" "$bits"
        done)
        # El archivo de estado lista a los conectados por su nombre de certificado.
        if grep -qE "(^CLIENT_LIST,|^)$c," "$ESTADO" 2>/dev/null; then conectado="sí"; else conectado="no"; fi
        txt+=$(printf '%-19s %-15s %-11s %s' "$c" "${ip:--}" "$conectado" "${redes:-(ninguna)}")
        txt+="\n"
    done < <(clientes)

    mensaje "$txt" 20
}

abrir_puerto_corte() {
    if ! command -v ufw >/dev/null || ! ufw status | grep -q "Status: active"; then
        mensaje "El firewall (ufw) no está activo en este VPS: el puerto $PUERTO_CORTE ya está abierto y no hay nada que hacer."
        return
    fi
    if ufw status | grep -q "$PUERTO_CORTE/tcp on tun"; then
        mensaje "El puerto $PUERTO_CORTE ya está abierto para los túneles."
        return
    fi
    confirmar "Se va a abrir el puerto $PUERTO_CORTE, solo para lo que entra por los túneles VPN.\n\nEs el de la página que ve el abonado cortado. Desde internet sigue cerrado." 13 || return
    correr ufw allow in on tun0 to any port "$PUERTO_CORTE" proto tcp
}

# ── El menú ──────────────────────────────────────────────────────────────────

while true; do
    opcion=$(whiptail --title "$TITULO" --menu "Elegí una opción (flechas y Enter)" 18 72 6 \
        1 "Instalar y configurar el servidor OpenVPN" \
        2 "Agregar un MikroTik (un usuario VPN por router)" \
        3 "Agregar redes de los clientes detrás de un MikroTik" \
        4 "Ver MikroTiks, si están conectados y sus redes" \
        5 "Abrir el puerto de la página del cortado" \
        3>&1 1>&2 2>&3) || { clear; exit 0; }

    case $opcion in
        1) instalar_servidor ;;
        2) agregar_usuario ;;
        3) agregar_red ;;
        4) ver_estado ;;
        5) abrir_puerto_corte ;;
    esac
done
