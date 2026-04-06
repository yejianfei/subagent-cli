const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { PtyXterm } = require('../dist/app')

/** xterm.write() is async — need to wait for internal buffer flush */
function writeAndFlush(ptyXterm, data) {
  return new Promise((resolve) => {
    ptyXterm['term'].write(data, resolve)
  })
}

describe('PtyXterm', () => {
  it('captures plain text', async () => {
    const t = new PtyXterm(80, 24, 100)
    await writeAndFlush(t, 'hello\r\nworld')
    const text = t.capture()
    assert.ok(text.includes('hello'), `Expected 'hello' in: ${JSON.stringify(text)}`)
    assert.ok(text.includes('world'))
    t.dispose()
  })

  it('strips ANSI colors in capture', async () => {
    const t = new PtyXterm(80, 24, 100)
    await writeAndFlush(t, '\x1b[31mred text\x1b[0m')
    const text = t.capture()
    assert.ok(text.includes('red text'))
    assert.ok(!text.includes('\x1b[31m'))
    t.dispose()
  })

  it('handles cursor positioning', async () => {
    const t = new PtyXterm(80, 24, 100)
    await writeAndFlush(t, '\x1b[2;5Hhere')
    const text = t.capture()
    const lines = text.split('\n')
    assert.ok(lines.length >= 2, `Expected >=2 lines, got ${lines.length}`)
    assert.ok(lines[1].includes('here'), `Expected 'here' in line 1: ${JSON.stringify(lines[1])}`)
    t.dispose()
  })

  it('trims trailing empty lines', async () => {
    const t = new PtyXterm(80, 24, 100)
    await writeAndFlush(t, 'content\r\n\r\n\r\n')
    const text = t.capture()
    assert.ok(text.includes('content'))
    assert.ok(!text.endsWith('\n\n\n'))
    t.dispose()
  })

  it('preserves scrollback in history via capture(totalLines)', async () => {
    const t = new PtyXterm(80, 5, 100)
    for (let i = 0; i < 10; i++) {
      await writeAndFlush(t, `line ${i}\r\n`)
    }
    const history = t.capture(t.totalLines)
    assert.ok(history.includes('line 0'), `Expected 'line 0' in history`)
    assert.ok(history.includes('line 9'), `Expected 'line 9' in history`)
    t.dispose()
  })

  it('capture(lines) limits returned line count', async () => {
    const t = new PtyXterm(80, 5, 100)
    for (let i = 0; i < 10; i++) {
      await writeAndFlush(t, `line ${i}\r\n`)
    }
    const last3 = t.capture(3)
    assert.ok(!last3.includes('line 0'), 'Should not include old lines')
    t.dispose()
  })

  it('resizes without crashing', async () => {
    const t = new PtyXterm(80, 24, 100)
    await writeAndFlush(t, 'before resize')
    t.resize(120, 40)
    // After resize, terminal should still be operational
    await writeAndFlush(t, '\r\nafter resize')
    await t.flush()
    const text = t.capture()
    // xterm resize may restructure buffer; just verify no crash and capture works
    assert.ok(typeof text === 'string')
    t.dispose()
  })

  it('clear resets screen state', async () => {
    const t = new PtyXterm(80, 24, 100)
    await writeAndFlush(t, 'some content')
    t.clear()
    await t.flush()
    const text = t.capture()
    assert.equal(text, '', 'Expected empty screen after clear')
    t.dispose()
  })

  it('totalLines getter works', async () => {
    const t = new PtyXterm(80, 24, 100)
    await writeAndFlush(t, 'line1\r\nline2\r\nline3')
    assert.ok(t.totalLines >= 3)
    t.dispose()
  })

  it('disposes cleanly', () => {
    const t = new PtyXterm(80, 24, 100)
    t.dispose()
    assert.ok(true)
  })

  it('emits exit with non-zero code for invalid command (preflight scenario)', async () => {
    const t = new PtyXterm(80, 24, 100)
    const code = await new Promise((resolve) => {
      t.on('exit', resolve)
      t.spawn('/nonexistent_command', [], { cwd: process.cwd(), env: process.env })
    })
    assert.ok(code !== 0, `Expected non-zero exit code, got ${code}`)
    t.dispose()
  })

  it('emits exit with zero code for valid command (preflight scenario)', async () => {
    const t = new PtyXterm(80, 24, 100)
    const code = await new Promise((resolve) => {
      t.on('exit', resolve)
      t.spawn('echo', ['ok'], { cwd: process.cwd(), env: process.env })
    })
    assert.equal(code, 0)
    t.dispose()
  })
})
