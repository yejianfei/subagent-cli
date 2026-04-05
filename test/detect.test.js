const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { ClaudeCodeAdapter, CodexAdapter } = require('../dist/app')

// Access protected getQuestion() and getAdapterDetectRules() via a thin test subclass
class TestableClaudeCode extends ClaudeCodeAdapter {
  testGetDetectRules() {
    return this.getAdapterDetectRules()
  }
}

describe('ClaudeCodeAdapter.getAdapterDetectRules()', () => {

  it('returns correct input keys', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    assert.equal(rules.input_keys.approve, '\r')
    assert.equal(rules.input_keys.allow, '\x1b[B\r')
    assert.equal(rules.input_keys.reject, '\x1b[B\x1b[B\r')
    assert.equal(rules.input_keys.amend, '\t')
    assert.equal(rules.input_keys.cancel, '\x1b')
    assert.equal(rules.input_keys.explain, '\x05')
  })

  it('match_words contain expected keywords', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    assert.ok(rules.match_words.includes('❯'))
    assert.ok(rules.match_words.includes('Esc'))
    assert.ok(rules.match_words.includes('trust'))
  })

  it('idle_words contain shortcuts indicators', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    assert.ok(rules.idle_words.includes('shortcuts'))
    assert.ok(rules.idle_words.includes('accept edits'))
  })

  it('asking_words contain approval dialog indicators', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    assert.ok(rules.asking_words.includes('Esc to cancel'))
    assert.ok(rules.asking_words.includes('I trust'))
  })

  it('running_words contain interrupt indicator', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    assert.ok(rules.running_words.includes('esc to interrupt'))
  })

})

// Access protected methods of CodexAdapter via a thin test subclass
class TestableCodex extends CodexAdapter {
  testGetDetectRules() {
    return this.getAdapterDetectRules()
  }

  detectState(text) {
    const rules = this.getAdapterDetectRules()
    if (!rules.match_words.some(w => text.includes(w))) return null
    if (rules.asking_words.some(w => text.includes(w))) return 'ASKING'
    if (rules.running_words.some(w => text.includes(w))) return 'RUNNING'
    if (rules.idle_words.some(w => text.includes(w))) return 'IDLE'
    return null
  }
}

describe('CodexAdapter.getAdapterDetectRules()', () => {

  it('returns correct input keys', () => {
    const a = new TestableCodex()
    const rules = a.testGetDetectRules()
    assert.equal(rules.input_keys.approve, '\r')
    assert.equal(rules.input_keys.allow, '\x1b[B\r')
    assert.equal(rules.input_keys.reject, '\x1b[B\x1b[B\r')
    assert.equal(rules.input_keys.amend, '')
    assert.equal(rules.input_keys.cancel, '\x1b')
    assert.equal(rules.input_keys.explain, '')
    assert.equal(rules.input_keys.exit, 'quit')
  })

  it('match_words contain expected keywords', () => {
    const a = new TestableCodex()
    const rules = a.testGetDetectRules()
    assert.ok(rules.match_words.includes('% left'))
    assert.ok(rules.match_words.includes('esc to'))
  })

  it('idle_words contain % left', () => {
    const a = new TestableCodex()
    const rules = a.testGetDetectRules()
    assert.ok(rules.idle_words.includes('% left'))
  })

  it('asking_words contain esc to cancel', () => {
    const a = new TestableCodex()
    const rules = a.testGetDetectRules()
    assert.ok(rules.asking_words.includes('esc to cancel'))
  })

  it('running_words contain esc to interrupt', () => {
    const a = new TestableCodex()
    const rules = a.testGetDetectRules()
    assert.ok(rules.running_words.includes('esc to interrupt'))
  })

})

describe('CodexAdapter detect() state detection', () => {

  it('detects IDLE from status bar with % left', () => {
    const a = new TestableCodex()
    const text = 'gpt-5.4 default · 100% left · /path'
    assert.equal(a.detectState(text), 'IDLE')
  })

  it('detects RUNNING from working status bar', () => {
    const a = new TestableCodex()
    const text = 'Working (3s · esc to interrupt) gpt-5.4 default · 100% left'
    assert.equal(a.detectState(text), 'RUNNING')
  })

  it('detects ASKING from approval dialog', () => {
    const a = new TestableCodex()
    const text = '› 1. Yes, proceed\n2. No, tell differently\nPress enter to confirm or esc to cancel'
    assert.equal(a.detectState(text), 'ASKING')
  })

  it('returns null for cursor blink chunk with only ›', () => {
    const a = new TestableCodex()
    const text = '› Improve documentation in @filename'
    // No % left, no esc to → match_words not hit → null
    assert.equal(a.detectState(text), null)
  })

  it('running takes priority over idle', () => {
    const a = new TestableCodex()
    const text = 'esc to interrupt 100% left'
    assert.equal(a.detectState(text), 'RUNNING')
  })

  it('asking takes priority over running', () => {
    const a = new TestableCodex()
    const text = 'esc to cancel esc to interrupt'
    assert.equal(a.detectState(text), 'ASKING')
  })

})

describe('Detection engine: keyword rules validation', () => {

  it('idle_words and asking_words have no overlap', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    for (const word of rules.idle_words) {
      assert.ok(!rules.asking_words.includes(word), `"${word}" overlaps between idle and asking`)
    }
  })

  it('running_words and asking_words have no overlap', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    for (const word of rules.running_words) {
      assert.ok(!rules.asking_words.includes(word), `"${word}" overlaps between running and asking`)
    }
  })

  it('running_words and idle_words have no overlap', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    for (const word of rules.running_words) {
      assert.ok(!rules.idle_words.includes(word), `"${word}" overlaps between running and idle`)
    }
  })

  it('match_words are short enough to not span 3+ chunks', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    for (const w of rules.match_words) {
      assert.ok(w.length < 20, `match_word "${w}" too long (${w.length} chars)`)
    }
  })

  it('state words are short enough to not span 3+ chunks', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    for (const w of [...rules.idle_words, ...rules.running_words, ...rules.asking_words]) {
      assert.ok(w.length < 50, `state word "${w}" too long (${w.length} chars)`)
    }
  })

})
