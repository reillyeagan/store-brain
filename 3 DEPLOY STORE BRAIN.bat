@echo off
title Store Brain - deploy
cd /d "%~dp0"
echo ==========================================================
echo   STORE BRAIN - DEPLOY
echo ==========================================================
echo.
echo   1) Database updates (only new ones run; D1 keeps 30 days
echo      of history, so any change can be rolled back).
echo      If it asks "Ok to proceed?", type y and press Enter.
echo.
call npx --yes wrangler@4 d1 migrations apply store-brain-ledger --remote
if errorlevel 1 goto failed
echo.
echo   2) Putting the new version online...
call npx --yes wrangler@4 deploy > deploy-output.txt 2>&1
if errorlevel 1 (
  type deploy-output.txt
  goto failed
)
type deploy-output.txt
echo.
echo   Secret NAMES only (values are never shown):
call npx --yes wrangler@4 secret list > secret-names.txt 2>&1
type secret-names.txt
echo.
echo ==========================================================
echo   DONE. Tell Claude "deployed".
echo ==========================================================
pause
exit /b 0

:failed
echo.
echo ==========================================================
echo   SOMETHING FAILED - nothing new went online.
echo   Tell Claude "deploy failed" (the window above has the reason).
echo ==========================================================
pause
exit /b 1
