const { describe, it, before, after, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const net = require('net')
const fs = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { createServer } = require('http')
const WebSocket = require('ws')
const request = require('supertest')
const { app, SubagentClient } = require('../dist/app')
const { parseIpcUuid, discoverIpcByVscodePid } = require('../dist/app')

const TEST_HOME = join(tmpdir(), `ipc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const VALID_CWD = join(TEST_HOME, 'cwd')
const WIN_A_UUID = 'aaaa1111'
const WIN_B_UUID = 'bbbb2222'
const WIN_A_IPC = join(tmpdir(), `subagent-cli_${WIN_A_UUID}.sock`)
const WIN_B_IPC = join(tmpdir(), `subagent-cli_${WIN_B_UUID}.sock`)

const testConfig = {
  port: 0,
  home: TEST_HOME,
  idle: { timeout: 300, check_interval: 60, manager_timeout: -1, reuse_ratio: 0, fast_reuse: false },
  terminal: { cols: 80, rows: 24, scrollback: 1000 },
  subagents: {
    'test-agent': { adapter: 'claude-code', description: 'Test', command: 'echo', args: [], env: {} },
  },
}

// ── Mock adapter ──

function createMockAdapter() {
  const { EventEmitter } = require('events')
  const adapter = new EventEmitter()
  const params = { subagent: '', adapter: '', cwd: '', command: '', args: [], env: {} }
  let state = 'IDLE'
  Object.assign(adapter, {
    name: 'mock',
    open(p) { Object.assign(params, p); state = 'IDLE' },
    prompt: (text) => { state = 'IDLE'; return Promise.resolve({ status: 'done', output: text }) },
    approve: () => Promise.resolve({ status: 'done' }),
    allow: () => Promise.resolve({ status: 'done' }),
    reject: () => Promise.resolve({ status: 'done' }),
    cancel: () => Promise.resolve({ status: 'done' }),
    status: () => ({ state, subagent: params.subagent, cwd: params.cwd, created_at: new Date().toISOString(), role: params.role ?? '' }),
    check: () => Promise.resolve({ state, subagent: params.subagent, cwd: params.cwd, created_at: new Date().toISOString(), role: params.role ?? '' }),
    getOutput: (type) => Promise.resolve({ type, content: '', lines: 0 }),
    getPrompts: () => [],
    getSessionId: () => undefined,
    getParams: () => params,
    getIpcPath: () => params.ipc_path,
    write: () => {},
    resize: () => {},
    close: () => { state = 'CLOSED'; return Promise.resolve() },
    setAutoApprove() {},
  })
  return adapter
}

// ── parseIpcUuid ──

describe('parseIpcUuid', () => {
  it('extracts UUID from canonical macOS/Linux path', () => {
    assert.equal(parseIpcUuid('/tmp/subagent-cli_aaaa1111.sock'), 'aaaa1111')
  })
  it('extracts UUID from Windows-style pipe name', () => {
    assert.equal(parseIpcUuid('\\\\.\\pipe\\subagent-cli_bbbb2222'), 'bbbb2222')
  })
  it('falls back to basename for non-canonical paths', () => {
    assert.equal(parseIpcUuid('/tmp/custom.sock'), 'custom')
  })
})

// ── App ownership middleware ──

describe('App window ownership', () => {
  let ctx
  let agent

  before(() => {
    fs.mkdirSync(join(TEST_HOME, 'sessions'), { recursive: true })
    fs.mkdirSync(VALID_CWD, { recursive: true })
  })
  after(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  })
  beforeEach(() => {
    fs.rmSync(join(TEST_HOME, 'sessions'), { recursive: true, force: true })
    fs.mkdirSync(join(TEST_HOME, 'sessions'), { recursive: true })
    ctx = app({ config: testConfig, adapterFactory: () => createMockAdapter(), onExit: () => {} })
    agent = request(ctx.app.callback())
  })
  afterEach(() => { ctx.stop() })

  async function openSession(ipcPath) {
    const body = { subagent: 'test-agent', cwd: VALID_CWD }
    if (ipcPath) body.ipc_path = ipcPath
    const res = await agent.post('/api/open')
      .set('Content-Type', 'application/json')
      .set(ipcPath ? { 'X-Subagent-Cli-IPC': ipcPath } : {})
      .send(body)
    return res.body.data.session
  }

  it('GET /api/sessions: header-set caller sees only its window; clientless CLI sees ALL', async () => {
    const sA = await openSession(WIN_A_IPC)
    const sB = await openSession(WIN_B_IPC)
    const sGlobal = await openSession()

    // VS Code window A sees only A's session
    const resA = await agent.get('/api/sessions').set('X-Subagent-Cli-IPC', WIN_A_IPC).expect(200)
    assert.deepEqual(resA.body.data.sessions.map(s => s.session).sort(), [sA].sort())

    // VS Code window B sees only B's session
    const resB = await agent.get('/api/sessions').set('X-Subagent-Cli-IPC', WIN_B_IPC).expect(200)
    assert.deepEqual(resB.body.data.sessions.map(s => s.session).sort(), [sB].sort())

    // CLI / admin (no header) sees every session, including window-bound ones
    const resCli = await agent.get('/api/sessions').expect(200)
    assert.deepEqual(resCli.body.data.sessions.map(s => s.session).sort(), [sA, sB, sGlobal].sort())
  })

  it('single-session route rejects cross-window with 403 WINDOW_MISMATCH', async () => {
    const sA = await openSession(WIN_A_IPC)
    const res = await agent.get(`/api/session/${sA}/status`)
      .set('X-Subagent-Cli-IPC', WIN_B_IPC)
    assert.equal(res.status, 403)
    assert.equal(res.body.data.error, 'WINDOW_MISMATCH')
  })

  it('single-session route allows same-window access', async () => {
    const sA = await openSession(WIN_A_IPC)
    const res = await agent.get(`/api/session/${sA}/status`)
      .set('X-Subagent-Cli-IPC', WIN_A_IPC)
    assert.equal(res.status, 200)
  })

  it('single-session route: header-less CLI has admin access to window-bound sessions', async () => {
    const sA = await openSession(WIN_A_IPC)
    const res = await agent.get(`/api/session/${sA}/status`)
    assert.equal(res.status, 200, 'CLI/admin caller must reach any session even when no header is set')
    assert.equal(res.body.data.state, 'IDLE')
  })

  it('POST /close from header-less CLI really closes a window-bound session', async () => {
    const sA = await openSession(WIN_A_IPC)
    const res = await agent.post(`/api/session/${sA}/close`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.status, 'closed')
    // Verify it's really gone from active sessions (CLI sees everything → check via clientless GET)
    const after = await agent.get('/api/sessions').expect(200)
    const sAState = after.body.data.sessions.find(x => x.session === sA)?.state
    assert.equal(sAState, 'CLOSED', 'session must be CLOSED (from-disk listing) after admin close')
  })

  it('POST /api/close only closes caller-window sessions', async () => {
    const sA = await openSession(WIN_A_IPC)
    const sB = await openSession(WIN_B_IPC)
    await agent.post('/api/close').set('X-Subagent-Cli-IPC', WIN_A_IPC).expect(200)

    // Session B should still be IDLE in window B
    const after = await agent.get('/api/sessions').set('X-Subagent-Cli-IPC', WIN_B_IPC).expect(200)
    const sBState = after.body.data.sessions.find(s => s.session === sB)?.state
    assert.equal(sBState, 'IDLE')

    // Session A is removed from memory but its history remains on disk → listed as CLOSED
    const checkA = await agent.get('/api/sessions').set('X-Subagent-Cli-IPC', WIN_A_IPC).expect(200)
    const sAState = checkA.body.data.sessions.find(s => s.session === sA)?.state
    assert.equal(sAState, 'CLOSED')
  })
})

// ── WebSocket /ws?client= validation ──

describe('WebSocket window ownership', () => {
  let ctx
  let httpServer
  let port

  before(async () => {
    fs.mkdirSync(join(TEST_HOME, 'sessions'), { recursive: true })
    fs.mkdirSync(VALID_CWD, { recursive: true })
    ctx = app({ config: { ...testConfig, port: 0 }, adapterFactory: () => createMockAdapter(), onExit: () => {} })
    await ctx.start()
    port = ctx.httpServer.address().port
    httpServer = ctx.httpServer
  })

  after(() => {
    ctx.stop()
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  })

  async function openSessionViaHttp(ipcPath) {
    const body = JSON.stringify(ipcPath ? { subagent: 'test-agent', cwd: VALID_CWD, ipc_path: ipcPath } : { subagent: 'test-agent', cwd: VALID_CWD })
    const res = await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ipcPath ? { 'X-Subagent-Cli-IPC': ipcPath } : {}) },
      body,
    })
    const j = await res.json()
    return j.data.session
  }

  function connectWs(session, client) {
    const qs = client ? `?session=${session}&client=${client}` : `?session=${session}`
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${qs}`)
      ws.on('open', () => { setTimeout(() => { if (ws.readyState === WebSocket.OPEN) resolve({ status: 'open', ws }) }, 80) })
      ws.on('close', (code) => resolve({ status: 'closed', code }))
      ws.on('error', () => {})
    })
  }

  it('accepts client UUID matching session ipc_path', async () => {
    const s = await openSessionViaHttp(WIN_A_IPC)
    const r = await connectWs(s, `${WIN_A_UUID}_001`)
    assert.equal(r.status, 'open')
    r.ws.close()
  })

  it('rejects client UUID not matching session ipc_path (4003 WINDOW_MISMATCH)', async () => {
    const s = await openSessionViaHttp(WIN_A_IPC)
    const r = await connectWs(s, `${WIN_B_UUID}_001`)
    assert.equal(r.status, 'closed')
    assert.equal(r.code, 4003)
  })

  it('accepts multi-segment uuid <hash>_<pid> (new socket naming)', async () => {
    // parseIpcUuid returns "abcd1234_45764"; client_id appends a counter.
    // split('_')[0] would wrongly yield "abcd1234" → false 4003. replace(/_\d+$/) keeps the pid.
    const ipc = join(tmpdir(), 'subagent-cli_abcd1234_45764.sock')
    const s = await openSessionViaHttp(ipc)
    const r = await connectWs(s, 'abcd1234_45764_001')
    assert.equal(r.status, 'open')
    r.ws.close()
  })

  it('rejects multi-segment uuid from a different window (different pid)', async () => {
    const ipc = join(tmpdir(), 'subagent-cli_abcd1234_45764.sock')
    const s = await openSessionViaHttp(ipc)
    const r = await connectWs(s, 'abcd1234_99999_001')
    assert.equal(r.status, 'closed')
    assert.equal(r.code, 4003)
  })

  it('allows clientless connection to a window-bound session (browser viewer broadcast)', async () => {
    const s = await openSessionViaHttp(WIN_A_IPC)
    const r = await connectWs(s)
    assert.equal(r.status, 'open')
    r.ws.close()
  })

  it('allows global session without client (legacy viewer)', async () => {
    const s = await openSessionViaHttp()
    const r = await connectWs(s)
    assert.equal(r.status, 'open')
    r.ws.close()
  })

  it('POST /api/session/:id/close kicks browser viewer (4001) and prevents reconnect (4004)', async () => {
    const s = await openSessionViaHttp(WIN_A_IPC)
    const viewer = await connectWs(s)
    assert.equal(viewer.status, 'open', 'browser-style WS (no client) should connect')

    const closeEvent = new Promise(resolve => viewer.ws.once('close', (code) => resolve(code)))

    const res = await fetch(`http://127.0.0.1:${port}/api/session/${s}/close`, {
      method: 'POST',
      headers: { 'X-Subagent-Cli-IPC': WIN_A_IPC },
    })
    assert.equal(res.status, 200)

    const code = await closeEvent
    assert.equal(code, 4001, 'viewer WS should be kicked with 4001 Session closed')

    const reconnect = await connectWs(s)
    assert.equal(reconnect.status, 'closed')
    assert.equal(reconnect.code, 4004, 'reconnect to deleted session should be rejected with 4004')

    const listing = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { 'X-Subagent-Cli-IPC': WIN_A_IPC },
    })).json()
    const sState = listing.data.sessions.find(x => x.session === s)?.state
    assert.equal(sState, 'CLOSED', 'after close, session should appear as CLOSED in listing (from disk)')
  })
})

// ── SubagentClient IPC handshake ──

describe('SubagentClient IPC', () => {
  let socketPath
  let ipcServer
  let savedVscodePid
  const receivedCalls = []

  beforeEach(() => {
    socketPath = join(tmpdir(), `subagent-cli-ipc-test_${Date.now()}_${Math.random().toString(36).slice(2)}.sock`)
    fs.existsSync(socketPath) && fs.unlinkSync(socketPath)
    receivedCalls.length = 0
    // Tests run inside VS Code where VSCODE_PID is set + a real extension socket
    // may exist; neutralize it so glob fallback stays off unless a test opts in.
    savedVscodePid = process.env.VSCODE_PID
    delete process.env.VSCODE_PID
  })

  afterEach(() => {
    ipcServer?.close()
    fs.existsSync(socketPath) && fs.unlinkSync(socketPath)
    delete process.env.SUBAGENT_VSCODE_IPC
    savedVscodePid === undefined ? delete process.env.VSCODE_PID : (process.env.VSCODE_PID = savedVscodePid)
  })

  function startMockIpcServer(handler) {
    return new Promise((resolve) => {
      ipcServer = net.createServer((sock) => {
        const chunks = []
        let expected = -1
        sock.on('data', (chunk) => {
          chunks.push(chunk)
          const all = Buffer.concat(chunks)
          if (expected < 0 && all.length >= 4) expected = all.readUInt32BE(0)
          if (expected >= 0 && all.length >= 4 + expected) {
            const json = all.slice(4, 4 + expected).toString('utf-8')
            const msg = JSON.parse(json)
            receivedCalls.push(msg)
            const reply = handler(msg) ?? { success: true }
            const replyBuf = Buffer.from(JSON.stringify(reply), 'utf-8')
            const header = Buffer.alloc(4)
            header.writeUInt32BE(replyBuf.length, 0)
            sock.write(Buffer.concat([header, replyBuf]))
            sock.end()
          }
        })
      })
      ipcServer.listen(socketPath, () => resolve())
    })
  }

  it('shouldUseIPC returns false when env missing', async () => {
    delete process.env.SUBAGENT_VSCODE_IPC
    const c = new SubagentClient()
    // call a private method via the public path
    const result = await c['shouldUseIPC']()
    assert.equal(result, false)
  })

  it('shouldUseIPC returns false when socket has no listener (orphan env)', async () => {
    process.env.SUBAGENT_VSCODE_IPC = socketPath  // no server bound
    const c = new SubagentClient()
    const result = await c['shouldUseIPC']()
    assert.equal(result, false)
  })

  it('shouldUseIPC returns true when peer is reachable', async () => {
    await startMockIpcServer(() => ({ success: true }))
    process.env.SUBAGENT_VSCODE_IPC = socketPath
    const c = new SubagentClient()
    const result = await c['shouldUseIPC']()
    assert.equal(result, true)
  })

  it('shouldUseIPC falls back to VSCODE_PID glob when env missing, and writes path back', async () => {
    const pid = String(900000 + Math.floor(Math.random() * 90000))
    socketPath = join(tmpdir(), `subagent-cli_globfb1_${pid}.sock`)
    await startMockIpcServer(() => ({ success: true }))
    delete process.env.SUBAGENT_VSCODE_IPC
    process.env.VSCODE_PID = pid
    const c = new SubagentClient()
    assert.equal(await c['shouldUseIPC'](), true)
    // discovered path is written back so handshake + header target the right window
    assert.equal(c['ipcPath'], socketPath)
  })

  it('shouldUseIPC prefers reachable env path over glob (no discovery needed)', async () => {
    await startMockIpcServer(() => ({ success: true }))
    process.env.SUBAGENT_VSCODE_IPC = socketPath
    process.env.VSCODE_PID = '987654'  // would glob-miss, but env wins first
    const c = new SubagentClient()
    assert.equal(await c['shouldUseIPC'](), true)
    assert.equal(c['ipcPath'], socketPath)
  })

  it('ipcCall sends length-prefixed JSON and parses response', async () => {
    await startMockIpcServer((msg) => {
      if (msg.method === 'prepareTerminal') return { success: true, client_id: `${WIN_A_UUID}_007` }
      return { success: true }
    })
    process.env.SUBAGENT_VSCODE_IPC = socketPath
    const c = new SubagentClient()
    const r = await c['ipcCall']('prepareTerminal')
    assert.equal(r.client_id, `${WIN_A_UUID}_007`)
    assert.equal(receivedCalls[0].method, 'prepareTerminal')
  })

  it('open() forwards subagent name to prepareTerminal (VS Code tab title)', async () => {
    fs.mkdirSync(VALID_CWD, { recursive: true })
    await startMockIpcServer((msg) => {
      if (msg.method === 'prepareTerminal') return { success: true, client_id: `${WIN_A_UUID}_001` }
      return { success: true }
    })
    const ctx = app({ config: { ...testConfig, port: 0 }, adapterFactory: () => createMockAdapter(), onExit: () => {} })
    await ctx.start()
    process.env.SUBAGENT_VSCODE_IPC = socketPath
    const c = new SubagentClient()
    c['port'] = ctx.httpServer.address().port
    await c.open({ subagent: 'test-agent', cwd: VALID_CWD })
    ctx.stop()
    const prep = receivedCalls.find((m) => m.method === 'prepareTerminal')
    assert.ok(prep, 'prepareTerminal should have been called')
    assert.equal(prep.params.subagent, 'test-agent')
  })
})

// ── discoverIpcByVscodePid (glob fallback) ──

describe('discoverIpcByVscodePid', () => {
  const servers = []
  const files = []
  let savedVscodePid
  let pidSeq = 0

  // Unique pid per call avoids cross-test collisions in the shared tmpdir.
  function uniquePid() {
    pidSeq += 1
    return String(700000 + pidSeq)
  }

  // Start a listening unix socket; returns its full path.
  function liveSocket(name) {
    const p = join(tmpdir(), name)
    fs.existsSync(p) && fs.unlinkSync(p)
    files.push(p)
    return new Promise((resolve) => {
      const srv = net.createServer((s) => s.end())
      servers.push(srv)
      srv.listen(p, () => resolve(p))
    })
  }

  // Create a stale socket-looking file with no listener.
  function deadSocketFile(name) {
    const p = join(tmpdir(), name)
    fs.existsSync(p) && fs.unlinkSync(p)
    fs.writeFileSync(p, '')
    files.push(p)
    return p
  }

  beforeEach(() => { savedVscodePid = process.env.VSCODE_PID })
  afterEach(() => {
    savedVscodePid === undefined ? delete process.env.VSCODE_PID : (process.env.VSCODE_PID = savedVscodePid)
  })
  after(() => {
    servers.forEach((s) => s.close())
    files.forEach((p) => fs.existsSync(p) && fs.unlinkSync(p))
  })

  it('returns undefined when VSCODE_PID is not set', async () => {
    delete process.env.VSCODE_PID
    assert.equal(await discoverIpcByVscodePid(), undefined)
  })

  it('finds the live socket whose name carries the matching VSCODE_PID', async () => {
    const pid = uniquePid()
    const p = await liveSocket(`subagent-cli_abc12345_${pid}.sock`)
    process.env.VSCODE_PID = pid
    assert.equal(await discoverIpcByVscodePid(), p)
  })

  it('wildcards the workspace-hash segment (any hash, exact pid)', async () => {
    const pid = uniquePid()
    const p = await liveSocket(`subagent-cli_ffffffff_${pid}.sock`)
    process.env.VSCODE_PID = pid
    assert.equal(await discoverIpcByVscodePid(), p)
  })

  it('ignores a socket whose pid segment differs', async () => {
    const otherPid = uniquePid()
    await liveSocket(`subagent-cli_deadbeef_${otherPid}.sock`)
    process.env.VSCODE_PID = uniquePid() + '0'  // no socket for this pid
    assert.equal(await discoverIpcByVscodePid(), undefined)
  })

  it('skips a dead socket file (no listener) and returns undefined', async () => {
    const pid = uniquePid()
    deadSocketFile(`subagent-cli_cafe0000_${pid}.sock`)
    process.env.VSCODE_PID = pid
    assert.equal(await discoverIpcByVscodePid(), undefined)
  })

  it('does not collide on pid substring (leading underscore guards)', async () => {
    // socket for pid 457, query pid 57 → must NOT match `..._457.sock`
    await liveSocket(`subagent-cli_hash0001_457.sock`)
    process.env.VSCODE_PID = '57'
    assert.equal(await discoverIpcByVscodePid(), undefined)
  })
})
