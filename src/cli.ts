#!/usr/bin/env node
import { program } from 'commander'
import path from 'node:path'
import { setConfigPath } from './config'
import { SubagentClient } from './client'

declare const __VERSION__: string

program
  .name('subagent-cli')
  .version(__VERSION__)
  .description('Let your AI agent drive other AI agents (Claude Code, Codex, Gemini CLI)')
  .option('-c, --config <path>', 'Config file path (default: ~/.subagent-cli/config.json)')
  .hook('preAction', () => {
    const opts = program.opts<{ config?: string }>()
    if (opts.config) setConfigPath(opts.config)
  })
  .addHelpText('after', `
Workflow:
  1. subagent-cli subagents                      # list available subagents
  2. subagent-cli open -s haiku --cwd .             # start session, returns session ID
     subagent-cli open -s haiku --cwd . --role "Java expert"  # custom role as session title
     subagent-cli open -s haiku --cwd . "do the task"        # open + send first prompt
     subagent-cli open -s haiku --cwd . --reuse "task"       # reuse same-cwd session (set idle.fast_reuse=true to default-on)
     subagent-cli open -s haiku --cwd . --auto "task"        # one-shot: open + auto-approve + run, blocks until IDLE (ASKING auto-confirmed)
  3. subagent-cli check --session <id>           # verify state before every command!
  4. subagent-cli prompt --session <id> "task"   # send task, done returns output field
     subagent-cli prompt --session <id> --auto "task"  # auto-approve + run, blocks until IDLE (ASKING auto-confirmed)
  5. subagent-cli approve --session <id>         # approve tool use, done returns output
     subagent-cli approve --session <id> "text"  # type selection/message, then approve
     subagent-cli reject --session <id> "reason" # reject with instruction (Escape + text)
     subagent-cli allow --session <id>           # approve + don't ask again for similar ops
  6. subagent-cli output --session <id> --type last  # get last reply (TUI chrome stripped)
  7. subagent-cli exit --session <id>            # graceful exit (captures resume_id)
     subagent-cli close --session <id>           # stop session (history kept, resume_id captured)

Important: Always run "check" before prompt/approve/reject/allow.
  Internal state may drift from actual terminal state. "check" reads
  the live screen and returns the authoritative state. Use --force
  if you need to send a key regardless of state.

Wait for state:
  subagent-cli check --session <id> --wait IDLE              # poll until IDLE
  subagent-cli check --session <id> --wait IDLE --output last # poll + return output
  (--wait returns 409 APPROVAL_NEEDED immediately if session enters ASKING)

All commands output JSON wrapped in delimiters:
  =====SUBAGENT_JSON=====
  { "success": bool, "code": number, "data": { ... } }
  =====SUBAGENT_JSON=====

Session recovery:
  subagent-cli sessions --cwd .                  # find sessions by working directory
  subagent-cli sessions --status CLOSED          # list closed sessions
  subagent-cli open --session <id>               # reconnect to existing session

Cleanup:
  subagent-cli delete --session <id>             # permanently delete session and history
  subagent-cli delete --closed                   # delete all closed sessions
  subagent-cli delete --all                      # close active + delete all
  subagent-cli close                             # close all sessions (keep history)

Daemon (single instance globally):
  subagent-cli daemon status                     # { running, port, pid }
  subagent-cli daemon start                      # fork on config.port (no-op if alive)
  subagent-cli daemon start --port 7200          # fork on 7200; refused if a live daemon exists
  subagent-cli daemon stop                       # graceful HTTP shutdown

Config: ~/.subagent-cli/config.json  (override with -c)
Home:   ~/.subagent-cli/             (override with config.home field)
Debug:  http://localhost:<port>/viewer
`)

// Write JSON to stdout with delimiters and wait for flush before returning
const JSON_DELIM = '=====SUBAGENT_JSON====='

function output(data: unknown): Promise<void> {
  return new Promise(resolve => {
    const payload = `${JSON_DELIM}\n${JSON.stringify(data)}\n${JSON_DELIM}\n`
    process.stdout.write(payload, () => resolve())
  })
}

// ──────────────── Commands ────────────────

program
  .command('subagents')
  .description('List available subagents')
  .action(async () => {
    const c = await SubagentClient.getInstance()
    await output(await c.getSubagents())
  })

program
  .command('sessions')
  .description('List sessions (active + closed)')
  .option('--cwd <dir>', 'Filter by working directory')
  .option('--status <state>', 'Filter by state (e.g. IDLE, RUNNING, ASKING, CLOSED)')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.getSessions(opts.cwd ? path.resolve(opts.cwd) : undefined, opts.status))
  })

program
  .command('open [text]')
  .description('Open a new session or reconnect. Optional [text] sends a prompt after open')
  .option('-s, --subagent <name>', 'Subagent to use')
  .option('--cwd <dir>', 'Working directory (default: current dir)')
  .option('--session <id>', 'Session ID to reconnect or pre-assign')
  .option('--role <text>', 'Role description (overrides config role, used as session title). Describe identity only — avoid imperative verbs like "analyze" or "audit" to prevent the sub-agent from starting work before the task is sent.')
  .option('--reuse', 'Reuse most-recent idle/closed session with same cwd+subagent (use --no-reuse to opt out when fast_reuse=true)')
  .option('--auto', 'Enable auto-approve before sending [text]: ASKING gets auto-confirmed, wait runs through to IDLE')
  .option('--timeout <seconds>', 'Startup timeout in seconds (overrides config)')
  .action(async (text, opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.open({
      subagent: opts.subagent,
      cwd: path.resolve(opts.cwd ?? process.cwd()),
      session: opts.session,
      role: opts.role,
      prompt: text,
      reuse: opts.reuse,
      auto: opts.auto,
      timeout: opts.timeout ? Number(opts.timeout) : undefined,
    }))
  })

program
  .command('prompt <text>')
  .description('Send a prompt (blocks until done or approval needed). Done includes extracted output')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .option('--auto', 'Enable auto-approve before sending: ASKING gets auto-confirmed, wait runs through to IDLE')
  .action(async (text, opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.prompt(opts.session, text, Number(opts.timeout), opts.auto))
  })

program
  .command('approve [text]')
  .description('Approve pending tool use (Enter). Optional [text] for amend (claude-code only)')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .option('-f, --force', 'Skip state check, send key regardless of internal state')
  .action(async (text, opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.approve(opts.session, text, Number(opts.timeout), opts.force))
  })

program
  .command('reject [text]')
  .description('Reject pending tool use (Escape), or type a reason/instruction first')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .option('-f, --force', 'Skip state check, send key regardless of internal state')
  .action(async (text, opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.reject(opts.session, text, Number(opts.timeout), opts.force))
  })

program
  .command('allow')
  .description('Approve via option 2. Scope depends on target CLI')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .option('-f, --force', 'Skip state check, send key regardless of internal state')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.allow(opts.session, Number(opts.timeout), opts.force))
  })

program
  .command('auto')
  .description('Toggle auto-approve: all subsequent approvals confirmed automatically')
  .requiredOption('--session <id>', 'Session ID')
  .option('--off', 'Disable auto-approve')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.auto(opts.session, !opts.off))
  })

program
  .command('status')
  .description('Get session status')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.status(opts.session))
  })

program
  .command('check')
  .description('Get screen-calibrated session state (authoritative). Use --wait to poll until target state')
  .requiredOption('--session <id>', 'Session ID')
  .option('--wait <state>', 'Poll until session reaches this state (e.g. IDLE, ASKING)')
  .option('--timeout <seconds>', 'Timeout for --wait polling (0 = no timeout)', '0')
  .option('--output <type>', 'Include output when target state reached (screen|history|last)')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.check(opts.session, opts.wait, Number(opts.timeout), opts.output))
  })

program
  .command('output')
  .description('Get session output (screen, history, or last extracted reply)')
  .requiredOption('--session <id>', 'Session ID')
  .option('--type <type>', 'Output type: screen | history | last', 'screen')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.output(opts.session, opts.type))
  })

program
  .command('cancel')
  .description('Cancel a running task')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.cancel(opts.session))
  })

program
  .command('exit')
  .description('Gracefully exit the sub-agent process')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    await output(await c.exit(opts.session))
  })

program
  .command('close')
  .description('Close session(s), keep history')
  .option('--session <id>', 'Session ID (omit to close all)')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    if (opts.session) {
      await output(await c.close(opts.session))
    } else {
      await output(await c.closeAll())
    }
  })

program
  .command('delete')
  .description('Permanently delete session and history')
  .option('--session <id>', 'Session ID')
  .option('--closed', 'Delete all closed sessions')
  .option('--all', 'Close active sessions and delete all')
  .action(async (opts) => {
    const c = await SubagentClient.getInstance()
    if (opts.all) {
      await output(await c.deleteAll())
    } else if (opts.closed) {
      await output(await c.deleteClosed())
    } else if (opts.session) {
      await output(await c.delete(opts.session))
    } else {
      await output({ success: false, data: { error: 'INVALID_STATE', message: 'Specify --session <id>, --closed, or --all' } })
    }
  })

program
  .command('daemon <action>')
  .description('Manage the App daemon: start | stop | status')
  .option('--port <port>', 'Override daemon port (default: config.json port)')
  .action(async (action, opts) => {
    if (action === 'start') {
      const c = await SubagentClient.getInstance({ port: opts.port ? Number(opts.port) : undefined })
      await output(c.startResult())
      return
    }
    if (action === 'status') {
      await output(await SubagentClient.status())
      return
    }
    if (action === 'stop') {
      await output(await new SubagentClient().stop())
      return
    }
    await output({ success: false, code: 400, data: { error: 'INVALID_STATE', message: `Unknown daemon action: ${action} (use start|stop|status)` } })
  })

program.parseAsync()
  .then(() => process.exit(0))
  .catch(async (err) => {
    await output({ success: false, data: { error: 'CLI_ERROR', message: err?.message ?? String(err) } })
    process.exit(1)
  })
