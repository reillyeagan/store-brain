@echo off
title Store Brain - add approval signing key
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-signing-key.ps1"
pause
