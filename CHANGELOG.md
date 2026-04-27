# Changelog

## [0.1.12] - 2026-04-27

### Fixed
- Detection engine: state fallback — `onIdle` handles ASKING→IDLE, `onAsking` handles IDLE→ASKING, preventing sessions stuck in wrong state
- Detection engine: removed probe verification that sent space to confirm IDLE (Codex shows `tab to queue` even when idle, causing infinite RUNNING loop)
- Detection engine: probe residue cleanup — clear lingering `tab to queue` with Ctrl+U before re-detecting

### Added
- Codex `onInit`: handle model migration prompt (`Try new model` → select "Use existing model")

## [0.1.11] - 2026-04-26

### Added
- `check --wait <state>` — poll until session reaches target state, with optional `--timeout` and `--output <type>`
- `sessions --status <state>` — filter sessions by state (IDLE, RUNNING, ASKING, CLOSED)
- `sessions` now includes closed (disk-only) sessions with adapter, cwd, and created_at
- `delete --closed` — batch delete all closed sessions
- `delete --all` — close active sessions and delete all
- Debug viewer shows all sessions including CLOSED; active session links open in new tab
- Role prompt `[subagent-cli]` prefix — sessions created by subagent-cli are identifiable in `claude -r` and `codex resume` lists
- Codex default config uses `gpt-5.4` model
- npm keywords for search discoverability

### Changed
- README rewritten: user-facing Quick Start, Use Cases, Integrate with Your AI Agent (3 skill templates)
- Removed all Gemini CLI references (not supported, no SDK planned)
- CLI help text updated with `check --wait` and `delete --closed/--all` examples

## [0.1.10] - 2026-04-22

### Added
- `--force` / `-f` flag for approve/reject/allow — skip internal state check, send key regardless
- `auto` command — toggle auto-approve mode for session
- `allow` description: "Approve via option 2. Scope depends on target CLI"

### Fixed
- Detection engine: probe verification prevents false IDLE during brief gaps between tool calls
- Codex e2e: assertCheck auto-approves when stuck in ASKING; reject timeout increased

## [0.1.9] - 2026-04-22

### Added
- `--force` / `-f` flag for approve/reject/allow — skip internal state check, send key regardless
- `auto` command — toggle auto-approve mode, all subsequent approvals confirmed automatically
- `allow` description clarified — "Approve via option 2", scope depends on target CLI

### Fixed
- Detection engine: probe verification — when IDLE detected while RUNNING, send probe+Ctrl+U to confirm truly idle before transitioning (prevents false IDLE during tool gaps)
- Detection engine: probe cleanup — clear probe residue (`tab to queue`) via Ctrl+U and re-detect before IDLE transition
- Codex adapter: restore probe mechanism with `tab to queue` in running_words, preventing false IDLE during streaming
- Codex adapter: IDLE check before `Update available` in onInit — v0.121.0 update banner is non-interactive
- Codex e2e: assertCheck auto-approves when ASKING while waiting for IDLE; reject timeout increased

## [0.1.8] - 2026-04-22

### Fixed
- Detection engine: add `flush()` before `capture()` to ensure xterm buffer has latest PTY data
- Codex adapter: add `· /` to match_words/idle_words for Codex v0.121.0 (status bar no longer shows `% left`)
- Codex adapter: Phase 2 (role prompt) uses independent polling instead of detection engine, fixing init stuck on RUNNING
- Codex adapter: IDLE check before `Update available` — v0.121.0 update banner is non-interactive
- Detection engine: probe cleanup — when only `tab to queue` remains (no `esc to interrupt`), clear probe via Ctrl+U and re-detect to confirm true IDLE

## [0.1.7] - 2026-04-20

### Fixed
- Detection engine: add `flush()` before `capture()` to ensure xterm buffer has latest PTY data
- Codex adapter: add `· /` to match_words/idle_words for Codex v0.121.0 (status bar no longer shows `% left`)
- Codex adapter: `onInit()` sends probe to trigger TUI render when buffer is empty
- Codex adapter: Phase 2 (role prompt) uses independent polling instead of detection engine, fixing init stuck on RUNNING with Codex v0.121.0

## [0.1.6] - 2026-04-08

### Fixed
- `approve()` returns done without effect when approving large file diffs — Ctrl+E collapses the diff panel (`ctrl+e to hide`), removing `"Esc to cancel"` from screen, causing detection engine to falsely detect IDLE
- `getQuestion()` now toggles explain panel closed after capture, restoring normal approval screen
- `onIdle()` no longer transitions from ASKING to IDLE — ASKING state can only exit via approve/reject/allow
- Detection engine now flushes xterm buffer and reads visible screen only (not full scrollback), fixing missed state transitions with Codex v0.121.0
- Codex adapter: add `· /` to match_words/idle_words for compatibility with Codex v0.121.0 (status bar no longer shows `% left`)

## [0.1.5] - 2026-04-07

### Added
- `output --type last`: extract last sub-agent reply with TUI chrome stripped
- `PromptResult.output`: prompt/approve/reject/allow done responses now return extracted reply content by default
- `DetectRules.prompt_marker` + `chrome_words`: config-driven output extraction per adapter
- History auto-records `output` entries on task completion

## [0.1.4] - 2026-04-06

### Added
- PTY preflight check: app daemon verifies spawn capability before accepting connections
- Sandbox detection: fast-fail with clear error message instead of hanging forever
- PtyXterm spawn failure tests (valid/invalid command exit codes)

## [0.1.3] - 2026-04-05

### Changed
- Scoped npm package name: `@yejianfei.billy/subagent-cli`
- Added author, license, repository fields to package.json
- Updated LICENSE copyright year to 2025-2026
- GitHub Release now shows CHANGELOG content
- Added `fetch-linux` script for npm publish with cross-platform binaries
- Added `npm version` hooks for automated release workflow

## [0.1.2] - 2026-04-05

### Fixed
- Linux release now includes `spawn-helper` binary (compiled from source in CI)
- Version number auto-injected from `package.json` via webpack DefinePlugin

### Added
- `npm version` hooks: pre-check lint/build/test, enforce CHANGELOG entry, auto-push tags

## [0.1.1] - 2026-04-05

### Fixed
- Linux release missing `spawn-helper` binary
- Linux CI failing due to missing `pty.node` prebuild

### Added
- ESLint flat config (ESLint 9 + TypeScript)
- `.editorconfig` for consistent editor formatting
- GitHub Actions CI (Node 18/20/22 × macOS/Ubuntu)
- GitHub Actions Release workflow (auto-build platform tarballs on tag)
- `npm run clean` script
- `files` field and `prepublishOnly` script for npm publish readiness
- Bash wrapper script in release tarballs (`./subagent-cli` instead of `node cli.js`)

### Removed
- Unused `VirtualScreen` class (`src/screen.ts`)

### Changed
- Silenced webpack warnings for ws optional deps (`bufferutil`, `utf-8-validate`)
- Fixed README clone URL placeholder

## [0.1.0] - 2026-04-05

Initial release.

- Three-layer architecture: CLI → App daemon → Session (Adapter + PtyXterm)
- Claude Code adapter with session ID acquisition via exit/resume cycle
- Codex adapter with startup dialog handling and probe detection
- State machine: OPENING → INITING → IDLE → PENDING → RUNNING → ASKING
- Detection engine: 1s polling with priority-based keyword matching
- Full approval flow: approve / reject / amend / allow-all
- Session persistence and resume support
- Built-in web debug viewer (xterm.js + WebSocket)
- Idle monitoring with configurable auto-close and auto-exit
