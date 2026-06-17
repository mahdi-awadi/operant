// src/company/tools.ts
import type { CompanyStore } from './store'

export const COMPANY_TOOL_DEFS = [
  { name: 'company_get_tasks', description: 'List tasks assigned to your department. Optional status filter.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
  { name: 'company_create_task', description: 'Create a task on the company board.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, project: { type: 'string' }, dept_id: { type: 'string' }, emits_on_done: { type: 'string' }, corr_id: { type: 'string' } }, required: ['title'] } },
  { name: 'company_claim_task', description: 'Atomically claim a task before working it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, run_id: { type: 'string' } }, required: ['id', 'run_id'] } },
  { name: 'company_update_task', description: 'Update a task status (in_progress|blocked|needs_approval|done|cancelled).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, result_ref: { type: 'string' } }, required: ['id', 'status'] } },
  { name: 'company_create_handoff', description: 'Hand a task to another department.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, to_dept: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'to_dept'] } },
  { name: 'company_write_memory', description: 'Write a durable fact/decision to shared memory.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } }, required: ['scope', 'key', 'value'] } },
  { name: 'company_search_memory', description: 'Search shared memory (full-text).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' } }, required: ['query'] } },
  { name: 'company_request_approval', description: 'Request the CEO\'s approval for an external/irreversible action. Parks the work until approved.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' }, summary: { type: 'string' }, task_id: { type: 'string' }, payload: { type: 'string' } }, required: ['kind', 'summary'] } },
] as const

export async function handleCompanyTool(store: CompanyStore, deptId: string, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'company_get_tasks': {
      const tasks = store.listTasks({ dept_id: deptId, status: args.status as string | undefined })
      return tasks.length ? JSON.stringify(tasks.map(t => ({ id: t.id, title: t.title, status: t.status, project: t.project }))) : 'No tasks.'
    }
    case 'company_create_task': {
      const t = store.createTask({ title: String(args.title), body: args.body as string, project: args.project as string, dept_id: (args.dept_id as string) ?? deptId, emits_on_done: args.emits_on_done as string, corr_id: args.corr_id as string })
      store.logActivity({ actor_type: 'agent', actor: deptId, action: 'create_task', entity_type: 'task', entity_id: t.id })
      return `Created task ${t.id}: ${t.title}`
    }
    case 'company_claim_task':
      return store.claimTask(String(args.id), String(args.run_id)) ? 'claimed' : 'already-claimed'
    case 'company_update_task':
      store.updateTaskStatus(String(args.id), String(args.status), args.result_ref as string)
      return `Task ${args.id} -> ${args.status}`
    case 'company_create_handoff': {
      store.createHandoff({ task_id: String(args.task_id), from_dept: deptId, to_dept: String(args.to_dept), reason: args.reason as string })
      return `Handed off ${args.task_id} to ${args.to_dept}`
    }
    case 'company_write_memory':
      store.writeMemory({ scope: String(args.scope), key: String(args.key), value: String(args.value), author_dept: deptId })
      return 'memory written'
    case 'company_search_memory': {
      const hits = store.searchMemory(String(args.query), args.scope as string)
      return hits.length ? JSON.stringify(hits) : 'No matches.'
    }
    case 'company_request_approval': {
      const a = store.createApproval({ task_id: args.task_id as string, dept_id: deptId, kind: String(args.kind), summary: String(args.summary), payload: args.payload as string })
      if (args.task_id) store.updateTaskStatus(String(args.task_id), 'needs_approval')
      return `Approval requested (${a.id}). Work parked until the CEO approves.`
    }
    default:
      throw new Error(`unknown company tool: ${name}`)
  }
}
