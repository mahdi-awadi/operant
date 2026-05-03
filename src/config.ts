import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { DEFAULT_AUTOPILOT_DEFAULTS } from './types'
import type { HubConfig, SessionConfig, TrustLevel, AutopilotDefaults } from './types'

export const HUB_DIR = process.env.CLAUDE_PLUGIN_DATA
  ?? process.env.HUB_DIR
  ?? join(homedir(), '.claude', 'channels', 'hub')

function defaultConfig(): HubConfig {
  return {
    webPort: 3000,
    telegramToken: '',
    telegramAllowFrom: [],
    defaultTrust: 'ask',
    defaultUploadDir: '.',
  }
}

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

export function loadHubConfig(dir: string = HUB_DIR): HubConfig {
  const raw = readJson<Partial<HubConfig>>(join(dir, 'config.json'))
  if (!raw) return defaultConfig()
  return {
    webPort: raw.webPort ?? 3000,
    webHost: raw.webHost,
    browseRoot: raw.browseRoot,
    telegramToken: raw.telegramToken ?? '',
    telegramBotUsername: raw.telegramBotUsername,
    telegramAllowFrom: raw.telegramAllowFrom ?? [],
    rubikaToken: raw.rubikaToken,                     // empty / unset = bot disabled
    rubikaBotUsername: raw.rubikaBotUsername,         // cosmetic — logs + future @-prefix command parsing
    rubikaAllowFrom: raw.rubikaAllowFrom ?? [],       // empty = deny-all (matches Telegram)
    rubikaApiBase: raw.rubikaApiBase,                 // override; defaults to botapi.rubika.ir/v3
    rubikaWebhookBase: raw.rubikaWebhookBase,         // public origin where the daemon is reachable, e.g. "https://hub.tech-gate.online"
    rubikaPollingMs: raw.rubikaPollingMs,             // getUpdates polling interval; undefined = default 2000
    defaultTrust: raw.defaultTrust ?? 'ask',
    defaultUploadDir: raw.defaultUploadDir ?? '.',
    autopilot: raw.autopilot,   // pass through as-is
  }
}

export function resolveAutopilotDefaults(config: HubConfig): AutopilotDefaults {
  const override = config.autopilot ?? {}
  return {
    vetoWindowMs: override.vetoWindowMs ?? DEFAULT_AUTOPILOT_DEFAULTS.vetoWindowMs,
    btwTimeoutMs: override.btwTimeoutMs ?? DEFAULT_AUTOPILOT_DEFAULTS.btwTimeoutMs,
    maxDurationMinutes: override.maxDurationMinutes ?? DEFAULT_AUTOPILOT_DEFAULTS.maxDurationMinutes,
    riskKeywords: override.riskKeywords ? [...override.riskKeywords] : [...DEFAULT_AUTOPILOT_DEFAULTS.riskKeywords],
  }
}

export function saveHubConfig(config: HubConfig, dir: string = HUB_DIR): void {
  writeJson(join(dir, 'config.json'), config)
}

export function loadSessions(dir: string = HUB_DIR): Record<string, SessionConfig> {
  return readJson<Record<string, SessionConfig>>(join(dir, 'sessions.json')) ?? {}
}

export function saveSessions(sessions: Record<string, SessionConfig>, dir: string = HUB_DIR): void {
  writeJson(join(dir, 'sessions.json'), sessions)
}

import { loadProfiles as loadProfilesFromModule, saveProfiles as saveProfilesFromModule } from './profiles'
import type { Profile } from './types'

export function loadProfilesForHub(): Profile[] {
  return loadProfilesFromModule(HUB_DIR)
}

export function saveProfilesForHub(profiles: Profile[]): void {
  saveProfilesFromModule(profiles, HUB_DIR)
}
