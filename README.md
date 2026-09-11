# DevOrbit

Hub desktop para projetos locais, Git e ferramentas de desenvolvimento. O
aplicativo é voltado para Windows e usa Electron, Vite, React, TypeScript e
Tailwind CSS.

## Requisitos

- Windows 10/11 x64 para executar os artefatos distribuídos;
- Node.js `>=22.12.0 <26` e npm `>=10` para desenvolvimento;
- Git disponível no `PATH`;
- As ferramentas opcionais (Codex CLI, VS Code, Windows Terminal e
  navegadores) podem ser configuradas em **Configurações**.

## Desenvolvimento

Na raiz do repositório:

```powershell
npm ci
npm run typecheck
npm run test
npm run lint
npm run build
npm start
```

Para desenvolvimento com recarregamento do renderer, use `npm run dev` em um
terminal e o fluxo Electron configurado pelo Vite no outro, conforme o
ambiente local.

Se o build mencionar uma pasta de outro projeto, verifique a instalação antes
de investigar o código:

```powershell
node -e "const fs=require('fs'); console.log(fs.realpathSync('node_modules'))"
npm ci
npm run build
```

`node_modules` deve resolver para a pasta `node_modules` deste checkout. A
pasta não deve ser copiada entre projetos, sistemas operacionais ou ambientes
WSL/Windows.

## Empacotamento

```powershell
npm run dist
```

O empacotamento usa [electron-builder.json](electron-builder.json), gera um
instalador NSIS e um executável portable x64 em `release/`. O diretório de
saída é um artefato local e não deve ser versionado.

`DevOrbit.bat` primeiro tenta abrir um executável portable ao lado do script ou
em `release/win-unpacked`. Se estiver sendo usado a partir do checkout, ele
exige as dependências instaladas e um build prévio; mensagens de erro indicam
o comando correto para reparar o ambiente.

## Configuração e privacidade

As configurações ficam no diretório de dados do Electron do usuário. Os
caminhos monitorados são escolhidos no aplicativo e validados antes de serem
salvos. O recurso **Copiar Contexto** pode incluir informações do projeto,
como branch e arquivos alterados; revise o texto antes de compartilhá-lo com
serviços externos.

### Ações rápidas

Use `Ctrl+K` (ou `Cmd+K`) para abrir a paleta de ações. Ela permite pesquisar
projetos e executar rapidamente atualização, sincronização com o GitHub,
configurações e troca de conta do ChatGPT. `Ctrl+R` (ou `Cmd+R`) atualiza a
lista diretamente.

Credenciais do Codex ficam separadas por conta em diretórios do usuário. Não
adicione tokens, e-mails ou caminhos pessoais a este repositório, às
especificações ou aos scripts de automação.

### Troca de contas do ChatGPT

O botão de conta abre o ChatGPT em um perfil persistente e isolado para cada
conta (`account1` e `account2`). Na primeira abertura de cada perfil, faça o
login manualmente; depois disso, a sessão permanece separada e pode ser
reutilizada sem misturar cookies. O DevOrbit não lê e-mails nem cookies do
navegador para tentar adivinhar a identidade ativa. O Codex CLI também usa um
`CODEX_HOME` separado por conta.
O Codex Desktop continua usando a sessão gerenciada pelo próprio aplicativo,
que não oferece isolamento de perfis por `CODEX_HOME`.

### Adicionar Git a um projeto existente

Projetos sem `.git` exibem o botão **Adicionar Git**. O fluxo mostra uma
prévia dos arquivos, permite escolher a branch inicial e um remote HTTPS, e só
faz `git add -A` depois da confirmação explícita. O commit inicial e o push
são opcionais; nenhum push usa `--force`, e remotes que já possuem histórico
são recusados para preservar os dados existentes. A confirmação fica vinculada
à impressão digital da prévia e é invalidada se a lista de arquivos mudar.
Se a criação do repositório ocorrer mas o commit ou push falhar, o card é
atualizado para refletir o `.git` existente e a mensagem explica o próximo
passo sem apagar o trabalho local.

### Trocar branch e atualizar a `main`

Em qualquer projeto com Git, clique no nome da branch no card para abrir o
seletor de branches locais e remotas. A troca usa `git switch` e cria uma branch
local acompanhando o remote quando necessário. Para proteger trabalho em
andamento, o DevOrbit recusa a troca se houver arquivos modificados; faça
commit ou stash e tente novamente. Depois de selecionar `main`, use **Pull** no
mesmo card para executar `git pull --ff-only` somente nessa branch.

### Uso real do Codex e sessões estimadas

A seção **Uso local (estimado)** continua registrando apenas sessões abertas
para bloquear lançamentos concorrentes; ela não é uma contagem de tokens. A
seção **Uso real do Codex** consulta os `auth.json` isolados de cada conta
(`.codex-conta1` e `.codex-conta2`) e a rota oficial usada pelo Codex CLI e pelo
[ai-usagebar](https://github.com/akitaonrails/ai-usagebar). Ela exibe somente
percentuais que a OpenAI realmente devolveu, com a janela e o próximo reset.
Conta sem login, resposta sem percentual ou falha de rede aparecem como
**Não autenticada/Indisponível**, nunca como `0%`. Tokens não são persistidos no
estado do DevOrbit nem enviados ao renderer.

### Memória contínua por projeto

O arquivo `.devorbit/memory.md` é a memória canônica, com `CONTEXT.md` apenas
como fallback de leitura. O DevOrbit atualiza o status dos projetos em segundo
plano a cada minuto e consulta o uso real do Codex a cada cinco minutos quando
a janela está visível. Ele também recalcula se a memória ficou desatualizada em
relação à branch, commit e arquivos locais. O modal **Memória** oferece **Atualizar** e
**Puxar do Git** para revisar o handoff antes de salvar; o conteúdo manual nunca
é sobrescrito automaticamente. O formato segue a ideia de wiki versionada do
[ai-memory](https://github.com/akitaonrails/ai-memory).

## CI

O workflow do GitHub Actions executa em `windows-latest` uma instalação limpa
com `npm ci` e verifica typecheck, testes, lint e build. O lockfile deve ser
atualizado junto com qualquer mudança de dependência usando npm; o CI não
aceita uma árvore de dependências gerada manualmente.
