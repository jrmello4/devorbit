@echo off
title DevOrbit
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem Instalado (NSIS) tem auto-update; portable exige download manual na Releases.
rem Este script prefere um executavel ja pronto ao lado dele, depois o
rem artefato local de build, e so por ultimo o modo desenvolvimento.

if exist "%~dp0DevOrbit.exe" (
  start "DevOrbit" "%~dp0DevOrbit.exe"
  exit /b 0
)

for %%F in ("%~dp0DevOrbit-*-portable.exe") do (
  if exist "%%~fF" (
    start "DevOrbit" "%%~fF"
    exit /b 0
  )
)

if exist "%~dp0release\win-unpacked\DevOrbit.exe" (
  start "DevOrbit" "%~dp0release\win-unpacked\DevOrbit.exe"
  exit /b 0
)

for %%F in ("%~dp0release\DevOrbit-*-portable.exe") do (
  if exist "%%~fF" (
    start "DevOrbit" "%%~fF"
    exit /b 0
  )
)

set "INSTALLER="
for %%F in ("%~dp0DevOrbit-*-x64.exe") do (
  if exist "%%~fF" (
    echo "%%~nxF" | findstr /i /c:"-portable" >nul
    if errorlevel 1 set "INSTALLER=%%~fF"
  )
)
if defined INSTALLER (
  echo Encontrado instalador do DevOrbit ao lado deste script:
  echo   %INSTALLER%
  echo Isso e o INSTALADOR, nao o app. Execute-o uma vez para instalar.
  echo A versao instalada atualiza sozinha; a portable pede download manual.
  echo.
  choice /m "Executar o instalador agora"
  if not errorlevel 2 start "DevOrbit Setup" "%INSTALLER%"
  exit /b 0
)

rem Development checkout fallback. Do not silently start with a missing or
rem stale dependency tree: that produces confusing esbuild/Electron errors.
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo DevOrbit nao encontrou um executavel pronto nem as dependencias de dev.
  echo Se baixou DevOrbit-...-x64.exe da pagina Releases, execute o instalador.
  echo Se baixou DevOrbit-...-portable.exe, coloque-o ao lado deste .bat.
  echo Para rodar do codigo-fonte, execute "npm ci" e depois "npm run build".
  echo Dica PowerShell com ExecutionPolicy restrita: use cmd /c "npm ci".
  exit /b 1
)

if not exist "%~dp0dist-electron\main\index.js" (
  echo DevOrbit nao encontrou o build da aplicacao.
  echo Execute "npm run build" depois de instalar as dependencias.
  exit /b 1
)

start "DevOrbit" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit /b %errorlevel%
