#!/usr/bin/env bun
/**
 * Gmail MCP Tool Server for Claude Code.
 *
 * Read tools: fetch/search emails, save to project-local inbox/gmail/
 * Write tools: send emails, optionally from project-local outbox/gmail/
 *
 * Auth: Google OAuth2 with offline refresh token.
 * Credentials: passed via env vars from startup script (decrypted from pass)
 * Token:       in-memory only, bootstrapped from GMAIL_REFRESH_TOKEN env var
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { google } from 'googleapis'
import type { gmail_v1 } from 'googleapis'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync,
  existsSync, unlinkSync,
} from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

// ── Config ──────────────────────────────────────────────────────────────

const STATE_DIR = process.env.GMAIL_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'gmail')
const LOG_FILE = join(STATE_DIR, 'debug.log')

// Project-local directories — resolved relative to cwd
const CWD = process.cwd()
const INBOX_DIR = join(CWD, 'inbox', 'gmail')
const OUTBOX_DIR = join(CWD, 'outbox', 'gmail')

// ── Logging ─────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  process.stderr.write(line)
  try { writeFileSync(LOG_FILE, line, { flag: 'a' }) } catch {}
}

// ── Credentials (from env — decrypted by startup script) ────────────────

const CLIENT_ID = process.env.GMAIL_CLIENT_ID
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET
const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI ?? 'http://localhost:3000/oauth2callback'

if (!CLIENT_ID || !CLIENT_SECRET) {
  process.stderr.write(
    `gmail server: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET required\n` +
    `  secrets must be in pass — run: gmail-start.sh --configure\n`,
  )
  process.exit(1)
}

// ── OAuth2 ──────────────────────────────────────────────────────────────

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

// Auto-refresh token on expiry (in-memory only)
oauth2.on('tokens', (tokens) => {
  if (tokens.refresh_token) {
    oauth2.setCredentials(tokens)
  }
  log('token refreshed')
})

// Bootstrap from env (decrypted by startup script from pass)
const refreshToken = process.env.GMAIL_REFRESH_TOKEN
if (refreshToken) {
  oauth2.setCredentials({ refresh_token: refreshToken })
  log('loaded refresh token from env')
} else {
  process.stderr.write(
    `gmail server: GMAIL_REFRESH_TOKEN required\n` +
    `  secrets must be in pass — run: gmail-start.sh --configure\n`,
  )
  process.exit(1)
}

const gmail = google.gmail({ version: 'v1', auth: oauth2 })

// ── Helpers ─────────────────────────────────────────────────────────────

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 100)
}

function extractHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return ''

  // If this part has a body with data, decode it
  if (part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8')
  }

  // If multipart, recurse
  if (part.parts) {
    // Prefer text/plain, fall back to text/html
    const textPart = part.parts.find(p => p.mimeType === 'text/plain')
    if (textPart) return decodeBody(textPart)
    const htmlPart = part.parts.find(p => p.mimeType === 'text/html')
    if (htmlPart) return decodeBody(htmlPart)
    // Try first part
    return decodeBody(part.parts[0])
  }

  return ''
}

interface ParsedEmail {
  id: string
  threadId: string
  from: string
  to: string
  cc: string
  subject: string
  date: string
  snippet: string
  body: string
  labels: string[]
}

function parseMessage(msg: gmail_v1.Schema$Message): ParsedEmail {
  const headers = msg.payload?.headers
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    from: extractHeader(headers, 'From'),
    to: extractHeader(headers, 'To'),
    cc: extractHeader(headers, 'Cc'),
    subject: extractHeader(headers, 'Subject'),
    date: extractHeader(headers, 'Date'),
    snippet: msg.snippet ?? '',
    body: decodeBody(msg.payload),
    labels: msg.labelIds ?? [],
  }
}

function emailToMarkdown(email: ParsedEmail): string {
  return [
    `# ${email.subject || '(no subject)'}`,
    '',
    `**From:** ${email.from}`,
    `**To:** ${email.to}`,
    email.cc ? `**Cc:** ${email.cc}` : '',
    `**Date:** ${email.date}`,
    `**Thread:** ${email.threadId}`,
    `**Labels:** ${email.labels.join(', ')}`,
    '',
    '---',
    '',
    email.body,
  ].filter(line => line !== '').join('\n')
}

function saveToInbox(email: ParsedEmail): string {
  mkdirSync(INBOX_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const fromName = safeName(email.from.split('<')[0].trim() || 'unknown')
  const subjectSlug = safeName(email.subject || 'no-subject').slice(0, 60)
  const filename = `${ts}_${fromName}_${subjectSlug}.md`
  const filepath = join(INBOX_DIR, filename)
  writeFileSync(filepath, emailToMarkdown(email))
  return filepath
}

// ── MCP Server ──────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'gmail', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Gmail tool server. Read and write tools for email.',
      '',
      'READ tools:',
      '- gmail_search: search emails using Gmail query syntax',
      '- gmail_read: fetch a specific email by ID',
      '- gmail_fetch_inbox: fetch recent unread emails and save to inbox/gmail/',
      '- gmail_list_labels: list all Gmail labels',
      '',
      'WRITE tools:',
      '- gmail_send: compose and send an email',
      '- gmail_reply: reply to a thread',
      '- gmail_draft: create a draft (saved to Gmail drafts)',
      '- gmail_send_outbox: send all drafts from outbox/gmail/',
      '',
      'Emails fetched by read tools are saved as markdown files in inbox/gmail/ (project-local).',
      'To send via outbox, write .md files to outbox/gmail/ with frontmatter (to, subject, cc, in_reply_to), then call gmail_send_outbox.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── READ tools ──────────────────────────────────────────────────
    {
      name: 'gmail_search',
      description: 'Search emails using Gmail query syntax. Results saved to inbox/gmail/. Returns summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Gmail search query, e.g. 'from:investor@fund.com newer_than:7d'" },
          max_results: { type: 'number', description: 'Max emails to fetch (default: 10, max: 50)' },
          save: { type: 'boolean', description: 'Save full emails to inbox/gmail/ (default: true)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'gmail_read',
      description: 'Fetch a specific email by message ID. Saves to inbox/gmail/.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Gmail message ID' },
        },
        required: ['message_id'],
      },
    },
    {
      name: 'gmail_fetch_inbox',
      description: 'Fetch recent unread emails from inbox. Saves to inbox/gmail/.',
      inputSchema: {
        type: 'object',
        properties: {
          max_results: { type: 'number', description: 'Max emails (default: 10)' },
          label: { type: 'string', description: 'Label to filter by (default: INBOX)' },
        },
      },
    },
    {
      name: 'gmail_list_labels',
      description: 'List all Gmail labels/folders.',
      inputSchema: { type: 'object', properties: {} },
    },
    // ── WRITE tools ─────────────────────────────────────────────────
    {
      name: 'gmail_send',
      description: 'Send an email directly.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email(s), comma-separated' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Email body (plain text)' },
          cc: { type: 'string', description: 'CC recipients, comma-separated' },
          in_reply_to: { type: 'string', description: 'Message-ID header to thread under' },
          thread_id: { type: 'string', description: 'Gmail thread ID to reply in' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'gmail_reply',
      description: 'Reply to an email thread. Uses the original message for threading.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Original message ID to reply to' },
          body: { type: 'string', description: 'Reply body (plain text)' },
          reply_all: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
        },
        required: ['message_id', 'body'],
      },
    },
    {
      name: 'gmail_draft',
      description: 'Create a draft in Gmail (not sent). Returns draft ID.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          cc: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'gmail_send_outbox',
      description: 'Send all .md files in outbox/gmail/. Each file needs frontmatter with to, subject. Sent files are deleted.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

// ── Tool handlers ───────────────────────────────────────────────────────

function buildRawEmail(opts: {
  to: string
  subject: string
  body: string
  cc?: string
  from?: string
  in_reply_to?: string
  references?: string
}): string {
  const lines: string[] = []
  if (opts.from) lines.push(`From: ${opts.from}`)
  lines.push(`To: ${opts.to}`)
  if (opts.cc) lines.push(`Cc: ${opts.cc}`)
  lines.push(`Subject: ${opts.subject}`)
  lines.push('Content-Type: text/plain; charset=utf-8')
  if (opts.in_reply_to) {
    lines.push(`In-Reply-To: ${opts.in_reply_to}`)
    lines.push(`References: ${opts.references ?? opts.in_reply_to}`)
  }
  lines.push('')
  lines.push(opts.body)
  return lines.join('\r\n')
}

function encodeRaw(raw: string): string {
  return Buffer.from(raw).toString('base64url')
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {

      // ── gmail_search ──────────────────────────────────────────────
      case 'gmail_search': {
        const query = args.query as string
        const maxResults = Math.min((args.max_results as number) ?? 10, 50)
        const save = (args.save as boolean) ?? true

        log(`gmail_search: "${query}" max=${maxResults}`)

        const list = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults,
        })

        const ids = list.data.messages ?? []
        if (ids.length === 0) {
          return { content: [{ type: 'text', text: 'No emails found.' }] }
        }

        const results: string[] = []
        const saved: string[] = []
        for (const { id } of ids) {
          if (!id) continue
          const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
          const email = parseMessage(msg.data)
          results.push(`[${email.id}] ${email.from} — ${email.subject} (${email.date})`)
          if (save) {
            const path = saveToInbox(email)
            saved.push(path)
          }
        }

        const summary = results.join('\n')
        const savedNote = save ? `\n\nSaved ${saved.length} emails to inbox/gmail/` : ''
        return { content: [{ type: 'text', text: summary + savedNote }] }
      }

      // ── gmail_read ────────────────────────────────────────────────
      case 'gmail_read': {
        const id = args.message_id as string
        log(`gmail_read: ${id}`)

        const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
        const email = parseMessage(msg.data)
        const path = saveToInbox(email)

        return { content: [{ type: 'text', text: `Saved to ${path}\n\n${emailToMarkdown(email)}` }] }
      }

      // ── gmail_fetch_inbox ─────────────────────────────────────────
      case 'gmail_fetch_inbox': {
        const maxResults = Math.min((args.max_results as number) ?? 10, 50)
        const label = (args.label as string) ?? 'INBOX'
        log(`gmail_fetch_inbox: label=${label} max=${maxResults}`)

        const list = await gmail.users.messages.list({
          userId: 'me',
          labelIds: [label],
          q: 'is:unread',
          maxResults,
        })

        const ids = list.data.messages ?? []
        if (ids.length === 0) {
          return { content: [{ type: 'text', text: 'No unread emails.' }] }
        }

        const results: string[] = []
        for (const { id } of ids) {
          if (!id) continue
          const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
          const email = parseMessage(msg.data)
          const path = saveToInbox(email)
          results.push(`${email.from} — ${email.subject}\n  → ${path}`)
        }

        return { content: [{ type: 'text', text: `Fetched ${results.length} unread emails:\n${results.join('\n')}` }] }
      }

      // ── gmail_list_labels ─────────────────────────────────────────
      case 'gmail_list_labels': {
        const res = await gmail.users.labels.list({ userId: 'me' })
        const labels = res.data.labels ?? []
        const text = labels.map(l => `${l.name} (${l.id})`).join('\n')
        return { content: [{ type: 'text', text: text || 'No labels found.' }] }
      }

      // ── gmail_send ────────────────────────────────────────────────
      case 'gmail_send': {
        const to = args.to as string
        const subject = args.subject as string
        const body = args.body as string
        const cc = args.cc as string | undefined
        const inReplyTo = args.in_reply_to as string | undefined
        const threadId = args.thread_id as string | undefined

        log(`gmail_send: to=${to} subject="${subject}"`)

        const raw = buildRawEmail({ to, subject, body, cc, in_reply_to: inReplyTo })
        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw: encodeRaw(raw),
            ...(threadId ? { threadId } : {}),
          },
        })

        return { content: [{ type: 'text', text: `sent (id: ${res.data.id})` }] }
      }

      // ── gmail_reply ───────────────────────────────────────────────
      case 'gmail_reply': {
        const messageId = args.message_id as string
        const body = args.body as string
        const replyAll = (args.reply_all as boolean) ?? false

        log(`gmail_reply: to message ${messageId}`)

        // Fetch original message for threading
        const orig = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
        const origEmail = parseMessage(orig.data)
        const msgIdHeader = extractHeader(orig.data.payload?.headers, 'Message-ID')
        const refsHeader = extractHeader(orig.data.payload?.headers, 'References')

        let to = origEmail.from
        let cc: string | undefined
        if (replyAll) {
          // Include all original To and Cc, excluding self
          const profile = await gmail.users.getProfile({ userId: 'me' })
          const myEmail = profile.data.emailAddress ?? ''
          const allRecipients = [origEmail.to, origEmail.cc]
            .filter(Boolean)
            .join(',')
            .split(',')
            .map(s => s.trim())
            .filter(s => !s.includes(myEmail))
          cc = allRecipients.join(', ') || undefined
        }

        const subject = origEmail.subject.startsWith('Re:')
          ? origEmail.subject
          : `Re: ${origEmail.subject}`

        const refs = refsHeader ? `${refsHeader} ${msgIdHeader}` : msgIdHeader
        const raw = buildRawEmail({
          to,
          subject,
          body,
          cc,
          in_reply_to: msgIdHeader,
          references: refs,
        })

        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw: encodeRaw(raw),
            threadId: orig.data.threadId ?? undefined,
          },
        })

        return { content: [{ type: 'text', text: `replied (id: ${res.data.id})` }] }
      }

      // ── gmail_draft ───────────────────────────────────────────────
      case 'gmail_draft': {
        const to = args.to as string
        const subject = args.subject as string
        const body = args.body as string
        const cc = args.cc as string | undefined

        log(`gmail_draft: to=${to} subject="${subject}"`)

        const raw = buildRawEmail({ to, subject, body, cc })
        const res = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw: encodeRaw(raw) } },
        })

        return { content: [{ type: 'text', text: `draft created (id: ${res.data.id})` }] }
      }

      // ── gmail_send_outbox ─────────────────────────────────────────
      case 'gmail_send_outbox': {
        if (!existsSync(OUTBOX_DIR)) {
          return { content: [{ type: 'text', text: 'outbox/gmail/ does not exist. Nothing to send.' }] }
        }

        const files = readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.md'))
        if (files.length === 0) {
          return { content: [{ type: 'text', text: 'outbox/gmail/ is empty.' }] }
        }

        const results: string[] = []
        for (const file of files) {
          const filepath = join(OUTBOX_DIR, file)
          try {
            const content = readFileSync(filepath, 'utf8')
            const { meta, body } = parseOutboxFile(content)
            if (!meta.to || !meta.subject) {
              results.push(`SKIP ${file}: missing 'to' or 'subject' in frontmatter`)
              continue
            }

            const raw = buildRawEmail({
              to: meta.to,
              subject: meta.subject,
              body,
              cc: meta.cc,
              in_reply_to: meta.in_reply_to,
            })

            const res = await gmail.users.messages.send({
              userId: 'me',
              requestBody: {
                raw: encodeRaw(raw),
                ...(meta.thread_id ? { threadId: meta.thread_id } : {}),
              },
            })

            unlinkSync(filepath)
            results.push(`SENT ${file} → ${meta.to} (id: ${res.data.id})`)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            results.push(`FAIL ${file}: ${msg}`)
          }
        }

        return { content: [{ type: 'text', text: results.join('\n') }] }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`${req.params.name} failed: ${msg}`)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

// ── Outbox file parser ──────────────────────────────────────────────────

interface OutboxMeta {
  to?: string
  subject?: string
  cc?: string
  in_reply_to?: string
  thread_id?: string
}

function parseOutboxFile(content: string): { meta: OutboxMeta; body: string } {
  const meta: OutboxMeta = {}
  let body = content

  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (fmMatch) {
    const fm = fmMatch[1]
    body = fmMatch[2]
    for (const line of fm.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (m) {
        const key = m[1].toLowerCase().replace(/-/g, '_') as keyof OutboxMeta
        if (key in meta || ['to', 'subject', 'cc', 'in_reply_to', 'thread_id'].includes(key)) {
          (meta as any)[key] = m[2].trim()
        }
      }
    }
  }

  return { meta, body: body.trim() }
}

// ── Shutdown ────────────────────────────────────────────────────────────

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

// ── Start ───────────────────────────────────────────────────────────────

log('starting gmail mcp server')
await mcp.connect(new StdioServerTransport())
log('gmail mcp server connected')