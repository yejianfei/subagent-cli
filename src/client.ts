import { connect } from 'net'
import { fork } from 'child_process'
import { join, dirname } from 'path'
import { realpathSync } from 'fs'
import { loadConfig } from './config'

export class SubagentClient {
  private baseUrl: string

  constructor() {
    const config = loadConfig()
    this.baseUrl = `http://localhost:${config.port}/api`
  }

  private async ensureManager(): Promise<void> {
    const config = loadConfig()
    if (await this.probePort(config.port)) return

    const realDir = dirname(realpathSync(__filename))
    const appPath = join(realDir, 'app.js')
    let exitCode: number | null = null
    const child = fork(appPath, [], { detached: true, stdio: 'ignore', env: { ...process.env, SUBAGENT_DAEMON: '1' } })
    child.on('exit', (code) => { exitCode = code })
    child.unref()

    const probed = await Array.from({ length: 50 }).reduce<Promise<boolean>>(async (prev) => {
      if (await prev) return true
      if (exitCode !== null) return false
      await new Promise(r => setTimeout(r, 100))
      return this.probePort(config.port)
    }, Promise.resolve(false))
    if (probed) return
    throw new Error(exitCode !== null
      ? `Manager failed to start (exit ${exitCode}). Check PTY permissions or start manually: SUBAGENT_DAEMON=1 node app.js`
      : 'Manager failed to start within 5 seconds')
  }

  private probePort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ port, timeout: 200 })
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
      socket.on('timeout', () => { socket.destroy(); resolve(false) })
    })
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.ensureManager()
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.json()
  }

  getSubagents() { return this.request('GET', '/subagents') }

  getSessions(cwd?: string, status?: string) {
    const params = new URLSearchParams()
    cwd && params.set('cwd', cwd)
    status && params.set('status', status)
    const qs = params.toString()
    return this.request('GET', `/sessions${qs ? `?${qs}` : ''}`)
  }

  open(params: { subagent?: string; cwd?: string; session?: string; timeout?: number }) {
    return this.request('POST', '/open', params)
  }

  prompt(session: string, prompt: string, timeout?: number) {
    return this.request('POST', `/session/${session}/prompt`, { prompt, timeout })
  }

  approve(session: string, prompt?: string, timeout?: number, force?: boolean) {
    return this.request('POST', `/session/${session}/approve`, { prompt, timeout, force })
  }

  reject(session: string, prompt?: string, timeout?: number, force?: boolean) {
    return this.request('POST', `/session/${session}/reject`, { prompt, timeout, force })
  }

  allow(session: string, timeout?: number, force?: boolean) {
    return this.request('POST', `/session/${session}/allow`, { timeout, force })
  }

  auto(session: string, enabled = true) {
    return this.request('POST', `/session/${session}/auto`, { enabled })
  }

  status(session: string) { return this.request('GET', `/session/${session}/status`) }

  check(session: string, wait?: string, timeout?: number, output?: string) {
    const params = new URLSearchParams()
    wait && params.set('wait', wait)
    timeout && params.set('timeout', String(timeout))
    output && params.set('output', output)
    const qs = params.toString()
    return this.request('GET', `/session/${session}/check${qs ? `?${qs}` : ''}`)
  }

  output(session: string, type = 'screen') {
    return this.request('GET', `/session/${session}/output/${type}`)
  }

  cancel(session: string) { return this.request('POST', `/session/${session}/cancel`) }
  exit(session: string) { return this.request('POST', `/session/${session}/exit`) }
  close(session: string) { return this.request('POST', `/session/${session}/close`) }
  delete(session: string) { return this.request('DELETE', `/session/${session}`) }
  deleteClosed() { return this.request('DELETE', '/sessions/closed') }
  deleteAll() { return this.request('DELETE', '/sessions/all') }
  closeAll() { return this.request('POST', '/close') }
}
