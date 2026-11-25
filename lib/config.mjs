// Shared config + paths. Personalize in ../config.json (see config.example.json).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STATE_DIR = process.env.CC_IMSG_STATE_DIR || path.join(os.homedir(), '.claude-imessage')
export const SOCKET_PATH = path.join(STATE_DIR, 'hub.sock')
export const STATE_FILE = path.join(STATE_DIR, 'state.json')
export const LOG_FILE = path.join(STATE_DIR, 'hub.log')

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

const DEFAULTS = {
  // Your own iMessage handles (phone in +E.164, Apple ID emails). Only messages
  // in the self-chat with these handles are accepted. Empty = auto-detect.
  handles: [],
  // Prefix on everything the hub sends, so its own echoes are never re-read as commands.
  botPrefix: '🤖',
  // How often to poll chat.db (ms).
  pollMs: 1000,
  // Shortcuts: "/new api" -> ~/code/api. Values may use ~.
  projects: {},
  // If "/new foo" has no dir and no project alias, try <projectsRoot>/foo.
  projectsRoot: '~/',
  // Extra args for every spawned claude, e.g. ["--permission-mode", "acceptEdits"].
  claudeArgs: [],
  // Path to the claude binary.
  claudeBin: 'claude',
  // Max characters per outbound iMessage (longer replies are split).
  maxChunk: 3000,
}

export function expandHome(p) {
  if (!p) return p
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

export function loadConfig() {
  const file = path.join(ROOT, 'config.json')
  let user = {}
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { ...DEFAULTS, ...user }
}

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

export function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}
