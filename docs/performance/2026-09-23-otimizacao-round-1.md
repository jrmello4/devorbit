# Performance — Rodada de otimização 2026-09-23

Auditoria Deep Audit (skill performance-engineering) sobre DevOrbit 1.0.36 WIP.
Método: 3 explorações estáticas paralelas (main, renderer, packaging) → baseline
(1014 testes verdes) → implementação por fronteiras de arquivo → gates integrados.

## Baseline (antes)

- typecheck + `npm test`: 1014/1014 verdes.
- Renderer: 1.003.888 B de JS raw (2 chunks) + 187.286 B CSS.
- `dist-electron/main/index.js`: ~449 KB. `app.asar` empacotado: 44.006.574 B.
- Nada em runtime foi profilado nesta rodada: achados são Observed (código),
  impactos estimados. Próxima rodada pode medir com app aberto.

## Mudanças aceitas (todas com testes verdes pós-mudança)

### Renderer — fluidez (WorkspaceCanvas e afins)
1. Gestos (pan/drag/resize) coalescidos por `requestAnimationFrame`: o
   `pointermove` só guarda coords; a matemática roda 1× por frame; o `finish`
   aplica o delta final (nada se perde). z do nó sobe 1× por gesto (`zTop`),
   não a cada move.
2. Loop App↔Canvas quebrado: `onSelectionChange` só notifica quando a
   assinatura (id|kind|title) muda; `onConnectionsChange` só quando a topologia
   muda. Antes, cada move re-renderizava o App inteiro.
3. `React.memo` do `CanvasNodeCard` volta a funcionar: ~10 closures inline do
   loop de nós viraram `useCallback` estáveis; `sendPolicyFor`/`sendDisabledFor`
   (O(nós+arestas) por nó por render) viraram um Map memoizado.
4. Persistência nunca mais dentro de gesto: `zoomAt`/`moveFromMinimap` usam o
   debounce de 160ms (eram `localStorage.setItem` síncrono por evento);
   `finishMinimapNavigation` faz `flush()`.
5. Minimap lê tamanho de um ref (ResizeObserver) em vez de
   `getBoundingClientRect()` no corpo do render (forced reflow por frame).
6. CSS: animação de fluxo das arestas pausada durante pan/drag;
   `backdrop-filter: none` durante gesto (radial options + view HUD).
7. xterm: URL detectada só na cauda de 2KB do snapshot (era regex sobre 40KB
   por chunk).
8. IntegratedWorkspace: drag de splits com rAF; layout persistido com debounce
   300ms; `updateBounds` (WebContentsView) com trailing rAF e sem recriar
   observers por frame.
9. `onDirtyChange` estável por projeto no App; timers de feedback em
   ProjectCard/CodexAuthModal/AiMemoryModal limpos no unmount; `agentTasks`
   podado na entrega do resultado.

### Main process — CPU/I-O
10. Health de provedores com cache TTL (120s ready / 300s missing), opt-in via
    `{ useCache: true }` — só o timer de readiness usa; turnos continuam
    frescos. Elimina ~24 spawns de `where.exe` + centenas de `stat` por minuto
    quando há CLIs ausentes. Chamada inicial movida para depois de
    `createWindow()` (boot não compete com probing de PATH).
11. PTY: chunks de saída coalescidos por terminal (janela de 16ms, primeiro
    chunk da rajada síncrono; flush imediato >64KB; exit/resize/stop fazem
    flush antes). Milhares de IPC/s passam a ser 1 IPC por frame.
12. `AuditLedger`: `mkdir` 1× (re-tentativa em ENOENT) e teto de 8MB com
    reescrita atômica mantendo cauda de ~1MB (observability.jsonl crescia sem
    limite). Sem buffering (contrato append→read dos testes preservado).
13. Scan de uso: `usageScanTimer` com `unref`; `stat` único por arquivo e skip
    de `readJsonlTail` quando offset+mtime não mudaram; carimbo `mtimes`
    opcional no `UsageScanState`, semeado/persistido pelo `UsageStore`
    (retrocompatível); poda conservadora de offsets inexistentes (ENOENT).
14. Updater: token do `gh` cacheado (positivo por processo; negativo TTL 10min)
    — sem spawn de `gh auth token` por ciclo de retry.
15. Shadow routing metrics: flush de 30s só quando dirty; `stop()` faz flush
    final.

### Packaging — disco/memória de instalação
16. `dependencies` de produção reduzidas a `node-pty` + `electron-updater`
    (externals reais do main). Renderer/main deps movidas para
    `devDependencies`; `clsx` e `tailwind-merge` removidos (zero uso). O Vite
    continua bundleando tudo em build time.
    **app.asar: 44.0 MB → 4.2 MB (−90%); win-unpacked: ~419 MiB → ~381 MiB.**

## Medidos vs. estimados
- Medido: tamanhos de asar/win-unpacked/bundle; suítes de teste.
- Estimado (Observed→Hypothesis): ganhos de frame time em drag (1–3), CPU idle
  (6, 10, 14, 15), I/O (12, 13). A próxima rodada deve medir com o app
  rodando (scenario: drag com N nós; idle CPU 60s; output de PTY verboso).

## Validação final integrada (estado combinado)
- `tsc --noEmit` (app e testes), `eslint --max-warnings=0`, build: limpos.
- `npm test`: 102 arquivos / **1014/1014** verdes. `npm run verify:bridge`: 68/68.
- `npm run verify:ui` (app real Electron, dist novo): todos os PASS — drag,
  multi-seleção, pan, zoom, conexões, resize, orquestração, web panel.
- Bundle: dist 1.191.932 → 1.196.468 B (+0,4% — custo do coalescing/memoização);
  dist-electron 455.300 → 461.457 B; main 455,55 kB gzip 121,61 kB.

## Dívida/pendências conscientes (não feitas de propósito)
- Batching no ledger (perda de N linhas em crash) — avaliar depois.
- `renderAgent`/`workbench` inline do IntegratedWorkspace ainda mudam de
  identidade por render (inofensivo hoje: o workspace não re-renderiza em
  gesto).
- Gesto de resize não tem classe CSS própria (pausa de animação cobre
  pan/drag).
- `release/` com ~3,3 GB de instaladores antigos (1.0.12–1.0.36) — limpeza
  manual recomendada, não automatizada aqui.
- OTLP sem batching (só relevante com DEVORBIT_OTLP_ENDPOINT configurado).
