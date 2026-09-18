# Changelog

All notable changes to DevOrbit are documented here.

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
