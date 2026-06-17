import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeLoadout } from '../src/company/loadout'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('writeLoadout', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'co-lo-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  test('writes settings.local.json with only the seat skills', () => {
    const folder = join(dir, 'desks', 'secretary')
    writeLoadout({ id: 'secretary', title: 'COS', folder, reports_to: 'mahdi', manages: [], profile_name: 'careful', skills: ['brainstorming', 'writing-plans'], mcps: [], schedule_cron: null, budget_minutes_week: 240, approval_policy: 'ask', autonomy_level: 1, status: 'idle', active: true })
    const settings = JSON.parse(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8'))
    expect(settings.enabledSkills).toEqual(['brainstorming', 'writing-plans'])
    const mcp = JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers).toEqual({})
  })
})
