import { SubagentCliAdapter, registerAdapter } from '../adapter'
import type { OpenParams, OpenResult, DetectRules, ApprovalInfo } from '../types'

// Match session UUID from exit output: "gemini --resume 4f5c854e-c2b8-41b3-8984-c400260b7b6a"
const SESSION_ID_RE = /--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * GeminiCliAdapter — adapter for Gemini CLI (interactive TUI mode).
 *
 * Startup flow:
 *   1. Spawn `gemini` → onInit handles trust dialog + update notice → IDLE
 *   2. Send init prompt with role + notice (auto-approve MCP tools) → wait for IDLE
 *   3. Return — session stays alive (no exit/respawn)
 *
 * Session ID is captured at exit() / close() time via parseSessionId().
 *
 * Detection:
 *   IDLE:    idle_words hit (? for shortcuts / accept edits) without asking/running
 *   RUNNING: running_words hit (esc to cancel — inside "Thinking..." line)
 *   ASKING:  asking_words hit (Allow once / Apply this change)
 *
 * Differences from Claude Code:
 *   - No amend/explain support
 *   - Exit via Ctrl+D×2 (no /exit or /quit command)
 *   - Resume via `--resume <uuid>`
 *   - Approval menu: Allow once / Allow for this session / No, suggest changes
 */
export class GeminiCliAdapter extends SubagentCliAdapter {
  readonly name = 'gemini-cli'

  /**
   * Custom init: poll screen to handle startup dialogs and wait for real IDLE.
   *
   * Gemini CLI startup stages:
   *   1. Trust dialog (optional) → send Enter to confirm
   *   2. Restart after trust → wait
   *   3. Update notice → ignore
   *   4. Real IDLE (shows "? for shortcuts") → done
   */
  protected async onInit(_timeoutMs: number): Promise<void> {
    const maxIterations = 60
    for (let i = 0; i < maxIterations; i++) {
      await this.wait(2000)
      await this.terminal.flush()
      const screen = this.terminal.capture(this.terminal.totalLines)

      if (screen.includes('? for shortcuts') || screen.includes('Type your message')) {
        this.state = 'IDLE'
        return
      }

      if (screen.includes('Do you trust')) {
        this.terminal.write('\r')
        continue
      }

      if (screen.includes('restarting')) continue
    }
    throw new Error('READY_TIMEOUT')
  }

  async open(params: OpenParams, session?: string, home?: string, timeout = 0): Promise<OpenResult> {
    if (params.args.includes('--resume')) {
      return super.open(params, session, home, timeout)
    }

    // Phase 1: spawn → onInit handles dialogs + boot → IDLE
    await super.open(params, session, home, timeout)

    // Phase 2: send init prompt to create session
    // Enable auto-approve: init may trigger MCP tool use (e.g. Pencil get_editor_state)
    this.setAutoApprove(true)
    const initPrompt = this.buildInitPrompt(params.role)
    this.terminal.write(initPrompt, true)
    await this.wait(500)
    this.terminal.write('\r')
    this.state = 'RUNNING'
    const isIdle = () => this.state === 'IDLE'
    for (let i = 0; i < 60 && !isIdle(); i++) {
      await this.wait(2000)
    }
    this.setAutoApprove(false)

    return { session: session ?? '' }
  }

  protected parseSessionId(exitOutput: string): string | undefined {
    return exitOutput.match(SESSION_ID_RE)?.[1]
  }

  /**
   * Override: Gemini CLI exits via Ctrl+U + Ctrl+D×2 (no /exit or /quit command).
   */
  protected async sendExitCommand(_exitCmd: string): Promise<void> {
    this.terminal.write('\x15')
    await this.wait(300)
    this.terminal.write('\x04')
    await this.wait(300)
    this.terminal.write('\x04')
  }

  /**
   * Override: Gemini CLI uses ✦ as AI response marker (not user prompt marker).
   * Strategy: trim chrome/borders from bottom, then take remaining content.
   */
  protected getLastOutput(rawText: string): string {
    const { chrome_words } = this.getAdapterDetectRules()
    const lines = rawText.split('\n')

    // Find last user prompt: lines starting with ">" that have real content
    // (exclude input placeholder "Type your message")
    let startIdx = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim()
      if (t.startsWith('>') && t.length > 2
          && !t.includes('Type your message') && !/^>\s*$/.test(t)) {
        startIdx = i + 1
        break
      }
    }

    // Trim TUI chrome from bottom
    let endIdx = lines.length
    for (let i = lines.length - 1; i >= startIdx; i--) {
      const t = lines[i].trim()
      if (t === '' || /^[─╌▀▄▐▌█░▒▓╭╮╰╯│┃═━]{3,}$/.test(t)
          || chrome_words.some(w => t.toLowerCase().includes(w.toLowerCase()))
          || /^[│┃]/.test(t) || /[│┃]$/.test(t)
          || /^workspace\s/.test(t) || /^[~/]/.test(t)
          || /sandbox|no sandbox/i.test(t) || /Auto \(/.test(t)) {
        endIdx = i
      } else {
        break
      }
    }

    return lines.slice(startIdx, endIdx).join('\n').trim()
  }

  protected async getQuestion(): Promise<ApprovalInfo> {
    await this.terminal.flush()
    const screenText = this.terminal.capture()

    // Trust dialog
    if (/Do you trust the files/i.test(screenText)) {
      return { tool: 'trust', target: 'folder' }
    }

    // File tool: "? WriteFile  Writing to hello.txt"
    // MCP tool: '?  get_editor_state (pencil MCP Server) {"include_schema":true}'
    const fileMatch = screenText.match(/\?\s+(\w+)\s+\w+(?:\s+to)?\s+(\S+)/)
    const mcpMatch = screenText.match(/\?\s+(\w+)\s+\((\w+)\s+MCP/)
    const toolMatch = fileMatch ?? mcpMatch

    // Extract context: from tool line to before menu
    const menuMatch = screenText.match(/●\s*1\./)
    const applyMatch = screenText.match(/Apply this change/)
    const contextStart = applyMatch?.index ?? menuMatch?.index ?? screenText.length
    const toolLineMatch = screenText.match(/\?\s+\w+\s+\w+/)
    const toolLineIdx = toolLineMatch?.index ?? 0
    const reason = toolLineIdx < contextStart
      ? screenText.slice(toolLineIdx, menuMatch?.index ?? screenText.length).trim()
      : ''

    return {
      tool: toolMatch?.[1] ?? 'unknown',
      target: toolMatch?.[2] ?? '',
      reason,
    }
  }

  protected getAdapterDetectRules(): DetectRules {
    return {
      input_keys: {
        approve: '\r',                // Enter → Allow once
        allow: '\x1b[B\r',            // Down↓ Enter → Allow for this session
        reject: '\x1b',               // Escape → No, suggest changes
        amend: '',                     // Not supported
        cancel: '\x1b',               // Escape during running
        explain: '',                   // Not supported
        exit: '',                      // Ctrl+D×2 handled in exit() override
      },
      match_words: ['? for shortcuts', 'esc to cancel', 'Allow once', 'accept edits'],
      idle_words: ['? for shortcuts', 'accept edits'],
      running_words: ['esc to cancel'],
      asking_words: ['Allow once', 'Apply this change'],
      prompt_marker: '✦',
      chrome_words: ['? for shortcuts', 'accept edits', 'update available', 'brew upgrade',
                     'Allow once', 'Apply this change', 'Allow for this session',
                     'No, suggest changes', 'Modify with external editor',
                     'Type your message'],
    }
  }
}

registerAdapter('gemini-cli', GeminiCliAdapter)
