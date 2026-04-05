import { appendFileSync, readFileSync, existsSync } from 'fs'

/**
 * SessionHistory — Read/write session history file.
 * 1 instance = 1 session's history.md file.
 */
export class SessionHistory {
  constructor(private filePath?: string) {}

  /** Append a log entry */
  log(type: string, content: string): void {
    if (!this.filePath) return
    appendFileSync(this.filePath, `## ${new Date().toISOString()} ${type}\n${content}\n\n`)
  }

  /** Retrieve log entries, optionally filtered by type */
  getLogs(type?: string): string[] {
    if (!this.filePath || !existsSync(this.filePath)) return []
    const content = readFileSync(this.filePath, 'utf-8')
    const pattern = type
      ? new RegExp(`^## .+ ${type}\\n([\\s\\S]*?)(?=\\n## |\\n*$)`, 'gm')
      : /^## .+\n([\s\S]*?)(?=\n## |\n*$)/gm
    return Array.from(content.matchAll(pattern), m => m[1].trim())
  }
}
