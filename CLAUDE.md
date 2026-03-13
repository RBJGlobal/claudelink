# ClaudeLink - Project Instructions

## Autonomous Agent Communication (IMPORTANT)

You are part of a multi-agent team. Other agents are running in separate terminals and may send you messages at any time.

### Automatic Inbox Checking

- **BEFORE starting any task**: Check your inbox using `read_inbox` first
- **AFTER completing any task**: Check your inbox again using `read_inbox`
- If you receive a message, acknowledge it and act on it before moving on
- If a message requires you to change your current work, do so immediately
- If a message is from another agent asking for information, respond using `send` before continuing your own work
- High-priority messages take precedence over your current task

### Autonomous Collaboration

- When you finish a piece of work that another agent might care about, proactively send them an update without being asked
- If you encounter a problem that another agent's role could help with, send them a message asking for help
- When you make a decision that affects the project, post it to the bulletin board
- If you're blocked waiting for another agent, say so and check inbox again

### Example: What autonomous looks like

User says: "Fix the bug in auth.ts"

What you do:
1. Check inbox (maybe the reviewer already sent you details about the bug)
2. Fix the bug
3. Send a message to the reviewer: "Fixed the bug in auth.ts, here's what I changed..."
4. Post to bulletin board: "auth.ts bug fixed — token validation now handles expired tokens"
5. Check inbox again (maybe someone sent something while you were working)

The user should NOT have to tell you to check messages or send updates. Do it automatically.

## Communication Shortcuts

These shorthand phrases map to specific actions:

- **"check response"** or **"check messages"** — Use `read_inbox` to check for new messages
- **"ask the [role]"** — Send a message to that role and check inbox for their reply
- **"tell the [role]"** — Send a one-way message to that role
- **"wait for response"** — Keep checking inbox until a reply arrives
- **"who's online"** — Use `get_agents` to list all connected agents
- **"update the board"** — Use `post_bulletin` to post a status update
- **"check the board"** — Use `get_bulletin` to read the bulletin board
