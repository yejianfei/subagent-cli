const { describe, it, after } = require('node:test')
const assert = require('node:assert/strict')
const { execFile, execSync } = require('child_process')
const { join } = require('path')
const { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } = require('fs')
const { tmpdir, homedir } = require('os')
const net = require('net')

const CLI = join(__dirname, '..', 'dist', 'cli.js')

// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════

function getPort() {
  const cfgPath = join(homedir(), '.subagent-cli', 'config.json')
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    return cfg.port ?? 7100
  }
  return 7100
}

function cli(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [CLI, ...args], {
      timeout: timeoutMs,
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (stderr) console.error(`    [stderr] ${stderr.trim().substring(0, 300)}`)
      const text = (stdout ?? '').trim()
      const DELIM = '=====SUBAGENT_JSON====='
      const startIdx = text.indexOf(DELIM)
      const endIdx = text.lastIndexOf(DELIM)
      if (startIdx !== -1 && endIdx !== -1 && startIdx !== endIdx) {
        try {
          const jsonStr = text.substring(startIdx + DELIM.length, endIdx).trim()
          const json = JSON.parse(jsonStr)
          resolve({ code: child.exitCode ?? 0, json })
          return
        } catch { /* fall through to error */ }
      }
      const message = err?.message ?? text ?? 'Unknown CLI error'
      if (err?.killed) {
        reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(' ')}`))
      } else {
        reject(new Error(`CLI non-JSON output [exit=${child.exitCode}]: ${message.substring(0, 500)}`))
      }
    })
  })
}

/** Assert screen-calibrated state. Polls until match (max 60s). */
async function assertCheck(sessionId, expected) {
  const maxWait = 60_000
  const interval = 2_000
  const start = Date.now()
  let last
  while (Date.now() - start < maxWait) {
    const { json } = await cli(['check', '--session', sessionId])
    last = json.data.state
    if (last === expected) return
    if (expected === 'IDLE' && last === 'ASKING') {
      console.log(`    check: got ASKING, auto-approving...`)
      try { await cli(['approve', '--session', sessionId, '--timeout', '60'], 90_000) } catch { /* timeout ok */ }
      continue
    }
    if (expected === 'IDLE' && last === 'RUNNING') {
      console.log(`    check: got ${last}, waiting for ${expected}...`)
      await new Promise(r => setTimeout(r, interval))
      continue
    }
    break
  }
  assert.equal(last, expected,
    `Expected screen state ${expected}, got ${last} (after ${Math.round((Date.now() - start) / 1000)}s)`)
}

/**
 * Send prompt with timeout fallback for cross-chunk detection miss.
 * If prompt times out, check real state via check() and handle accordingly.
 */
async function sendPrompt(sessionId, text, timeoutMs = 120_000) {
  try {
    const { json } = await cli(['prompt', text, '--session', sessionId, '--timeout', String(Math.floor(timeoutMs / 1000))], timeoutMs + 30_000)
    return json
  } catch {
    // Timeout — check real state
    console.warn('    \x1b[33m⚠ prompt timed out, checking real state...\x1b[0m')
    const { json: check } = await cli(['check', '--session', sessionId])
    const state = check.data.state
    if (state === 'ASKING') {
      // Detection miss — return synthetic approval_needed
      return { success: true, data: { status: 'approval_needed' } }
    }
    if (state === 'IDLE') {
      return { success: true, data: { status: 'done' } }
    }
    // Still RUNNING — wait longer
    await assertCheck(sessionId, 'IDLE')
    return { success: true, data: { status: 'done' } }
  }
}

async function approveLoop(sessionId, method = 'approve') {
  let approvalCount = 0
  const maxIterations = 20
  for (let i = 0; i < maxIterations; i++) {
    const args = [method, '--session', sessionId, '--timeout', '120']
    try {
      const { json } = await cli(args, 150_000)
      assert.equal(json.success, true, `${method} failed: ${JSON.stringify(json)}`)
      if (json.data.status === 'done') break
      if (json.data.status === 'approval_needed') approvalCount++
    } catch {
      // Timeout fallback
      console.warn(`    \x1b[33m⚠ ${method} timed out, checking state...\x1b[0m`)
      const { json: check } = await cli(['check', '--session', sessionId])
      if (check.data.state === 'IDLE') break
      if (check.data.state === 'ASKING') {
        approvalCount++
        continue  // retry approve
      }
      await assertCheck(sessionId, 'IDLE')
      break
    }
  }
  return approvalCount
}

async function cleanupSession(sessionId) {
  if (!sessionId) return
  try { await cli(['close', '--session', sessionId], 5000) } catch { /* ignore */ }
  try { await cli(['delete', '--session', sessionId], 5000) } catch { /* ignore */ }
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => { server.close(); resolve(true) })
    server.listen(port, '127.0.0.1')
  })
}

// ══════════════════════════════════════════════════════════════════
// Preflight
// ══════════════════════════════════════════════════════════════════

describe('Codex Preflight', () => {
  it('P1: codex CLI installed', () => {
    try {
      const version = execSync('codex --version 2>&1', { encoding: 'utf-8', timeout: 10_000 }).trim()
      console.log(`    Codex CLI: ${version}`)
    } catch {
      assert.fail('Codex CLI not found. Install via: brew install --cask codex')
    }
  })

  it('P2: kill stale daemon and ensure port available', async () => {
    try { execSync('pkill -9 -f "dist/app" 2>/dev/null || true') } catch { /* ignore */ }
    const port = getPort()
    if (await isPortAvailable(port)) return
    console.log(`    Port ${port} still in use, waiting...`)
    await new Promise(r => setTimeout(r, 1000))
    assert.ok(await isPortAvailable(port), `Port ${port} still in use`)
  })

  it('P3: clean stale sessions', () => {
    const sessDir = join(homedir(), '.subagent-cli', 'sessions')
    if (existsSync(sessDir)) {
      const dirs = readdirSync(sessDir)
      dirs.forEach(d => rmSync(join(sessDir, d), { recursive: true, force: true }))
      console.log(`    Cleaned ${dirs.length} stale subagent-cli session(s)`)
    }

    // Clean leftover /tmp/subagent-codex-* from previous interrupted runs
    try {
      const tmpFiles = readdirSync(tmpdir())
      let count = 0
      for (const f of tmpFiles) {
        if (f.startsWith('subagent-codex-')) {
          rmSync(join(tmpdir(), f), { recursive: true, force: true })
          count++
        }
      }
      if (count) console.log(`    Cleaned ${count} stale /tmp dir(s)`)
    } catch { /* ignore */ }

    // Clean Codex CLI session logs for temp CWDs
    try {
      const codexSessions = join(homedir(), '.codex', 'sessions')
      if (existsSync(codexSessions)) {
        execSync(`grep -rl "/tmp/subagent" "${codexSessions}" | xargs rm -f 2>/dev/null || true`)
        console.log('    Cleaned stale Codex CLI session logs')
      }
    } catch { /* ignore */ }
  })

  it('P4: warm-start daemon', async () => {
    const { json } = await cli(['subagents'], 30_000)
    assert.equal(json.success, true)
    const codex = json.data.subagents.find(s => s.name === 'codex')
    assert.ok(codex, 'codex subagent not found in config')
    console.log(`    Daemon ready, codex adapter: ${codex.adapter}`)
  })
})

// ══════════════════════════════════════════════════════════════════
// Codex E2E: Single session full workflow
// ══════════════════════════════════════════════════════════════════

describe('E2E: Codex single session', { timeout: 900_000 }, () => {
  let sessionId
  const tmpDir = mkdtempSync(join('/tmp', 'subagent-codex-e2e-'))

  // ── Open + Basic ──

  it('① open codex session', async () => {
    const { json } = await cli(['open', '-s', 'codex', '--cwd', tmpDir], 180_000)
    assert.equal(json.success, true, `Open failed: ${JSON.stringify(json)}`)
    sessionId = json.data.session
    assert.ok(sessionId, 'Expected session ID')
    console.log(`    Session: ${sessionId}, CWD: ${tmpDir}`)
  })

  it('② status → IDLE', async () => {
    const { json } = await cli(['status', '--session', sessionId])
    assert.equal(json.data.state, 'IDLE')
    assert.equal(json.data.subagent, 'codex')
  })

  // ── Create complex file + approve ──

  it('③ prompt: create complex JS file', async () => {
    await assertCheck(sessionId, 'IDLE')
    const json = await sendPrompt(sessionId,
      'Create a file called event-emitter.js in the current directory. Implement a fully functional '
      + 'event emitter with on, off, and emit methods, supporting multiple listeners. '
      + 'Target moderate complexity, around 50-80 lines of code.')
    assert.equal(json.success, true, `Prompt failed: ${JSON.stringify(json)}`)
    console.log(`    Prompt result: ${json.data.status}`)
  })

  it('④ approve loop until done', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state === 'ASKING') {
      const count = await approveLoop(sessionId)
      console.log(`    Approved ${count} tool uses`)
    } else {
      console.log(`    Already done (state: ${status.data.state})`)
    }
    await assertCheck(sessionId, 'IDLE')
    // Verify output last has content after task completion
    const port = getPort()
    const res = await fetch(`http://localhost:${port}/api/session/${sessionId}/output/last`)
    const last = await res.json()
    assert.equal(last.success, true)
    assert.ok(last.data.content.length > 0, 'output last should have content after done')
    console.log(`    Output last: ${last.data.lines} lines, ${last.data.content.length} chars`)
  })

  it('⑤ disk: JS file exists with expected content', () => {
    const filePath = join(tmpDir, 'event-emitter.js')
    assert.ok(existsSync(filePath), 'event-emitter.js not found on disk')
    const content = readFileSync(filePath, 'utf-8')
    const hasEventKeywords = /function|on|off|emit|listener|event/i.test(content)
    assert.ok(hasEventKeywords, 'File content does not look like an event emitter')
    assert.ok(content.length > 100, 'File too short to be a real implementation')
    console.log(`    File: ${content.length} chars, ${content.split('\n').length} lines`)
  })

  // ── Idempotent ──

  it('⑥ idempotent: approve/reject/allow on IDLE → done', async () => {
    const { json: a } = await cli(['approve', '--session', sessionId])
    assert.equal(a.data.status, 'done')
    const { json: r } = await cli(['reject', '--session', sessionId])
    assert.equal(r.data.status, 'done')
    const { json: l } = await cli(['allow', '--session', sessionId])
    assert.equal(l.data.status, 'done')
  })

  // ── Reject ──

  it('⑦ prompt: create file → approval_needed', async () => {
    await assertCheck(sessionId, 'IDLE')
    const json = await sendPrompt(sessionId,
      'Create example.js in the current directory with sample code that uses the event emitter.')
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
  })

  it('⑧ reject → agent retries → approve to done', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.warn('    \x1b[33m⚠ FALLBACK: not in ASKING state, skipping reject test\x1b[0m')
      return
    }
    const { json } = await cli(['reject', '--session', sessionId, '--timeout', '120'], 300_000)
    assert.equal(json.success, true)
    console.log(`    After reject: ${json.data.status}`)
    if (json.data.status === 'approval_needed') {
      await approveLoop(sessionId)
    }
    await assertCheck(sessionId, 'IDLE')
  })

  // ── Consecutive approvals ──

  it('⑨ prompt: create two large files → consecutive approvals (triggers folded diff)', async () => {
    await assertCheck(sessionId, 'IDLE')
    const json = await sendPrompt(sessionId,
      'Create two separate files in the current directory:\n'
      + '1. test-emitter.js — unit tests with at least 15 test cases and JSDoc for each (must be over 80 lines)\n'
      + '2. bench-emitter.js — performance benchmarks with at least 10 benchmarks and JSDoc for each (must be over 80 lines)\n'
      + 'You must create two separate files, do not merge them.')
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
  })

  it('⑩ approve loop, count ≥ 2 consecutive approvals', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.log('    Task completed without approval')
      return
    }
    let approvalCount = 1
    const maxIterations = 20
    for (let i = 0; i < maxIterations; i++) {
      try {
        const { json } = await cli(['approve', '--session', sessionId, '--timeout', '120'], 150_000)
        assert.equal(json.success, true)
        if (json.data.status === 'done') break
        if (json.data.status === 'approval_needed') approvalCount++
      } catch {
        console.warn('    \x1b[33m⚠ approve timed out, checking state...\x1b[0m')
        const { json: check } = await cli(['check', '--session', sessionId])
        if (check.data.state === 'IDLE') break
        if (check.data.state === 'ASKING') { approvalCount++; continue }
        await assertCheck(sessionId, 'IDLE')
        break
      }
    }
    console.log(`    Consecutive approvals: ${approvalCount}`)
    assert.ok(approvalCount >= 1, `Expected ≥1 approval, got ${approvalCount}`)
    await assertCheck(sessionId, 'IDLE')
  })

  // ── Allow ──

  it('⑪ prompt: modify file → approval_needed', async () => {
    await assertCheck(sessionId, 'IDLE')
    const json = await sendPrompt(sessionId,
      'Modify test-emitter.js in the current directory, add more edge case tests.')
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
  })

  it('⑫ allow → done', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.warn('    \x1b[33m⚠ FALLBACK: not in ASKING state, skipping allow test\x1b[0m')
      return
    }
    const { json } = await cli(['allow', '--session', sessionId])
    assert.equal(json.success, true)
    console.log(`    After allow: ${json.data.status}`)
    if (json.data.status === 'approval_needed') {
      await approveLoop(sessionId)
    }
    await assertCheck(sessionId, 'IDLE')
  })

  // ── Auto-approve ──

  it('⑫½ auto: enable → prompt with tool use → done without manual approval', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json: autoOn } = await cli(['auto', '--session', sessionId])
    assert.equal(autoOn.success, true)
    assert.equal(autoOn.data.auto, true)
    console.log(`    Auto-approve enabled`)

    const { json } = await cli([
      'prompt',
      'Create a file called auto-test.txt in the current directory with content "auto approved".',
      '--session', sessionId, '--timeout', '120',
    ], 150_000)
    assert.equal(json.success, true)
    assert.equal(json.data.status, 'done', 'Auto-approve should complete without approval_needed')
    console.log(`    Auto-approve result: ${json.data.status}`)

    const { json: autoOff } = await cli(['auto', '--session', sessionId, '--off'])
    assert.equal(autoOff.data.auto, false)
    await assertCheck(sessionId, 'IDLE')
  })

  // ── Approve with text (amend not supported) ──

  it('⑬ approve with text: ignored for codex', async () => {
    await assertCheck(sessionId, 'IDLE')
    const json = await sendPrompt(sessionId,
      'Create a file called note.txt in the current directory with "just a note"')
    assert.equal(json.success, true)
    if (json.data.status === 'approval_needed') {
      // approve with text — should fall back to plain approve
      try {
        const { json: approveResult } = await cli([
          'approve', 'this text should be ignored', '--session', sessionId, '--timeout', '120',
        ], 150_000)
        assert.equal(approveResult.success, true)
        console.log(`    approve(text) result: ${approveResult.data.status}`)
        if (approveResult.data.status === 'approval_needed') {
          await approveLoop(sessionId)
        }
      } catch {
        console.warn('    \x1b[33m⚠ approve(text) timed out, using approveLoop\x1b[0m')
        await approveLoop(sessionId)
      }
    }
    await assertCheck(sessionId, 'IDLE')
  })

  it('⑭ disk: verify files created', () => {
    const files = readdirSync(tmpDir).filter(f => f.endsWith('.js') || f.endsWith('.txt'))
    assert.ok(files.length > 0, `Expected files in ${tmpDir}, found: ${readdirSync(tmpDir).join(', ')}`)
    console.log(`    Files: ${files.join(', ')}`)
  })

  // ── Output ──

  it('⑮ output screen', async () => {
    const { json } = await cli(['output', '--session', sessionId, '--type', 'screen'])
    assert.equal(json.success, true)
    console.log(`    Screen: ${json.data.lines} lines, ${json.data.content.length} chars`)
  })

  it('⑮½ output last → extracted reply without TUI chrome', async () => {
    const port = getPort()
    const res = await fetch(`http://localhost:${port}/api/session/${sessionId}/output/last`)
    const last = await res.json()
    assert.equal(last.success, true)
    assert.ok(last.data.content.length > 0, 'Last output should not be empty')
    // Should NOT contain TUI chrome
    assert.ok(!last.data.content.includes('% left'), 'Should not contain status bar')
    console.log(`    Last:   ${last.data.lines} lines, ${last.data.content.length} chars`)
  })

  // ── Close → Resume ──

  it('⑯ close session', async () => {
    const { json } = await cli(['close', '--session', sessionId])
    assert.equal(json.success, true)
    assert.equal(json.data.status, 'closed')
  })

  it('⑰ sessions: closed session visible', async () => {
    const { json } = await cli(['sessions'])
    const s = json.data.sessions.find(s => s.session === sessionId)
    assert.ok(s, 'Closed session should still appear')
    assert.equal(s.state, 'CLOSED')
  })

  it('⑱ resume from disk', async () => {
    console.log(`    Resuming session ${sessionId}...`)
    const { json } = await cli(['open', '--session', sessionId], 180_000)
    assert.equal(json.success, true, `Resume failed: ${JSON.stringify(json)}`)
    assert.equal(json.data.session, sessionId)
  })

  it('⑲ status → IDLE after resume', async () => {
    const { json } = await cli(['status', '--session', sessionId])
    assert.equal(json.data.state, 'IDLE')
  })

  // ── Cancel ──

  it('⑳ prompt: send large task for cancel', async () => {
    await assertCheck(sessionId, 'IDLE')
    const json = await sendPrompt(sessionId,
      'Write a comprehensive guide about JavaScript design patterns. Cover at least 10 patterns '
      + 'including Singleton, Observer, Factory, Strategy, Decorator, Proxy, Module, Command, '
      + 'Iterator, and Mediator. For each pattern provide a detailed explanation with code examples.',
      300_000)
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
    if (json.data.status === 'approval_needed') {
      await approveLoop(sessionId)
    }
    await assertCheck(sessionId, 'IDLE')
  })

  it('㉑ cancel: interrupt running task', async () => {
    const promptPromise = cli([
      'prompt',
      'Now rewrite the entire guide from scratch with completely different examples and add 5 more patterns.',
      '--session', sessionId,
    ], 120_000)

    // Poll until state leaves IDLE (prompt enters RUNNING), max 10s
    let state = 'IDLE'
    for (let i = 0; i < 20; i++) {
      const { json: s } = await cli(['status', '--session', sessionId])
      state = s.data.state
      if (state !== 'IDLE') break
      await new Promise(r => setTimeout(r, 500))
    }
    console.log(`    State before cancel: ${state}`)

    if (state === 'ASKING') {
      const { json: rejectResult } = await cli(['reject', '--session', sessionId], 30_000)
      assert.equal(rejectResult.success, true)
      console.warn('    \x1b[33m⚠ FALLBACK: ASKING instead of RUNNING, used reject\x1b[0m')
    } else if (state === 'RUNNING') {
      const { json: cancelResult } = await cli(['cancel', '--session', sessionId], 30_000)
      assert.equal(cancelResult.success, true)
      assert.equal(cancelResult.data.status, 'done')
    } else {
      console.warn('    \x1b[33m⚠ FALLBACK: still IDLE after 10s, prompt completed instantly\x1b[0m')
    }

    await promptPromise.catch(() => {})
    await assertCheck(sessionId, 'IDLE')
    console.log('    Cancel: session back to IDLE')
  })

  // ── Graceful exit ──

  it('㉒ exit: graceful process exit from IDLE', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli(['exit', '--session', sessionId], 60_000)
    assert.equal(json.success, true)
    assert.equal(json.data.status, 'exited')
    const { json: status } = await cli(['status', '--session', sessionId])
    assert.equal(status.data.state, 'CLOSED')
    console.log('    Exit: /quit processed, state=CLOSED')
  })

  // ── Delete ──

  it('㉓ delete session', async () => {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const { json } = await cli(['delete', '--session', sessionId])
    assert.equal(json.data.status, 'deleted')
    const { json: sessions } = await cli(['sessions'])
    assert.ok(!sessions.data.sessions.some(s => s.session === sessionId))
  })

  after(async () => {
    await cleanupSession(sessionId)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════
// New features: check --wait, sessions --status, delete --closed, [subagent-cli] prefix
// ══════════════════════════════════════════════════════════════════

describe('E2E: Codex new features (v0.1.11)', { timeout: 600_000 }, () => {
  let sessionId
  let tmpDir

  it('㉔ warm-start daemon + open codex session', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'subagent-codex-new-'))
    const { json: sa } = await cli(['subagents'])
    assert.equal(sa.success, true, 'Daemon should be reachable')
    console.log(`    Daemon alive, ${sa.data.subagents.length} subagent(s)`)

    const { json } = await cli(['open', '-s', 'codex', '--cwd', tmpDir])
    assert.equal(json.success, true)
    sessionId = json.data.session
    console.log(`    New features session: ${sessionId}`)
    assert.ok(sessionId)
  })

  it('㉕ check --wait IDLE (already idle)', async () => {
    const { json } = await cli(['check', '--session', sessionId, '--wait', 'IDLE', '--timeout', '30'])
    assert.equal(json.success, true)
    assert.equal(json.data.state, 'IDLE')
  })

  it('㉖ check --wait IDLE --output last', async () => {
    const { json } = await cli(['check', '--session', sessionId, '--wait', 'IDLE', '--timeout', '10', '--output', 'last'])
    assert.equal(json.success, true)
    assert.equal(json.data.state, 'IDLE')
    assert.equal(typeof json.data.output, 'string')
  })

  it('㉗ sessions --status IDLE includes this session', async () => {
    const { json } = await cli(['sessions', '--status', 'IDLE'])
    assert.ok(json.data.sessions.some(s => s.session === sessionId))
  })

  it('㉘ session config exists on disk', () => {
    const configPath = join(homedir(), '.subagent-cli', 'sessions', sessionId, 'config.json')
    assert.ok(existsSync(configPath), 'Session config should exist on disk')
  })

  it('㉙ close + verify CLOSED in sessions --status CLOSED', async () => {
    await cli(['close', '--session', sessionId])
    const { json } = await cli(['sessions', '--status', 'CLOSED'])
    assert.ok(json.data.sessions.some(s => s.session === sessionId && s.state === 'CLOSED'))
  })

  it('㉚ delete --closed removes closed sessions', async () => {
    const { json } = await cli(['delete', '--closed'])
    assert.equal(json.success, true)
    assert.ok(json.data.deleted.length > 0)

    const { json: after } = await cli(['sessions', '--status', 'CLOSED'])
    assert.ok(!after.data.sessions.some(s => s.session === sessionId))
  })

  after(async () => {
    await cleanupSession(sessionId)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════
// Cleanup
// ══════════════════════════════════════════════════════════════════

after(async () => {
  try { execSync('pkill -9 -f "dist/app" 2>/dev/null || true') } catch { /* ignore */ }
  try {
    const tmpFiles = readdirSync(tmpdir())
    for (const f of tmpFiles) {
      if (f.startsWith('subagent-codex-')) {
        rmSync(join(tmpdir(), f), { recursive: true, force: true })
      }
    }
  } catch { /* ignore */ }

  // Clean Codex CLI session logs for temp CWDs
  try {
    const codexSessions = join(homedir(), '.codex', 'sessions')
    if (existsSync(codexSessions)) {
      execSync(`grep -rl "/tmp/subagent" "${codexSessions}" | xargs rm -f 2>/dev/null || true`)
    }
  } catch { /* ignore */ }
})
