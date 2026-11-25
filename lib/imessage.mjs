// iMessage I/O: read new self-chat messages from chat.db, send via AppleScript.
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export const CHAT_DB = path.join(os.homedir(), 'Library/Messages/chat.db')

export function openDb() {
  return new DatabaseSync(CHAT_DB, { readOnly: true })
}

// Text is often NULL on modern macOS; the body lives in attributedBody
// (an NSAttributedString in Apple's "typedstream" format). Pull the NSString out.
export function decodeAttributedBody(buf) {
  if (!buf) return null
  buf = Buffer.from(buf)
  let i = buf.indexOf('NSString')
  if (i < 0) return null
  i = buf.indexOf(0x2b, i + 8) // '+' marks the start of the string payload
  if (i < 0) return null
  i += 1
  let len = buf[i]; i += 1
  if (len === 0x81) { len = buf.readUInt16LE(i); i += 2 }
  else if (len === 0x82) { len = buf.readUInt32LE(i); i += 4 }
  return buf.subarray(i, i + len).toString('utf8')
}

// Your own handles, as Messages knows them (used when config.handles is empty).
export function detectOwnHandles(db) {
  const rows = db.prepare(
    "SELECT DISTINCT account FROM message WHERE is_from_me = 1 AND account LIKE '_:%'"
  ).all()
  return [...new Set(rows.map(r => r.account.slice(2)))]
}

export function maxRowId(db) {
  return db.prepare('SELECT MAX(ROWID) AS m FROM message').get().m || 0
}

// The self-chat thread(s): 1:1 chats (style 45) whose identifier is one of your handles.
export function selfChats(db, handles) {
  const q = handles.map(() => '?').join(',')
  return db.prepare(
    `SELECT ROWID AS id, guid, chat_identifier AS ident FROM chat WHERE style = 45 AND chat_identifier IN (${q})`
  ).all(...handles)
}

// New inbound copies of self-chat messages after `since`. In a self-chat every message
// is stored twice (is_from_me 1 and 0); we take only the "received" copy, sent by one of your handles.
export function newSelfMessages(db, handles, since) {
  const q = handles.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT m.ROWID AS rowid, m.text, m.attributedBody AS body, m.associated_message_type AS amt,
            c.guid AS chat_guid, h.id AS sender
       FROM message m
       JOIN chat_message_join j ON j.message_id = m.ROWID
       JOIN chat c ON c.ROWID = j.chat_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ? AND m.is_from_me = 0 AND c.style = 45
        AND c.chat_identifier IN (${q}) AND h.id IN (${q})
      ORDER BY m.ROWID`
  ).all(since, ...handles, ...handles)
  return rows
    .filter(r => !r.amt) // skip tapbacks/reactions
    .map(r => ({ rowid: r.rowid, chatGuid: r.chat_guid, sender: r.sender, text: (r.text ?? decodeAttributedBody(r.body) ?? '').trim() }))
    .filter(r => r.text && r.text !== '￼')
}

const SEND_SCRIPT = `
on run argv
  set msg to item 1 of argv
  set target to item 2 of argv
  tell application "Messages"
    try
      send msg to chat id target
    on error
      set svc to 1st account whose service type = iMessage
      send msg to participant (item 3 of argv) of svc
    end try
  end tell
end run`

// Serialized so multi-part replies arrive in order.
let queue = Promise.resolve()
export function send(text, chatGuid, handle) {
  const p = queue.then(() => new Promise((resolve, reject) => {
    execFile('osascript', ['-e', SEND_SCRIPT, text, chatGuid, handle], { timeout: 20000 }, err =>
      err ? reject(err) : resolve())
  }))
  queue = p.catch(() => {})
  return p
}
