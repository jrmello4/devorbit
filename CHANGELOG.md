# Changelog

All notable changes to DevOrbit are documented here.

## [1.0.38] - 2026-09-23

### Fixed

- Canvas card gear now opens the side Inspector; the legacy inline agent config (role/provider inside the card) was removed, so the panel no longer duplicates or blocks the terminal.
- Expanding and collapsing a canvas card works in any state: expanding shows the terminal and collapsing minimizes it again.
- Connection ports stay hidden until the card is hovered, focused, selected or being connected.

### Changed

- Canvas gestures (pan/drag/resize), connection drafts and minimap navigation are coalesced per animation frame, and card handlers are stable so React.memo works, cutting per-frame re-renders.
- Main process: provider health cache, PTY output coalescing, audit ledger size cap and single-stat usage scans reduce steady-state CPU and I/O.

## [1.0.37] - 2026-09-23

### Added

- Workspace Canvas as a command center: compact agent/terminal/note cards show identity, role, current task, provider and real status, with a contextual Inspector for nodes and squads.
- Simplified canvas toolbar with focus mode, zoom presets and grouped creation/selection actions.
- Squads as first-class entities independent of notes: free member count (2, 3, 5+), custom roles, optional/configurable coordinator, collapse/expand, automatic layout and coordinator-to-specialist connections.
- Squad creation dialog with quick templates, a dynamic participant list and explicit coordinator selection.

### Changed

- Canvas edges carry semantic kinds and labels (delegation, context, dependency, membership); focus mode dims unrelated nodes without changing the structure.
- Canvas state v5 with migration from v2-v4, preserving existing nodes, edges and squads.

### Fixed

- Removing the last member of a squad is blocked with a clear hint.
- UI verification follows the new zoom control label.

## [1.0.36] - 2026-09-22

### Added

- Responsive Projects library with grid as the default, an optional list, compact filters, contextual actions, and independent project tabs.
- Canvas radial menu for quick access to creation actions.
- Compact navigation rail and permanently dark DevOrbit theme.

### Fixed

- Project action menus remain available in the mobile list and grouped views; the filter popover stays inside narrow windows.
- Finalizing a project retains the full removal warning and prevents duplicate execution while busy.

## [1.0.35] - 2026-09-22

### Changed

- Project library architecture: Projects screen is a visual folder-grouped grid (Drive-style, no fixed detail pane, no external brand assets). Clicking a card opens its own `project-tabs` view with a full-width ProjectCard, breadcrumb/back, and independent open/close tabs (separate from workspace tabs). Local install only (no commit/push/tag/release).

## [1.0.34] - 2026-09-22

### Changed

- Visual redesign of the shell and sub-screens: shared spacing/radius/typography tokens, collapsible workspace tool groups with a single primary action, and aligned Usage/Audit/Canvas panels. Local test build only (no publish).

## [1.0.33] - 2026-09-21

### Added

- Smart Terminals: canvas terminal nodes with Quick Deploy presets (Shell, Codex, Claude Code, OpenCode, Antigravity, custom), persistent startup command, smart restart with configurable behavior (relaunch, resume, plain shell), per-node workspace/custom cwd, autoStart, activity monitor states and "save as preset" — presets are data, resolved through the existing provider start paths.
- User-defined terminal presets persisted in `config.json` (`terminalPresets`) with strict sanitization; `devorbit:startTerminal` gained optional `{command, args, cwd}` options with cmd-safe validation and Windows script wrapping (`terminal-launch.ts`).
- Per-model usage tracking: usage event store (`userData/usage`), agent turn/session recording, llm-router token capture, incremental local token adapters for Claude transcripts, Codex rollouts (interactive `token_count` included) and OpenCode SQLite storage, plus Claude OAuth quota polling with aggressive throttling; Usage panel share view with day/week/all windows and quota chips.
- Command palette `C` then `D` opens the new-terminal Quick Deploy flow.

### Fixed

- Custom presets can be cleared via `devorbit:saveConfig` with an empty list (explicit clear instead of a no-op).
- Canvas state migration to v4 preserves every existing node field; only the terminal config is normalized.

## [1.0.32] - 2026-09-19

### Added

- Multi-provider orchestration continuity with persisted checkpoints, deterministic role handoff, quota-aware Codex fallback, circuit breakers and an accessible canvas kill switch.
- Authenticated private GitHub updater diagnostics and portable release manifest generation.
- Agent bridge hardening, richer IPC coverage and production smoke checks for NSIS, portable and MCP assets.

### Fixed

- GitHub updater credentials no longer enter `process.env` or child PTYs.
- Provider handoffs resume the next action from the saved checkpoint without duplicating turns or stopping active agents.
- Portable releases now publish `latest-portable.yml` alongside the NSIS update manifest.

## [1.0.31] - 2026-09-19

### Added

- Secure BYOK configuration storage: provider API keys are encrypted at rest with the OS keychain (`safeStorage`) when available and are never returned to the renderer, which now receives only `has*Key` presence flags. Legacy plaintext keys in `config.json` are migrated automatically.
- Provider routing now exposes the fields required by the LLM providers (DeepSeek, GLM, Kimi, MiniMax, vLLM, Ollama and optional per-provider base URLs) in Settings.

### Changed

- `devorbit:getConfig`/`devorbit:saveConfig` return a secret-free projection; `exportConfigJson` no longer writes credentials.
- CI quality job now runs `audit:tokens`, `audit:repository` and `release:check`.

## [1.0.30] - 2026-09-18

### Added

- Hero Ops phases 3-5: node identity with Lucide icons, role/status metadata, coordinator mark and accessible agent configuration; squad regions derived from existing canvas data; Carbon design system propagated to the shell, Git dock, command palette, integrated workspace, modals and panels.
- Shared ECMA-48 cleaner for PTY output covering CSI (7/8-bit, colon/private parameters), OSC, DCS/SOS/PM/APC and truncated escapes.

### Fixed

- `DEVORBIT_RESULT` parsing no longer rejects legitimate frames decorated with heavy ANSI and treats long markerless lines as noise.
- Transient error classification and TypeSafe shadow state sanitization no longer leak terminal escape sequences.
- Runtime verification disables GPU in the harness and reports `child-process-gone`/`did-fail-load` diagnostics instead of timing out.

## [1.0.29] - 2026-09-17

### Added

- Local agent bridge with authenticated named-pipe and Unix-socket transports.
- Structured delegation events, process execution controls and ripgrep indexing.
- Deterministic validation commands for tokens, bridge behavior and release metadata.

### Fixed

- Agent turn result waiter race during immediate PTY responses.
- Provider resolution consistency for Antigravity.
