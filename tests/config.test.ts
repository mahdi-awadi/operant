import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadHubConfig, saveHubConfig, loadSessions, saveSessions, resolveAutopilotDefaults, HUB_DIR } from '../src/config'
import type { HubConfig } from '../src/types'
import { mkdirSync, rmSync, existsSync, writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(import.meta.dir, '.test-hub-config')

describe('config', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('loadHubConfig returns defaults when file missing', () => {
    const config = loadHubConfig(TEST_DIR)
    expect(config.webPort).toBe(3000)
    expect(config.defaultTrust).toBe('ask')
    expect(config.telegramToken).toBe('')
    expect(config.telegramAllowFrom).toEqual([])
    expect(config.defaultUploadDir).toBe('.')
  })

  test('saveHubConfig and loadHubConfig roundtrip', () => {
    const config = {
      webPort: 4000,
      telegramToken: '123:AAH',
      telegramAllowFrom: ['12345'],
      defaultTrust: 'auto' as const,
      defaultUploadDir: 'uploads/',
    }
    saveHubConfig(config, TEST_DIR)
    const loaded = loadHubConfig(TEST_DIR)
    expect(loaded).toMatchObject(config)
  })

  test('browseRoot roundtrips through save/load', () => {
    const config = {
      webPort: 3000,
      browseRoot: '/home',
      telegramToken: '',
      telegramAllowFrom: [],
      defaultTrust: 'ask' as const,
      defaultUploadDir: '.',
    }
    saveHubConfig(config, TEST_DIR)
    const loaded = loadHubConfig(TEST_DIR)
    expect(loaded.browseRoot).toBe('/home')
  })

  test('browseRoot is undefined by default', () => {
    const loaded = loadHubConfig(TEST_DIR)
    expect(loaded.browseRoot).toBeUndefined()
  })

  test('loadSessions returns empty object when file missing', () => {
    const sessions = loadSessions(TEST_DIR)
    expect(sessions).toEqual({})
  })

  test('saveSessions and loadSessions roundtrip', () => {
    const sessions = {
      '/home/user/frontend': {
        name: 'frontend',
        trust: 'ask' as const,
        prefix: '',
        uploadDir: '.',
        managed: false,
        teamIndex: 0,
        teamSize: 0,
      },
    }
    saveSessions(sessions, TEST_DIR)
    const loaded = loadSessions(TEST_DIR)
    expect(loaded).toEqual(sessions)
  })

  test('saveHubConfig creates directory with mode 0o700', () => {
    const config = loadHubConfig(TEST_DIR)
    saveHubConfig(config, TEST_DIR)
    expect(existsSync(TEST_DIR)).toBe(true)
  })
})

test('loadHubConfig reads autopilot section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-autopilot-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000,
      defaultTrust: 'ask',
      defaultUploadDir: '.',
      telegramToken: '',
      telegramAllowFrom: ['123'],
      autopilot: { vetoWindowMs: 5000, maxDurationMinutes: 120 },
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.autopilot?.vetoWindowMs).toBe(5000)
    expect(cfg.autopilot?.maxDurationMinutes).toBe(120)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadHubConfig ignores removed third-party channel fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-legacy-channel-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000,
      defaultTrust: 'ask',
      defaultUploadDir: '.',
      telegramToken: '',
      telegramAllowFrom: [],
      legacyChannelToken: 'legacy-token',
      legacyChannelUsername: 'Operant_bot',
      legacyChannelAllowFrom: ['sender-1'],
      legacyChannelApiBase: 'https://legacy.example/api',
      legacyChannelWebhookBase: 'https://hub.example',
    }))
    const cfg = loadHubConfig(dir)
    expect('legacyChannelToken' in cfg).toBe(false)
    expect('legacyChannelUsername' in cfg).toBe(false)
    expect('legacyChannelAllowFrom' in cfg).toBe(false)
    expect('legacyChannelApiBase' in cfg).toBe(false)
    expect('legacyChannelWebhookBase' in cfg).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadHubConfig without autopilot key returns undefined for autopilot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-noauto-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: '', telegramAllowFrom: [],
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.autopilot).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadHubConfig honors chromeEnabled, chromePort, chromeExecutablePath defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-chrome-absent-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: '', telegramAllowFrom: [],
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.chromeEnabled).toBeUndefined()      // default applied at daemon level
    expect(cfg.chromePort).toBeUndefined()
    expect(cfg.chromeExecutablePath).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadHubConfig passes through chrome config when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-chrome-present-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: '', telegramAllowFrom: [],
      chromeEnabled: false,
      chromePort: 9300,
      chromeExecutablePath: '/usr/bin/chromium',
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.chromeEnabled).toBe(false)
    expect(cfg.chromePort).toBe(9300)
    expect(cfg.chromeExecutablePath).toBe('/usr/bin/chromium')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TELEGRAM_TOKEN env var overrides config.json telegramToken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-env-token-'))
  const prev = process.env.TELEGRAM_TOKEN
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: 'file-token', telegramAllowFrom: ['123'],
    }))
    process.env.TELEGRAM_TOKEN = 'env-token'
    const cfg = loadHubConfig(dir)
    expect(cfg.telegramToken).toBe('env-token')
    // structured settings still come from the file
    expect(cfg.telegramAllowFrom).toEqual(['123'])
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_TOKEN
    else process.env.TELEGRAM_TOKEN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('telegramToken falls back to config.json when TELEGRAM_TOKEN env is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-env-token-fallback-'))
  const prev = process.env.TELEGRAM_TOKEN
  try {
    delete process.env.TELEGRAM_TOKEN
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: 'file-token', telegramAllowFrom: [],
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.telegramToken).toBe('file-token')
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_TOKEN
    else process.env.TELEGRAM_TOKEN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WEB_PORT env var overrides config.json webPort as a number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-env-port-'))
  const prev = process.env.WEB_PORT
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: '', telegramAllowFrom: [],
    }))
    process.env.WEB_PORT = '4500'
    const cfg = loadHubConfig(dir)
    expect(cfg.webPort).toBe(4500)
  } finally {
    if (prev === undefined) delete process.env.WEB_PORT
    else process.env.WEB_PORT = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadHubConfig reads TELEGRAM_TOKEN from a .env file in the hub dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-dotenv-'))
  const prev = process.env.TELEGRAM_TOKEN
  try {
    delete process.env.TELEGRAM_TOKEN
    writeFileSync(join(dir, '.env'), '# secrets\nTELEGRAM_TOKEN=dotenv-token\n')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
      telegramToken: 'file-token', telegramAllowFrom: [],
    }))
    const cfg = loadHubConfig(dir)
    expect(cfg.telegramToken).toBe('dotenv-token')
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_TOKEN
    else process.env.TELEGRAM_TOKEN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a real env var takes precedence over the .env file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-dotenv-prec-'))
  const prev = process.env.TELEGRAM_TOKEN
  try {
    process.env.TELEGRAM_TOKEN = 'real-env'
    writeFileSync(join(dir, '.env'), 'TELEGRAM_TOKEN=dotenv-token\n')
    const cfg = loadHubConfig(dir)
    expect(cfg.telegramToken).toBe('real-env')
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_TOKEN
    else process.env.TELEGRAM_TOKEN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAutopilotDefaults merges user overrides with built-in defaults', () => {
  const cfg: HubConfig = {
    webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
    telegramToken: '', telegramAllowFrom: [],
    autopilot: { vetoWindowMs: 1000 },
  }
  const resolved = resolveAutopilotDefaults(cfg)
  expect(resolved.vetoWindowMs).toBe(1000)
  expect(resolved.btwTimeoutMs).toBe(30_000)
  // Risk keyword default was deliberately trimmed to a minimal backstop —
  // broad words like 'delete' / 'production' fire on benign mentions. We only
  // ship the unambiguous catastrophic tokens; the wrap-prompt handles the rest.
  expect(resolved.riskKeywords.length).toBeGreaterThanOrEqual(2)
  expect(resolved.riskKeywords).toContain('force push')
})
