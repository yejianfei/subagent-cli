# subagent-cli

Drive independent coding environments like Claude Code and Codex through headless terminals. Control multiple terminal sessions via a unified CLI, enabling cross-terminal, cross-model collaboration with different AI vendors.

## Why subagent-cli

| | Claude Code Built-in Subagents | Claude Squad | tmux | subagent-cli |
|---|---|---|---|---|
| How | Internal subprocess spawning | tmux sessions + git worktree | Main agent drives tmux directly | Headless PTY + CLI state machine |
| For | Official built-in feature | TUI for humans managing multiple agents | AI self-driving tmux | CLI for AI-to-AI delegation |
| Cross-model | ❌ Anthropic only | ✅ Claude Code / Codex / Aider / Gemini | ✅ Any terminal tool | ✅ Claude Code / Codex |
| AI-programmable | ✅ Via tool calls | ❌ Human-facing | ⚠️ Must parse screen yourself | ✅ JSON in/out |
| Main agent token cost | Subagents share context window | N/A (human-driven) | High (each poll consumes tokens) | Low (only on send/receive) |
| Approval control | Limited by permission modes | Manual interaction | Simulate keystrokes | Full flow (approve / reject / amend / allow-all) |
| Vendor lock-in | Anthropic | None | None | None |

## What It Does

- Control Claude Code, Codex and other coding terminals from a single workflow — mix different AIs freely
- Assign different models to different roles: decision-making, execution, review. Mutual oversight eliminates blind spots
- Each sub-agent runs in its own PTY process with full environment isolation
- Tool-use approval flow: approve, reject, amend, or allow-all — same as manual interaction
- Persistent sessions — reconnect by ID with full context preserved
- Built-in web debug terminal for real-time sub-agent screen inspection

## Not Recommended

- Fine-grained tasks — session startup and each interaction have overhead, best suited for self-contained subtasks of meaningful scope
- Use as a general-purpose terminal multiplexer or CI/CD tool
- Expecting precise structured output — built on screen parsing, inherently fuzzy
- Running as a long-lived service in production — this is a development-stage debugging and collaboration tool

## Architecture

```
Main Agent (Claude Code / Gemini CLI / ...)
    │
    │  stdout JSON
    ▼
┌──────────────────────┐          ┌──────────────────────────┐
│  subagent-cli (CLI)  │          │  Browser Debug Viewer    │
│  HTTP fetch          │          │  xterm.js (WebSocket)    │
└──────────┬───────────┘          └─────────────┬────────────┘
           │ HTTP JSON                          │ WebSocket
           ▼                                    ▼
┌────────────────────────────────────────────────────────────┐
│  App Daemon (Koa2, localhost:7100)                         │
│                                                            │
│  ┌─ Session ──────────────────────────────────────────┐    │
│  │  ClaudeCodeAdapter (state machine)                 │    │
│  │  ├── PtyXterm (node-pty + xterm/headless)          │    │
│  │  └── SessionHistory                                │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ┌─ Session ──────────────────────────────────────────┐    │
│  │  ... more sessions                                 │    │
│  └────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

- **CLI** — Short-lived process. Receives commands from the main agent, forwards to App via HTTP, returns JSON to stdout.
- **App** — Long-running daemon on `localhost:7100`. Manages all sessions, monitors idle timeouts, auto-exits when unused.
- **Session** — In-memory composite object: Adapter (state machine) + PtyXterm (virtual terminal) + SessionHistory.

The CLI auto-detects the App daemon via TCP probe. If not running, it forks one automatically.

## Supported Terminals

| Adapter | Status | CLI Tool |
|---------|--------|----------|
| `claude-code` | ✅ Available | [Claude Code](https://claude.ai/code) |
| `codex` | ✅ Available | [OpenAI Codex CLI](https://github.com/openai/codex) |

## Quick Start

```bash
# Install from npm
npm install -g @yejianfei.billy/subagent-cli

# Or clone and build from source
git clone https://github.com/yejianfei/subagent-cli.git
cd subagent-cli
npm install
npm run build
npm link

# 1. List available subagents
subagent-cli subagents

# 2. Open a session (App starts automatically if not running)
subagent-cli open -s haiku --cwd /path/to/project
# → { "data": { "session": "a1b2c3d4", "state": "IDLE" } }

# 3. Send a task
subagent-cli prompt --session a1b2c3d4 "Create a hello world Express server"
# → { "data": { "status": "approval_needed", "question": "Write to server.js" } }

# 4. Approve tool use
subagent-cli approve --session a1b2c3d4
# → { "data": { "status": "done" } }

# Or reject / amend / allow-all:
subagent-cli reject --session a1b2c3d4 "Use Koa instead"
subagent-cli approve --session a1b2c3d4 "Change port to 8080"
subagent-cli allow --session a1b2c3d4

# 5. Close session (history preserved, can resume later)
subagent-cli close --session a1b2c3d4

# Resume a previous session
subagent-cli open --session a1b2c3d4
```

All commands output JSON wrapped in delimiters for reliable parsing:

```
=====SUBAGENT_JSON=====
{ "success": bool, "code": number, "data": { ... } }
=====SUBAGENT_JSON=====
```

Parse by extracting content between the two `=====SUBAGENT_JSON=====` markers, then `JSON.parse` the result.

## CLI Reference

| Command | Options | Description |
|---------|---------|-------------|
| `subagents` | | List available subagent configurations |
| `sessions` | `--cwd <path>` | List active sessions, optionally filter by working directory |
| `open` | `-s, --subagent <name>` `--cwd <path>` `--session <id>` `--timeout <s>` | Create new session or resume existing one |
| `prompt` | `--session <id>` `--timeout <s>` `<text>` | Send task, blocks until done or approval needed |
| `approve` | `--session <id>` `--timeout <s>` `[text]` | Approve tool use (Enter). Optional text typed before approval |
| `allow` | `--session <id>` `--timeout <s>` | Approve and allow all similar operations (Shift+Tab) |
| `reject` | `--session <id>` `--timeout <s>` `[text]` | Reject tool use (Escape). Optional text sent as new instruction |
| `cancel` | `--session <id>` | Cancel running task (Escape) |
| `status` | `--session <id>` | Get internal session state (sync) |
| `check` | `--session <id>` | Get screen-calibrated state (authoritative, async) |
| `output` | `--session <id>` `--type <screen\|history>` | Get terminal output |
| `close` | `--session <id>` | Close session (omit `--session` to close all). History preserved |
| `delete` | `--session <id>` | Delete session permanently |
| `exit` | `--session <id>` | Graceful exit (`/exit` command to Claude Code) |

Global option: `-c, --config <path>` — Custom config file path.

## Configuration

Config file: `~/.subagent-cli/config.json` (auto-created on first run with default `haiku` and `codex` subagents)

```json
{
  "port": 7100,
  "idle": { "timeout": 300, "check_interval": 30, "manager_timeout": 120 },
  "terminal": { "cols": 220, "rows": 50, "scrollback": 5000 },
  "subagents": {
    "haiku": {
      "adapter": "claude-code",
      "description": "Claude Haiku",
      "role": "You are a helpful assistant.",
      "command": "claude",
      "args": [],
      "env": { "ANTHROPIC_MODEL": "haiku" }
    },
    "kimi": {
      "adapter": "claude-code",
      "description": "Fast coding, ultra low cost",
      "command": "claude",
      "args": [],
      "env": {
        "CLAUDE_CODE_OAUTH_TOKEN": "",
        "ENABLE_TOOL_SEARCH": "false",
        "ANTHROPIC_MODEL": "kimi-k2.5",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "kimi-k2.5",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2.5",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-k2.5",
        "ANTHROPIC_BASE_URL": "https://api.kimi.com/coding/",
        "ANTHROPIC_API_KEY": "${KIMI_API_KEY}"
      }
    },
    "codex": {
      "adapter": "codex",
      "description": "OpenAI Codex CLI",
      "role": "You are a helpful assistant.",
      "command": "codex",
      "args": ["--ask-for-approval", "untrusted"],
      "env": {}
    }
  }
}
```

**Top-level**

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `home` | `string` | `~/.subagent-cli` | Override home directory for sessions and data |
| `port` | `number` | `7100` | App daemon HTTP port |

**`idle` — Idle monitoring**

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `idle.timeout` | `number` | `300` | Session idle timeout (seconds). Auto-close when exceeded |
| `idle.check_interval` | `number` | `30` | How often to check for idle sessions (seconds) |
| `idle.manager_timeout` | `number` | `120` | App auto-exit delay when no sessions remain (seconds). `-1` to disable |

**`terminal` — PTY terminal settings**

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `terminal.cols` | `number` | `220` | Terminal width in columns. Wide to prevent line wrapping |
| `terminal.rows` | `number` | `50` | Terminal height in rows |
| `terminal.scrollback` | `number` | `5000` | Scrollback buffer size (lines) |

**`subagents.<name>` — Subagent definitions**

Each key under `subagents` defines a named subagent that can be used with `open -s <name>`.

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `adapter` | `string` | Yes | Adapter type. Supported: `claude-code`, `codex` |
| `description` | `string` | Yes | Human-readable description, shown in `subagents` list |
| `command` | `string` | Yes | CLI command to spawn (e.g., `claude`) |
| `args` | `string[]` | Yes | Additional command-line arguments |
| `role` | `string` | No | System prompt sent during session initialization to establish context |
| `env` | `object` | Yes | Environment variables passed to the spawned process |

**Environment variable handling**:

- `"${VAR}"` — References a system environment variable, resolved at App startup
- `""` (empty string) — Explicitly deletes the variable from the spawned process environment

> **Important**: If your current account uses `CLAUDE_CODE_OAUTH_TOKEN` (e.g., Claude Pro/Max subscription), the subagent process will inherit it. Since OAuth token has the highest authentication priority in Claude Code, you **must** set `"CLAUDE_CODE_OAUTH_TOKEN": ""` in env to delete it, otherwise `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` will be ignored. See the `kimi` example above.

**Model aliases**: `ANTHROPIC_MODEL` in env supports shorthand: `sonnet`, `opus`, `haiku`. Other env keys like `ANTHROPIC_DEFAULT_*_MODEL` require full model IDs.

## Debug Viewer

Access the built-in web terminal at `http://localhost:7100/viewer`.

- **Session list**: `http://localhost:7100/viewer` — shows all active sessions
- **Session terminal**: `http://localhost:7100/viewer?session=<id>` — real-time interactive terminal

Features:
- Full xterm.js rendering with dark theme
- Keyboard input forwarding (you can type directly)
- Dynamic resize with FitAddon
- Screen snapshot replay on connect (no lost content on page reload)
- Connection status indicator (green = connected, red = disconnected)

## Development

```bash
npm install                 # install dependencies
npm run build               # webpack production build
npm run watch               # webpack watch mode
npm test                    # unit tests (node:test)
npm run test:e2e:claude     # Claude Code end-to-end tests
npm run test:e2e:codex      # Codex end-to-end tests
npm run test:all            # build + unit tests + e2e (full pipeline)

# Manual daemon start (for debugging)
SUBAGENT_DAEMON=1 node dist/app.js
```

**Requirements**: Node.js 18+ (uses built-in `fetch`). Windows is not yet supported (macOS and Linux only).

**Tested on**: macOS 15.7 (ARM64), Node.js v18.20, Claude Code 2.1.84, Codex CLI 0.118.0. Linux has not been e2e tested yet.

**Native module note**: `node-pty` requires platform-specific prebuilds. The `postinstall` script automatically runs `chmod +x` on all `spawn-helper` binaries. If you encounter permission issues, run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` manually.

## AGENTS.md / CLAUDE.md

For more consistent results when using subagent-cli from an AI agent, add to your project or global instructions file:

```markdown
## Subagent Delegation

Use `subagent-cli` for delegating subtasks. Run `subagent-cli --help` for all commands.

Core workflow:

1. `subagent-cli open -s haiku --cwd .`            - Start session, returns session ID
2. `subagent-cli prompt --session <id> "task"`     - Send task, blocks until done or approval
3. `subagent-cli approve --session <id>`           - Approve tool use (Enter)
   `subagent-cli reject --session <id> "reason"`   - Reject with new instruction (Escape)
   `subagent-cli allow --session <id>`             - Allow all similar operations (Shift+Tab)
4. `subagent-cli close --session <id>`             - Close session (history kept)

Session recovery:
  `subagent-cli sessions --cwd .`                  - Find sessions by working directory
  `subagent-cli open --session <id>`               - Reconnect to existing session

All commands output JSON wrapped in delimiters:
  =====SUBAGENT_JSON=====
  { "success": bool, "code": number, "data": { ... } }
  =====SUBAGENT_JSON=====
Parse by extracting content between the two delimiter lines, then JSON.parse.

Debug viewer: http://localhost:7100/viewer?session=<id>

Note: In `allow` mode, `check` may briefly return RUNNING for a few seconds after task completion due to status bar refresh delay. This only affects `check`; `prompt`/`approve`/`allow`/`reject` return immediately. Retry if needed.
```

## Note

This project was fully developed through [Claude Code](https://claude.ai/code) vibe coding. For any copyright concerns, please open an Issue.

## License

Apache-2.0
