@echo off
title DevOrbit
setlocal
cd /d "%~dp0"

rem Prefer a shipped portable executable when this script is beside one.
if exist "%~dp0DevOrbit.exe" (
  start "DevOrbit" "%~dp0DevOrbit.exe"
  exit /b 0
)

rem Also support running the unpacked artifact produced by electron-builder.
if exist "%~dp0release\win-unpacked\DevOrbit.exe" (
  start "DevOrbit" "%~dp0release\win-unpacked\DevOrbit.exe"
  exit /b 0
)

rem Development checkout fallback. Do not silently start with a missing or
rem stale dependency tree: that produces confusing esbuild/Electron errors.
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo DevOrbit nao encontrou as dependencias locais do Electron.
  echo Execute "npm ci" na pasta do projeto e tente novamente.
  exit /b 1
)

if not exist "%~dp0dist-electron\main\index.js" (
  echo DevOrbit nao encontrou o build da aplicacao.
  echo Execute "npm run build" depois de instalar as dependencias.
  exit /b 1
)

start "DevOrbit" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit /b %errorlevel%
