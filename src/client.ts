import { loadConfig } from './config'
import { forkDaemonAndWait, readDaemonInfo, isProcessAlive } from './daemon_lifecycle'

export class SubagentClient {
  private port!: number

  /**
   * Resolve the daemon and its port (single instance).
   * If a live daemon is recorded (pid alive), connect to its port — even if
   * it differs from config (user may have started it with `daemon start --port`).
   * Otherwise fork a fresh daemon on the config port.
   */
  private async ensureManager(): Promise<void> {
    const info = readDaemonInfo()
    if (info && isProcessAlive(info.pid)) {
      this.port = info.port
      return
    }
    const config = loadConfig()
    await forkDaemonAndWait(config.port)
    this.port = config.port
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.ensureManager()
    const res = await fetch(`http://localhost:${this.port}/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
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

  open(params: { subagent?: string; cwd?: string; session?: string; role?: string; prompt?: string; reuse?: boolean; timeout?: number }) {
    // open --session <id> targeting own session is forbidden (recursive self-control)
    if (params.session) {
      const err = this.guardSelfRef(params.session)
      if (err) return Promise.resolve(err)
    }
    // Recursive call: pass exclude_session so reuse (when enabled via fast_reuse or --reuse) excludes the caller's own session.
    const excludeSession = process.env.SUBAGENT_CLI_SESSION
    const body = excludeSession ? { ...params, exclude_session: excludeSession } : params
    return this.request('POST', '/open', body)
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
