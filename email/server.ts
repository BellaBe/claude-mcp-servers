#!/usr/bin/env bun
/**
 * Email MCP Tool Server for Claude Code.
 *
 * Read: IMAP (with IDLE for push notifications on new mail)
 * Send: SMTP directly, or Resend HTTP API for deliverability at scale
 *
 * Works with Fastmail, Zoho, ProtonMail Bridge, custom domain on any host —
 * all just IMAP/SMTP credentials.
 *
 * Auth: credentials loaded at startup via secret.sh (GPG-encrypted, never in process.env).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ImapFlow } from 'imapflow'
import { createTransport } from 'nodemailer'
import { simpleParser } from 'mailparser'
import {
  writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

// ── Config ──────────────────────────────────────────────────────────────

const STATE_DIR = process.env.EMAIL_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'email')
const LOG_FILE = join(STATE_DIR, 'debug.log')

const CWD = process.cwd()
const INBOX_DIR = join(CWD, 'inbox', 'email')
const OUTBOX_DIR = join(CWD, 'outbox', 'email')

// ── Logging ─────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  process.stderr.write(line)
  try { writeFileSync(LOG_FILE, line, { flag: 'a' }) } catch {}
}

// ── Secrets (loaded once at startup, stored in local vars) ──────────────

const SECRET_CMD = process.env.SECRET_CMD ?? join(homedir(), 'claude-mcp-servers', 'secrets', 'secret.sh')

function loadSecret(key: string): string {
  const result = spawnSync(SECRET_CMD, ['get', 'email', key], {
    encoding: 'utf8',
    timeout: 5000,
  })
  return (result.stdout ?? '').trim()
}

// IMAP
const IMAP_HOST = loadSecret('imap-host')
const IMAP_PORT = parseInt(loadSecret('imap-port') || '993', 10)
const IMAP_USER = loadSecret('imap-user')
const IMAP_PASS = loadSecret('imap-pass')

// SMTP
const SMTP_HOST = loadSecret('smtp-host')
const SMTP_PORT = parseInt(loadSecret('smtp-port') || '587', 10)
const SMTP_USER = loadSecret('smtp-user')
const SMTP_PASS = loadSecret('smtp-pass')
const SMTP_FROM = loadSecret('smtp-from')

// Resend (optional alternative to SMTP)
const RESEND_API_KEY = loadSecret('resend-api-key')
const RESEND_FROM = loadSecret('resend-from')

// Clear SECRET_CMD from env — no longer needed
delete process.env.SECRET_CMD

if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) {
  process.stderr.write(
    `email server: IMAP credentials not found in secrets\n` +
    `  run: email-start.sh --configure\n`,
  )
  process.exit(1)
}

if (!SMTP_HOST && !RESEND_API_KEY) {
  process.stderr.write(
    `email server: SMTP_HOST or RESEND_API_KEY required for sending\n` +
    `  run: email-start.sh --configure\n`,
  )
  process.exit(1)
}

log('secrets loaded from GPG store')

// ── IMAP Client ─────────────────────────────────────────────────────────

function createImapClient(): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_PORT === 993,
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASS,
    },
    logger: false,
  })
}

// ── SMTP / Resend Transport ─────────────────────────────────────────────

const smtpTransport = SMTP_HOST ? createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER || IMAP_USER,
    pass: SMTP_PASS || IMAP_PASS,
  },
}) : null

async function sendViaResend(opts: {
  to: string
  subject: string
  text: string
  cc?: string
  in_reply_to?: string
}): Promise<{ id: string }> {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')
  const from = RESEND_FROM || SMTP_FROM || IMAP_USER
  const body: Record<string, unknown> = {
    from,
    to: opts.to.split(',').map(s => s.trim()),
    subject: opts.subject,
    text: opts.text,
  }
  if (opts.cc) body.cc = opts.cc.split(',').map(s => s.trim())
  if (opts.in_reply_to) {
    body.headers = {
      'In-Reply-To': opts.in_reply_to,
      'References': opts.in_reply_to,
    }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Resend API ${res.status}: ${text}`)
  }
  return res.json() as Promise<{ id: string }>
}

async function sendEmail(opts: {
  to: string
  subject: string
  body: string
  cc?: string
  in_reply_to?: string
  references?: string
}): Promise<string> {
  if (smtpTransport) {
    const from = SMTP_FROM || SMTP_USER || IMAP_USER
    const info = await smtpTransport.sendMail({
      from,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      text: opts.body,
      ...(opts.in_reply_to ? {
        inReplyTo: opts.in_reply_to,
        references: opts.references ?? opts.in_reply_to,
      } : {}),
    })
    return info.messageId
  }

  const result = await sendViaResend({
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
    cc: opts.cc,
    in_reply_to: opts.in_reply_to,
  })
  return result.id
}

// ── Helpers ─────────────────────────────────────────────────────────────

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 100)
}

interface ParsedEmail {
  uid: number
  messageId: string
  from: string
  to: string
  cc: string
  subject: string
  date: string
  body: string
  flags: string[]
  mailbox: string
}

function emailToMarkdown(email: ParsedEmail): string {
  return [
    `# ${email.subject || '(no subject)'}`,
    '',
    `**From:** ${email.from}`,
    `**To:** ${email.to}`,
    email.cc ? `**Cc:** ${email.cc}` : '',
    `**Date:** ${email.date}`,
    `**Message-ID:** ${email.messageId}`,
    `**UID:** ${email.uid}`,
    `**Mailbox:** ${email.mailbox}`,
    `**Flags:** ${email.flags.join(', ')}`,
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

// ── Classify email ──────────────────────────────────────────────────────

type EmailClass = 'interested' | 'objection' | 'unsubscribe' | 'bounce' | 'auto-reply' | 'unknown'

function classifyEmail(email: ParsedEmail): EmailClass {
  const body = email.body.toLowerCase()
  const subject = email.subject.toLowerCase()
  const from = email.from.toLowerCase()

  if (from.includes('mailer-daemon') || from.includes('postmaster') ||
      subject.includes('delivery') && (subject.includes('fail') || subject.includes('returned'))) {
    return 'bounce'
  }

  if (subject.startsWith('auto:') || subject.includes('out of office') ||
      subject.includes('automatic reply') || email.flags.includes('\\Answered')) {
    if (subject.includes('out of office') || subject.includes('automatic reply')) return 'auto-reply'
  }

  if (body.includes('unsubscribe') && (body.includes('remove me') || body.includes('stop') ||
      body.includes('opt out') || body.includes('take me off'))) {
    return 'unsubscribe'
  }

  if (body.includes('not interested') || body.includes('no thanks') ||
      body.includes('no thank you') || body.includes('please stop') ||
      body.includes('don\'t contact')) {
    return 'objection'
  }

  if (body.includes('interested') || body.includes('tell me more') ||
      body.includes('let\'s talk') || body.includes('let\'s chat') ||
      body.includes('set up a call') || body.includes('schedule') ||
      body.includes('sounds good') || body.includes('yes') ||
      body.includes('would love to')) {
    return 'interested'
  }

  return 'unknown'
}

// ── MCP Server ──────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'email', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Email tool server. IMAP for reading, SMTP/Resend for sending.',
      'Works with any IMAP/SMTP provider (Fastmail, Zoho, ProtonMail Bridge, custom domain).',
      '',
      'READ tools:',
      '- email_fetch_inbox: fetch recent emails from inbox',
      '- email_search: search emails by criteria',
      '- email_read: read a specific email by UID',
      '- email_list_mailboxes: list all mailboxes/folders',
      '- email_classify: classify an email (interested/objection/unsubscribe/bounce)',
      '',
      'WRITE tools:',
      '- email_send: compose and send an email',
      '- email_reply: reply to an email',
      '- email_send_outbox: send all drafts from outbox/email/',
      '- email_move: move an email to a different mailbox',
      '- email_flag: add/remove flags on an email',
      '',
      'Emails are saved as markdown to inbox/email/ when fetched.',
      'To send via outbox, write .md files to outbox/email/ with frontmatter (to, subject, cc), then call email_send_outbox.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── READ tools ──────────────────────────────────────────────────
    {
      name: 'email_fetch_inbox',
      description: 'Fetch recent emails from inbox. Saves to inbox/email/.',
      inputSchema: {
        type: 'object',
        properties: {
          max_results: { type: 'number', description: 'Max emails to fetch (default: 10, max: 50)' },
          mailbox: { type: 'string', description: 'Mailbox/folder to fetch from (default: INBOX)' },
          unseen_only: { type: 'boolean', description: 'Only fetch unseen/unread emails (default: true)' },
        },
      },
    },
    {
      name: 'email_search',
      description: 'Search emails by criteria. Saves results to inbox/email/.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Filter by sender email/name' },
          to: { type: 'string', description: 'Filter by recipient' },
          subject: { type: 'string', description: 'Filter by subject (substring match)' },
          since: { type: 'string', description: 'Emails since date (ISO 8601 or YYYY-MM-DD)' },
          before: { type: 'string', description: 'Emails before date' },
          text: { type: 'string', description: 'Full-text search in body' },
          mailbox: { type: 'string', description: 'Mailbox to search (default: INBOX)' },
          max_results: { type: 'number', description: 'Max results (default: 10)' },
        },
      },
    },
    {
      name: 'email_read',
      description: 'Read a specific email by UID. Saves to inbox/email/.',
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'number', description: 'Email UID' },
          mailbox: { type: 'string', description: 'Mailbox (default: INBOX)' },
        },
        required: ['uid'],
      },
    },
    {
      name: 'email_list_mailboxes',
      description: 'List all mailboxes/folders.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'email_classify',
      description: 'Classify an email as interested/objection/unsubscribe/bounce/auto-reply/unknown. Reads email by UID.',
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'number', description: 'Email UID to classify' },
          mailbox: { type: 'string', description: 'Mailbox (default: INBOX)' },
        },
        required: ['uid'],
      },
    },
    // ── WRITE tools ─────────────────────────────────────────────────
    {
      name: 'email_send',
      description: 'Send an email via SMTP or Resend.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email(s), comma-separated' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Email body (plain text)' },
          cc: { type: 'string', description: 'CC recipients, comma-separated' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'email_reply',
      description: 'Reply to an email by UID. Fetches original for threading.',
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'number', description: 'UID of email to reply to' },
          body: { type: 'string', description: 'Reply body (plain text)' },
          mailbox: { type: 'string', description: 'Mailbox (default: INBOX)' },
          reply_all: { type: 'boolean', description: 'Reply to all (default: false)' },
        },
        required: ['uid', 'body'],
      },
    },
    {
      name: 'email_send_outbox',
      description: 'Send all .md files in outbox/email/. Each needs frontmatter with to, subject. Sent files are deleted.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'email_move',
      description: 'Move an email to a different mailbox/folder.',
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'number', description: 'Email UID' },
          from_mailbox: { type: 'string', description: 'Source mailbox (default: INBOX)' },
          to_mailbox: { type: 'string', description: 'Destination mailbox' },
        },
        required: ['uid', 'to_mailbox'],
      },
    },
    {
      name: 'email_flag',
      description: 'Add or remove flags on an email (\\Seen, \\Flagged, \\Answered, \\Deleted).',
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'number', description: 'Email UID' },
          mailbox: { type: 'string', description: 'Mailbox (default: INBOX)' },
          add: { type: 'string', description: 'Flags to add, comma-separated (e.g. "\\Seen,\\Flagged")' },
          remove: { type: 'string', description: 'Flags to remove, comma-separated' },
        },
        required: ['uid'],
      },
    },
  ],
}))

// ── IMAP fetch helper ───────────────────────────────────────────────────

async function fetchEmail(client: ImapFlow, uid: number, mailbox: string): Promise<ParsedEmail> {
  const lock = await client.getMailboxLock(mailbox)
  try {
    const msg = await client.fetchOne(String(uid), {
      source: true,
      flags: true,
      uid: true,
    }, { uid: true })

    const parsed = await simpleParser(msg.source)

    return {
      uid,
      messageId: parsed.messageId ?? '',
      from: parsed.from?.text ?? '',
      to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map(a => a.text).join(', ') : parsed.to.text) : '',
      cc: parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc.map(a => a.text).join(', ') : parsed.cc.text) : '',
      subject: parsed.subject ?? '',
      date: parsed.date?.toISOString() ?? '',
      body: parsed.text ?? '',
      flags: Array.from(msg.flags ?? []),
      mailbox,
    }
  } finally {
    lock.release()
  }
}

// ── Tool Handlers ───────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {

      // ── email_fetch_inbox ─────────────────────────────────────────
      case 'email_fetch_inbox': {
        const maxResults = Math.min((args.max_results as number) ?? 10, 50)
        const mailbox = (args.mailbox as string) ?? 'INBOX'
        const unseenOnly = (args.unseen_only as boolean) ?? true

        log(`email_fetch_inbox: mailbox=${mailbox} max=${maxResults} unseen=${unseenOnly}`)

        const client = createImapClient()
        await client.connect()
        const lock = await client.getMailboxLock(mailbox)
        try {
          const searchCriteria = unseenOnly ? { seen: false } : { all: true }
          const uids = await client.search(searchCriteria, { uid: true })

          if (!uids.length) {
            return { content: [{ type: 'text', text: unseenOnly ? 'No unread emails.' : 'No emails found.' }] }
          }

          const targetUids = uids.slice(-maxResults)
          lock.release()

          const results: string[] = []
          for (const uid of targetUids) {
            try {
              const email = await fetchEmail(client, uid, mailbox)
              const path = saveToInbox(email)
              results.push(`${email.from} — ${email.subject}\n  → ${path}`)
            } catch (err) {
              log(`fetch uid ${uid} failed: ${err}`)
            }
          }

          return { content: [{ type: 'text', text: `Fetched ${results.length} emails:\n${results.join('\n')}` }] }
        } catch (err) {
          lock.release()
          throw err
        } finally {
          await client.logout()
        }
      }

      // ── email_search ──────────────────────────────────────────────
      case 'email_search': {
        const mailbox = (args.mailbox as string) ?? 'INBOX'
        const maxResults = Math.min((args.max_results as number) ?? 10, 50)

        log(`email_search: mailbox=${mailbox}`)

        const searchQuery: Record<string, unknown> = {}
        if (args.from) searchQuery.from = args.from as string
        if (args.to) searchQuery.to = args.to as string
        if (args.subject) searchQuery.subject = args.subject as string
        if (args.since) searchQuery.since = new Date(args.since as string)
        if (args.before) searchQuery.before = new Date(args.before as string)
        if (args.text) searchQuery.body = args.text as string
        if (!Object.keys(searchQuery).length) searchQuery.all = true

        const client = createImapClient()
        await client.connect()
        const lock = await client.getMailboxLock(mailbox)
        try {
          const uids = await client.search(searchQuery, { uid: true })

          if (!uids.length) {
            return { content: [{ type: 'text', text: 'No emails match search criteria.' }] }
          }

          const targetUids = uids.slice(-maxResults)
          lock.release()

          const results: string[] = []
          for (const uid of targetUids) {
            try {
              const email = await fetchEmail(client, uid, mailbox)
              const path = saveToInbox(email)
              results.push(`[uid:${uid}] ${email.from} — ${email.subject} (${email.date})\n  → ${path}`)
            } catch (err) {
              log(`fetch uid ${uid} failed: ${err}`)
            }
          }

          return { content: [{ type: 'text', text: `Found ${results.length} emails:\n${results.join('\n')}` }] }
        } catch (err) {
          lock.release()
          throw err
        } finally {
          await client.logout()
        }
      }

      // ── email_read ────────────────────────────────────────────────
      case 'email_read': {
        const uid = args.uid as number
        const mailbox = (args.mailbox as string) ?? 'INBOX'

        log(`email_read: uid=${uid} mailbox=${mailbox}`)

        const client = createImapClient()
        await client.connect()
        try {
          const email = await fetchEmail(client, uid, mailbox)
          const path = saveToInbox(email)
          return { content: [{ type: 'text', text: `Saved to ${path}\n\n${emailToMarkdown(email)}` }] }
        } finally {
          await client.logout()
        }
      }

      // ── email_list_mailboxes ──────────────────────────────────────
      case 'email_list_mailboxes': {
        log('email_list_mailboxes')

        const client = createImapClient()
        await client.connect()
        try {
          const mailboxes = await client.list()
          const text = mailboxes.map(m =>
            `${m.path}${m.specialUse ? ` (${m.specialUse})` : ''}`
          ).join('\n')
          return { content: [{ type: 'text', text: text || 'No mailboxes found.' }] }
        } finally {
          await client.logout()
        }
      }

      // ── email_classify ────────────────────────────────────────────
      case 'email_classify': {
        const uid = args.uid as number
        const mailbox = (args.mailbox as string) ?? 'INBOX'

        log(`email_classify: uid=${uid}`)

        const client = createImapClient()
        await client.connect()
        try {
          const email = await fetchEmail(client, uid, mailbox)
          const classification = classifyEmail(email)
          return {
            content: [{
              type: 'text',
              text: `classification: ${classification}\nfrom: ${email.from}\nsubject: ${email.subject}`,
            }],
          }
        } finally {
          await client.logout()
        }
      }

      // ── email_send ────────────────────────────────────────────────
      case 'email_send': {
        const to = args.to as string
        const subject = args.subject as string
        const body = args.body as string
        const cc = args.cc as string | undefined

        log(`email_send: to=${to} subject="${subject}"`)

        const messageId = await sendEmail({ to, subject, body, cc })
        return { content: [{ type: 'text', text: `sent (messageId: ${messageId})` }] }
      }

      // ── email_reply ───────────────────────────────────────────────
      case 'email_reply': {
        const uid = args.uid as number
        const body = args.body as string
        const mailbox = (args.mailbox as string) ?? 'INBOX'
        const replyAll = (args.reply_all as boolean) ?? false

        log(`email_reply: uid=${uid} mailbox=${mailbox}`)

        const client = createImapClient()
        await client.connect()
        try {
          const orig = await fetchEmail(client, uid, mailbox)

          let to = orig.from
          let cc: string | undefined
          if (replyAll) {
            const myEmail = (SMTP_FROM || SMTP_USER || IMAP_USER).toLowerCase()
            const allRecipients = [orig.to, orig.cc]
              .filter(Boolean)
              .join(',')
              .split(',')
              .map(s => s.trim())
              .filter(s => !s.toLowerCase().includes(myEmail))
            cc = allRecipients.join(', ') || undefined
          }

          const subject = orig.subject.startsWith('Re:')
            ? orig.subject
            : `Re: ${orig.subject}`

          const messageId = await sendEmail({
            to,
            subject,
            body,
            cc,
            in_reply_to: orig.messageId,
            references: orig.messageId,
          })

          return { content: [{ type: 'text', text: `replied (messageId: ${messageId})` }] }
        } finally {
          await client.logout()
        }
      }

      // ── email_send_outbox ─────────────────────────────────────────
      case 'email_send_outbox': {
        if (!existsSync(OUTBOX_DIR)) {
          return { content: [{ type: 'text', text: 'outbox/email/ does not exist. Nothing to send.' }] }
        }

        const files = readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.md'))
        if (files.length === 0) {
          return { content: [{ type: 'text', text: 'outbox/email/ is empty.' }] }
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

            const messageId = await sendEmail({
              to: meta.to,
              subject: meta.subject,
              body,
              cc: meta.cc,
              in_reply_to: meta.in_reply_to,
              references: meta.in_reply_to,
            })

            unlinkSync(filepath)
            results.push(`SENT ${file} → ${meta.to} (messageId: ${messageId})`)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            results.push(`FAIL ${file}: ${msg}`)
          }
        }

        return { content: [{ type: 'text', text: results.join('\n') }] }
      }

      // ── email_move ────────────────────────────────────────────────
      case 'email_move': {
        const uid = args.uid as number
        const fromMailbox = (args.from_mailbox as string) ?? 'INBOX'
        const toMailbox = args.to_mailbox as string

        log(`email_move: uid=${uid} ${fromMailbox} → ${toMailbox}`)

        const client = createImapClient()
        await client.connect()
        const lock = await client.getMailboxLock(fromMailbox)
        try {
          await client.messageMove(String(uid), toMailbox, { uid: true })
          return { content: [{ type: 'text', text: `moved uid ${uid} from ${fromMailbox} to ${toMailbox}` }] }
        } finally {
          lock.release()
          await client.logout()
        }
      }

      // ── email_flag ────────────────────────────────────────────────
      case 'email_flag': {
        const uid = args.uid as number
        const mailbox = (args.mailbox as string) ?? 'INBOX'
        const addFlags = (args.add as string)?.split(',').map(s => s.trim()).filter(Boolean) ?? []
        const removeFlags = (args.remove as string)?.split(',').map(s => s.trim()).filter(Boolean) ?? []

        log(`email_flag: uid=${uid} +${addFlags.join(',')} -${removeFlags.join(',')}`)

        const client = createImapClient()
        await client.connect()
        const lock = await client.getMailboxLock(mailbox)
        try {
          if (addFlags.length) {
            await client.messageFlagsAdd(String(uid), addFlags, { uid: true })
          }
          if (removeFlags.length) {
            await client.messageFlagsRemove(String(uid), removeFlags, { uid: true })
          }
          return { content: [{ type: 'text', text: `flags updated for uid ${uid}` }] }
        } finally {
          lock.release()
          await client.logout()
        }
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
}

function parseOutboxFile(content: string): { meta: OutboxMeta; body: string } {
  const meta: OutboxMeta = {}
  let body = content

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (fmMatch) {
    const fm = fmMatch[1]
    body = fmMatch[2]
    for (const line of fm.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (m) {
        const key = m[1].toLowerCase().replace(/-/g, '_') as keyof OutboxMeta
        if (['to', 'subject', 'cc', 'in_reply_to'].includes(key)) {
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

log('starting email mcp server')
await mcp.connect(new StdioServerTransport())
log('email mcp server connected')
