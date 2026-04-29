import { SubagentCliAdapter, registerAdapter } from '../adapter'
import type { OpenParams, OpenResult, DetectRules, ApprovalInfo } from '../types'

const SESSION_ID_RE = /codex resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * CodexAdapter — adapter for OpenAI Codex CLI (interactive TUI mode).
 *
 * Startup flow (session ID acquisition):
 *   1. Spawn `codex` with user-configured args
 *   2. onInit: handle startup dialogs + wait for MCP boot → IDLE
 *   3. Send init prompt → wait for completion
 *   4. Send `/quit` → wait for process exit
 *   5. Parse session ID from exit output ("codex resume <uuid>")
 *   6. Re-spawn with `codex resume <uuid>` + original args → IDLE
 *   7. Return UUID as the subagent-cli session ID
 *
 * Differences from Claude Code:
 *   - No amend/explain support
 *   - Exit via /quit, resume via subcommand (codex resume <id>)
 *   - Custom onInit: handles update prompt, trust dialog, MCP boot
 *   - idle_words uses '% left' (not '›') to avoid TUI cursor blink re-triggering
 */
export class CodexAdapter extends SubagentCliAdapter {
  readonly name = 'codex'
  private sessionId?: string

  getSessionId(): string | undefined { return this.sessionId }

  buildResumeArgs(resumeId: string, originalArgs: string[]): string[] {
    return ['resume', resumeId, ...originalArgs]
  }

  /**
   * Custom init: poll screen to handle startup dialogs and wait for real IDLE.
   *
   * Codex startup stages:
   *   1. Update prompt (optional) → send ↓+Enter to Skip
   *   2. Trust directory (optional) → send Enter to confirm
   *   3. MCP boot (shows "Booting") → wait
   *   4. Real IDLE (shows "% left", no "Booting") → done
   */
  protected async onInit(_timeoutMs: number): Promise<void> {
    const maxIterations = 60
    for (let i = 0; i < maxIterations; i++) {
      await this.wait(2000)
      await this.terminal.flush()
      const screen = this.terminal.capture(this.terminal.totalLines)

      if ((screen.includes('% left') || screen.includes('· /'))
          && !screen.includes('Booting')) {
        this.terminal.write('\x15') // Ctrl+U: clear any probe residue
        this.state = 'IDLE'
        return
      }

      if (screen.includes('Update available')
          || screen.includes('Try new model')) {
        this.terminal.write('\x1b[B')  // Down arrow → Skip / Use existing model
        await this.wait(200)
        this.terminal.write('\r')
        continue
      }

      if (screen.includes('Do you trust')) {
        this.terminal.write('\r')  // Enter → Yes
        continue
      }

      if (screen.includes('Booting')) continue
    }
    throw new Error('READY_TIMEOUT')
  }

  async open(params: OpenParams, session?: string, home?: string, timeout = 0): Promise<OpenResult> {
    // Reconnect path: args already contain 'resume'
    if (params.args.includes('resume')) {
      return super.open(params, session, home, timeout)
    }

    // New session path
    const ms = timeout * 1000

    // Phase 1: spawn → onInit handles dialogs + boot → IDLE
    await super.open(params, session, home, timeout)

    // Phase 2: send init prompt to create session
    const initPrompt = `[subagent-cli] ${params.role ?? 'hi'}`
    this.terminal.write(initPrompt, true)
    await this.wait(500)
    this.terminal.write('\r')
    this.state = 'RUNNING'
    // Wait for detection engine to transition state to IDLE
    const isIdle = () => this.state === 'IDLE'
    for (let i = 0; i < 60 && !isIdle(); i++) {
      await this.wait(2000)
    }

    // Phase 3: wait for TUI to settle, then send /quit
    await this.wait(2000)
    this.terminal.write('/quit', true)
    await this.wait(500)
    this.terminal.write('\r')
    const exitOutput = await new Promise<string>(resolve => {
      this.terminal.once('exit', async () => {
        await this.terminal.flush()
        resolve(this.terminal.capture(1000))
      })
    })

    // Phase 4: parse session ID
    const match = exitOutput.match(SESSION_ID_RE)
    if (!match) {
      this.terminal.spawn(params.command, params.args, {
        cwd: params.cwd,
        env: this.buildEnv(params.env),
      })
      this.state = 'INITING'
      await this.onInit(ms)
      return { session: session ?? '' }
    }

    this.sessionId = match[1]

    // Phase 5: re-spawn with resume subcommand
    this.terminal.spawn(
      params.command,
      this.buildResumeArgs(this.sessionId, params.args),
      { cwd: params.cwd, env: this.buildEnv(params.env) },
    )
    this.state = 'INITING'
    await this.onInit(ms)
    return { session: this.sessionId }
  }

  protected async getQuestion(): Promise<ApprovalInfo> {
    await this.terminal.flush()
    const screenText = this.terminal.capture()

    // Trust dialog
    if (/Do you trust the contents/i.test(screenText)) {
      return { tool: 'trust', target: 'directory' }
    }

    // File edit approval: "Would you like to make the following edits?"
    const fileMatch = screenText.match(/(?:Added|Modified|Deleted)\s+(\S+)\s+\([^)]+\)/)

    // Extract diff context
    const editStart = screenText.indexOf('Would you like to make the following edits?')
    const menuMatch = screenText.match(/›\s*1\.\s/)
    const menuIdx = menuMatch?.index ?? screenText.length
    const reason = editStart >= 0 && menuIdx > editStart
      ? screenText.slice(editStart, menuIdx).trim()
      : ''

    // Command approval
    const cmdMatch = screenText.match(/Ran?\s+(.+?)(?:\n|$)/)

    return {
      tool: fileMatch ? 'edit' : cmdMatch ? 'command' : 'unknown',
      target: fileMatch?.[1] ?? cmdMatch?.[1] ?? '',
      reason,
    }
  }

  protected getAdapterDetectRules(): DetectRules {
    return {
      input_keys: {
        approve: '\r',
        allow: '\x1b[B\r',
        reject: '\x1b[B\x1b[B\r',
        amend: '',
        cancel: '\x1b',
        explain: '',
        exit: 'quit',
      },
      match_words: ['% left', 'esc to', 'tab to queue', '· /'],
      idle_words: ['% left', '· /'],
      running_words: ['esc to interrupt', 'tab to queue'],
      asking_words: ['esc to cancel'],
      probe: ' ',
      prompt_marker: '›',
      chrome_words: ['% left', 'context left', 'esc to cancel', 'Press enter to confirm'],
    }
  }
}

registerAdapter('codex', CodexAdapter)
