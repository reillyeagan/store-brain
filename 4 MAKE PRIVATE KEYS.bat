@echo off
title Store Brain - make private keys
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - MAKE THE 3 PRIVATE KEYS
echo ==========================================================
echo   Makes MC_KEY, APPROVAL_SIGNING_KEY and NTFY_TOPIC on this PC
echo   and adds them straight to Cloudflare. Running it again
echo   replaces all three with new ones.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-keys.ps1"
echo.
echo   Close this window after you have saved the two values.
pause
