const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { ClaudeCodeAdapter, CodexAdapter, GeminiCliAdapter } = require('../dist/app')

// Access protected methods via thin test subclasses
class TestableClaudeCode extends ClaudeCodeAdapter {
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

class TestableGeminiCli extends GeminiCliAdapter {
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
    // v2.1.145+ input modes (auto/accept edits/plan) all show "(shift+tab to cycle)"
    assert.ok(rules.idle_words.includes('shift+tab to cycle'))
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

  it('idle_words use bullet prompt marker, NOT % left', () => {
    // `% left` is chrome (context-remaining indicator) visible both during streaming
    // and idle — treating it as an idle marker breaks the probe handshake. See codex.ts.
    const a = new TestableCodex()
    const rules = a.testGetDetectRules()
    assert.ok(rules.idle_words.includes('· /'), 'must keep real idle marker')
    assert.ok(!rules.idle_words.includes('% left'), 'must not treat chrome as idle')
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

  it('detects IDLE when cwd is under $HOME (path shown as ~/…)', () => {
    // Regression: codex TUI collapses paths under $HOME to `~/…`, so the
    // idle marker becomes `· ~` instead of `· /`. Missing `· ~` in idle_words
    // stalled init when cwd was any subdirectory of $HOME.
    const a = new TestableCodex()
    const text = 'gpt-5.5 high · ~/subagent-bug-repro'
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

// ══════════════════════════════════════════════════════════════════
// ClaudeCode state detection (real screen samples from kimi task)
// ══════════════════════════════════════════════════════════════════

describe('ClaudeCodeAdapter detect() state detection', () => {

  // Real IDLE screen from user log — bottom of TUI after task completes
  it('detects IDLE from real Claude Code screen', () => {
    const a = new TestableClaudeCode()
    const screen = [
      '⏺ 所有测试通过。任务完成。',
      '',
      '  修改的文件路径清单：',
      '',
      '  1. 新增 src/main/java/com/dofunc/twenx/trace/TraceAuditLogActionRegistry.java',
      '  2. 修改 src/main/java/com/dofunc/twenx/trace/TraceAuditLogEvent.java',
      '',
      '✻ Sautéed for 3m 59s',
      '',
      '───────────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '───────────────────────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts                                                                 Update available! Run: brew upgrade claude-code',
    ].join('\n')
    assert.equal(a.detectState(screen), 'IDLE')
  })

  // Real ASKING screen — approval dialog with tool use
  it('detects ASKING from real approval dialog', () => {
    const a = new TestableClaudeCode()
    const screen = [
      '⏺ Write(src/main/java/com/dofunc/twenx/trace/TraceAuditLogActionRegistry.java)',
      '',
      '───────────────────────────────────────────────────────────────────────────────────────',
      ' Create file',
      ' src/main/java/com/dofunc/twenx/trace/TraceAuditLogActionRegistry.java',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      '  1 package com.dofunc.twenx.trace;',
      '  2',
      '  3 import java.lang.reflect.Method;',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' Do you want to create TraceAuditLogActionRegistry.java?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n')
    assert.equal(a.detectState(screen), 'ASKING')
  })

  // RUNNING screen
  it('detects RUNNING from real running screen', () => {
    const a = new TestableClaudeCode()
    const screen = [
      '⏺ Now let me read the test file.',
      '',
      '⏺ Read(src/test/java/com/dofunc/twenx/trace/TraceAuditLogFilterTest.java)',
      '',
      '───────────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '───────────────────────────────────────────────────────────────────────────────────────',
      '  esc to interrupt                                                                 Update available! Run: brew upgrade claude-code',
    ].join('\n')
    assert.equal(a.detectState(screen), 'RUNNING')
  })

  // Explain panel screen: detect() returns IDLE (correct — pure text matching).
  // The fix is in onIdle() which no longer transitions from ASKING.
  it('explain panel screen: detect returns IDLE (known, guarded by onIdle)', () => {
    const a = new TestableClaudeCode()
    const screen = [
      '⏺ Write(src/main/java/com/dofunc/twenx/trace/TraceAuditLogActionRegistry.java)',
      '',
      '  ⎿  Wrote 75 lines to src/main/java/com/dofunc/twenx/trace/TraceAuditLogActionRegistry.java',
      '       1 package com.dofunc.twenx.trace;',
      '       2',
      '       3 import java.lang.reflect.Method;',
      '',
      '───────────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '───────────────────────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts                                                                 Update available! Run: brew upgrade claude-code',
    ].join('\n')
    // Has ❯ + "shortcuts" but no "Esc to cancel" → detect returns IDLE.
    // This is correct for detect(). The defense is onIdle() ignoring ASKING state.
    assert.equal(a.detectState(screen), 'IDLE')
  })

  it('detects IDLE in v2.1.145 auto/accept-edits/plan modes (shift+tab to cycle)', () => {
    const a = new TestableClaudeCode()
    const footer = (mode) => [
      '───────────────────────────────────────────────────────────────────────────────────────',
      '❯',
      '───────────────────────────────────────────────────────────────────────────────────────',
      `  ${mode}                                                                 ◈ max · /effort`,
    ].join('\n')
    // Regression: auto mode and plan mode used to stall init because idle_words
    // only matched "shortcuts"/"accept edits" (pre-v2.1.145 wording).
    assert.equal(a.detectState(footer('⏵⏵ auto mode on (shift+tab to cycle)')), 'IDLE')
    assert.equal(a.detectState(footer('⏵⏵ accept edits on (shift+tab to cycle)')), 'IDLE')
    assert.equal(a.detectState(footer('⏸ plan mode on (shift+tab to cycle)')), 'IDLE')
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

// ══════════════════════════════════════════════════════════════════
// GeminiCliAdapter DetectRules validation
// ══════════════════════════════════════════════════════════════════

describe('GeminiCliAdapter.getAdapterDetectRules()', () => {

  it('returns correct input keys', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    assert.equal(rules.input_keys.approve, '\r')
    assert.equal(rules.input_keys.allow, '\x1b[B\r')
    assert.equal(rules.input_keys.reject, '\x1b')
    assert.equal(rules.input_keys.amend, '')
    assert.equal(rules.input_keys.cancel, '\x1b')
    assert.equal(rules.input_keys.explain, '')
    assert.equal(rules.input_keys.exit, '')
  })

  it('match_words contain expected keywords', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    assert.ok(rules.match_words.includes('? for shortcuts'))
    assert.ok(rules.match_words.includes('esc to cancel'))
    assert.ok(rules.match_words.includes('Allow once'))
  })

  it('idle_words contain shortcuts and accept edits', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    assert.ok(rules.idle_words.includes('? for shortcuts'))
    assert.ok(rules.idle_words.includes('accept edits'))
  })

  it('asking_words contain Allow once and Apply this change', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    assert.ok(rules.asking_words.includes('Allow once'))
    assert.ok(rules.asking_words.includes('Apply this change'))
  })

  it('running_words contain esc to cancel', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    assert.ok(rules.running_words.includes('esc to cancel'))
  })

  it('prompt_marker and chrome_words are configured', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    assert.equal(rules.prompt_marker, '✦')
    assert.ok(rules.chrome_words.length > 0)
    assert.ok(rules.chrome_words.includes('? for shortcuts'))
    assert.ok(rules.chrome_words.includes('Allow once'))
  })

})

// ══════════════════════════════════════════════════════════════════
// GeminiCli state detection (real screen samples from PTY test)
// ══════════════════════════════════════════════════════════════════

describe('GeminiCliAdapter detect() state detection', () => {

  it('detects IDLE from real Gemini CLI idle screen', () => {
    const a = new TestableGeminiCli()
    const screen = [
      '✦ Hello.',
      '╭──────────────────────────────────────────────────────────────────╮',
      '│ Gemini CLI update available! 0.38.2 → 0.40.0                        │',
      '╰──────────────────────────────────────────────────────────────────╯',
      '                                                       ? for shortcuts',
      '────────────────────────────────────────────────────────────────────',
      ' Shift+Tab to accept edits                    1 GEMINI.md file',
      '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      ' >   Type your message or @path/to/file',
    ].join('\n')
    assert.equal(a.detectState(screen), 'IDLE')
  })

  it('detects RUNNING from Thinking indicator', () => {
    const a = new TestableGeminiCli()
    const screen = [
      ' ⠹ Thinking... (esc to cancel, 3s)                     ? for shortcuts',
      '────────────────────────────────────────────────────────────────────',
      ' Shift+Tab to accept edits                    1 GEMINI.md file',
      '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      ' >   Type your message or @path/to/file',
    ].join('\n')
    assert.equal(a.detectState(screen), 'RUNNING')
  })

  it('detects ASKING from approval dialog', () => {
    const a = new TestableGeminiCli()
    const screen = [
      '│ ? WriteFile  Writing to hello.txt                                    │',
      '│ ╭──────────────────────────────────────────────────────────────╮ │',
      '│ │ 1 hello world                                                    │ │',
      '│ ╰──────────────────────────────────────────────────────────────╯ │',
      '│ Apply this change?                                                   │',
      '│                                                                      │',
      '│ ● 1. Allow once                                                      │',
      '│   2. Allow for this session                                          │',
      '│   3. Modify with external editor                                     │',
      '│   4. No, suggest changes (esc)                                       │',
      '╰──────────────────────────────────────────────────────────────────╯',
    ].join('\n')
    assert.equal(a.detectState(screen), 'ASKING')
  })

  it('returns null for text without match_words', () => {
    const a = new TestableGeminiCli()
    assert.equal(a.detectState('just some random text'), null)
  })

  it('running takes priority over idle (both present)', () => {
    const a = new TestableGeminiCli()
    const text = 'esc to cancel  ? for shortcuts  accept edits'
    assert.equal(a.detectState(text), 'RUNNING')
  })

  it('asking takes priority over running (both present)', () => {
    const a = new TestableGeminiCli()
    const text = 'Allow once  esc to cancel  ? for shortcuts'
    assert.equal(a.detectState(text), 'ASKING')
  })

  it('Apply this change also triggers ASKING', () => {
    const a = new TestableGeminiCli()
    const text = 'Apply this change?  ? for shortcuts'
    assert.equal(a.detectState(text), 'ASKING')
  })

})

// ══════════════════════════════════════════════════════════════════
// GeminiCli keyword rules validation
// ══════════════════════════════════════════════════════════════════

describe('GeminiCli detection engine: keyword rules validation', () => {

  it('idle_words and asking_words have no overlap', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    for (const word of rules.idle_words) {
      assert.ok(!rules.asking_words.includes(word), `"${word}" overlaps between idle and asking`)
    }
  })

  it('running_words and asking_words have no overlap', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    for (const word of rules.running_words) {
      assert.ok(!rules.asking_words.includes(word), `"${word}" overlaps between running and asking`)
    }
  })

  it('running_words and idle_words have no overlap', () => {
    const a = new TestableGeminiCli()
    const rules = a.testGetDetectRules()
    for (const word of rules.running_words) {
      assert.ok(!rules.idle_words.includes(word), `"${word}" overlaps between running and idle`)
    }
  })

})

// ══════════════════════════════════════════════════════════════════
// getLastOutput — Gemini CLI (real screen samples from PTY test)
// ══════════════════════════════════════════════════════════════════

describe('GeminiCliAdapter.getLastOutput()', () => {

  it('extracts pure text reply', () => {
    const a = new TestableGeminiCli()
    const raw = [
      '> say hello in one word',
      '✦ Hello.',
      '',
      '                                                       ? for shortcuts',
      '────────────────────────────────────────────────────────────────────',
      ' Shift+Tab to accept edits                    1 GEMINI.md file',
      '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      ' >   Type your message or @path/to/file',
      '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      ' workspace (/directory)',
      ' ~                                                      Auto (Gemini 3)',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('Hello.'), `Expected Hello. in: ${result}`)
    assert.ok(!result.includes('shortcuts'))
    assert.ok(!result.includes('accept edits'))
    assert.ok(!result.includes('Type your message'))
    assert.ok(!result.includes('workspace'))
  })

  it('extracts tool use done reply', () => {
    const a = new TestableGeminiCli()
    const raw = [
      '> create hello.txt with hello world',
      '✦ I will create a file named hello.txt with the content "hello world".',
      '',
      '✦ Successfully created hello.txt with "hello world".',
      '',
      '                                                       ? for shortcuts',
      '────────────────────────────────────────────────────────────────────',
      ' Shift+Tab to accept edits                    1 GEMINI.md file',
      '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      ' >   Type your message or @path/to/file',
      '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      ' workspace (/directory)',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('Successfully created'))
    assert.ok(!result.includes('shortcuts'))
    assert.ok(!result.includes('workspace'))
  })

  it('trims Update available chrome', () => {
    const a = new TestableGeminiCli()
    const raw = [
      '> say hello',
      '✦ Hello.',
      '╭──────────────────────────────────────────────────────────────────╮',
      '│ Gemini CLI update available! 0.38.2 → 0.40.0                        │',
      '│ Installed via Homebrew. Please update with "brew upgrade gemini-cli" │',
      '╰──────────────────────────────────────────────────────────────────╯',
      '                                                       ? for shortcuts',
      ' Shift+Tab to accept edits',
      '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      ' >   Type your message or @path/to/file',
      '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('Hello.'))
    assert.ok(!result.includes('Update available'))
    assert.ok(!result.includes('brew upgrade'))
  })

  it('handles screen without user prompt (scrolled off)', () => {
    const a = new TestableGeminiCli()
    const raw = [
      '✦ Hello.',
      '',
      '                                                       ? for shortcuts',
      '────────────────────────────────────────────────────────────────────',
      ' Shift+Tab to accept edits',
    ].join('\n')
    const result = a.testGetLastOutput(raw)
    assert.ok(result.includes('Hello.'))
    assert.ok(!result.includes('shortcuts'))
  })

})
