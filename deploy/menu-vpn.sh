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
TITULO="ZenithCore - Túnel VPN"

[[ $EUID -eq 0 ]] || { echo "Correr como root (sudo menu-vpn)"; exit 1; }

if ! command -v dialog >/dev/null; then
    echo "Instalando dialog, que es lo que dibuja el menú..."
    apt-get install -y dialog >/dev/null || { echo "No se pudo instalar dialog"; exit 1; }
fi

# Bordes en ASCII (+ - |) y no con los caracteres de dibujo de líneas.
#
# La consola web de DigitalOcean no los muestra: cada borde salía como una fila
# de "â" —se ve igual en el menú de MikroWisp—. Con ASCII se ve bien en esa
# consola, en PuTTY y en cualquier terminal, sin depender de cómo esté
# configurada. NCURSES_NO_UTF8_ACS cubre lo que dialog no dibuja por su cuenta.
export NCURSES_NO_UTF8_ACS=1
dlg() { dialog --ascii-lines --backtitle "ZenithCore" "$@"; }

# ── Ayudantes ────────────────────────────────────────────────────────────────

mensaje() { dlg --title "$TITULO" --msgbox "$1" "${2:-12}" 72; }

pedir() { # pedir "pregunta" "valor sugerido" -> imprime lo escrito; falla si cancela
    dlg --title "$TITULO" --inputbox "$1" 12 72 "${2:-}" 3>&1 1>&2 2>&3
}

confirmar() { dlg --title "$TITULO" --yesno "$1" "${2:-12}" 72; }

instalado() { [[ -f "$CONF" ]]; }

clientes() { ls -1 "$DIR_CCD" 2>/dev/null; }

# Corre un script mostrando su salida, y espera Enter: si la pantalla se
# redibujara enseguida, el mensaje de error se perdería antes de leerlo.
correr() {
    clear
    "$@"
    local rc=$?
    echo
    read -rp "  Enter para volver al menú... " _
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
        dlg --title "Pegar en la terminal de $nombre" --textbox "$rsc" 30 100
    fi
}

# Las redes publicadas de un cliente, ya como red/prefijo.
redes_de() {
    awk '/^iroute/ {print $2, $3}' "$DIR_CCD/$1" 2>/dev/null | while read -r r m; do
        local bits=0 o
        for o in ${m//./ }; do while (( o )); do bits=$(( bits + (o & 1) )); o=$(( o >> 1 )); done; done
        echo "$r/$bits"
    done
}

elegir_cliente() { # elegir_cliente "pregunta" -> imprime el nombre elegido
    local lista=() c
    while read -r c; do [[ -n "$c" ]] && lista+=("$c" ""); done < <(clientes)
    (( ${#lista[@]} )) || { mensaje "Todavía no hay ningún MikroTik dado de alta (opción 2)."; return 1; }
    dlg --title "$TITULO" --menu "$1" 18 72 8 "${lista[@]}" 3>&1 1>&2 2>&3
}

reiniciar_openvpn() {
    clear
    echo
    systemctl restart openvpn-server@server \
        && echo "  ✓ OpenVPN reiniciado. Los túneles se reconectan solos en unos segundos." \
        || echo "  ! OpenVPN no reinició. Mirá: journalctl -u openvpn-server@server -n 40"
    echo
    read -rp "  Enter para volver al menú... " _
}

agregar_red() {
    instalado || { mensaje "Primero instalá el servidor (opción 1)."; return; }

    local cliente
    cliente=$(elegir_cliente "¿Detrás de qué MikroTik están las redes?") || return

    # Un formulario de diez casilleros, como el de MikroWisp.

    local ya
    ya=$(redes_de "$cliente" | tr '\n' ' ')
    local campos=() i
    for i in $(seq 1 10); do campos+=("Red $i:" "$i" 2 "" "$i" 12 22 22); done

    local salida
    salida=$(dlg --title "Agregar redes de $cliente" --ok-label "Agregar" --cancel-label "Volver" \
        --form "Como están en el router, ej: 10.10.7.254/24 o 10.10.7.0/24.\nLas vacías se ignoran.\nYa publicadas: ${ya:-(ninguna)}" \
        20 60 10 "${campos[@]}" 3>&1 1>&2 2>&3) || { clear; return; }
    clear

    local validas=() malas=() linea red
    while IFS= read -r linea; do
        [[ -n "${linea// /}" ]] || continue
        if red=$(normalizar_red "$linea"); then
            [[ " ${validas[*]} " == *" $red "* ]] || validas+=("$red")
        else
            malas+=("$linea")
        fi
    done <<< "$salida"

    (( ${#malas[@]} )) && { mensaje "Estas no son redes válidas, corregilas:\n\n  ${malas[*]}\n\nEj: 10.10.7.254/24 o 10.10.7.0/24"; return; }
    (( ${#validas[@]} )) || { mensaje "No se escribió ninguna red."; return; }

    confirmar "Se van a publicar a través de $cliente:\n\n  ${validas[*]}\n\nAl terminar se reinicia OpenVPN UNA vez: los túneles se cortan unos segundos y se reconectan solos.\n\n¿Seguir?" 16 || return

    clear
    for red in "${validas[@]}"; do
        SIN_REINICIO=1 bash "$DIR/agregar-red-cliente.sh" "$cliente" "$red"
    done
    echo
    read -rp "  Enter para reiniciar OpenVPN y aplicarlas... " _
    reiniciar_openvpn
}

quitar_red() {
    instalado || { mensaje "El servidor OpenVPN no está instalado."; return; }

    local cliente
    cliente=$(elegir_cliente "¿De qué MikroTik querés quitar redes?") || return

    local opciones=() r
    while read -r r; do [[ -n "$r" ]] && opciones+=("$r" "" OFF); done < <(redes_de "$cliente")
    (( ${#opciones[@]} )) || { mensaje "$cliente no tiene redes publicadas."; return; }

    local elegidas
    elegidas=$(dlg --separate-output --title "$TITULO" --checklist "Marcá con la barra espaciadora las que querés quitar de $cliente:" 18 72 10 \
        "${opciones[@]}" 3>&1 1>&2 2>&3) || return
    elegidas=${elegidas//\"/}
    [[ -n "$elegidas" ]] || { mensaje "No marcaste ninguna."; return; }

    confirmar "Se van a quitar de $cliente:\n\n  $elegidas\n\nEl servidor deja de llegar a esas redes. Se reinicia OpenVPN una vez.\n\n¿Seguir?" 15 || return

    clear
    for r in $elegidas; do SIN_REINICIO=1 bash "$DIR/quitar-red-cliente.sh" "$cliente" "$r"; done
    echo
    read -rp "  Enter para reiniciar OpenVPN y aplicar... " _
    reiniciar_openvpn
}

cambiar_red_tunel() {
    instalado || { mensaje "El servidor OpenVPN no está instalado."; return; }
    # shellcheck source=/dev/null
    local RED_VPN="" PREFIJO=24; source "$ENV"

    mensaje "La red del túnel hoy es $RED_VPN/$PREFIJO.\n\nCambiarla es para cuando choca con una red que ya existe dentro de algún MikroTik. Va en dos pasos:\n\n  1. Preparar: arma, para cada MikroTik, los comandos que le habilitan la red nueva. Se pegan en cada router.\n  2. Aplicar: recién ahí se cambia el servidor.\n\nSaltear el paso 1 deja a los routers inalcanzables para el sistema." 18

    local paso
    paso=$(dlg --title "$TITULO" --menu "¿Qué paso?" 14 72 3 \
        preparar "1. Armar los comandos para cada MikroTik (no cambia nada)" \
        aplicar  "2. Cambiar el servidor (ya pegué los comandos)" \
        3>&1 1>&2 2>&3) || return

    local nueva
    nueva=$(pedir "Red nueva del túnel, ej: 10.67.0.0/24.\n\nTiene que ser la MISMA en los dos pasos." "") || return
    nueva=$(normalizar_red "$nueva") || { mensaje "No es una red válida. Ej: 10.67.0.0/24"; return; }

    if [[ "$paso" == aplicar ]]; then
        confirmar "Se va a cambiar el túnel de $RED_VPN/$PREFIJO a $nueva.\n\n¿Pegaste en TODOS los MikroTik los comandos del paso 1?" 12 || return
    fi
    correr bash "$DIR/cambiar-red-vpn.sh" "$paso" "$nueva"
}

donde_esta() {
    # En un archivo y con --textbox: un msgbox de dialog no se desplaza, y esto
    # no entra en una pantalla de la consola web.
    local tmp
    tmp=$(mktemp)
    cat > "$tmp" <<'TEXTO'
\
Para corregir a mano, por SSH (nano) o con WinSCP (usuario root).
Después de editar cualquiera, reiniciar:  systemctl restart openvpn-server@server

/etc/openvpn/ccd/<NOMBRE>
   Un archivo por MikroTik. Adentro:
     ifconfig-push 10.66.0.11 255.255.255.0   -> su IP fija en el túnel
     iroute 10.10.7.0 255.255.255.0           -> una línea por red detrás de él

/etc/openvpn/server/server.conf
   La configuración del servidor.
     server 10.66.0.0 255.255.255.0           -> la red del túnel
   Al final, debajo de '# --- redes de clientes ---':
     route 10.10.7.0 255.255.255.0            -> una por red (la misma del iroute)
   Una red necesita SIEMPRE las dos: route acá e iroute en su cliente.

/etc/openvpn/smartolt.env
   Lo que eligió el instalador: IP pública, puerto, RED_VPN, PREFIJO, IP_VPS.
   Lo leen los scripts y el sistema (para la página del cortado).

/root/clientes-vpn/<NOMBRE>/
   Certificados y el script .rsc para pegar en cada MikroTik.

/var/log/openvpn/status.log    quién está conectado ahora
/var/log/openvpn/openvpn.log   el registro del servidor, para errores

Respaldos de un cambio de red: /root/respaldo-openvpn-<fecha>.tar.gz
TEXTO
    dlg --title "Dónde está cada cosa" --exit-label "Volver" --textbox "$tmp" 30 84
    rm -f "$tmp"
}

ver_estado() {
    instalado || { mensaje "El servidor OpenVPN no está instalado."; return; }

    local txt c ip redes conectado
    txt="MIKROTIK            IP TÚNEL        CONECTADO   REDES\n"
    txt+="------------------------------------------------------------------\n"
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
    opcion=$(dlg --title "$TITULO" --menu "Elegí una opción (flechas y Enter)" 20 74 8 \
        1 "Instalar y configurar el servidor OpenVPN" \
        2 "Agregar un MikroTik (un usuario VPN por router)" \
        3 "Agregar redes de los clientes detrás de un MikroTik" \
        4 "Quitar redes de un MikroTik (corregir un error)" \
        5 "Ver MikroTiks, si están conectados y sus redes" \
        6 "Abrir el puerto de la página del cortado" \
        7 "Cambiar la red del túnel (si choca con otra)" \
        8 "Dónde está cada cosa (para corregir a mano)" \
        3>&1 1>&2 2>&3) || { clear; exit 0; }

    case $opcion in
        1) instalar_servidor ;;
        2) agregar_usuario ;;
        3) agregar_red ;;
        4) quitar_red ;;
        5) ver_estado ;;
        6) abrir_puerto_corte ;;
        7) cambiar_red_tunel ;;
        8) donde_esta ;;
    esac
done
