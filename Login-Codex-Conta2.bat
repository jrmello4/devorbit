@echo off
title Conectar OpenAI Codex - Conta 2 (Brave)
setlocal
color 0B
echo ====================================================================
echo             OPENAI CODEX - AUTENTICACAO CONTA 2 (BRAVE)
echo ====================================================================
echo.
echo [1/2] Configurando pasta isolada da Conta 2:
set "CODEX_HOME=%USERPROFILE%\.codex-conta2"
echo       CODEX_HOME=%CODEX_HOME%
echo.
echo [2/2] Iniciando login oficial do Codex...
echo.
echo ====================================================================
echo INSTRUCAO:
echo Uma janela de autorizacao abrira no navegador.
echo Copie a URL ou certifique-se de autorizar no BRAVE com a conta desejada.
echo ====================================================================
echo.

where codex.cmd >nul 2>&1
if errorlevel 1 (
  echo O comando codex.cmd nao foi encontrado no PATH.
  echo Instale o Codex CLI ou configure o caminho em DevOrbit - Configuracoes.
  pause
  exit /b 1
)

call codex.cmd login
if errorlevel 1 (
  echo O login do Codex terminou com erro. Verifique a janela do navegador e tente novamente.
  pause
  exit /b 1
)
echo.
echo ====================================================================
echo Verificando se a Conta 2 foi autenticada com sucesso:
call codex.cmd login status
echo ====================================================================
echo.
echo Pronto! A sessao da Conta 2 foi configurada para este usuario.
echo.
pause
endlocal
