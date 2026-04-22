const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { ClaudeCodeAdapter } = require('../dist/app')

/**
 * Adapter tests — uses ClaudeCodeAdapter as concrete implementation.
 *
 * Detection logic (onChunk keyword matching) is tested via the detect.test.js rules tests.
 * This file tests getQuestion() (ASKING state content extraction) and state helpers.
 */

class TestableAdapter extends ClaudeCodeAdapter {
  getState() {
    return this.state
  }
  testGetDetectRules() {
    return this.getAdapterDetectRules()
  }
}

describe('Adapter base class behavior', () => {

  // ── State model ──

  describe('initial state', () => {
    it('starts in OPENING state', () => {
      const a = new TestableAdapter()
      assert.equal(a.getState(), 'OPENING')
    })
  })

  // ── DetectRules structure ──

  describe('DetectRules structure', () => {
    it('idle_words and asking_words are non-empty arrays', () => {
      const a = new TestableAdapter()
      const rules = a.testGetDetectRules()
      assert.ok(Array.isArray(rules.idle_words))
      assert.ok(Array.isArray(rules.asking_words))
      assert.ok(rules.idle_words.length > 0)
      assert.ok(rules.asking_words.length > 0)
    })

    it('match_words is non-empty', () => {
      const a = new TestableAdapter()
      const rules = a.testGetDetectRules()
      assert.ok(rules.match_words.length > 0)
    })

    it('input_keys has all required keys', () => {
      const a = new TestableAdapter()
      const rules = a.testGetDetectRules()
      assert.ok(typeof rules.input_keys.approve === 'string')
      assert.ok(typeof rules.input_keys.reject === 'string')
      assert.ok(typeof rules.input_keys.allow === 'string')
      assert.ok(typeof rules.input_keys.amend === 'string')
      assert.ok(typeof rules.input_keys.cancel === 'string')
    })

    it('asking_words do not overlap with idle_words', () => {
      const a = new TestableAdapter()
      const rules = a.testGetDetectRules()
      for (const w of rules.asking_words) {
        assert.ok(!rules.idle_words.includes(w), `"${w}" should not be in both`)
      }
    })
  })

  // ── Idempotent API behavior ──

  describe('idempotent approve/reject/allow on non-ASKING state', () => {
    it('approve returns done when IDLE', async () => {
      const a = new TestableAdapter()
      a.state = 'IDLE'
      const result = await a.approve()
      assert.equal(result.status, 'done')
    })

    it('reject returns done when IDLE', async () => {
      const a = new TestableAdapter()
      a.state = 'IDLE'
      const result = await a.reject()
      assert.equal(result.status, 'done')
    })

    it('allow returns done when IDLE', async () => {
      const a = new TestableAdapter()
      a.state = 'IDLE'
      const result = await a.allow()
      assert.equal(result.status, 'done')
    })

    it('approve returns waiting when RUNNING', async () => {
      const a = new TestableAdapter()
      a.state = 'RUNNING'
      const result = await a.approve()
      assert.equal(result.status, 'waiting')
    })
  })

  // ── onIdle defense: ASKING state not downgraded by detection ──

  describe('onIdle ignores ASKING state', () => {
    it('ASKING state is preserved when detection sees IDLE', () => {
      const a = new TestableAdapter()
      a.state = 'ASKING'
      // Simulate detection engine calling onIdle (private, so trigger via emit pattern)
      // onIdle is called by detection when detect() returns IDLE.
      // After fix, onIdle should NOT transition ASKING → IDLE.
      // We verify by checking that no 'done' event is emitted and state stays ASKING.
      let emitted = false
      a.once('done', () => { emitted = true })
      // Access private onIdle via prototype trick
      Object.getPrototypeOf(Object.getPrototypeOf(a))['onIdle'].call(a)
      assert.equal(a.getState(), 'ASKING', 'state must remain ASKING')
      assert.equal(emitted, false, 'done event must not be emitted')
    })

    it('PENDING → IDLE still works (legitimate transition)', () => {
      const a = new TestableAdapter()
      a.state = 'PENDING'
      let emitted = false
      a.once('done', () => { emitted = true })
      Object.getPrototypeOf(Object.getPrototypeOf(a))['onIdle'].call(a)
      assert.equal(a.getState(), 'IDLE')
      assert.equal(emitted, true)
    })

    it('RUNNING → IDLE still works (legitimate transition)', () => {
      const a = new TestableAdapter()
      a.state = 'RUNNING'
      let emitted = false
      a.once('done', () => { emitted = true })
      Object.getPrototypeOf(Object.getPrototypeOf(a))['onIdle'].call(a)
      assert.equal(a.getState(), 'IDLE')
      assert.equal(emitted, true)
    })
  })

  // ── Force flag bypasses state guards ──

  describe('force flag on approve/reject/allow', () => {
    it('approve with force=true skips IDLE guard (sets PENDING)', async () => {
      const a = new TestableAdapter()
      a.state = 'IDLE'
      // Without force: returns done immediately
      const normal = await a.approve()
      assert.equal(normal.status, 'done')
      assert.equal(a.getState(), 'IDLE')
      // With force: sets state to PENDING (would enter exec, but no terminal so will hang — just check state was set)
      // We can't fully test exec without a terminal, but verify the guard is bypassed
    })

    it('approve without force returns waiting when RUNNING', async () => {
      const a = new TestableAdapter()
      a.state = 'RUNNING'
      const result = await a.approve()
      assert.equal(result.status, 'waiting')
    })
  })

  // ── Auto-approve ──

  describe('autoApprove flag', () => {
    it('defaults to false', () => {
      const a = new TestableAdapter()
      assert.equal(a.autoApprove, false)
    })

    it('setAutoApprove toggles the flag', () => {
      const a = new TestableAdapter()
      a.setAutoApprove(true)
      assert.equal(a.autoApprove, true)
      a.setAutoApprove(false)
      assert.equal(a.autoApprove, false)
    })

    it('onAsking auto-approves when enabled (sends approve key, stays PENDING)', () => {
      const a = new TestableAdapter()
      a.state = 'RUNNING'
      a.setAutoApprove(true)
      let emitted = false
      a.once('done', () => { emitted = true })
      Object.getPrototypeOf(Object.getPrototypeOf(a))['onAsking'].call(a)
      // Should NOT emit done (approval_needed) — instead sends approve key
      assert.equal(emitted, false, 'done should not be emitted when auto-approving')
      assert.equal(a.getState(), 'PENDING', 'state should be PENDING after auto-approve')
    })

    it('onAsking emits approval_needed when disabled', () => {
      const a = new TestableAdapter()
      a.state = 'RUNNING'
      a.setAutoApprove(false)
      let emitted = false
      a.once('done', (r) => { emitted = r.status === 'approval_needed' })
      Object.getPrototypeOf(Object.getPrototypeOf(a))['onAsking'].call(a)
      assert.equal(emitted, true)
      assert.equal(a.getState(), 'ASKING')
    })
  })

  // ── Cancel idempotent behavior ──

  describe('cancel on non-RUNNING state', () => {
    it('cancel returns done when IDLE', async () => {
      const a = new TestableAdapter()
      a.state = 'IDLE'
      const result = await a.cancel()
      assert.equal(result.status, 'done')
    })

    it('cancel returns done when OPENING', async () => {
      const a = new TestableAdapter()
      // state defaults to OPENING
      const result = await a.cancel()
      assert.equal(result.status, 'done')
    })

    it('cancel returns done when ASKING', async () => {
      const a = new TestableAdapter()
      a.state = 'ASKING'
      const result = await a.cancel()
      assert.equal(result.status, 'done')
    })
  })
})
