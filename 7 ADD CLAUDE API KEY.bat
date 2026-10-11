@echo off
title Store Brain - add Claude API key
cd /d "%~dp0"
echo   Adds ANTHROPIC_API_KEY (from console.anthropic.com, API Keys page).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-secrets.ps1" -Spec "ANTHROPIC_API_KEY|Claude API key (starts with sk-ant-)|^sk-ant-[A-Za-z0-9_\-]{20,}$"
pause
