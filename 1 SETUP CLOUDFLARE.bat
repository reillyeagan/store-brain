@echo off
title Store Brain - Cloudflare setup (step 1 of 3)
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - STEP 1: CLOUDFLARE SETUP
echo ==========================================================
echo.
echo   This creates two things in your Cloudflare account:
echo     - the ledger database   (store-brain-ledger)
echo     - the backup storage    (store-brain-backups)
echo   Nothing touches any store.
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Install the LTS version from https://nodejs.org
  echo   then run this file again.
  pause
  exit /b 1
)
echo   Checking your Cloudflare login (a browser tab may open - click Allow)...
call npx --yes wrangler@4 whoami >nul 2>nul
if errorlevel 1 call npx --yes wrangler@4 login
echo.
echo   Creating the database...
call npx --yes wrangler@4 d1 create store-brain-ledger > d1-create-output.txt 2>&1
type d1-create-output.txt
echo.
echo   Creating the backup storage...
call npx --yes wrangler@4 r2 bucket create store-brain-backups
echo.
echo ==========================================================
echo   DONE. Tell Claude "step 1 done".
echo   (Claude reads d1-create-output.txt for the database id.
echo    The id is not a secret.)
echo ==========================================================
pause
