import { connect, type Socket } from 'net'
import { fork } from 'child_process'
import { dirname, join } from 'path'
import { existsSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { getHome, loadConfig } from './config'

export interface DaemonOpResult {
  success: boolean
  code: number
  data: Record<string, unknown>
}

// ── Daemon registry helpers (module-private) ──────────────────────────
// These live in client.ts because cli.js bundle is the only consumer; the
// daemon-side (app.js) writes its own pid file with two `fs` calls directly,
// not through these helpers, to avoid a shared module just for two writes.

interface DaemonInfo {
  pid: number
  port: number
}

function daemonInfoPath(): string {
  return join(getHome(), 'daemon.pid')
}

/** TCP probe: true if a daemon is listening on the port (200ms timeout). */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, timeout: 200 })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
  })
}

/** Unix socket / Named Pipe probe: true if a peer is listening (200ms timeout). */
function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path)
    const timer = setTimeout(() => { sock.destroy(); resolve(false) }, 200)
    sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true) })
    sock.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

/**
 * Discover this window's IPC socket by VSCODE_PID when SUBAGENT_VSCODE_IPC is
 * missing — happens when the CLI is spawned by another extension whose host
 * snapshotted env before our extension injected the var (e.g. Claude Code).
 *
 * The extension names its socket `subagent-cli_<sha1(workspace)[:8]>_<VSCODE_PID>.sock`.
 * We wildcard the workspace-hash segment and lock onto `_<VSCODE_PID>` (the editor
 * main-process pid, inherited by all spawned children and stable across reloads),
 * then probe each match and return the first reachable one.
 *
 * Windows Named Pipes are not on the filesystem — readdir can't enumerate them,
 * so glob is skipped there (env path only).
 */
export async function discoverIpcByVscodePid(): Promise<string | undefined> {
  const pid = process.env.VSCODE_PID
  if (!pid || process.platform === 'win32') return undefined
  const dir = tmpdir()
  const re = new RegExp(`^subagent-cli_.+_${pid}\\.sock$`)
  const matches = readdirSync(dir).filter(f => re.test(f)).map(f => join(dir, f))
  const probed = await Promise.all(matches.map(async p => ({ p, alive: await probeSocket(p) })))
  return probed.find(x => x.alive)?.p
}

/**
 * Read the daemon registry and return it **only if the recorded pid is alive**.
 * Stale entries (missing file, malformed content, dead pid) are auto-unlinked
 * and undefined is returned — callers don't need to combine with a liveness check.
 */
function readDaemonInfo(): DaemonInfo | undefined {
  const p = daemonInfoPath()
  if (!existsSync(p)) return undefined
  const m = readFileSync(p, 'utf-8').trim().match(/^(\d+),(\d+)$/)
  const pid = m ? Number(m[1]) : 0
  const port = m ? Number(m[2]) : 0
  if (pid > 0 && port > 0 && processAlive(pid)) return { pid, port }
  unlinkSync(p)  // stale or malformed → drop so next start has a clean slate
  return undefined
}

function clearDaemonInfo(): void {
  const p = daemonInfoPath()
  if (existsSync(p)) unlinkSync(p)
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Fork the daemon (dist/app.js next to this CLI bundle) and wait until the
 * port is reachable. Single-instance is enforced by the caller via
 * readDaemonInfo before invoking this. `port` is passed via SUBAGENT_PORT
 * env so the daemon binds the requested port regardless of config.json.
 *
 * `app.js` always sits next to this CLI bundle in dist/ — realpathSync
 * resolves the symlink so npm/npx/brew/yarn installs all locate it.
 */
async function forkDaemonAndWait(port: number): Promise<void> {
  if (await probePort(port)) return
  const realDir = dirname(realpathSync(__filename))
  const appPath = join(realDir, 'app.js')
  let exitCode: number | null = null
  const child = fork(appPath, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SUBAGENT_DAEMON: '1', SUBAGENT_PORT: String(port) },
  })
  child.on('exit', (code) => { exitCode = code })
  child.unref()
  const probed = await Array.from({ length: 50 }).reduce<Promise<boolean>>(async (prev) => {
    if (await prev) return true
    if (exitCode !== null) return false
    await new Promise(r => setTimeout(r, 100))
    return probePort(port)
  }, Promise.resolve(false))
  if (probed) return
  throw new Error(exitCode !== null
    ? `Manager failed to start (exit ${exitCode}). Check PTY permissions or start manually: SUBAGENT_DAEMON=1 node app.js`
    : 'Manager failed to start within 5 seconds')
}

interface IpcResponse {
  success?: boolean
  client_id?: string
  error?: string
  message?: string
}

export class SubagentClient {
  private port!: number
  private ipcPath: string | undefined = process.env.SUBAGENT_VSCODE_IPC || undefined
  private ipcChecked = false
  private ipcUsable = false

  /**
   * Detect if the IPC peer (VS Code extension) is reachable, resolving the
   * socket path via a two-step degradation chain:
   *
   *   1. SUBAGENT_VSCODE_IPC env, if set and reachable → use it (fastest path).
   *   2. else glob `<tmpdir>/subagent-cli_*_<VSCODE_PID>.sock` and probe matches —
   *      covers CLI spawned without env injection (see discoverIpcByVscodePid).
   *   3. neither reachable → independent (HTTP) mode, no regression.
   *
   * A discovered path is written back to this.ipcPath so the handshake
   * (ipcCall) and the X-Subagent-Cli-IPC request header target the same window.
   * 200ms probe per candidate.
   */
  private async shouldUseIPC(): Promise<boolean> {
    if (this.ipcChecked) return this.ipcUsable
    this.ipcChecked = true
    if (this.ipcPath && await probeSocket(this.ipcPath)) {
      this.ipcUsable = true
      return true
    }
    const discovered = await discoverIpcByVscodePid()
    if (discovered) {
      this.ipcPath = discovered
      this.ipcUsable = true
      return true
    }
    this.ipcUsable = false
    return false
  }

  /**
   * Length-prefixed JSON-RPC over Unix Socket / Named Pipe.
   * Frame: <4-byte BE uint32 length><UTF-8 JSON body>
   */
  private ipcCall<T extends IpcResponse>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ipcPath) return Promise.reject(new Error('IPC_NOT_AVAILABLE'))
    const target = this.ipcPath
    return new Promise<T>((resolve, reject) => {
      const chunks: Buffer[] = []
      let expectedLength = -1
      const sock: Socket = connect(target)
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('IPC_TIMEOUT')) }, 5000)
      sock.on('connect', () => {
        const payload = Buffer.from(JSON.stringify({ method, params: params ?? {} }), 'utf-8')
        const header = Buffer.alloc(4)
        header.writeUInt32BE(payload.length, 0)
        sock.write(Buffer.concat([header, payload]))
      })
      sock.on('data', chunk => {
        chunks.push(chunk)
        const all = Buffer.concat(chunks)
        if (expectedLength < 0 && all.length >= 4) expectedLength = all.readUInt32BE(0)
        if (expectedLength >= 0 && all.length >= 4 + expectedLength) {
          clearTimeout(timer)
          sock.end()
          const json = all.slice(4, 4 + expectedLength).toString('utf-8')
          try {
            resolve(JSON.parse(json) as T)
          } catch (e) {
            reject(new Error(`IPC_PARSE_ERROR: ${(e as Error).message}`))
          }
        }
      })
      sock.on('error', err => { clearTimeout(timer); reject(err) })
    })
  }

  /**
   * Resolve the daemon and its port (single instance).
   * If a live daemon is recorded (pid alive), connect to its port — even if
   * it differs from config (user may have started it with `daemon start --port`).
   * Otherwise fork a fresh daemon on the config port.
   */
  private async ensureManager(): Promise<void> {
    const live = readDaemonInfo()
    if (live) { this.port = live.port; return }
    const config = loadConfig()
    await forkDaemonAndWait(config.port)
    this.port = config.port
  }

  // ── Daemon lifecycle ───────────────────────────────────────────────
  // Factory + stop() form. `getInstance` is the one-shot "give me a ready client"
  // entry — it forks the daemon if needed and returns an instance bound to the
  // live port. `stop()` shuts down the daemon (not just the client). `status()`
  // is a side-effect-free static query (it must NOT fork, hence not via factory).

  /** Most recent daemon-start outcome from `getInstance` — surfaced by `daemon start` CLI command. */
  private _startResult: DaemonOpResult | null = null
  startResult(): DaemonOpResult | null { return this._startResult }

  /**
   * Get a ready-to-use client with the daemon ensured running.
   * If a live daemon is registered, the returned instance binds to its port.
   * Otherwise a new daemon is forked on `opts.port` (default config.port).
   */
  static async getInstance(opts: { port?: number } = {}): Promise<SubagentClient> {
    const c = new SubagentClient()
    const live = readDaemonInfo()
    if (live) {
      c.port = live.port
      c._startResult = { success: true, code: 200, data: { status: 'already_running', port: live.port, pid: live.pid } }
      return c
    }
    const port = opts.port ?? loadConfig().port
    await forkDaemonAndWait(port)
    c.port = port
    c._startResult = { success: true, code: 200, data: { status: 'started', port } }
    return c
  }

  /** Status of the registered daemon. **Never forks** — safe for diagnostic queries. */
  static async status(): Promise<DaemonOpResult> {
    const live = readDaemonInfo()
    const running = !!live && (await probePort(live.port))
    return { success: true, code: 200, data: { running, port: live?.port, pid: live?.pid } }
  }

  /** Gracefully stop the daemon via `POST /api/shutdown`. Never forks. */
  async stop(): Promise<DaemonOpResult> {
    const live = readDaemonInfo()
    if (!live) {
      return { success: true, code: 200, data: { status: 'not_running' } }
    }
    try {
      await fetch(`http://localhost:${live.port}/api/shutdown`, { method: 'POST' })
    } catch { /* daemon may close the socket before responding — fall through to wait */ }
    const stopped = await Array.from({ length: 50 }).reduce<Promise<boolean>>(async (prev) => {
      if (await prev) return true
      await new Promise(r => setTimeout(r, 100))
      return !(await probePort(live.port))
    }, Promise.resolve(false))
    if (stopped) {
      clearDaemonInfo()
      return { success: true, code: 200, data: { status: 'stopped', port: live.port } }
    }
    return {
      success: false, code: 500,
      data: { error: 'STOP_FAILED', message: `Daemon (pid ${live.pid}, port ${live.port}) did not stop. Kill manually: kill ${live.pid}` },
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.ensureManager()
    const headers: Record<string, string> = {}
    if (body) headers['Content-Type'] = 'application/json'
    // VS Code mode: stamp every request with the window IPC path so daemon can
    // filter listing and reject cross-window single-session operations (403 WINDOW_MISMATCH).
    if (this.ipcPath) headers['X-Subagent-Cli-IPC'] = this.ipcPath
    const res = await fetch(`http://localhost:${this.port}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.json()
  }

  /** Reject any command that targets the caller's own session (prevents recursive self-control). */
  private guardSelfRef(sessionId: string): { success: false; code: number; data: { error: string; message: string } } | null {
    const self = process.env.SUBAGENT_CLI_SESSION
    if (self && sessionId === self) {
      return {
        success: false,
        code: 400,
        data: {
          error: 'RECURSIVE_SELF_REFERENCE',
          message: `Session ${sessionId} is the current subagent-cli session — recursive self-control is forbidden`,
        },
      }
    }
    return null
  }

  getSubagents() { return this.request('GET', '/subagents') }

  getSessions(cwd?: string, status?: string) {
    const params = new URLSearchParams()
    cwd && params.set('cwd', cwd)
    status && params.set('status', status)
    const qs = params.toString()
    return this.request('GET', `/sessions${qs ? `?${qs}` : ''}`)
  }

  async open(params: { subagent?: string; cwd?: string; session?: string; role?: string; prompt?: string; reuse?: boolean; timeout?: number }) {
    // open --session <id> targeting own session is forbidden (recursive self-control)
    if (params.session) {
      const err = this.guardSelfRef(params.session)
      if (err) return err
    }
    // Recursive call: pass exclude_session so reuse (when enabled via fast_reuse or --reuse) excludes the caller's own session.
    const excludeSession = process.env.SUBAGENT_CLI_SESSION
    const baseBody: Record<string, unknown> = excludeSession ? { ...params, exclude_session: excludeSession } : { ...params }

    // VS Code mode: prepareTerminal → /api/open (with ipc_path) → attachSession
    if (await this.shouldUseIPC()) {
      const prep = await this.ipcCall<IpcResponse>('prepareTerminal', { subagent: params.subagent })
      if (prep.error || !prep.client_id) {
        return { success: false, code: 502, data: { error: 'IPC_ERROR', message: prep.error ?? prep.message ?? 'prepareTerminal returned no client_id' } }
      }
      const result = await this.request('POST', '/open', { ...baseBody, ipc_path: this.ipcPath })
      const session = (result as { data?: { session?: string } }).data?.session
      if (session) {
        await this.ipcCall<IpcResponse>('attachSession', { session, client_id: prep.client_id }).catch(() => undefined)
      }
      return result
    }
    return this.request('POST', '/open', baseBody)
  }

  prompt(session: string, prompt: string, timeout?: number) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/prompt`, { prompt, timeout })
  }

  approve(session: string, prompt?: string, timeout?: number, force?: boolean) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/approve`, { prompt, timeout, force })
  }

  reject(session: string, prompt?: string, timeout?: number, force?: boolean) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/reject`, { prompt, timeout, force })
  }

  allow(session: string, timeout?: number, force?: boolean) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/allow`, { timeout, force })
  }

  auto(session: string, enabled = true) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/auto`, { enabled })
  }

  status(session: string) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('GET', `/session/${session}/status`)
  }

  check(session: string, wait?: string, timeout?: number, output?: string) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    const params = new URLSearchParams()
    wait && params.set('wait', wait)
    timeout && params.set('timeout', String(timeout))
    output && params.set('output', output)
    const qs = params.toString()
    return this.request('GET', `/session/${session}/check${qs ? `?${qs}` : ''}`)
  }

  output(session: string, type = 'screen') {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('GET', `/session/${session}/output/${type}`)
  }

  cancel(session: string) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/cancel`)
  }
  exit(session: string) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/exit`)
  }
  close(session: string) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('POST', `/session/${session}/close`)
  }
  delete(session: string) {
    const err = this.guardSelfRef(session); if (err) return Promise.resolve(err)
    return this.request('DELETE', `/session/${session}`)
  }
  deleteClosed() { return this.request('DELETE', '/sessions/closed') }
  deleteAll() { return this.request('DELETE', '/sessions/all') }
  closeAll() { return this.request('POST', '/close') }
}
