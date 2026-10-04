@echo off
rem Double-click to open the dashboard (see dashboard-tunnel.ps1). Keep this window open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dashboard-tunnel.ps1" %*
pause
