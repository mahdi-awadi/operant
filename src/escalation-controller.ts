// src/escalation-controller.ts
// Tracks autopilot escalations so the UI can show action buttons on them
// (Proceed anyway / Answer manually / Dismiss). No timers — escalations wait
// until the user acts.

export type PendingEscalation = {
  path: string
  sessionName: string
  rawQuestion: string       // Claude's original outgoing message
  wrappedQuestion: string   // the autopilot-wrapped prompt fed to /btw
  tmuxName: string          // tmux session name for re-running /btw
  reason: string            // why we escalated (risk keyword / timeout / ...)
  reasonKind: 'risk' | 'escalate_token' | 'parse_error' | 'timeout' | 'other'
  createdAt: number
}

export class EscalationController {
  private pending = new Map<string, PendingEscalation>()

  record(e: PendingEscalation): void {
    this.pending.set(e.path, e)
  }

  clear(path: string): PendingEscalation | undefined {
    const existing = this.pending.get(path)
    if (existing) this.pending.delete(path)
    return existing
  }

  get(path: string): PendingEscalation | undefined {
    return this.pending.get(path)
  }

  list(): PendingEscalation[] {
    return [...this.pending.values()]
  }
}
