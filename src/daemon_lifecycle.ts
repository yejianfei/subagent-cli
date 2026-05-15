import { connect } from 'net'
import { fork } from 'child_process'
import { join, dirname } from 'path'
import { realpathSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { getHome } from './config'

export interface DaemonInfo {
  pid: number
  port: number
}

/** TCP probe: true if a daemon is listening on the port */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, timeout: 200 })
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
}

/** True if a process with this pid is currently alive */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Fork the App daemon (dist/app.js) and wait until the port is reachable.
 * Single-instance is enforced by callers via readDaemonInfo + isProcessAlive
 * before calling this. `port` is passed via SUBAGENT_PORT so the daemon binds
 * the requested port regardless of config.json.
 */
export async function forkDaemonAndWait(port: number): Promise<void> {
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

// ── Daemon info file (single instance: pid + bound port) ──

export function daemonInfoPath(): string {
  return join(getHome(), 'daemon.pid')
}

/** File format: plain text `<pid>,<port>` (single line) */
export function writeDaemonInfo(pid: number, port: number): void {
  writeFileSync(daemonInfoPath(), `${pid},${port}`)
}

export function readDaemonInfo(): DaemonInfo | undefined {
  const p = daemonInfoPath()
  if (!existsSync(p)) return undefined
  const m = readFileSync(p, 'utf-8').trim().match(/^(\d+),(\d+)$/)
  if (!m) return undefined
  const pid = Number(m[1])
  const port = Number(m[2])
  if (pid > 0 && port > 0) return { pid, port }
  return undefined
}

export function clearDaemonInfo(): void {
  const p = daemonInfoPath()
  if (existsSync(p)) unlinkSync(p)
}
