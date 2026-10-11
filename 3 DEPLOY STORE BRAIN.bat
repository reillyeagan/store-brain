@echo off
title Store Brain - deploy (step 3 of 3)
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - STEP 3: DEPLOY
echo ==========================================================
echo.
echo   Puts the Store Brain online. Phase 1 is read-only:
echo   it cannot change anything in any store.
echo.
call npx --yes wrangler@4 deploy > deploy-output.txt 2>&1
type deploy-output.txt
echo.
echo ==========================================================
echo   DONE. Tell Claude "deployed".
echo   The address it printed (ending in workers.dev) is your
echo   Store Brain. Add the secrets next (Claude will guide you).
echo ==========================================================
pause
