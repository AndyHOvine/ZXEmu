@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is needed: https://nodejs.org/
  exit /b 1
)
node "%~dp0tools\serve.mjs" --open %*
