# Gmail MCP Server for Claude Code

Tool server for reading and writing Gmail. Not a channel — Claude calls these tools on demand.

## Architecture

```
Claude Code → gmail_search/gmail_send/... → Google Gmail API
                    ↓                              ↓
            inbox/gmail/ (read)          outbox/gmail/ (write)
```

Read tools save emails as markdown to project-local `inbox/gmail/`.
Write tools can send directly or process drafts from `outbox/gmail/`.

## Setup

### 1. Create Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use existing)
3. Enable the **Gmail API**
4. Go to **Credentials** → Create **OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Download the credentials

### 2. Place files and configure

```bash
cp -r gmail-channel/* ~/.claude/channels/gmail/
cd ~/.claude/channels/gmail
./gmail-start.sh --configure  # stores client ID and secret in pass
bun install
```

### 3. Authorize

```bash
./gmail-start.sh --auth
```

Opens browser for Google sign-in. Authorize with your Gmail account. Refresh token is saved to `pass` (claude-gmail/refresh-token).

### 4. Validate

```bash
./gmail-start.sh --check
```

### 5. Register

```bash
claude mcp add gmail --scope user -- bash ~/.claude/channels/gmail/gmail-start.sh
```

No `--dangerously-load-development-channels` needed — this is a tool server, not a channel.

**Prime GPG cache before starting Claude Code:**

```bash
pass show claude-gmail/client-id > /dev/null && claude
```

### 6. Test

Start Claude Code and ask: "check my inbox for unread emails"

## Tools

### Read

| Tool | What it does |
|------|-------------|
| `gmail_search` | Search using Gmail query syntax. Saves results to `inbox/gmail/` |
| `gmail_read` | Fetch specific email by ID. Saves to `inbox/gmail/` |
| `gmail_fetch_inbox` | Fetch recent unread emails. Saves to `inbox/gmail/` |
| `gmail_list_labels` | List all Gmail labels |

### Write

| Tool | What it does |
|------|-------------|
| `gmail_send` | Send an email directly |
| `gmail_reply` | Reply to a thread (with reply-all option) |
| `gmail_draft` | Create a draft in Gmail |
| `gmail_send_outbox` | Send all `.md` files from `outbox/gmail/` |

## Outbox Format

Write `.md` files to `outbox/gmail/` with YAML frontmatter:

```markdown
---
to: investor@fund.com
subject: Re: Partnership Discussion
cc: partner@fund.com
in_reply_to: <message-id@gmail.com>
thread_id: 18e1234567890abc
---

Hi,

Thanks for the meeting yesterday. Here's the follow-up...

Best,
Bella
```

Then call `gmail_send_outbox` — each file is sent and deleted.

## Inbox Format

Fetched emails are saved as markdown:

```
inbox/gmail/2026-03-27T12-00-00Z_John_Doe_Re-Partnership.md
```

Each file contains headers (from, to, date, thread ID) and body.

## State

```
~/.claude/channels/gmail/     # global — server code
├── server.ts
├── auth.ts
├── gmail-start.sh
├── package.json
└── debug.log

~/.password-store/claude-gmail/ # encrypted credentials
├── client-id.gpg
├── client-secret.gpg
└── refresh-token.gpg

<project>/                     # project-local — messages
├── inbox/gmail/               # fetched emails
└── outbox/gmail/              # drafts to send
```

No plaintext credentials on disk. Client ID, client secret, and refresh token live in GPG-encrypted pass storage. Tokens are held in-memory only — nothing persisted to disk.