import { EventEmitter } from 'events'
import { join } from 'path'
import { PtyXterm } from './pty_xterm'
import { SessionHistory } from './session_history'
import { loadConfig } from './config'
import type {
  OpenParams, OpenResult, PromptResult, SessionStatus, OutputResult,
  DetectRules, AgentState, ApprovalInfo,
} from './types'

// ── Adapter Registry ──

type AdapterCtor = new () => SubagentCliAdapter

const registry = new Map<string, AdapterCtor>()

export function registerAdapter(name: string, ctor: AdapterCtor): void {
  registry.set(name, ctor)
}

export function createAdapter(adapterName: string): SubagentCliAdapter {
  const Ctor = registry.get(adapterName)
  if (!Ctor) throw new Error(`Unknown adapter: ${adapterName}`)
  return new Ctor()
}

// ── IPC Path Helper ──

/**
 * Extract UUID from an IPC socket path so child agents and ws clients can pick it up.
 * Canonical form: `subagent-cli_<UUID>(.sock)` — emitted by the VS Code extension.
 * Custom paths fall back to the basename without extension.
 */
export function parseIpcUuid(ipcPath: string): string {
  const canonical = ipcPath.match(/subagent-cli_([^./\\]+)/)
  if (canonical) return canonical[1]
  const basename = ipcPath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  return basename || ipcPath
}

// ── Base Class ──

/**
 * SubagentCliAdapter — base class for all sub-agent CLI adapters.
 * Subclasses provide getAdapterDetectRules() and getQuestion().
 *
 * Async model: all async waits go through exec(event, action, timeout).
 * Detection engine: 2s polling timer runs flush+capture(5)+detect() on screen bottom,
 * emits 'ready' (INITING→IDLE) and 'done' (RUNNING/ASKING→result).
 * State guards on each API prevent duplicate once() listeners.
 *
 * Timeout policy: all timeouts default to 0 (no timeout).
 * Callers pass timeout (seconds) via method params or HTTP API.
 */
export abstract class SubagentCliAdapter extends EventEmitter {
  protected terminal!: PtyXterm
  protected history!: SessionHistory
  protected state: AgentState = 'OPENING'
  protected params!: Readonly<OpenParams>
  protected createdAt = new Date()
  protected sessionIdValue?: string
  private detectTimer: ReturnType<typeof setInterval> | null = null
  private autoApproveEnabled = false
  private expectingExit = false
  protected terminalExited = false

  abstract readonly name: string

  // ── Subclass interface ──

  protected abstract getAdapterDetectRules(): DetectRules
  protected abstract getQuestion(): Promise<ApprovalInfo>

  /** Get the real session ID from the sub-agent (populated after exit() parses it) */
  getSessionId(): string | undefined { return this.sessionIdValue }

  /** Get the open params for this session (for persistence updates) */
  getParams(): OpenParams { return this.params }

  /** Window-scope IPC path (if any) — used by daemon for ownership filtering */
  getIpcPath(): string | undefined { return this.params?.ipc_path }

  /**
   * Parse the sub-agent's session ID from exit output.
   * Subclasses override with adapter-specific regex (e.g. UUID format).
   * Returns undefined if parsing fails.
   */
  protected parseSessionId(_exitOutput: string): string | undefined {
    return undefined
  }

  /** Write data to PTY stdin (for interactive viewer input) */
  write(data: string): void { this.terminal?.write(data) }

  /** Resize PTY to match viewer terminal dimensions */
  resize(cols: number, rows: number): void { this.terminal?.resize(cols, rows) }

  // ── History delegation ──

  getPrompts(): string[] {
    return this.history?.getLogs('prompt') ?? []
  }

  // ── Environment ──

  /** Build resolved env (empty string = delete from process.env) */
  protected buildEnv(paramEnv: Record<string, string>): Record<string, string> {
    const deleteKeys = Object.entries(paramEnv).filter(([, v]) => v === '').map(([k]) => k)
    const overrides = Object.fromEntries(Object.entries(paramEnv).filter(([, v]) => v !== ''))
    const merged = { ...process.env, ...overrides }
    deleteKeys.forEach(k => { delete merged[k] })
    return Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] != null)
    )
  }


  /**
   * Unified async wait: register once(event) → run before() → await event.
   * timeoutMs = 0 means no timeout (wait indefinitely).
   *
   * The `before` callback runs AFTER the listener is registered but BEFORE awaiting the event,
   * ensuring no race condition between terminal writes and event detection.
   *
   * @param event - event name to wait for ('ready' or 'done')
   * @param timeoutMs - timeout in milliseconds. 0 = no timeout (default)
   * @param before - optional async action to run after listener registration (e.g. terminal writes)
   */
  protected exec<T>(event: string, timeoutMs: number, before?: () => Promise<void> | void): Promise<T> {
    const pending = new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs > 0
        ? setTimeout(() => reject(new Error(`${event.toUpperCase()}_TIMEOUT`)), timeoutMs)
        : null
      const onExit = () => {
        if (timeout) clearTimeout(timeout)
        this.off(event, onResult)
        const tail = this.terminal.capture(this.terminal.totalLines)
          .trim().split('\n').slice(-20).join('\n').trim()
        reject(new Error(`SUBAGENT_EXITED_DURING_${event.toUpperCase()}: ${tail || '(no output)'}`))
      }
      const onResult = (result: T) => {
        if (timeout) clearTimeout(timeout)
        this.off('unexpected-exit', onExit)
        resolve(result)
      }
      this.once(event, onResult)
      this.once('unexpected-exit', onExit)
    })
    return Promise.resolve(before?.()).then(() => pending)
  }

  /** Delay helper, for pacing terminal writes. Subclasses can also use. */
  protected wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /** Throw if PTY exited early (e.g. CLI rejected args). Surfaces the last 20 screen lines. */
  protected throwIfExited(stage: string): void {
    if (!this.terminalExited) return
    const tail = this.terminal.capture(this.terminal.totalLines)
      .trim().split('\n').slice(-20).join('\n').trim()
    throw new Error(`SUBAGENT_EXITED_DURING_${stage}: ${tail || '(no output)'}`)
  }

  /**
   * Extract last sub-agent reply from raw terminal text.
   * Uses prompt_marker and chrome_words from DetectRules — fully generic.
   */
  protected getLastOutput(rawText: string): string {
    const { prompt_marker, chrome_words } = this.getAdapterDetectRules()
    const markerEsc = prompt_marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const lines = rawText.split('\n')

    // Find last user prompt: marker + real content (exclude menu items like "❯ 1.")
    let startIdx = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (t.startsWith(prompt_marker) && t.length > prompt_marker.length + 1
          && !new RegExp(`^${markerEsc}\\s+\\d+\\.`).test(t)) {
        startIdx = i + 1
        break
      }
    }

    // Trim TUI chrome from bottom
    let endIdx = lines.length
    for (let i = lines.length - 1; i >= startIdx; i--) {
      const t = lines[i].trim()
      if (t === '' || /^[─╌]{3,}$/.test(t) || new RegExp(`^${markerEsc}[\\s\\u00a0]*$`).test(t)
          || chrome_words.some(w => t.includes(w))) {
        endIdx = i
      } else {
        break
      }
    }

    return lines.slice(startIdx, endIdx).join('\n').trim()
  }

  private async fetchLastOutput(): Promise<string> {
    await this.terminal.flush()
    return this.getLastOutput(this.terminal.capture())
  }

  /**
   * Initialization hook. Called after spawn with state = INITING.
   * Default: wait for detection engine to detect IDLE (exec 'ready').
   * Subclasses override to handle startup dialogs, MCP boot, etc.
   */
  protected async onInit(timeoutMs: number): Promise<void> {
    await this.exec('ready', timeoutMs)
  }

  // ── Public API ──

  /** Build args for resuming a session. Subclasses override for different resume formats. */
  buildResumeArgs(resumeId: string, originalArgs: string[]): string[] {
    return [...originalArgs, '--resume', resumeId]
  }

  /**
   * Build init prompt for new session creation.
   * Appends a system notice so the sub-agent treats the role as identity only
   * and waits for the actual task message that follows.
   */
  protected buildInitPrompt(role?: string): string {
    const header = `[subagent-cli] ${role ?? 'hi'}`
    const notice = '[SYSTEM] Above is your session role, not a task message. Do not act on the role itself — do not call tools, write, edit, run, or analyze yet. Reply "OK" to acknowledge and wait for the user\'s actual task.'
    return `${header}\n\n${notice}`
  }

  async open(params: OpenParams, session?: string, home?: string, timeout = 0): Promise<OpenResult> {
    this.params = Object.freeze({ ...params })
    const sid = session ?? ''

    const historyPath = (home && sid) ? join(home, 'sessions', sid, 'history.md') : undefined
    this.history = new SessionHistory(historyPath)

    const cfg = loadConfig()
    const env = this.buildEnv(params.env)
    if (params.ipc_path) {
      env.SUBAGENT_VSCODE_IPC = params.ipc_path
      env.SUBAGENT_VSCODE_UUID = parseIpcUuid(params.ipc_path)
    }
    this.terminal = new PtyXterm(cfg.terminal.cols, cfg.terminal.rows, cfg.terminal.scrollback)
    this.terminal.on('data', (chunk: string) => this.onChunk(chunk))
    this.terminal.on('exit', () => {
      this.terminalExited = true
      if (this.expectingExit) return  // Normal exit/close path handles this
      // Unexpected exit: try parse UUID for cleanup, mark closed, notify app
      this.terminal.flush().then(() => {
        const parsed = this.parseSessionId(this.terminal.capture(1000))
        if (parsed) this.sessionIdValue = parsed
        this.stopDetection()
        this.state = 'CLOSED'
        this.emit('unexpected-exit')
      })
    })
    this.startDetection()

    this.state = 'OPENING'
    this.terminal.spawn(params.command, params.args, { cwd: params.cwd, env })
    const ms = timeout * 1000
    this.state = 'INITING'
    await this.onInit(ms)
    return { session: sid }
  }

  async prompt(text: string, timeout = 0): Promise<PromptResult> {
    if (this.state === 'ASKING') {
      const approval = await this.getQuestion()
      return { status: 'approval_needed', approval }
    }
    if (this.state !== 'IDLE') throw new Error('SESSION_BUSY')
    this.history.log('prompt', text)

    const ms = timeout * 1000
    const r = await this.exec<PromptResult>('done', ms, async () => {
      this.terminal.write('\x15') // Ctrl+U: clear input line
      await this.wait(500)
      this.terminal.write(text, true)
      await this.wait(500)
      this.state = 'PENDING'
      this.terminal.write('\r')
    })

    if (r.status === 'done') {
      r.output = await this.fetchLastOutput()
      this.history.log('output', r.output)
    }
    this.history.log(r.status, r.approval ? `tool: ${r.approval.tool}, target: ${r.approval.target}` : 'done')
    if (r.status === 'approval_needed') {
      const approval = await this.getQuestion()
      return { status: 'approval_needed', approval }
    }
    return r
  }

  async approve(prompt?: string, timeout = 0, force = false): Promise<PromptResult> {
    if (!force) {
      if (this.state === 'IDLE') return { status: 'done' }
      if (this.state === 'RUNNING') return { status: 'waiting' }
      if (this.state !== 'ASKING') return { status: 'waiting' }
    }
    const rules = this.getAdapterDetectRules()
    this.history.log('approve', prompt ?? '(no prompt)')
    this.state = 'PENDING'

    const ms = timeout * 1000
    const r = await this.exec<PromptResult>('done', ms, async () => {
      if (prompt && rules.input_keys.amend) {
        this.terminal.write(rules.input_keys.amend)
        await this.wait(1000)
        this.terminal.write('\x15') // Ctrl+U: clear input line
        await this.wait(500)
        this.terminal.write(prompt, true)
        await this.wait(500)
        this.terminal.write('\r')
      } else {
        this.terminal.write(rules.input_keys.approve)
      }
    })

    if (r.status === 'done') {
      r.output = await this.fetchLastOutput()
      this.history.log('output', r.output)
    }
    this.history.log(r.status, r.approval ? `tool: ${r.approval.tool}, target: ${r.approval.target}` : 'done')
    if (r.status === 'approval_needed') {
      const approval = await this.getQuestion()
      return { status: 'approval_needed', approval }
    }
    return r
  }

  async allow(timeout = 0, force = false): Promise<PromptResult> {
    if (!force) {
      if (this.state === 'IDLE') return { status: 'done' }
      if (this.state === 'RUNNING') return { status: 'waiting' }
      if (this.state !== 'ASKING') return { status: 'waiting' }
    }
    const rules = this.getAdapterDetectRules()
    this.history.log('allow', 'allow all during session')
    this.state = 'PENDING'

    const ms = timeout * 1000
    const r = await this.exec<PromptResult>('done', ms, async () => {
      const arrows = rules.input_keys.allow.match(/\x1b\[[A-D]/g) ?? []
      await arrows.reduce(async (prev, arrow) => {
        await prev
        this.terminal.write(arrow)
        await this.wait(200)
      }, Promise.resolve())
      this.terminal.write('\r')
    })

    if (r.status === 'done') {
      r.output = await this.fetchLastOutput()
      this.history.log('output', r.output)
    }
    this.history.log(r.status, r.approval ? `tool: ${r.approval.tool}, target: ${r.approval.target}` : 'done')
    if (r.status === 'approval_needed') {
      const approval = await this.getQuestion()
      return { status: 'approval_needed', approval }
    }
    return r
  }

  async reject(prompt?: string, timeout = 0, force = false): Promise<PromptResult> {
    if (!force) {
      if (this.state === 'IDLE') return { status: 'done' }
      if (this.state === 'RUNNING') return { status: 'waiting' }
      if (this.state !== 'ASKING') return { status: 'waiting' }
    }
    const rules = this.getAdapterDetectRules()
    this.history.log('reject', prompt ?? '(no reason)')
    this.state = 'PENDING'

    const ms = timeout * 1000
    const r = await this.exec<PromptResult>('done', ms, async () => {
      const arrows = rules.input_keys.reject.match(/\x1b\[[A-D]/g) ?? []
      await arrows.reduce(async (prev, arrow) => {
        await prev
        this.terminal.write(arrow)
        await this.wait(200)
      }, Promise.resolve())
      this.terminal.write('\r')
    })

    if (r.status === 'done') {
      r.output = await this.fetchLastOutput()
      this.history.log('output', r.output)
    }
    this.history.log(r.status, r.approval ? `tool: ${r.approval.tool}, target: ${r.approval.target}` : 'done')
    if (r.status === 'approval_needed') {
      const approval = await this.getQuestion()
      return { status: 'approval_needed', approval }
    }
    return r
  }

  async cancel(timeout = 30): Promise<PromptResult> {
    if (this.state !== 'RUNNING') return { status: 'done' }
    const rules = this.getAdapterDetectRules()
    this.history.log('cancel', 'user cancelled')

    const ms = timeout * 1000
    const r = await this.exec<PromptResult>('done', ms, async () => {
      // If probe is active, clear it first so Escape isn't swallowed
      if (rules.probe) {
        this.terminal.write('\x15') // Ctrl+U: kill line (clear input)
        await this.wait(500)
      }
      this.terminal.write(rules.input_keys.cancel)
    })

    this.history.log(r.status, 'cancelled')
    return r
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApproveEnabled = enabled
    this.history?.log('auto', enabled ? 'enabled' : 'disabled')
  }

  get autoApprove(): boolean { return this.autoApproveEnabled }

  status(): SessionStatus {
    return {
      state: this.state,
      subagent: this.params.subagent,
      cwd: this.params.cwd,
      created_at: this.createdAt.toISOString(),
      role: this.params.role ?? '',
    }
  }

  async getOutput(type: 'screen' | 'history' | 'last' = 'screen'): Promise<OutputResult> {
    await this.terminal.flush()
    let content: string
    if (type === 'last') {
      content = this.getLastOutput(this.terminal.capture())
    } else if (type === 'history') {
      content = this.terminal.capture(this.terminal.totalLines)
    } else {
      content = this.terminal.capture()
    }
    return { type, content, lines: content.split('\n').length }
  }

  async exit(timeout = 30): Promise<void> {
    if (this.state !== 'IDLE') throw new Error('SESSION_BUSY')
    this.expectingExit = true
    const ms = timeout * 1000
    const rules = this.getAdapterDetectRules()
    // Register listener BEFORE write to avoid race condition
    const pending = new Promise<void>((resolve) => {
      const timer = ms > 0
        ? setTimeout(() => { this.terminal.kill(); resolve() }, ms)
        : null
      this.terminal.once('exit', () => {
        if (timer) clearTimeout(timer)
        resolve()
      })
    })
    this.sendExitCommand(rules.input_keys.exit)
    await pending
    // Capture exit output and parse session ID
    await this.terminal.flush()
    const exitOutput = this.terminal.capture(1000)
    const parsed = this.parseSessionId(exitOutput)
    if (parsed) this.sessionIdValue = parsed
    this.stopDetection()
    this.state = 'CLOSED'
  }

  /**
   * Send exit command to the sub-agent CLI. Default sends `/<cmd>` + Enter.
   * Subclasses override for non-slash exit (e.g. Gemini's Ctrl+D×2).
   */
  protected async sendExitCommand(exitCmd: string): Promise<void> {
    this.terminal.write('\x15') // Ctrl+U: clear input line
    await this.wait(500)
    this.terminal.write(`/${exitCmd}`, true)
    await this.wait(500)
    this.terminal.write('\r')
  }

  /** Screen-calibrated state check (authoritative, async — flush + capture bottom lines → detect) */
  async check(): Promise<SessionStatus> {
    let state = this.state
    if (this.terminal && state !== 'OPENING' && state !== 'INITING' && state !== 'CLOSED') {
      await this.terminal.flush()
      const bottom = this.terminal.capture(5)
      const detected = this.detect(bottom)
      if (detected) state = detected
    }
    return {
      state,
      subagent: this.params.subagent,
      cwd: this.params.cwd,
      created_at: this.createdAt.toISOString(),
      role: this.params.role ?? '',
    }
  }

  /**
   * Close the session. Tries graceful exit first (send exit command, wait up to 3s,
   * then SIGTERM, then SIGKILL). Parses session ID from exit output if successful.
   */
  async close(): Promise<void> {
    if (this.state === 'CLOSED') {
      this.removeAllListeners()
      return
    }
    this.expectingExit = true
    if (this.terminal?.alive) {
      const rules = this.getAdapterDetectRules()
      const gracefulExit = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000)
        this.terminal.once('exit', () => { clearTimeout(timer); resolve(true) })
      })
      try {
        await this.sendExitCommand(rules.input_keys.exit)
      } catch {
        // Send may fail if process already dying — fall through to kill
      }
      const exited = await gracefulExit
      if (!exited) {
        // SIGTERM, wait up to 1s, then SIGKILL via dispose
        this.terminal.exit()
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000)
          this.terminal.once('exit', () => { clearTimeout(t); resolve() })
        })
      }
      // Try to capture session ID even on close
      await this.terminal.flush()
      const exitOutput = this.terminal.capture(1000)
      const parsed = this.parseSessionId(exitOutput)
      if (parsed) this.sessionIdValue = parsed
    }
    this.stopDetection()
    this.terminal?.dispose()
    this.state = 'CLOSED'
    this.removeAllListeners()
  }

  // ── Detection Engine ──

  /**
   * Detect agent state from text. Priority: asking > running > idle.
   * Used by polling timer and check() — both operate on rendered screen text.
   */
  private detect(text: string): AgentState | null {
    const rules = this.getAdapterDetectRules()
    if (!rules.match_words.some(w => text.includes(w))) return null
    if (rules.asking_words.some(w => text.includes(w))) return 'ASKING'
    if (rules.running_words.some(w => text.includes(w))) return 'RUNNING'
    if (rules.idle_words.some(w => text.includes(w))) return 'IDLE'
    return null
  }

  /** Forward PTY data to upper layer (WebSocket viewer etc.) */
  private onChunk(chunk: string): void {
    this.emit('data', chunk)
  }

  /** Start detection polling (1000ms interval). Idempotent — safe to call multiple times.
   *
   *  Active probe confirm-before-IDLE: for adapters with a `probe` rule (codex), when the
   *  detection appears to say IDLE while we're currently RUNNING/PENDING, we actively write
   *  the probe character (a space) and re-detect. The probe makes a still-busy codex
   *  re-display "tab to queue …" → running_words hit → keep RUNNING. On a truly idle codex
   *  the space stays in the input buffer but codex does not show the queue indicator → the
   *  next detect is still IDLE → real transition. Residue character is cleared only at the
   *  start of the next prompt()/approve()/etc via Ctrl+U.
   */
  private startDetection(): void {
    if (this.detectTimer) return
    this.detectTimer = setInterval(async () => {
      if (!this.terminal) return
      await this.terminal.flush()
      let result = this.detect(this.terminal.capture())

      const rules = this.getAdapterDetectRules()
      if (result === 'IDLE' && rules.probe && (this.state === 'RUNNING' || this.state === 'PENDING')) {
        this.terminal.write(rules.probe)
        await this.wait(500)
        await this.terminal.flush()
        result = this.detect(this.terminal.capture())
      }

      switch (result) {
        case 'ASKING':
          this.onAsking()
          break
        case 'IDLE':
          this.onIdle()
          break
        case 'RUNNING':
          this.onRunning()
          break
      }
    }, 1000)
  }

  /** Stop detection polling. */
  protected stopDetection(): void {
    if (this.detectTimer) {
      clearInterval(this.detectTimer)
      this.detectTimer = null
    }
  }

  private onIdle(): void {
    switch (this.state) {
      case 'IDLE':
        return
      case 'OPENING':
      case 'INITING':
        this.state = 'IDLE'
        this.emit('ready')
        break
      case 'PENDING':
      case 'RUNNING':
      case 'ASKING':
        this.state = 'IDLE'
        this.emit('done', { status: 'done' } as PromptResult)
        break
    }
  }

  private onAsking(): void {
    const rules = this.getAdapterDetectRules()
    switch (this.state) {
      case 'ASKING':
        return
      case 'OPENING':
      case 'INITING':
        // Trust dialog during startup — auto-confirm
        this.terminal.write(rules.input_keys.approve)
        break
      case 'PENDING':
      case 'RUNNING':
      case 'IDLE':
        if (this.autoApproveEnabled) {
          this.state = 'PENDING'
          this.terminal?.write(rules.input_keys.approve)
          this.history?.log('auto-approve', 'auto')
        } else {
          this.state = 'ASKING'
          this.emit('done', { status: 'approval_needed' } as PromptResult)
        }
        break
    }
  }

  private onRunning(): void {
    if (this.state === 'PENDING') {
      this.state = 'RUNNING'
      const probe = this.getAdapterDetectRules().probe
      if (probe) this.terminal.write(probe)
    }
  }
}
