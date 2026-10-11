@echo off
title Store Brain - add parcel tracking key
cd /d "%~dp0"
echo   Adds TRACKING_API_KEY (17TRACK API dashboard, Settings, Security key).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-secrets.ps1" -Spec "TRACKING_API_KEY|17TRACK API key|^[A-Za-z0-9]{16,64}$"
pause
