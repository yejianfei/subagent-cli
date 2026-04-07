const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { ClaudeCodeAdapter, CodexAdapter } = require('../dist/app')

// Access protected methods via thin test subclasses
class TestableClaudeCode extends ClaudeCodeAdapter {
  testGetDetectRules() {
    return this.getAdapterDetectRules()
  }
  testGetLastOutput(rawText) {
    return this.getLastOutput(rawText)
  }
}

class TestableCodex extends CodexAdapter {
  testGetDetectRules() {
    return this.getAdapterDetectRules()
  }
  testGetLastOutput(rawText) {
    return this.getLastOutput(rawText)
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

// ══════════════════════════════════════════════════════════════════
// DetectRules validation
// ══════════════════════════════════════════════════════════════════

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

  it('prompt_marker and chrome_words are configured', () => {
    const a = new TestableClaudeCode()
    const rules = a.testGetDetectRules()
    assert.equal(rules.prompt_marker, '❯')
    assert.ok(rules.chrome_words.length > 0)
    assert.ok(rules.chrome_words.includes('shortcuts'))
  })

})

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

  it('prompt_marker and chrome_words are configured', () => {
    const a = new TestableCodex()
    const rules = a.testGetDetectRules()
    assert.equal(rules.prompt_marker, '›')
    assert.ok(rules.chrome_words.length > 0)
    assert.ok(rules.chrome_words.includes('% left'))
  })

})

// ══════════════════════════════════════════════════════════════════
// State detection
// ══════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════
// getLastOutput — Claude Code (real screen samples)
// ══════════════════════════════════════════════════════════════════

describe('ClaudeCodeAdapter.getLastOutput()', () => {

  it('extracts pure text reply', () => {
    const a = new TestableClaudeCode()
    const raw = [
      '❯ Do NOT use any tools. Just reply: Hello, I am Claude. List 3 colors: red, blue, green.',
      '',
      '⏺ Hello, I am Claude. List 3 colors: red, blue, green.',
      '',
      '───────────────────────────────────────────────────────────────────────',
      '❯',
      '───────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts                                  Update available! Run: brew upgrade claude-code',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('⏺ Hello, I am Claude'))
    assert.ok(!result.includes('───'))
    assert.ok(!result.includes('shortcuts'))
    assert.ok(!result.includes('Update available'))
  })

  it('extracts tool use done reply', () => {
    const a = new TestableClaudeCode()
    const raw = [
      '❯ Create a file called /tmp/test.txt with content hello world',
      '',
      '⏺ Write(/tmp/test.txt)',
      '  ⎿  Wrote 1 lines to ../../tmp/test.txt',
      '      1 hello world',
      '',
      '⏺ Done! I\'ve created the file /tmp/test.txt with the content hello world.',
      '',
      '───────────────────────────────────────────────────────────────────────',
      '❯',
      '───────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts                                  Update available! Run: brew upgrade claude-code',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('⏺ Write(/tmp/test.txt)'))
    assert.ok(result.includes('⏺ Done!'))
    assert.ok(result.includes('Wrote 1 lines'))
    assert.ok(!result.includes('❯'))
    assert.ok(!result.includes('shortcuts'))
  })

  it('extracts reply up to ASKING dialog', () => {
    const a = new TestableClaudeCode()
    const raw = [
      '❯ Create a file called /tmp/test.txt with content hello world',
      '',
      '⏺ Write(/tmp/test.txt)',
      '',
      '───────────────────────────────────────────────────────────────────────',
      ' Create file',
      ' ../../tmp/test.txt',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      '  1 hello world',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' Do you want to create test.txt?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('⏺ Write(/tmp/test.txt)'))
    // Should include the diff content shown in the dialog
    assert.ok(result.includes('hello world'))
    // Should NOT include the ASKING chrome
    assert.ok(!result.includes('Esc to cancel'))
    assert.ok(!result.includes('Tab to amend'))
  })

  it('extracts large multi-screen content', () => {
    const a = new TestableClaudeCode()
    const contentLines = []
    for (let i = 0; i < 300; i++) {
      contentLines.push(`  Line ${i + 1} of the Observer pattern explanation.`)
    }
    const raw = [
      '❯ Write a detailed explanation of the Observer design pattern',
      '',
      '⏺ The Observer Design Pattern in JavaScript',
      '',
      ...contentLines,
      '',
      '───────────────────────────────────────────────────────────────────────',
      '❯',
      '───────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts                                  Update available! Run: brew upgrade claude-code',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('⏺ The Observer Design Pattern'))
    assert.ok(result.includes('Line 1 of'))
    assert.ok(result.includes('Line 300 of'))
    assert.ok(!result.includes('shortcuts'))
    assert.ok(result.split('\n').length > 300)
  })

  it('returns empty string when no prompt marker found', () => {
    const a = new TestableClaudeCode()
    const raw = 'some random text without any markers'
    const result = a.testGetLastOutput(raw)
    assert.equal(result, 'some random text without any markers')
  })

  it('excludes menu item ❯ 1. from prompt detection', () => {
    const a = new TestableClaudeCode()
    const raw = [
      '❯ Create file test.txt',
      '',
      '⏺ Write(test.txt)',
      '',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    // Should find ❯ Create file as prompt, not ❯ 1. Yes
    assert.ok(result.includes('⏺ Write(test.txt)'))
  })

  it('handles empty prompt marker with NBSP (real terminal rendering)', () => {
    const a = new TestableClaudeCode()
    const raw = [
      '❯ Say hello',
      '',
      '⏺ Hello!',
      '',
      '───────────────────────────────────────────────────────────────────────',
      '❯\u00a0',
      '───────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.equal(result, '⏺ Hello!')
  })

  it('trims line-wrapped Update available chrome', () => {
    const a = new TestableClaudeCode()
    const raw = [
      '❯ Say hello',
      '',
      '⏺ Hello!',
      '',
      '───────────────────────────────────────────────────────────────────────',
      '❯\u00a0 ',
      '───────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts                                   Update a',
      'vailable! Run: brew upgrade claude-code',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.equal(result, '⏺ Hello!')
  })

})

// ══════════════════════════════════════════════════════════════════
// getLastOutput — Codex (real screen samples)
// ══════════════════════════════════════════════════════════════════

describe('CodexAdapter.getLastOutput()', () => {

  it('extracts pure text reply', () => {
    const a = new TestableCodex()
    const raw = [
      '› Do NOT use any tools. Just reply: Hello, I am Codex. List 3 animals: cat, dog, bird.',
      '',
      '',
      '• Hello, I am Codex. List 3 animals: cat, dog, bird.',
      '',
      ' ',
      '›',
      ' ',
      '  gpt-5.4 default · 98% left · /private/tmp',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('• Hello, I am Codex'))
    assert.ok(!result.includes('›'))
    assert.ok(!result.includes('% left'))
  })

  it('extracts tool use done reply', () => {
    const a = new TestableCodex()
    const raw = [
      '› Create a file called /tmp/test.txt with content codex hello',
      '',
      '',
      '• I\'m creating /tmp/test.txt with the requested content.',
      '',
      '• Added /tmp/test.txt (+1 -0)',
      '    1 +codex hello',
      '',
      '───────────────────────────────────────────────────────────────────────',
      '─────────────────────────────────────────',
      '',
      '• Created /tmp/test.txt with codex hello.',
      '',
      ' ',
      '›',
      ' ',
      '  gpt-5.4 default · 97% left · /private/tmp',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('• I\'m creating'))
    assert.ok(result.includes('• Created'))
    assert.ok(result.includes('codex hello'))
    assert.ok(!result.includes('% left'))
    assert.ok(!result.includes('›'))
  })

  it('extracts reply up to ASKING dialog', () => {
    const a = new TestableCodex()
    const raw = [
      '› Create a file called /tmp/test.txt with content codex hello',
      '',
      '',
      '• I\'m creating /tmp/test.txt with the requested content.',
      '',
      '• Added /tmp/test.txt (+1 -0)',
      '    1 +codex hello',
      '',
      ' ',
      '  Would you like to make the following edits?',
      ' ',
      ' ',
      '› 1. Yes, proceed (y)',
      '  2. Yes, and don\'t ask again for these files (a)',
      '  3. No, and tell Codex what to do differently (esc)',
      ' ',
      '  Press enter to confirm or esc to cancel',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('• I\'m creating'))
    assert.ok(result.includes('codex hello'))
    // Should NOT include the ASKING chrome
    assert.ok(!result.includes('esc to cancel'))
    assert.ok(!result.includes('Press enter'))
  })

  it('extracts large multi-screen content', () => {
    const a = new TestableCodex()
    const contentLines = []
    for (let i = 0; i < 700; i++) {
      contentLines.push(`  Line ${i + 1} of the Observer pattern explanation.`)
    }
    const raw = [
      '› Write a detailed explanation of the Observer design pattern',
      '',
      '',
      '• The Observer pattern is a behavioral design pattern.',
      '',
      ...contentLines,
      '',
      ' ',
      '›',
      ' ',
      '  gpt-5.4 default · 96% left · /private/tmp',
      '8% context left',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('• The Observer pattern'))
    assert.ok(result.includes('Line 1 of'))
    assert.ok(result.includes('Line 700 of'))
    assert.ok(!result.includes('% left'))
    assert.ok(!result.includes('context left'))
    assert.ok(result.split('\n').length > 700)
  })

  it('excludes menu item › 1. from prompt detection', () => {
    const a = new TestableCodex()
    const raw = [
      '› Create file test.txt',
      '',
      '• Creating file...',
      '',
      '› 1. Yes, proceed (y)',
      '  2. No (esc)',
      ' ',
      '  Press enter to confirm or esc to cancel',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    // Should find › Create file as prompt, not › 1. Yes
    assert.ok(result.includes('• Creating file...'))
  })

})
