/**
 * WhatsApp channel for Claude Code.
 *
 * Two-way bridge: WhatsApp messages push into Claude Code session,
 * Claude replies back through WhatsApp.
 *
 * Uses whatsapp-web.js (puppeteer) — unofficial, secondary number recommended.
 * Auth: QR code scan on first run, LocalAuth persists the session.
 *
 * State: ~/.claude/channels/whatsapp/
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import pkg from 'whatsapp-web.js'
const { Client, LocalAuth } = pkg
import qrcode from 'qrcode-terminal'
import {
  readFileSync, writeFileSync, mkdirSync,
  existsSync, unlinkSync, renameSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ── Config ──────────────────────────────────────────────────────────────

const STATE_DIR = process.env.WHATSAPP_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'whatsapp')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const LOG_FILE = join(STATE_DIR, 'debug.log')
const INBOX_DIR = join(STATE_DIR, 'inbox')

const DEFAULT_REPLY_DELAY_MIN = 2000
const DEFAULT_REPLY_DELAY_MAX = 5000
const DEFAULT_MAX_REPLIES_PER_HOUR = 30

// ── Logging ─────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  process.stderr.write(line)
  try { writeFileSync(LOG_FILE, line, { flag: 'a' }) } catch {}
}

// ── Access control ──────────────────────────────────────────────────────

function defaultAccess() {
  return {
    allowFrom: [],
    groups: {},
    replyDelayMin: DEFAULT_REPLY_DELAY_MIN,
    replyDelayMax: DEFAULT_REPLY_DELAY_MAX,
    maxRepliesPerHour: DEFAULT_MAX_REPLIES_PER_HOUR,
  }
}

function loadAccess() {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    return { ...defaultAccess(), ...JSON.parse(raw) }
  } catch {
    return defaultAccess()
  }
}

function saveAccess(a) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

// Rate tracking
const replyLog = []

function canReply() {
  const access = loadAccess()
  const cutoff = Date.now() - 3600000
  const recent = replyLog.filter(t => t > cutoff)
  return recent.length < access.maxRepliesPerHour
}

function logReply() {
  replyLog.push(Date.now())
  const cutoff = Date.now() - 3600000
  while (replyLog.length > 0 && replyLog[0] < cutoff) replyLog.shift()
}

function isAllowed(contactId) {
  const access = loadAccess()
  if (access.allowFrom.length === 0) return true
  return access.allowFrom.some(id => contactId.includes(id))
}

function isGroupAllowed(groupId) {
  const access = loadAccess()
  return groupId in (access.groups ?? {})
}

async function humanDelay() {
  const access = loadAccess()
  const min = access.replyDelayMin ?? DEFAULT_REPLY_DELAY_MIN
  const max = access.replyDelayMax ?? DEFAULT_REPLY_DELAY_MAX
  const delay = min + Math.random() * (max - min)
  await new Promise(r => setTimeout(r, delay))
}

// ── WhatsApp client ─────────────────────────────────────────────────────

const wa = new Client({
  authStrategy: new LocalAuth({ dataPath: join(STATE_DIR, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  },
})

let waReady = false

// ── MCP Server ──────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'whatsapp', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'WhatsApp channel. Messages arrive as <channel source="whatsapp" chat_id="..." user="..." ts="...">.',
      '',
      'Tools: reply, react, get_contacts, fetch_messages, download_media, manage_access.',
      '',
      'IMPORTANT: Replies have a human-like delay (2-5s) and are rate-limited to avoid WhatsApp bans.',
      'This is a secondary number. Never send bulk messages or auto-reply to unknown contacts.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a WhatsApp message. Has built-in human-like delay to avoid detection.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'WhatsApp chat ID from inbound message' },
          text: { type: 'string' },
          quote_id: { type: 'string', description: 'Message ID to quote-reply (optional)' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'React to a WhatsApp message with an emoji.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string', description: 'Serialized message ID' },
          emoji: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'get_contacts',
      description: 'List known WhatsApp contacts.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max contacts (default: 50)' },
        },
      },
    },
    {
      name: 'fetch_messages',
      description: 'Fetch recent messages from a specific chat. Unlike Telegram, WhatsApp has history.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          limit: { type: 'number', description: 'Number of messages (default: 10, max: 50)' },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'download_media',
      description: 'Download media from a WhatsApp message to inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Serialized message ID' },
          chat_id: { type: 'string' },
        },
        required: ['message_id', 'chat_id'],
      },
    },
    {
      name: 'manage_access',
      description: 'Manage the allowlist. Numbers as digits only: 971501234567 (no + or spaces).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove', 'list', 'set_rate'] },
          phone: { type: 'string', description: 'Phone number for add/remove' },
          rate: { type: 'number', description: 'Max replies per hour (for set_rate)' },
        },
        required: ['action'],
      },
    },
  ],
}))

// ── Tool handlers ───────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {}

  if (!waReady && req.params.name !== 'manage_access') {
    return {
      content: [{ type: 'text', text: 'WhatsApp not ready. Run standalone to pair: cd ~/.claude/channels/whatsapp && node server.mjs 2>&1' }],
      isError: true,
    }
  }

  try {
    switch (req.params.name) {

      case 'reply': {
        if (!canReply()) {
          return { content: [{ type: 'text', text: `Rate limit (${loadAccess().maxRepliesPerHour}/hr). Try later.` }], isError: true }
        }

        log(`reply: to=${args.chat_id} text="${String(args.text).slice(0, 50)}"`)
        await humanDelay()

        const chat = await wa.getChatById(args.chat_id)
        await chat.sendStateTyping()
        await new Promise(r => setTimeout(r, Math.min(String(args.text).length * 30, 3000)))
        await chat.clearState()

        let sentMsg
        if (args.quote_id) {
          const messages = await chat.fetchMessages({ limit: 50 })
          const quoted = messages.find(m => m.id._serialized === args.quote_id)
          sentMsg = quoted ? await quoted.reply(args.text) : await chat.sendMessage(args.text)
        } else {
          sentMsg = await chat.sendMessage(args.text)
        }

        logReply()
        return { content: [{ type: 'text', text: `sent (id: ${sentMsg.id._serialized})` }] }
      }

      case 'react': {
        const chat = await wa.getChatById(args.chat_id)
        const messages = await chat.fetchMessages({ limit: 50 })
        const msg = messages.find(m => m.id._serialized === args.message_id)
        if (!msg) return { content: [{ type: 'text', text: 'Message not found' }], isError: true }
        await msg.react(args.emoji)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'get_contacts': {
        const limit = Math.min(args.limit ?? 50, 200)
        const contacts = await wa.getContacts()
        const list = contacts
          .filter(c => c.isMyContact && !c.isMe)
          .slice(0, limit)
          .map(c => `${c.pushname ?? c.name ?? 'unknown'} — ${c.number} (${c.id._serialized})`)
        return { content: [{ type: 'text', text: list.join('\n') || 'No contacts.' }] }
      }

      case 'fetch_messages': {
        const limit = Math.min(args.limit ?? 10, 50)
        const chat = await wa.getChatById(args.chat_id)
        const messages = await chat.fetchMessages({ limit })
        const result = messages.map(m => {
          const from = m.fromMe ? 'me' : (m._data?.notifyName ?? m.from)
          const ts = new Date(m.timestamp * 1000).toISOString()
          return `[${ts}] ${from}: ${m.body || `(${m.type})`}`
        }).join('\n')
        return { content: [{ type: 'text', text: result || 'No messages.' }] }
      }

      case 'download_media': {
        const chat = await wa.getChatById(args.chat_id)
        const messages = await chat.fetchMessages({ limit: 50 })
        const msg = messages.find(m => m.id._serialized === args.message_id)
        if (!msg?.hasMedia) return { content: [{ type: 'text', text: 'No media or not found.' }], isError: true }

        const media = await msg.downloadMedia()
        if (!media) return { content: [{ type: 'text', text: 'Download failed.' }], isError: true }

        mkdirSync(INBOX_DIR, { recursive: true })
        const ext = media.mimetype.split('/')[1]?.split(';')[0] ?? 'bin'
        const filename = `${Date.now()}-media.${ext}`
        const filepath = join(INBOX_DIR, filename)
        writeFileSync(filepath, Buffer.from(media.data, 'base64'))
        return { content: [{ type: 'text', text: filepath }] }
      }

      case 'manage_access': {
        const access = loadAccess()
        switch (args.action) {
          case 'add': {
            if (!args.phone) return { content: [{ type: 'text', text: 'phone required' }], isError: true }
            if (!access.allowFrom.includes(args.phone)) access.allowFrom.push(args.phone)
            saveAccess(access)
            return { content: [{ type: 'text', text: `Added ${args.phone}. List: ${access.allowFrom.join(', ')}` }] }
          }
          case 'remove': {
            if (!args.phone) return { content: [{ type: 'text', text: 'phone required' }], isError: true }
            access.allowFrom = access.allowFrom.filter(p => p !== args.phone)
            saveAccess(access)
            return { content: [{ type: 'text', text: `Removed ${args.phone}.` }] }
          }
          case 'list':
            return { content: [{ type: 'text', text: `Allowlist: ${access.allowFrom.join(', ') || '(empty — all allowed)'}` }] }
          case 'set_rate': {
            if (!args.rate || args.rate < 1) return { content: [{ type: 'text', text: 'rate must be >= 1' }], isError: true }
            access.maxRepliesPerHour = args.rate
            saveAccess(access)
            return { content: [{ type: 'text', text: `Rate: ${args.rate}/hour` }] }
          }
          default:
            return { content: [{ type: 'text', text: `Unknown action: ${args.action}` }], isError: true }
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

// ── WhatsApp events ─────────────────────────────────────────────────────

wa.on('qr', (qr) => {
  log('QR code generated — scan with WhatsApp on secondary phone')
  qrcode.generate(qr, { small: true })
})

wa.on('authenticated', () => log('authenticated'))
wa.on('auth_failure', (msg) => log(`auth failed: ${msg}`))

wa.on('ready', () => {
  waReady = true
  log('whatsapp client ready')
})

wa.on('disconnected', (reason) => {
  waReady = false
  log(`disconnected: ${reason}`)
})

wa.on('message', async (msg) => {
  try {
    if (msg.isStatus || msg.fromMe) return

    const contact = await msg.getContact()
    const chatId = msg.from
    const isGroup = chatId.endsWith('@g.us')

    if (isGroup) {
      if (!isGroupAllowed(chatId)) return
    } else {
      if (!isAllowed(contact.number ?? chatId)) return
    }

    const contactName = contact.pushname ?? contact.name ?? contact.number ?? chatId
    const body = msg.body || `(${msg.type})`
    const ts = new Date(msg.timestamp * 1000).toISOString()

    log(`inbound: from=${contactName} chat=${chatId} text="${body.slice(0, 50)}"`)

    // Auto-download images
    let imagePath
    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker')) {
      try {
        const media = await msg.downloadMedia()
        if (media) {
          mkdirSync(INBOX_DIR, { recursive: true })
          const ext = media.mimetype.split('/')[1]?.split(';')[0] ?? 'bin'
          imagePath = join(INBOX_DIR, `${Date.now()}-${contact.number ?? 'unknown'}.${ext}`)
          writeFileSync(imagePath, Buffer.from(media.data, 'base64'))
        }
      } catch (err) {
        log(`media download failed: ${err}`)
      }
    }

    mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: body,
        meta: {
          chat_id: chatId,
          message_id: msg.id._serialized,
          user: contactName,
          user_id: contact.number ?? chatId,
          ts,
          ...(isGroup ? { group: chatId } : {}),
          ...(imagePath ? { image_path: imagePath } : {}),
          ...(msg.hasMedia && msg.type !== 'image' && msg.type !== 'sticker'
            ? { has_media: 'true', media_type: msg.type } : {}),
        },
      },
    }).then(() => log(`notification delivered`))
      .catch(err => log(`notification FAILED: ${err}`))
  } catch (err) {
    log(`message handler error: ${err}`)
  }
})

// ── Shutdown ────────────────────────────────────────────────────────────

function shutdown() {
  log('shutting down')
  process.exit(0)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ───────────────────────────────────────────────────────────────

log('starting whatsapp mcp server')
await mcp.connect(new StdioServerTransport())
log('mcp connected, initializing whatsapp client...')
wa.initialize().catch(err => log(`whatsapp init failed: ${err}`))
