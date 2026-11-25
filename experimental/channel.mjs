#!/usr/bin/env node
// Channel MCP server: loaded by each Claude Code session. Bridges the session <-> hub.
// Claude Code spawns this over stdio; it talks to the hub over a unix socket.
// stdout belongs to MCP — log to stderr only.
import net from 'node:net'
import path from 'node:path'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SOCKET_PATH } from '../lib/config.mjs'

const NAME = process.env.CC_IMSG_NAME || path.basename(process.cwd())
const log = (...a) => console.error(`[imessage:${NAME}]`, ...a)

const mcp = new Server(
  { name: 'imessage', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: [
      `This session is named "${NAME}" and is remote-controlled by the user over iMessage.`,
      'Messages from their iPhone arrive as <channel source="imessage" session="..."> tags.',
      'The user is on their phone and cannot see this terminal: whenever you finish work asked for',
      'over iMessage, or need a decision, call the `reply` tool. Keep replies short and skimmable,',
      'plain text only (no markdown headers/tables/code fences; short lists with "-" are fine).',
      'Lead with the outcome (done / blocked / question), then key details, file names, and next steps.',
    ].join(' '),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Text the user on iMessage. Use for results, questions, and progress on long tasks.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Plain-text message to send' } },
      required: ['text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)
  const text = String(req.params.arguments?.text ?? '').trim()
  if (!text) return { content: [{ type: 'text', text: 'empty message, nothing sent' }], isError: true }
  const res = await hubRequest({ type: 'reply', text })
  return res.ok
    ? { content: [{ type: 'text', text: 'sent' }] }
    : { content: [{ type: 'text', text: `not sent: ${res.error}` }], isError: true }
})

// Claude Code -> us: a tool needs approval. Forward to the phone via the hub.
mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }).passthrough(),
  }),
  ({ params }) => { hubSend({ type: 'permission_request', ...params }) },
)

// ---- hub connection (auto-reconnect) ----
let sock = null
let buf = ''
let seq = 0
const waiting = new Map()

function connect() {
  const s = net.createConnection(SOCKET_PATH)
  s.on('connect', () => {
    sock = s
    hubSend({ type: 'hello', name: NAME, cwd: process.cwd(), pid: process.ppid, tmux: process.env.CC_IMSG_TMUX || null })
    log('connected to hub')
  })
  s.on('data', d => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (line) onHubMessage(JSON.parse(line))
    }
  })
  s.on('error', () => {})
  s.on('close', () => {
    if (sock === s) sock = null
    for (const [, r] of waiting) r({ ok: false, error: 'hub disconnected' })
    waiting.clear()
    setTimeout(connect, 3000)
  })
}

function hubSend(msg) {
  if (sock) sock.write(JSON.stringify(msg) + '\n')
  return !!sock
}

function hubRequest(msg) {
  const id = ++seq
  return new Promise(resolve => {
    if (!hubSend({ ...msg, id })) return resolve({ ok: false, error: 'hub not running (start it with: cc-imsg hub)' })
    waiting.set(id, resolve)
    setTimeout(() => { if (waiting.delete(id)) resolve({ ok: false, error: 'hub timeout' }) }, 30000)
  })
}

async function onHubMessage(m) {
  if (m.type === 'ack') { waiting.get(m.id)?.(m); waiting.delete(m.id); return }
  if (m.type === 'message') {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: m.text, meta: { session: NAME, via: 'iphone' } },
    })
  }
  if (m.type === 'permission') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: m.request_id, behavior: m.behavior },
    })
  }
}

await mcp.connect(new StdioServerTransport())
connect()
