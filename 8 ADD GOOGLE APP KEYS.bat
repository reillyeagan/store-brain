@echo off
title Store Brain - add Google OAuth client
cd /d "%~dp0"
echo   Adds the Google OAuth client for Gmail, Google Ads and Merchant Center
echo   (Google Cloud, project Store Brain, APIs and Services, Credentials).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-secrets.ps1" -Spec "GOOGLE_CLIENT_ID|Client ID (ends with .apps.googleusercontent.com)|^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$;GOOGLE_CLIENT_SECRET|Client secret (starts with GOCSPX-)|^GOCSPX-[A-Za-z0-9_\-]{20,}$"
pause
