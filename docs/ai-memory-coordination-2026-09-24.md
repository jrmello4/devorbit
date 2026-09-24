# DevOrbit + ai-memory: diagnóstico e estado implementado

Data: 2026-09-24
Status: **4 etapas de implementação concluídas; etapa de validação/package concluída com quality e package gates PASS; apenas tag, GitHub release e workflow seguem pendentes (release não concluída).**

## Diagnóstico pré-integração

DevOrbit 1.0.41 mantinha memória markdown (`memory.ts`) e hybrid-memory (operational/episodic/reflexive). Providers: 7 first-class (codex, opencode, claude, gemini, aider, agy, custom). Agent Bridge produzia eventos pending/completed/failed/blocked. Squads do Canvas tinham objetivo/membros sem estado durável. Nenhuma integração com ai-memory existia.

## Módulos implementados

| Módulo | Arquivos | Testes |
|---|---|---|
| Contrato/runtime/scope | `ai-memory-contract.ts`, `ai-memory-service.ts`, `ai-memory-client.ts`, `ai-memory-scope.ts`, `config.ts` (seção ai-memory), `index.ts` (bootstrap) | 99 testes (49 service, 24 client, 18 scope, 8 config; E2E gated adicional 1/1 executado separadamente em `tests/ai-memory-real-scope-e2e.test.ts`; suíte unitária de `tests/ai-memory-client.test.ts` mantida em 24/24) |
| Providers/launcher/lifecycle | `agent-provider-contract.ts`, `agent-providers.ts` (9 providers), `ai-memory-launcher.ts`, `terminal-session.ts`, `ipc/terminal-ipc.ts`, `agent-creation-helpers.ts`, `IntegratedWorkspace.tsx` | 228 testes nas 7 suítes focused provider/launcher/setup/agent-turn/router |
| IPC/migração/Bridge/squad | `ipc/ai-memory-ipc.ts` (11 canais), `ai-memory-migration.ts`, `ai-memory-takeover.ts`, `ai-memory-sync.ts`, `ai-memory-agent-setup.ts`, `WorkspaceCanvas.tsx`, `CanvasNodeInspector.tsx` | 155 testes nas 9 suítes IPC/migration/takeover/sync/setup/canvas takeover/bridge outcome/legacy gate/integration |
| UI | `AiMemoryModal.tsx` (6 abas), preload (13 wrappers), `types.ts` (13 canais), `agent-creation-helpers.ts` | 83 testes (67 modal, 16 preload contract) |
| Verificação | `verify-ui-preload.cjs` (14 mocks), `verify-ui.cjs` (inspectSharedMemory), `smoke-package.cjs`, `smoke-ipc.cjs` | verify:ui 114 assertions (57/viewport), smoke:ipc 6/6 (104 métodos), verify:bridge 68, smoke:package 6/6 v1.0.42 (histórico v1.0.41 preservado) |

## State do checkout em 2026-09-24

- **Providers first-class e Contrato Compartilhado:** `src/shared/agent-provider-contract.ts` estabelecido como única fonte de verdade (`AGENT_PROVIDER_ID_LIST` e `AgentProviderId`) consumida por main, renderer e testes sem acoplamento de runtime. Mapeamento de comandos padrão (`AGENT_TERMINAL_DEFAULT_COMMANDS`) e injeção de terminal seguro (`injectAgentTerminalLaunch`) em `agent-creation-helpers.ts` e `IntegratedWorkspace.tsx`.
- **Sidecar Lifecycle e Resiliência (P1/P2):** Download com timeout finito (`downloadTimeoutMs: 60s`) e cancelamento via AbortController no `stop()`/`reconfigure()`, liberando `startPromise` e a UI; discovery pula binários incompatíveis (PATH/resources/runtime) com fallback na versão pinada v2.4.0; remoção automática de zip corrompido em falha de SHA-256; adoção de serviço externo com `owned=false` em caso de corrida de portas pós-probe; limitação residual de Windows Job Object documentada em código sem dependências nativas.
- **Launcher:** `resolveExecutableForRust` — para script ABSOLUTO procura .exe irmão; para RELATIVO retorna script diretamente. **Nunca monta cmd.exe /c** — a CLI upstream v2.4.0 aceita .cmd/.bat nativamente via `--executable` (Rust 1.95, BatBadBut mitigado).
- **Finalização:** Deduplicada com `overlappingAntigravitySessions` sticky set. `drainPendingAiMemoryFinalizations` bounded (5s) no shutdown.
- **Doctor IPC:** Owned: CLI com `--data-dir <userDataDir>/ai-memory/data doctor`; não-owned: `health()` injetado ou fallback de status sem inspecionar diretório alheio.
- **IPC:** 11 canais registrados (status/doctor/query/briefing/recent/handoffs/enableProject/migrateLegacy/migrationStatus/getProjectStatus/takeover/publishSquadState).
- **Opt-in e Toggle Rollback:** `setAiMemoryProjectEnabled(entry, true)` liga `enabled=true` no mesmo update atômico. Desabilitar NÃO desliga gate global. `AiMemoryModal.tsx` trata rollback do switch em caso de falha ou rejeição IPC.
- **UI:** Modal Shared AI Memory com 6 abas, parsing seguro de envelopes JSON-RPC/snippets MCP (`renderPage`/`renderHandoff`/`renderBriefingContent`/`FallbackJson` circular-safe sem HTML perigoso), sem vazio silencioso quando desativado, atualização imediata de `getProjectStatus` pós-migração, acessibilidade ARIA completa (`role="tablist"`, `aria-selected`, `aria-controls`, `aria-labelledby`, foco coerente e texto `sr-only`).
- **Validação e Gates Executados:**
  - `typecheck` e `typecheck:test`: PASS (zero erros).
  - `npm test`: 1560 passed + 1 skipped (suíte completa de testes unitários e de integração).
  - `lint`: PASS (0 warnings); eslint focado PASS.
  - `build`: PASS (exit code 0; 2 avisos informativos Vite: chunk de `IntegratedWorkspace` com 546 KB [>500 KB]; `ai-memory-client` importado dinamicamente por IPC e estaticamente pelo service sem impacto funcional).
  - `verify:bridge`: 68/68 PASS.
  - `verify:runtime`: PASS (logs de Electron console-message deprecation e rejeição esperada de path fora do projeto).
  - `verify:ui`: 57 assertions por viewport (114 no total em 1366×768 e 1920×1080; toggle, busca MCP, aba legado).
  - `smoke:ipc`: PASS 6 checks / 104 métodos testados; falha intencional agora retorna exit 1 estrito; log de origem não confiável esperado e aviso residual de EPERM de limpeza temporária no scratch mantido como warning P3 não bloqueante.
  - `audit:tokens` (46 tokens) e `audit:repository`: PASS.
  - E2E real ai-memory v2.4.0: 1/1 PASS (`tests/ai-memory-real-scope-e2e.test.ts` com binário oficial v2.4.0 e `buildAiMemoryHelperEnv`, além de teste em runtime temporário e porta isolada 49474 com dados temporários isolados, comprovando download e extração automáticos, `verifyScope` funcional pré-write, aceitação de erro canônico `-32602` em base virgem, escrita/leitura e shutdown limpo sem impactar instâncias externas; suíte unitária de `tests/ai-memory-client.test.ts` mantida em 24/24).
  - `release:check`: PASS (metadata válida 1.0.42).
  - `npm run dist`: PASS (Windows x64 concluído com sucesso).
  - `smoke:package`: PASS 6/6 no pacote v1.0.42 (manifestos com hash SHA-512 [latest.yml e latest-portable.yml], tamanho, recursos do bridge, win-unpacked, portable e NSIS install+uninstall exit 0; histórico v1.0.41 6/6 preservado).
  - **Source + package gates PASS.** Publicação no GitHub, criação de git tag e execução de workflows de release permanecem pendentes pelo coordenador; release **não declarada concluída**.
- **E2E Real com sidecar v2.4.0 comprovado:** teste E2E real executado com o asset Windows x64 oficial (SHA-256 `4b3b8757c16a6ae97a3a43f46baef012a400121017272fb4e799503d8c130a50`) em porta 49474 com dados temporários isolados (bootstrap, escrita, leitura, receipt e shutdown limpo sem afetar instâncias externas). Client e service aceitam especificamente o erro canônico `-32602` de workspace não criada, e o `verifyScope` funciona perfeitamente antes do primeiro write (eliminando a hipótese incorreta de que `service.start` degradava até o primeiro write).

## Arquivos com ownership definido

- **Shell #2 (Codex #1):** `types.ts`, `preload/index.ts`, `ai-memory-modal.test.ts`, `AiMemoryModal.tsx`, `verify-ui.cjs`, `verify-ui-preload.cjs`, `agent-providers.ts`, `validation.ts`, `config.ts` (seção ai-memory), `SettingsModal.tsx`, `WorkspaceTerminal.tsx`, `agent-creation-helpers.ts`, `ai-memory-ipc.ts`, `ai-memory-ipc.test.ts`.
- **Shell #3:** `ai-memory-migration.ts`, `ai-memory-takeover.ts`, `ai-memory-sync.ts`, `ai-memory-agent-setup.ts`, `ai-memory-ipc-contract.ts`, `ai-memory-contract.ts`, `ai-memory-service.ts`, `ai-memory-client.ts`, `ai-memory-scope.ts`.
- **Antigravity #2:** `WorkspaceCanvas.tsx`, `WorkspaceCanvas.css`, `CanvasNodeInspector.tsx` e componentes Canvas.

## Correções desde a revisão anterior

- `src/shared/agent-provider-contract.ts` — contrato compartilhado de providers first-class unificado entre main, renderer e testes.
- `WorkspaceCanvas.tsx:843` — erro de tipo corrigido (edição concorrente Antigravity).
- `ai-memory-launcher.test.ts:188` — tuple typing corrigido.
- `resolveExecutableForRust` — NÃO monta cmd.exe /c para .cmd/.bat (v2.4.0 aceita scripts diretamente ou resolve .exe irmão).
- `ai-memory-service.ts` — correções P1/P2 (fetch abortável com timeout, discovery com pule de versão incompatível, remoção de zip com hash divergente, adoção de externo em corrida de porta).
- Doctor IPC: owned CLI com `--data-dir`, não-owned via `health()`.
- `AiMemoryModal.tsx`: toggle rollback defensivo, tratamento de estados desativados sem vazio silencioso, parsing seguro de envelopes IPC sem HTML perigoso, semântica ARIA completa.
- verify:ui: 57 assertions por viewport (114 no total, delta de +6 por viewport com inspectSharedMemory); inclui validação de fluxos interativos reais (toggle opt-in com rollback/restore, busca MCP e aba legado).
- Diagnóstico de first-run capturado: `memory_status` devolve `-32602: workspace '<w>' not found` em base virgem; client e service aceitam especificamente este erro, o `verifyScope` é confirmado antes do primeiro write e o fluxo foi comprovado com bootstrap oficial via `memory_write_page`.

## Riscos e limitações atuais

- **E2E com binário real e smoke v2.4.0:** smoke executado com sucesso com asset oficial v2.4.0 (Windows x64) em temp dir e porta isolada (49474); teste E2E real validado em `tests/ai-memory-real-scope-e2e.test.ts` (1/1 passing com binário oficial v2.4.0 e `buildAiMemoryHelperEnv`; suíte unitária de `tests/ai-memory-client.test.ts` mantida em 24/24). Client e service aceitam somente o erro canônico `-32602` de workspace ainda não criada, e o `verifyScope` opera normalmente antes do primeiro write.
- **Provisionamento e conectividade no first-run:** Sem o binário do sidecar pré-instalado em cache local ou empacotado em resources, o provisionamento inicial faz download sob demanda do GitHub Releases oficial; é necessária conexão com a internet na primeira execução (sem garantia de operação offline sem pré-provisionamento).
- **Limitação residual de Windows Job Object (P2 #5):** sem suporte nativo a `KILL_ON_JOB_CLOSE` no runtime Electron/Node; encerramento limpo via `stopTerminalAsync`/`before-quit` sem dependências nativas C++. Risco residual de processo órfão restrito a encerramento anormal ou forçado do host (`taskkill /F`).
- **Verificador de atualizações in-app (limitação preexistente):** O verificador in-app exige GitHub token (`GH_TOKEN`/`GITHUB_TOKEN`) ou autenticação prévia via `gh auth login` para checagem automatizada na API do GitHub; o repositório e os assets públicos permitem download manual direto, não constituindo bloqueio para a release.
- **Publicação e workflow pendentes (release não concluída):** Source e package gates validados com sucesso (`release:check` 1.0.42, `dist` Windows x64 e `smoke:package` 6/6 no v1.0.42); a publicação no GitHub, criação de git tag e execução de workflows de release permanecem pendentes pelo coordenador (release **não concluída**).
- **Limpeza scratch temp no smoke:ipc (P3):** warning residual de EPERM na remoção do diretório temporário no Windows é não bloqueante e não afeta os 104 métodos nem o exit code estrito (exit 1 em caminho negativo induzido).
- **memory.json real-shape correction (implementado):** coberto e validado em `tests/ai-memory-migration.test.ts:457-581` (envelope `StoredMemory` v1 `{ version: 1, entries }`, arrays legados, tolerância a dados corrompidos/versões futuras, namespaces e migração idempotente com receipt) e gate read-only sem dual-write em `src/main/project-hybrid-memory.ts:70-79`.
- **Doctor/harness headless/redaction:** implementados e testados com mocks; sem validação com harness real.
- **Gemini hooks/MCP:** `ai-memory-agent-setup.ts` implementa setup; sem teste integrado com binário real.
- **verify:ui interativo:** 57 assertions por viewport (114 no total) exercitando fluxos interativos reais (toggle opt-in com rollback/restore, busca MCP com query, inspeção condicional da aba legado); cobertura complementar pelas suítes Vitest.
