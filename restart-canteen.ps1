# Stops the canteen server if it is running, starts it again, and tells you how it went.
# Double-click restart-canteen.bat, or run:  .\restart-canteen.ps1
# Settings come from the ".env" file in this folder (copy .env.example to .env).
param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
Set-Location $app

# Find Node: the portable copy first, then whatever is on the PATH.
$node = Join-Path $env:USERPROFILE 'tools\node-portable\node-v24.22.1-win-x64\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source } else { Write-Host 'Node.js was not found. Install it or put a portable copy in tools\node-portable.'; exit 1 }
}

# Read the few settings this script needs from .env (the server reads the rest itself).
$cfg = @{}
$envFile = Join-Path $app '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$' -and -not $line.Trim().StartsWith('#')) { $cfg[$Matches[1]] = $Matches[2].Trim('"', "'") }
  }
}
$port = if ($env:PORT) { $env:PORT } elseif ($cfg['PORT']) { $cfg['PORT'] } else { '3000' }

# Stop whatever node server is using the port.
$old = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
foreach ($c in $old) {
  $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $proc.Id -Force; Write-Host "Stopped the old server (process $($proc.Id))." }
  elseif ($proc) { Write-Host "Port $port is used by '$($proc.ProcessName)', not node. Close it or set PORT in .env."; exit 1 }
}
Start-Sleep -Milliseconds 800

# Without DEV_USER nobody is signed in locally, so fall back to your own account name.
if (-not $env:DEV_USER -and -not $cfg['DEV_USER']) {
  $upn = (whoami /upn 2>$null)
  $env:DEV_USER = if ($upn -and $upn -like '*@*') { $upn.Trim() } else { 'dev@localhost' }
  Write-Host "No DEV_USER in .env: signing you in locally as $env:DEV_USER."
}

$log = Join-Path $app 'server.log'
$errLog = Join-Path $app 'server-error.log'
$p = Start-Process $node -ArgumentList 'server.js' -WorkingDirectory $app -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog

# Wait until it answers.
$up = $false
for ($i = 0; $i -lt 20 -and -not $up; $i++) {
  Start-Sleep -Milliseconds 500
  try { $up = (Invoke-WebRequest "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq 'ok' } catch {}
}
if (-not $up) {
  Write-Host 'The server did not start. Last lines of the error log:'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 8 }
  exit 1
}

# With DEMO_LOGIN the page asks people to sign in, so /api/me answers 401 here: read the setting from .env instead.
$me = $null
try { $me = Invoke-RestMethod "http://localhost:$port/api/me" } catch {}
$personalOn = if ($me) { $me.teamsAlerts } else { [bool]$cfg['TEAMS_PERSONAL_WEBHOOK_URL'] -or [bool]$env:TEAMS_PERSONAL_WEBHOOK_URL }
Write-Host ''
Write-Host "Canteen server is running at http://localhost:$port  (process $($p.Id))"
if (-not $me) { Write-Host '  Sign-in                 : people sign in with their work email (DEMO_LOGIN is on)' }
Write-Host ('  Personal Teams messages : ' + $(if ($personalOn) { 'ON' } else { 'off (set TEAMS_PERSONAL_WEBHOOK_URL in .env)' }))
Write-Host ('  Teams channel alerts    : ' + $(if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'Teams channel alerts are on' -Quiet)) { 'ON' } else { 'off (set TEAMS_WEBHOOK_URL in .env)' }))
Write-Host "  Logs: $log"
if (-not $NoOpen) { Start-Process "http://localhost:$port" }
