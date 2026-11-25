#!/usr/bin/env node
// The hub: one long-running process that
//   1. watches your iMessage self-chat (chat.db),
//   2. runs Claude Code sessions in tmux (cc-<name>),
//   3. types your texts into the right session, and
//   4. texts you back when Claude finishes or needs permission (via hook.mjs).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, STATE_DIR, SOCKET_PATH, LOG_FILE, loadConfig, loadState, saveState, expandHome } from './lib/config.mjs'
import * as im from './lib/imessage.mjs'
import { writeHooksFile, resolveClaude, tmuxName, tmuxNewArgs } from './lib/launch.mjs'

const cfg = loadConfig()
const state = loadState()
state.sessions ??= {}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`
  console.log(line); logStream.write(line + '\n')
}

// ---------- iMessage side ----------
let db = im.openDb()
const handles = cfg.handles.length ? cfg.handles : im.detectOwnHandles(db)
const chats = im.selfChats(db, handles)
if (!chats.length) {
  console.error('No self-chat found. Text yourself once from your iPhone, then restart. Handles:', handles)
  process.exit(1)
}
const selfChat = chats[0]
state.lastRowId ??= im.maxRowId(db)
log('hub starting; handles', handles, 'self-chat', selfChat.guid)

const recentlySent = new Map() // normalized text -> time, to ignore our own echoes
const norm = s => s.replace(/\s+/g, ' ').trim()

async function text(body) {
  const full = `${cfg.botPrefix} ${body}`.trim()
  const chunks = []
  for (let i = 0; i < full.length; i += cfg.maxChunk) chunks.push(full.slice(i, i + cfg.maxChunk))
  for (const c of chunks) {
    recentlySent.set(norm(c), Date.now())
    try { await im.send(c, selfChat.guid, selfChat.ident) } catch (e) { log('send failed', e.message) }
  }
}
const say = (name, body) => text(name ? `[${name}] ${body}` : body)

function isEcho(t) {
  const now = Date.now()
  for (const [k, ts] of recentlySent) if (now - ts > 15 * 60_000) recentlySent.delete(k)
  return t.startsWith(cfg.botPrefix) || recentlySent.has(norm(t))
}

function poll() {
  let msgs
  try { msgs = im.newSelfMessages(db, handles, state.lastRowId) }
  catch (e) { log('db error, reopening', e.message); try { db.close() } catch {} db = im.openDb(); return }
  for (const m of msgs) {
    state.lastRowId = Math.max(state.lastRowId, m.rowid)
    if (isEcho(m.text)) continue
    log('inbound', m.text.slice(0, 200))
    handleInbound(m.text).catch(e => { log('handler error', e.stack); say(null, `error: ${e.message}`) })
  }
  if (msgs.length) saveState(state)
}

// ---------- tmux side ----------
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
function tmuxAlive(name) {
  try { tmux('has-session', '-t', `=${tmuxName(name)}`); return true } catch { return false }
}
function screen(name, lines = 25) {
  const out = tmux('capture-pane', '-p', '-J', '-t', `=${tmuxName(name)}:`)
  return out.split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-lines).join('\n')
}
function typeInto(name, body) {
  execFileSync('tmux', ['load-buffer', '-b', 'ccimsg', '-'], { input: body })
  tmux('paste-buffer', '-p', '-d', '-b', 'ccimsg', '-t', `=${tmuxName(name)}:`)
  setTimeout(() => { try { tmux('send-keys', '-t', `=${tmuxName(name)}:`, 'Enter') } catch {} }, 250)
}
const keys = (name, ...k) => tmux('send-keys', '-t', `=${tmuxName(name)}:`, ...k)

writeHooksFile()
const claudeBin = resolveClaude(cfg.claudeBin)

// ---------- sessions ----------
// name -> { name, dir, remote, expect, busy, lastActivity, sessionId, starting }
const sessions = new Map()
for (const [name, meta] of Object.entries(state.sessions)) {
  if (tmuxAlive(name)) sessions.set(name, { ...meta, name, remote: false, busy: false })
}
const persist = () => {
  state.sessions = Object.fromEntries([...sessions].map(([n, s]) => [n, { dir: s.dir, created: s.created }]))
  saveState(state)
}
persist()

function resolveDir(name, dirArg) {
  if (dirArg) return expandHome(dirArg)
  if (cfg.projects[name]) return expandHome(cfg.projects[name])
  const guess = path.join(expandHome(cfg.projectsRoot), name)
  return fs.existsSync(guess) ? guess : null
}

function spawnSession(name, dir, prompt) {
  tmux(...tmuxNewArgs({ name, dir, claudeBin, claudeArgs: cfg.claudeArgs, prompt }))
  const s = { name, dir, created: Date.now(), remote: true, expect: prompt || null, busy: !!prompt, lastActivity: Date.now(), starting: true }
  sessions.set(name, s)
  persist()
  watchStartup(s)
}

// First launch in a new folder shows Claude's "trust this folder?" screen. Auto-accept for
// folders under cfg.autoTrust, otherwise ask you.
function watchStartup(s) {
  let tries = 0, asked = false
  const iv = setInterval(() => {
    if (!sessions.has(s.name) || !s.starting || ++tries > 40) return clearInterval(iv)
    let scr = ''
    try { scr = screen(s.name, 40) } catch { return }
    if (/trust this folder|Is this a project you created/i.test(scr)) {
      const trusted = (cfg.autoTrust || []).some(r => s.dir.startsWith(expandHome(r)))
      if (trusted) { keys(s.name, 'Down', 'Enter'); log('auto-trusted', s.dir) }
      else if (!asked) { asked = true; say(s.name, `Claude asks whether to trust ${s.dir}.\n/trust ${s.name} to accept, /kill ${s.name} to cancel.`) }
    }
  }, 1000)
}

const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago` }
const tilde = p => p.replace(process.env.HOME, '~')

function pickSession(name) {
  if (name) {
    if (!sessions.has(name)) throw new Error(`no session "${name}". /ls to list`)
    return sessions.get(name)
  }
  if (state.active && sessions.has(state.active)) return sessions.get(state.active)
  if (sessions.size === 1) return [...sessions.values()][0]
  throw new Error(sessions.size ? 'which session? use @name or /use name' : 'no sessions yet. /new <name> [dir]')
}

function sendToSession(s, body) {
  s.remote = true; s.expect = body; s.busy = true; s.lastActivity = Date.now()
  state.active = s.name
  typeInto(s.name, body)
}

// ---------- permissions ----------
// id -> { name, conn, summary }
const pending = new Map()
const newId = () => { let id; do { id = Array.from({ length: 4 }, () => 'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)]).join('') } while (pending.has(id)); return id }

function summarizeTool(tool, input = {}) {
  if (tool === 'Bash') return `run: ${input.command}`
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return `${tool.toLowerCase()} ${tilde(input.file_path || input.notebook_path || '')}`
  if (tool === 'WebFetch') return `fetch ${input.url}`
  return `${tool} ${JSON.stringify(input).slice(0, 300)}`
}

function answer(id, behavior) {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  try { p.conn.end(JSON.stringify({ behavior }) + '\n') } catch {}
  return true
}

// ---------- inbound commands ----------
const HELP = `Commands:
/ls  list sessions
/new name [dir] [prompt]  start a session
@name [msg]  switch to (and message) a session
/use name  switch active session
/screen [name] [lines]  show the terminal
/esc [name]  interrupt Claude
/keys [name] Down Enter …  send raw keys
/trust name  accept the folder-trust prompt
/kill name  end a session
y / n [id]  answer a permission request
Anything else goes to the active session (incl. Claude's own /commands like /compact).`

async function handleInbound(t) {
  // permission verdicts: "y", "yes abcd", "no", "deny abcd"
  const v = t.match(/^\s*(y|yes|ok|allow|n|no|deny)\s*([a-z]{4})?\s*$/i)
  if (v && pending.size) {
    const behavior = /^(y|yes|ok|allow)$/i.test(v[1]) ? 'allow' : 'deny'
    let id = v[2]?.toLowerCase()
    if (!id) {
      if (pending.size > 1) return say(null, `${pending.size} requests pending; add the id: ${[...pending].map(([i, p]) => `${i} (${p.name})`).join(', ')}`)
      id = [...pending.keys()][0]
    }
    const p = pending.get(id)
    if (!answer(id, behavior)) return say(null, `no pending request "${id}"`)
    return say(p.name, behavior === 'allow' ? '✅ allowed' : '⛔ denied')
  }

  const at = t.match(/^@(\S+)\s*([\s\S]*)$/)
  if (at) {
    const s = pickSession(at[1])
    state.active = s.name; saveState(state)
    if (at[2].trim()) sendToSession(s, at[2].trim())
    else say(s.name, `now active. ${s.busy ? 'working…' : 'idle'}`)
    return
  }

  const cmd = t.match(/^\/(\w+)\s*([\s\S]*)$/)
  const arg = cmd ? cmd[2].trim() : ''
  const parts = arg ? arg.split(/\s+/) : []
  switch (cmd?.[1]?.toLowerCase()) {
    case 'help': case 'h': return say(null, HELP)
    case 'ls': case 'list': {
      if (!sessions.size) return say(null, 'no sessions. /new <name> [dir]')
      const rows = [...sessions.values()].map(s =>
        `${s.name === state.active ? '▶' : '•'} ${s.name} — ${s.starting ? 'starting' : s.busy ? 'working' : 'idle'}, ${ago(s.lastActivity)}\n   ${tilde(s.dir)}`)
      const waiting = pending.size ? `\n${pending.size} permission request(s) waiting` : ''
      return say(null, rows.join('\n') + waiting)
    }
    case 'new': {
      const [name, maybeDir] = parts
      if (!name || !/^[\w.-]+$/.test(name)) return say(null, 'usage: /new name [dir] [prompt]')
      if (sessions.has(name) || tmuxAlive(name)) return say(null, `"${name}" already exists`)
      const looksLikePath = maybeDir && /^[~/.]/.test(maybeDir)
      const dir = resolveDir(name, looksLikePath ? maybeDir : null)
      if (!dir || !fs.existsSync(dir)) return say(null, `can't find a folder for "${name}". Try /new ${name} ~/path/to/project`)
      const prompt = arg.slice(name.length).trim().slice(looksLikePath ? maybeDir.length : 0).trim()
      spawnSession(name, dir, prompt || null)
      state.active = name; saveState(state)
      return say(name, `starting in ${tilde(dir)}${prompt ? ' with your prompt' : ''}. It's now active.`)
    }
    case 'use': { const s = pickSession(parts[0]); state.active = s.name; saveState(state); return say(s.name, 'now active') }
    case 'screen': case 'sc': {
      const n = parts.find(p => !/^\d+$/.test(p)); const lines = Number(parts.find(p => /^\d+$/.test(p))) || 25
      const s = pickSession(n)
      return say(s.name, '\n' + screen(s.name, lines))
    }
    case 'esc': case 'stop': { const s = pickSession(parts[0]); keys(s.name, 'Escape'); return say(s.name, 'sent Esc (interrupt)') }
    case 'keys': {
      let name = parts[0] && sessions.has(parts[0]) ? parts.shift() : null
      const s = pickSession(name)
      if (!parts.length) return say(null, 'usage: /keys [name] Down Enter')
      keys(s.name, ...parts)
      return setTimeout(() => say(s.name, '\n' + screen(s.name, 15)), 800)
    }
    case 'trust': {
      const s = pickSession(parts[0])
      if (!/trust this folder|Is this a project you created/i.test(screen(s.name, 40))) return say(s.name, 'no trust prompt on screen')
      keys(s.name, 'Down', 'Enter'); return say(s.name, 'trusted, starting up')
    }
    case 'kill': {
      const s = pickSession(parts[0])
      try { tmux('kill-session', '-t', `=${tmuxName(s.name)}`) } catch {}
      for (const [id, p] of pending) if (p.name === s.name) answer(id, null)
      sessions.delete(s.name); if (state.active === s.name) state.active = null; persist()
      return say(s.name, 'killed')
    }
  }
  // Plain text (or a Claude slash command like /compact) -> active session
  sendToSession(pickSession(), t)
}

// ---------- hook socket ----------
function onHook(msg, conn) {
  const reply = (o = {}) => { try { conn.end(JSON.stringify(o) + '\n') } catch {} }
  // `cc-imsg say "..."`: treat text as if you'd texted it (handy for testing/scripts).
  if (msg.type === 'cli') {
    handleInbound(msg.text).catch(e => say(null, `error: ${e.message}`))
    return reply({ ok: true })
  }
  // Adopt sessions started from a terminal with `cc-imsg [name]`.
  if (!sessions.has(msg.name) && msg.type === 'session_start' && tmuxAlive(msg.name)) {
    sessions.set(msg.name, { name: msg.name, dir: msg.cwd, created: Date.now(), remote: false, busy: false, lastActivity: Date.now() })
    persist(); log('adopted', msg.name)
  }
  const s = sessions.get(msg.name)
  if (!s) return reply()
  s.lastActivity = Date.now()
  switch (msg.type) {
    case 'session_start':
      s.starting = false; s.sessionId = msg.session_id
      return reply()
    case 'prompt': {
      // Typed at the Mac instead of from the phone? Then stop relaying until you text again.
      s.remote = s.expect != null && norm(msg.prompt).includes(norm(s.expect).slice(0, 200))
      s.expect = null; s.busy = true; s.starting = false
      return reply()
    }
    case 'stop':
      s.busy = false
      if ((s.remote || cfg.replyMode === 'all') && msg.text) say(s.name, msg.text)
      return reply()
    case 'notification':
      if (s.remote && !['idle_prompt', 'permission_prompt'].includes(msg.kind) && msg.text) say(s.name, `🔔 ${msg.text}\n(/screen ${s.name} to look)`)
      return reply()
    case 'permission_request': {
      if (!s.remote && cfg.replyMode !== 'all') return reply() // you're at the Mac: normal dialog
      const id = newId()
      pending.set(id, { name: s.name, conn, summary: summarizeTool(msg.tool_name, msg.tool_input) })
      conn.on('close', () => pending.delete(id))
      return say(s.name, `🔐 wants to ${summarizeTool(msg.tool_name, msg.tool_input).slice(0, 600)}\nReply y or n${pending.size > 1 ? ` + ${id}` : ''} (id ${id})`)
    }
    case 'session_end':
      if (s.remote) say(s.name, `session ended (${msg.reason})`)
      sessions.delete(s.name); if (state.active === s.name) state.active = null; persist()
      return reply()
  }
  reply()
}

function startSocket() {
  if (fs.existsSync(SOCKET_PATH)) {
    // another hub running?
    const probe = net.createConnection(SOCKET_PATH)
    probe.on('connect', () => { console.error('hub already running'); process.exit(1) })
    probe.on('error', () => { fs.unlinkSync(SOCKET_PATH); startSocket() })
    return
  }
  const server = net.createServer(conn => {
    let buf = ''
    conn.on('data', d => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl >= 0) { const line = buf.slice(0, nl); buf = ''; try { onHook(JSON.parse(line), conn) } catch (e) { log('hook msg error', e.message); conn.end() } }
    })
    conn.on('error', () => {})
  })
  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600)
    log(`listening on ${SOCKET_PATH}; ${sessions.size} session(s) restored`)
    setInterval(poll, cfg.pollMs)
    setInterval(reap, 10_000)
    if (cfg.announce !== false) say(null, `hub online${sessions.size ? ` (${sessions.size} session(s))` : ''}. /help for commands`)
  })
}

// Sessions whose tmux window closed (claude exited, or you killed it at the Mac).
function reap() {
  for (const s of sessions.values()) if (!tmuxAlive(s.name)) {
    sessions.delete(s.name); if (state.active === s.name) state.active = null
    log('reaped', s.name); persist()
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { fs.unlinkSync(SOCKET_PATH) } catch {} saveState(state); process.exit(0) })
startSocket()
