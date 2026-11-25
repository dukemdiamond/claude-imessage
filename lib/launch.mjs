// How hub-managed claude sessions are launched (shared by hub.mjs and bin/cc-imsg).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, STATE_DIR } from './config.mjs'

export const HOOKS_FILE = path.join(STATE_DIR, 'hooks.json')

// Hooks are injected per-session with --settings, so your global ~/.claude config is untouched.
export function writeHooksFile() {
  const command = `"${process.execPath}" "${path.join(ROOT, 'hook.mjs')}"`
  const hook = timeout => [{ hooks: [{ type: 'command', command, ...(timeout && { timeout }) }] }]
  fs.writeFileSync(HOOKS_FILE, JSON.stringify({
    hooks: {
      SessionStart: hook(), UserPromptSubmit: hook(), Stop: hook(), Notification: hook(),
      SessionEnd: hook(5), PermissionRequest: hook(600),
    },
  }, null, 2))
  return HOOKS_FILE
}

export function resolveClaude(bin = 'claude') {
  try { return execFileSync('/bin/zsh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).trim() || bin } catch { return bin }
}

export const tmuxName = name => `cc-${name}`
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

// Args for `tmux new-session` that run claude for session `name` in `dir`.
export function tmuxNewArgs({ name, dir, claudeBin, claudeArgs = [], prompt, detached = true }) {
  const cmd = [claudeBin, '--settings', HOOKS_FILE, ...claudeArgs, ...(prompt ? [prompt] : [])]
  return ['new-session', ...(detached ? ['-d'] : []), '-s', tmuxName(name), '-x', '160', '-y', '50',
    '-c', dir, '-e', `CC_IMSG_NAME=${name}`, cmd.map(shq).join(' ')]
}
