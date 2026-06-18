// src/profiles.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join } from 'path'
import type { Profile, ProfileOverrides, TrustLevel, FrontendSource } from './types'

const PROFILES_FILE = 'profiles.json'

export const DEFAULT_CHANNEL_INSTRUCTIONS: Record<FrontendSource, string> = {
  telegram: 'You are replying on Telegram mobile. Use markdown formatting, emoji prefixes (✅ ❌ ⚠️ 🔄 📝), bold for emphasis, and fenced code blocks. When you create, save, or reference a file (especially .md specs, configs, or new code files), paste the full file contents in your reply — mobile users cannot browse the filesystem. Keep replies concise but complete.',
  web: 'You are replying on the web dashboard. Use markdown, code blocks, tables, and emoji. For files, show a summary or diff; long content is fine since the dashboard has scroll. Prefer structured output over walls of text.',
  cli: 'You are replying via the CLI. Plain text only, no markdown, no emoji. Keep output terminal-friendly and concise.',
}

export const BUILTIN_PROFILES: readonly Profile[] = [
  {
    name: 'careful',
    description: 'Production work — max caution, strict trust, verification required',
    trust: 'strict',
    rules: [
      'No shortcuts, no hacks. Always root-cause bugs.',
      'Never force-push or rewrite history.',
      'Run full test suite before claiming done.',
      'No deploys without explicit approval.',
    ],
    facts: [],
    prefix: '',
    driftDetection: true,
    sidecarEnabled: false,
    verification: { commands: ['bun test', 'bunx tsc --noEmit'] },
  },
  {
    name: 'tdd',
    description: 'Test-driven development enforcer',
    trust: 'ask',
    rules: [
      'Write a failing test before any implementation change.',
      'Never skip tests, never comment out tests.',
      'Run tests after every change.',
      'No implementation without a test that covers it.',
    ],
    facts: [],
    prefix: '',
    driftDetection: true,
    sidecarEnabled: false,
    verification: { commands: ['bun test', 'bunx tsc --noEmit'] },
  },
  {
    name: 'docs',
    description: 'Documentation work — markdown structure and clarity',
    trust: 'ask',
    rules: [
      'Use markdown with H2 for sections and H3 for subsections.',
      'All code examples must be runnable.',
      'Add a table of contents for any doc over 500 words.',
      'Define jargon before using it.',
    ],
    facts: [],
    prefix: '',
    driftDetection: true,
    sidecarEnabled: false,
  },
  {
    name: 'yolo',
    description: 'Disposable experiments — auto-approve everything',
    trust: 'yolo',
    rules: [],
    facts: [],
    prefix: '',
    driftDetection: false,
    sidecarEnabled: false,
  },
] as const

export function loadProfiles(dir: string): Profile[] {
  const path = join(dir, PROFILES_FILE)
  if (!existsSync(path)) {
    return [...BUILTIN_PROFILES]
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const user = JSON.parse(raw) as Profile[]
    // User profiles override built-ins by name
    const userNames = new Set(user.map(p => p.name))
    const builtins = BUILTIN_PROFILES.filter(p => !userNames.has(p.name))
    return [...builtins, ...user]
  } catch (err) {
    process.stderr.write(`profiles: failed to load ${path}: ${err}\n`)
    return [...BUILTIN_PROFILES]
  }
}

export function saveProfiles(profiles: Profile[], dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, PROFILES_FILE)
  // Only persist non-builtin profiles (and overrides of builtins)
  const builtinNames = new Set(BUILTIN_PROFILES.map(p => p.name))
  const toSave = profiles.filter(p =>
    !builtinNames.has(p.name) || !isIdenticalToBuiltin(p)
  )
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(toSave, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

function isIdenticalToBuiltin(profile: Profile): boolean {
  const builtin = BUILTIN_PROFILES.find(p => p.name === profile.name)
  if (!builtin) return false
  return JSON.stringify(builtin) === JSON.stringify(profile)
}

export function getProfile(name: string, profiles: readonly Profile[]): Profile | undefined {
  return profiles.find(p => p.name === name)
}

type PartialSession = {
  appliedProfile?: string
  profileOverrides?: ProfileOverrides
}

export type EffectiveConfig = {
  trust: TrustLevel
  rules: string[]
  facts: string[]
  prefix: string
  channelOverrides: Partial<Record<FrontendSource, string>>
  driftDetection: boolean
  sidecarEnabled: boolean
  verification?: Profile['verification']
}

export function applyProfile(profile: Profile): {
  trust: TrustLevel
  appliedProfile: string
  profileOverrides: ProfileOverrides
} {
  return {
    trust: profile.trust,
    appliedProfile: profile.name,
    profileOverrides: {},
  }
}

export function injectContext(
  userMessage: string,
  frontend: FrontendSource,
  effective: EffectiveConfig,
): string {
  const parts: string[] = []

  const channelInstr = effective.channelOverrides?.[frontend] ?? DEFAULT_CHANNEL_INSTRUCTIONS[frontend]
  if (channelInstr) {
    parts.push(`[Channel: ${channelInstr}]`)
  }

  if (effective.rules.length > 0) {
    parts.push(`[Session Rules: ${effective.rules.join('; ')}]`)
  }

  if (effective.facts.length > 0) {
    parts.push(`[Facts: ${effective.facts.join('; ')}]`)
  }

  parts.push('')
  parts.push(userMessage)

  return parts.join('\n')
}

export function resolveSession(
  session: PartialSession,
  profiles: readonly Profile[],
): EffectiveConfig {
  const profile = session.appliedProfile
    ? getProfile(session.appliedProfile, profiles)
    : undefined
  const overrides = session.profileOverrides ?? {}

  return {
    trust: overrides.trust ?? profile?.trust ?? 'ask',
    rules: overrides.rules ?? profile?.rules ?? [],
    facts: overrides.facts ?? profile?.facts ?? [],
    prefix: overrides.prefix ?? profile?.prefix ?? '',
    channelOverrides: { ...(profile?.channelOverrides ?? {}), ...(overrides.channelOverrides ?? {}) },
    driftDetection: overrides.driftDetection ?? profile?.driftDetection ?? true,
    sidecarEnabled: overrides.sidecarEnabled ?? profile?.sidecarEnabled ?? false,
    verification: overrides.verification ?? profile?.verification,
  }
}
