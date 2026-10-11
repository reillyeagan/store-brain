@echo off
title Store Brain - create ledger tables (step 2 of 3)
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - STEP 2: CREATE THE LEDGER TABLES
echo ==========================================================
echo.
echo   If it asks "Ok to proceed?", type y and press Enter.
echo.
call npx --yes wrangler@4 d1 migrations apply store-brain-ledger --remote
echo.
echo   Checking the backup storage exists...
call npx --yes wrangler@4 r2 bucket list > r2-check-output.txt 2>&1
type r2-check-output.txt
echo.
echo ==========================================================
echo   DONE. Tell Claude "step 2 done".
echo ==========================================================
pause
