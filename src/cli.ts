// src/cli.ts

export function parseCliArgs(args: string[]): { command: string; args: string[] } {
  if (args.length === 0) {
    return { command: 'help', args: [] }
  }

  const command = args[0]
  const rest = args.slice(1)

  // For send and prefix, join remaining args after the session name as a single string
  if ((command === 'send' || command === 'prefix') && rest.length >= 2) {
    const name = rest[0]
    const text = rest.slice(1).join(' ')
    return { command, args: [name, text] }
  }

  return { command, args: rest }
}

const HELP_TEXT = `
Claude Code Hub CLI

Commands:
  list                         List all sessions
  status                       Show session status
  spawn <name> <path>          Spawn a new session
  kill <name>                  Kill a session
  send <name> <message>        Send a message to a session
  trust <name> <level>         Set trust level (ask|auto|strict|yolo)
  prefix <name> <text>         Set a prefix for a session
  rename <oldName> <newName>   Rename a session
  upload <name> <file>         Upload a file to a session
  autopilot <name> on|off      Enable or disable autopilot for a session
  start                        Start the daemon in background
  help                         Show this help text
`.trim()

async function main() {
  const args = process.argv.slice(2)
  const parsed = parseCliArgs(args)
  const { command } = parsed
  const cmdArgs = parsed.args

  const HUB_URL = process.env.HUB_URL ?? 'http://localhost:3000'

  if (command === 'help') {
    console.log(HELP_TEXT)
    return
  }

  if (command === 'list' || command === 'status') {
    try {
      const res = await fetch(`${HUB_URL}/api/sessions`)
      if (!res.ok) {
        console.error(`Error: ${res.status} ${res.statusText}`)
        process.exit(1)
      }
      const sessions = await res.json() as any[]
      if (sessions.length === 0) {
        console.log('No sessions connected.')
        return
      }
      for (const s of sessions) {
        const icon = s.status === 'active' ? '●' : s.status === 'respawning' ? '◑' : '○'
        const trust = s.trust === 'auto' ? ' [auto]' : ''
        if (command === 'status') {
          console.log(`${icon} ${s.name}${trust} (${s.status})`)
          console.log(`  path: ${s.path}`)
          console.log(`  trust: ${s.trust}`)
          if (s.prefix) console.log(`  prefix: ${s.prefix}`)
          console.log()
        } else {
          console.log(`${icon} ${s.name}${trust}`)
        }
      }
    } catch (err) {
      console.error(`Failed to connect to hub at ${HUB_URL}:`, err)
      process.exit(1)
    }
    return
  }

  if (command === 'spawn') {
    const [name, path] = cmdArgs
    if (!name || !path) {
      console.error('Usage: spawn <name> <path>')
      process.exit(1)
    }
    try {
      const res = await fetch(`${HUB_URL}/api/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path }),
      })
      if (!res.ok) {
        console.error(`Error: ${await res.text()}`)
        process.exit(1)
      }
      console.log(`Spawned session ${name} at ${path}`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'kill') {
    const [name] = cmdArgs
    if (!name) {
      console.error('Usage: kill <name>')
      process.exit(1)
    }
    try {
      const res = await fetch(`${HUB_URL}/api/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        console.error(`Error: ${await res.text()}`)
        process.exit(1)
      }
      console.log(`Killed session ${name}`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'send') {
    const [sessionName, text] = cmdArgs
    if (!sessionName || !text) {
      console.error('Usage: send <name> <message>')
      process.exit(1)
    }
    try {
      const res = await fetch(`${HUB_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, text }),
      })
      if (!res.ok) {
        console.error(`Error: ${await res.text()}`)
        process.exit(1)
      }
      console.log(`Message sent to ${sessionName}`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'trust') {
    const [name, level] = cmdArgs
    if (!name || !level) {
      console.error('Usage: trust <name> <level>')
      process.exit(1)
    }
    try {
      const res = await fetch(`${HUB_URL}/api/trust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, level }),
      })
      if (!res.ok) {
        console.error(`Error: ${await res.text()}`)
        process.exit(1)
      }
      console.log(`Trust for ${name} set to ${level}`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'prefix') {
    const [name, text] = cmdArgs
    if (!name || !text) {
      console.error('Usage: prefix <name> <text>')
      process.exit(1)
    }
    try {
      const res = await fetch(`${HUB_URL}/api/prefix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text }),
      })
      if (!res.ok) {
        console.error(`Error: ${await res.text()}`)
        process.exit(1)
      }
      console.log(`Prefix for ${name} set`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'rename') {
    const [oldName, newName] = cmdArgs
    if (!oldName || !newName) {
      console.error('Usage: rename <oldName> <newName>')
      process.exit(1)
    }
    try {
      const res = await fetch(`${HUB_URL}/api/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName, newName }),
      })
      if (!res.ok) {
        console.error(`Error: ${await res.text()}`)
        process.exit(1)
      }
      console.log(`Renamed ${oldName} to ${newName}`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'upload') {
    const [sessionName, filePath] = cmdArgs
    if (!sessionName || !filePath) {
      console.error('Usage: upload <name> <file>')
      process.exit(1)
    }
    try {
      const file = Bun.file(filePath)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('sessionName', sessionName)

      const res = await fetch(`${HUB_URL}/api/upload`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        console.error(`Error: ${await res.text()}`)
        process.exit(1)
      }
      const json = await res.json() as { path: string }
      console.log(`File uploaded to ${json.path}`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'autopilot') {
    const [name, mode] = cmdArgs
    if (!name || !mode || (mode !== 'on' && mode !== 'off')) {
      console.error('Usage: autopilot <name> on|off')
      process.exit(1)
    }
    try {
      const res = await fetch(`${HUB_URL}/api/autopilot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled: mode === 'on' }),
      })
      if (!res.ok) {
        console.error(`autopilot request failed: ${res.status} ${await res.text()}`)
        process.exit(1)
      }
      console.log(`autopilot ${mode} for ${name}`)
    } catch (err) {
      console.error('Failed:', err)
      process.exit(1)
    }
    return
  }

  if (command === 'start') {
    const proc = Bun.spawn(['bun', 'run', 'src/daemon.ts'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    proc.unref()
    console.log(`Daemon started (pid: ${proc.pid})`)
    return
  }

  console.error(`Unknown command: ${command}`)
  console.log(HELP_TEXT)
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
