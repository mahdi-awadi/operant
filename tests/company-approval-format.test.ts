import { test, expect } from 'bun:test'
import { formatApproval } from '../src/frontends/telegram'

test('formats an approval with kind and summary', () => {
  const text = formatApproval({ id: 'appr_1', task_id: 't1', dept_id: 'sales', kind: 'send_external', summary: 'Send outreach email', payload: null, state: 'pending', requested_at: 0 })
  expect(text).toContain('sales')
  expect(text).toContain('send_external')
  expect(text).toContain('Send outreach email')
})
