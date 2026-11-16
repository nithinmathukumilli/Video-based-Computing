@echo off
title Restart canteen server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-server.ps1"
pause
