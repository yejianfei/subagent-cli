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
