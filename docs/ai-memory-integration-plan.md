# Integração ai-memory — plano e estado implementado

Status: **etapas de implementação 1–4 concluídas; quality e package gates PASS; somente tag, GitHub release e workflow permanecem pendentes (release não concluída).**
Checkout: baseline DevOrbit 1.0.41, release-alvo 1.0.42; sidecar ai-memory v2.4.0 (`b1b25219`).

## Diagnóstico pré-integração do DevOrbit

O DevOrbit 1.0.41 mantinha duas memórias locais: `memory.ts` (markdown com snapshot Git) e `hybrid-memory.ts`/`project-hybrid-memory.ts` (operational/episodic/reflexive em `.devorbit/memory.json`). Os pontos IPC relevantes estavam em `config-ipc.ts` e `observability-ipc.ts`. Providers tinham 7 first-class (codex, opencode, claude, gemini, aider, agy, custom); opencode2 e command-code não existiam como IDs. O Agent Bridge já oferecia eventos pending/completed/failed/blocked. Squads do Canvas tinham objetivo/membros mas sem estado durável consolidado. Nenhuma integração com ai-memory existia.

## Estado por etapa

### Etapa 1 — contrato, runtime e scope ✅

- `src/shared/ai-memory-contract.ts` — tipos, constantes, enums, erros, MCP tools, CLI commands.
- `src/main/ai-memory-service.ts` — lifecycle (unavailable/starting/running/degraded/error), single-flight, spawn/waitForHealth, reconfigure, marker, scope, binary discovery resiliente (pula binários incompatíveis no PATH/resources/runtime e cai no fallback v2.4.0), install com SHA-256 (remoção automática de zip corrompido), download com timeout finito e cancelamento via AbortController no stop/reconfigure sem travar UI, adoção de servidor externo com owned=false em corrida de porta, PowerShell extract, stop/dispose, generation-based stale detection.
- `src/main/ai-memory-client.ts` — MCP Streamable HTTP (JSON-RPC over POST), SSE parsing, serverIdentity (name+version), verifyScope, tools: status/query/recent/briefing/readPage/writePage/handoffList. CLI runner (doctor/workstreams/finalizeSession/backfill/bootstrap).
- `src/main/ai-memory-scope.ts` — identity derivation (git-common-dir > remote > path), marker parse/render/atomic-write, conflict detection, third-party preservation.
- `src/main/config.ts` — `loadAiMemoryConfig`, `saveAiMemoryConfig`, `setAiMemoryProjectEnabled` (habilitar liga gate global no mesmo update), `normalizeAiMemoryConfig`, arquivo separado `userData/ai-memory/config.json`.
- `src/main/index.ts` — `bootstrapAiMemory()` (fire-and-forget após janela), `aiMemoryService.stop()` no shutdown, `registerAiMemoryIpc` com serviço injetado.
- `src/shared/ai-memory-ipc-contract.ts` — contratos IPC: status/doctor/query/briefing/recent/handoffs/enableProject/migrateLegacy/migrationStatus/getProjectStatus/takeover/publishSquadState.
- Testes: 99 testes (service: 49, client: 24, scope: 18, config: 8; E2E gated adicional executado 1/1 separadamente em `tests/ai-memory-real-scope-e2e.test.ts` com binário oficial v2.4.0 e `buildAiMemoryHelperEnv`; suíte unitária de `tests/ai-memory-client.test.ts` mantida em 24/24).

### Etapa 2 — providers, launcher e lifecycle ✅

- `src/shared/agent-provider-contract.ts` — fonte única da verdade para `AGENT_PROVIDER_ID_LIST` e `AgentProviderId` (compartilhada entre main, renderer e testes sem acoplamento de runtime).
- `src/main/agent-providers.ts` — 9 providers first-class: codex, opencode, **opencode2**, claude, gemini, aider, agy, **command-code**, custom. Aliases Windows (.cmd/.bat/.exe), `CONFIGURED_COMMAND_KEYS`, `getKnownPathCandidates` com caminhos Windows por provider, `PROVIDER_MODEL_FLAGS`, `buildAgentTurnEnv` (opencode2→ANTHROPIC_API_KEY, command-code→OPENAI_API_KEY).
- `src/renderer/src/components/agent-creation-helpers.ts` — mapeamento unificado de `AGENT_TERMINAL_DEFAULT_COMMANDS` e injeção de terminal `injectAgentTerminalLaunch` (preserva autoStart do card de agente e runtimeConfig customizado).
- `src/renderer/src/components/IntegratedWorkspace.tsx` — integração do slot de workbench e canvas para inicialização de agentes.
- `src/main/ai-memory-launcher.ts` — `prepareAiMemoryLaunch` (scope resolution, marker guarantee, allowlist capture-mode, workstream default/`--new`). `resolveExecutableForRust` resolve .cmd/.bat: procura .exe irmão (caminho absoluto) ou retorna script diretamente — **NÃO monta cmd.exe /c**, pois a CLI upstream v2.4.0 aceita scripts .cmd/.bat nativamente via `--executable`. `registerActiveAiMemorySession`, `finalizeAiMemorySession` (deduplicada, overlap sticky set para Antigravity/Command Code), `drainPendingAiMemoryFinalizations` (bounded shutdown).
- `src/main/terminal-session.ts` — `finalizeAiMemorySession` no `onExit` e `stopTerminal`, `stopTerminalAsync` e `stopAllTerminalsAsync` com drain.
- `src/main/ipc/terminal-ipc.ts` — `prepareAiMemoryLaunch` integrado em `startAgentTerminal` e `startCodexTerminal` com fallback direto.
- `src/renderer/src/types.ts` — `AgentProviderId` derivado do contrato compartilhado.
- `src/main/validation.ts` — `AGENT_PROVIDER_IDS` validado com o contrato.
- Testes: 228 testes nas 7 suítes focused provider/launcher/setup/agent-turn/router (`agent-providers.test.ts`, `agent-terminal-launch.test.ts`, `terminal-ipc-agent-start.test.ts`, `ai-memory-launcher.test.ts`, `ai-memory-agent-setup.test.ts`, `agent-turn.test.ts`, `agent-router.test.ts`).

### Etapa 3 — migração, IPC, Bridge e squad ✅

- `src/main/ipc/ai-memory-ipc.ts` — 11 canais IPC registrados (status/doctor/query/briefing/recent/handoffs/enableProject/migrateLegacy/migrationStatus/getProjectStatus/takeover/publishSquadState). Doctor: owned usa CLI `--data-dir <userDataDir>/ai-memory/data doctor`; não-owned usa `health()` injetado no serviço para reportar saúde real sem inspecionar diretório alheio. Validação de path, scope gate, bounded reads.
- `src/main/ai-memory-migration.ts` — `runLegacyMigration`, `readMigrationReceiptState`, receipt determinístico com tags obrigatórias `historical` e `do-not-answer-from`.
- `src/main/ai-memory-takeover.ts` — `buildTakeoverPlan`, `fallbackTakeoverPlan`, takeover verification-first.
- `src/main/ai-memory-sync.ts` — `SquadMemoryPublisher`, `sanitizeSnapshot`, `squadStatePagePath`.
- `src/main/ai-memory-agent-setup.ts` — hooks/install per-agent (Gemini MCP+hooks).
- `src/renderer/src/components/WorkspaceCanvas.tsx` e `CanvasNodeInspector.tsx` — publicação periódica com debounce de squad snapshots; takeover com sincronização de handoffs/Git/decisões sem iniciar PTY duplicado.
- Testes: 155 testes nas 9 suítes IPC/migration/takeover/sync/setup/canvas takeover/bridge outcome/legacy gate/integration (`ai-memory-ipc.test.ts`, `ai-memory-migration.test.ts`, `ai-memory-takeover.test.ts`, `ai-memory-sync.test.ts`, `ai-memory-agent-setup.test.ts`, `canvas-squad-takeover.test.ts`, `bridge-outcome.test.ts`, `legacy-memory-gate.test.ts`, `ai-memory-integration.test.ts`).

### Etapa 4 — UI ✅

- `src/renderer/src/components/AiMemoryModal.tsx` — 6 abas (Status/Atividade/Briefing/Handoffs/Doctor/Legado). Toggle opt-in via `aiMemoryEnableProject` com rollback defensivo em caso de erro/rejeição IPC. Status Running/Starting/Degraded/Error/Disabled. Estados explícitos orientando ativação (sem vazio silencioso). Parsing e renderização segura de envelopes JSON-RPC e snippets MCP (`renderPage`, `renderHandoff`, `renderBriefingContent`, `FallbackJson` circular-safe sem HTML perigoso). Atualização imediata de `getProjectStatus` pós-migração para refletir receipt presente. Semântica ARIA completa (`role="tablist"`, `aria-selected`, `aria-controls`, `aria-labelledby`, foco coerente e texto `sr-only`).
- `src/preload/index.ts` — 13 invoke wrappers novos (aiMemory*).
- `src/renderer/src/types.ts` — `IpcInvokeChannel` e `DevOrbitAPI` expandidos com 13 canais.
- `tests/preload-contract.test.ts` — 16 testes (102 expectedApiKeys validados).
- `tests/ai-memory-modal.test.ts` — 67 testes focados (7 appendGitMemory, 9 IPC contract, 7 renderPage, 4 renderHandoff, 4 renderBriefingContent, 11 extractIpcArray envelope parser, 5 FallbackJson, 3 UI & acessibilidade, 17 migration e opt-in notice contract). Total na frente de UI: 83 testes (67 modal + 16 preload contract).
- `scripts/verify-ui-preload.cjs` — 14 mocks para APIs ai-memory.
- `scripts/verify-ui.cjs` — `inspectMemory` atualizado, `inspectSharedMemory` adicionado (título/tabs/switch/status/dark surface).

### Etapa 5 — validação e gates pós-execução (pacote validado / publicação pendente)

- `npm run typecheck` e `npm run typecheck:test` — PASS (zero erros).
- `npm test` — 1560 passed + 1 skipped (suíte completa de testes unitários e de integração).
- `npm run lint` — PASS (0 warnings); eslint focado PASS.
- `npm run build` — PASS (exit code 0; 2 avisos informativos Vite: chunk de `IntegratedWorkspace` com 546 KB [>500 KB]; `ai-memory-client` importado dinamicamente por IPC e estaticamente pelo service sem impacto funcional).
- `npm run verify:bridge` — 68/68 PASS.
- `npm run verify:runtime` — PASS (logs de Electron console-message deprecation e rejeição esperada de path fora do projeto).
- `npm run verify:ui` — 57 assertions por viewport (1366×768 e 1920×1080), totalizando 114 assertions (exit code 0; fluxos interativos toggle opt-in, busca MCP e aba legado).
- `npm run smoke:ipc` — PASS 6 checks / 104 métodos testados; falha intencional agora retorna exit 1 estrito; log de origem não confiável esperado e EPERM de limpeza temporária residual não bloqueante mantido como warning P3.
- `npm run audit:tokens` (46 tokens) e `npm run audit:repository` — PASS.
- E2E real ai-memory v2.4.0 — 1/1 PASS (`tests/ai-memory-real-scope-e2e.test.ts` com binário oficial v2.4.0 e `buildAiMemoryHelperEnv`, além de teste em runtime temporário e porta isolada 49474 com dados temporários isolados, comprovando download e extração automáticos, `verifyScope` funcional pré-write, aceitação de erro canônico `-32602` em base virgem, escrita/leitura e shutdown limpo sem impactar instâncias externas; suíte unitária de `tests/ai-memory-client.test.ts` mantida em 24/24).
- `npm run release:check` — PASS (metadata válida 1.0.42).
- `npm run dist` — PASS (empacotamento Windows x64 concluído com sucesso).
- `npm run smoke:package` — PASS 6/6 no pacote v1.0.42 (manifestos com hash SHA-512 [latest.yml e latest-portable.yml], tamanho, recursos do bridge, binários win-unpacked, executável portable e instalador/desinstalador NSIS com exit 0; histórico v1.0.41 6/6 preservado).
- **Source + package gates PASS.** Publicação no GitHub, criação de git tag e execução do workflow de release permanecem pendentes pelo coordenador; release **não declarada concluída**.

## Arquitetura implementada

1. **Main process** controla sidecar em `userData/ai-memory`. Binário versionado; dados persistentes separados.
2. **AiMemoryClient** — única interface MCP interna. Renderer não executa CLI/HTTP.
3. **Service** — 5 estados, single-flight, timeout, health check real, generation-based stale.
4. **Scope** — workspace `devorbit`, identity por git-common-dir > remote > path. Marker atômico com preservação de terceiros.
5. **Opt-in** — `enabled=false` por default. `setAiMemoryProjectEnabled(entry, true)` liga gate global no mesmo update.
6. **Providers** — 9 first-class. opencode2 e command-code com aliases, paths, model flags e env.
7. **Launcher** — scope reservation, workstream default/`--new`, allowlist capture-mode, `resolveExecutableForRust` (resolve .exe irmão para absoluto; retorna script diretamente para relativo; **nunca cmd.exe /c** — upstream v2.4.0 aceita scripts .cmd/.bat via `--executable`).
8. **Finalização** — deduplicada com sticky overlap set para Antigravity/Command Code. `drainPendingAiMemoryFinalizations` bounded (5s default).
9. **Doctor IPC** — owned: CLI com `--data-dir <userDataDir>/ai-memory/data doctor`; não-owned: `health()` ou fallback status. Testes: 8 cenários.
10. **UI** — 6 abas, presentation helpers, acessibilidade ARIA, IPC mock no verify-ui-preload, 57 assertions por viewport (114 no total) cobrindo estrutura e fluxos interativos (toggle, busca, legado).
11. **Migração** — receipt determinístico, idempotente, read-only após migração.

## Riscos e limitações atuais

- **E2E com binário real e smoke v2.4.0:** smoke/E2E com o asset oficial v2.4.0 (Windows x64, SHA-256 `4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50`) executado com sucesso em runtime temporário e porta isolada (49474), comprovando bootstrap, escrita, leitura e shutdown seguro sem afetar processos externos. O teste E2E real foi validado em `tests/ai-memory-real-scope-e2e.test.ts` (1/1 passing com binário oficial v2.4.0 e `buildAiMemoryHelperEnv`; suíte unitária de `tests/ai-memory-client.test.ts` mantida em 24/24). O client e service aceitam especificamente o erro canônico `-32602` (workspace não criada) em base virgem, e o `verifyScope` opera normalmente antes do primeiro write (eliminando a hipótese incorreta de degradação até o primeiro write).
- **Provisionamento e conectividade no first-run:** Sem o binário do sidecar pré-instalado em cache local ou empacotado em resources, o provisionamento inicial faz download sob demanda do GitHub Releases oficial; é necessária conexão com a internet na primeira execução (sem garantia de operação offline sem pré-provisionamento).
- **Limitação residual de Windows Job Object (P2 #5):** ausência de wrapper nativo de Job Object com `KILL_ON_JOB_CLOSE` no runtime Electron/Node. O encerramento do sidecar é garantido via `stopTerminalAsync`/`before-quit` sem dependências nativas C++; risco residual de processo órfão restrito a encerramento anormal ou forçado do host (`taskkill /F`).
- **Verificador de atualizações in-app (limitação preexistente):** O verificador in-app exige GitHub token (`GH_TOKEN`/`GITHUB_TOKEN`) ou autenticação prévia via `gh auth login` para checagem automatizada na API do GitHub; o repositório e os assets públicos permitem download manual direto, não constituindo bloqueio para a release.
- **Publicação e workflow pendentes (release não concluída):** Source e package gates validados com sucesso (`release:check` 1.0.42, `dist` Windows x64 e `smoke:package` 6/6 no v1.0.42); a publicação no GitHub, criação de git tag e execução de workflows de release permanecem pendentes pelo coordenador (release **não concluída**).
- **Limpeza scratch temp no smoke:ipc (P3):** warning residual de EPERM na remoção do diretório temporário no Windows é não bloqueante e não impacta os 104 métodos nem a garantia de saída exit 1 em caminho negativo induzido.
- **memory.json real-shape correction (implementado):** coberto e validado em `tests/ai-memory-migration.test.ts:457-581` (envelope `StoredMemory` v1 `{ version: 1, entries }`, arrays legados, tolerância a dados corrompidos/versões futuras, namespaces e migração idempotente com receipt) e gate read-only sem dual-write em `src/main/project-hybrid-memory.ts:70-79`.
- **Doctor/harness headless/redaction:** implementados e testados com mocks; sem validação com harness real.
- **Gemini hooks/MCP:** `ai-memory-agent-setup.ts` implementa setup; sem teste integrado com binário real.
- **verify:ui interativo:** `verify-ui.cjs` exercita fluxos interativos reais (toggle opt-in com rollback/restore, busca MCP com query, inspeção condicional da aba legado), com 57 assertions por viewport (114 assertions no total, exit code 0).

## Owner por fase

| Fase | Owner | Arquivos principais |
|---|---|---|
| 1. Contrato/runtime/scope | Shell #3 (OpenCode #3) | `ai-memory-contract.ts`, `ai-memory-service.ts`, `ai-memory-client.ts`, `ai-memory-scope.ts`, `config.ts`, `index.ts` |
| 2. Providers/launcher/lifecycle | Shell #2 (Codex #1) | `agent-providers.ts`, `ai-memory-launcher.ts`, `terminal-session.ts`, `terminal-ipc.ts`, `validation.ts` |
| 3. IPC/migração/Bridge/squad | Shell #3 | `ai-memory-ipc.ts`, `ai-memory-migration.ts`, `ai-memory-takeover.ts`, `ai-memory-sync.ts`, `ai-memory-agent-setup.ts` |
| 4. UI | Shell #2 (Codex #1) | `AiMemoryModal.tsx`, `preload/index.ts`, `types.ts`, `verify-ui.cjs`, `verify-ui-preload.cjs` |
| 5. Validação/gates | Coordenador | Diffs integrados, testes E2E, revisão segurança/privacidade |

## Fontes consultadas

- https://github.com/akitaonrails/ai-memory/releases/tag/v2.4.0
- Docs upstream: ARCHITECTURE.md, windows.md, managed-workstreams.md, mcp-install.md, marker-file.md, usage.md, cookbook.md, support-matrix.md
