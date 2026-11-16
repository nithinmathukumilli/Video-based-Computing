@echo off
rem Double-click to look at the camera pictures once and send the seat counts to the app. See run-camera.ps1.
rem For a round every 2.5 minutes, use run-camera-loop.bat instead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-camera.ps1"
echo.
pause
