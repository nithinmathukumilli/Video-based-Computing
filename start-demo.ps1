# Starts the demo: Cloudflare tunnel -> saves the new link as PUBLIC_URL in .env -> starts the server.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = "$env:USERPROFILE\tools\node-portable\node-v24.22.1-win-x64\node.exe"
$cloudflared = "$env:USERPROFILE\tools\cloudflared\cloudflared.exe"
$envFile = Join-Path $root '.env'
$port = 3011   # the POC runs on its own port, so it never touches the live demo on 3001
$tunnelLog = Join-Path $env:TEMP 'canteen-poc-tunnel.log'
$serverLog = Join-Path $env:TEMP 'canteen-poc-server.log'

# Settings come from .env. Clear any left in this window's environment, because those would win over .env.
foreach ($n in 'ADMINS','DATA_DIR','DEV_USER','HOLD_MINUTES','PUBLIC_URL','DEMO_EMAIL_DOMAIN','TEAMS_WEBHOOK_URL','TEAMS_PERSONAL_WEBHOOK_URL','TEAMS_ALERT_MIN_SEATS','TEAMS_ALERT_COOLDOWN_SECONDS','TEAMS_PERSONAL_TTL_MINUTES') {
  Remove-Item "Env:\$n" -ErrorAction SilentlyContinue
}

foreach ($f in $node, $cloudflared) {
  if (-not (Test-Path $f)) { Write-Host "Missing: $f" -ForegroundColor Red; exit 1 }
}

# Stop anything left over from an earlier run (old server on the port, old tunnels).
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match "localhost:$port" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }   # only this copy's own tunnel
$old = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($old) { $old | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }
Start-Sleep 1

# The tunnel needs the server running to answer, but the server needs the link in .env at startup.
# So: start the tunnel first (it only forwards traffic), read its link, write .env, then start the server.
Remove-Item $tunnelLog, $serverLog -ErrorAction SilentlyContinue
Write-Host 'Starting the tunnel...'
$tunnel = Start-Process $cloudflared -ArgumentList 'tunnel', '--url', "http://localhost:$port" `
  -RedirectStandardError $tunnelLog -RedirectStandardOutput "$tunnelLog.out" -WindowStyle Hidden -PassThru

$link = $null
for ($i = 0; $i -lt 60 -and -not $link; $i++) {
  Start-Sleep 1
  if (Test-Path $tunnelLog) {
    $m = [regex]::Match((Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue), 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $link = $m.Value }
  }
}
if (-not $link) {
  Write-Host 'Could not get a link from Cloudflare. Check your internet connection.' -ForegroundColor Red
  Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

# Save the link as PUBLIC_URL in .env (replace the line, or add it if missing).
$text = if (Test-Path $envFile) { [IO.File]::ReadAllText($envFile) } else { '' }
if ($text -match '(?m)^PUBLIC_URL=.*$') { $text = [regex]::Replace($text, '(?m)^PUBLIC_URL=.*$', "PUBLIC_URL=$link") }
else { $text = $text.TrimEnd() + "`r`n`r`nPUBLIC_URL=$link`r`n" }
[IO.File]::WriteAllText($envFile, $text, (New-Object Text.UTF8Encoding($false)))

# Start the server. ADMINS and the Teams settings come from .env.
$env:DEMO_LOGIN = '1'
$env:PORT = "$port"
$server = Start-Process $node -ArgumentList 'server.js' -WorkingDirectory $root `
  -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err" -WindowStyle Hidden -PassThru

$up = $false
for ($i = 0; $i -lt 15 -and -not $up; $i++) {
  Start-Sleep 1
  try { $up = (Invoke-WebRequest "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq 'ok' } catch {}
}
if (-not $up) {
  Write-Host "The server did not start. See $serverLog.err" -ForegroundColor Red
  Stop-Process -Id $tunnel.Id, $server.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

try { Set-Clipboard -Value $link } catch {}
Write-Host ''
Write-Host '  Demo is running. Share this link (copied to your clipboard):' -ForegroundColor Green
Write-Host "  $link" -ForegroundColor Cyan
Write-Host '  It was saved as PUBLIC_URL in .env.'
Write-Host ''
Write-Host 'Press Enter to stop the demo (this ends the link).'
[void][Console]::ReadLine()

Stop-Process -Id $tunnel.Id, $server.Id -Force -ErrorAction SilentlyContinue
Write-Host 'Stopped.'
