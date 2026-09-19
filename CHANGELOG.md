# Changelog

All notable changes to DevOrbit are documented here.

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
