@echo off
rem Double-click to (re)start the canteen server. See restart-canteen.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-canteen.ps1"
echo.
pause
