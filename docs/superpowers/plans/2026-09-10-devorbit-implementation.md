# Plano de Implementação — DevOrbit (Desktop Workspace & AI Launcher)

Construção do aplicativo desktop **DevOrbit** para transformar a rotina de desenvolvimento com múltiplos repositórios e ferramentas de IA (Antigravity/Gemini, Xiaomi MiMo AI, ChatGPT Plus/Codex no Brave, VS Code e Terminal), eliminando a navegação manual de pastas e sincronizando repositórios Git com 1 clique.

## Fases de Execução

### Fase 1: Setup do Projeto & Estrutura Base
- Inicializar projeto Electron com Vite + React + TypeScript + Tailwind CSS v4.
- Configurar scripts no `package.json` (`dev`, `build`).
- Configurar Vite e TypeScript para suportar os três processos: Main, Preload e Renderer.

### Fase 2: Serviços do Processo Principal (Electron Main & IPC)
- `src/main/config.ts`: Gerenciar configuração local em JSON (pastas monitoradas e caminhos de executáveis).
- `src/main/scanner.ts`: Varredura recursiva de 1 nível nas pastas raiz configuradas para listar projetos, identificar `.git` e detectar stacks tecnológicas.
- `src/main/git.ts`: Executar `git status --porcelain -b` e `git pull` com tratamento de saída e erros.
- `src/main/launcher.ts`: Comandos seguros de inicialização para `agy.exe`, `Xiaomi MiMo AI.exe`, `brave.exe`, `code.cmd` e `wt.exe`.
- `src/main/index.ts`: Janela frameless com bordas arredondadas e registro de IPC handlers.
- `src/preload/index.ts`: ContextBridge tipado expondo a API `window.devorbit`.

### Fase 3: Interface do Usuário (Renderer React + Tailwind)
- `src/renderer/src/components/Header.tsx`: Barra de título moderna com busca (`Ctrl+K`), botão de refresh, alternador de conta ChatGPT (Conta 1 / Conta 2) e controles de janela.
- `src/renderer/src/components/ProjectCard.tsx`: Card com badges de tecnologia, diagnóstico Git (Sincronizado, X commits atrás, Alterações locais), botão "Sync Git" e botões rápidos para Antigravity, MiMo AI, Brave/ChatGPT, VS Code, Terminal e Copiar Contexto.
- `src/renderer/src/components/ProjectGrid.tsx`: Grid com filtros ("Todos", "Com alterações", "Atrás da origin").
- `src/renderer/src/components/SettingsModal.tsx`: Modal para adicionar/remover pastas monitoradas.
- `src/renderer/src/App.tsx`: Gerenciamento do estado global e atalhos.

### Fase 4: Verificação e Testes
- Execução em modo de desenvolvimento (`npm run dev`).
- Teste real com as pastas `C:\Users\adenilson.j\projects` e `Documents`.
- Teste de lançamento dos aplicativos e sincronização Git.
