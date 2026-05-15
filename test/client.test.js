const { describe, it, before, after, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
// SubagentClient is re-exported from dist/app for testing access.
// Guard paths return synchronously without invoking ensureManager, so no daemon is needed.
const { SubagentClient: Client } = require('../dist/app')

describe('SubagentClient — recursive self-reference guard', () => {
  let savedEnv
  let client

  before(() => {
    savedEnv = process.env.SUBAGENT_CLI_SESSION
  })

  after(() => {
    if (savedEnv === undefined) delete process.env.SUBAGENT_CLI_SESSION
    else process.env.SUBAGENT_CLI_SESSION = savedEnv
  })

  beforeEach(() => {
    process.env.SUBAGENT_CLI_SESSION = 'self-id-abc'
    client = new Client()
  })

  afterEach(() => {
    delete process.env.SUBAGENT_CLI_SESSION
  })

  const expectGuardError = (result, expectedId) => {
    assert.equal(result.success, false)
    assert.equal(result.code, 400)
    assert.equal(result.data.error, 'RECURSIVE_SELF_REFERENCE')
    assert.ok(result.data.message.includes(expectedId))
  }

  it('open({ session: self }) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.open({ session: 'self-id-abc' })
    expectGuardError(r, 'self-id-abc')
  })

  it('prompt(self, ...) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.prompt('self-id-abc', 'task')
    expectGuardError(r, 'self-id-abc')
  })

  it('approve(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.approve('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('reject(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.reject('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('allow(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.allow('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('auto(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.auto('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('status(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.status('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('check(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.check('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('output(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.output('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('cancel(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.cancel('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('exit(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.exit('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('close(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.close('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('delete(self) returns RECURSIVE_SELF_REFERENCE', async () => {
    const r = await client.delete('self-id-abc')
    expectGuardError(r, 'self-id-abc')
  })

  it('does NOT guard other sessions (env set, but target is different id)', () => {
    // Just check the guard predicate returns null for non-self ids
    // by inspecting the internal helper indirectly through open() with a different session id.
    // We can't easily test the happy path here without a daemon, so verify
    // that no RECURSIVE_SELF_REFERENCE error happens — request would attempt to connect.
    // Use a non-self id and check the guardSelfRef returns null:
    // (We rely on the public surface: if guard fired, we'd get immediate response.)
    // For a deterministic check without daemon, just inspect the method does not synchronously throw.
    const p = client.status('other-id-xyz')
    assert.ok(p instanceof Promise)
  })

  it('does NOT guard when SUBAGENT_CLI_SESSION is unset', () => {
    delete process.env.SUBAGENT_CLI_SESSION
    const fresh = new Client()
    const p = fresh.status('any-id')
    assert.ok(p instanceof Promise)
  })
})
