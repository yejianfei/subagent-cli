#!/usr/bin/env node
import { program } from 'commander'
import { setConfigPath } from './config'
import { SubagentClient } from './client'

declare const __VERSION__: string

program
  .name('subagent-cli')
  .version(__VERSION__)
  .description('Delegate tasks to sub-agent CLI instances (Claude Code, Codex, etc.)')
  .option('-c, --config <path>', 'Config file path (default: ~/.subagent-cli/config.json)')
  .hook('preAction', () => {
    const opts = program.opts<{ config?: string }>()
    if (opts.config) setConfigPath(opts.config)
  })
  .addHelpText('after', `
Workflow:
  1. subagent-cli subagents                      # list available subagents
  2. subagent-cli open -s haiku --cwd .            # start session, returns session ID
  3. subagent-cli prompt --session <id> "task"   # send task, done returns output field
  4. subagent-cli approve --session <id>         # approve tool use, done returns output
     subagent-cli approve --session <id> "text"  # type selection/message, then approve
     subagent-cli reject --session <id> "reason" # reject with instruction (Escape + text)
     subagent-cli allow --session <id>           # allow all for this session (Shift+Tab)
  5. subagent-cli output --session <id> --type last  # get last reply (TUI chrome stripped)
  6. subagent-cli close --session <id>           # stop session (history kept)

All commands output JSON wrapped in delimiters:
  =====SUBAGENT_JSON=====
  { "success": bool, "code": number, "data": { ... } }
  =====SUBAGENT_JSON=====

Session recovery:
  subagent-cli sessions --cwd .                  # find sessions by working directory
  subagent-cli open --session <id>               # reconnect to existing session

Cleanup:
  subagent-cli delete --session <id>             # permanently delete session and history
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
  .action(async (opts) => {
    await output(await client().getSessions(opts.cwd))
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
  .description('Approve pending tool use (Enter). Done includes extracted output. Optional [text] for amend (claude-code only)')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .action(async (text, opts) => {
    await output(await client().approve(opts.session, text, Number(opts.timeout)))
  })

program
  .command('reject [text]')
  .description('Reject pending tool use (Escape), or type a reason/instruction first')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .action(async (text, opts) => {
    await output(await client().reject(opts.session, text, Number(opts.timeout)))
  })

program
  .command('allow')
  .description('Allow all tool use for this session (shift+tab)')
  .requiredOption('--session <id>', 'Session ID')
  .option('--timeout <seconds>', 'Task timeout in seconds (0 = no timeout)', '0')
  .action(async (opts) => {
    await output(await client().allow(opts.session, Number(opts.timeout)))
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
  .description('Get screen-calibrated session state (authoritative). Note: may briefly return RUNNING for 1-3s after task completion due to terminal refresh delay — retry if needed')
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    await output(await client().check(opts.session))
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
  .requiredOption('--session <id>', 'Session ID')
  .action(async (opts) => {
    await output(await client().delete(opts.session))
  })

program.parseAsync()
  .then(() => process.exit(0))
  .catch(async (err) => {
    await output({ success: false, data: { error: 'CLI_ERROR', message: err?.message ?? String(err) } })
    process.exit(1)
  })
