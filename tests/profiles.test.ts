import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { loadProfiles, saveProfiles, getProfile, BUILTIN_PROFILES, DEFAULT_CHANNEL_INSTRUCTIONS, applyProfile, resolveSession, injectContext } from '../src/profiles'
import type { Profile } from '../src/types'

const TEST_DIR = join(import.meta.dir, '.test-profiles')

describe('profiles', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('loadProfiles returns builtins when file missing', () => {
    const profiles = loadProfiles(TEST_DIR)
    expect(profiles.length).toBeGreaterThan(0)
    expect(profiles.find(p => p.name === 'careful')).toBeDefined()
    expect(profiles.find(p => p.name === 'tdd')).toBeDefined()
    expect(profiles.find(p => p.name === 'docs')).toBeDefined()
    expect(profiles.find(p => p.name === 'yolo')).toBeDefined()
  })

  test('saveProfiles and loadProfiles roundtrip user profiles', () => {
    const userProfile: Profile = {
      name: 'my-project',
      description: 'Test',
      trust: 'ask',
      rules: ['no shortcuts'],
      facts: ['DB is dev'],
      prefix: '',
    }
    saveProfiles([userProfile], TEST_DIR)
    const loaded = loadProfiles(TEST_DIR)
    expect(loaded.find(p => p.name === 'my-project')).toEqual(userProfile)
    // Builtins should still be there
    expect(loaded.find(p => p.name === 'careful')).toBeDefined()
  })

  test('getProfile returns profile by name', () => {
    const profiles = loadProfiles(TEST_DIR)
    const careful = getProfile('careful', profiles)
    expect(careful?.name).toBe('careful')
    expect(careful?.trust).toBe('strict')
  })

  test('getProfile returns undefined for unknown name', () => {
    const profiles = loadProfiles(TEST_DIR)
    expect(getProfile('nonexistent', profiles)).toBeUndefined()
  })

  test('BUILTIN_PROFILES are readonly and complete', () => {
    expect(BUILTIN_PROFILES.find(p => p.name === 'careful')).toBeDefined()
    expect(BUILTIN_PROFILES.find(p => p.name === 'tdd')).toBeDefined()
    expect(BUILTIN_PROFILES.find(p => p.name === 'docs')).toBeDefined()
    expect(BUILTIN_PROFILES.find(p => p.name === 'yolo')).toBeDefined()
  })

  test('careful profile has strict trust', () => {
    const careful = getProfile('careful', BUILTIN_PROFILES as Profile[])
    expect(careful?.trust).toBe('strict')
    expect(careful?.rules.length).toBeGreaterThan(0)
  })

  test('yolo profile has yolo trust and no rules', () => {
    const yolo = getProfile('yolo', BUILTIN_PROFILES as Profile[])
    expect(yolo?.trust).toBe('yolo')
    expect(yolo?.rules).toEqual([])
  })

  test('saved user profile overrides builtin with same name', () => {
    const customCareful: Profile = {
      name: 'careful',
      description: 'My custom careful',
      trust: 'ask',
      rules: ['custom rule'],
      facts: [],
      prefix: '',
    }
    saveProfiles([customCareful], TEST_DIR)
    const loaded = loadProfiles(TEST_DIR)
    const careful = loaded.find(p => p.name === 'careful')
    expect(careful?.trust).toBe('ask')
    expect(careful?.rules).toEqual(['custom rule'])
  })

  test('applyProfile creates session config with profile fields', () => {
    const profiles = loadProfiles(TEST_DIR)
    const careful = getProfile('careful', profiles)!
    const result = applyProfile(careful)
    expect(result.trust).toBe('strict')
    expect(result.appliedProfile).toBe('careful')
    expect(result.profileOverrides).toEqual({})
  })

  test('resolveSession merges profile + overrides', () => {
    const profiles = loadProfiles(TEST_DIR)
    const session = {
      appliedProfile: 'careful',
      profileOverrides: {
        rules: ['Custom rule'],
      },
    }
    const effective = resolveSession(session, profiles)
    expect(effective.trust).toBe('strict') // from profile
    expect(effective.rules).toEqual(['Custom rule']) // from overrides
  })

  test('resolveSession returns overrides-only when profile deleted', () => {
    const session = {
      appliedProfile: 'deleted-profile',
      profileOverrides: {
        trust: 'ask' as const,
        rules: ['Fallback rule'],
        facts: [],
        prefix: '',
      },
    }
    const effective = resolveSession(session, [])
    expect(effective.trust).toBe('ask')
    expect(effective.rules).toEqual(['Fallback rule'])
  })

  test('resolveSession returns defaults when no profile and no overrides', () => {
    const effective = resolveSession({}, [])
    expect(effective.trust).toBe('ask')
    expect(effective.rules).toEqual([])
    expect(effective.facts).toEqual([])
    expect(effective.driftDetection).toBe(true)
    expect(effective.sidecarEnabled).toBe(false)
  })

  test('resolveSession profile facts pass through when no override', () => {
    const profiles: Profile[] = [{
      name: 'with-facts',
      trust: 'ask',
      rules: [],
      facts: ['fact one', 'fact two'],
      prefix: '',
    }]
    const session = { appliedProfile: 'with-facts' }
    const effective = resolveSession(session, profiles)
    expect(effective.facts).toEqual(['fact one', 'fact two'])
  })

  describe('injectContext', () => {
    test('prepends channel instructions for telegram', () => {
      const effective = resolveSession({}, [])
      effective.rules = []
      effective.facts = []
      const result = injectContext('fix the bug', 'telegram', effective)
      expect(result).toContain('[Channel:')
      expect(result).toContain('Telegram')
      expect(result).toContain('fix the bug')
    })

    test('includes rules when present', () => {
      const effective = resolveSession(
        { profileOverrides: { rules: ['no shortcuts', 'TDD always'], facts: [] } },
        [],
      )
      const result = injectContext('hello', 'web', effective)
      expect(result).toContain('[Session Rules:')
      expect(result).toContain('no shortcuts')
      expect(result).toContain('TDD always')
    })

    test('includes facts when present', () => {
      const effective = resolveSession(
        { profileOverrides: { rules: [], facts: ['DB is dev', 'Bob owns auth'] } },
        [],
      )
      const result = injectContext('hello', 'web', effective)
      expect(result).toContain('[Facts:')
      expect(result).toContain('DB is dev')
      expect(result).toContain('Bob owns auth')
    })

    test('skips empty rules/facts blocks', () => {
      const effective = resolveSession({}, [])
      const result = injectContext('hello', 'cli', effective)
      expect(result).not.toContain('[Session Rules:')
      expect(result).not.toContain('[Facts:')
      expect(result).toContain('hello')
    })

    test('uses profile override for channel instructions', () => {
      const effective = resolveSession(
        { profileOverrides: { channelOverrides: { telegram: 'Custom telegram instructions' } } },
        [],
      )
      const result = injectContext('hello', 'telegram', effective)
      expect(result).toContain('Custom telegram instructions')
      expect(result).not.toContain('You are replying on Telegram mobile')
    })

    test('default channel instructions only include supported frontends', () => {
      expect(Object.keys(DEFAULT_CHANNEL_INSTRUCTIONS).sort()).toEqual(['cli', 'telegram', 'web'])
    })
  })
})
