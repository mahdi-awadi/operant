import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Department } from './store'

// Known extra MCP servers a seat may request (least privilege; hub is always present via the spawn flag).
// Add entries here as their launch commands are confirmed (gitnexus, github, etc. pending).
const MCP_REGISTRY: Record<string, { command: string; args: string[] }> = {
  'chrome': { command: 'npx', args: ['-y', 'chrome-devtools-mcp', '--browserURL', 'http://127.0.0.1:9222'] },
  // Other servers (gitnexus, github, slack, etc.) get added here when their launch commands are known.
}

export function writeLoadout(dept: Department): void {
  const claudeDir = join(dept.folder, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  // Skills: only the seat's skills are enabled.
  writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify({ enabledSkills: dept.skills }, null, 2))
  // MCP: only the seat's requested extra servers (hub comes from the spawn flag).
  const mcpServers: Record<string, unknown> = {}
  for (const name of dept.mcps) {
    if (name === 'hub') continue // provided by --dangerously-load-development-channels server:hub
    if (MCP_REGISTRY[name]) mcpServers[name] = MCP_REGISTRY[name]
  }
  writeFileSync(join(dept.folder, '.mcp.json'), JSON.stringify({ mcpServers, enableAllProjectMcpServers: false }, null, 2))
}
