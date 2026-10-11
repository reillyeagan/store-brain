@echo off
title Store Brain - make private keys
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - MAKE THE 2 PRIVATE KEYS
echo ==========================================================
echo   Makes MC_KEY and APPROVAL_SIGNING_KEY on this PC
echo   and adds them straight to Cloudflare. Running it again
echo   replaces both with new ones.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-keys.ps1"
echo.
echo   Close this window after you have saved MC_KEY.
pause
