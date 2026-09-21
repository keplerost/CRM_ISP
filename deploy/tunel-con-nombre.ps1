<#
  Arma el tunel CON NOMBRE: la URL deja de cambiar.

      powershell -ExecutionPolicy Bypass -File deploy\tunel-con-nombre.ps1 -Hostname api.tudominio.com

  ── En que se diferencia del tunel rapido ──

  El rapido (deploy\tunel.ps1) pide una URL prestada a trycloudflare.com y la
  devuelve al cerrarse. Sirve para probar.

  Este se registra con tu cuenta de Cloudflare y queda atado a un subdominio
  tuyo. La URL no cambia nunca, y puede arrancar solo con la PC.

  ── Lo que hay que hacer ANTES, una sola vez ──

      cloudflared tunnel login

  Abre el navegador para que elijas el dominio y guarda el certificado en
  %USERPROFILE%\.cloudflared\cert.pem. Es interactivo: no se puede automatizar,
  y sin eso todo lo de abajo falla con "Cannot determine default origin
  certificate path".
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Hostname,

    [string]$Nombre = 'smartolt-api',

    [int]$Puerto = 4000,

    # Instalar como servicio de Windows requiere consola de administrador.
    [switch]$ComoServicio
)

$ErrorActionPreference = 'Stop'

$exe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
if (-not (Test-Path $exe)) { $exe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source }
if (-not $exe -or -not (Test-Path $exe)) {
    Write-Host 'Falta cloudflared. Instalalo con: winget install --id Cloudflare.cloudflared' -ForegroundColor Red
    exit 1
}

$dir  = Join-Path $env:USERPROFILE '.cloudflared'
$cert = Join-Path $dir 'cert.pem'

# ── Paso 0 ── El certificado de la cuenta.
#
# Se chequea antes que nada porque su ausencia es el motivo mas comun de que
# todo esto falle, y el error nativo ("Cannot determine default origin
# certificate path") no dice que hay que correr `tunnel login`.
if (-not (Test-Path $cert)) {
    Write-Host ''
    Write-Host 'Falta autenticar con Cloudflare. Corre esto primero:' -ForegroundColor Yellow
    Write-Host '    cloudflared tunnel login' -ForegroundColor White
    Write-Host ''
    Write-Host 'Se abre el navegador, elegis el dominio, y vuelve aca.' -ForegroundColor DarkGray
    exit 1
}

# ── Paso 1 ── El tunel.
#
# Se reusa si ya existe. Crear dos con el mismo nombre no da error pero deja
# dos UUID distintos, y despues el config.yml apunta a uno y el DNS al otro:
# el sintoma es un 530 que no explica nada.
$lista = & $exe tunnel list --output json | ConvertFrom-Json
$tunel = $lista | Where-Object { $_.name -eq $Nombre } | Select-Object -First 1

if ($tunel) {
    Write-Host "Tunel '$Nombre' ya existe -> $($tunel.id)" -ForegroundColor DarkGray
} else {
    Write-Host "Creando tunel '$Nombre'..." -ForegroundColor Cyan
    & $exe tunnel create $Nombre
    if ($LASTEXITCODE -ne 0) { exit 1 }
    $lista = & $exe tunnel list --output json | ConvertFrom-Json
    $tunel = $lista | Where-Object { $_.name -eq $Nombre } | Select-Object -First 1
}

$id = $tunel.id
$credFile = Join-Path $dir "$id.json"

if (-not (Test-Path $credFile)) {
    Write-Host "No aparece el archivo de credenciales: $credFile" -ForegroundColor Red
    Write-Host 'Si el tunel se creo en otra PC, copia ese .json aca.' -ForegroundColor DarkGray
    exit 1
}

# ── Paso 2 ── El config.yml.
#
# `ingress` se lee en orden y la ultima regla TIENE que ser un catch-all
# `http_status: 404`. Sin ella cloudflared se niega a arrancar.
$config = Join-Path $dir 'config.yml'

@"
# Generado por deploy\tunel-con-nombre.ps1
tunnel: $id
credentials-file: $credFile

ingress:
  - hostname: $Hostname
    service: http://localhost:$Puerto
  # Todo lo que no sea ese hostname se rechaza. Sin esta regla final
  # cloudflared no arranca.
  - service: http_status:404
"@ | Out-File -FilePath $config -Encoding utf8

Write-Host "config.yml escrito en $config" -ForegroundColor DarkGray

# ── Paso 3 ── El DNS.
#
# Crea un CNAME de $Hostname hacia $id.cfargotunnel.com. Si ya hay un registro
# con ese nombre, hay que sobreescribirlo a proposito.
Write-Host "Apuntando $Hostname al tunel..." -ForegroundColor Cyan
& $exe tunnel route dns $Nombre $Hostname
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'No se pudo crear el DNS. Si dice "record already exists", ya hay' -ForegroundColor Yellow
    Write-Host 'otra cosa con ese nombre: borrala en el panel de Cloudflare o usa' -ForegroundColor Yellow
    Write-Host 'otro subdominio.' -ForegroundColor Yellow
    exit 1
}

# ── Paso 4 ── Correrlo.
if ($ComoServicio) {
    $admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
             ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) {
        Write-Host ''
        Write-Host 'Instalar el servicio requiere PowerShell como Administrador.' -ForegroundColor Red
        Write-Host 'Abri una consola con boton derecho -> Ejecutar como administrador y repeti.' -ForegroundColor DarkGray
        exit 1
    }
    Write-Host 'Instalando el servicio de Windows...' -ForegroundColor Cyan
    & $exe service install
    Start-Sleep -Seconds 3
    Get-Service cloudflared | Format-Table Name, Status, StartType -AutoSize
} else {
    Write-Host ''
    Write-Host '  Listo. Para levantarlo ahora:' -ForegroundColor Green
    Write-Host "      cloudflared tunnel run $Nombre" -ForegroundColor White
    Write-Host ''
    Write-Host '  Para que arranque solo con la PC, repeti con -ComoServicio' -ForegroundColor DarkGray
    Write-Host '  desde una consola de Administrador.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  URL base para el CRM:' -ForegroundColor Green
Write-Host "  https://$Hostname/api/v1" -ForegroundColor White
Write-Host ''
