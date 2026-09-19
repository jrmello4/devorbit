# Orquestração entre agentes no DevOrbit (Agent Bridge)

**Data:** 2026-09-17 · **Atualizado:** 2026-09-19
**Status:** Núcleo da bridge implementado (delegação estruturada + headless agy)
**Contexto:** problema identificado ao tentar orquestrar o Antigravity (`agy`) de dentro de um terminal do DevOrbit.

---

## 1. Problema

Um agente CLI rodando dentro de um terminal do DevOrbit (opencode, codex, claude, gemini, aider, agy...) **não consegue orquestrar outro agente**. O processo vive dentro de um PTY e não tem acesso ao IPC do Electron: `window.devorbit.*` existe apenas no renderer (`src/preload/index.ts:78-104`), inalcançável do lado do PTY.

Consequências práticas:

- A única ponte agente→agente é o pipe de PTY do canvas (`src/main/pty-pipe.ts:4`, "padrão Maestri"), que encaminha stdout→stdin, é configurada manualmente por cabos e não suporta pergunta/resposta estruturada.
- A orquestração real é app-driven: `WorkspaceCanvas.tsx:1366-1439` sequencia fases e o app injeta os prompts; o agente não escolhe nem aciona o próximo. O contrato `DEVORBIT_RESULT:` é escaneado pelo app (`src/main/agent-turn.ts:295-359`, `src/shared/agent-result.ts:107-177`).
- O agy (Antigravity) é executado apenas em modo interativo (`src/main/agent-providers.ts:1477` não usa flag de print mode), embora o CLI nativo suporte `--print`, `--output-format json/stream-json`, `--model`, `--agent`, `--effort` e `--mode`.

Efeito prático: hoje um agente no DevOrbit só consegue delegar para outro disparando `agy -p` via shell manualmente. Deveria ser um recurso de primeira classe, disponível para qualquer agente em qualquer terminal, com visibilidade na UI e guardrails.

## 2. Objetivo

Todo agente rodando no DevOrbit deve poder **delegar uma tarefa a outro agente e receber o resultado de forma estruturada**, sem depender de cabos manuais nem de hack via shell — mantendo a UI do canvas como fonte de visibilidade e controle.

## 3. Proposta

### 3.1. Bridge de agente local (`devorbit` CLI + IPC no main)

- Expor no PATH das sessões um binário `devorbit` que fala com o main process via **socket local** (named pipe no Windows), autenticado por token por sessão injetado no env (ex: `DEVORBIT_BRIDGE_TOKEN`, `DEVORBIT_SESSION_ID`).
- Comandos mínimos:

| Comando | Comportamento |
|---|---|
| `devorbit agent list [--json]` | Lista agentes/terminais ativos e estado |
| `devorbit agent send <target> "<prompt>"` | Escreve no PTY alvo via `writeTerminal` (`src/main/terminal-session.ts:130`) |
| `devorbit agent wait <target> --timeout 5m` | Aguarda conclusão reaproveitando o scanner de resultado existente |
| `devorbit agent ask <target> "<prompt>" --json` | send + wait + resultado estruturado |

- Reutilizar o marker `DEVORBIT_RESULT:` como contrato de retorno: status `completed`/`blocked`, resumo e artefatos.
- O bridge deve funcionar para qualquer provider já suportado (`codex`, `opencode`, `claude`, `gemini`, `aider`, `agy`, `custom` — `src/main/agent-providers.ts:34-101`).

### 3.2. Integração plena do agy (Antigravity)

- Mapear flags reais do CLI no provider:
  - `--model` em `PROVIDER_MODEL_FLAGS.agy` (hoje `null`, `src/main/agent-providers.ts:1471-1479`);
  - `--agent`, `--effort`, `--mode` como opções de sessão.
- Adicionar invocação não-interativa (print mode) quando o turno vier de orquestração/app, mantendo o modo interativo para uso manual.
- Garantir parsing de `--output-format json` para retorno estruturado.

### 3.3. Visualização e controle na UI

- Cabos do canvas passam a representar conexões reais do bridge, mostrando delegação em andamento, resultado e status.
- Toda delegação aparece no fluxo da orquestração existente (`planning → specialist → finalizing → complete/blocked`), como qualquer etapa do Coordenador.
- Mencionar no painel de uso/atividade quando uma resposta veio de delegação.

### 3.4. Guardrails

- Token escopado por sessão; socket restrito ao usuário; allow-list por agente.
- Limite de profundidade/ciclos de delegação (anti-loop A→B→A) e auditoria em log.
- Permissão explícita do usuário para delegações de risco (ex: modo accept-edits) configurável no app.

### 3.5. Implementação atual (2026-09-19)

- **Protocolo** (`src/main/agent-bridge.ts`): nova operação `run`, campo opcional
  `origin` e guardrail avaliável/auditável (`evaluateDelegationGuard`,
  `isTargetAllowListed`, `buildDelegationAudit`). O timeout por duração e a
  cadeia `depth`/`visited` continuam iguais.
- **Runtime de eventos** (`src/main/agent-bridge-runtime.ts`): cada delegação
  emite `pending` e o estado terminal com `origin`, `destination`, `depth` e
  `result` (`{ outcome, summary, artifacts? }`). Eventos antigos sem esses
  campos continuam válidos (`src/shared/agent-bridge-event.ts`).
- **Serviço** (`src/main/bridge-service.ts`): respostas estruturadas com
  `status`, `summary`, `origin`, `destination` e `result`; allow-list por id de
  terminal via `BridgeServiceOptions.allowedTargets`; a operação `run` usa o
  runner headless injetado (`runHeadlessTurn`).
- **agy não interativo** (`src/main/bridge-headless.ts`): monta
  `agy --print --output-format json [--model|--mode|--effort|--agent]` e entrega
  o prompt por **stdin** (o texto do usuário nunca entra no argv). Em Windows,
  wrappers `.cmd` passam por `cmd /d /s /c` com apenas o comando e flags
  validados na linha. A saída é interpretada como `DEVORBIT_RESULT:`, JSON ou
  texto, sempre normalizada para `{ status, summary, artifacts? }`.
- **CLI/MCP** (`scripts/devorbit-bridge.cjs`, `scripts/devorbit-mcp.cjs`):
  novo comando `devorbit agent run <target> <prompt> [...]` e a ferramenta MCP
  `agent.run`.
- **Auditoria**: bloqueios de allow-list chamam `onGuard`, persistido no
  `observability.jsonl` como `type: "delegation.guard"`.

## 4. Critérios de aceite

1. Dentro de um terminal do DevOrbit, um agente consegue rodar `devorbit agent ask agy "..."` e receber resposta estruturada sem interação manual.
2. A delegação aparece na UI com origem, destino, status e resultado.
3. O agy aceita `--model` via provider e turnos não-interativos funcionam de ponta a ponta.
4. Loops de delegação são bloqueados (profundidade/ciclo) e há log auditável.
5. Testes: unit para o protocolo do bridge, integração para `send/wait/ask` e smoke no canvas com dois agentes.

## 5. Fora de escopo (por agora)

- Substituir o pipe de PTY existente — ele pode virar uma camada acima do bridge.
- Suporte a rede/multi-máquina: o bridge é local por design.

## 6. Referências de código

- Spawn de PTY: `src/main/terminal-session.ts:85-128`, `src/main/agent-turn.ts:38-80`
- Escrita no PTY: `src/main/terminal-session.ts:130-143`
- IPC validado: `src/preload/index.ts:78-104`, `src/main/index.ts:929-938`
- Pipes entre PTYs: `src/main/pty-pipe.ts:67-150`
- Orquestração no canvas: `src/renderer/src/components/WorkspaceCanvas.tsx:1366-1439`, `:1479-1730`
- Contrato de resultado: `src/shared/agent-result.ts:107-177`, `src/main/agent-turn.ts:295-359`
- Providers CLI: `src/main/agent-providers.ts:34-101`, `:1471-1524`
