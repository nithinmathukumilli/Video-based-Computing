@echo off
rem Double-click to keep the camera result fresh: a round every 150 seconds (2.5 minutes). Close this window to stop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-camera.ps1" -Every 150
echo.
pause
