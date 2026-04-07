# CLAUDE.md — subagent-cli

> 详细设计方案见 [README.md](./README.md)

## 项目定位

Node.js + TypeScript CLI 工具，让 AI 通过 CLI 命令控制已有的编程终端（Claude Code、Codex、Gemini CLI 等），实现跨终端、跨模型的多 Agent 协作。MVP 版本采用终端控制（PTY + 屏幕解析）方式实现，支持进程隔离、两阶段审批、session 持久化。

## 技术栈

- **Runtime**: Node.js 18+（内置 `fetch`）
- **Language**: TypeScript 5.7+
- **Build**: webpack 5（双入口 `cli` + `app`）+ ts-loader
- **PTY**: `node-pty` ^1.1.0（原生模块，webpack externals）
- **Terminal**: `@xterm/headless` ^5.5.0（虚拟终端，ANSI → 纯文本）
- **HTTP Server**: `koa` + `@koa/router`（App 端）
- **WebSocket**: `ws` ^8.18.0（Debug Viewer 推送）
- **CLI**: `commander` ^12.0.0
- **Debug Viewer**: xterm.js CDN（内联 HTML 模板字符串，无外部文件）
- **Test**: `node:test` + `node:assert`（零依赖）

## 三层架构

```
CLI (thin client, 短命进程)
 ↓ HTTP fetch
App (Koa2 常驻守护进程, localhost:{port})
 ↓ 内存直接调用
Session (SubagentCliAdapter 实例 = PtyXterm + SessionHistory + 状态机)
```

- CLI 启动时 TCP 探测端口，未开放自动 fork App（`dist/app.js`）
- App 无 session 时可配置自动退出（`idle.managerTimeout`）
- Debug Viewer 集成在 App 同端口 `/viewer` + `ws://host/ws?session=xxx`

## 目录结构

```
src/
  cli.ts                     # CLI 入口 (thin client → SubagentClient)
  client.ts                  # CLI → App HTTP 客户端 (TCP 探测 + auto-fork)
  app.ts                     # App 守护进程 (Koa2 + WebSocket + 生命周期 + 内联 Viewer HTML)
  adapter.ts                 # SubagentCliAdapter 基类 (状态机 + 检测引擎 + 注册工厂)
  pty_xterm.ts               # PtyXterm (node-pty + @xterm/headless 合并)
  session_history.ts         # SessionHistory (交互历史记录)
  config.ts                  # 加载 ~/.subagent-cli/config.json (auto-init + setConfigPath)
  types.ts                   # 统一类型
  adapters/claude_code.ts    # Claude Code adapter (detect + keyMap + session ID 获取)
  adapters/codex.ts          # Codex adapter (detect + keyMap + session ID 获取)
test/
  app.test.js                # App HTTP API 单元测试 (mock adapter)
  detect.test.js             # detect() 正则匹配测试
  screen.test.js             # PtyXterm 单元测试
  e2e.test.js                # Claude Code 端到端测试 (真实 CLI + subagent)
  e2e-codex.test.js          # Codex 端到端测试
dist/                        # webpack 产物
  cli.js                     # CLI 打包结果 (bin 入口)
  app.js                     # App 打包结果
webpack.config.js            # webpack 配置 (双入口 + externals)
```

## 配置文件

**`~/.subagent-cli/config.json`**（首次启动 App 自动创建，可通过 `-c` 指定路径）：

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
    }
  }
}
```

> **首次运行**: 自动创建默认配置，包含 `haiku` subagent
> **Home 优先级**: `config.home` > 默认 `~/.subagent-cli/`
> **env 空字符串**: `""` 表示从系统环境变量中删除该变量（如覆盖 OAuth token）
> **env 模型别名**: `ANTHROPIC_MODEL` 支持别名（`sonnet` / `opus` / `haiku`），`ANTHROPIC_DEFAULT_*_MODEL` 需完整模型 ID

**Session 持久化**: `~/.subagent-cli/sessions/<id>/` 目录，包含：
- `config.json` — session 元数据（OpenParams + `resume_id`），open 时创建，**close 保留、delete 删除**
- `history.md` — 交互历史记录（时间戳 + 操作 + 内容），主 agent 丢失 session ID 时可据此回忆

## HTTP API 路由表

| Method | Route | 阻塞 | 说明 |
|---|---|---|---|
| GET | `/api/subagents` | 否 | 列出可用 subagent (name + description) |
| GET | `/api/sessions` | 否 | 列出活跃 session，支持 `?cwd=` 过滤 |
| POST | `/api/open` | **是** | 创建/重连 session，阻塞到 READY（cwd 必须存在） |
| POST | `/api/session/:id/prompt` | **长轮询** | 发送任务 |
| POST | `/api/session/:id/approve` | **长轮询** | 批准审批 (Enter)，可附带文字选择/修改 |
| POST | `/api/session/:id/allow` | **长轮询** | 批准并允许本 session 同类操作 (Shift+Tab) |
| POST | `/api/session/:id/reject` | **长轮询** | 拒绝审批 (Escape)，可附带新指令 |
| GET | `/api/session/:id/status` | 否 | 查询内部状态（同步，快速） |
| GET | `/api/session/:id/check` | 否 | 屏幕校准状态（async，flush+capture 底部 5 行 → detect） |
| GET | `/api/session/:id/output/:type` | 否 | 获取输出 (screen/history/last) |
| POST | `/api/session/:id/close` | 否 | 关闭 session（保留 history） |
| DELETE | `/api/session/:id` | 否 | 删除 session（彻底清除目录） |
| POST | `/api/close` | 否 | 关闭全部 session（保留 history） |

**统一响应**: CLI stdout 输出 JSON 前后包裹定界符 `=====SUBAGENT_JSON=====`，便于从大输出中可靠提取：
```
=====SUBAGENT_JSON=====
{ "success": bool, "code": number, "data": { "session": "...", "status": "done", "output": "..." } }
=====SUBAGENT_JSON=====
```
HTTP API 响应不含定界符，直接返回 JSON。

**prompt/approve/reject/allow 完成时**，`data.output` 包含提取后的子 agent 回复（去除 TUI chrome），主 agent 无需额外调用 `output --type last`。

**错误码**: `SESSION_NOT_FOUND` (404), `SESSION_BUSY` (409), `SESSION_NOT_READY` (503), `INVALID_STATE` (400), `TIMEOUT` (408), `SUBAGENT_NOT_FOUND` (400)

## 核心模式

### App (守护进程)

- **Session 注册**: `Map<string, SubagentCliAdapter>`，内存为权威来源
- **持久化**: open 时创建目录 + config.json + history.md，存储 `resumeId` 供重连使用
- **无自动恢复**: App 重启不会自动恢复旧 session，需用户显式 `open --session <id>` 重连
- **空闲监控**: `setInterval` 按 `idle.checkInterval` 轮询，超时 close
- **自动退出**: 由 `idle.managerTimeout` 控制（`-1` 禁用）
- **Debug Viewer**: `/viewer` + `ws://host/ws?session=xxx`，集成在同端口，断连时绿灯变红
- **不涉及 history 内容**：App 只管目录和 config.json，history 记录由 adapter 自主完成

### SubagentCliAdapter (基类)

- 继承 `EventEmitter`，`this.emit('data', data)` 广播 pty 数据
- 公开方法与 API 一对一：`open / prompt / approve / allow / reject / cancel / status / check / getOutput / close`
- 所有阻塞方法（open/prompt/approve/reject/allow）接受 `timeout` 参数（秒），默认 0 = 不超时，由 CLI `--timeout` 或 HTTP API `timeout` 字段传入
- `close()` 只管 pty 进程，调用 `removeAllListeners()`，不涉及磁盘
- **History 自主记录**: `open(params, session, home, timeout)` 传入目录后，自动追加 `history.md`
- **`getPrompts()`**: 从 history.md 提取所有 prompt 文本，供 `GET /api/sessions` 返回
- **Re-spawn 支持**: `terminal.spawn()` 内部 kill + `term.reset()` + 启动新进程，无需子类手动重置
- **Output 策略**: `approval_needed` 由上层调 `getQuestion()` 获取审批上下文（flush+capture+正则）；完整屏幕通过 `getOutput('screen')` 获取；`getOutput('last')` 提取最后一轮子 agent 回复（去除 TUI chrome）
- **Last Output 提取**: `getLastOutput(rawText)` 用 `prompt_marker` 反向查找用户 prompt 行，向下截取到 `chrome_words` 前，返回纯回复内容。`fetchLastOutput()` 在 done 时自动调用，结果附在 `PromptResult.output` 并记录到 history
- **超时控制**: `exec(event, timeoutMs, before?)` 统一管理，timeout=0 不超时
- **检测引擎**: 500ms 定时器轮询 `capture(totalLines) + detect()`，替代旧的 onChunk 被动检测，彻底消除跨 chunk 边界检测丢失问题
- **定时器生命周期**: `startDetection()` 在 spawn 后启动（幂等），`stopDetection()` 在 close/exit 时停止。始终运行，不检查状态
- **detect() 优先级**: asking_words > running_words > idle_words。running_words 命中时跳过（不触发状态变更）
- **Probe 探测**: 适配器可配置 `DetectRules.probe` 字符（如 Codex 的空格），在进入 RUNNING 时发送一次，触发 TUI 显示运行指示器（如 `tab to queue message`），用于区分 streaming 和 idle
- **Ctrl+U 清行**: 所有文本写入前（prompt/approve/cancel/exit）先发 `\x15` 清空输入行，防止 probe 残留或其他字符污染输入
- **prompt() 延迟状态**: `this.state = 'PENDING'` 在 exec 的 before 回调内设置，由检测引擎探测到屏幕关键词后转为 RUNNING，防止 prompt 发出前的 IDLE 误消费 done 事件
- **status() vs check()**: `status()` 同步读内部 state；`check()` async flush+capture(5) 屏幕底部 → detect() 返回校准状态（只读不写）

### 子类最少提供 2 项

1. `getAdapterDetectRules(): DetectRules` — 返回 match_words / idle_words / running_words / asking_words / input_keys / probe（可选）/ prompt_marker / chrome_words
2. `getQuestion(): Promise<ApprovalInfo>` — ASKING 时提取审批信息（flush+capture+正则）

可选覆写：
- `open()` — 特殊启动流程（如 session ID 获取）
- `onInit(timeoutMs)` — 启动对话框处理（默认 `exec('ready')` 等定时器检测到 IDLE）
- `buildResumeArgs(resumeId, originalArgs)` — Resume 命令格式（默认 `[...args, '--resume', id]`）

### ClaudeCodeAdapter 启动流程

```
spawn claude → IDLE → 发送 role prompt → IDLE → 发送 /exit → 进程退出
→ 解析 session UUID → spawn claude --resume <UUID> → IDLE
```

- UUID 存储在 session config.json 的 `resumeId` 字段
- 重连时 args 包含 `--resume`，跳过获取流程直接等待 IDLE
- 不覆写 `onInit()`，使用默认实现（等定时器检测到 IDLE）

### CodexAdapter 启动流程

```
spawn codex → onInit 处理启动对话框（Update/Trust/MCP boot）→ IDLE
→ 发送 role prompt → IDLE → 发送 /quit → 进程退出
→ 解析 session UUID → spawn codex resume <UUID> → IDLE
```

- 覆写 `onInit()`: 轮询 `capture(totalLines)` 处理 Update prompt（↓+Enter 跳过）、Trust dialog（Enter 确认）、MCP boot（等待）
- 覆写 `buildResumeArgs()`: `['resume', id, ...args]`（子命令格式，非 `--resume` 参数）
- 不支持 amend 和 explain（`input_keys.amend` 和 `input_keys.explain` 为空字符串）

### 状态机

```
AgentState = 'OPENING' | 'INITING' | 'IDLE' | 'PENDING' | 'RUNNING' | 'ASKING' | 'CLOSED'

新建: OPENING → INITING → IDLE → (role → /exit → UUID) → INITING → IDLE
重连: OPENING → INITING → IDLE
交互: IDLE → prompt() → PENDING → RUNNING → ASKING | IDLE(done)
审批: ASKING → approve()/allow() → PENDING → RUNNING → ASKING | IDLE(done)
修改: ASKING → approve(text)/reject(text) → PENDING → RUNNING → ASKING | IDLE(done)
取消: RUNNING → cancel() → IDLE
幂等: IDLE 下调 approve/reject/allow 直接返回 done
幂等: ASKING 下调 prompt() 直接返回当前审批信息 (approval_needed)
```

- **PENDING 状态**：prompt/approve/reject/allow 发送按键后立即进入，表示"请求已发，等待大模型响应"。检测引擎探测到屏幕关键词后转为 RUNNING
- **INITING 状态**：OPENING 后立即进入，子类 `onInit()` 在此阶段处理启动对话框。定时器检测到 IDLE 时 emit `ready`，检测到 ASKING 时自动确认（trust dialog）
- **检测引擎**：500ms 定时器轮询 `capture(totalLines) + detect()`
- **detect() 优先级**：asking_words(`Esc to cancel`/`I trust`) > running_words(`esc to interrupt`/`tab to queue`) > idle_words(`shortcuts`/`accept edits`)
- **check() 主动校准**：flush + capture(5) 屏幕底部 → detect(bottom)，返回校准状态（只读不写）
- **init 阶段不可见**：session 在 IDLE 后才注册到 sessions map

### Codex Probe 探测

Codex 在流式输出时 `esc to interrupt` 消失，只剩 `% left`。`onRunning()` 进入 RUNNING 时发送空格（`probe: ' '`），触发 `tab to queue message` 指示器。cancel 时先 Ctrl+U 清空输入再发 Escape。对 Claude Code 无影响（不设 probe）。

### Adapter 加载

- 每个 adapter 文件（如 `claude_code.ts`、`codex.ts`）底部自注册：`registerAdapter('claude-code', ClaudeCodeAdapter)`
- App 启动时 import `src/adapters/claude_code` + `src/adapters/codex`，自动完成注册
- `config.json` 中 `subagents.<name>.adapter` 引用已注册的 adapter 名（`claude-code` 或 `codex`）
- App 在 `open` 时通过 `createAdapter(config.adapter)` 实例化

## 关键约定

- 文件名用下划线：`claude_code.ts`
- 代码注释/日志/错误信息用英文，沟通用中文
- `AgentState`: `'OPENING' | 'INITING' | 'IDLE' | 'PENDING' | 'RUNNING' | 'ASKING' | 'CLOSED'`
- 终端尺寸 220×50 + 5000 scrollback（宽屏防折行，核心设计决策）
- `${VAR}` 环境变量在 App 启动时解析，空字符串 `""` 表示删除该变量

## macOS 注意

`node-pty` ARM64 需 `chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`，`postinstall` 脚本自动修复。
