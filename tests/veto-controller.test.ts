import { describe, test, expect } from 'bun:test'
import { VetoController } from '../src/veto-controller'

describe('VetoController', () => {
  test('schedule stores a pending veto retrievable by path', () => {
    const vc = new VetoController()
    vc.schedule('/p:0', 'mysess', 'draft', 10_000, () => {})
    const v = vc.get('/p:0')
    expect(v?.sessionName).toBe('mysess')
    expect(v?.draft).toBe('draft')
  })

  test('cancel clears the pending veto and returns it', () => {
    const vc = new VetoController()
    vc.schedule('/p:0', 'mysess', 'draft', 10_000, () => {})
    const cancelled = vc.cancel('/p:0')
    expect(cancelled?.draft).toBe('draft')
    expect(vc.get('/p:0')).toBeUndefined()
  })

  test('schedule while pending replaces the prior veto', () => {
    const vc = new VetoController()
    vc.schedule('/p:0', 'mysess', 'first', 10_000, () => {})
    vc.schedule('/p:0', 'mysess', 'second', 10_000, () => {})
    expect(vc.get('/p:0')?.draft).toBe('second')
  })

  test('onFire callback runs when the timeout elapses', async () => {
    const vc = new VetoController()
    let fired: string | undefined
    vc.schedule('/p:0', 'mysess', 'boom', 15, (v) => { fired = v.draft })
    await new Promise(r => setTimeout(r, 40))
    expect(fired).toBe('boom')
    expect(vc.get('/p:0')).toBeUndefined()
  })

  test('cancel before timeout prevents onFire', async () => {
    const vc = new VetoController()
    let fired = false
    vc.schedule('/p:0', 'mysess', 'x', 30, () => { fired = true })
    vc.cancel('/p:0')
    await new Promise(r => setTimeout(r, 60))
    expect(fired).toBe(false)
  })

  test('list returns all pending vetos', () => {
    const vc = new VetoController()
    vc.schedule('/a:0', 'sessA', 'draftA', 10_000, () => {})
    vc.schedule('/b:0', 'sessB', 'draftB', 10_000, () => {})
    const list = vc.list()
    expect(list.length).toBe(2)
    const names = list.map(v => v.sessionName).sort()
    expect(names).toEqual(['sessA', 'sessB'])
  })

  test('cancel on non-existent path returns undefined', () => {
    const vc = new VetoController()
    expect(vc.cancel('/no:0')).toBeUndefined()
  })
})
