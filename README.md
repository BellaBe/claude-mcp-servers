# Claude Code MCP Servers

Custom MCP servers for Claude Code: Telegram, Gmail, WhatsApp, Calendar, and Email.
Wiring patterns, configuration, and known failure modes — written from production debugging.

---

## Server Registry

| Server | Type | Location | Flag Required | Status |
|--------|------|----------|---------------|--------|
| telegram | channel (push + tools) | `~/.claude/channels/telegram/` | `--dangerously-load-development-channels server:telegram` | active |
| gmail | tool server (pull only) | `~/.claude/channels/gmail/` | none | active |
| whatsapp | channel (push + tools) | `~/.claude/channels/whatsapp/` | `--dangerously-load-development-channels server:whatsapp` | active |
| calendar | tool server (pull only) | `~/.claude/channels/calendar/` | none | active |
| email | tool server (pull only) | `~/.claude/channels/email/` | none | active |

### Channel vs Tool Server

Two kinds of MCP servers. Different wiring.

**Tool servers** — Claude calls them on demand. Register in `~/.claude.json` under `mcpServers`. Available immediately in every session. No startup flags. Gmail is a tool server.

**Channel servers** — they push notifications INTO the session (incoming messages, events). Same registration in `~/.claude.json`, but require a startup flag or Claude Code silently ignores their notifications. Telegram and WhatsApp are channel servers.

A server can be both — it pushes notifications AND exposes tools (reply, react, etc.). Telegram and WhatsApp do this. The channel capability (`experimental: { 'claude/channel': {} }`) is what triggers the flag requirement.

---

## Configuration

### ~/.claude.json — mcpServers block

```json
{
  "mcpServers": {
    "telegram": {
      "type": "stdio",
      "command": "bash",
      "args": ["~/.claude/channels/telegram/telegram-start.sh"],
      "env": {}
    },
    "gmail": {
      "type": "stdio",
      "command": "bash",
      "args": ["~/.claude/channels/gmail/gmail-start.sh"],
      "env": {}
    },
    "whatsapp": {
      "type": "stdio",
      "command": "bash",
      "args": ["~/.claude/channels/whatsapp/whatsapp-start.sh"],
      "env": {}
    },
    "calendar": {
      "type": "stdio",
      "command": "bash",
      "args": ["~/.claude/channels/calendar/calendar-start.sh"],
      "env": {}
    },
    "email": {
      "type": "stdio",
      "command": "bash",
      "args": ["~/.claude/channels/email/email-start.sh"],
      "env": {}
    }
  }
}
```

### Adding a new server

```bash
claude mcp add <name> --scope user -- bash ~/.claude/channels/<name>/<name>-start.sh
```

### Removing a server

```bash
claude mcp remove <name> --scope user
```

---

## Startup

### Standard startup (all channels + tools)

```bash
claude --dangerously-load-development-channels server:telegram server:whatsapp
```

Gmail, Calendar, and Email load automatically — no flag needed.

### With agent

```bash
claude --dangerously-load-development-channels server:telegram server:whatsapp --agent orchestrator
```

**Critical:** if the agent's frontmatter has a `tools` field, MCP tools must be explicitly listed or they are silently excluded. See [Agent Wiring](#agent-wiring).

### Alias

```bash
alias claude-all='claude --dangerously-load-development-channels server:telegram server:whatsapp'
alias claude-all-orch='claude --dangerously-load-development-channels server:telegram server:whatsapp --agent orchestrator'
```

---

## Agent Wiring

When using `--agent`, the agent's frontmatter controls tool access.

### The rule

- `tools` field present → **allowlist**. Only listed tools are available. MCP tools excluded unless listed.
- `disallowedTools` field present → **denylist**. All tools inherited except those listed.
- Neither field → all tools inherited, including MCP.

### Adding MCP tools to an agent

In the agent's frontmatter (e.g., `.claude/agents/orchestrator.md`):

```yaml
---
name: orchestrator
description: ...
tools:
  # built-in tools
  - Read
  - Write
  - Edit
  - Bash
  - Agent
  # ... other built-in tools ...
  # MCP tools — wildcard per server
  - mcp__telegram__*
  - mcp__gmail__*
  - mcp__whatsapp__*
  - mcp__calendar__*
  - mcp__email__*
---
```

**Wildcard pattern:** `mcp__<server-name>__*` grants all tools from that server.

**Specific tools:** `mcp__telegram__reply` grants only the reply tool.

**If you add a new MCP server**, you must also add its tools to every agent that needs them. This is the most common wiring failure.

---

## Known Failure Modes

### 1. Official plugin conflicts (CRITICAL)

**Symptom:** Telegram 409 Conflict errors. Two processes polling the same bot token.

**Cause:** Claude Code ships an official `telegram` plugin via the marketplace. If installed, it competes with your custom `telegram` MCP server for the bot's polling slot.

**Fix:**
```bash
claude plugin uninstall telegram
```

Then verify the plugin entry is gone from `~/.claude.json`:
```bash
grep -n '"plugin": "telegram"' ~/.claude.json
```

If still present, manually delete the `{"marketplace": "claude-plugins-official", "plugin": "telegram"}` block.

**Hazard:** Claude Code updates may re-enable or re-install the official plugin. After every upgrade, check:
```bash
grep '"plugin": "telegram"' ~/.claude.json
```

### 2. Messages arrive but tools unavailable

**Symptom:** `← telegram · user: Test` appears but Claude says "reply tool isn't available."

**Cause (most common):** Agent frontmatter has a `tools` allowlist that doesn't include MCP tools. See [Agent Wiring](#agent-wiring).

**Cause (less common):** Session started without `--dangerously-load-development-channels`. Channel notifications may still flow via the MCP connection, but tools are suppressed.

**Cause (rare):** MCP tool descriptions exceed the 2KB cap (introduced v2.1.86). Check:
```bash
# Count instruction bytes in server source
grep -oP 'instructions:\s*[`'"'"'"](.+?)[`'"'"'"]' server.ts | wc -c
```

### 3. claude.ai connector collision

**Symptom:** Local MCP server works intermittently or tools appear duplicated.

**Cause:** Same service connected as both a claude.ai connector AND a local MCP server (e.g., Gmail). v2.1.86 deduplicates — local wins — but the connector still shows "Needs authentication" and may interfere.

**Fix:** Disconnect the claude.ai connector for any service you run locally:
- In Claude Code: `/mcp` → find the claude.ai connector → disconnect
- Or via CLI: check available options with `claude connector --help`

**Rule:** One path per service. Either claude.ai connector OR local MCP server. Never both.

### 4. Startup script permissions

**Symptom:** Server listed in `~/.claude.json` but doesn't spawn. No process visible.

**Cause:** Startup scripts lack execute permission. Claude Code runs them with `bash`, so `+x` isn't strictly required — but some versions may use `exec` which needs it.

**Fix:**
```bash
chmod +x ~/.claude/channels/*/start*.sh
```

### 5. Zombie polling processes

**Symptom:** 409 Conflict on Telegram even after removing the official plugin.

**Cause:** Previous session's server process still running, holding the poll.

**Fix:**
```bash
pkill -f telegram-start
pkill -f "server.ts"
pkill -f "server.mjs"
# Verify
ps aux | grep -E "(telegram|gmail|whatsapp|calendar|email)" | grep -v grep
```

Then restart Claude Code.

### 6. WhatsApp session expiry

**Symptom:** WhatsApp server starts but shows "Waiting for chats" or QR code prompt.

**Cause:** `whatsapp-web.js` session in `.wwebjs_auth/` expired (phone went offline too long, or Meta pushed a Web version update).

**Fix:** Delete the session and re-pair. The QR code prints to stderr, which MCP's stdio transport captures — so you won't see it when launched from Claude Code. Run standalone instead:
```bash
rm -rf ~/.claude/channels/whatsapp/.wwebjs_auth/
cd ~/.claude/channels/whatsapp && node server.mjs 2>&1
# QR prints directly to terminal — scan immediately (expires in ~20s)
# Once paired, kill it (Ctrl-C), then start Claude Code normally.
# Session persists in .wwebjs_auth/ — no QR needed again unless it expires.
```

### 7. Gmail OAuth token expiry

**Symptom:** Gmail server connects but all tool calls return auth errors.

**Cause:** OAuth refresh token expired or was revoked.

**Fix:**
```bash
# Re-run the auth flow to get a fresh refresh token:
./gmail-start.sh --auth
```

---

## Post-Upgrade Checklist

Run after every Claude Code version update:

```bash
# 1. Check version
claude --version

# 2. Check for re-installed official plugins
grep '"plugin": "telegram"' ~/.claude.json && echo "WARNING: official telegram plugin re-appeared — remove it"

# 3. Verify MCP server entries still exist
cat ~/.claude.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
servers = d.get('mcpServers', {})
for name in ['telegram', 'gmail', 'whatsapp', 'calendar', 'email']:
    status = 'OK' if name in servers else 'MISSING'
    print(f'  {name}: {status}')
"

# 4. Check startup script permissions
ls -la ~/.claude/channels/*/start*.sh

# 5. Test each server manually
cd ~/.claude/channels/telegram && bash telegram-start.sh 2>&1 | head -5
cd ~/.claude/channels/gmail && bash gmail-start.sh 2>&1 | head -5
cd ~/.claude/channels/whatsapp && bash whatsapp-start.sh 2>&1 | head -5
cd ~/.claude/channels/calendar && bash calendar-start.sh --check
cd ~/.claude/channels/email && bash email-start.sh --check

# 6. Start session and verify tools
claude --dangerously-load-development-channels server:telegram server:whatsapp
# Inside session: /mcp → check all servers show tools
```

---

## File Structure

```
~/.claude/
├── claude.json                    # MCP server registry (mcpServers block)
├── channels/
│   ├── telegram/
│   │   ├── server.ts              # MCP server (channel + tools)
│   │   ├── telegram-start.sh      # startup script (loads secrets from pass)
│   │   ├── package.json
│   │   ├── access.json            # runtime state (allowlist, groups, pending)
│   │   ├── debug.log
│   │   └── node_modules/
│   ├── gmail/
│   │   ├── server.ts              # MCP server (tools only, no channel)
│   │   ├── auth.ts                # one-time OAuth2 authorization
│   │   ├── gmail-start.sh         # startup script (loads secrets from pass)
│   │   ├── package.json
│   │   └── node_modules/
│   ├── whatsapp/
│   │   ├── server.mjs             # MCP server (channel + tools)
│   │   ├── whatsapp-start.sh      # startup script
│   │   ├── package.json
│   │   ├── access.json
│   │   ├── debug.log
│   │   ├── inbox/                 # downloaded media
│   │   ├── .wwebjs_auth/          # puppeteer session (auto-created)
│   │   └── node_modules/
│   ├── calendar/
│   │   ├── server.ts              # MCP server (tools only — CalDAV + Cal.com)
│   │   ├── calendar-start.sh      # startup script
│   │   ├── package.json
│   │   ├── debug.log
│   │   └── node_modules/
│   └── email/
│       ├── server.ts              # MCP server (tools only — IMAP + SMTP/Resend)
│       ├── email-start.sh         # startup script
│       ├── package.json
│       ├── debug.log
│       └── node_modules/
├── secrets/
│   ├── secret.sh                  # GPG-encrypted credential manager
│   └── README.md                  # setup and usage docs
└── agents/                        # (project-level agents reference MCP tools in frontmatter)
```

---

## Secrets

All credentials are stored in `pass` (GPG-encrypted `~/.password-store/`). Managed by `secrets/secret.sh`.

### Security model

Servers load secrets at startup by spawning `secret.sh get <channel> <key>` via `spawnSync`. Credentials are stored in local TypeScript `const` variables — never in `process.env`.

| Layer | Claude can access? |
|-------|--------------------|
| `~/.password-store/*.gpg` | No — GPG-encrypted |
| `process.env` at runtime | No — secrets not in env |
| `/proc/<pid>/environ` | No — nothing to read |
| TypeScript heap variables | No — no filesystem exposure |

The startup script only passes the `SECRET_CMD` path (to `secret.sh`) as an env var. The server deletes it from `process.env` immediately after loading secrets.

### Setup

```bash
# One-time: install pass + GPG
sudo apt install pass gnupg
gpg --gen-key
pass init <gpg-key-id>

# Store credentials per server
./secrets/secret.sh set calendar caldav-url "https://..."
./secrets/secret.sh set calendar caldav-username "user@example.com"
./secrets/secret.sh set calendar caldav-password "app-password"

./secrets/secret.sh set email imap-host "imap.fastmail.com"
./secrets/secret.sh set email imap-user "user@example.com"
./secrets/secret.sh set email imap-pass "app-password"
./secrets/secret.sh set email smtp-host "smtp.fastmail.com"

# Or use interactive setup
./calendar/calendar-start.sh --configure
./email/email-start.sh --configure
```

### GPG cache for MCP startup

Claude Code spawns startup scripts as subprocesses with no TTY. Prime the GPG cache before starting:

```bash
pass show claude-calendar/caldav-url > /dev/null && claude
```

### Storage layout

```
~/.password-store/
  claude-telegram/
    bot-token.gpg
    admin-id.gpg
  claude-gmail/
    client-id.gpg
    client-secret.gpg
    refresh-token.gpg
  claude-calendar/
    caldav-url.gpg
    caldav-username.gpg
    caldav-password.gpg
    calcom-api-key.gpg        # optional
    calcom-base-url.gpg        # optional
  claude-email/
    imap-host.gpg
    imap-port.gpg
    imap-user.gpg
    imap-pass.gpg
    smtp-host.gpg              # optional if using Resend
    smtp-port.gpg
    smtp-user.gpg
    smtp-pass.gpg
    smtp-from.gpg
    resend-api-key.gpg         # optional alternative to SMTP
    resend-from.gpg
```

---

## Adding a New Channel Server

Checklist for wiring a new channel:

1. **Build** the server at `~/.claude/channels/<name>/`
2. **Create** startup script: `<name>-start.sh`
3. **Set permissions:** `chmod +x <name>-start.sh`
4. **Register:** `claude mcp add <name> --scope user -- bash ~/.claude/channels/<name>/<name>-start.sh`
5. **Add to agent frontmatter:** `mcp__<name>__*` in every agent's `tools` list that needs it
6. **Add to startup alias:** update `claude-all` alias with `server:<name>`
7. **Test without agent first:** confirm tools appear in `/mcp`
8. **Test with agent:** confirm tools still appear
9. **Document** in this registry table

---

## Adding a New Tool Server

Same as above except:
- No `--dangerously-load-development-channels` flag needed
- No `server:<name>` in startup alias
- Server starts automatically from `~/.claude.json` registration
- Still needs `mcp__<name>__*` in agent frontmatter if using `--agent`

---

## Version History

| Date | Version | Issue | Resolution |
|------|---------|-------|------------|
| 2026-03-21 | ~2.1.8x | Telegram not receiving messages | Missing `--dangerously-load-development-channels` flag |
| 2026-03-21 | ~2.1.8x | 409 Conflict on Telegram | Official plugin competing with custom server — `claude plugin uninstall telegram` |
| 2026-03-28 | 2.1.86 | All MCP tools unavailable | Official plugin re-enabled by permission fix in v2.1.83→v2.1.86; agent frontmatter `tools` allowlist missing MCP entries |
| 2026-03-28 | 2.1.86 | Gmail connector collision | claude.ai Gmail connector + local server = dedup conflict. Rule: one path per service |