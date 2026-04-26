import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

export interface SubagentConfig {
  adapter: string
  description: string
  command: string
  args: string[]
  env: Record<string, string>
  role?: string
}

export interface AppConfig {
  home?: string   // override home dir, default = ~/.subagent-cli
  port: number
  idle: { timeout: number; check_interval: number; manager_timeout?: number }
  terminal: { cols: number; rows: number; scrollback: number }
  subagents: Record<string, SubagentConfig>
}

// Mutable runtime state (grouped in a single const object)
const paths = {
  home: join(homedir(), '.subagent-cli'),
  config: join(homedir(), '.subagent-cli', 'config.json'),
}

/** Override config file path. Called by CLI -c/--config before any loadConfig(). */
export function setConfigPath(filePath: string): void {
  paths.config = resolve(filePath)
}

const DEFAULTS: Omit<AppConfig, 'home'> = {
  port: 7100,
  idle: { timeout: 300, check_interval: 30, manager_timeout: 120 },
  terminal: { cols: 220, rows: 50, scrollback: 5000 },
  subagents: {
    haiku: {
      adapter: 'claude-code',
      description: 'Claude Haiku',
      role: 'You are a helpful assistant.',
      command: 'claude',
      args: [],
      env: {
        ANTHROPIC_MODEL: 'haiku',
      },
    },
    codex: {
      adapter: 'codex',
      description: 'OpenAI Codex CLI (GPT-5.4)',
      role: 'You are a helpful assistant.',
      command: 'codex',
      args: ['--ask-for-approval', 'untrusted', '-m', 'gpt-5.4'],
      env: {},
    },
  },
}

/** Resolve ${VAR} references in string values */
function resolveEnvVars(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, val]) => [key, val.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')])
  )
}

const cache: { config: AppConfig | null } = { config: null }

export function loadConfig(): AppConfig {
  if (cache.config) return cache.config

  // Auto-create default config if missing
  if (!existsSync(paths.config)) {
    mkdirSync(paths.home, { recursive: true })
    const sample = { ...DEFAULTS }
    writeFileSync(paths.config, JSON.stringify(sample, null, 2) + '\n')
    console.error(`Created default config: ${paths.config}`)
    console.error('Please add subagent configurations to this file.')
  }

  const raw = JSON.parse(readFileSync(paths.config, 'utf-8'))
  const config: AppConfig = { ...DEFAULTS, ...raw }

  // Apply config.home override (higher priority than default)
  if (config.home) {
    paths.home = join(config.home)
  }

  // Resolve ${VAR} in all subagent env blocks
  Object.values(config.subagents).forEach(sub => {
    sub.env = resolveEnvVars(sub.env ?? {})
    sub.args = sub.args ?? []
  })

  cache.config = config
  return config
}

/** The program home directory (~/.subagent-cli by default) */
export function getHome(): string { return paths.home }

/** Ensure home/sessions/ exists */
export function ensureDirs(): void {
  mkdirSync(join(paths.home, 'sessions'), { recursive: true })
}
