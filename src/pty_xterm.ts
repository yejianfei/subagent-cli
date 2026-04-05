import { EventEmitter } from 'events'
import * as pty from 'node-pty'
import { Terminal } from '@xterm/headless'

export interface PtySpawnOptions {
  cwd: string
  env: Record<string, string>
}

/**
 * PtyXterm — Virtual terminal abstraction.
 * 1 instance = 1 terminal = node-pty process + xterm/headless emulator.
 * Emits 'data' (raw stdout chunks) and 'exit' (process exit code) events.
 */
export class PtyXterm extends EventEmitter {
  private proc?: pty.IPty
  private term: Terminal

  constructor(
    private cols: number,
    private rows: number,
    private scrollback: number,
  ) {
    super()
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  }

  // ── Process management ──

  /** Spawn a PTY process (kills old process + clears screen → starts new process) */
  spawn(command: string, args: string[], opts: PtySpawnOptions): void {
    this.kill()
    this.term.reset()
    this.proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: this.cols, rows: this.rows,
      cwd: opts.cwd, env: opts.env,
    })
    this.proc.onData((data: string) => {
      this.term.write(data)
      this.emit('data', data)
    })
    this.proc.onExit(({ exitCode }) => {
      this.proc = undefined
      this.emit('exit', exitCode)
    })
  }

  /** Graceful exit (SIGTERM) — listen on('exit') for completion */
  exit(): void {
    if (!this.proc) return
    try { this.proc.kill() } catch { /* already dead */ }
  }

  /** Force kill (SIGKILL) — immediate cleanup, no waiting */
  kill(): void {
    try { this.proc?.kill('SIGKILL') } catch { /* already dead */ }
    this.proc = undefined
  }

  // ── Input ──

  /**
   * Write to PTY stdin.
   * @param pasted - when true, wraps with bracketed paste mode (\x1b[200~ ... \x1b[201~)
   */
  write(data: string, pasted?: boolean): void {
    if (!this.proc) return
    if (pasted) {
      this.proc.write(`\x1b[200~${data}\x1b[201~`)
    } else {
      this.proc.write(data)
    }
  }

  /** Resize terminal dimensions */
  resize(cols: number, rows: number): void {
    if (this.proc) this.proc.resize(cols, rows)
    this.term.resize(cols, rows)
  }

  // ── Query ──

  /** Flush xterm async writes to ensure capture gets latest data */
  flush(): Promise<void> {
    return new Promise(resolve => this.term.write('', resolve))
  }

  /**
   * Capture terminal plain text (ANSI stripped).
   * @param lines - number of lines to capture, defaults to this.rows (one screen).
   *                Pass a larger value to include scrollback history.
   */
  capture(lines?: number): string {
    const count = lines ?? this.rows
    const buf = this.term.buffer.active
    const total = buf.length
    const start = Math.max(0, total - count)
    const result = Array.from({ length: total - start }, (_, idx) => {
      const line = buf.getLine(start + idx)
      return line ? line.translateToString(true) : ''
    })
    // Trim trailing empty lines
    const trimmed = result.reduceRight<string[]>((acc, line) =>
      acc.length === 0 && line.trim() === '' ? acc : [line, ...acc], [])
    return trimmed.join('\n')
  }

  /** Total line count (including scrollback history) */
  get totalLines(): number {
    return this.term.buffer.active.length
  }

  /** Raw xterm buffer reference (advanced usage) */
  get buffer() {
    return this.term.buffer.active
  }

  // ── Lifecycle ──

  /** Clear screen buffer (same Terminal instance, no dispose) */
  clear(): void {
    this.term.write('\x1b[2J\x1b[3J\x1b[H')
    this.term.clear()
  }

  /** Dispose all resources (force kills process if running) */
  dispose(): void {
    this.kill()
    this.term.dispose()
    this.removeAllListeners()
  }
}
