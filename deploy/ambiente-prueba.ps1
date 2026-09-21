<#
  Levanta el ambiente de prueba completo: Supabase local + migraciones.

      powershell -ExecutionPolicy Bypass -File deploy\ambiente-prueba.ps1
      powershell -ExecutionPolicy Bypass -File deploy\ambiente-prueba.ps1 -Detener
      powershell -ExecutionPolicy Bypass -File deploy\ambiente-prueba.ps1 -Reiniciar

  ── Qué levanta ──

  `supabase start` corre Supabase ENTERO en esta PC dentro de Docker: Postgres,
  la API REST, autenticación, storage y el panel. No es un Postgres pelado — es
  lo mismo que hay en la nube, así que lo que funciona acá funciona allá.

  ── Por qué local y no un proyecto en la nube ──

  Porque el plan gratuito permite dos proyectos por cuenta y los dos ya están
  ocupados: el del sistema ISP y el del CRM. Y porque para PROBAR, local es
  mejor: se reinicia entero en segundos con -Reiniciar, no consume cuota, y
  nada de afuera puede alcanzarlo ni por error.

  La contra: solo corre mientras la PC esté prendida. Para pruebas alcanza; el
  día que el proveedor del CRM tenga que probar contra algo que no sea
  producción, ahí sí hace falta uno en la nube.
#>

param(
    [switch]$Detener,
    [switch]$Reiniciar
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot

Set-Location $raiz

# ── Docker tiene que estar corriendo ──
#
# Se chequea antes que nada porque `supabase start` sin Docker falla con un
# error sobre el socket que no dice que lo que falta es abrir Docker Desktop.
function DockerVivo {
    try { docker info 2>&1 | Out-Null; return $LASTEXITCODE -eq 0 } catch { return $false }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Falta Docker Desktop. Instalalo con:' -ForegroundColor Red
    Write-Host '  winget install --id Docker.DockerDesktop'
    exit 1
}

if (-not (DockerVivo)) {
    Write-Host 'Docker esta instalado pero el motor no responde.' -ForegroundColor Yellow
    Write-Host 'Abri Docker Desktop y espera a que diga "Engine running".' -ForegroundColor DarkGray
    exit 1
}

if ($Detener) {
    Write-Host 'Bajando Supabase local...' -ForegroundColor Cyan
    supabase stop
    Write-Host 'Listo. Los datos quedan guardados: al volver a levantarlo siguen ahi.' -ForegroundColor DarkGray
    exit 0
}

if ($Reiniciar) {
    Write-Host 'Borrando los datos de prueba y volviendo a empezar...' -ForegroundColor Yellow
    supabase stop --no-backup
    supabase start
    Write-Host 'Base vacia. Ahora hay que volver a aplicar las migraciones.' -ForegroundColor DarkGray
}
else {
    if (-not (Test-Path 'supabase\config.toml')) {
        Write-Host 'Primera vez: inicializando el CLI...' -ForegroundColor Cyan
        # Crea config.toml y la carpeta migrations/. No toca los .sql que ya estan.
        supabase init
    }

    Write-Host 'Levantando Supabase local (la primera vez baja imagenes, tarda)...' -ForegroundColor Cyan
    supabase start
}

if ($LASTEXITCODE -ne 0) { exit 1 }

# ── La cadena de conexion local es siempre la misma ──
#
# No hay que copiarla de ningun panel: el CLI usa estos valores fijos.
$conexion = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

Write-Host ''
Write-Host 'Aplicando las 178 migraciones...' -ForegroundColor Cyan
node supabase/aplicar-migraciones.mjs $conexion
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
Write-Host '  Ambiente de prueba listo.' -ForegroundColor Green
Write-Host ''
supabase status
Write-Host ''
Write-Host '  Copia la API URL y la service_role key de arriba a:' -ForegroundColor DarkGray
Write-Host '      middleware\.env.prueba     (service_role)' -ForegroundColor DarkGray
Write-Host '      web\.env.prueba            (anon)' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Y despues:  npm run dev:prueba' -ForegroundColor DarkGray
