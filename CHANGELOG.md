# Changelog

## [0.1.21] - 2026-05-29

### Fixed

- **Claude Code adapter stalled at init in auto/plan mode** — Claude Code v2.1.145 added two input modes (auto mode, plan mode) whose footer reads `(shift+tab to cycle)` instead of the old `? for shortcuts` / `accept edits`. The adapter's `idle_words` didn't recognize them, so detection never reached IDLE. Now `idle_words` includes `shift+tab to cycle`, covering normal / auto / accept-edits / plan modes. (Surfaced with the `deepseek` subagent under a global `defaultMode: auto`.)
- **Codex adapter spawned runaway sessions on init** — Codex 0.135's update-available dialog text lingered in scrollback; `onInit` captured the full scrollback, so a dismissed "Update available" kept re-matching and sent ↓+Enter onto the following trust dialog, selecting "No, quit" → Codex exited → reopened in a loop. `onInit` now reads the visible screen only.
- **IPC window header inconsistency stranded sessions** — `request()` stamped `X-Subagent-Cli-IPC` whenever `SUBAGENT_VSCODE_IPC` env was set, even if the socket was unreachable, while `open()` only binds a window via `shouldUseIPC()` (real socket reachability). With a stale env (extension closed / headless CLI), `open` went plain-HTTP (no window) but follow-up requests carried the header → daemon filtered the unbound session out → `status` 404 → callers reopened endlessly. Header injection is now gated on `shouldUseIPC()`, matching `open()`. Socket-reachable (live extension) behavior is unchanged.

### Changed

- Default Codex model `gpt-5.4` → `gpt-5.5` (config defaults + README).

### Tests

- `detect.test.js`: added auto/accept-edits/plan mode IDLE detection regression cases.
- E2E suites isolate the VS Code IPC bridge (`SUBAGENT_VSCODE_IPC`/`UUID` unset) — headless tests must not route through the editor extension.
- Verified: 175 unit, Claude e2e 69/69, Codex e2e 42/42; deepseek manual (init + IDLE).

## [0.1.20] - 2026-05-25

### Fixed — WebSocket window-auth wrongly rejected multi-segment uuids

- **`/ws?client=` ownership check dropped the pid segment of the new socket naming, closing the connection with 4003 `WINDOW_MISMATCH`.** `parseIpcUuid('subagent-cli_<hash>_<pid>.sock')` returns `<hash>_<pid>` (the regex treats `_` as a valid uuid char), but the WS check derived the client uuid via `clientId.split('_')[0]` → only `<hash>`. `<hash>` ≠ `<hash>_<pid>` rejected every legitimate connection from a window using the `_<VSCODE_PID>` naming, and an extension that disposes its terminal on ws-close saw the panel created then instantly destroyed. Now strips only the trailing `_<counter>` via `clientId.replace(/_\d+$/, '')`, preserving the full uuid — compatible with both old (`<hash>_001`) and new (`<hash>_<pid>_001`) client ids.

### Added — IPC socket glob fallback by VSCODE_PID

- **CLI now discovers the VS Code extension's IPC socket via glob when `SUBAGENT_VSCODE_IPC` is missing.** This happens when the CLI is spawned by another extension (e.g. Claude Code) whose host snapshotted env before our extension injected the var, leaving the session in standalone mode (no auto-opened editor terminal). New three-step degradation chain in `shouldUseIPC()`:
  1. `SUBAGENT_VSCODE_IPC` env, if set and reachable → use it (fastest, unchanged).
  2. else glob `<os.tmpdir()>/subagent-cli_*_<VSCODE_PID>.sock`, probe each, take first reachable.
  3. neither → standalone (HTTP) mode, no regression.
- `VSCODE_PID` (editor main-process pid) is the window identity: unique per window, inherited by all spawned children, stable across window reload. The workspace-hash segment is wildcarded, so the CLI needs no workspace knowledge — only the `_<VSCODE_PID>` suffix is matched exactly (a leading underscore guards against pid-substring collisions).
- A discovered path is written back to `ipcPath` so the IPC handshake and the `X-Subagent-Cli-IPC` request header target the same window.
- **Windows:** Named Pipes are not on the filesystem, so glob is skipped (env path only).
- New `probeSocket()` helper (Unix socket / Named Pipe reachability, 200ms) and exported `discoverIpcByVscodePid()` for testing.

### Fixed — `--cwd` always stored as absolute path

- **`subagent-cli open --cwd <dir>`** now resolves the argument with `path.resolve()` before sending to the daemon, so the session's `cwd` field is always an absolute path regardless of whether the user passed `.`, `./foo`, or an absolute path. Previously the literal string (e.g. `"."`) was persisted, making it impossible for viewer / VS Code extension / cross-terminal listings to identify the real working directory.
- **`subagent-cli sessions --cwd <dir>`** filter side is resolved symmetrically — `--cwd .` still matches new sessions whose stored cwd is the absolute form.
- Old sessions created before this release keep their existing literal cwd in `~/.subagent-cli/sessions/<id>/config.json`; they continue to work but display the original string. Close and reopen to refresh.

## [0.1.19] - 2026-05-21

### Fixed — sub-agent startup error visibility

- **Surface CLI startup errors instead of silently waiting 120s for timeout.** When the underlying CLI (codex / gemini) rejects its arguments (e.g. stale `resume <UUID>` no longer recognised) it prints an error and exits immediately, but the adapter used to keep polling for "% left" / "Type your message" until `READY_TIMEOUT`. Now:
  - **`terminalExited` flag** on `SubagentCliAdapter` is set synchronously inside `terminal.on('exit')`, before the async cleanup runs.
  - **New `throwIfExited(stage)` helper** captures the last 20 lines of screen content and throws `SUBAGENT_EXITED_DURING_<stage>` so the actual CLI error reaches the HTTP caller.
  - **`exec()` now races `event` against `unexpected-exit`** — if the PTY dies while waiting for `ready` / `done`, the promise rejects immediately with the screen tail.
  - `CodexAdapter.onInit` / phase-2 init loop and `GeminiCliAdapter.onInit` / phase-2 init loop both call `throwIfExited` each tick.

### Added — Codex 26.5+ "Hooks need review" auto-skip

- Codex's new startup dialog (`Hooks need review` → `1. Review hooks / 2. Trust all and continue / 3. Continue without trusting (hooks won't run)`) blocks subagent startup. `CodexAdapter.onInit` now detects this screen and picks option 3 (↓↓+Enter) — sub-agent proceeds without trusting unknown hooks. Existing `Do you trust the contents` directory-trust auto-confirm is unchanged.

## [0.1.18] - 2026-05-15

### Added — viewer & API alignment for VS Code extension

- **`cli open --cwd` defaults to `process.cwd()`** when omitted (previously sent `undefined`, leading daemon to fall back to its own working directory — `/` under VS Code extension host). The help text "default: current dir" is now actually true.
- **`SessionStatus.role`** is now a required `string` field (empty string when no role). `adapter.status()` / `adapter.check()` always return it; `GET /api/sessions` propagates it for both active and closed entries. No more `undefined` leaking to JSON consumers.
- **Session `last_at` timestamp** — every session entry (active + closed) carries a ms-precision "last meaningful activity" time, derived **on demand from the mtime of `history.md`**. The file is only touched when a real interaction is recorded (prompt / approve / sub-agent reply), so TUI cursor blinks / status-bar refreshes don't pollute it. No persistence/maintenance of the field is needed; the filesystem is the source of truth.
- **`persistSession()` is now merge-aware** — reads existing `config.json` before writing so `created_at`, `resume_id`, `ipc_path`, `role` survive partial updates. Fixes a long-standing **role-persistence bug**: previously `OpenParams.role` existed but was never written to disk, so closed sessions lost their role.
- **`/viewer` index page** rewritten as a six-column table (`Subagent` / `Session` / `CWD` / `Role` / `Last activity` / `State`) matching the VS Code extension webview. HTML-escaped user content, a `↻` refresh button right-aligned in the header (hover background), 5-second auto-refresh that only fires while `document.visibilityState === 'visible'`, and JS-side relative-time rendering (`Xs/m/h ago`) that ticks every second. State column uses colored pill badges per `AgentState`.
- **`open` flow now propagates `role` across all session lifecycles** — both the reuse path (line ~186) and the explicit resume-by-id path (line ~355) were silently rebuilding `OpenParams` without `role`. After the fix every path (new / reuse / resume) reads `saved.role` from the on-disk config so `adapter.params.role` stays populated. Old closed sessions whose `config.json` was written before this release have no role on disk — they intentionally display empty rather than fall back to today's `subCfg.role` (which may have diverged).
- **`src/viewer_template.ts`** — HTML templates (`VIEWER_HTML`, `renderViewerIndex`, `renderSessionRow`, `escapeHtml`) extracted from `app.ts` into a dedicated module so routing/lifecycle code stays compact and the markup can iterate independently.

### Added — Window-scope IPC scaffolding (for upcoming VS Code extension)

Foundation for multi-window isolation, validated via mock IPC harness — no real extension integration yet. Backwards-compatible: when no `SUBAGENT_VSCODE_IPC` env / `X-Subagent-Cli-IPC` header is present, all behaviour matches v0.1.17.

- **`OpenParams.ipc_path`** — optional field stamping a session with the originating window's IPC socket path. Persisted in `~/.subagent-cli/sessions/<id>/config.json` and restored on resume.
- **`SUBAGENT_VSCODE_IPC` / `SUBAGENT_VSCODE_UUID` env injection** — when a session is opened with `ipc_path`, the spawned sub-agent process receives both vars so recursive `subagent-cli` calls inside the sub-agent route back to the same window.
- **`X-Subagent-Cli-IPC` request header** — `SubagentClient` automatically attaches it in VS Code mode; daemon uses it to enforce per-window access.
- **Window ownership middleware** in App daemon — asymmetric privilege model:
  - **Header-less caller** (CLI / curl / scripts) = **admin**: full access to every session including window-bound ones (`/api/session/:id/*`, `GET /api/sessions`, batch `close` / `delete --closed` / `delete --all` all see and act on the entire registry).
  - **Header-set caller** (a VS Code extension) is sandboxed to its own window: routes return 403 `WINDOW_MISMATCH` on cross-window single-session access; list/batch routes only include sessions whose `ipc_path` matches the header.
  - `tryReuseSession` — reuse candidates strictly matched by `ipc_path` to prevent cross-window leakage (no admin override here — reuse is an open-time UX choice, not an audit operation).
- **WebSocket `/ws?session=X&client=Y`** — when a `client` is supplied, its UUID prefix must match `session.ipc_path`'s UUID, else close 4003 `WINDOW_MISMATCH` (isolates other windows' extensions). A clientless connection (browser `/viewer`) is allowed through so PTY broadcast stays visible on both ends. Global sessions remain accessible without `client`.
- **IPC handshake (CLI ↔ extension)** in `SubagentClient`:
  - `shouldUseIPC()` — env probe with 200ms socket-reachability check (orphan env falls back to HTTP mode)
  - `ipcCall(method, params)` — length-prefixed JSON-RPC over Unix socket / Named Pipe
  - `open()` — `prepareTerminal` → HTTP `/api/open` (with `ipc_path`) → `attachSession`
- **Exported `parseIpcUuid()`** from `dist/app` so tests and downstream code can extract the canonical UUID from a socket path.

### Refactored

- **Daemon management moves into `SubagentClient`** as a factory + instance method shape. `SubagentClient` is the SDK that bridges CLI args and HTTP; `cli.ts` is now a thin parser/dispatcher.
  - `SubagentClient.getInstance({ port? })` — async factory that ensures the daemon is running and returns a ready-to-use client. Forks if needed; returns immediately with `startResult()` recording `started` vs `already_running`.
  - `SubagentClient.status()` — static, side-effect-free daemon query (read info + probePort). **Never forks.** Kept as a static method because `getInstance` cannot represent "diagnose without starting".
  - `client.stop()` — instance method that gracefully shuts down the daemon via `POST /api/shutdown` (5s probe loop). Never forks.
  - SDK consumer flow becomes: `const c = await SubagentClient.getInstance(); await c.open(...); await c.stop()` — two-step daemon lifecycle for embedded usage.
  - **Removed `src/daemon_lifecycle.ts`** — its helpers were absorbed as module-private functions in `client.ts` (where the complexity lives: fork, probe, parse, auto-clear). The daemon side (`app.ts`) writes/clears its `daemon.pid` registry file with two direct `fs` calls — no shared module needed for two writes. The `<pid>,<port>` string format is the only contract between the two bundles.
- **`readDaemonInfo()` now returns liveness, not raw state.** The file is read, parsed, and the recorded pid is checked with `isProcessAlive` in one step — stale entries (missing/malformed file, dead pid) are auto-unlinked and `undefined` is returned. Callers stop combining `readDaemonInfo + isProcessAlive` and stop manually clearing stale info:
  - `SubagentClient.getInstance/status/stop` and `client.ts ensureManager()` all do a single `const live = readDaemonInfo()` check.
  - Single source of truth for "is there a live daemon?" — the daemon info file (`~/.subagent-cli/daemon.pid`).

### Tests
- New `test/ipc.test.js` — 15 tests covering `parseIpcUuid`, ownership middleware, batch route filtering, WebSocket client check, and full IPC protocol (length-prefix framing, handshake)
- 189 unit tests total (174 → 189), all passing

## [0.1.17] - 2026-05-13

### Added
- **`open --reuse`**: skip session creation by reusing existing IDLE/CLOSED session matching `cwd + subagent + adapter`. Combines with inline `[text]` for one-shot reuse + prompt:
  ```bash
  subagent-cli open -s gemini --cwd . --reuse "code review this file"
  ```
- **`idle.reuse_ratio`** (default `0.5`): cooldown ratio — active IDLE session must be idle for at least `idle.timeout * reuse_ratio` seconds before being reusable (prevents race conditions when other callers may be about to use it)
- **`idle.fast_reuse`** (default `false`): when `true`, `--reuse` becomes default for all `open` commands. Pass `--no-reuse` to opt out
- Response field `reused: true` when an existing session was reused
- **Recursive subagent-cli self-protection** — prevents a sub-agent from reusing or controlling its own session when it calls `subagent-cli` recursively:
  - Daemon injects `SUBAGENT_CLI_SESSION=<id>` env into each session's PTY
  - Client auto-passes `exclude_session` on `open` so reuse never returns the caller's own session
  - `RECURSIVE_SELF_REFERENCE` (400) returned client-side when any `--session <id>` command (`open/prompt/approve/reject/allow/auto/status/check/output/cancel/exit/close/delete`) targets the caller's own session

### Priority

`open` resolution order (highest first):
1. `--session <id>` present → reuse that session
2. no `--session`, `--reuse` present → reuse by `cwd + subagent`
3. no `--session`/`--reuse`, `fast_reuse=true` → reuse by `cwd + subagent`
4. otherwise → create new session

Reuse candidate selection (steps 2/3): active IDLE (oldest lastActivity within cooldown window) > disk CLOSED with resume_id (newest created_at) > fall back to create new

### Added — Daemon lifecycle

- **`subagent-cli daemon start|stop|status`** — manage the App daemon explicitly:
  - `start [--port <port>]` — fork the daemon on the given port (defaults to `config.port`). Returns `already_running` if a live daemon (any port) is already recorded
  - `stop` — POST `/api/shutdown` (loopback only) → graceful close, returns `stopped`
  - `status` — `{ running, port, pid }` (port/pid resolved from the daemon info file, not config)
- **Single-instance enforcement**: at most one daemon globally. `start` first checks `~/.subagent-cli/daemon.pid` for a live process (`pid,port` plain text); if alive, refuses with `already_running` — even if `--port` differs
- **`POST /api/shutdown`** — loopback-only HTTP endpoint that triggers a graceful daemon shutdown
- **Daemon info file** (`~/.subagent-cli/daemon.pid`) — plain text `<pid>,<port>` written on start, cleared on shutdown / idle-timeout exit
- **Dynamic port resolution in client**: `SubagentClient` reads the daemon info file first — if a live daemon is recorded on a non-default port (e.g. you started with `daemon start --port 7200`), the client connects to that port automatically

### Refactored

- **`src/daemon_lifecycle.ts`** (new) — shared `probePort` / `forkDaemonAndWait` / `isProcessAlive` / daemon-info file helpers. `SubagentClient.ensureManager()` and the `daemon` CLI command both consume this module (single source of truth for daemon lifecycle)
- **`config.applyHome(home?)`** — apply a home-dir override when an in-memory config is passed without going through `loadConfig()` (fixes test isolation: `app({config: { home: TEST_HOME }})` now actually uses `TEST_HOME` for `getHome()`)

### Tests
- 3 E2E suites: 152 tests total (Claude 69, Codex 42, Gemini 41), all passing
- 174 unit tests (added daemon shutdown / pid-file / process-alive coverage), all passing

## [0.1.16] - 2026-05-13

### Added
- **`open [text]` inline prompt** — pass a prompt directly to `open` for one-shot create + prompt:
  ```bash
  subagent-cli open -s gemini --cwd /tmp "implement a REST API"
  # Returns: { session, status: 'done'|'approval_needed', output, approval? }
  ```
- **Graceful close**: `close` now tries to send the adapter's exit command first (Claude `/exit`, Codex `/quit`, Gemini Ctrl+D×2), waits up to 10s, then SIGTERM, then SIGKILL — gives the CLI a chance to save session state
- **`resume_id` captured at close/exit time** instead of during open — config.json populated when session terminates
- **Unexpected exit detection**: PTY death (crash, external kill) auto-cleans session from memory map and emits `unexpected-exit` event

### Changed
- **Simplified `open` flow**: 5 phases (spawn → init prompt → /exit → parse UUID → respawn) reduced to 2 (spawn → init prompt). Sessions stay alive after open. ~4-5x faster on simple opens
- **`close()` is now async** — callers must await it
- **`SubagentCliAdapter.parseSessionId(output)` hook** — subclasses override to parse resume UUID from exit output
- **`SubagentCliAdapter.getParams()` public** — for persistence updates after exit
- **`PtyXterm.alive` getter** — check if process is running

### Tests
- 3 E2E suites: 138 tests total (Claude 59, Codex 40, Gemini 39), all passing
- 114 unit tests (added 2 for inline prompt), all passing

## [0.1.15] - 2026-05-01

### Added
- **Gemini CLI adapter** (`gemini-cli`) — full support for Google Gemini CLI as a sub-agent
  - TUI detection: `esc to cancel` (RUNNING), `Allow once` / `Apply this change` (ASKING), `? for shortcuts` (IDLE)
  - Exit via Ctrl+D×2 (Gemini CLI has no /exit or /quit command)
  - Session resume via `--resume <uuid>` parsed from exit output
  - Trust dialog and MCP tool approval auto-handling during init
  - Custom `getLastOutput` override: `✦` is AI response marker, `>` is user input marker
  - No probe needed: `esc to cancel` persists during both Thinking and streaming phases
- Default config includes `gemini` subagent entry (adapter: `gemini-cli`, command: `gemini`)
- E2E test suite for Gemini CLI (`test/e2e-gemini.test.js`, 37 tests)
- Detect test coverage for GeminiCliAdapter (12 tests)

### Fixed
- Session directory created before `adapter.open()` to prevent ENOENT when adapter writes history during init
- `SubagentCliAdapter.stopDetection()` changed from private to protected for subclass exit override

## [0.1.14] - 2026-04-29

### Added
- `open --role <text>` — custom role prompt overrides config `role`, used as session title in Claude/Codex to distinguish sessions (new sessions only, ignored on resume)

### Fixed
- Detection engine: capture visible screen only instead of full scrollback — scrollback history contained stale `esc to interrupt` / `tab to queue` causing detect to return RUNNING permanently even when session was idle
- Detection engine: Codex Phase 2 polling relied on `capture(totalLines)` which hit the same scrollback issue — now delegates to detection engine via state check
- `status` and `check` return `state: CLOSED` for disk-persisted sessions instead of 404

## [0.1.13] - 2026-04-28

### Added
- `check --wait` returns `409 APPROVAL_NEEDED` immediately when session enters ASKING, instead of waiting until timeout
- Codex `onInit`: handle model migration prompt (`Try new model` → select "Use existing model")

### Fixed
- Detection engine: state fallback — `onIdle` handles ASKING→IDLE, `onAsking` handles IDLE→ASKING, preventing sessions stuck in wrong state
- Detection engine: removed probe verification that sent space to confirm IDLE (Codex shows `tab to queue` even when idle, causing infinite RUNNING loop)
- Detection engine: probe residue cleanup — clear lingering `tab to queue` with Ctrl+U before re-detecting

### Changed
- README: skill templates rewritten — "Coding Delegation" shows independent development flow, "Independent Review Loop" shows cross-model review with auto-fix cycle

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
- Removed Gemini CLI placeholder references (native adapter added in v0.1.15)
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
