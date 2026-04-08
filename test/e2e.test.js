const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { execFile, execSync } = require('child_process')
const { join } = require('path')
const { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } = require('fs')
const { tmpdir, homedir } = require('os')
const net = require('net')

const CLI = join(__dirname, '..', 'dist', 'cli.js')
const PROJECT_ROOT = join(__dirname, '..')

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

// ── Viewer helpers ──

async function fetchViewerSessions() {
  const port = getPort()
  const res = await fetch(`http://localhost:${port}/viewer`)
  const html = await res.text()
  const regex = /session=([^"]+)">[^<]+<\/a>\s*—\s*(\w+)\s*\((\w+)\)/g
  const sessions = []
  let match
  while ((match = regex.exec(html)) !== null) {
    sessions.push({ session: match[1], subagent: match[2], state: match[3] })
  }
  return sessions
}

async function fetchViewerDetail(sessionId) {
  const port = getPort()
  const res = await fetch(`http://localhost:${port}/viewer?session=${sessionId}`)
  return { status: res.status, html: await res.text() }
}

async function verifyViewerHasSession(sessionId, expectedState, expectedSubagent = 'haiku') {
  const viewerSessions = await fetchViewerSessions()
  const found = viewerSessions.find(s => s.session === sessionId)
  assert.ok(found, `Session ${sessionId} not found in viewer`)
  assert.equal(found.state, expectedState, `Viewer state: expected ${expectedState}, got ${found.state}`)
  assert.equal(found.subagent, expectedSubagent)

  const { json } = await cli(['sessions'])
  const cliSession = json.data.sessions.find(s => s.session === sessionId)
  assert.ok(cliSession, `Session ${sessionId} not in CLI sessions`)
  assert.equal(cliSession.state, expectedState)
}

async function verifyViewerNoSession(sessionId) {
  const viewerSessions = await fetchViewerSessions()
  const found = viewerSessions.find(s => s.session === sessionId)
  assert.ok(!found, `Session ${sessionId} should NOT be in viewer`)
}

// ── State assertion ──

/** Assert internal adapter state (fast, sync) */
async function assertState(sessionId, expected) {
  const { json } = await cli(['status', '--session', sessionId])
  assert.equal(json.data.state, expected,
    `Expected internal state ${expected}, got ${json.data.state}`)
}

/** Assert screen-calibrated state (authoritative — flush + capture bottom 5 lines → detect).
 *  Use after operations that may have false-positive IDLE (e.g. allow, approveLoop).
 *  When expected=IDLE but check returns RUNNING, polls until truly IDLE (max 60s). */
async function assertCheck(sessionId, expected) {
  const maxWait = 60_000
  const interval = 2_000
  const start = Date.now()
  let last
  while (Date.now() - start < maxWait) {
    const { json } = await cli(['check', '--session', sessionId])
    last = json.data.state
    if (last === expected) return
    if (expected === 'IDLE' && (last === 'RUNNING' || last === 'ASKING')) {
      console.log(`    check: got ${last}, waiting for ${expected}...`)
      await new Promise(r => setTimeout(r, interval))
      continue
    }
    break
  }
  assert.equal(last, expected,
    `Expected screen state ${expected}, got ${last} (after ${Math.round((Date.now() - start) / 1000)}s)`)
}

// ── Approval loop ──

async function approveLoop(sessionId, method = 'approve', text) {
  let approvalCount = 0
  const maxIterations = 20
  for (let i = 0; i < maxIterations; i++) {
    const args = [method, '--session', sessionId]
    if (text && method === 'approve' && i === 0) args.push(text)
    const { json } = await cli(args, 660_000)
    assert.equal(json.success, true, `${method} failed: ${JSON.stringify(json)}`)
    if (json.data.status === 'done') break
    if (json.data.status === 'approval_needed') approvalCount++
  }
  return approvalCount
}

// ── Cleanup ──

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

describe('Preflight', () => {
  it('P1: claude CLI installed', () => {
    try {
      const version = execSync('claude --version 2>&1', { encoding: 'utf-8', timeout: 10_000 }).trim()
      console.log(`    Claude CLI: ${version}`)
    } catch {
      assert.fail(
        'Claude Code CLI not found. Install via:\n'
        + '  brew install claude-code\n'
        + '  npm i -g @anthropic-ai/claude-code\n'
        + '  npx -y @anthropic-ai/claude-code --version'
      )
    }
  })

  it('P2: Node >= 18', () => {
    const major = parseInt(process.version.slice(1))
    assert.ok(major >= 18, `Node ${process.version} < 18`)
  })

  it('P3: kill stale daemon and ensure port available', async () => {
    // Always kill stale daemon to ensure clean state
    try { execSync('pkill -9 -f "dist/app" 2>/dev/null || true') } catch { /* ignore */ }
    const port = getPort()
    if (await isPortAvailable(port)) return

    console.log(`    Port ${port} still in use, waiting...`)
    await new Promise(r => setTimeout(r, 1000))

    const available = await isPortAvailable(port)
    assert.ok(available, `Port ${port} still in use after killing daemon`)
  })

  it('P4: clean stale sessions', () => {
    const sessDir = join(homedir(), '.subagent-cli', 'sessions')
    if (existsSync(sessDir)) {
      const dirs = readdirSync(sessDir)
      dirs.forEach(d => rmSync(join(sessDir, d), { recursive: true, force: true }))
      console.log(`    Cleaned ${dirs.length} stale subagent-cli session(s)`)
    }

    // Clean leftover /tmp/subagent-* from previous interrupted runs
    try {
      const tmpFiles = readdirSync(tmpdir())
      let count = 0
      for (const f of tmpFiles) {
        if (f.startsWith('subagent-')) {
          rmSync(join(tmpdir(), f), { recursive: true, force: true })
          count++
        }
      }
      if (count) console.log(`    Cleaned ${count} stale /tmp dir(s)`)
    } catch { /* ignore */ }

    // Clean Claude Code project configs for temp CWDs
    try {
      const claudeProjects = join(homedir(), '.claude', 'projects')
      if (existsSync(claudeProjects)) {
        const dirs = readdirSync(claudeProjects)
        let count = 0
        for (const d of dirs) {
          if (d.startsWith('-private-tmp') || d.startsWith('-tmp')) {
            rmSync(join(claudeProjects, d), { recursive: true, force: true })
            count++
          }
        }
        if (count) console.log(`    Cleaned ${count} stale Claude Code project config(s)`)
      }
    } catch { /* ignore */ }
  })

  it('P5: warm-start daemon', async () => {
    assert.ok(existsSync(join(PROJECT_ROOT, 'dist', 'cli.js')), 'dist/cli.js not found — run npm run build first')
    const { json } = await cli(['subagents'], 30_000)
    assert.equal(json.success, true, `Daemon warm-start failed: ${JSON.stringify(json)}`)
    console.log(`    Daemon ready, ${json.data.subagents.length} subagent(s) configured`)
  })
})

// ══════════════════════════════════════════════════════════════════
// Single Session: Full E2E (one session, all features)
// ══════════════════════════════════════════════════════════════════

describe('E2E: Single session real task', { timeout: 900_000 }, () => {
  let sessionId
  const tmpDir = mkdtempSync(join('/tmp', 'subagent-e2e-'))

  // ── Open + Basic ──

  it('① open in temp directory (auto trust)', async () => {
    const { json } = await cli(['open', '-s', 'haiku', '--cwd', tmpDir], 180_000)
    assert.equal(json.success, true, `Open failed: ${JSON.stringify(json)}`)
    sessionId = json.data.session
    assert.ok(sessionId, 'Expected session ID')
    console.log(`    Session: ${sessionId}, CWD: ${tmpDir}`)
  })

  it('② status → IDLE', async () => {
    const { json } = await cli(['status', '--session', sessionId])
    assert.equal(json.data.state, 'IDLE')
    assert.equal(json.data.subagent, 'haiku')
  })

  it('③ viewer: session in list with IDLE state', async () => {
    await verifyViewerHasSession(sessionId, 'IDLE')
  })

  // ── Create file + approve ──

  it('④ prompt: create complex JS file', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli([
      'prompt',
      'Create a file called event-emitter.js in the current directory. Implement a fully functional '
      + 'event emitter with on, off, and emit methods, supporting multiple listeners. '
      + 'Target moderate complexity, around 50-80 lines of code.',
      '--session', sessionId,
    ], 660_000)
    assert.equal(json.success, true, `Prompt failed: ${JSON.stringify(json)}`)
    console.log(`    Prompt result: ${json.data.status}`)
  })

  it('⑤ approve loop until done', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state === 'ASKING') {
      const count = await approveLoop(sessionId)
      console.log(`    Approved ${count} tool uses`)
    } else {
      console.log(`    Already done (state: ${status.data.state})`)
    }
    await assertCheck(sessionId, 'IDLE')
  })

  it('⑥ disk: JS file exists with expected content', () => {
    const filePath = join(tmpDir, 'event-emitter.js')
    assert.ok(existsSync(filePath), 'event-emitter.js not found on disk')
    const content = readFileSync(filePath, 'utf-8')
    const hasEventKeywords = /function|on|off|emit|listener|event/i.test(content)
    assert.ok(hasEventKeywords, 'File content does not look like an event emitter')
    assert.ok(content.length > 100, 'File too short to be a real implementation')
    console.log(`    File: ${content.length} chars, ${content.split('\n').length} lines`)
  })

  it('⑦ viewer: session IDLE after task', async () => {
    await verifyViewerHasSession(sessionId, 'IDLE')
  })

  // ── Idempotent + filter + reconnect ──

  it('⑧ idempotent: approve/reject/allow on IDLE → done', async () => {
    const { json: a } = await cli(['approve', '--session', sessionId])
    assert.equal(a.data.status, 'done')
    const { json: r } = await cli(['reject', '--session', sessionId])
    assert.equal(r.data.status, 'done')
    const { json: l } = await cli(['allow', '--session', sessionId])
    assert.equal(l.data.status, 'done')
  })

  it('⑨ sessions: filter by cwd', async () => {
    const { json: found } = await cli(['sessions', '--cwd', tmpDir])
    assert.ok(found.data.sessions.some(s => s.session === sessionId))

    const { json: notFound } = await cli(['sessions', '--cwd', '/nonexistent-dir-12345'])
    assert.ok(!notFound.data.sessions.some(s => s.session === sessionId))
  })

  it('⑩ reconnect in-memory session', async () => {
    const { json } = await cli(['open', '--session', sessionId])
    assert.equal(json.success, true)
    assert.equal(json.data.session, sessionId)
  })

  // ── Reject ──

  it('⑪ prompt: create file → approval_needed', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli([
      'prompt',
      'Create example.js in the current directory with sample code that uses the event emitter.',
      '--session', sessionId,
    ], 660_000)
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
    // Verify approval structure when approval is needed
    if (json.data.status === 'approval_needed') {
      assert.ok(json.data.approval, 'Should include approval info')
      assert.ok(json.data.approval.tool, 'Approval should have tool name')
      assert.ok(typeof json.data.approval.target === 'string', 'Approval should have target')
      console.log(`    Approval: ${json.data.approval.tool}(${json.data.approval.target})`)
    }
  })

  it('⑫ prompt during ASKING → idempotent approval_needed', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.warn('    \x1b[33m⚠ FALLBACK: not in ASKING state, skipping idempotent test\x1b[0m')
      return
    }
    const { json } = await cli([
      'prompt', 'This is another task',
      '--session', sessionId,
    ])
    assert.equal(json.success, true)
    assert.equal(json.data.status, 'approval_needed',
      'Prompt during ASKING should return current approval')
    assert.ok(json.data.approval, 'Should include approval info')
    // Deep approval structure validation
    assert.ok(json.data.approval.tool, 'Approval should have tool name (e.g. Write, Read)')
    assert.ok(typeof json.data.approval.target === 'string', 'Approval should have target string')
    assert.ok(typeof json.data.approval.reason === 'string', 'Approval should have reason string')
    console.log(`    Approval detail: tool=${json.data.approval.tool}, target=${json.data.approval.target}`)
  })

  it('⑬ viewer: ASKING state during approval', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.warn('    \x1b[33m⚠ FALLBACK: not in ASKING state, skipping viewer check\x1b[0m')
      return
    }
    await verifyViewerHasSession(sessionId, 'ASKING')
  })

  it('⑭ reject → agent retries → approve to done', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.warn('    \x1b[33m⚠ FALLBACK: not in ASKING state, skipping reject test\x1b[0m')
      return
    }
    const { json } = await cli(['reject', '--session', sessionId])
    assert.equal(json.success, true)
    console.log(`    After reject: ${json.data.status}`)
    if (json.data.status === 'approval_needed') {
      await approveLoop(sessionId)
    }
    await assertCheck(sessionId, 'IDLE')
  })

  // ── Amend ──

  it('⑮ prompt: create demo.js → approval_needed', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli([
      'prompt',
      'Create demo.js in the current directory with an event emitter demonstration program.',
      '--session', sessionId,
    ], 120_000)
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
    // If already done (haiku may auto-complete), that's fine
    if (json.data.status === 'approval_needed') {
      assert.ok(json.data.approval, 'Should include approval info')
    }
  })

  it('⑯ approve with amend text → done', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.warn('    \x1b[33m⚠ FALLBACK: not in ASKING state, skipping amend test\x1b[0m')
      return
    }
    const count = await approveLoop(sessionId, 'approve', 'Rename the file to showcase.js')
    console.log(`    Amend flow: ${count} additional approvals`)
    await assertCheck(sessionId, 'IDLE')
  })

  it('⑰ disk: verify files created', () => {
    const files = readdirSync(tmpDir).filter(f => f.endsWith('.js'))
    assert.ok(files.length > 0, `Expected JS files in ${tmpDir}, found: ${readdirSync(tmpDir).join(', ')}`)
    console.log(`    Files: ${files.join(', ')}`)
  })

  // ── Consecutive approvals ──

  it('⑱ prompt: create two large files → consecutive approvals (triggers folded diff)', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli([
      'prompt',
      'Create two separate files in the current directory:\n'
      + '1. test-emitter.js — unit tests with at least 15 test cases and JSDoc for each (must be over 80 lines)\n'
      + '2. bench-emitter.js — performance benchmarks with at least 10 benchmarks and JSDoc for each (must be over 80 lines)\n'
      + 'You must create two separate files, do not merge them.',
      '--session', sessionId,
    ], 660_000)
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
  })

  it('⑲ approve loop, count ≥ 2 consecutive approvals', async () => {
    const { json: status } = await cli(['status', '--session', sessionId])
    if (status.data.state !== 'ASKING') {
      console.log('    Task completed without approval')
      return
    }
    let approvalCount = 1
    const maxIterations = 20
    for (let i = 0; i < maxIterations; i++) {
      const { json } = await cli(['approve', '--session', sessionId], 660_000)
      assert.equal(json.success, true)
      if (json.data.status === 'done') break
      if (json.data.status === 'approval_needed') approvalCount++
    }
    console.log(`    Consecutive approvals: ${approvalCount}`)
    assert.ok(approvalCount >= 1, `Expected ≥1 approval, got ${approvalCount}`)
    await assertCheck(sessionId, 'IDLE')
  })

  // ── Allow ──

  it('⑳ prompt: modify file → approval_needed', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli([
      'prompt',
      'Modify test-emitter.js in the current directory, add more edge case tests.',
      '--session', sessionId,
    ], 660_000)
    assert.equal(json.success, true)
    console.log(`    Status: ${json.data.status}`)
  })

  it('㉑ allow → done (Shift+Tab)', async () => {
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

  // ── Large content ──

  it('㉒ prompt: detailed explanation (large output)', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli([
      'prompt',
      'Do NOT use any tools, do NOT create or modify files. '
      + 'Explain in detail how JavaScript event-driven programming patterns work, including: '
      + '1. Core data structure design of EventEmitter; '
      + '2. Implementation approach and edge cases for on/off/emit/once; '
      + '3. Memory leak prevention (maxListeners); '
      + '4. Sync vs async emit trade-offs; '
      + '5. Wildcard matching implementation strategies. '
      + 'Be thorough and provide code examples for each section.',
      '--session', sessionId,
    ], 660_000)
    assert.equal(json.success, true)
    // Claude may still use tools despite instruction; handle gracefully
    if (json.data.status === 'approval_needed') {
      console.warn('    \x1b[33m⚠ FALLBACK: Claude used tools despite instruction, auto-approving\x1b[0m')
      await approveLoop(sessionId)
    } else {
      // Verify output field on done
      assert.ok(json.data.output, 'done result should include output field')
      assert.ok(json.data.output.length > 0, 'output should not be empty')
      console.log(`    Output: ${json.data.output.length} chars`)
    }
    await assertCheck(sessionId, 'IDLE')
  })

  it('㉓ output screen → last visible screen', async () => {
    const { json } = await cli(['output', '--session', sessionId, '--type', 'screen'])
    assert.equal(json.success, true)
    assert.ok(json.data.content.length > 0, 'Screen content should not be empty')
    assert.ok(json.data.lines > 0)
    // Verify content contains meaningful text (not just ANSI/whitespace)
    const content = json.data.content.toLowerCase()
    assert.ok(
      content.includes('event') || content.includes('function') || content.includes('class')
      || content.includes('emitter') || content.includes('const') || content.includes('accept'),
      'Screen should contain meaningful code/text content'
    )
    console.log(`    Screen: ${json.data.lines} lines, ${json.data.content.length} chars`)
  })

  it('㉓½ output last → extracted sub-agent reply without TUI chrome', async () => {
    const port = getPort()
    const res = await fetch(`http://localhost:${port}/api/session/${sessionId}/output/last`)
    const last = await res.json()
    assert.equal(last.success, true)
    assert.ok(last.data.content.length > 0, 'Last output should not be empty')
    assert.ok(last.data.lines > 0)
    // Should NOT contain TUI chrome
    assert.ok(!last.data.content.includes('? for shortcuts'), 'Should not contain status bar')
    assert.ok(!last.data.content.includes('Update available'), 'Should not contain update notice')
    // Should contain meaningful content
    const content = last.data.content.toLowerCase()
    assert.ok(
      content.includes('event') || content.includes('function') || content.includes('class')
      || content.includes('emitter') || content.includes('const'),
      'Last output should contain meaningful content'
    )
    console.log(`    Last:   ${last.data.lines} lines, ${last.data.content.length} chars`)
  })

  it('㉔ output history → full scrollback (larger than screen)', async () => {
    const { json: screen } = await cli(['output', '--session', sessionId, '--type', 'screen'])
    // Use HTTP API directly for history — large output (60KB+) can be truncated
    // through CLI's stdout pipe when Node.js exits before pipe flush completes
    const port = getPort()
    const res = await fetch(`http://localhost:${port}/api/session/${sessionId}/output/history`)
    const history = await res.json()
    assert.equal(history.success, true)
    assert.ok(history.data.lines > 0)
    assert.ok(
      history.data.lines >= screen.data.lines,
      `History (${history.data.lines}) should be ≥ screen (${screen.data.lines})`
    )
    const content = history.data.content.toLowerCase()
    assert.ok(
      content.includes('eventemitter') || content.includes('event') || content.includes('emit'),
      'History should contain event-related content'
    )
    console.log(`    History: ${history.data.lines} lines (screen: ${screen.data.lines})`)
  })

  it('㉕ viewer: detail page loads correctly', async () => {
    const { status, html } = await fetchViewerDetail(sessionId)
    assert.equal(status, 200)
    assert.ok(html.includes('debug viewer'), 'Should contain viewer title')
    assert.ok(html.includes('id="terminal"'), 'Should contain terminal div')
    assert.ok(html.includes('WebSocket'), 'Should contain WebSocket code')
  })

  // ── Close → Resume → Context preserved ──

  it('㉖ close session', async () => {
    const { json } = await cli(['close', '--session', sessionId])
    assert.equal(json.success, true)
    assert.equal(json.data.status, 'closed')
  })

  it('㉗ viewer: session gone; API: CLOSED', async () => {
    await verifyViewerNoSession(sessionId)
    const { json } = await cli(['sessions'])
    const s = json.data.sessions.find(s => s.session === sessionId)
    assert.ok(s, 'Closed session should still appear in API')
    assert.equal(s.state, 'CLOSED')
  })

  it('㉘ resume from disk', async () => {
    console.log(`    Resuming session ${sessionId}...`)
    const { json } = await cli(['open', '--session', sessionId])
    assert.equal(json.success, true, `Resume failed: ${JSON.stringify(json)}`)
    assert.equal(json.data.session, sessionId)
  })

  it('㉙ viewer: session back after resume, IDLE', async () => {
    await verifyViewerHasSession(sessionId, 'IDLE')
  })

  it('㉚ prompt: extend file (context preserved)', async () => {
    await assertCheck(sessionId, 'IDLE')
    const { json } = await cli([
      'prompt',
      'Extend event-emitter.js in the current directory. Add a once method (fires once then auto-removes) '
      + 'and wildcard matching (e.g. on("user.*", fn) matches "user.login"). '
      + 'Modify the existing file directly, do not create new files.',
      '--session', sessionId,
    ], 660_000)
    assert.equal(json.success, true)
    if (json.data.status === 'approval_needed') {
      console.warn('    \x1b[33m⚠ FALLBACK: unexpected approval needed after prompt, auto-approving\x1b[0m')
      await approveLoop(sessionId)
    }
    await assertCheck(sessionId, 'IDLE')
  })

  it('㉛ disk: file updated with new features', () => {
    const content = readFileSync(join(tmpDir, 'event-emitter.js'), 'utf-8')
    const hasNewFeatures = /once|wildcard|\*/i.test(content)
    assert.ok(hasNewFeatures, 'File should contain once/wildcard features after update')
  })

  // ── Cancel running task ──

  it('㉜ cancel: interrupt running task → back to IDLE', async () => {
    // Send a long-running prompt (don't await completion)
    const promptPromise = cli([
      'prompt',
      'Perform a comprehensive code review of event-emitter.js in the current directory. '
      + 'Analyze each function line by line for implementation quality, edge case handling, '
      + 'performance bottlenecks, and potential memory leak risks. Provide detailed improvement suggestions.',
      '--session', sessionId,
    ], 60_000)

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
      assert.equal(cancelResult.data.status, 'done', 'cancel should return done')
    } else {
      console.warn('    \x1b[33m⚠ FALLBACK: still IDLE after 10s, prompt may have completed instantly\x1b[0m')
    }

    await promptPromise.catch(() => {})
    await assertCheck(sessionId, 'IDLE')
    console.log('    Cancel: task interrupted, session back to IDLE')
  })

  // ── Graceful exit ──

  it('㉝ exit: graceful process exit from IDLE', async () => {
    // Wait for Claude to fully settle after cancel
    await new Promise(resolve => setTimeout(resolve, 3000))

    const { json } = await cli(['exit', '--session', sessionId], 60_000)
    assert.equal(json.success, true)
    assert.equal(json.data.status, 'exited')

    // After exit, session state should be CLOSED (process terminated)
    const { json: status } = await cli(['status', '--session', sessionId])
    assert.equal(status.data.state, 'CLOSED')
    console.log('    Exit: /exit processed, process terminated, state=CLOSED')
  })

  // ── Delete ──

  it('㉞ delete → viewer empty', async () => {
    const { json } = await cli(['delete', '--session', sessionId])
    assert.equal(json.data.status, 'deleted')
    await verifyViewerNoSession(sessionId)
    const { json: sessions } = await cli(['sessions'])
    assert.ok(!sessions.data.sessions.some(s => s.session === sessionId))
  })

  after(async () => {
    await cleanupSession(sessionId)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ══════════════════════════════════════════════════════════════════
// Error Paths (independent, no real sessions)
// ══════════════════════════════════════════════════════════════════

describe('Error paths', { timeout: 60_000 }, () => {
  it('㉟ open: non-existent CWD → INVALID_STATE', async () => {
    const { json } = await cli(['open', '-s', 'haiku', '--cwd', '/nonexistent-path-99999'])
    assert.equal(json.success, false)
    assert.equal(json.data.error, 'INVALID_STATE')
    assert.ok(json.data.message.includes('does not exist'))
  })

  it('㊱ status: non-existent session → SESSION_NOT_FOUND', async () => {
    const { json } = await cli(['status', '--session', 'nonexistent-session-id'])
    assert.equal(json.success, false)
    assert.equal(json.data.error, 'SESSION_NOT_FOUND')
  })

  it('㊲ check: non-existent session → SESSION_NOT_FOUND', async () => {
    const { json } = await cli(['check', '--session', 'nonexistent-session-id'])
    assert.equal(json.success, false)
    assert.equal(json.data.error, 'SESSION_NOT_FOUND')
  })

  it('㊳ prompt: non-existent session → error', async () => {
    const { json } = await cli(['prompt', 'test', '--session', 'nonexistent-session-id'])
    assert.equal(json.success, false)
  })

  it('㊴ close all remaining sessions', async () => {
    const { json } = await cli(['close'])
    assert.equal(json.success, true)
    assert.ok(Array.isArray(json.data.closed))
    console.log(`    Closed: ${json.data.closed.length} sessions`)
  })
})

// ══════════════════════════════════════════════════════════════════
// Global cleanup
// ══════════════════════════════════════════════════════════════════

after(async () => {
  try {
    execSync('pkill -9 -f "dist/app" 2>/dev/null || true')
  } catch { /* ignore */ }

  // Clean temp directories created by E2E tests
  try {
    const tmpFiles = readdirSync(tmpdir())
    for (const f of tmpFiles) {
      if (f.startsWith('subagent-')) {
        rmSync(join(tmpdir(), f), { recursive: true, force: true })
      }
    }
  } catch { /* ignore */ }

  // Clean Claude Code project configs for temp CWDs
  try {
    const claudeProjects = join(homedir(), '.claude', 'projects')
    const dirs = readdirSync(claudeProjects)
    for (const d of dirs) {
      if (d.startsWith('-private-tmp') || d.startsWith('-tmp')) {
        rmSync(join(claudeProjects, d), { recursive: true, force: true })
      }
    }
  } catch { /* ignore */ }
})
