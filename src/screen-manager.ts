// src/screen-manager.ts — uses tmux for reliable TUI interaction
import { $ } from 'bun'
import { mkdirSync, existsSync } from 'fs'

function ensureProjectDir(projectPath: string): void {
  // Reject paths whose basename collides with session-key suffix format (path:index).
  // Otherwise spawning at "/foo:0" creates a real dir that ghosts the registry grouping.
  if (/:\d+$/.test(projectPath)) {
    throw new Error(`Invalid project path "${projectPath}": trailing ":N" collides with session key format`)
  }
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath, { recursive: true })
    process.stderr.write(`hub: created project directory ${projectPath}\n`)
  }
}

type ManagedSession = {
  sessionName: string
  projectPath: string
  respawnEnabled: boolean
  profileName?: string
}

const CHANNELS_FLAG = '--dangerously-load-development-channels server:hub'
const TEAM_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1'

export type ResumeSpec =
  | { mode: 'continue' }
  | { mode: 'session', id: string }

export function isValidSessionId(id: string): boolean {
  return /^[0-9a-f-]{8,64}$/i.test(id)
}

export function buildClaudeCmd(opts: { team: boolean; resume?: ResumeSpec }): string {
  let flag = ''
  if (opts.resume?.mode === 'continue') {
    flag = '--continue '
  } else if (opts.resume?.mode === 'session') {
    if (!isValidSessionId(opts.resume.id)) {
      throw new Error(`invalid session id: ${opts.resume.id}`)
    }
    flag = `--resume ${opts.resume.id} `
  }
  const base = `claude ${flag}${CHANNELS_FLAG}`
  return opts.team ? `${TEAM_ENV} ${base}` : base
}

// Team-mode command is referenced by spawnTeam / addTeammate; keep as a constant.
const CLAUDE_TEAM_CMD = buildClaudeCmd({ team: true })
const CONFIRM_DELAY = 1500
const CONFIRM_RETRIES = 5
const CONFIRM_INTERVAL = 1000
const GRACEFUL_CANCEL_DELAY = 300      // ms between Ctrl+C and /exit
const GRACEFUL_POLL_INTERVAL = 250     // ms between has-session polls
const GRACEFUL_TIMEOUT = 3000          // ms total wait before hard kill

export class ScreenManager {
  private managed = new Map<string, ManagedSession>()
  private respawnTimers = new Map<string, ReturnType<typeof setTimeout>>()

  async spawn(
    name: string,
    projectPath: string,
    instructions?: string,
    profileName?: string,
    resume?: ResumeSpec,
  ): Promise<void> {
    const sessionName = `hub-${name}`
    ensureProjectDir(projectPath)

    // Kill existing session if any
    try { await $`tmux kill-session -t ${sessionName}`.quiet() } catch {}

    // Create detached tmux session running Claude
    const cmd = buildClaudeCmd({ team: false, resume })
    await $`tmux new-session -d -s ${sessionName} -c ${projectPath} ${cmd}`.quiet()
    this.managed.set(name, { sessionName, projectPath, respawnEnabled: true, profileName })

    // Auto-confirm the development channels warning, then send instructions if any
    this.autoConfirm(sessionName, instructions)
  }

  private async autoConfirm(sessionName: string, initialPrompt?: string): Promise<void> {
    await new Promise(r => setTimeout(r, CONFIRM_DELAY))

    for (let i = 0; i < CONFIRM_RETRIES; i++) {
      try {
        const pane = await $`tmux capture-pane -t ${sessionName} -p`.quiet().text()
        if (pane.includes('Enter to confirm')) {
          await $`tmux send-keys -t ${sessionName} Enter`.quiet()
          process.stderr.write(`hub: auto-confirmed dev warning for ${sessionName}\n`)
          // Wait for Claude to fully start, then send initial prompt if provided
          if (initialPrompt) {
            await this.waitForReady(sessionName)
            await this.sendPrompt(sessionName, initialPrompt)
          }
          return
        }
        // Already past the warning
        if (pane.includes('Listening for channel') || pane.includes('╭')) {
          if (initialPrompt) {
            await this.waitForReady(sessionName)
            await this.sendPrompt(sessionName, initialPrompt)
          }
          return
        }
      } catch {
        return
      }
      await new Promise(r => setTimeout(r, CONFIRM_INTERVAL))
    }
    process.stderr.write(`hub: could not auto-confirm warning for ${sessionName} (timed out)\n`)
  }

  private async waitForReady(sessionName: string): Promise<void> {
    // Wait until we see the prompt indicator (❯)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        const pane = await $`tmux capture-pane -t ${sessionName} -p`.quiet().text()
        if (pane.includes('❯')) {
          return
        }
      } catch {
        return
      }
    }
  }

  private async sendPrompt(sessionName: string, text: string): Promise<void> {
    try {
      // Type the prompt and press Enter
      await $`tmux send-keys -t ${sessionName} ${text} Enter`.quiet()
      process.stderr.write(`hub: sent prompt to ${sessionName}\n`)
    } catch (err) {
      process.stderr.write(`hub: failed to send prompt to ${sessionName}: ${err}\n`)
    }
  }

  async kill(name: string): Promise<void> {
    const entry = this.managed.get(name)
    if (!entry) return
    entry.respawnEnabled = false
    const timer = this.respawnTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.respawnTimers.delete(name)
    }
    try {
      await $`tmux kill-session -t ${entry.sessionName}`.quiet()
    } catch {}
    this.managed.delete(name)
  }

  async gracefulKill(name: string): Promise<void> {
    const entry = this.managed.get(name)
    if (!entry) return

    // Stop respawn first so the monitor doesn't restart the session while we're tearing it down.
    entry.respawnEnabled = false
    const timer = this.respawnTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.respawnTimers.delete(name)
    }

    const sessionName = entry.sessionName

    // 1. Cancel any in-progress tool call so Claude is at a clean prompt.
    try { await $`tmux send-keys -t ${sessionName} C-c`.quiet() } catch {}
    await new Promise(r => setTimeout(r, GRACEFUL_CANCEL_DELAY))

    // 2. Ask Claude to exit. Since Claude is the tmux window's only process,
    //    its exit causes tmux to close the window and the session disappears.
    try { await $`tmux send-keys -t ${sessionName} /exit Enter`.quiet() } catch {}

    // 3. Poll for the session to disappear on its own, up to GRACEFUL_TIMEOUT.
    const deadline = Date.now() + GRACEFUL_TIMEOUT
    while (Date.now() < deadline) {
      if (!(await this.isSessionRunning(sessionName))) {
        this.managed.delete(name)
        return
      }
      await new Promise(r => setTimeout(r, GRACEFUL_POLL_INTERVAL))
    }

    // Final check after the poll window closes, in case the session died during the last sleep.
    if (!(await this.isSessionRunning(sessionName))) {
      this.managed.delete(name)
      return
    }

    // 4. Fallback: Claude didn't respond in time, hard-kill tmux.
    try { await $`tmux kill-session -t ${sessionName}`.quiet() } catch {}
    this.managed.delete(name)
  }

  async killAll(): Promise<void> {
    for (const name of [...this.managed.keys()]) {
      await this.kill(name)
    }
  }

  async isSessionRunning(sessionName: string): Promise<boolean> {
    try {
      await $`tmux has-session -t ${sessionName}`.quiet()
      return true
    } catch {
      return false
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const result = await $`tmux list-sessions -F #{session_name}`.quiet().text()
      return result.trim().split('\n').filter(s => s.startsWith('hub-'))
    } catch {
      return []
    }
  }

  scheduleRespawn(name: string): void {
    const entry = this.managed.get(name)
    if (!entry || !entry.respawnEnabled) return

    this.respawnTimers.set(name, setTimeout(async () => {
      this.respawnTimers.delete(name)
      if (!entry.respawnEnabled) return
      try {
        await this.spawn(name, entry.projectPath)
        process.stderr.write(`hub: respawned ${name}\n`)
      } catch (err) {
        process.stderr.write(`hub: failed to respawn ${name}: ${err}\n`)
      }
    }, 3000))
  }

  async spawnTeam(name: string, projectPath: string, size: number, instructions?: string, profileName?: string): Promise<void> {
    ensureProjectDir(projectPath)
    const teammateNames = Array.from({ length: size - 1 }, (_, i) => `${name}-${i + 2}`)
    const tagsSuffix = instructions ? ` ${instructions}` : ''
    const leadPrompt = `You are the team lead "${name}". Create a team and spawn ${size - 1} teammates. Assign them names: ${teammateNames.join(', ')}. Wait for them to connect, then coordinate the work.${tagsSuffix}`

    // Spawn lead first
    const leadSession = `hub-${name}`
    try { await $`tmux kill-session -t ${leadSession}`.quiet() } catch {}
    await $`tmux new-session -d -s ${leadSession} -c ${projectPath} ${CLAUDE_TEAM_CMD}`.quiet()
    this.managed.set(name, { sessionName: leadSession, projectPath, respawnEnabled: true, profileName })
    this.autoConfirm(leadSession, leadPrompt)

    // Wait for lead to initialize and create the team
    await new Promise(r => setTimeout(r, 8000))

    // Spawn teammates — they connect to the same folder, Claude's team protocol handles joining
    for (let i = 2; i <= size; i++) {
      const tmName = `${name}-${i}`
      const tmSession = `hub-${tmName}`
      try { await $`tmux kill-session -t ${tmSession}`.quiet() } catch {}
      await $`tmux new-session -d -s ${tmSession} -c ${projectPath} ${CLAUDE_TEAM_CMD}`.quiet()
      this.managed.set(tmName, { sessionName: tmSession, projectPath, respawnEnabled: true, profileName })
      this.autoConfirm(tmSession)
      await new Promise(r => setTimeout(r, 3000))
    }
  }

  async addTeammate(leadName: string): Promise<string | null> {
    const leadEntry = this.managed.get(leadName)
    if (!leadEntry) return null

    let index = 2
    while (this.managed.has(`${leadName}-${index}`)) index++

    const tmName = `${leadName}-${index}`
    const tmSession = `hub-${tmName}`
    try { await $`tmux kill-session -t ${tmSession}`.quiet() } catch {}
    await $`tmux new-session -d -s ${tmSession} -c ${leadEntry.projectPath} ${CLAUDE_TEAM_CMD}`.quiet()
    this.managed.set(tmName, { sessionName: tmSession, projectPath: leadEntry.projectPath, respawnEnabled: true })
    this.autoConfirm(tmSession)

    // Tell the lead about the new teammate
    const leadSession = `hub-${leadName}`
    this.waitForReady(tmSession).then(() => {
      this.sendPrompt(leadSession, `A new teammate "${tmName}" has joined. Assign them work.`)
    })

    return tmName
  }

  forgetManaged(name: string): void {
    const entry = this.managed.get(name)
    if (!entry) return
    entry.respawnEnabled = false
    const timer = this.respawnTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.respawnTimers.delete(name)
    }
    this.managed.delete(name)
  }

  async capturePane(sessionName: string, lines: number = 200): Promise<string> {
    try {
      return await $`tmux capture-pane -t ${sessionName} -p -S -${lines}`.quiet().text()
    } catch {
      return ''
    }
  }

  async sendKeysRaw(sessionName: string, text: string, withEnter: boolean): Promise<void> {
    try {
      if (withEnter) {
        await $`tmux send-keys -t ${sessionName} ${text} Enter`.quiet()
      } else {
        await $`tmux send-keys -t ${sessionName} ${text}`.quiet()
      }
    } catch (err) {
      process.stderr.write(`hub: sendKeysRaw failed for ${sessionName}: ${err}\n`)
    }
  }

  async sendEscape(sessionName: string): Promise<void> {
    try { await $`tmux send-keys -t ${sessionName} Escape`.quiet() } catch {}
  }

  isManaged(name: string): boolean {
    return this.managed.has(name)
  }

  getManagedNames(): string[] {
    return [...this.managed.keys()]
  }

  getManagedEntry(name: string): ManagedSession | undefined {
    return this.managed.get(name)
  }

  getManagedByPath(projectPath: string): ManagedSession | undefined {
    for (const entry of this.managed.values()) {
      if (entry.projectPath === projectPath) return entry
    }
    return undefined
  }
}
