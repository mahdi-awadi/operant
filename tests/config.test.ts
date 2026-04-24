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
    expect(loaded).toEqual(config)
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

test('resolveAutopilotDefaults merges user overrides with built-in defaults', () => {
  const cfg: HubConfig = {
    webPort: 3000, defaultTrust: 'ask', defaultUploadDir: '.',
    telegramToken: '', telegramAllowFrom: [],
    autopilot: { vetoWindowMs: 1000 },
  }
  const resolved = resolveAutopilotDefaults(cfg)
  expect(resolved.vetoWindowMs).toBe(1000)
  expect(resolved.btwTimeoutMs).toBe(30_000)
  expect(resolved.riskKeywords.length).toBeGreaterThan(5)
})
