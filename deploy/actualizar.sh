#!/usr/bin/env bash
#
# Trae los cambios del repositorio y deja el sistema andando con ellos.
#
#   ./actualizar.sh
#
# ── Por qué esto es un script y no tres comandos en el README ──
#
# Actualizar son cuatro pasos que hay que hacer en orden y con una variable de
# entorno que nadie recuerda:
#
#     git pull
#     npm install          (solo si cambiaron las dependencias)
#     NODE_OPTIONS=--max-old-space-size=N npm run build
#     systemctl restart smartolt-middleware
#
# El tercero es el que muerde. El instalador exporta `NODE_OPTIONS` dentro de su
# propia ejecución, así que compilar DESDE ÉL funciona; compilar a mano después
# falla con "JavaScript heap out of memory" y cincuenta líneas de volcado de V8.
#
# Pasó en la primera instalación real: el instalador terminó bien, y el primer
# `npm run build` a mano murió. El README incluso enseñaba el comando sin la
# variable — o sea que el propio proyecto indicaba el camino equivocado.
#
# Y el cuarto se olvida. Sin el reinicio, el frontend queda nuevo y el
# middleware sigue con el código viejo, que es la clase de desajuste que se
# manifiesta como un error raro media hora después.
#
set -euo pipefail

RAIZ=/opt/smartolt
USUARIO=smartolt
PUERTO_API=4000

azul() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
aviso() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Correr como root"; exit 1; }
[[ -d "$RAIZ/.git" ]] || { echo "No encuentro el repositorio en $RAIZ"; exit 1; }

cd "$RAIZ"

# ── Git y el `chown` ─────────────────────────────────────────────────────────
#
# El instalador hace `chown -R smartolt:smartolt` sobre todo el proyecto, y las
# actualizaciones se corren como root. Git ve un repositorio de otro dueño y se
# niega:
#
#     fatal: detected dubious ownership in repository at '/opt/smartolt'
#
# La protección es correcta —evita que un repositorio ajeno ejecute hooks como
# root— pero acá los dos dueños somos nosotros. Se declara la excepción una vez.
# Es idempotente: `--add` sobre un valor que ya está no lo duplica si se usa
# `git config --get` antes.
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$RAIZ"; then
    git config --global --add safe.directory "$RAIZ"
fi


# ── 1. Traer los cambios ─────────────────────────────────────────────────────

azul "1/4  Trayendo cambios"
ANTES=$(git rev-parse HEAD)

# Los .env son locales y no están versionados, pero los permisos de los scripts
# sí: si alguien hizo `chmod` a mano, el pull se niega y avisa con un mensaje
# que se pierde entre lo demás. Se descarta ese ruido y nada más.
git checkout -- deploy/ 2>/dev/null || true
git pull --ff-only

DESPUES=$(git rev-parse HEAD)

if [[ "$ANTES" == "$DESPUES" ]]; then
    ok "ya estaba al día ($(git rev-parse --short HEAD))"
else
    ok "$(git rev-parse --short "$ANTES") → $(git rev-parse --short "$DESPUES")"
    git log --oneline "$ANTES..$DESPUES" | sed 's/^/      /'
fi

# ── 2. Dependencias, solo si cambiaron ───────────────────────────────────────

azul "2/4  Dependencias"
# Se miran los package-lock: reinstalar cuando no cambió nada son dos minutos
# regalados en cada actualización.
if [[ "$ANTES" != "$DESPUES" ]] && \
   ! git diff --quiet "$ANTES" "$DESPUES" -- middleware/package-lock.json web/package-lock.json; then
    npm --prefix "$RAIZ/middleware" install --omit=dev --no-audit --no-fund
    npm --prefix "$RAIZ/web" install --no-audit --no-fund
    ok "dependencias actualizadas"
else
    ok "sin cambios en las dependencias"
fi

# ── 3. Compilar ──────────────────────────────────────────────────────────────

azul "3/4  Compilando el frontend"

# El mismo cálculo que hace el instalador. Ver el comentario largo de allá: Node
# fija su techo según la RAM física y el swap NO lo mueve, así que sin esto el
# build muere aunque haya swap de sobra.
RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
TECHO=$(( (RAM_MB + SWAP_MB) * 2 / 3 ))
(( TECHO < 1536 )) && TECHO=1536

if (( RAM_MB + SWAP_MB < 1800 )); then
    aviso "Poca memoria (${RAM_MB} MB + ${SWAP_MB} MB de swap). Si falla, corré install-app.sh, que crea swap."
fi

export NODE_OPTIONS="--max-old-space-size=$TECHO"
npm --prefix "$RAIZ/web" run build
ok "frontend compilado (techo de Node: ${TECHO} MB)"

# Lo recién compilado tiene que poder leerlo nginx, y los .env el servicio.
chown -R "$USUARIO:$USUARIO" "$RAIZ/web/dist"
ok "permisos de dist"

# ── 4. Reiniciar ─────────────────────────────────────────────────────────────

azul "4/4  Reiniciando el middleware"
systemctl restart smartolt-middleware
sleep 2

if systemctl is-active --quiet smartolt-middleware; then
    ok "smartolt-middleware corriendo"
else
    echo
    echo "  El servicio NO arrancó. Qué pasó:"
    echo "      journalctl -u smartolt-middleware -n 40 --no-pager"
    exit 1
fi

# El estado real, que es lo único que dice si esto quedó utilizable.
#
# Se consulta al middleware DIRECTO y no a través de nginx. Con HTTPS
# configurado, `http://localhost` devuelve el 301 hacia el dominio, y seguirlo
# no sirve: el certificado es del dominio y no de localhost. El resultado era
# que este paso imprimía el HTML de una redirección en vez del estado.
#
# Preguntarle al servicio directamente además es más honesto: lo que interesa
# acá es si el middleware arrancó y tiene su configuración, no si nginx sabe
# redirigir.
azul "Estado"

# Se reintenta, en vez de preguntar una sola vez.
#
# `systemctl is-active` da positivo apenas el proceso existe, pero Node todavía
# tarda en quedar escuchando. En una máquina chica, justo después de una
# compilación que dejó la memoria exigida, eso puede ser bastante más que los
# dos segundos que esperábamos: la actualización terminaba imprimiendo "El
# health no respondió" sobre un sistema que estaba perfecto.
#
# Es el peor cartel posible al final de un despliegue — manda a diagnosticar
# algo que no está roto, y la segunda vez que aparece ya nadie le cree.
RESPUESTA=""
for _ in $(seq 1 20); do
    RESPUESTA="$(curl -s --max-time 3 "http://127.0.0.1:${PUERTO_API}/api/health" || true)"
    [[ -n "$RESPUESTA" ]] && break
    sleep 2
done

if [[ -n "$RESPUESTA" ]]; then
    echo "  $RESPUESTA"
else
    aviso "El health no respondió después de 40 segundos. Qué dice el servicio:"
    echo "      journalctl -u smartolt-middleware -n 40 --no-pager"
    exit 1
fi
