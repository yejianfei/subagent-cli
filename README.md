# subagent-cli

Let your AI agent drive other AI agents. Control Claude Code, Codex and other coding terminals through a unified CLI — assign tasks, review approvals, collect results.

## Quick Start

```bash
npm install -g @yejianfei.billy/subagent-cli
```

```bash
# 1. Start a session
subagent-cli open -s haiku --cwd /path/to/project
# → { "session": "a1b2c3d4" }

# 2. Always check state before sending commands
subagent-cli check --session a1b2c3d4
# → { "status": "IDLE" }

# 3. Send a task (blocks until done or approval needed)
subagent-cli prompt --session a1b2c3d4 "Create a hello world Express server"
# → { "status": "approval_needed", "approval": { "tool": "Write", "target": "server.js" } }

# 4. Approve / reject / allow
subagent-cli approve --session a1b2c3d4
# → { "status": "done", "output": "Created server.js with Express hello world..." }

# 5. Close when done
subagent-cli close --session a1b2c3d4
```

All commands output JSON wrapped in `=====SUBAGENT_JSON=====` delimiters for reliable extraction from mixed stdout.

> **Tip**: Always run `check` before `prompt`/`approve`/`reject`/`allow`. Internal state may drift from actual terminal state. Use `--force` (`-f`) to send keys regardless of state.

## Use Cases

**Coding delegation** — Your main agent (e.g. Opus) breaks down a feature into subtasks, delegates each to a cheaper/faster sub-agent (Haiku, Kimi, Codex), reviews the results, and iterates. Each sub-agent runs in a fully isolated PTY with its own environment, tools, and MCP servers.

**Independent review** — Send code to a different model family for review. A Claude agent delegates review to Codex, or vice versa. Cross-vendor oversight catches blind spots that same-family models share.

```
Main Agent (Opus)
    ├── delegate coding ──→ Sub-agent A (Haiku / Kimi)
    ├── delegate review ──→ Sub-agent B (Codex)
    └── collect & verify results
```

## Integrate with Your AI Agent

Add any of the following sections to your `CLAUDE.md`, `AGENTS.md`, or equivalent instructions file.

### Basic — Core Workflow

```markdown
---
name: subagent-delegation
description: Delegate subtasks to independent coding agents via subagent-cli
---

Use `subagent-cli` to delegate subtasks to independent coding agents.
Run `subagent-cli --help` for all commands.

## Workflow

1. `subagent-cli subagents`                        - List available sub-agents
2. `subagent-cli sessions --cwd .`                 - Check for existing sessions to reuse
3. `subagent-cli open -s haiku --cwd .`            - Start new session (or `open --session <id>` to resume)
4. `subagent-cli check --session <id>`             - Verify state before every command
5. `subagent-cli prompt --session <id> "task"`     - Send task (blocks until done or approval)
6. Handle approvals:
   - `approve --session <id>`                      - Approve tool use
   - `reject --session <id> "reason"`              - Reject with new instruction
   - `allow --session <id>`                        - Approve via option 2
7. `subagent-cli close --session <id>`             - Close when done

## Wait for State

- `check --session <id> --wait IDLE`               - Poll until IDLE
- `check --session <id> --wait IDLE --output last`  - Poll + return extracted reply
- `check --session <id> --wait IDLE --timeout 30`   - Poll with timeout

## Session Management

- `sessions --status CLOSED`                       - List closed sessions
- `delete --session <id>`                          - Delete one session
- `delete --closed`                                - Delete all closed sessions
- `delete --all`                                   - Close active + delete all

## Rules

- Always `check` (or `check --wait`) before sending commands — internal state may drift from terminal.
- Use `--force` to send keys regardless of internal state.
- Reuse sessions for follow-up tasks. Only create new sessions for unrelated work.
- If a command times out, use `check` + `output` to inspect state before deciding next action.
```

### Coding Delegation

```markdown
---
name: subagent-coding-delegation
description: Delegate coding tasks to sub-agents with task scoping, structured prompts, and approval control
---

Delegate coding tasks to sub-agents. Reuse sessions for iterations on the same task.

## Before Delegating

- Run `subagent-cli subagents` to confirm available sub-agents.
- Run `subagent-cli sessions --cwd .` to check for reusable sessions.
- Estimate task scope — if changes are under ~50 lines, consider doing it directly.

## Task Prompt Structure

Send self-contained task prompts. Include:
- **Goal**: what to achieve
- **Scope**: which files/directories to modify
- **Constraints**: project rules, safety boundaries
- **Verification**: commands to run after completion

## Approval Strategy

- Use `approve` to review each tool call individually.
- Use `allow` when the task scope is clear and low-risk.
- Use `auto --session <id>` to auto-approve all tool calls in the session.
- Use `reject "instruction"` to redirect with new guidance.
- For delete/overwrite/large refactors, always review individually — do not auto-approve.
```

### Independent Review

```markdown
---
name: subagent-independent-review
description: Delegate review tasks to a different model family for cross-vendor oversight
---

Delegate review tasks to a sub-agent running a different model family for cross-vendor oversight.

## Workflow

1. Open or reuse a session with a different adapter (e.g. `codex` for reviewing Claude Code output).
2. Send a review prompt describing what to review and the review criteria.
3. The sub-agent reviews independently and returns findings.
4. Handle approvals as needed — reviewers may need file read access.
5. Collect the review output and act on findings.
6. For multi-round review, reuse the same session — send follow-up prompts after fixing issues.

## Rules

- The reviewer only reviews — it does not modify source files.
- Reuse the same session for follow-up review rounds on the same document.
- If the reviewer times out, use `check` + `output` to retrieve partial results.
```

## Supported Terminals

| Adapter       | Status | CLI Tool                                            |
| ------------- | ------ | --------------------------------------------------- |
| `claude-code` | ✅      | [Claude Code](https://claude.ai/code)               |
| `codex`       | ✅      | [OpenAI Codex CLI](https://github.com/openai/codex) |

## CLI Reference

| Command     | Options                                                                  | Description                                                      |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `subagents` |                                                                          | List available subagent configurations                           |
| `sessions`  | `--cwd <path>` `--status <state>`                                        | List sessions (active + closed), filter by cwd or state          |
| `open`      | `-s, --subagent <name>` `--cwd <path>` `--session <id>` `--timeout <s>` | Create new session or resume existing one                        |
| `prompt`    | `--session <id>` `--timeout <s>` `<text>`                                | Send task, blocks until done or approval needed                  |
| `approve`   | `--session <id>` `--timeout <s>` `-f` `[text]`                          | Approve tool use. Optional text typed before approval            |
| `allow`     | `--session <id>` `--timeout <s>` `-f`                                    | Approve via option 2. Scope depends on target CLI                |
| `reject`    | `--session <id>` `--timeout <s>` `-f` `[text]`                          | Reject tool use. Optional text sent as new instruction           |
| `auto`      | `--session <id>` `--off`                                                 | Toggle auto-approve for the session                              |
| `cancel`    | `--session <id>`                                                         | Cancel running task                                              |
| `status`    | `--session <id>`                                                         | Get internal session state (sync)                                |
| `check`     | `--session <id>` `--wait <state>` `--timeout <s>` `--output <type>`     | Get state. `--wait` polls until target state reached             |
| `output`    | `--session <id>` `--type <screen\|history\|last>`                       | Get terminal output. `last` = extracted sub-agent reply          |
| `close`     | `--session <id>`                                                         | Close session (omit `--session` to close all). History preserved |
| `delete`    | `--session <id>` `--closed` `--all`                                      | Delete session, all closed, or everything                        |
| `exit`      | `--session <id>`                                                         | Graceful exit the sub-agent process                              |

Global option: `-c, --config <path>` — Custom config file path.

## Configuration

Config file: `~/.subagent-cli/config.json` (auto-created on first run)

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
      "description": "OpenAI Codex CLI (GPT-5.4)",
      "role": "You are a helpful assistant.",
      "command": "codex",
      "args": ["--ask-for-approval", "untrusted", "-m", "gpt-5.4"],
      "env": {}
    }
  }
}
```

**Top-level**

| Key    | Type     | Default           | Description                                   |
| ------ | -------- | ----------------- | --------------------------------------------- |
| `home` | `string` | `~/.subagent-cli` | Override home directory for sessions and data |
| `port` | `number` | `7100`            | App daemon HTTP port                          |

**`idle`** — Idle monitoring

| Key                    | Type     | Default | Description                                                            |
| ---------------------- | -------- | ------- | ---------------------------------------------------------------------- |
| `idle.timeout`         | `number` | `300`   | Session idle timeout (seconds). Auto-close when exceeded               |
| `idle.check_interval`  | `number` | `30`    | How often to check for idle sessions (seconds)                         |
| `idle.manager_timeout` | `number` | `120`   | App auto-exit delay when no sessions remain (seconds). `-1` to disable |

**`terminal`** — PTY terminal settings

| Key                   | Type     | Default | Description                                              |
| --------------------- | -------- | ------- | -------------------------------------------------------- |
| `terminal.cols`       | `number` | `220`   | Terminal width in columns. Wide to prevent line wrapping |
| `terminal.rows`       | `number` | `50`    | Terminal height in rows                                  |
| `terminal.scrollback` | `number` | `5000`  | Scrollback buffer size (lines)                           |

**`subagents.<name>`** — Subagent definitions

| Key           | Type       | Required | Description                                                           |
| ------------- | ---------- | -------- | --------------------------------------------------------------------- |
| `adapter`     | `string`   | Yes      | Adapter type: `claude-code` or `codex`                                |
| `description` | `string`   | Yes      | Human-readable description, shown in `subagents` list                 |
| `command`     | `string`   | Yes      | CLI command to spawn (e.g., `claude`, `codex`)                        |
| `args`        | `string[]` | Yes      | Additional command-line arguments                                     |
| `role`        | `string`   | No       | System prompt sent during session initialization to establish context |
| `env`         | `object`   | Yes      | Environment variables passed to the spawned process                   |

**Environment variable handling**:

- `"${VAR}"` — References a system environment variable, resolved at App startup
- `""` (empty string) — Explicitly deletes the variable from the spawned process environment

> **Important**: If your current account uses `CLAUDE_CODE_OAUTH_TOKEN` (e.g., Claude Pro/Max subscription), the subagent process will inherit it. Since OAuth token has the highest authentication priority in Claude Code, you **must** set `"CLAUDE_CODE_OAUTH_TOKEN": ""` in env to delete it, otherwise `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` will be ignored. See the `kimi` example above.

**Model aliases**: `ANTHROPIC_MODEL` in env supports shorthand: `sonnet`, `opus`, `haiku`. Other env keys like `ANTHROPIC_DEFAULT_*_MODEL` require full model IDs.

## Architecture

```
Main Agent (Claude Code / Codex / ...)
    │  stdout JSON
    ▼
┌──────────────────────┐          ┌──────────────────────────┐
│  subagent-cli (CLI)  │          │  Browser Debug Viewer    │
│  thin HTTP client    │          │  xterm.js + WebSocket    │
└──────────┬───────────┘          └─────────────┬────────────┘
           │ HTTP                               │ WebSocket
           ▼                                    ▼
┌────────────────────────────────────────────────────────────┐
│  App Daemon (localhost:7100)                               │
│  ┌─ Session ─────────────────────────────────────────┐    │
│  │  Adapter (state machine) + PtyXterm + History     │    │
│  └───────────────────────────────────────────────────┘    │
│  ┌─ Session ... ─────────────────────────────────────┐    │
│  └───────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

- **CLI** — Short-lived process. Receives commands, forwards to App via HTTP, returns JSON.
- **App** — Long-running daemon. Manages sessions, monitors idle timeouts, auto-exits when unused.
- **Session** — Adapter (state machine) + PtyXterm (node-pty + xterm/headless) + SessionHistory.

The CLI auto-detects the App daemon via TCP probe. If not running, it forks one automatically.

## Debug Viewer

Built-in web terminal at `http://localhost:7100/viewer` — real-time xterm.js rendering with keyboard input forwarding and connection status indicator.

## Development

```bash
npm install                 # install dependencies
npm run build               # webpack production build
npm run watch               # webpack watch mode
npm test                    # unit tests (node:test)
npm run test:e2e:claude     # Claude Code end-to-end tests
npm run test:e2e:codex      # Codex end-to-end tests
```

**Requirements**: Node.js 18+ (uses built-in `fetch`). macOS and Linux only — Windows is not supported.

## Note

This project was fully developed through [Claude Code](https://claude.ai/code) vibe coding. For any copyright concerns, please open an Issue.

## License

Apache-2.0
