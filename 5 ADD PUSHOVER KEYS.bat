@echo off
title Store Brain - add Pushover keys
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-pushover-keys.ps1"
pause
