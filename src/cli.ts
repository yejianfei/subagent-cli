#!/usr/bin/env node
import { program } from 'commander'
import { setConfigPath } from './config'
import { SubagentClient } from './client'

declare const __VERSION__: string

program
  .name('subagent-cli')
  .version(__VERSION__)
  .description('Let your AI agent drive other AI agents (Claude Code, Codex, etc.)')
  .option('-c, --config <path>', 'Config file path (default: ~/.subagent-cli/config.json)')
  .hook('preAction', () => {
    const opts = program.opts<{ config?: string }>()
    if (opts.config) setConfigPath(opts.config)
  })
  .addHelpText('after', `
Workflow:
  1. subagent-cli subagents                      # list available subagents
  2. subagent-cli open -s haiku --cwd .            # start session, returns session ID
  3. subagent-cli check --session <id>           # verify state before every command!
  4. subagent-cli prompt --session <id> "task"   # send task, done returns output field
  5. subagent-cli approve --session <id>         # approve tool use, done returns output
     subagent-cli approve --session <id> "text"  # type selection/message, then approve
     subagent-cli reject --session <id> "reason" # reject with instruction (Escape + text)
     subagent-cli allow --session <id>           # approve + don't ask again for similar ops
  6. subagent-cli output --session <id> --type last  # get last reply (TUI chrome stripped)
  7. subagent-cli close --session <id>           # stop session (history kept)

Important: Always run "check" before prompt/approve/reject/allow.
  Internal state may drift from actual terminal state. "check" reads
  the live screen and returns the authoritative state. Use --force
  if you need to send a key regardless of state.

Wait for state:
  subagent-cli check --session <id> --wait IDLE              # poll until IDLE
  subagent-cli check --session <id> --wait IDLE --output last # poll + return output

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

Config: ~/.subagent-cli/config.json  (override with -c)
Home:   ~/.subagent-cli/             (override with config.home field)
Debug:  http://localhost:<port>/viewer
`)

// Lazy client — created after -c hook runs
function client(): SubagentClient { return new SubagentClient() }

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
    await output(await client().getSubagents())
  })

program
  .command('sessions')
  .description('List sessions (active + closed)')
  .option('--cwd <dir>', 'Filter by working directory')
  .option('--status <state>', 'Filter by state (e.g. IDLE, RUNNING, ASKING, CLOSED)')
  .action(async (opts) => {
    await output(await client().getSessions(opts.cwd, opts.status))
  })

program
  .command('open')
  .description('Open a new session or reconnect to an existing one')
  .option('-s, --subagent <name>', 'Subagent to use')
  .option('--cwd <dir>', 'Working directory (default: current dir)')
  .option('--session <id>', 'Session ID to reconnect or pre-assign')
  .option('--timeout <seconds>', 'Startup timeout in seconds (overrides config)')
  .action(async (opts) => {
    await output(await client().open({
      subagent: opts.subagent,
      cwd: opts.cwd,
      session: opts.session,
      timeout: opts.timeout ? Number(opts.timeout) : undefined,
    }))
  })

program
  .command('prompt <text>')
  .description('Send a prompt (blocks until done or approval needed). Done includes extracted output')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .action(async (text, opts) => {
    await output(await client().prompt(opts.session, text, Number(opts.timeout)))
  })

program
  .command('approve [text]')
  .description('Approve pending tool use (Enter). Optional [text] for amend (claude-code only)')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .option('-f, --force', 'Skip state check, send key regardless of internal state')
  .action(async (text, opts) => {
    await output(await client().approve(opts.session, text, Number(opts.timeout), opts.force))
  })

program
  .command('reject [text]')
  .description('Reject pending tool use (Escape), or type a reason/instruction first')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .option('-f, --force', 'Skip state check, send key regardless of internal state')
  .action(async (text, opts) => {
    await output(await client().reject(opts.session, text, Number(opts.timeout), opts.force))
  })

program
  .command('allow')
  .description('Approve via option 2. Scope depends on target CLI')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .option('-f, --force', 'Skip state check, send key regardless of internal state')
  .action(async (opts) => {
    await output(await client().allow(opts.session, Number(opts.timeout), opts.force))
  })

program
  .command('auto')
  .description('Toggle auto-approve: all subsequent approvals confirmed automatically')
  .requiredOption('--session <id>', 'Session ID')
  .option('--off', 'Disable auto-approve')
  .action(async (opts) => {
    await output(await client().auto(opts.session, !opts.off))
  })

program
  .command('status')
  .description('Get session status')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    await output(await client().status(opts.session))
  })

program
  .command('check')
  .description('Get screen-calibrated session state (authoritative). Use --wait to poll until target state')
  .requiredOption('--session <id>', 'Session ID')
  .option('--wait <state>', 'Poll until session reaches this state (e.g. IDLE, ASKING)')
  .option('--timeout <seconds>', 'Timeout for --wait polling (0 = no timeout)', '0')
  .option('--output <type>', 'Include output when target state reached (screen|history|last)')
  .action(async (opts) => {
    await output(await client().check(opts.session, opts.wait, Number(opts.timeout), opts.output))
  })

program
  .command('output')
  .description('Get session output (screen, history, or last extracted reply)')
  .requiredOption('--session <id>', 'Session ID')
  .option('--type <type>', 'Output type: screen | history | last', 'screen')
  .action(async (opts) => {
    await output(await client().output(opts.session, opts.type))
  })

program
  .command('cancel')
  .description('Cancel a running task')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    await output(await client().cancel(opts.session))
  })

program
  .command('exit')
  .description('Gracefully exit the sub-agent process')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    await output(await client().exit(opts.session))
  })

program
  .command('close')
  .description('Close session(s), keep history')
  .option('--session <id>', 'Session ID (omit to close all)')
  .action(async (opts) => {
    if (opts.session) {
      await output(await client().close(opts.session))
    } else {
      await output(await client().closeAll())
    }
  })

program
  .command('delete')
  .description('Permanently delete session and history')
  .option('--session <id>', 'Session ID')
  .option('--closed', 'Delete all closed sessions')
  .option('--all', 'Close active sessions and delete all')
  .action(async (opts) => {
    if (opts.all) {
      await output(await client().deleteAll())
    } else if (opts.closed) {
      await output(await client().deleteClosed())
    } else if (opts.session) {
      await output(await client().delete(opts.session))
    } else {
      await output({ success: false, data: { error: 'INVALID_STATE', message: 'Specify --session <id>, --closed, or --all' } })
    }
  })

program.parseAsync()
  .then(() => process.exit(0))
  .catch(async (err) => {
    await output({ success: false, data: { error: 'CLI_ERROR', message: err?.message ?? String(err) } })
    process.exit(1)
  })
