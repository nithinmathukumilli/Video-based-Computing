# Looks at the camera pictures and sends the seat counts to the app (poc-vision\post_camera.py).
# Double-click run-camera.bat for one round, or run:
#   .\run-camera.ps1                 one round, then stop
#   .\run-camera.ps1 -Every 150      keep going: a round every 150 seconds (2.5 minutes). Close the window to stop.
#   .\run-camera.ps1 -Dry            show what would be sent, send nothing
# The app (restart-canteen.bat) must be running first.
param([int]$Every = 0, [switch]$Dry)

$vision = Join-Path $PSScriptRoot 'poc-vision'
$python = Join-Path $vision '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { Write-Host "Python for the camera scripts was not found at $python"; exit 1 }

# Is the app up? (post_camera.py reads the address and key from .env itself)
$port = '3000'
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) { if ($line -match '^\s*PORT\s*=\s*(\d+)') { $port = $Matches[1] } }
}
if ($env:PORT) { $port = $env:PORT }
try { $up = (Invoke-WebRequest "http://localhost:$port/healthz" -UseBasicParsing -TimeoutSec 3).Content -eq 'ok' } catch { $up = $false }
if (-not $up) { Write-Host "The app is not running on port $port. Start it first (restart-canteen.bat), then run this again."; exit 1 }

$cmdArgs = @('post_camera.py')
if ($Every -gt 0) { $cmdArgs += @('--every', $Every) }
if ($Dry) { $cmdArgs += '--dry' }
Set-Location $vision
& $python @cmdArgs
