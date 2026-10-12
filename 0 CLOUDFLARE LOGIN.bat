@echo off
title Store Brain - sign in to Cloudflare again
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - SIGN IN TO CLOUDFLARE AGAIN
echo ==========================================================
echo.
echo   Use this when a deploy says "not authorized" (code 7403/10000).
echo   A browser tab opens: sign in to the Cloudflare account that has
echo   the Store Brain and click Allow. Nothing else is changed.
echo.
call npx --yes wrangler@4 login
echo.
echo   Signed in as:
call npx --yes wrangler@4 whoami
echo.
echo ==========================================================
echo   DONE. Now run 3 DEPLOY STORE BRAIN.bat again.
echo ==========================================================
pause
