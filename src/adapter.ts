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
  private detectTimer: ReturnType<typeof setInterval> | null = null

  abstract readonly name: string

  // ── Subclass interface ──

  protected abstract getAdapterDetectRules(): DetectRules
  protected abstract getQuestion(): Promise<ApprovalInfo>

  /** Get the real session ID from the sub-agent (if available after open completes) */
  getSessionId(): string | undefined { return undefined }

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
      this.once(event, (result) => {
        if (timeout) clearTimeout(timeout)
        resolve(result)
      })
    })
    return Promise.resolve(before?.()).then(() => pending)
  }

  /** Delay helper, for pacing terminal writes. Subclasses can also use. */
  protected wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
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

  async open(params: OpenParams, session?: string, home?: string, timeout = 0): Promise<OpenResult> {
    this.params = Object.freeze({ ...params })
    const sid = session ?? ''

    const historyPath = (home && sid) ? join(home, 'sessions', sid, 'history.md') : undefined
    this.history = new SessionHistory(historyPath)

    const cfg = loadConfig()
    const env = this.buildEnv(params.env)
    this.terminal = new PtyXterm(cfg.terminal.cols, cfg.terminal.rows, cfg.terminal.scrollback)
    this.terminal.on('data', (chunk: string) => this.onChunk(chunk))
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

  async approve(prompt?: string, timeout = 0): Promise<PromptResult> {
    if (this.state === 'IDLE') return { status: 'done' }
    if (this.state === 'RUNNING') return { status: 'waiting' }
    if (this.state !== 'ASKING') return { status: 'waiting' }
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

  async allow(timeout = 0): Promise<PromptResult> {
    if (this.state === 'IDLE') return { status: 'done' }
    if (this.state === 'RUNNING') return { status: 'waiting' }
    if (this.state !== 'ASKING') return { status: 'waiting' }
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

  async reject(prompt?: string, timeout = 0): Promise<PromptResult> {
    if (this.state === 'IDLE') return { status: 'done' }
    if (this.state === 'RUNNING') return { status: 'waiting' }
    if (this.state !== 'ASKING') return { status: 'waiting' }
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

  status(): SessionStatus {
    return {
      state: this.state,
      subagent: this.params.subagent,
      cwd: this.params.cwd,
      created_at: this.createdAt.toISOString(),
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
    this.terminal.write('\x15') // Ctrl+U: clear input line
    await this.wait(500)
    this.terminal.write(`/${rules.input_keys.exit}`, true)
    await this.wait(500)
    this.terminal.write('\r')
    await pending
    this.stopDetection()
    this.state = 'CLOSED'
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
    }
  }

  close(): void {
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

  /** Start detection polling (1000ms interval). Idempotent — safe to call multiple times. */
  private startDetection(): void {
    if (this.detectTimer) return
    this.detectTimer = setInterval(async () => {
      if (!this.terminal) return
      await this.terminal.flush()
      const screen = this.terminal.capture(this.terminal.totalLines)
      let result = this.detect(screen)

      // Probe cleanup: probe space causes "tab to queue" to persist after task ends.
      // When RUNNING but only "tab to queue" remains (no "esc to interrupt"),
      // clear probe → re-detect → IDLE means truly done, otherwise re-send probe.
      const rules = this.getAdapterDetectRules()
      if (result === 'RUNNING' && this.state === 'RUNNING' && rules.probe
          && screen.includes('tab to queue') && !screen.includes('esc to interrupt')) {
        this.terminal.write('\x15') // Ctrl+U: clear probe
        await this.wait(300)
        await this.terminal.flush()
        result = this.detect(this.terminal.capture(this.terminal.totalLines))
        if (result !== 'IDLE') {
          this.terminal.write(rules.probe)
          return
        }
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
  private stopDetection(): void {
    if (this.detectTimer) {
      clearInterval(this.detectTimer)
      this.detectTimer = null
    }
  }

  private onIdle(): void {
    switch (this.state) {
      case 'OPENING':
      case 'INITING':
        this.state = 'IDLE'
        this.emit('ready')
        break
      case 'PENDING':
      case 'RUNNING':
        this.state = 'IDLE'
        this.emit('done', { status: 'done' } as PromptResult)
        break
    }
  }

  private onAsking(): void {
    const rules = this.getAdapterDetectRules()
    switch (this.state) {
      case 'OPENING':
      case 'INITING':
        // Trust dialog during startup — auto-confirm
        this.terminal.write(rules.input_keys.approve)
        break
      case 'PENDING':
      case 'RUNNING':
        this.state = 'ASKING'
        // Emit synchronously — no async gap. Approval details extracted lazily by caller.
        this.emit('done', { status: 'approval_needed' } as PromptResult)
        break
    }
  }

  private onRunning(): void {
    if (this.state === 'PENDING') {
      this.state = 'RUNNING'
      // Send probe character once to trigger running indicator on screen
      // (e.g. Codex shows "tab to queue message" when input is non-empty)
      const probe = this.getAdapterDetectRules().probe
      if (probe) this.terminal.write(probe)
    }
  }
}
