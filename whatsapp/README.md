# WhatsApp Channel for Claude Code

Two-way WhatsApp bridge using whatsapp-web.js. Messages push into Claude Code, Claude replies back.

**Use a secondary phone number.** WhatsApp can ban accounts for automated behavior.

## How it works

```
WhatsApp ←→ whatsapp-web.js (puppeteer/chromium) ←→ MCP Server (stdio) ←→ Claude Code
```

Unlike Telegram (bot token), WhatsApp uses your actual account via WhatsApp Web. The library runs a headless Chromium instance that connects to WhatsApp's servers using the Web protocol.

## Safety measures

- **Human-like reply delay** (2-5s configurable) before every outbound message
- **Typing indicator** simulated proportional to message length
- **Rate limiting** (30 replies/hour default, configurable)
- **Allowlist** — only specified phone numbers trigger notifications
- **No bulk messaging** — single message replies only

## Setup

### 1. Place files

```bash
cp -r whatsapp-channel/* ~/.claude/channels/whatsapp/
cd ~/.claude/channels/whatsapp
```

### 2. Install dependencies

```bash
npm install
```

Note: uses `node` + `npm`, not `bun`. Puppeteer has better Node.js compatibility. First install downloads Chromium (~170MB).

### 3. Validate

```bash
./whatsapp-start.sh --check
```

### 4. Register

```bash
claude mcp add whatsapp --scope user -- bash ~/.claude/channels/whatsapp/whatsapp-start.sh
```

### 5. First start — QR scan

Start Claude Code with the channel:

```bash
claude --dangerously-load-development-channels server:telegram server:whatsapp
```

On first start, the server prints a QR code to the terminal. Scan it with WhatsApp on your **secondary phone** (Settings → Linked Devices → Link a Device).

After scanning, the session persists in `~/.claude/channels/whatsapp/.wwebjs_auth/`. No QR needed on subsequent starts unless the session expires.

### 6. Configure allowlist

In Claude Code, ask Claude:
- "add my number to the whatsapp allowlist: 971501234567"
- Or use the tool directly: `manage_access` with action `add` and phone `971501234567`

Phone numbers use digits only — no `+`, spaces, or dashes.

## Tools

| Tool | What it does |
|------|-------------|
| `reply` | Send message with human-like delay + typing indicator |
| `react` | React with emoji |
| `get_contacts` | List known WhatsApp contacts |
| `fetch_messages` | Pull recent messages from a chat (WhatsApp has history, unlike Telegram) |
| `download_media` | Download images/docs/audio from a message |
| `manage_access` | Add/remove from allowlist, set rate limit |

## Access control

`access.json` in the state directory:

```json
{
  "allowFrom": ["971501234567", "44771234567"],
  "groups": {},
  "replyDelayMin": 2000,
  "replyDelayMax": 5000,
  "maxRepliesPerHour": 30
}
```

- **Empty allowlist** = all contacts allowed (initial setup only)
- **Groups** = add group chat IDs to enable group message forwarding
- **Rate limit** = replies per hour, configurable via `manage_access` tool

## State

```
~/.claude/channels/whatsapp/
├── server.mjs          # MCP channel server
├── whatsapp-start.sh   # startup script
├── package.json
├── access.json         # allowlist + rate config (runtime)
├── debug.log           # diagnostics
├── .wwebjs_auth/       # puppeteer session data (auto-created)
└── inbox/              # downloaded media
```

No secrets on disk — WhatsApp uses session-based auth (QR scan), not tokens.

## Startup alias (all channels)

```bash
alias claude-all='pass show claude-gmail/client-id > /dev/null && pass show claude-telegram/bot-token > /dev/null && claude --dangerously-load-development-channels server:telegram server:whatsapp'
```

Gmail tools load automatically (no channel flag needed).

## Troubleshooting

**"WhatsApp not ready"** — QR scan needed. Run standalone to pair: `cd ~/.claude/channels/whatsapp && node server.mjs 2>&1` — scan the QR immediately, then kill and restart via Claude Code.

**Session expired** — WhatsApp occasionally invalidates linked sessions. Run `./whatsapp-start.sh --reset-session` and re-scan.

**"Still waiting for chats"** — Known whatsapp-web.js issue after WhatsApp Web updates. Check for library updates: `npm update whatsapp-web.js`

**Chromium won't start** — On headless Linux/WSL, you may need: `sudo apt install -y libgbm-dev libnss3 libatk-bridge2.0-0 libdrm2`

**Rate limit hit** — Increase via Claude: "set whatsapp rate limit to 60 per hour" or `manage_access` with `set_rate`.

## Differences from Telegram channel

| | Telegram | WhatsApp |
|---|---|---|
| Auth | Bot token (static) | QR scan (session) |
| Runtime | Lightweight (HTTP poll) | Heavy (Chromium ~400MB) |
| History | No API | `fetch_messages` works |
| Reply safety | None needed (it's a bot) | Delay + typing + rate limit |
| Ban risk | None | Real — use secondary number |
| Secrets | In `pass` | None (session-based) |