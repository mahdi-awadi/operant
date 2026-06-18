// tests/personalities.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Personalities, BUILTIN_NAMES } from '../src/personalities'
import { openOperantDb } from '../src/operant-db'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { OperantDbHandle } from '../src/operant-db'

describe('Personalities', () => {
  let dir: string
  let handle: OperantDbHandle
  let p: Personalities

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'operant-personalities-test-'))
    handle = openOperantDb(dir)
    p = new Personalities(handle.db)
  })

  afterEach(() => {
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('seeds the 5 built-in personalities on construction', () => {
    const all = p.listAll()
    expect(all.length).toBeGreaterThanOrEqual(5)
    for (const name of BUILTIN_NAMES) {
      const found = all.find((x) => x.name === name)
      expect(found).toBeTruthy()
      expect(found?.builtin).toBe(true)
    }
  })

  test('re-instantiating does NOT duplicate builtins (upsert by name)', () => {
    new Personalities(handle.db)
    const all = p.listAll()
    expect(all.filter((x) => x.builtin).length).toBe(BUILTIN_NAMES.length)
  })

  test('create / get / update / delete a user personality', () => {
    const created = p.create({
      name: 'Test',
      description: 'a test one',
      systemPrompt: 'be brief',
      replyStyle: 'terse',
      riskTolerance: 'medium',
      defaultWhenUnclear: 'pick_first',
    })
    expect(created.id).toBeGreaterThan(0)
    expect(created.builtin).toBe(false)

    const fetched = p.getById(created.id)
    expect(fetched?.name).toBe('Test')

    p.update(created.id, { description: 'updated' })
    expect(p.getById(created.id)?.description).toBe('updated')

    p.deleteById(created.id)
    expect(p.getById(created.id)).toBeUndefined()
  })

  test('refuses to delete a built-in personality', () => {
    const builtin = p.getByName('Senior Engineer')
    expect(builtin).toBeTruthy()
    expect(() => p.deleteById(builtin!.id)).toThrow(/built-in/i)
  })

  test('refuses to overwrite the builtin flag via update', () => {
    const created = p.create({ name: 'Mine', systemPrompt: 'x' })
    expect(() => p.update(created.id, { builtin: true } as any)).toThrow(/builtin/i)
  })

  test('getByName is case-insensitive', () => {
    expect(p.getByName('senior engineer')?.name).toBe('Senior Engineer')
    expect(p.getByName('SENIOR ENGINEER')?.name).toBe('Senior Engineer')
  })

  test('assignToSession + getForSession round-trips', () => {
    const builtin = p.getByName('Pragmatist')!
    p.assignToSession('/p/foo:0', builtin.id)
    const got = p.getForSession('/p/foo:0')
    expect(got?.name).toBe('Pragmatist')
  })

  test('reassign overwrites prior assignment', () => {
    const a = p.getByName('Architect')!
    const r = p.getByName('Researcher')!
    p.assignToSession('/p/foo:0', a.id)
    p.assignToSession('/p/foo:0', r.id)
    expect(p.getForSession('/p/foo:0')?.name).toBe('Researcher')
  })

  test('removeFromSession returns the session to the default behaviour', () => {
    const a = p.getByName('Architect')!
    p.assignToSession('/p/foo:0', a.id)
    p.removeFromSession('/p/foo:0')
    expect(p.getForSession('/p/foo:0')).toBeUndefined()
  })

  test('deleting an assigned personality nulls the assignment (cascade)', () => {
    const created = p.create({ name: 'Custom', systemPrompt: 'x' })
    p.assignToSession('/p/foo:0', created.id)
    p.deleteById(created.id)
    expect(p.getForSession('/p/foo:0')).toBeUndefined()
  })

  test('listAll orders builtins first, then alphabetically among each group', () => {
    p.create({ name: 'Zeta', systemPrompt: 'x' })
    p.create({ name: 'Alpha', systemPrompt: 'x' })
    const all = p.listAll()
    const builtinNames = all.filter((x) => x.builtin).map((x) => x.name)
    const userNames = all.filter((x) => !x.builtin).map((x) => x.name)
    expect(userNames).toEqual(['Alpha', 'Zeta'])
    // All builtins come before any user personality
    const lastBuiltinIdx = all.findIndex((x) => x.name === builtinNames[builtinNames.length - 1])
    const firstUserIdx = all.findIndex((x) => x.name === 'Alpha')
    expect(lastBuiltinIdx).toBeLessThan(firstUserIdx)
  })

  test('rejects creating a personality with a duplicate name', () => {
    p.create({ name: 'Unique', systemPrompt: 'x' })
    expect(() => p.create({ name: 'Unique', systemPrompt: 'y' })).toThrow()
  })
})
