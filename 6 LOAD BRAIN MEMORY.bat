@echo off
title Store Brain - load store knowledge from the vault
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - LOAD STORE KNOWLEDGE
echo ==========================================================
echo.
echo   Loads ~1,230 audited facts from your vault into the brain's
echo   memory. Safe to run again: it replaces only this seed.
echo   Run "3 DEPLOY STORE BRAIN.bat" first.
echo.
if not exist "seed\core_seed.sql" (
  echo   seed\core_seed.sql is missing - tell Claude.
  pause
  exit /b 1
)
call npx --yes wrangler@4 d1 execute store-brain-ledger --remote --file seed\core_seed.sql > seed-output.txt 2>&1
type seed-output.txt
echo.
echo ==========================================================
echo   DONE. Tell Claude "memory loaded".
echo ==========================================================
pause
