import { writeLoadout } from './loadout'
import { buildWakePrompt } from './wake-prompt'
import type { Department } from './store'

export async function spawnDepartment(
  dept: Department,
  screen: { spawn: (name: string, projectPath: string, instructions?: string, profileName?: string) => Promise<void> },
): Promise<void> {
  writeLoadout(dept)
  await screen.spawn(dept.id, dept.folder, buildWakePrompt(dept), dept.profile_name ?? undefined)
}
