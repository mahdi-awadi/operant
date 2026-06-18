import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { DEFAULT_AUTOPILOT_DEFAULTS } from './types'
import type { OperantConfig, SessionConfig, TrustLevel, AutopilotDefaults } from './types'

export const OPERANT_DIR = process.env.CLAUDE_PLUGIN_DATA
  ?? process.env.OPERANT_DIR
  ?? join(homedir(), '.claude', 'channels', 'operant')

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(path: string, data: unknown): void {
  const dir = join(path, '..')
  ensureDir(dir)
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

// Load `<dir>/.env` into process.env. Existing env vars win (we only fill
// the gaps), so a real environment value always takes precedence over the
// file. Loaded by the daemon itself rather than systemd EnvironmentFile,
// which SELinux blocks PID 1 from reading under $HOME.
export function loadDotEnv(dir: string = OPERANT_DIR): void {
  let text: string
  try {
    text = readFileSync(join(dir, '.env'), 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key && !(key in process.env)) process.env[key] = val
  }
}

export function loadOperantConfig(dir: string = OPERANT_DIR): OperantConfig {
  // Precedence: environment (incl. <dir>/.env) > config.json > default.
  // Secrets (TELEGRAM_TOKEN) and host/port live in the environment; structured
  // settings (telegramAllowFrom, autopilot) stay in config.json.
  loadDotEnv(dir)
  const raw = readJson<Partial<OperantConfig>>(join(dir, 'config.json')) ?? {}
  const envPort = process.env.WEB_PORT
  const webPort = envPort && !Number.isNaN(Number(envPort)) ? Number(envPort) : (raw.webPort ?? 3000)
  return {
    webPort,
    webHost: process.env.WEB_HOST || raw.webHost,
    browseRoot: process.env.BROWSE_ROOT || raw.browseRoot,
    telegramToken: process.env.TELEGRAM_TOKEN || raw.telegramToken || '',
    telegramBotUsername: raw.telegramBotUsername,
    telegramAllowFrom: raw.telegramAllowFrom ?? [],
    defaultTrust: raw.defaultTrust ?? 'ask',
    defaultUploadDir: raw.defaultUploadDir ?? '.',
    autopilot: raw.autopilot,   // pass through as-is
    chromeEnabled: raw.chromeEnabled,
    chromePort: raw.chromePort,
    chromeExecutablePath: raw.chromeExecutablePath,
  }
}

export function resolveAutopilotDefaults(config: OperantConfig): AutopilotDefaults {
  const override = config.autopilot ?? {}
  return {
    vetoWindowMs: override.vetoWindowMs ?? DEFAULT_AUTOPILOT_DEFAULTS.vetoWindowMs,
    btwTimeoutMs: override.btwTimeoutMs ?? DEFAULT_AUTOPILOT_DEFAULTS.btwTimeoutMs,
    maxDurationMinutes: override.maxDurationMinutes ?? DEFAULT_AUTOPILOT_DEFAULTS.maxDurationMinutes,
    riskKeywords: override.riskKeywords ? [...override.riskKeywords] : [...DEFAULT_AUTOPILOT_DEFAULTS.riskKeywords],
  }
}

export function saveOperantConfig(config: OperantConfig, dir: string = OPERANT_DIR): void {
  writeJson(join(dir, 'config.json'), config)
}

export function loadSessions(dir: string = OPERANT_DIR): Record<string, SessionConfig> {
  return readJson<Record<string, SessionConfig>>(join(dir, 'sessions.json')) ?? {}
}

export function saveSessions(sessions: Record<string, SessionConfig>, dir: string = OPERANT_DIR): void {
  writeJson(join(dir, 'sessions.json'), sessions)
}

import { loadProfiles as loadProfilesFromModule, saveProfiles as saveProfilesFromModule } from './profiles'
import type { Profile } from './types'

export function loadProfilesForOperant(): Profile[] {
  return loadProfilesFromModule(OPERANT_DIR)
}

export function saveProfilesForOperant(profiles: Profile[]): void {
  saveProfilesFromModule(profiles, OPERANT_DIR)
}
