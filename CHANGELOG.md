# Changelog

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
