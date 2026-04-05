const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const { app } = require('../dist/app')
const { mkdirSync, rmSync, existsSync } = require('fs')
const { join } = require('path')
const { tmpdir } = require('os')

// ── Test Config ──

const TEST_HOME = join(tmpdir(), `subagent-test-${Date.now()}`)
const VALID_CWD = join(tmpdir(), `subagent-test-cwd-${Date.now()}`)

const testConfig = {
  home: TEST_HOME,
  port: 0,
  idle: { timeout: 999999, check_interval: 999999, manager_timeout: -1 },
  terminal: { cols: 120, rows: 50, scrollback: 5000 },
  subagents: {
    'test-agent': {
      adapter: 'claude-code',
      description: 'Test agent',
      role: 'You are a helpful assistant.',
      command: 'echo',
      args: [],
      env: {},
    },
    'another-agent': {
      adapter: 'claude-code',
      description: 'Another test agent',
      role: 'You are a helpful assistant.',
      command: 'echo',
      args: [],
      env: {},
    },
  },
}

// ── Mock Adapter Factory ──

function createMockAdapter() {
  const EventEmitter = require('events')
  const adapter = new EventEmitter()

  let state = 'IDLE'
  const params = { subagent: '', adapter: '', cwd: '', command: '', args: [], env: {} }

  Object.assign(adapter, {
    name: 'mock',
    open(p) {
      Object.assign(params, p)
      state = 'READY'
    },
    waitUntilReady: () => Promise.resolve(),
    prompt: (text) => {
      // Simulate idempotent behavior: if ASKING, return approval info
      if (state === 'ASKING') {
        return Promise.resolve({ status: 'approval_needed', output: 'pending approval', approval: { tool: 'Write', target: 'test.txt' } })
      }
      state = 'IDLE'
      return Promise.resolve({ status: 'done', output: `Mock response to: ${text}` })
    },
    approve: (prompt) => {
      // Idempotent: if IDLE, return done
      if (state === 'IDLE') return Promise.resolve({ status: 'done' })
      if (state === 'RUNNING') return Promise.resolve({ status: 'waiting' })
      state = 'IDLE'
      return Promise.resolve({ status: 'done', output: prompt ? `Amended: ${prompt}` : 'Approved' })
    },
    allow: () => {
      if (state === 'IDLE') return Promise.resolve({ status: 'done' })
      if (state === 'RUNNING') return Promise.resolve({ status: 'waiting' })
      state = 'IDLE'
      return Promise.resolve({ status: 'done', output: 'Allowed' })
    },
    reject: (prompt) => {
      if (state === 'IDLE') return Promise.resolve({ status: 'done' })
      if (state === 'RUNNING') return Promise.resolve({ status: 'waiting' })
      state = 'IDLE'
      return Promise.resolve({ status: 'done', output: prompt ? `Rejected: ${prompt}` : 'Rejected' })
    },
    cancel: () => {
      if (state !== 'RUNNING') return Promise.resolve({ status: 'done' })
      state = 'IDLE'
      return Promise.resolve({ status: 'done' })
    },
    status: () => ({
      state,
      subagent: params.subagent,
      cwd: params.cwd,
      created_at: new Date().toISOString(),
    }),
    getOutput: (type) => ({ type, content: 'mock screen content', lines: 1 }),
    getPrompts: () => [],
    getSessionId: () => undefined,
    write: () => {},
    resize: () => {},
    check: () => Promise.resolve({
      state,
      subagent: params.subagent,
      cwd: params.cwd,
      created_at: new Date().toISOString(),
    }),
    close: () => { state = 'CLOSED' },
    // Allow test to force state transitions
    _setState: (s) => { state = s },
  })

  return adapter
}

// ── Tests ──

describe('App HTTP API', () => {
  let ctx
  let agent

  before(() => {
    mkdirSync(join(TEST_HOME, 'sessions'), { recursive: true })
    mkdirSync(VALID_CWD, { recursive: true })
    ctx = app({
      config: testConfig,
      adapterFactory: () => createMockAdapter(),
    })
    agent = request(ctx.app.callback())
  })

  after(() => {
    ctx.stop()
    rmSync(TEST_HOME, { recursive: true, force: true })
    rmSync(VALID_CWD, { recursive: true, force: true })
  })

  // ── GET /api/subagents ──

  describe('GET /api/subagents', () => {
    it('should list configured subagents', async () => {
      const res = await agent.get('/api/subagents').expect(200)
      assert.equal(res.body.success, true)
      const subagents = res.body.data.subagents
      assert.equal(subagents.length, 2)
      assert.ok(subagents.find(s => s.name === 'test-agent'))
      assert.ok(subagents.find(s => s.name === 'another-agent'))
    })

    it('should include adapter field for each subagent', async () => {
      const res = await agent.get('/api/subagents').expect(200)
      const sa = res.body.data.subagents.find(s => s.name === 'test-agent')
      assert.equal(sa.adapter, 'claude-code')
      assert.equal(sa.description, 'Test agent')
    })
  })

  // ── GET /api/sessions ──

  describe('GET /api/sessions', () => {
    it('should return empty sessions list initially', async () => {
      const res = await agent.get('/api/sessions').expect(200)
      assert.equal(res.body.success, true)
      assert.ok(Array.isArray(res.body.data.sessions))
    })

    it('should filter by cwd', async () => {
      const res = await agent.get('/api/sessions?cwd=/nonexistent').expect(200)
      assert.equal(res.body.data.sessions.length, 0)
    })
  })

  // ── POST /api/open — validation ──

  describe('POST /api/open — validation', () => {
    it('should reject missing subagent field', async () => {
      const res = await agent
        .post('/api/open')
        .send({})
        .set('Content-Type', 'application/json')
        .expect(400)
      assert.equal(res.body.data.error, 'INVALID_STATE')
    })

    it('should reject unknown subagent', async () => {
      const res = await agent
        .post('/api/open')
        .send({ subagent: 'nonexistent' })
        .set('Content-Type', 'application/json')
        .expect(400)
      assert.equal(res.body.data.error, 'SUBAGENT_NOT_FOUND')
    })

    it('should reject non-existent CWD', async () => {
      const res = await agent
        .post('/api/open')
        .send({ subagent: 'test-agent', cwd: '/this/path/does/not/exist/at/all' })
        .set('Content-Type', 'application/json')
        .expect(400)
      assert.equal(res.body.data.error, 'INVALID_STATE')
      assert.ok(res.body.data.message.includes('does not exist'))
    })
  })

  // ── Session lifecycle ──

  describe('Session lifecycle', () => {
    let sessionId

    it('should open a new session with valid CWD', async () => {
      const res = await agent
        .post('/api/open')
        .send({ subagent: 'test-agent', cwd: VALID_CWD })
        .set('Content-Type', 'application/json')
        .expect(200)
      assert.equal(res.body.success, true)
      sessionId = res.body.data.session
      assert.ok(sessionId)
    })

    it('should reconnect to in-memory session', async () => {
      const res = await agent
        .post('/api/open')
        .send({ session: sessionId })
        .set('Content-Type', 'application/json')
        .expect(200)
      assert.equal(res.body.data.session, sessionId)
    })

    it('should list the active session', async () => {
      const res = await agent.get('/api/sessions').expect(200)
      assert.ok(res.body.data.sessions.find(s => s.session === sessionId))
    })

    it('should filter sessions by cwd', async () => {
      const res = await agent.get(`/api/sessions?cwd=${VALID_CWD}`).expect(200)
      assert.ok(res.body.data.sessions.length > 0)
    })

    it('should not find session with wrong cwd', async () => {
      const res = await agent.get('/api/sessions?cwd=/wrong/path').expect(200)
      assert.ok(!res.body.data.sessions.find(s => s.session === sessionId))
    })

    it('should return session status', async () => {
      const res = await agent.get(`/api/session/${sessionId}/status`).expect(200)
      assert.equal(res.body.data.session, sessionId)
      assert.ok(res.body.data.state)
      assert.equal(res.body.data.subagent, 'test-agent')
    })

    it('should return screen output', async () => {
      const res = await agent.get(`/api/session/${sessionId}/output/screen`).expect(200)
      assert.equal(res.body.data.type, 'screen')
    })

    it('should return history output', async () => {
      const res = await agent.get(`/api/session/${sessionId}/output/history`).expect(200)
      assert.equal(res.body.success, true)
    })

    it('should send prompt and get done result', async () => {
      const res = await agent
        .post(`/api/session/${sessionId}/prompt`)
        .send({ prompt: 'test task' })
        .set('Content-Type', 'application/json')
        .expect(200)
      assert.equal(res.body.data.status, 'done')
    })

    it('should approve (idempotent: returns done when IDLE)', async () => {
      const res = await agent
        .post(`/api/session/${sessionId}/approve`)
        .send({})
        .set('Content-Type', 'application/json')
        .expect(200)
      assert.equal(res.body.success, true)
      assert.equal(res.body.data.status, 'done')
    })

    it('should reject (idempotent: returns done when IDLE)', async () => {
      const res = await agent
        .post(`/api/session/${sessionId}/reject`)
        .send({ prompt: 'no' })
        .set('Content-Type', 'application/json')
        .expect(200)
      assert.equal(res.body.success, true)
      assert.equal(res.body.data.status, 'done')
    })

    it('should allow (idempotent: returns done when IDLE)', async () => {
      const res = await agent
        .post(`/api/session/${sessionId}/allow`)
        .send({})
        .set('Content-Type', 'application/json')
        .expect(200)
      assert.equal(res.body.success, true)
      assert.equal(res.body.data.status, 'done')
    })

    it('should close session', async () => {
      const res = await agent.post(`/api/session/${sessionId}/close`).expect(200)
      assert.equal(res.body.data.status, 'closed')
    })

    it('should return 404 after session closed', async () => {
      await agent.get(`/api/session/${sessionId}/status`).expect(404)
    })
  })

  // ── Idempotent state guards ──

  describe('Idempotent state behavior', () => {
    let sessionId
    let mockAdapter

    before(async () => {
      // We need to capture the adapter to manipulate state
      let captured
      const ctx2 = app({
        config: testConfig,
        adapterFactory: () => {
          captured = createMockAdapter()
          return captured
        },
      })
      const agent2 = request(ctx2.app.callback())
      const res = await agent2
        .post('/api/open')
        .send({ subagent: 'test-agent', cwd: VALID_CWD })
        .set('Content-Type', 'application/json')
      sessionId = res.body.data.session
      mockAdapter = captured

      // Use the main ctx for remaining tests since we can't easily switch
      // Instead, test via the main agent with known state transitions
      ctx2.stop()
    })

    it('prompt returns approval_needed when ASKING', async () => {
      // Open a fresh session on the main agent
      const res1 = await agent
        .post('/api/open')
        .send({ subagent: 'test-agent', cwd: VALID_CWD })
        .set('Content-Type', 'application/json')
      const sid = res1.body.data.session
      // Get the adapter from sessions map and force ASKING state
      const adp = ctx.sessions.get(sid)
      adp._setState('ASKING')
      const res = await agent
        .post(`/api/session/${sid}/prompt`)
        .send({ prompt: 'new task' })
        .set('Content-Type', 'application/json')
        .expect(200)
      assert.equal(res.body.data.status, 'approval_needed')

      // Clean up
      await agent.post(`/api/session/${sid}/close`)
    })
  })

  // ── DELETE /api/session/:id ──

  describe('DELETE /api/session/:id', () => {
    let sessionId

    before(async () => {
      const res = await agent
        .post('/api/open')
        .send({ subagent: 'test-agent', cwd: VALID_CWD })
        .set('Content-Type', 'application/json')
      sessionId = res.body.data.session
    })

    it('should delete session and remove directory', async () => {
      const res = await agent.delete(`/api/session/${sessionId}`).expect(200)
      assert.equal(res.body.data.status, 'deleted')
    })

    it('should handle delete of non-existent session gracefully', async () => {
      const res = await agent.delete('/api/session/nonexistent-id').expect(200)
      assert.equal(res.body.data.status, 'deleted')
    })
  })

  // ── POST /api/close — close all ──

  describe('POST /api/close — close all', () => {
    before(async () => {
      await agent.post('/api/open').send({ subagent: 'test-agent', cwd: VALID_CWD }).set('Content-Type', 'application/json')
      await agent.post('/api/open').send({ subagent: 'another-agent', cwd: VALID_CWD }).set('Content-Type', 'application/json')
    })

    it('should close all sessions', async () => {
      const res = await agent.post('/api/close').expect(200)
      assert.equal(res.body.data.closed.length, 2)
    })

    it('should have no active sessions after close all', async () => {
      const res = await agent.get('/api/sessions').expect(200)
      // Only disk-only (CLOSED) sessions remain
      const active = res.body.data.sessions.filter(s => s.state !== 'CLOSED')
      assert.equal(active.length, 0)
    })
  })

  // ── 404 for non-existent session ──

  describe('Non-existent session', () => {
    it('should return 404 for status', async () => {
      await agent.get('/api/session/fake-id/status').expect(404)
    })

    it('should return 404 for output', async () => {
      await agent.get('/api/session/fake-id/output/screen').expect(404)
    })

    it('should return 404 for close', async () => {
      await agent.post('/api/session/fake-id/close').expect(404)
    })

    it('should return 404 for prompt', async () => {
      await agent
        .post('/api/session/fake-id/prompt')
        .send({ prompt: 'test' })
        .set('Content-Type', 'application/json')
        .expect(404)
    })

    it('should return 404 for approve', async () => {
      await agent
        .post('/api/session/fake-id/approve')
        .send({})
        .set('Content-Type', 'application/json')
        .expect(404)
    })

    it('should return 404 for reject', async () => {
      await agent
        .post('/api/session/fake-id/reject')
        .send({})
        .set('Content-Type', 'application/json')
        .expect(404)
    })

    it('should return 404 for allow', async () => {
      await agent
        .post('/api/session/fake-id/allow')
        .send({})
        .set('Content-Type', 'application/json')
        .expect(404)
    })

    it('should return 404 for cancel', async () => {
      await agent
        .post('/api/session/fake-id/cancel')
        .send({})
        .set('Content-Type', 'application/json')
        .expect(404)
    })
  })

  // ── Response format consistency ──

  describe('Response format', () => {
    it('all success responses have { success, code, data } structure', async () => {
      const res = await agent.get('/api/subagents').expect(200)
      assert.equal(typeof res.body.success, 'boolean')
      assert.equal(typeof res.body.code, 'number')
      assert.ok(res.body.data)
    })

    it('all error responses have { success, code, data: { error, message } }', async () => {
      const res = await agent.get('/api/session/fake/status').expect(404)
      assert.equal(res.body.success, false)
      assert.equal(res.body.code, 404)
      assert.equal(typeof res.body.data.error, 'string')
      assert.equal(typeof res.body.data.message, 'string')
    })
  })
})
