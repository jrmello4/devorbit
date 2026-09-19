@echo off
setlocal

set "SCRIPT_PATH=%~dp0scripts\devorbit-bridge.cjs"
if not exist "%SCRIPT_PATH%" (
  if exist "%~dp0..\scripts\devorbit-bridge.cjs" (
    set "SCRIPT_PATH=%~dp0..\scripts\devorbit-bridge.cjs"
  )
)

rem 1. Se node global estiver disponivel, execute via label sem bloco parentizado
where node >nul 2>nul
if %errorlevel% equ 0 goto :run_node

rem 2. Fallback de release: procurar executavel DevOrbit ou Electron
set "ELECTRON_RUN_AS_NODE=1"

set "NODE_EXE="
if exist "%~dp0DevOrbit.exe" set "NODE_EXE=%~dp0DevOrbit.exe"
if not defined NODE_EXE if exist "%~dp0..\DevOrbit.exe" set "NODE_EXE=%~dp0..\DevOrbit.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\DevOrbit\DevOrbit.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\DevOrbit\DevOrbit.exe"
if not defined NODE_EXE if exist "%~dp0electron.exe" set "NODE_EXE=%~dp0electron.exe"
if not defined NODE_EXE if exist "%~dp0..\electron.exe" set "NODE_EXE=%~dp0..\electron.exe"

if defined NODE_EXE goto :run_electron

echo [DevOrbit] Erro: Node.js ou executavel DevOrbit.exe nao encontrado para rodar o bridge CLI. 1>&2
exit /b 1

:run_node
node "%SCRIPT_PATH%" %*
exit /b %errorlevel%

:run_electron
"%NODE_EXE%" "%SCRIPT_PATH%" %*
exit /b %errorlevel%
