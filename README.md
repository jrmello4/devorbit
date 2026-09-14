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
npm run verify:ui
npm start
```

Para desenvolvimento com recarregamento, um único comando basta
(`npm run dev` ou `npm run electron:dev`): o Vite serve o renderer e abre o
Electron automaticamente.

Se o PowerShell bloquear o `npm` (`execution of scripts is disabled`),
rode via `cmd`:

```powershell
cmd /c "npm ci"
cmd /c "npm run dev"
```

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

Na página **Releases** há dois artefatos:

| Arquivo | Tipo | Auto-update |
|---|---|---|
| `DevOrbit-<versão>-x64.exe` | Instalador NSIS | Sim, baixa e instala no próximo reinício |
| `DevOrbit-<versão>-portable.exe` | Portable, sem instalação | Sim, troca o executável no reinício |

A barra de status indica `portable · atualização automática` quando aplicável. O instalador NSIS e a versão portable consultam o release privado automaticamente; o GitHub CLI precisa estar autenticado uma vez com `gh auth login` para que o app consiga baixar os arquivos.
O `DevOrbit-...-x64.exe` é o **instalador**: execute-o uma vez para instalar
(atalhos no menu Iniciar e área de trabalho). Não confunda com o app.

`DevOrbit.bat` procura nesta ordem: `DevOrbit.exe` ao lado do script,
`DevOrbit-*-portable.exe` ao lado, `release/win-unpacked/DevOrbit.exe`,
`release/DevOrbit-*-portable.exe`. Se achar um `DevOrbit-*-x64.exe` que não
seja portable, ele avisa que é o instalador e oferece executá-lo. Sem nenhum
executável, cai no modo checkout (`npm ci` + `npm run build`).

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

### Diagnóstico e abertura do workspace

O menu **Diagnóstico** verifica os caminhos configurados para Terminal, VS Code,
Codex CLI, Antigravity, Chrome, Brave e MiMo AI, informando quando uma
alternativa pode ser usada. No card de cada projeto, **Abrir tudo** inicia o
VS Code, um terminal na pasta, o Codex CLI e o navegador associado à conta
selecionada. A conta pode ser definida por projeto e fica salva localmente;
quando não há escolha específica, o DevOrbit usa a conta ativa. O card também
mostra a última atualização detectada, o gerenciador de pacotes e scripts úteis.
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

### Catálogo de projetos e liberação de espaço

O botão **Clonar por link** também registra o projeto no catálogo do DevOrbit.
Depois de enviar o trabalho para o GitHub, use **Finalizar e liberar espaço**
no card. O DevOrbit mantém a pasta com o nome e os dados do remote, mas remove
o conteúdo local somente quando confirma que a árvore está limpa, a branch e
as demais branches locais estão alinhadas ao GitHub, não há stash nem arquivos
ignorados importantes. Se alguma verificação falhar, nada é removido.

Um projeto arquivado aparece como **Arquivado · pronto para baixar**. Clique em
**Baixar projeto** para clonar novamente o remote na mesma pasta e continuar o
trabalho. Dependências e diretórios recriáveis ignorados pelo Git podem ser
liberados junto com a cópia; arquivos ignorados como `.env` e bancos bloqueiam
o fluxo para evitar perda acidental.

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
com `npm ci` e verifica typecheck, testes, lint e build. Pushes na `main`
executam apenas essas verificações. Para publicar uma versão, atualize a
versão do `package.json` e do lockfile, crie uma tag correspondente como
`v1.0.14` e envie essa tag; então o workflow valida a versão, gera o instalador
NSIS e portable, cria o Release e publica os metadados de atualização. O
lockfile deve ser atualizado junto com qualquer mudança de dependência usando
npm; o CI não aceita uma árvore de dependências gerada manualmente.

## Interface desktop

O workspace usa tema claro, sem azul, com navegação recolhível, lista de projetos e painel de detalhes. **Contas e uso** reúne as cotas reais e os controles de estimativas locais. A janela não tem rolagem global; conteúdo extenso rola dentro dos painéis.

A organização espacial, os tokens, a tipografia e os critérios de contraste estão em [DESIGN.md](DESIGN.md). `Ctrl+,` abre Configurações.
