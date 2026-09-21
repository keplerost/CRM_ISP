<#
  Levanta el tunel publico hacia el middleware y muestra la URL base para el CRM.

      powershell -ExecutionPolicy Bypass -File deploy\tunel.ps1

  ── Para que sirve ──

  El CRM corre en la nube. Para un servidor en internet `localhost` es el mismo,
  no esta PC, asi que nunca llegaria al puerto 4000. El tunel le da una direccion
  publica que si alcanza.

  ── Lo que hay que saber antes de usarlo ──

  La URL CAMBIA cada vez que se levanta. Sirve para probar; para produccion hace
  falta dominio propio y HTTPS (ver deploy/nginx-smartolt.conf). Cada vez que se
  reinicia hay que pasarle la URL nueva al proveedor.

  Mientras se use tunel, NO le cargues IPs permitidas a la llave: la IP de origen
  cambia sola y la llave dejaria de funcionar sin motivo aparente.
#>

$ErrorActionPreference = 'Stop'

$exe = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
if (-not (Test-Path $exe)) {
    $exe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
}
if (-not $exe -or -not (Test-Path $exe)) {
    Write-Host 'Falta cloudflared. Instalalo con:' -ForegroundColor Red
    Write-Host '  winget install --id Cloudflare.cloudflared'
    exit 1
}

# Sin middleware el tunel se levanta igual y contesta 502: parece que el tunel
# fallo cuando en realidad lo que falta es `npm run dev`. Se chequea antes para
# que el error diga lo que hay que hacer.
try {
    Invoke-WebRequest -Uri 'http://localhost:4000/api/integracion/ping' -UseBasicParsing -TimeoutSec 5 | Out-Null
} catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 401) {
        Write-Host 'El middleware no responde en el puerto 4000.' -ForegroundColor Red
        Write-Host 'Levantalo primero con:  npm run dev'
        exit 1
    }
}

$log = Join-Path $env:TEMP 'tunel-smartolt.log'
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host 'Levantando el tunel...' -ForegroundColor Cyan

$proc = Start-Process -FilePath $exe `
    -ArgumentList 'tunnel', '--url', 'http://localhost:4000' `
    -RedirectStandardError $log -RedirectStandardOutput "$log.out" `
    -WindowStyle Hidden -PassThru

$url = $null
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
             Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value; break }
    }
}

if (-not $url) {
    Write-Host 'No aparecio la URL. Ultimas lineas del log:' -ForegroundColor Red
    Get-Content $log -Tail 20
    exit 1
}

Write-Host ''
Write-Host '  URL base para el CRM:' -ForegroundColor Green
Write-Host "  $url/api/v1" -ForegroundColor White
Write-Host ''
Write-Host "  Header        : X-API-Key"
Write-Host "  Token         : la llave de Ajustes -> Gestion de personal"
Write-Host ''
Write-Host "  PID del tunel : $($proc.Id)   (para cerrarlo: Stop-Process -Id $($proc.Id))"
Write-Host "  Log           : $log"
Write-Host ''
Write-Host '  Mientras esta ventana siga viva, el tunel sigue arriba.' -ForegroundColor DarkGray
Write-Host '  La URL cambia si lo reiniciás: avisale al proveedor cada vez.' -ForegroundColor DarkGray
