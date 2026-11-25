# claude-imessage

Text your Mac to drive Claude Code.

You send iMessages to yourself from your phone. A small daemon on your Mac picks them up, types them into Claude Code sessions running in tmux, and texts you back when Claude is done or needs permission to run something.

```
you:     /new api fix the flaky login test
mac:     🤖 [api] starting in ~/api with your prompt. It's now active.
         ...
mac:     🤖 [api] 🔐 wants to run: npm test -- login.spec.ts
         Reply y or n (id kqtz)
you:     y
mac:     🤖 [api] Fixed. The test was racing the session cookie; it now
         waits for the redirect. 14/14 passing. Changed: src/auth/login.ts
you:     @web what's left on the navbar ticket?
```

You can run several sessions and switch between them, and any session can be picked up at the Mac with `tmux attach`.

## Requirements

- macOS, signed in to Messages with your Apple ID
- Node 22.5+ (it uses the built-in `node:sqlite`)
- tmux
- Claude Code, logged in

## Install

```sh
git clone https://github.com/dukemdiamond/claude-imessage
cd claude-imessage
npm install
npm link            # puts cc-imsg on your PATH
cp config.example.json config.json
```

Put your phone number and Apple ID email in `handles` in `config.json`. You can also leave it empty and the hub will work them out from your Messages history.

Start the hub:

```sh
cc-imsg hub
```

Your phone should get a "hub online" text. If it doesn't, check two things:

1. The terminal you started the hub from needs **Full Disk Access** (System Settings → Privacy & Security). Without it, it can't read `~/Library/Messages/chat.db`.
2. The first send asks to let your terminal control Messages. Allow it.

I keep the hub in its own tmux window: `tmux new -d -s imsg-hub cc-imsg hub`.

## Usage

Text these to yourself:

```
/ls                          list sessions (▶ marks the active one)
/new api                     start a session in ~/api (or a folder from config)
/new api ~/code/api <prompt> start in a specific folder, optionally with a prompt
@api <message>               switch to api and send it something
/use api                     switch without sending
y / n                        answer a permission request (y abcd if several are waiting)
/screen [name] [lines]       show the bottom of the terminal
/esc [name]                  interrupt Claude
/keys [name] Down Enter      send raw keys, for menus and pickers
/trust name                  accept the "trust this folder?" prompt
/kill name                   end a session
/help
```

Anything else goes to the active session as a prompt. That includes Claude Code's own slash commands, so `/compact` and `/model sonnet` work too.

At the Mac:

```sh
cc-imsg              # start a session named after the current folder, or attach to it
cc-imsg attach api   # jump into a session you started from your phone
cc-imsg ls
cc-imsg say "/ls"    # act as if you'd texted it, useful for testing
cc-imsg log
```

If you type into a session at the Mac, it stops texting you about that session until the next time you message it from your phone. So your phone only buzzes for work you started from it.

## Config

`config.json`:

| key | default | what it does |
|---|---|---|
| `handles` | `[]` | your own phone/email; only the self-chat with these is read |
| `projects` | `{}` | short names, e.g. `{"api": "~/work/api"}` |
| `projectsRoot` | `~/` | where `/new foo` looks when `foo` isn't in `projects` |
| `autoTrust` | `[]` | folders whose trust prompt gets accepted for you |
| `claudeArgs` | `[]` | extra flags for every session, e.g. `["--model", "sonnet"]` |
| `replyMode` | `"phone"` | `"all"` texts you about every turn, not just phone-started ones |
| `botPrefix` | `🤖` | marks outgoing texts; inbound texts starting with it are ignored |

## How it works

```
iPhone ─▶ iMessage self-chat ─▶ chat.db ─▶ hub.mjs ─▶ tmux paste ─▶ claude (cc-<name>)
   ▲                                          │                        │
   └──────────── AppleScript ◀────────────────┴──── hook.mjs ◀─────────┘
```

- `hub.mjs` polls `chat.db` for new messages in your self-chat. Every message there is stored twice, as a sent copy and a received copy. The hub reads the received copy and skips its own echoes.
- Each session is a normal interactive `claude` in a tmux session named `cc-<name>`. Your texts are pasted in with bracketed paste, so multi-line messages arrive as one prompt.
- Sessions are started with `claude --settings ~/.claude-imessage/hooks.json`. Those hooks (`hook.mjs`) report back to the hub over a unix socket:
  - `Stop` sends Claude's final message for the turn.
  - `PermissionRequest` blocks until you reply y or n. If you're at the Mac instead, it returns right away and you get the normal dialog.
- None of this touches your global `~/.claude` settings. Sessions you start the usual way aren't affected.

## Why not the official iMessage plugin?

Anthropic ships an [iMessage channel](https://code.claude.com/docs/en/channels) for Claude Code. It's a good choice for texting one session you already have open. I wanted to start, list, and switch between sessions from my phone. Also, channels are a research preview that organizations can turn off. This project only uses tmux and hooks, so it works on any plan.

`experimental/channel.mjs` is a channel server built on the same hub socket, in case you'd rather use channels.

## Caveats

- Your Mac has to be awake with Messages signed in. Texts sent while it's asleep get handled when it wakes up.
- Anyone who can text from your Apple ID can run commands on your Mac. That's your own devices, but think about it before turning on `autoTrust` or `--dangerously-skip-permissions`.
- In-terminal menus (model pickers, multiple-choice questions) need `/screen` plus `/keys`.
- `chat.db` isn't a public API. A macOS update could change the schema.

## License

MIT
