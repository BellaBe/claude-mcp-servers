Claude Channel Secrets
GPG-encrypted credential storage for Claude Code MCP channels. Keeps tokens out of flat files where Claude's tools can read them.

Why
MCP channel servers need API tokens. Storing them in .env files or process.env means Claude Code can read them via file tools or `/proc/<pid>/environ`. This moves credentials into pass (GPG-encrypted ~/.password-store/), loaded at startup via `spawnSync` into local TypeScript variables — never touching the environment.

Security model
| Layer | Claude can access? |
|-------|--------------------|
| ~/.password-store/*.gpg | No — GPG-encrypted |
| process.env at runtime | No — secrets not in env |
| /proc/<pid>/environ | No — nothing to read |
| TypeScript heap variables | No — no filesystem exposure |

Flow: GPG-encrypted file → secret.sh get → spawnSync stdout → local const → server memory. The token never exists as an env var or flat file.

Install
# Prerequisites (one-time)
sudo apt install pass gnupg
gpg --gen-key
pass init <gpg-key-id>          # gpg --list-keys to find it

Usage
secret.sh set <channel> <key> <value>
secret.sh get <channel> <key>
secret.sh list [channel]
secret.sh rm  <channel> <key>
secret.sh migrate <channel> <ENV_KEY> <pass_key>
Store
Always quote values — tokens contain colons and special characters that the shell will split or truncate without quotes:

./secrets/secret.sh set telegram bot-token "123456789:AAHfiqksKZ8..."
./secrets/secret.sh set telegram admin-id "987654321"
./secrets/secret.sh set gmail client-id "xxxxx.apps.googleusercontent.com"
./secrets/secret.sh set calendar caldav-url "https://caldav.fastmail.com/dav/calendars/user/you@fastmail.com/"
./secrets/secret.sh set calendar caldav-username "you@fastmail.com"
./secrets/secret.sh set calendar caldav-password "app-specific-password"
./secrets/secret.sh set email imap-host "imap.fastmail.com"
./secrets/secret.sh set email imap-user "you@fastmail.com"
./secrets/secret.sh set email imap-pass "app-specific-password"
./secrets/secret.sh set email smtp-host "smtp.fastmail.com"

Verify after storing
Always verify the token works after storing:

# Telegram
curl "https://api.telegram.org/bot$(./secrets/secret.sh get telegram bot-token)/getMe"

# IMAP
openssl s_client -connect $(./secrets/secret.sh get email imap-host):993 -quiet

Retrieve
./secrets/secret.sh get telegram bot-token
./secrets/secret.sh get calendar caldav-url
./secrets/secret.sh get email imap-host
List
./secrets/secret.sh list              # all channels
./secrets/secret.sh list telegram     # one channel
./secrets/secret.sh list calendar
./secrets/secret.sh list email
Delete
./secrets/secret.sh rm email resend-api-key
Migrate from .env
Reads a key from ~/.claude/channels/<channel>/.env, stores it in pass, strips it from the file:

./secrets/secret.sh migrate telegram TELEGRAM_BOT_TOKEN bot-token
./secrets/secret.sh migrate telegram TELEGRAM_ADMIN_USER_ID admin-id

Override the channels directory if yours is elsewhere:

CLAUDE_CHANNELS_DIR=~/my-channels ./secrets/secret.sh migrate telegram TELEGRAM_BOT_TOKEN bot-token

Storage layout
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
    calcom-api-key.gpg          # optional
    calcom-base-url.gpg         # optional
  claude-email/
    imap-host.gpg
    imap-port.gpg
    imap-user.gpg
    imap-pass.gpg
    smtp-host.gpg               # optional if using Resend
    smtp-port.gpg
    smtp-user.gpg
    smtp-pass.gpg
    smtp-from.gpg
    resend-api-key.gpg          # optional alternative to SMTP
    resend-from.gpg

How servers load secrets
Servers call secret.sh at startup via spawnSync, storing results in local const variables:

```typescript
import { spawnSync } from 'child_process'

const SECRET_CMD = process.env.SECRET_CMD ?? '/path/to/secrets/secret.sh'

function loadSecret(key: string): string {
  const result = spawnSync(SECRET_CMD, ['get', 'email', key], {
    encoding: 'utf8',
    timeout: 5000,
  })
  return (result.stdout ?? '').trim()
}

const IMAP_HOST = loadSecret('imap-host')
const IMAP_PASS = loadSecret('imap-pass')

// Remove SECRET_CMD from env — no longer needed
delete process.env.SECRET_CMD
```

The startup script only passes SECRET_CMD (the path to secret.sh) as an env var. The server deletes it immediately after use.

GPG passphrase and subprocesses
Claude Code spawns the start script as a subprocess with no TTY. If GPG needs your passphrase and the cache is empty, it can't prompt you — the start script fails silently.

Prime the cache before starting Claude Code:

pass show claude-telegram/bot-token > /dev/null && claude --dangerously-load-development-channels server:telegram

Or create a one-liner alias:

alias claude-all='pass show claude-telegram/bot-token > /dev/null && claude --dangerously-load-development-channels server:telegram server:whatsapp'

Lock down GPG cache timeout
By default GPG remembers your passphrase for a long time. Shorten it so the decryption window closes before Claude's session is fully running:

echo "default-cache-ttl 60
max-cache-ttl 300" > ~/.gnupg/gpg-agent.conf

gpg-connect-agent reloadagent /bye

Passphrase expires 60 seconds after you type it. The start script decrypts at launch, the cache clears, and Claude can't decrypt anything even if it tries.

Troubleshooting
"Secrets not found" when Claude Code starts — GPG cache expired. Prime it: pass show claude-telegram/bot-token > /dev/null then reconnect.

Token stored but API returns 404 — Token was truncated — you likely stored it without quotes. Re-store with quotes around the value.

pass insert succeeds but pass show is empty — Old version of the script without -e flag. Update secret.sh and re-store.

Migration ran but no secrets stored — Same -e flag issue. Use secret.sh set to store manually.

Directory
secrets/
  secret.sh     # this tool
  README.md     # this file
