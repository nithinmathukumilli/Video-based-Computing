# Restarts only the server so it re-reads .env. The tunnel is not touched, so the link stays the same.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = "$env:USERPROFILE\tools\node-portable\node-v24.22.1-win-x64\node.exe"
$port = 3011   # the POC runs on its own port, so it never touches the live demo on 3001
$serverLog = Join-Path $env:TEMP 'canteen-poc-server.log'

# The server takes its settings from .env, but a setting left in this window's environment would win over .env
# (for example the admin list or the data folder from a test run). Clear them so .env is what counts.
foreach ($n in 'ADMINS','DATA_DIR','DEV_USER','HOLD_MINUTES','PUBLIC_URL','DEMO_EMAIL_DOMAIN','TEAMS_WEBHOOK_URL','TEAMS_PERSONAL_WEBHOOK_URL','TEAMS_ALERT_MIN_SEATS','TEAMS_ALERT_COOLDOWN_SECONDS','TEAMS_PERSONAL_TTL_MINUTES') {
  Remove-Item "Env:\$n" -ErrorAction SilentlyContinue
}

if (-not (Test-Path $node)) { Write-Host "Missing: $node" -ForegroundColor Red; exit 1 }

if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'Note: no tunnel is running, so there is no public link. Run start-demo.bat to start one.' -ForegroundColor Yellow
}

# Stop the old server on the port, if any.
$old = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($old) { $old | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep 1 }

# Start the new one with the same settings as start-demo.ps1. ADMINS and the Teams settings come from .env.
$env:DEMO_LOGIN = '1'
$env:PORT = "$port"
Remove-Item $serverLog, "$serverLog.err" -ErrorAction SilentlyContinue
Start-Process $node -ArgumentList 'server.js' -WorkingDirectory $root `
  -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err" -WindowStyle Hidden | Out-Null

$up = $false
for ($i = 0; $i -lt 15 -and -not $up; $i++) {
  Start-Sleep 1
  try { $up = (Invoke-WebRequest "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq 'ok' } catch {}
}
if (-not $up) {
  Write-Host "The server did not start. See $serverLog.err" -ForegroundColor Red
  exit 1
}

Write-Host 'Server restarted. It has read .env again; the link is unchanged.' -ForegroundColor Green
$line = Get-Content (Join-Path $root '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match '^PUBLIC_URL=' } | Select-Object -First 1
if ($line) { Write-Host ('Current link in .env: ' + ($line -split '=', 2)[1].Trim()) }
