import Koa from 'koa'
import Router from '@koa/router'
import { createServer, type Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { loadConfig, ensureDirs, getHome, type AppConfig } from './config'
import { createAdapter, SubagentCliAdapter } from './adapter'
import { PtyXterm } from './pty_xterm'
import type { OpenParams } from './types'

// Load all adapters (self-register)
import './adapters/claude_code'
import './adapters/codex'

// Re-export internal modules for testing
export { PtyXterm } from './pty_xterm'
export { ClaudeCodeAdapter } from './adapters/claude_code'
export { CodexAdapter } from './adapters/codex'
// Augment Koa request with parsed body
declare module 'koa' {
  interface Request {
    body?: unknown
  }
}

export interface AppOptions {
  config?: AppConfig
  adapterFactory?: (adapterName: string) => SubagentCliAdapter
}

export interface AppContext {
  app: Koa
  httpServer: Server
  sessions: Map<string, SubagentCliAdapter>
  start(): Promise<void>
  stop(): void
}

export function app(opts?: AppOptions | AppConfig): AppContext {
  // Support both app(config) and app({ config, adapterFactory }) for backward compat
  const isOptions = opts && 'adapterFactory' in opts
  const config = (isOptions ? (opts as AppOptions).config : opts as AppConfig) ?? loadConfig()
  const buildAdapter = (isOptions ? (opts as AppOptions).adapterFactory : undefined) ?? createAdapter
  ensureDirs()

  // ── Session Registry ──

  const sessions = new Map<string, SubagentCliAdapter>()

  function generateId(): string {
    return randomBytes(6).toString('hex')
  }

  // ── Persistence Helpers ──

  function sessionDir(id: string): string {
    return join(getHome(), 'sessions', id)
  }

  function persistSession(id: string, params: OpenParams, resumeId?: string): void {
    const dir = sessionDir(id)
    mkdirSync(dir, { recursive: true })
    const meta: Record<string, unknown> = {
      subagent: params.subagent, adapter: params.adapter,
      cwd: params.cwd, command: params.command,
      args: params.args, env: params.env,
      created_at: new Date().toISOString(),
    }
    if (resumeId) meta.resume_id = resumeId
    writeFileSync(join(dir, 'config.json'), JSON.stringify(meta, null, 2) + '\n')
    const historyFile = join(dir, 'history.md')
    if (!existsSync(historyFile)) {
      writeFileSync(historyFile, `# Session ${id} — ${params.subagent}\n\n`)
    }
  }

  function deleteSessionDir(id: string): void {
    const dir = sessionDir(id)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  // ── Startup Recovery ──

  // ── HTTP API ──

  const koaApp = new Koa()
  const router = new Router({ prefix: '/api' })

  // Global error handler — log to console
  koaApp.on('error', (err: Error) => {
    console.error('[Koa error]', err.stack ?? err.message)
  })
  koaApp.use(async (ctx, next) => {
    try { await next() } catch (err) {
      const e = err as Error
      console.error(`[${ctx.method} ${ctx.path}]`, e.stack ?? e.message)
      ctx.status = 500
      ctx.body = { success: false, code: 500, data: { error: 'INTERNAL_ERROR', message: e.message } }
    }
  })

  // Lightweight JSON body parser
  koaApp.use(async (ctx, next) => {
    if (ctx.is('json')) {
      const chunks: Buffer[] = []
      for await (const chunk of ctx.req) chunks.push(chunk as Buffer)
      ctx.request.body = JSON.parse(Buffer.concat(chunks).toString())
    }
    await next()
  })

  function ok(ctx: Koa.Context, data: Record<string, unknown>): void {
    ctx.body = { success: true, code: 200, data }
  }

  function fail(ctx: Koa.Context, code: number, error: string, message: string): void {
    ctx.status = code
    ctx.body = { success: false, code, data: { error, message } }
  }

  function getAdapter(ctx: Koa.Context): SubagentCliAdapter | null {
    const id = ctx.params.id
    const adapter = sessions.get(id)
    if (!adapter) { fail(ctx, 404, 'SESSION_NOT_FOUND', `Session ${id} does not exist`); return null }
    return adapter
  }

  // GET /api/subagents
  router.get('/subagents', (ctx) => {
    const list = Object.entries(config.subagents).map(([name, cfg]) => ({
      name, adapter: cfg.adapter, description: cfg.description,
    }))
    ok(ctx, { subagents: list })
  })

  // GET /api/sessions?cwd=xxx&status=IDLE
  router.get('/sessions', (ctx) => {
    const cwdFilter = ctx.query.cwd as string | undefined
    const statusFilter = ctx.query.status as string | undefined

    const active = Array.from(sessions.entries())
      .map(([id, adapter]) => ({ session: id, ...adapter.status(), prompts: adapter.getPrompts() }))

    const sessDir = join(getHome(), 'sessions')
    const closed = existsSync(sessDir)
      ? readdirSync(sessDir)
        .filter(id => !sessions.has(id))
        .map(id => {
          const cfgFile = join(sessDir, id, 'config.json')
          if (!existsSync(cfgFile)) return null
          const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
          return {
            session: id, state: 'CLOSED' as const,
            subagent: saved.subagent, adapter: saved.adapter,
            cwd: saved.cwd, created_at: saved.created_at, prompts: [] as string[],
          }
        })
        .filter(Boolean) as Array<{ session: string; state: string; subagent: string; adapter: string; cwd: string; created_at: string; prompts: string[] }>
      : []

    const all = [...active, ...closed]
      .filter(s => !cwdFilter || s.cwd === cwdFilter)
      .filter(s => !statusFilter || s.state === statusFilter)

    ok(ctx, { sessions: all })
  })

  // POST /api/open
  router.post('/open', async (ctx) => {
    const body = ctx.request.body as Record<string, unknown>
    const sessionId = body.session as string | undefined
    const timeout = body.timeout ? Number(body.timeout) : 0

    // Reconnect in-memory
    if (sessionId && sessions.has(sessionId)) {
      ok(ctx, { session: sessionId }); return
    }

    // Recover from disk — use resumeId for --resume if available
    if (sessionId && existsSync(join(sessionDir(sessionId), 'config.json'))) {
      const saved = JSON.parse(readFileSync(join(sessionDir(sessionId), 'config.json'), 'utf-8'))
      const subCfg = config.subagents[saved.subagent]
      if (!subCfg) { fail(ctx, 400, 'SUBAGENT_NOT_FOUND', `Subagent ${saved.subagent} not in config`); return }
      const adapter = buildAdapter(subCfg.adapter)
      const resumeId = saved.resume_id as string | undefined
      const args = resumeId ? adapter.buildResumeArgs(resumeId, subCfg.args) : subCfg.args
      const params: OpenParams = {
        subagent: saved.subagent, adapter: subCfg.adapter,
        cwd: saved.cwd, command: subCfg.command, args, env: subCfg.env,
      }
      if (!existsSync(params.cwd)) { fail(ctx, 400, 'INVALID_STATE', `Working directory does not exist: ${params.cwd}`); return }
      sessions.set(sessionId, adapter)
      trackActivity(sessionId, adapter)
      try {
        await adapter.open(params, sessionId, getHome(), timeout)
      } catch (err) {
        sessions.delete(sessionId)
        lastActivity.delete(sessionId)
        adapter.close()
        throw err
      }
      ok(ctx, { session: sessionId }); return
    }

    // New session
    const subagentName = body.subagent as string | undefined
    if (!subagentName) { fail(ctx, 400, 'INVALID_STATE', 'Missing "subagent" field'); return }
    const subCfg = config.subagents[subagentName]
    if (!subCfg) { fail(ctx, 400, 'SUBAGENT_NOT_FOUND', `Unknown subagent: ${subagentName}`); return }

    const id = (sessionId ?? generateId()) as string
    const adapter = buildAdapter(subCfg.adapter)
    const cwd = (body.cwd as string | undefined) ?? process.cwd()
    if (!existsSync(cwd)) { fail(ctx, 400, 'INVALID_STATE', `Working directory does not exist: ${cwd}`); return }
    const params: OpenParams = {
      subagent: subagentName, adapter: subCfg.adapter,
      cwd, command: subCfg.command, args: subCfg.args, env: subCfg.env,
    }
    sessions.set(id, adapter)
    trackActivity(id, adapter)
    try {
      console.error(`[open] calling adapter.open for ${id}`)
      await adapter.open(params, id, getHome(), timeout)
      console.error(`[open] adapter.open returned for ${id}, sessionId=${adapter.getSessionId()}`)
    } catch (err) {
      sessions.delete(id)
      lastActivity.delete(id)
      adapter.close()
      throw err
    }
    persistSession(id, params, adapter.getSessionId())
    console.error(`[open] persisted, sending ok for ${id}`)
    ok(ctx, { session: id })
  })

  // POST /api/session/:id/prompt
  router.post('/session/:id/prompt', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const { prompt, timeout } = ctx.request.body as { prompt: string; timeout?: number }
    try {
      const result = await adapter.prompt(prompt, timeout ?? 0)
      ok(ctx, { session: ctx.params.id, ...result })
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'SESSION_BUSY') fail(ctx, 409, 'SESSION_BUSY', 'Session is processing another request')
      else fail(ctx, 500, 'INTERNAL', msg)
    }
  })

  // POST /api/session/:id/approve
  router.post('/session/:id/approve', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const { prompt, timeout, force } = (ctx.request.body ?? {}) as { prompt?: string; timeout?: number; force?: boolean }
    const result = await adapter.approve(prompt, timeout ?? 0, force)
    ok(ctx, { session: ctx.params.id, ...result })
  })

  // POST /api/session/:id/reject
  router.post('/session/:id/reject', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const { prompt, timeout, force } = (ctx.request.body ?? {}) as { prompt?: string; timeout?: number; force?: boolean }
    const result = await adapter.reject(prompt, timeout ?? 0, force)
    ok(ctx, { session: ctx.params.id, ...result })
  })

  // POST /api/session/:id/allow
  router.post('/session/:id/allow', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const { timeout, force } = (ctx.request.body ?? {}) as { timeout?: number; force?: boolean }
    const result = await adapter.allow(timeout ?? 0, force)
    ok(ctx, { session: ctx.params.id, ...result })
  })

  // POST /api/session/:id/auto
  router.post('/session/:id/auto', (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const { enabled } = (ctx.request.body ?? {}) as { enabled?: boolean }
    adapter.setAutoApprove(enabled !== false)
    ok(ctx, { session: ctx.params.id, auto: adapter.autoApprove })
  })

  // POST /api/session/:id/cancel
  router.post('/session/:id/cancel', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const body = (ctx.request.body ?? {}) as Record<string, unknown>
    const result = await adapter.cancel(body.timeout as number | undefined)
    ok(ctx, { session: ctx.params.id, ...result })
  })

  // GET /api/session/:id/status
  router.get('/session/:id/status', (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    ok(ctx, { session: ctx.params.id, ...adapter.status() })
  })

  // GET /api/session/:id/check (screen-calibrated state, optional polling)
  router.get('/session/:id/check', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const waitState = ctx.query.wait as string | undefined
    const timeout = Number(ctx.query.timeout ?? 0)
    const outputType = ctx.query.output as 'screen' | 'history' | 'last' | undefined

    const poll = async (): Promise<Record<string, unknown>> => {
      const s = await adapter.check()
      const result: Record<string, unknown> = { session: ctx.params.id, ...s }
      if (outputType) {
        const o = await adapter.getOutput(outputType)
        result.output = o.content
      }
      return result
    }

    if (!waitState) {
      ok(ctx, await poll()); return
    }

    const deadline = timeout > 0 ? Date.now() + timeout * 1000 : 0
    while (true) {
      const result = await poll()
      if (result.state === waitState) { ok(ctx, result); return }
      if (deadline > 0 && Date.now() >= deadline) {
        fail(ctx, 408, 'TIMEOUT', `Timed out waiting for state ${waitState}`); return
      }
      await new Promise(r => setTimeout(r, 1000))
    }
  })

  // GET /api/session/:id/output/:type
  router.get('/session/:id/output/:type', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    ok(ctx, { session: ctx.params.id, ...await adapter.getOutput(ctx.params.type as 'screen' | 'history') })
  })

  // POST /api/session/:id/exit (graceful process exit)
  router.post('/session/:id/exit', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    await adapter.exit()
    ok(ctx, { session: ctx.params.id, status: 'exited' })
  })

  // POST /api/session/:id/close (keep dir)
  router.post('/session/:id/close', (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    adapter.close()
    sessions.delete(ctx.params.id)
    closeViewerSockets(ctx.params.id)
    ok(ctx, { session: ctx.params.id, status: 'closed' })
    checkAutoExit()
  })

  // Close all viewer WebSocket connections for a given session
  function closeViewerSockets(sessionId: string): void {
    for (const client of wss.clients) {
      if ((client as any)._sessionId === sessionId) client.close(4001, 'Session closed')
    }
  }

  // DELETE /api/session/:id (remove dir)
  router.del('/session/:id', (ctx) => {
    const id = ctx.params.id
    const adapter = sessions.get(id)
    if (adapter) { adapter.close(); sessions.delete(id); closeViewerSockets(id) }
    deleteSessionDir(id)
    ok(ctx, { session: id, status: 'deleted' })
    checkAutoExit()
  })

  // DELETE /api/sessions/closed (batch delete closed sessions)
  router.del('/sessions/closed', (ctx) => {
    const sessDir = join(getHome(), 'sessions')
    const deleted = existsSync(sessDir)
      ? readdirSync(sessDir)
        .filter(id => !sessions.has(id))
        .map(id => { deleteSessionDir(id); return id })
      : []
    ok(ctx, { deleted })
  })

  // DELETE /api/sessions/all (close active + delete all)
  router.del('/sessions/all', (ctx) => {
    const deleted: string[] = []
    sessions.forEach((adapter, id) => { adapter.close(); closeViewerSockets(id); deleted.push(id) })
    sessions.clear()
    const sessDir = join(getHome(), 'sessions')
    existsSync(sessDir) && readdirSync(sessDir).forEach(id => {
      deleteSessionDir(id)
      !deleted.includes(id) && deleted.push(id)
    })
    ok(ctx, { deleted })
    checkAutoExit()
  })

  // POST /api/close (close all, keep dirs)
  router.post('/close', (ctx) => {
    const closed = Array.from(sessions.entries()).map(([id, adapter]) => { adapter.close(); closeViewerSockets(id); return id })
    sessions.clear()
    ok(ctx, { closed })
    checkAutoExit()
  })

  koaApp.use(router.routes()).use(router.allowedMethods())

  // ── Debug Viewer ──

  koaApp.use(async (ctx, next) => {
    if (ctx.path === '/viewer') {
      const session = ctx.query.session as string | undefined
      if (session) {
        ctx.type = 'html'
        ctx.body = VIEWER_HTML
      } else {
        ctx.type = 'html'
        const activeItems = Array.from(sessions.entries()).map(([id, a]) => {
          const s = a.status()
          return `<li><a href="/viewer?session=${id}" target="_blank">${id}</a> — ${s.subagent} (${s.state})</li>`
        })
        const sessDir = join(getHome(), 'sessions')
        const closedItems = existsSync(sessDir)
          ? readdirSync(sessDir)
            .filter(id => !sessions.has(id))
            .map(id => {
              const cfgFile = join(sessDir, id, 'config.json')
              if (!existsSync(cfgFile)) return ''
              const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
              return `<li style="opacity:0.5">${id} — ${saved.subagent ?? 'unknown'} (CLOSED)</li>`
            })
            .filter(Boolean)
          : []
        const items = [...activeItems, ...closedItems].join('\n')
        ctx.body = `<!DOCTYPE html><html><body><h1>Sessions</h1><ul>${items}</ul></body></html>`
      }
    } else {
      await next()
    }
  })

  const VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>subagent-cli debug viewer</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; font-family: 'SF Mono', 'Fira Code', monospace; height: 100vh; display: flex; flex-direction: column; }
    .header { background: #16213e; color: #7B61FF; padding: 8px 16px; font-size: 13px; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #00ff88; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
    #terminal { flex: 1; padding: 4px; }
  </style>
</head>
<body>
  <div class="header"><span class="dot"></span> subagent-cli debug viewer — session: <span id="sid"></span></div>
  <div id="terminal"></div>
  <script type="module">
    import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm'
    import * as FitAddon from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm'
    const session = new URLSearchParams(location.search).get('session') || 'unknown'
    document.getElementById('sid').textContent = session
    const term = new Terminal({
      theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#7B61FF' },
      fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 13,
      cursorBlink: true, scrollback: 10000,
    })
    const fitAddon = new FitAddon.FitAddon()
    term.loadAddon(fitAddon)
    term.open(document.getElementById('terminal'))
    let ws
    function connect() {
      ws = new WebSocket('ws://' + location.host + '/ws?session=' + session)
      ws.onopen = () => { const dot = document.querySelector('.dot'); dot.style.background = '#44ff44'; dot.style.animation = 'pulse 2s infinite'; fitAddon.fit(); sendResize() }
      ws.onmessage = (e) => term.write(e.data)
      ws.onclose = () => { const dot = document.querySelector('.dot'); dot.style.background = '#ff4444'; dot.style.animation = 'none'; term.write('\\r\\n\\x1b[33m[reconnecting...]\\x1b[0m\\r\\n'); setTimeout(connect, 2000) }
    }
    connect()
    term.onData((data) => { if (ws && ws.readyState === 1) ws.send(data) })
    function sendResize() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) }
    term.onResize(() => sendResize())
    window.addEventListener('resize', () => fitAddon.fit())
    term.focus()
  </script>
</body>
</html>`

  // ── WebSocket ──

  const httpServer = createServer(koaApp.callback())
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const sessionId = url.searchParams.get('session')
    if (!sessionId) { ws.close(4000, 'Missing session parameter'); return }
    const adapter = sessions.get(sessionId)
    if (!adapter) { ws.close(4004, 'Session not found'); return }
    ;(ws as any)._sessionId = sessionId


    const listener = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    }
    adapter.on('data', listener)
    // Replay current screen snapshot on connect
    adapter.getOutput('screen').then(({ content }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(content)
    })
    // Forward viewer input to PTY, handle resize
    ws.on('message', (msg) => {
      const str = String(msg)
      if (str.startsWith('{')) {
        try {
          const cmd = JSON.parse(str)
          if (cmd.type === 'resize') adapter.resize(cmd.cols, cmd.rows)
        } catch { /* not json, treat as input */ adapter.write(str) }
      } else {
        adapter.write(str)
      }
    })
    ws.on('close', () => adapter.off('data', listener))
  })

  // ── Idle Monitor ──

  // Track last activity per session for idle timeout
  const lastActivity = new Map<string, number>()

  // Update activity timestamp when adapter emits data
  function trackActivity(id: string, adapter: SubagentCliAdapter): void {
    lastActivity.set(id, Date.now())
    adapter.on('data', () => lastActivity.set(id, Date.now()))
  }

  const idleTimer = setInterval(() => {
    const now = Date.now()
    Array.from(sessions.entries())
      .filter(([id]) => (now - (lastActivity.get(id) ?? now)) > config.idle.timeout * 1000)
      .forEach(([id, adapter]) => {
        console.error(`Idle timeout: session ${id} (${Math.round((now - (lastActivity.get(id) ?? now)) / 1000)}s)`)
        adapter.close()
        sessions.delete(id)
        lastActivity.delete(id)
      })
    checkAutoExit()
  }, config.idle.check_interval * 1000)

  // ── Auto Exit ──

  const autoExit = { timer: null as ReturnType<typeof setTimeout> | null }
  const MANAGER_IDLE = (config.idle.manager_timeout ?? -1) * 1000  // default -1 = never

  function checkAutoExit(): void {
    if (MANAGER_IDLE < 0) return  // -1 = never auto-exit
    if (sessions.size > 0) {
      if (autoExit.timer) { clearTimeout(autoExit.timer); autoExit.timer = null }
      return
    }
    if (autoExit.timer) return
    autoExit.timer = setTimeout(() => {
      if (sessions.size > 0) { autoExit.timer = null; return }
      console.error(`No sessions for ${MANAGER_IDLE / 1000}s. Manager exiting.`)
      clearInterval(idleTimer)
      httpServer.close()
      process.exit(0)
    }, MANAGER_IDLE)
  }

  // ── Start / Stop ──

  /** Preflight check: verify PTY spawn works before accepting connections */
  function preflight(): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = new PtyXterm(80, 24, 100)
      const timer = setTimeout(() => { t.dispose(); resolve() }, 3000)
      t.on('exit', (code: number) => {
        clearTimeout(timer)
        t.dispose()
        code === 0 ? resolve() : reject(new Error(
          `PTY preflight failed (exit ${code}). Likely running in a sandboxed or restricted environment. ` +
          'Start the daemon manually outside the sandbox: SUBAGENT_DAEMON=1 node app.js'
        ))
      })
      t.spawn('echo', ['ok'], { cwd: getHome(), env: { PATH: process.env.PATH ?? '/usr/bin' } })
    })
  }

  async function start(): Promise<void> {
    await preflight()
    httpServer.listen(config.port, () => {
      console.error(`App listening on http://localhost:${config.port}`)
      console.error(`Debug viewer: http://localhost:${config.port}/viewer`)
    })
  }

  function stop(): void {
    clearInterval(idleTimer)
    if (autoExit.timer) clearTimeout(autoExit.timer)
    sessions.forEach(adapter => adapter.close())
    sessions.clear()
    wss.close()
    httpServer.close()
  }

  return { app: koaApp, httpServer, sessions, start, stop }
}

// Auto-start when forked as daemon by client.ts
if (process.env.SUBAGENT_DAEMON) {
  app().start()
}
