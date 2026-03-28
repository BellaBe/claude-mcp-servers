# Telegram Channel for Claude Code

Forked from the official Claude Code Telegram plugin. Key differences:
- **Access management happens directly in Telegram** via admin bot commands — no need to switch to the terminal
- **Credentials stored in GPG-encrypted storage** (`pass`), not plaintext `.env` files — see [claude-secrets](https://github.com/AhmedKElGamil/claude-secrets)

## Setup

```bash
# 1. Install dependencies
cd telegram-channel && bun install

# 2. Store credentials (always quote the token — it contains a colon)
~/claude-secrets/secret.sh set telegram bot-token "123456789:AAHfiqksKZ8..."
~/claude-secrets/secret.sh set telegram admin-id "YOUR_NUMERIC_ID"

# 3. Verify token works
curl "https://api.telegram.org/bot$(pass show claude-telegram/bot-token)/getMe"

# 4. Validate everything
./telegram-start.sh --check
```

### Getting your credentials

| What | Where |
|------|-------|
| Bot token | Message [@BotFather](https://t.me/BotFather) → `/newbot` |
| Your user ID | Message [@userinfobot](https://t.me/userinfobot) |

### Claude Code integration

Add to your `.claude.json` or project settings:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "bash",
      "args": ["/path/to/telegram-channel/telegram-start.sh"]
    }
  }
}
```

**Important:** The start script decrypts credentials from `pass` at launch. GPG needs a cached passphrase — prime it before starting Claude Code:

```bash
pass show claude-telegram/bot-token > /dev/null && claude --dangerously-load-development-channels server:telegram
```

Or as an alias:

```bash
alias claude-tg='pass show claude-telegram/bot-token > /dev/null && claude --dangerously-load-development-channels server:telegram'
```

## Admin Commands (Telegram)

All admin commands are DM-only and gated behind your `TELEGRAM_ADMIN_USER_ID`.

| Command | What it does |
|---------|-------------|
| `/start` | Shows admin command list |
| `/status` | Policy, allowlist, pending pairings |
| `/pair <code>` | Approve a pending pairing |
| `/deny <code>` | Reject a pending pairing |
| `/allow <userId>` | Direct-add to allowlist |
| `/remove <userId>` | Remove from allowlist |
| `/policy <mode>` | Set DM policy: `pairing`, `allowlist`, `disabled` |
| `/config <key> <value>` | Delivery settings (see below) |

### Config keys

| Key | Values | Default |
|-----|--------|---------|
| `ackReaction` | Any Telegram-whitelisted emoji, or `""` to disable | (none) |
| `replyToMode` | `off`, `first`, `all` | `first` |
| `textChunkLimit` | `1`–`4096` | `4096` |
| `chunkMode` | `length`, `newline` | `length` |

## Pairing Flow

1. Someone DMs your bot → bot replies "pairing required, waiting for admin"
2. You (admin) run `/pair` in Telegram → see pending codes
3. `/pair <code>` → approved. Bot confirms to both sides.
4. Once everyone's in: `/policy allowlist` to lock it down.

## State

```
~/.claude/channels/telegram/
  access.json   — policy, allowlist, pending pairings, config
  debug.log     — server debug output (tail -f to troubleshoot)
  inbox/        — downloaded attachments
  approved/     — transient approval signals

~/.password-store/claude-telegram/
  bot-token.gpg   — encrypted bot token
  admin-id.gpg    — encrypted admin user ID
```

Credentials are **not** in the channel directory. They live in GPG-encrypted storage, separate from anything Claude can read.

## Tips

**Remove the official plugin skills** — The Telegram plugin ships with skills (`/telegram:access`, `/telegram:configure`) that load into Claude's context every message. They eat tokens and often get stuck mid-process. Since this fork manages access via bot commands, you don't need them. Delete the `skills/` folder from the plugin directory.

**Lock down GPG cache** — Shorten the passphrase cache so Claude can't decrypt tokens even if it tries:

```bash
echo "default-cache-ttl 60
max-cache-ttl 300" > ~/.gnupg/gpg-agent.conf
gpg-connect-agent reloadagent /bye
```

## Troubleshooting

**"Secrets not found" on start** — GPG cache expired. Run `pass show claude-telegram/bot-token > /dev/null` and enter your passphrase, then reconnect.

**Bot starts but Claude doesn't respond** — Check the Claude Code terminal. If it's at the `❯` prompt, press Enter — known issue where the REPL doesn't wake on async notifications. Restart the session if it persists.

**409 Conflict on startup** — Another bot instance is polling with the same token. Kill stale processes: `pkill -f "bun.*server.ts"` and restart.

**Token 404 errors** — Token was stored without quotes and got truncated at the colon. Re-store: `~/claude-secrets/secret.sh set telegram bot-token "FULL_TOKEN_HERE"`


To troubleshoot, export before starting:

```bash
export TELEGRAM_LOG_LEVEL=debug
```

Then check `~/.claude/channels/telegram/debug.log` for detailed logs.