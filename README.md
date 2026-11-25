# claude-imessage

Run Claude Code on your Mac by texting yourself. Start sessions, switch between them, and approve commands from your phone. Replies come back as iMessages.

```
you:  /new api fix the flaky login test
mac:  🤖 [api] starting in ~/api with your prompt.

mac:  🤖 [api] 🔐 wants to run: npm test -- login.spec.ts
      Reply y or n
you:  y

mac:  🤖 [api] Fixed. The test was racing the session cookie, it now waits
      for the redirect. 14/14 passing.
you:  @web what's left on the navbar ticket?
```

It's for when you're away from your desk, not a replacement for sitting at it. Every session is a normal Claude Code terminal you can attach to later.

## Installation

You need macOS with Messages signed in, Node 22.5+, tmux, and Claude Code.

```sh
git clone https://github.com/dukemdiamond/claude-imessage
cd claude-imessage
npm install && npm link
cc-imsg hub
```

Run the hub from a terminal that has Full Disk Access, since it reads `~/Library/Messages/chat.db`. When it starts, you'll get a "hub online" text in your chat with yourself.

## Usage

Text yourself:

```
/new api                start a session in ~/api
/new api ~/work/api     ...or in a specific folder
@api run the tests      talk to a session (it becomes the active one)
y / n                   answer a permission request
/ls                     list sessions
/screen                 see the terminal
/esc                    interrupt
/kill api               end a session
```

Anything else goes to the active session, including Claude's own commands like `/compact`. Text `/help` for the full list.

At your Mac, `cc-imsg attach api` drops you into a session you started from your phone. `cc-imsg` on its own starts one in the current folder.

To give your projects short names, copy `config.example.json` to `config.json` and fill in `projects`.

## How it works

The hub polls your self-chat in the Messages database and pastes each new text into a Claude Code session running in tmux. Those sessions load a few hooks. When Claude finishes a turn, the final message goes back to the hub, and the hub sends it to you with AppleScript. When Claude asks for permission, the hook waits for your y or n.

If you type into a session at your Mac, it stops texting you about that session. Your phone only buzzes for work you started from it.

The hooks are only loaded into sessions the hub starts, so your normal Claude Code setup isn't touched.

## License

MIT
