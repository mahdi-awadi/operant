// src/session-registry.ts
import { basename } from 'path'
import type { SessionState, SessionConfig, TrustLevel, Profile, FrontendSource, AutopilotConfig } from './types'

type RegistryOptions = {
  defaultTrust: TrustLevel
  defaultUploadDir: string
}

export class SessionRegistry {
  private sessions = new Map<string, SessionState>()
  private options: RegistryOptions

  constructor(options: RegistryOptions) {
    this.options = options
  }

  folderPath(sessionKey: string): string {
    const idx = sessionKey.lastIndexOf(':')
    if (idx > 0 && /^\d+$/.test(sessionKey.slice(idx + 1))) {
      return sessionKey.slice(0, idx)
    }
    return sessionKey
  }

  getTeam(folderPath: string): SessionState[] {
    return [...this.sessions.values()]
      .filter(s => this.folderPath(s.path) === folderPath)
      .sort((a, b) => (a.teamIndex ?? 0) - (b.teamIndex ?? 0))
  }

  getTeamLead(folderPath: string): SessionState | undefined {
    return this.getTeam(folderPath).find(s => s.teamIndex === 0)
  }

  nextTeamIndex(folderPath: string): number {
    const team = this.getTeam(folderPath)
    if (team.length === 0) return 0
    return Math.max(...team.map(s => s.teamIndex ?? 0)) + 1
  }

  register(path: string, overrides?: Partial<SessionConfig>): SessionState {
    if (this.sessions.has(path)) {
      throw new Error(`Session for ${path} already registered`)
    }
    const folder = this.folderPath(path)
    const baseName = overrides?.name ?? basename(folder)
    const name = this.uniqueName(baseName)
    const session: SessionState = {
      path,
      name,
      trust: overrides?.trust ?? this.options.defaultTrust,
      prefix: overrides?.prefix ?? '',
      uploadDir: overrides?.uploadDir ?? this.options.defaultUploadDir,
      managed: overrides?.managed ?? false,
      teamIndex: overrides?.teamIndex ?? 0,
      teamSize: overrides?.teamSize ?? 0,
      appliedProfile: overrides?.appliedProfile,
      profileOverrides: overrides?.profileOverrides,
      status: 'active',
      connectedAt: Date.now(),
    }
    this.sessions.set(path, session)
    return session
  }

  private uniqueName(base: string): string {
    const existing = new Set([...this.sessions.values()].map(s => s.name))
    if (!existing.has(base)) return base
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`
      if (!existing.has(candidate)) return candidate
    }
  }

  disconnect(path: string): void {
    const s = this.sessions.get(path)
    if (s) s.status = 'disconnected'
  }

  reconnect(path: string): void {
    const s = this.sessions.get(path)
    if (s) {
      s.status = 'active'
      s.connectedAt = Date.now()
    }
  }

  unregister(path: string): void {
    this.sessions.delete(path)
  }

  get(path: string): SessionState | undefined {
    return this.sessions.get(path)
  }

  list(): SessionState[] {
    return [...this.sessions.values()]
  }

  findByName(name: string): string | undefined {
    for (const [path, s] of this.sessions) {
      if (s.name === name) return path
    }
    return undefined
  }

  rename(path: string, newName: string): void {
    const s = this.sessions.get(path)
    if (s) s.name = newName
  }

  setTrust(path: string, trust: TrustLevel): void {
    const s = this.sessions.get(path)
    if (s) s.trust = trust
  }

  setPrefix(path: string, prefix: string): void {
    const s = this.sessions.get(path)
    if (s) s.prefix = prefix
  }

  setAutopilot(path: string, config: Partial<AutopilotConfig> | undefined): void {
    const s = this.sessions.get(path)
    if (!s) return
    if (config === undefined) {
      delete s.autopilot
    } else {
      s.autopilot = config
    }
  }

  getAutopilot(path: string): Partial<AutopilotConfig> | undefined {
    return this.sessions.get(path)?.autopilot
  }

  // Rules & facts live on profileOverrides — setting them here materializes
  // an override that shadows whatever the applied profile specifies. Reading
  // via getEffectiveRules/Facts falls back to the profile when no override.

  setRules(path: string, rules: string[]): void {
    const s = this.sessions.get(path)
    if (!s) return
    if (!s.profileOverrides) s.profileOverrides = {}
    s.profileOverrides.rules = rules
  }

  getEffectiveRules(path: string, profiles: readonly Profile[]): string[] {
    const s = this.sessions.get(path)
    if (!s) return []
    const profile = s.appliedProfile ? profiles.find(p => p.name === s.appliedProfile) : undefined
    const overrides = s.profileOverrides?.rules
    return overrides ?? profile?.rules ?? []
  }

  addRule(path: string, rule: string, profiles: readonly Profile[]): void {
    const current = this.getEffectiveRules(path, profiles)
    this.setRules(path, [...current, rule])
  }

  clearRules(path: string): void {
    const s = this.sessions.get(path)
    if (!s) return
    if (!s.profileOverrides) s.profileOverrides = {}
    s.profileOverrides.rules = []
  }

  setFacts(path: string, facts: string[]): void {
    const s = this.sessions.get(path)
    if (!s) return
    if (!s.profileOverrides) s.profileOverrides = {}
    s.profileOverrides.facts = facts
  }

  getEffectiveFacts(path: string, profiles: readonly Profile[]): string[] {
    const s = this.sessions.get(path)
    if (!s) return []
    const profile = s.appliedProfile ? profiles.find(p => p.name === s.appliedProfile) : undefined
    const overrides = s.profileOverrides?.facts
    return overrides ?? profile?.facts ?? []
  }

  addFact(path: string, fact: string, profiles: readonly Profile[]): void {
    const current = this.getEffectiveFacts(path, profiles)
    this.setFacts(path, [...current, fact])
  }

  clearFacts(path: string): void {
    const s = this.sessions.get(path)
    if (!s) return
    if (!s.profileOverrides) s.profileOverrides = {}
    s.profileOverrides.facts = []
  }

  setChannelOverride(path: string, frontend: FrontendSource, text: string): void {
    const s = this.sessions.get(path)
    if (!s) return
    if (!s.profileOverrides) s.profileOverrides = {}
    if (!s.profileOverrides.channelOverrides) s.profileOverrides.channelOverrides = {}
    s.profileOverrides.channelOverrides[frontend] = text
  }

  clearChannelOverride(path: string, frontend: FrontendSource): void {
    const s = this.sessions.get(path)
    if (!s?.profileOverrides?.channelOverrides) return
    delete s.profileOverrides.channelOverrides[frontend]
  }

  getChannelOverride(path: string, frontend: FrontendSource): string | undefined {
    const s = this.sessions.get(path)
    return s?.profileOverrides?.channelOverrides?.[frontend]
  }

  restoreFrom(saved: Record<string, SessionConfig>): void {
    for (const [path, config] of Object.entries(saved)) {
      this.sessions.set(path, {
        ...config,
        path,
        status: 'disconnected',
        connectedAt: null,
      })
    }
  }

  toSaveFormat(): Record<string, SessionConfig> {
    const result: Record<string, SessionConfig> = {}
    for (const [path, s] of this.sessions) {
      result[path] = {
        name: s.name,
        trust: s.trust,
        prefix: s.prefix,
        uploadDir: s.uploadDir,
        managed: s.managed,
        teamIndex: s.teamIndex,
        teamSize: s.teamSize,
        appliedProfile: s.appliedProfile,
        profileOverrides: s.profileOverrides,
        autopilot: s.autopilot,    // new
      }
    }
    return result
  }
}
