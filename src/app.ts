import Koa from 'koa'
import Router from '@koa/router'
import { createServer, type Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { loadConfig, ensureDirs, getHome, applyHome, type AppConfig } from './config'
import { createAdapter, parseIpcUuid, SubagentCliAdapter } from './adapter'
import { PtyXterm } from './pty_xterm'
import type { OpenParams } from './types'
import { VIEWER_HTML, renderViewerIndex, renderSessionRow } from './viewer_template'

// Daemon registry file — `<pid>,<port>` single line. Written on start, cleared on shutdown.
// Client side reads/parses this file directly (see src/client.ts); no shared module is needed
// for two write operations on the daemon side.
const daemonPidPath = (): string => join(getHome(), 'daemon.pid')

// Load all adapters (self-register)
import './adapters/claude_code'
import './adapters/codex'
import './adapters/gemini_cli'

// Re-export internal modules for testing
export { PtyXterm } from './pty_xterm'
export { ClaudeCodeAdapter } from './adapters/claude_code'
export { CodexAdapter } from './adapters/codex'
export { GeminiCliAdapter } from './adapters/gemini_cli'
export { SubagentClient, discoverIpcByVscodePid } from './client'
export { parseIpcUuid } from './adapter'
// Augment Koa request with parsed body
declare module 'koa' {
  interface Request {
    body?: unknown
  }
}

export interface AppOptions {
  config?: AppConfig
  adapterFactory?: (adapterName: string) => SubagentCliAdapter
  /** Process exit hook (default: process.exit). Overridable for tests. */
  onExit?: (code: number) => void
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
  // SUBAGENT_PORT (set by forkDaemonAndWait) overrides config so `daemon start --port` binds correctly
  if (process.env.SUBAGENT_PORT) config.port = Number(process.env.SUBAGENT_PORT)
  applyHome(config.home)
  const buildAdapter = (isOptions ? (opts as AppOptions).adapterFactory : undefined) ?? createAdapter
  const onExit = (isOptions ? (opts as AppOptions).onExit : undefined) ?? ((code: number) => process.exit(code))
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
    const cfgFile = join(dir, 'config.json')
    const prev = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf-8')) : {}
    const meta: Record<string, unknown> = {
      subagent: params.subagent, adapter: params.adapter,
      cwd: params.cwd, command: params.command,
      args: params.args, env: params.env,
      created_at: prev.created_at ?? new Date().toISOString(),
    }
    const finalResume = resumeId ?? prev.resume_id
    if (finalResume) meta.resume_id = finalResume
    const finalIpc = params.ipc_path ?? prev.ipc_path
    if (finalIpc) meta.ipc_path = finalIpc
    const finalRole = params.role ?? prev.role
    if (finalRole) meta.role = finalRole
    writeFileSync(cfgFile, JSON.stringify(meta, null, 2) + '\n')
    const historyFile = join(dir, 'history.md')
    if (!existsSync(historyFile)) {
      writeFileSync(historyFile, `# Session ${id} — ${params.subagent}\n\n`)
    }
  }

  function deleteSessionDir(id: string): void {
    const dir = sessionDir(id)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  /** Last-activity timestamp = mtime of history.md (only meaningful interactions touch it,
   *  so TUI cursor blinks / status-bar refreshes don't pollute it like in-memory PTY tracking does). */
  function sessionLastAt(id: string): number {
    const f = join(sessionDir(id), 'history.md')
    try { return statSync(f).mtimeMs } catch { return 0 }
  }

  /**
   * Try to reuse an existing session matching cwd + subagent + adapter.
   *
   * Priority:
   *   1. Active IDLE session, cooled down (idle for >= timeout * reuse_ratio)
   *      → pick oldest lastActivity (least likely to be in use by another caller)
   *   2. Disk CLOSED session with resume_id → resume the newest one
   *   3. None → null (caller should create new)
   */
  async function tryReuseSession(
    cwd: string,
    subagentName: string,
    adapterName: string,
    timeout: number,
    inlinePrompt?: string,
    excludeSession?: string,
    callerIpcPath = '',
    auto = false,
  ): Promise<Record<string, unknown> | null> {
    const ratio = config.idle.reuse_ratio ?? 0.5
    const minIdleMs = config.idle.timeout * 1000 * ratio
    const now = Date.now()

    // ① Active IDLE candidates, cooled down, oldest lastActivity first
    // excludeSession filter prevents recursive subagent-cli calls from reusing their own parent session
    // ipc_path filter enforces window-scoped reuse (callers from window A cannot reuse window B's session)
    const activeCandidates = Array.from(sessions.entries())
      .filter(([id, a]) => {
        if (excludeSession && id === excludeSession) return false
        if ((a.getIpcPath() ?? '') !== callerIpcPath) return false
        const s = a.status()
        const p = a.getParams()
        const idleAge = now - (lastActivity.get(id) ?? now)
        return s.cwd === cwd
          && s.subagent === subagentName
          && p.adapter === adapterName
          && s.state === 'IDLE'
          && idleAge >= minIdleMs
      })
      .sort(([a], [b]) => (lastActivity.get(a) ?? 0) - (lastActivity.get(b) ?? 0))

    if (activeCandidates.length > 0) {
      const [id, adapter] = activeCandidates[0]
      trackActivity(id, adapter)
      if (auto) adapter.setAutoApprove(true)
      if (inlinePrompt) {
        const r = await adapter.prompt(inlinePrompt, timeout)
        return { session: id, reused: true, ...r }
      }
      return { session: id, reused: true }
    }

    // ② Disk CLOSED candidates with resume_id, newest first
    const sessDir = join(getHome(), 'sessions')
    if (!existsSync(sessDir)) return null
    const diskCandidates = readdirSync(sessDir)
      .filter(id => !sessions.has(id))
      .filter(id => !excludeSession || id !== excludeSession)
      .map(id => {
        const cfgFile = join(sessDir, id, 'config.json')
        if (!existsSync(cfgFile)) return null
        try {
          const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
          if (saved.cwd !== cwd || saved.subagent !== subagentName
              || saved.adapter !== adapterName || !saved.resume_id) return null
          if ((saved.ipc_path ?? '') !== callerIpcPath) return null
          return { id, saved }
        } catch { return null }
      })
      .filter((x): x is { id: string; saved: Record<string, unknown> } => x !== null)
      .sort((a, b) => String(b.saved.created_at).localeCompare(String(a.saved.created_at)))

    if (diskCandidates.length === 0) return null

    // Resume the newest disk session
    const { id, saved } = diskCandidates[0]
    const adapter = buildAdapter(adapterName)
    const args = adapter.buildResumeArgs(saved.resume_id as string, saved.args as string[])
    // Override SUBAGENT_CLI_SESSION env so the resumed session knows its own id (prevents self-reuse on recursive call)
    const env = { ...(saved.env as Record<string, string>), SUBAGENT_CLI_SESSION: id }
    const params: OpenParams = {
      subagent: saved.subagent as string, adapter: adapterName,
      cwd: saved.cwd as string, command: saved.command as string,
      args, env,
      ...(saved.ipc_path ? { ipc_path: saved.ipc_path as string } : {}),
      ...(saved.role ? { role: saved.role as string } : {}),
    }
    sessions.set(id, adapter)
    trackActivity(id, adapter)
    try {
      await adapter.open(params, id, getHome(), timeout)
    } catch (err) {
      sessions.delete(id)
      lastActivity.delete(id)
      await adapter.close()
      throw err
    }
    if (auto) adapter.setAutoApprove(true)
    if (inlinePrompt) {
      const r = await adapter.prompt(inlinePrompt, timeout)
      return { session: id, reused: true, ...r }
    }
    return { session: id, reused: true }
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

  /** Read X-Subagent-Cli-IPC request header; empty string means "non-VS Code caller". */
  function getCallerIpc(ctx: Koa.Context): string {
    return (ctx.headers['x-subagent-cli-ipc'] as string | undefined) ?? ''
  }

  /** Read ipc_path from a persisted session config.json (for closed/disk sessions). */
  function diskSessionIpc(id: string): string {
    const cfgFile = join(sessionDir(id), 'config.json')
    if (!existsSync(cfgFile)) return ''
    try {
      const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
      return (saved.ipc_path as string | undefined) ?? ''
    } catch { return '' }
  }

  // ── Window ownership middleware (single-session routes) ──
  // Window-scope access on `/api/session/:id/*` routes.
  // - caller header empty → CLI/admin: full access to every session
  // - caller header set + session ipc set + values equal → allow (same window)
  // - caller header set + mismatch (incl. session ipc empty) → 403 WINDOW_MISMATCH
  router.use('/session/:id', async (ctx, next) => {
    const id = ctx.params.id
    const adapter = sessions.get(id)
    const sessionIpc = adapter ? (adapter.getIpcPath() ?? '') : diskSessionIpc(id)
    // For brand-new sessions or non-existent ids we let the route handler return 404
    if (!adapter && !sessionIpc) return next()
    const callerIpc = getCallerIpc(ctx)
    if (callerIpc !== '' && callerIpc !== sessionIpc) {
      fail(ctx, 403, 'WINDOW_MISMATCH', `Session ${id} is bound to a different window`)
      return
    }
    return next()
  })

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
    const callerIpc = getCallerIpc(ctx)

    const active = Array.from(sessions.entries())
      .filter(([, adapter]) => callerIpc === '' || (adapter.getIpcPath() ?? '') === callerIpc)
      .map(([id, adapter]) => ({ session: id, ...adapter.status(), prompts: adapter.getPrompts(), last_at: sessionLastAt(id) }))

    const sessDir = join(getHome(), 'sessions')
    const closed = existsSync(sessDir)
      ? readdirSync(sessDir)
        .filter(id => !sessions.has(id))
        .map(id => {
          const cfgFile = join(sessDir, id, 'config.json')
          if (!existsSync(cfgFile)) return null
          const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
          if (callerIpc !== '' && (saved.ipc_path ?? '') !== callerIpc) return null
          return {
            session: id, state: 'CLOSED' as const,
            subagent: saved.subagent, adapter: saved.adapter,
            cwd: saved.cwd, created_at: saved.created_at, prompts: [] as string[],
            role: (saved.role as string | undefined) ?? '',
            last_at: sessionLastAt(id),
          }
        })
        .filter(Boolean) as Array<{ session: string; state: string; subagent: string; adapter: string; cwd: string; created_at: string; prompts: string[]; role: string; last_at: number }>
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
      // Inject SUBAGENT_CLI_SESSION so recursive subagent-cli calls inside this session can self-exclude
      const env = { ...subCfg.env, SUBAGENT_CLI_SESSION: sessionId }
      const params: OpenParams = {
        subagent: saved.subagent, adapter: subCfg.adapter,
        cwd: saved.cwd, command: subCfg.command, args, env,
        ...(saved.ipc_path ? { ipc_path: saved.ipc_path as string } : {}),
        ...(saved.role ? { role: saved.role as string } : {}),
      }
      if (!existsSync(params.cwd)) { fail(ctx, 400, 'INVALID_STATE', `Working directory does not exist: ${params.cwd}`); return }
      sessions.set(sessionId, adapter)
      trackActivity(sessionId, adapter)
      try {
        await adapter.open(params, sessionId, getHome(), timeout)
      } catch (err) {
        sessions.delete(sessionId)
        lastActivity.delete(sessionId)
        await adapter.close()
        throw err
      }
      // Optional auto-approve + inline prompt
      if (body.auto) adapter.setAutoApprove(true)
      const inlinePrompt = body.prompt as string | undefined
      if (inlinePrompt) {
        const r = await adapter.prompt(inlinePrompt, timeout)
        ok(ctx, { session: sessionId, ...r }); return
      }
      ok(ctx, { session: sessionId }); return
    }

    // New session
    const subagentName = body.subagent as string | undefined
    if (!subagentName) { fail(ctx, 400, 'INVALID_STATE', 'Missing "subagent" field'); return }
    const subCfg = config.subagents[subagentName]
    if (!subCfg) { fail(ctx, 400, 'SUBAGENT_NOT_FOUND', `Unknown subagent: ${subagentName}`); return }

    const cwd = (body.cwd as string | undefined) ?? process.cwd()
    if (!existsSync(cwd)) { fail(ctx, 400, 'INVALID_STATE', `Working directory does not exist: ${cwd}`); return }

    // ── Reuse logic ──
    const excludeSession = body.exclude_session as string | undefined
    const reuseEnabled = (body.reuse as boolean | undefined) ?? config.idle.fast_reuse ?? false
    const bodyIpcPath = body.ipc_path as string | undefined
    if (reuseEnabled) {
      const reused = await tryReuseSession(cwd, subagentName, subCfg.adapter, timeout, body.prompt as string | undefined, excludeSession, bodyIpcPath ?? '', body.auto === true)
      if (reused) { ok(ctx, reused); return }
    }

    const id = (sessionId ?? generateId()) as string
    const adapter = buildAdapter(subCfg.adapter)
    const role = (body.role as string | undefined) ?? subCfg.role
    // Inject SUBAGENT_CLI_SESSION so recursive subagent-cli calls inside this session can self-exclude
    const env = { ...subCfg.env, SUBAGENT_CLI_SESSION: id }
    const params: OpenParams = {
      subagent: subagentName, adapter: subCfg.adapter,
      cwd, command: subCfg.command, args: subCfg.args, env,
      ...(role ? { role } : {}),
      ...(bodyIpcPath ? { ipc_path: bodyIpcPath } : {}),
    }
    sessions.set(id, adapter)
    trackActivity(id, adapter)
    mkdirSync(sessionDir(id), { recursive: true })
    try {
      console.error(`[open] calling adapter.open for ${id}`)
      await adapter.open(params, id, getHome(), timeout)
      console.error(`[open] adapter.open returned for ${id}, sessionId=${adapter.getSessionId()}`)
    } catch (err) {
      sessions.delete(id)
      lastActivity.delete(id)
      await adapter.close()
      throw err
    }
    // Listen for unexpected exit: cleanup session from memory
    adapter.once('unexpected-exit', () => {
      console.error(`[unexpected-exit] session ${id} died unexpectedly`)
      sessions.delete(id)
      lastActivity.delete(id)
      closeViewerSockets(id)
      persistSession(id, params, adapter.getSessionId())
    })
    persistSession(id, params, adapter.getSessionId())
    console.error(`[open] persisted, sending ok for ${id}`)
    // Optional auto-approve + inline prompt
    if (body.auto) adapter.setAutoApprove(true)
    const inlinePrompt = body.prompt as string | undefined
    if (inlinePrompt) {
      const r = await adapter.prompt(inlinePrompt, timeout)
      ok(ctx, { session: id, ...r }); return
    }
    ok(ctx, { session: id })
  })

  // POST /api/session/:id/prompt
  router.post('/session/:id/prompt', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    const { prompt, timeout, auto } = ctx.request.body as { prompt: string; timeout?: number; auto?: boolean }
    try {
      if (auto) adapter.setAutoApprove(true)
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
    const adapter = sessions.get(ctx.params.id)
    if (!adapter) {
      const cfgFile = join(sessionDir(ctx.params.id), 'config.json')
      if (existsSync(cfgFile)) {
        const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
        ok(ctx, { session: ctx.params.id, state: 'CLOSED', subagent: saved.subagent, cwd: saved.cwd, created_at: saved.created_at })
        return
      }
      fail(ctx, 404, 'SESSION_NOT_FOUND', `Session ${ctx.params.id} does not exist`); return
    }
    ok(ctx, { session: ctx.params.id, ...adapter.status() })
  })

  // GET /api/session/:id/check (screen-calibrated state, optional polling)
  router.get('/session/:id/check', async (ctx) => {
    const adapter = sessions.get(ctx.params.id)
    if (!adapter) {
      const cfgFile = join(sessionDir(ctx.params.id), 'config.json')
      if (existsSync(cfgFile)) {
        const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
        ok(ctx, { session: ctx.params.id, state: 'CLOSED', subagent: saved.subagent, cwd: saved.cwd, created_at: saved.created_at })
        return
      }
      fail(ctx, 404, 'SESSION_NOT_FOUND', `Session ${ctx.params.id} does not exist`); return
    }
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
      if (result.state === 'ASKING' && !adapter.autoApprove) {
        fail(ctx, 409, 'APPROVAL_NEEDED', 'Session requires approval'); return
      }
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
    // Persist resume_id parsed from exit output (last_at is derived from history.md mtime at read time)
    persistSession(ctx.params.id, adapter.getParams(), adapter.getSessionId())
    sessions.delete(ctx.params.id)
    lastActivity.delete(ctx.params.id)
    closeViewerSockets(ctx.params.id)
    ok(ctx, { session: ctx.params.id, status: 'exited' })
    checkAutoExit()
  })

  // POST /api/session/:id/close (keep dir)
  router.post('/session/:id/close', async (ctx) => {
    const adapter = getAdapter(ctx); if (!adapter) return
    await adapter.close()
    // resume_id only if captured during graceful close; last_at = history.md mtime, read on demand
    persistSession(ctx.params.id, adapter.getParams(), adapter.getSessionId())
    sessions.delete(ctx.params.id)
    lastActivity.delete(ctx.params.id)
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
  router.del('/session/:id', async (ctx) => {
    const id = ctx.params.id
    const adapter = sessions.get(id)
    if (adapter) { await adapter.close(); sessions.delete(id); closeViewerSockets(id) }
    deleteSessionDir(id)
    ok(ctx, { session: id, status: 'deleted' })
    checkAutoExit()
  })

  // DELETE /api/sessions/closed (batch delete closed sessions)
  router.del('/sessions/closed', (ctx) => {
    const callerIpc = getCallerIpc(ctx)
    const sessDir = join(getHome(), 'sessions')
    const deleted = existsSync(sessDir)
      ? readdirSync(sessDir)
        .filter(id => !sessions.has(id))
        .filter(id => callerIpc === '' || diskSessionIpc(id) === callerIpc)
        .map(id => { deleteSessionDir(id); return id })
      : []
    ok(ctx, { deleted })
  })

  // DELETE /api/sessions/all (close active + delete all)
  router.del('/sessions/all', async (ctx) => {
    const callerIpc = getCallerIpc(ctx)
    const deleted: string[] = []
    const targets = Array.from(sessions.entries())
      .filter(([, adapter]) => callerIpc === '' || (adapter.getIpcPath() ?? '') === callerIpc)
    await Promise.all(targets.map(async ([id, adapter]) => {
      await adapter.close()
      closeViewerSockets(id)
      deleted.push(id)
      sessions.delete(id)
    }))
    const sessDir = join(getHome(), 'sessions')
    existsSync(sessDir) && readdirSync(sessDir)
      .filter(id => callerIpc === '' || diskSessionIpc(id) === callerIpc)
      .forEach(id => {
        deleteSessionDir(id)
        !deleted.includes(id) && deleted.push(id)
      })
    ok(ctx, { deleted })
    checkAutoExit()
  })

  // POST /api/close (close all, keep dirs)
  router.post('/close', async (ctx) => {
    const callerIpc = getCallerIpc(ctx)
    const closed: string[] = []
    const targets = Array.from(sessions.entries())
      .filter(([, adapter]) => callerIpc === '' || (adapter.getIpcPath() ?? '') === callerIpc)
    await Promise.all(targets.map(async ([id, adapter]) => {
      await adapter.close()
      persistSession(id, adapter.getParams(), adapter.getSessionId())
      closeViewerSockets(id)
      closed.push(id)
      sessions.delete(id)
      lastActivity.delete(id)
    }))
    ok(ctx, { closed })
    checkAutoExit()
  })

  // POST /api/shutdown (loopback only) — graceful daemon stop
  router.post('/shutdown', (ctx) => {
    const ip = ctx.request.ip
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === ''
    if (!loopback) { fail(ctx, 403, 'FORBIDDEN', 'shutdown only allowed from loopback'); return }
    ok(ctx, { status: 'shutting_down' })
    // Defer so the HTTP response flushes before the process tears down
    setTimeout(() => {
      clearInterval(idleTimer)
      if (autoExit.timer) clearTimeout(autoExit.timer)
      sessions.forEach(adapter => { adapter.close().catch(() => {}) })
      sessions.clear()
      wss.close()
      httpServer.close()
      existsSync(daemonPidPath()) && unlinkSync(daemonPidPath())
      onExit(0)
    }, 50)
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
        const activeRows = Array.from(sessions.entries()).map(([id, a]) => {
          const s = a.status()
          return renderSessionRow({ id, subagent: s.subagent, cwd: s.cwd, role: s.role, state: s.state, lastAt: sessionLastAt(id), closed: false })
        })
        const sessDir = join(getHome(), 'sessions')
        const closedRows = existsSync(sessDir)
          ? readdirSync(sessDir)
            .filter(id => !sessions.has(id))
            .map(id => {
              const cfgFile = join(sessDir, id, 'config.json')
              if (!existsSync(cfgFile)) return ''
              const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
              return renderSessionRow({ id, subagent: saved.subagent ?? '', cwd: saved.cwd ?? '', role: saved.role ?? '', state: 'CLOSED', lastAt: sessionLastAt(id), closed: true })
            })
            .filter(Boolean)
          : []
        ctx.body = renderViewerIndex([...activeRows, ...closedRows].join('\n'))
      }
    } else {
      await next()
    }
  })

  // ── WebSocket ──

  const httpServer = createServer(koaApp.callback())
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const sessionId = url.searchParams.get('session')
    if (!sessionId) { ws.close(4000, 'Missing session parameter'); return }
    const adapter = sessions.get(sessionId)
    if (!adapter) { ws.close(4004, 'Session not found'); return }
    // Window-scope check: if a client identifies itself with `client=<UUID>_<n>`,
    // the prefix UUID must match the session's ipc_path — this isolates other
    // VS Code windows' extensions. A clientless connection (browser /viewer) is a
    // legitimate local read-only observer and is allowed through so PTY broadcast
    // stays visible on both ends, as the design requires.
    const sessionIpc = adapter.getIpcPath()
    if (sessionIpc) {
      const expectedUuid = parseIpcUuid(sessionIpc)
      const clientId = url.searchParams.get('client') ?? ''
      // Strip only the trailing `_<counter>`; the uuid itself may contain `_`
      // (new naming `<hash>_<pid>`), so split('_')[0] would wrongly drop the pid.
      const clientUuid = clientId.replace(/_\d+$/, '')
      if (clientId && clientUuid !== expectedUuid) { ws.close(4003, 'WINDOW_MISMATCH'); return }
    }
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
        adapter.close().then(() => {
          persistSession(id, adapter.getParams(), adapter.getSessionId())
        }).catch(err => console.error(`[idle-close] ${id}:`, err))
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
      existsSync(daemonPidPath()) && unlinkSync(daemonPidPath())
      onExit(0)
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
      writeFileSync(daemonPidPath(), `${process.pid},${config.port}`)
      console.error(`App listening on http://localhost:${config.port}`)
      console.error(`Debug viewer: http://localhost:${config.port}/viewer`)
    })
  }

  function stop(): void {
    clearInterval(idleTimer)
    if (autoExit.timer) clearTimeout(autoExit.timer)
    // Fire-and-forget close — synchronous stop path
    sessions.forEach(adapter => { adapter.close().catch(() => {}) })
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
