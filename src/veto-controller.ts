// src/veto-controller.ts

export type PendingVeto = {
  path: string
  sessionName: string
  draft: string
  expiresAt: number
}

export type VetoFireFn = (v: PendingVeto) => void

export class VetoController {
  private pending = new Map<string, { veto: PendingVeto; timer: ReturnType<typeof setTimeout> }>()

  schedule(path: string, sessionName: string, draft: string, vetoMs: number, onFire: VetoFireFn): PendingVeto {
    this.cancel(path) // clear any existing veto for the same session
    const expiresAt = Date.now() + vetoMs
    const veto: PendingVeto = { path, sessionName, draft, expiresAt }
    const timer = setTimeout(() => {
      this.pending.delete(path)
      onFire(veto)
    }, vetoMs)
    this.pending.set(path, { veto, timer })
    return veto
  }

  cancel(path: string): PendingVeto | undefined {
    const existing = this.pending.get(path)
    if (existing) {
      clearTimeout(existing.timer)
      this.pending.delete(path)
      return existing.veto
    }
    return undefined
  }

  get(path: string): PendingVeto | undefined {
    return this.pending.get(path)?.veto
  }

  list(): PendingVeto[] {
    return [...this.pending.values()].map(p => p.veto)
  }
}
