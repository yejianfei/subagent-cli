// Unified type definitions for subagent-cli

export type AgentState = 'OPENING' | 'INITING' | 'IDLE' | 'PENDING' | 'RUNNING' | 'ASKING' | 'CLOSED'

export interface OpenParams {
  subagent: string
  adapter: string
  cwd: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface OpenResult {
  session: string
}

export interface ApprovalInfo {
  tool: string
  target: string
  reason?: string
}

export interface PromptResult {
  status: 'done' | 'approval_needed' | 'waiting'
  approval?: ApprovalInfo
}

export interface SessionStatus {
  state: AgentState
  subagent: string
  cwd: string
  created_at: string
}

export interface OutputResult {
  type: 'screen' | 'history'
  content: string
  lines: number
}

export interface DetectRules {
  input_keys: {
    approve: string   // Enter → option 1: Yes
    allow: string     // Down↓ Enter → option 2: Allow
    reject: string    // Down↓ Down↓ Enter → option 3: No
    amend: string     // Tab to enter amend mode
    cancel: string    // Escape (sent twice)
    explain: string   // Ctrl+E or equivalent to explain
    exit: string      // command word only, e.g. 'exit' or 'quit'
  }
  match_words: string[]
  idle_words: string[]
  running_words: string[]
  asking_words: string[]
  /** Probe character sent once on entering RUNNING to trigger a running indicator.
   *  E.g. Codex shows "tab to queue message" when input is non-empty during RUNNING. */
  probe?: string
}
