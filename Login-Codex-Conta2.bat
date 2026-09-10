@echo off
title Conectar OpenAI Codex - Conta 2 (Brave)
color 0B
echo ====================================================================
echo             OPENAI CODEX - AUTENTICACAO CONTA 2 (BRAVE)
echo ====================================================================
echo.
echo [1/2] Configurando pasta isolada da Conta 2:
set "CODEX_HOME=C:\Users\adenilson.j\.codex-conta2"
echo       CODEX_HOME=%CODEX_HOME%
echo.
echo [2/2] Iniciando login oficial do Codex...
echo.
echo ====================================================================
echo INSTRUCAO:
echo Uma janela de autorizacao abrira no navegador.
echo Copie a URL ou certifique-se de autorizar no BRAVE com sua Conta 2
echo (mello@adenilsonjunior.com.br)!
echo ====================================================================
echo.
call codex.cmd login
echo.
echo ====================================================================
echo Verificando se a Conta 2 foi autenticada com sucesso:
call codex.cmd login status
echo ====================================================================
echo.
echo Pronto! Agora sua Conta 2 esta conectada permanentemente no DevOrbit.
echo.
pause
