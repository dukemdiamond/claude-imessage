#!/usr/bin/env node
// Claude Code hook handler for hub-managed sessions (wired in via `claude --settings <hooks.json>`).
// Reads the hook event from stdin, forwards it to the hub, and (for PermissionRequest)
// waits for your verdict from iMessage. If the hub is down, it exits quietly so the
// session behaves normally.
import net from 'node:net'
import { SOCKET_PATH } from './lib/config.mjs'

const name = process.env.CC_IMSG_NAME
if (!name) process.exit(0) // not a hub-managed session

let input = ''
for await (const chunk of process.stdin) input += chunk
const event = JSON.parse(input || '{}')

// Wait up to `ms` for the hub's single-line JSON answer.
function ask(msg, ms) {
  return new Promise(resolve => {
    const s = net.createConnection(SOCKET_PATH)
    let buf = ''
    const done = v => { clearTimeout(t); s.destroy(); resolve(v) }
    const t = setTimeout(() => done(null), ms)
    s.on('connect', () => s.write(JSON.stringify({ ...msg, name }) + '\n'))
    s.on('data', d => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl >= 0) done(JSON.parse(buf.slice(0, nl)))
    })
    s.on('error', () => done(null))
  })
}

const base = { session_id: event.session_id, cwd: event.cwd }

switch (event.hook_event_name) {
  case 'SessionStart':
    await ask({ type: 'session_start', ...base, source: event.source }, 3000)
    break
  case 'UserPromptSubmit':
    await ask({ type: 'prompt', ...base, prompt: event.prompt }, 3000)
    break
  case 'Stop':
    await ask({ type: 'stop', ...base, text: event.last_assistant_message || '' }, 5000)
    break
  case 'Notification':
    await ask({ type: 'notification', ...base, kind: event.notification_type, text: event.message }, 3000)
    break
  case 'SessionEnd':
    await ask({ type: 'session_end', ...base, reason: event.reason }, 1000)
    break
  case 'PermissionRequest': {
    // Blocks until you answer on your phone (hub decides whether to ask at all).
    const res = await ask({
      type: 'permission_request', ...base,
      tool_name: event.tool_name, tool_input: event.tool_input,
    }, 590_000)
    if (res?.behavior === 'allow' || res?.behavior === 'deny') {
      const decision = { behavior: res.behavior }
      if (res.behavior === 'deny') decision.message = res.message || 'Denied from iMessage.'
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
      }))
    }
    // no answer -> no output -> normal terminal dialog
    break
  }
}
process.exit(0)
