@echo off
title Store Brain - backup storage + check
cd /d "%~dp0"
echo   Creating the backup storage (R2 must be enabled in the dashboard first)...
call npx --yes wrangler@4 r2 bucket create store-brain-backups > r2-create-output.txt 2>&1
type r2-create-output.txt
echo.
echo   Checking the ledger tables...
call npx --yes wrangler@4 d1 execute store-brain-ledger --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" > d1-tables-output.txt 2>&1
type d1-tables-output.txt
echo.
echo   DONE. Tell Claude "backups done".
pause
