# Perfis Codex isolados por conta

O DevOrbit trata cada conta ChatGPT como um perfil Codex independente. Não há
perfil "padrão" compartilhado e não existe reaproveitamento automático de
credenciais entre contas.

## Onde cada conta vive

| Conta | `CODEX_HOME` | Arquivo de autenticação |
|---|---|---|
| Conta 1 | `%USERPROFILE%\.codex-conta1` | `%USERPROFILE%\.codex-conta1\auth.json` |
| Conta 2 | `%USERPROFILE%\.codex-conta2` | `%USERPROFILE%\.codex-conta2\auth.json` |

- `getCodexHome` e `getAuthFilePaths` (`src/main/account-profiles.ts`) apontam
  exclusivamente para o home da conta escolhida.
- `getCodexAccountEnvironment` devolve somente `{ CODEX_HOME }`; nenhum token,
  chave ou credencial é injetado no ambiente do PTY.
- O login oficial (`startCodexDeviceLogin`, em `src/main/codex-auth.ts`) roda
  `codex login` com o `CODEX_HOME` da conta e valida o `auth.json` desse mesmo
  diretório.
- O launcher (`launchTool('codex-cli')`, em `src/main/launcher.ts`) exige a
  conta explícita e abre a sessão com o `CODEX_HOME` correspondente.

## O que o DevOrbit nunca faz

- **Não lê, não copia, não move e não importa** o auth legado de `~/.codex`.
- Não copia `auth.json` de uma conta para outra.
- Não escolhe conta automaticamente quando nenhuma foi informada: a operação
  falha com uma mensagem pedindo a seleção explícita.
- Não apaga nem altera a pasta `~/.codex`; ela continua pertencendo ao usuário
  e a outras ferramentas.

## Usuário que só tem `~/.codex`

Se a única sessão existente é a de `~/.codex` (por exemplo, criada pelo Codex
Desktop ou por um login antigo do CLI), faça um login novo na Conta 1:

1. Abra o modal de autenticação do Codex no DevOrbit e escolha **Conta 1**.
   O DevOrbit cria `%USERPROFILE%\.codex-conta1` e roda o login oficial da
   OpenAI já apontado para esse diretório.
2. Conclua a autorização no navegador (Chrome, perfil da Conta 1).

Também é possível fazer o mesmo manualmente em um terminal:

```powershell
$env:CODEX_HOME = "$env:USERPROFILE\.codex-conta1"
codex login
codex login status
```

Para a Conta 2, use o atalho `Login-Codex-Conta2.bat` (que define
`CODEX_HOME=%USERPROFILE%\.codex-conta2`) ou repita o comando manual trocando o
diretório.

Não copie `~/.codex\auth.json` para `.codex-conta1\auth.json`. O arquivo
pertence à sessão antiga e copiá-lo:

- mistura a identidade das contas (uso e login passariam a divergir);
- duplica credenciais em disco sem controle de expiração;
- mascara falhas de login que o fluxo oficial detectaria.

Se a Conta 1 precisar ser reautenticada, remova apenas o `auth.json` do home
isolado (`%USERPROFILE%\.codex-conta1\auth.json`) e faça login novamente. O
`~/.codex` original permanece intacto.

## Como conferir no Diagnóstico

O modal **Diagnóstico de ferramentas** mostra, por ferramenta:

- **Em uso**: o caminho que o DevOrbit abrirá (campo `effectivePath`).
- **Configurado**: o caminho definido em Configurações quando houver um valor
  explícito (`configuredPath`/`isConfigured`); caso contrário, indica
  "Padrão (detecção automática)".

Para o Codex CLI, o caminho em uso é o executável resolvido pelo DevOrbit. A
pasta de perfil (`CODEX_HOME`) não aparece nesse modal e não é exposta por IPC.
