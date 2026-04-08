import { SubagentCliAdapter, registerAdapter } from '../adapter'
import { loadConfig } from '../config'
import type { OpenParams, OpenResult, PromptResult, DetectRules, ApprovalInfo } from '../types'

const SESSION_ID_RE = /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * ClaudeCodeAdapter — adapter for Claude Code CLI (interactive TUI mode).
 *
 * NOTE: Do NOT use --bare flag. Interactive mode is required for PTY state detection.
 *
 * Startup flow (session ID acquisition):
 *   1. Spawn `claude` → wait for IDLE (❯ prompt)
 *   2. Send init prompt → wait for completion (creates Claude Code session)
 *   3. Send `/exit` → wait for process exit
 *   4. Parse session ID from exit output ("claude --resume <uuid>")
 *   5. Re-spawn with `--resume <uuid>` → wait for IDLE
 *   6. Return UUID as the subagent-cli session ID
 *
 * Detection:
 *   IDLE:    match_words hit + idle_words hit (❯ + shortcuts/accept edits)
 *   ASKING:  match_words hit + asking_words hit (Esc/trust + Esc to cancel/Yes, I trust)
 *   RUNNING: none of the above match
 */
export class ClaudeCodeAdapter extends SubagentCliAdapter {
  readonly name = 'claude-code'
  private sessionId?: string

  /** Get the Claude Code session ID (available after open completes) */
  getSessionId(): string | undefined { return this.sessionId }

  /**
   * Override: acquire Claude Code session ID via exit + resume cycle.
   * If --resume is already in args (reconnect), skip the acquisition.
   */
  async open(params: OpenParams, session?: string, home?: string, timeout = 0): Promise<OpenResult> {
    // Reconnect path: just open normally
    if (params.args.includes('--resume')) {
      return super.open(params, session, home, timeout)
    }

    // New session path
    const cfg = loadConfig()
    const ms = timeout * 1000

    // Phase 1: initial spawn → wait for IDLE
    await super.open(params, session, home, timeout)

    // Phase 2: send init prompt to create session
    const subCfg = cfg.subagents[params.subagent]
    const initPrompt = subCfg?.role ?? 'hi'
    await this.exec<PromptResult>('done', ms, async () => {
      this.terminal.write(initPrompt, true)
      await this.wait(500)
      this.state = 'RUNNING'
      this.terminal.write('\r')
    })

    // Phase 3: wait for TUI to settle, then send /exit
    await this.wait(2000)
    this.terminal.write('/exit\r')
    const exitOutput = await new Promise<string>(resolve => {
      this.terminal.once('exit', async () => {
        await this.terminal.flush()
        resolve(this.terminal.capture(1000))
      })
    })

    // Phase 4: parse session ID
    const match = exitOutput.match(SESSION_ID_RE)
    if (!match) {
      // Fallback: re-spawn without --resume
      this.terminal.spawn(params.command, params.args, {
        cwd: params.cwd,
        env: this.buildEnv(params.env),
      })
      await this.wait(3000)
      this.state = 'INITING'
      await this.onInit(ms)
      return { session: session ?? '' }
    }

    this.sessionId = match[1]

    // Phase 5: re-spawn with --resume, wait for new process to render
    this.terminal.spawn(
      params.command,
      [...params.args, '--resume', this.sessionId],
      { cwd: params.cwd, env: this.buildEnv(params.env) },
    )
    this.state = 'INITING'
    await this.onInit(ms)
    return { session: this.sessionId }
  }

  protected async getQuestion(): Promise<ApprovalInfo> {
    // Send explain key to get detailed context, then capture screen
    const rules = this.getAdapterDetectRules()
    if (rules.input_keys.explain) {
      this.terminal.write(rules.input_keys.explain)
      await this.wait(500)
      await this.terminal.flush()
    }
    const screenText = this.terminal.capture()
    // Close explain panel (toggle off) to restore normal approval screen
    if (rules.input_keys.explain) {
      this.terminal.write(rules.input_keys.explain)
      await this.wait(300)
    }

    // Trust dialog
    if (/(?:trust\s+this\s+folder|one\s+you\s+trust)/i.test(screenText)) {
      return { tool: 'trust', target: 'folder' }
    }

    // Tool approval: ⏺ Write(test.txt) ...
    const toolMatch = screenText.match(/⏺\s*(\w+)\(([^)]*)\)/)
    const questionMatch = screenText.match(/Do you want to \w+ (.+?)\?/i)

    // Extract context: from ⏺ tool marker to before selection menu (❯ 1.)
    const toolStart = screenText.indexOf('⏺')
    const menuMatch = screenText.match(/❯\s*1\.\s/)
    const menuIdx = menuMatch?.index ?? screenText.length
    const reason = toolStart >= 0 && menuIdx > toolStart
      ? screenText.slice(toolStart, menuIdx).trim()
      : ''

    return {
      tool: toolMatch?.[1] ?? 'unknown',
      target: toolMatch?.[2] ?? questionMatch?.[1] ?? '',
      reason,
    }
  }

  protected getAdapterDetectRules(): DetectRules {
    return {
      input_keys: {
        approve: '\r',                // Enter → option 1: Yes
        allow: '\x1b[B\r',            // Down↓ Enter → option 2: Allow/don't ask again
        reject: '\x1b[B\x1b[B\r',     // Down↓ Down↓ Enter → option 3: No
        amend: '\t',                  // Tab to enter amend mode
        cancel: '\x1b',              // Escape
        explain: '\x05',             // Ctrl+E to explain
        exit: 'exit',                // /exit command
      },
      match_words: ['❯', 'trust', 'Esc'],
      idle_words: ['shortcuts', 'accept edits'],
      running_words: ['esc to interrupt'],
      asking_words: ['Esc to cancel', 'I trust'],
      prompt_marker: '❯',
      chrome_words: ['shortcuts', 'accept edits', 'Update available', 'brew upgrade',
                     'Esc to cancel', 'Tab to amend'],
    }
  }

}

// Self-register
registerAdapter('claude-code', ClaudeCodeAdapter)
