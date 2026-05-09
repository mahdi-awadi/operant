// tests/rubika-invites.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RubikaInviteStore } from '../src/rubika-invites'

function makeStore(opts: { now?: () => number; dir?: string } = {}): { store: RubikaInviteStore; dir: string } {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'invite-store-'))
  const store = new RubikaInviteStore({ dir, now: opts.now })
  return { store, dir }
}

describe('RubikaInviteStore.mintInvite', () => {
  test('returns a 6-char alphanumeric code', () => {
    const { store, dir } = makeStore()
    try {
      const code = store.mintInvite('mhmd')
      expect(code).toMatch(/^[A-Z0-9]{6}$/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('returned codes are unique across many mints', () => {
    const { store, dir } = makeStore()
    try {
      const codes = new Set<string>()
      for (let i = 0; i < 50; i++) codes.add(store.mintInvite('mhmd'))
      expect(codes.size).toBe(50)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('persists to invites.json', () => {
    const { store, dir } = makeStore()
    try {
      const code = store.mintInvite('mhmd')
      const path = join(dir, 'rubika-invites.json')
      expect(existsSync(path)).toBe(true)
      const json = JSON.parse(readFileSync(path, 'utf8'))
      expect(json.pendingInvites[code]).toMatchObject({ sessionName: 'mhmd' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('default TTL is 24 hours from now', () => {
    const fixedNow = 1_700_000_000_000
    const { store, dir } = makeStore({ now: () => fixedNow })
    try {
      const code = store.mintInvite('mhmd')
      const inv = store.peekInvite(code)
      expect(inv).not.toBeNull()
      expect(inv!.expiresAt).toBe(fixedNow + 24 * 60 * 60 * 1000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('RubikaInviteStore.claim', () => {
  test('valid code pins the sender to the session and returns the session name', () => {
    const { store, dir } = makeStore()
    try {
      const code = store.mintInvite('mhmd')
      const sessionName = store.claim(code, 'guest-9')
      expect(sessionName).toBe('mhmd')
      expect(store.getPin('guest-9')).toBe('mhmd')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('claim consumes the invite — second claim returns null', () => {
    const { store, dir } = makeStore()
    try {
      const code = store.mintInvite('mhmd')
      expect(store.claim(code, 'guest-9')).toBe('mhmd')
      expect(store.claim(code, 'guest-10')).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('expired invite returns null and is not pinned', () => {
    let fakeNow = 1_700_000_000_000
    const { store, dir } = makeStore({ now: () => fakeNow })
    try {
      const code = store.mintInvite('mhmd')
      fakeNow += 25 * 60 * 60 * 1000   // 25h later
      expect(store.claim(code, 'guest-9')).toBeNull()
      expect(store.getPin('guest-9')).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('unknown code returns null', () => {
    const { store, dir } = makeStore()
    try {
      expect(store.claim('NOTACODE', 'guest-9')).toBeNull()
      expect(store.getPin('guest-9')).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('claim is case-insensitive (codes uppercased on input)', () => {
    const { store, dir } = makeStore()
    try {
      const code = store.mintInvite('mhmd')
      expect(store.claim(code.toLowerCase(), 'guest-9')).toBe('mhmd')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('persists the new pin to disk', () => {
    const { store, dir } = makeStore()
    try {
      const code = store.mintInvite('mhmd')
      store.claim(code, 'guest-9')
      const path = join(dir, 'rubika-invites.json')
      const json = JSON.parse(readFileSync(path, 'utf8'))
      expect(json.pins['guest-9']).toMatchObject({ sessionName: 'mhmd' })
      // Invite removed after claim.
      expect(json.pendingInvites[code]).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('RubikaInviteStore.unpin', () => {
  test('removes the pin and returns true', () => {
    const { store, dir } = makeStore()
    try {
      const code = store.mintInvite('mhmd')
      store.claim(code, 'guest-9')
      expect(store.unpin('guest-9')).toBe(true)
      expect(store.getPin('guest-9')).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('unpinning a non-pinned sender returns false', () => {
    const { store, dir } = makeStore()
    try {
      expect(store.unpin('nope')).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('RubikaInviteStore persistence', () => {
  test('reloads pins and pending invites from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invite-reload-'))
    try {
      const store1 = new RubikaInviteStore({ dir })
      const code = store1.mintInvite('mhmd')
      store1.mintInvite('other')
      // Simulate restart
      const store2 = new RubikaInviteStore({ dir })
      expect(store2.peekInvite(code)).not.toBeNull()
      expect(store2.peekInvite(code)!.sessionName).toBe('mhmd')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('reloads claimed pins after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invite-reload-pin-'))
    try {
      const s1 = new RubikaInviteStore({ dir })
      const code = s1.mintInvite('mhmd')
      s1.claim(code, 'guest-9')
      const s2 = new RubikaInviteStore({ dir })
      expect(s2.getPin('guest-9')).toBe('mhmd')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('handles missing storage file (fresh install) without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invite-fresh-'))
    try {
      // Don't create any file — constructor should treat it as empty store.
      const store = new RubikaInviteStore({ dir })
      expect(store.getPin('anybody')).toBeNull()
      expect(store.listPins()).toEqual({})
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('handles malformed json without throwing — treats as empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invite-bad-'))
    try {
      writeFileSync(join(dir, 'rubika-invites.json'), 'not json {{{')
      const store = new RubikaInviteStore({ dir })
      expect(store.listPins()).toEqual({})
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('RubikaInviteStore.listPendingInvites', () => {
  test('returns active invites with their session and expiry', () => {
    const fixedNow = 1_700_000_000_000
    const { store, dir } = makeStore({ now: () => fixedNow })
    try {
      const c1 = store.mintInvite('mhmd')
      const c2 = store.mintInvite('other')
      const list = store.listPendingInvites()
      expect(list.length).toBe(2)
      const codes = list.map(i => i.code).sort()
      expect(codes).toEqual([c1, c2].sort())
      expect(list.every(i => i.expiresAt === fixedNow + 24 * 60 * 60 * 1000)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('omits expired invites', () => {
    let fakeNow = 1_700_000_000_000
    const { store, dir } = makeStore({ now: () => fakeNow })
    try {
      store.mintInvite('mhmd')
      fakeNow += 25 * 60 * 60 * 1000
      expect(store.listPendingInvites()).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('RubikaInviteStore.listPins', () => {
  test('returns all active pins keyed by sender id', () => {
    const { store, dir } = makeStore()
    try {
      const c1 = store.mintInvite('mhmd')
      const c2 = store.mintInvite('other')
      store.claim(c1, 'g1')
      store.claim(c2, 'g2')
      expect(store.listPins()).toEqual({ g1: 'mhmd', g2: 'other' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
