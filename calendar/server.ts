#!/usr/bin/env bun
/**
 * Calendar MCP Tool Server for Claude Code.
 *
 * CalDAV: universal protocol — works with Google, Outlook, Apple, Fastmail, any compliant provider.
 * Cal.com: booking link generation for leads (optional, requires Cal.com API key).
 *
 * Auth: credentials loaded at startup via secret.sh (GPG-encrypted, never in process.env).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createDAVClient, DAVCalendar } from 'tsdav'
import {
  writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

// ── Config ──────────────────────────────────────────────────────────────

const STATE_DIR = process.env.CALENDAR_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'calendar')
const LOG_FILE = join(STATE_DIR, 'debug.log')

const CWD = process.cwd()
const INBOX_DIR = join(CWD, 'inbox', 'calendar')
const OUTBOX_DIR = join(CWD, 'outbox', 'calendar')

// ── Logging ─────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  process.stderr.write(line)
  try { writeFileSync(LOG_FILE, line, { flag: 'a' }) } catch {}
}

// ── Secrets (loaded once at startup, stored in local vars) ──────────────

const SECRET_CMD = process.env.SECRET_CMD ?? join(homedir(), 'claude-mcp-servers', 'secrets', 'secret.sh')

function loadSecret(key: string): string {
  const result = spawnSync(SECRET_CMD, ['get', 'calendar', key], {
    encoding: 'utf8',
    timeout: 5000,
  })
  return (result.stdout ?? '').trim()
}

const CALDAV_URL = loadSecret('caldav-url')
const CALDAV_USERNAME = loadSecret('caldav-username')
const CALDAV_PASSWORD = loadSecret('caldav-password')
const CALCOM_API_KEY = loadSecret('calcom-api-key')
const CALCOM_BASE_URL = loadSecret('calcom-base-url') || 'https://api.cal.com/v1'

// Clear SECRET_CMD from env — no longer needed
delete process.env.SECRET_CMD

if (!CALDAV_URL || !CALDAV_USERNAME || !CALDAV_PASSWORD) {
  process.stderr.write(
    `calendar server: CalDAV credentials not found in secrets\n` +
    `  run: calendar-start.sh --configure\n`,
  )
  process.exit(1)
}

log('secrets loaded from GPG store')

// ── CalDAV Client ───────────────────────────────────────────────────────

let davClient: Awaited<ReturnType<typeof createDAVClient>>
let calendars: DAVCalendar[] = []

async function ensureClient() {
  if (davClient) return davClient
  davClient = await createDAVClient({
    serverUrl: CALDAV_URL,
    credentials: {
      username: CALDAV_USERNAME,
      password: CALDAV_PASSWORD,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })
  calendars = await davClient.fetchCalendars()
  log(`connected to CalDAV, found ${calendars.length} calendar(s)`)
  return davClient
}

// ── iCal Helpers ────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function generateUID(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}@claude-calendar`
}

function buildVEvent(opts: {
  summary: string
  start: Date
  end: Date
  description?: string
  location?: string
  attendees?: string[]
  uid?: string
  allDay?: boolean
}): string {
  const uid = opts.uid ?? generateUID()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Claude Calendar MCP//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatDate(new Date())}`,
  ]

  if (opts.allDay) {
    const startStr = `${opts.start.getFullYear()}${String(opts.start.getMonth() + 1).padStart(2, '0')}${String(opts.start.getDate()).padStart(2, '0')}`
    const endStr = `${opts.end.getFullYear()}${String(opts.end.getMonth() + 1).padStart(2, '0')}${String(opts.end.getDate()).padStart(2, '0')}`
    lines.push(`DTSTART;VALUE=DATE:${startStr}`)
    lines.push(`DTEND;VALUE=DATE:${endStr}`)
  } else {
    lines.push(`DTSTART:${formatDate(opts.start)}`)
    lines.push(`DTEND:${formatDate(opts.end)}`)
  }

  lines.push(`SUMMARY:${escapeIcal(opts.summary)}`)
  if (opts.description) lines.push(`DESCRIPTION:${escapeIcal(opts.description)}`)
  if (opts.location) lines.push(`LOCATION:${escapeIcal(opts.location)}`)
  if (opts.attendees) {
    for (const email of opts.attendees) {
      lines.push(`ATTENDEE;RSVP=TRUE:mailto:${email.trim()}`)
    }
  }
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}

function escapeIcal(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

function unescapeIcal(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

// ── iCal Parser (lightweight) ──────────────────────────────────────────

interface ParsedEvent {
  uid: string
  summary: string
  description: string
  location: string
  dtstart: string
  dtend: string
  attendees: string[]
  status: string
  organizer: string
  raw: string
}

function parseVEvents(icalData: string): ParsedEvent[] {
  const events: ParsedEvent[] = []
  const eventBlocks = icalData.split('BEGIN:VEVENT')
  for (let i = 1; i < eventBlocks.length; i++) {
    const block = eventBlocks[i].split('END:VEVENT')[0]
    events.push({
      uid: extractProp(block, 'UID'),
      summary: unescapeIcal(extractProp(block, 'SUMMARY')),
      description: unescapeIcal(extractProp(block, 'DESCRIPTION')),
      location: unescapeIcal(extractProp(block, 'LOCATION')),
      dtstart: extractProp(block, 'DTSTART'),
      dtend: extractProp(block, 'DTEND'),
      attendees: extractAttendees(block),
      status: extractProp(block, 'STATUS') || 'CONFIRMED',
      organizer: extractProp(block, 'ORGANIZER'),
      raw: block,
    })
  }
  return events
}

function extractProp(block: string, prop: string): string {
  const regex = new RegExp(`^${prop}[;:](.*)$`, 'mi')
  const match = block.match(regex)
  if (!match) return ''
  const val = match[1]
  const colonIdx = val.indexOf(':')
  if (match[0].includes(';') && colonIdx >= 0) {
    return val.slice(colonIdx + 1).trim()
  }
  return val.trim()
}

function extractAttendees(block: string): string[] {
  const attendees: string[] = []
  const regex = /ATTENDEE[^:]*:mailto:([^\r\n]+)/gi
  let m
  while ((m = regex.exec(block))) {
    attendees.push(m[1].trim())
  }
  return attendees
}

function parseICalDate(s: string): Date | null {
  if (!s) return null
  if (/^\d{8}$/.test(s)) {
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`)
  }
  const cleaned = s.replace(/[^\dTZ]/g, '')
  if (/^\d{8}T\d{6}Z?$/.test(cleaned)) {
    const dt = `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T${cleaned.slice(9, 11)}:${cleaned.slice(11, 13)}:${cleaned.slice(13, 15)}Z`
    return new Date(dt)
  }
  return new Date(s)
}

function eventToMarkdown(ev: ParsedEvent): string {
  const start = parseICalDate(ev.dtstart)
  const end = parseICalDate(ev.dtend)
  return [
    `# ${ev.summary || '(no title)'}`,
    '',
    `**Start:** ${start?.toISOString() ?? ev.dtstart}`,
    `**End:** ${end?.toISOString() ?? ev.dtend}`,
    ev.location ? `**Location:** ${ev.location}` : '',
    ev.organizer ? `**Organizer:** ${ev.organizer}` : '',
    ev.attendees.length ? `**Attendees:** ${ev.attendees.join(', ')}` : '',
    `**Status:** ${ev.status}`,
    `**UID:** ${ev.uid}`,
    '',
    ev.description ? `---\n\n${ev.description}` : '',
  ].filter(Boolean).join('\n')
}

function saveEventToInbox(ev: ParsedEvent): string {
  mkdirSync(INBOX_DIR, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const slug = ev.summary.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
  const filename = `${ts}_${slug}.md`
  const filepath = join(INBOX_DIR, filename)
  writeFileSync(filepath, eventToMarkdown(ev))
  return filepath
}

// ── Cal.com Integration ─────────────────────────────────────────────────

async function calcomRequest(method: string, path: string, body?: unknown): Promise<any> {
  if (!CALCOM_API_KEY) throw new Error('CALCOM_API_KEY not configured — run: calendar-start.sh --configure')
  const url = `${CALCOM_BASE_URL}${path}?apiKey=${CALCOM_API_KEY}`
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cal.com API ${res.status}: ${text}`)
  }
  return res.json()
}

// ── Resolve calendar ────────────────────────────────────────────────────

async function resolveCalendar(name?: string): Promise<DAVCalendar> {
  await ensureClient()
  if (!calendars.length) throw new Error('No calendars found')
  if (!name) return calendars[0]
  const found = calendars.find(c =>
    c.displayName?.toLowerCase() === name.toLowerCase() ||
    c.url?.includes(name)
  )
  if (!found) {
    const available = calendars.map(c => c.displayName || c.url).join(', ')
    throw new Error(`Calendar "${name}" not found. Available: ${available}`)
  }
  return found
}

// ── MCP Server ──────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'calendar', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Calendar tool server. CalDAV for universal calendar access, Cal.com for booking links.',
      '',
      'CalDAV tools (work with Google, Outlook, Apple, Fastmail, any CalDAV provider):',
      '- calendar_list: list available calendars',
      '- calendar_events: fetch events in a date range',
      '- calendar_availability: check free/busy for a date range',
      '- calendar_create_event: create a new event',
      '- calendar_update_event: update an existing event',
      '- calendar_delete_event: delete an event',
      '',
      'Cal.com tools (booking links for leads):',
      '- calcom_event_types: list available booking event types',
      '- calcom_create_booking: create a booking directly',
      '- calcom_booking_link: generate a booking link',
      '',
      'Events are saved as markdown to inbox/calendar/ when fetched.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── CalDAV tools ────────────────────────────────────────────────
    {
      name: 'calendar_list',
      description: 'List all available CalDAV calendars.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'calendar_events',
      description: 'Fetch events from a calendar within a date range. Saves to inbox/calendar/.',
      inputSchema: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Start date/time (ISO 8601, e.g. 2026-03-30T00:00:00Z)' },
          end: { type: 'string', description: 'End date/time (ISO 8601)' },
          calendar: { type: 'string', description: 'Calendar name (default: first calendar)' },
          save: { type: 'boolean', description: 'Save events to inbox/calendar/ (default: true)' },
        },
        required: ['start', 'end'],
      },
    },
    {
      name: 'calendar_availability',
      description: 'Check free/busy status for a date range. Returns busy slots.',
      inputSchema: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Start date/time (ISO 8601)' },
          end: { type: 'string', description: 'End date/time (ISO 8601)' },
          calendar: { type: 'string', description: 'Calendar name (default: first calendar)' },
        },
        required: ['start', 'end'],
      },
    },
    {
      name: 'calendar_create_event',
      description: 'Create a new calendar event.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start: { type: 'string', description: 'Start date/time (ISO 8601)' },
          end: { type: 'string', description: 'End date/time (ISO 8601)' },
          description: { type: 'string', description: 'Event description' },
          location: { type: 'string', description: 'Event location' },
          attendees: { type: 'string', description: 'Attendee emails, comma-separated' },
          calendar: { type: 'string', description: 'Calendar name (default: first calendar)' },
          all_day: { type: 'boolean', description: 'All-day event (default: false)' },
        },
        required: ['summary', 'start', 'end'],
      },
    },
    {
      name: 'calendar_update_event',
      description: 'Update an existing calendar event by UID.',
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'Event UID' },
          summary: { type: 'string', description: 'New title' },
          start: { type: 'string', description: 'New start (ISO 8601)' },
          end: { type: 'string', description: 'New end (ISO 8601)' },
          description: { type: 'string', description: 'New description' },
          location: { type: 'string', description: 'New location' },
          calendar: { type: 'string', description: 'Calendar name (default: first calendar)' },
        },
        required: ['uid'],
      },
    },
    {
      name: 'calendar_delete_event',
      description: 'Delete a calendar event by UID.',
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'Event UID to delete' },
          calendar: { type: 'string', description: 'Calendar name (default: first calendar)' },
        },
        required: ['uid'],
      },
    },
    {
      name: 'calendar_send_outbox',
      description: 'Create events from .md files in outbox/calendar/. Each file needs frontmatter (summary, start, end). Created files are deleted.',
      inputSchema: { type: 'object', properties: {} },
    },
    // ── Cal.com tools ───────────────────────────────────────────────
    {
      name: 'calcom_event_types',
      description: 'List available Cal.com event types (booking page types).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'calcom_create_booking',
      description: 'Create a Cal.com booking directly for a lead.',
      inputSchema: {
        type: 'object',
        properties: {
          event_type_id: { type: 'number', description: 'Cal.com event type ID' },
          name: { type: 'string', description: 'Attendee name' },
          email: { type: 'string', description: 'Attendee email' },
          start: { type: 'string', description: 'Start time (ISO 8601)' },
          notes: { type: 'string', description: 'Booking notes' },
          timezone: { type: 'string', description: 'Attendee timezone (default: UTC)' },
        },
        required: ['event_type_id', 'name', 'email', 'start'],
      },
    },
    {
      name: 'calcom_booking_link',
      description: 'Generate a Cal.com booking link for a specific event type.',
      inputSchema: {
        type: 'object',
        properties: {
          event_type_slug: { type: 'string', description: 'Event type slug (from calcom_event_types)' },
          username: { type: 'string', description: 'Cal.com username' },
          prefill_name: { type: 'string', description: 'Pre-fill attendee name' },
          prefill_email: { type: 'string', description: 'Pre-fill attendee email' },
        },
        required: ['event_type_slug', 'username'],
      },
    },
  ],
}))

// ── Tool Handlers ───────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {

      // ── calendar_list ─────────────────────────────────────────────
      case 'calendar_list': {
        await ensureClient()
        const text = calendars.map((c, i) =>
          `${i + 1}. ${c.displayName || '(unnamed)'} — ${c.url}`
        ).join('\n')
        return { content: [{ type: 'text', text: text || 'No calendars found.' }] }
      }

      // ── calendar_events ───────────────────────────────────────────
      case 'calendar_events': {
        const start = args.start as string
        const end = args.end as string
        const save = (args.save as boolean) ?? true
        const cal = await resolveCalendar(args.calendar as string | undefined)

        log(`calendar_events: ${start} → ${end} on ${cal.displayName}`)

        const client = await ensureClient()
        const objects = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start, end },
        })

        if (!objects.length) {
          return { content: [{ type: 'text', text: 'No events in range.' }] }
        }

        const results: string[] = []
        const saved: string[] = []
        for (const obj of objects) {
          if (!obj.data) continue
          const events = parseVEvents(obj.data)
          for (const ev of events) {
            const startDt = parseICalDate(ev.dtstart)
            results.push(`[${ev.uid}] ${ev.summary} — ${startDt?.toISOString() ?? ev.dtstart}`)
            if (save) saved.push(saveEventToInbox(ev))
          }
        }

        const summary = results.join('\n')
        const note = save ? `\n\nSaved ${saved.length} events to inbox/calendar/` : ''
        return { content: [{ type: 'text', text: summary + note }] }
      }

      // ── calendar_availability ─────────────────────────────────────
      case 'calendar_availability': {
        const start = args.start as string
        const end = args.end as string
        const cal = await resolveCalendar(args.calendar as string | undefined)

        log(`calendar_availability: ${start} → ${end}`)

        const client = await ensureClient()
        const objects = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start, end },
        })

        const busy: { summary: string; start: string; end: string }[] = []
        for (const obj of objects) {
          if (!obj.data) continue
          const events = parseVEvents(obj.data)
          for (const ev of events) {
            if (ev.status === 'CANCELLED') continue
            const s = parseICalDate(ev.dtstart)
            const e = parseICalDate(ev.dtend)
            busy.push({
              summary: ev.summary,
              start: s?.toISOString() ?? ev.dtstart,
              end: e?.toISOString() ?? ev.dtend,
            })
          }
        }

        busy.sort((a, b) => a.start.localeCompare(b.start))

        if (!busy.length) {
          return { content: [{ type: 'text', text: `Fully available from ${start} to ${end}` }] }
        }

        const text = busy.map(b => `BUSY: ${b.start} → ${b.end} (${b.summary})`).join('\n')
        return { content: [{ type: 'text', text: `${busy.length} busy slot(s):\n${text}` }] }
      }

      // ── calendar_create_event ─────────────────────────────────────
      case 'calendar_create_event': {
        const summary = args.summary as string
        const start = new Date(args.start as string)
        const end = new Date(args.end as string)
        const description = args.description as string | undefined
        const location = args.location as string | undefined
        const attendeesStr = args.attendees as string | undefined
        const attendees = attendeesStr?.split(',').map(s => s.trim()).filter(Boolean)
        const allDay = (args.all_day as boolean) ?? false
        const cal = await resolveCalendar(args.calendar as string | undefined)

        const uid = generateUID()
        const ical = buildVEvent({ summary, start, end, description, location, attendees, uid, allDay })

        log(`calendar_create_event: "${summary}" uid=${uid}`)

        const client = await ensureClient()
        await client.createCalendarObject({
          calendar: cal,
          filename: `${uid}.ics`,
          iCalString: ical,
        })

        return { content: [{ type: 'text', text: `created event "${summary}" (uid: ${uid})` }] }
      }

      // ── calendar_update_event ─────────────────────────────────────
      case 'calendar_update_event': {
        const uid = args.uid as string
        const cal = await resolveCalendar(args.calendar as string | undefined)

        log(`calendar_update_event: uid=${uid}`)

        const client = await ensureClient()
        const objects = await client.fetchCalendarObjects({ calendar: cal })
        const target = objects.find(o => o.data?.includes(uid))
        if (!target) throw new Error(`Event with UID ${uid} not found`)

        const events = parseVEvents(target.data!)
        const ev = events.find(e => e.uid === uid)
        if (!ev) throw new Error(`Event with UID ${uid} not found in calendar data`)

        const summary = (args.summary as string) ?? ev.summary
        const start = args.start ? new Date(args.start as string) : (parseICalDate(ev.dtstart) ?? new Date())
        const end = args.end ? new Date(args.end as string) : (parseICalDate(ev.dtend) ?? new Date())
        const description = (args.description as string) ?? ev.description
        const location = (args.location as string) ?? ev.location

        const ical = buildVEvent({ summary, start, end, description, location, uid })

        await client.updateCalendarObject({
          calendarObject: {
            ...target,
            data: ical,
          },
        })

        return { content: [{ type: 'text', text: `updated event "${summary}" (uid: ${uid})` }] }
      }

      // ── calendar_delete_event ─────────────────────────────────────
      case 'calendar_delete_event': {
        const uid = args.uid as string
        const cal = await resolveCalendar(args.calendar as string | undefined)

        log(`calendar_delete_event: uid=${uid}`)

        const client = await ensureClient()
        const objects = await client.fetchCalendarObjects({ calendar: cal })
        const target = objects.find(o => o.data?.includes(uid))
        if (!target) throw new Error(`Event with UID ${uid} not found`)

        await client.deleteCalendarObject({ calendarObject: target })

        return { content: [{ type: 'text', text: `deleted event (uid: ${uid})` }] }
      }

      // ── calendar_send_outbox ──────────────────────────────────────
      case 'calendar_send_outbox': {
        if (!existsSync(OUTBOX_DIR)) {
          return { content: [{ type: 'text', text: 'outbox/calendar/ does not exist. Nothing to create.' }] }
        }

        const files = readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.md'))
        if (files.length === 0) {
          return { content: [{ type: 'text', text: 'outbox/calendar/ is empty.' }] }
        }

        const results: string[] = []
        for (const file of files) {
          const filepath = join(OUTBOX_DIR, file)
          try {
            const content = readFileSync(filepath, 'utf8')
            const { meta, body } = parseOutboxFile(content)
            if (!meta.summary || !meta.start || !meta.end) {
              results.push(`SKIP ${file}: missing summary, start, or end in frontmatter`)
              continue
            }

            const start = new Date(meta.start)
            const end = new Date(meta.end)
            const attendees = meta.attendees?.split(',').map(s => s.trim()).filter(Boolean)
            const cal = await resolveCalendar(meta.calendar)

            const uid = generateUID()
            const ical = buildVEvent({
              summary: meta.summary,
              start,
              end,
              description: body || meta.description,
              location: meta.location,
              attendees,
              uid,
            })

            const client = await ensureClient()
            await client.createCalendarObject({
              calendar: cal,
              filename: `${uid}.ics`,
              iCalString: ical,
            })

            unlinkSync(filepath)
            results.push(`CREATED ${file} → "${meta.summary}" (uid: ${uid})`)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            results.push(`FAIL ${file}: ${msg}`)
          }
        }

        return { content: [{ type: 'text', text: results.join('\n') }] }
      }

      // ── calcom_event_types ────────────────────────────────────────
      case 'calcom_event_types': {
        log('calcom_event_types')
        const data = await calcomRequest('GET', '/event-types')
        const types = data.event_types ?? data.data ?? []
        const text = types.map((t: any) =>
          `[${t.id}] ${t.title} (${t.slug}) — ${t.length}min`
        ).join('\n')
        return { content: [{ type: 'text', text: text || 'No event types found.' }] }
      }

      // ── calcom_create_booking ─────────────────────────────────────
      case 'calcom_create_booking': {
        const eventTypeId = args.event_type_id as number
        const name = args.name as string
        const email = args.email as string
        const start = args.start as string
        const notes = args.notes as string | undefined
        const timezone = (args.timezone as string) ?? 'UTC'

        log(`calcom_create_booking: type=${eventTypeId} email=${email}`)

        const data = await calcomRequest('POST', '/bookings', {
          eventTypeId,
          start,
          responses: { name, email, notes: notes ?? '' },
          timeZone: timezone,
          language: 'en',
          metadata: {},
        })

        const booking = data.data ?? data
        return {
          content: [{
            type: 'text',
            text: `booking created (id: ${booking.id ?? booking.uid})\nstart: ${start}\nattendee: ${name} <${email}>`,
          }],
        }
      }

      // ── calcom_booking_link ───────────────────────────────────────
      case 'calcom_booking_link': {
        const slug = args.event_type_slug as string
        const username = args.username as string
        const prefillName = args.prefill_name as string | undefined
        const prefillEmail = args.prefill_email as string | undefined

        const baseUrl = CALCOM_BASE_URL.replace('/api/v1', '').replace('api.cal.com/v1', 'cal.com')
        let url = `${baseUrl}/${username}/${slug}`
        const params = new URLSearchParams()
        if (prefillName) params.set('name', prefillName)
        if (prefillEmail) params.set('email', prefillEmail)
        const qs = params.toString()
        if (qs) url += `?${qs}`

        return { content: [{ type: 'text', text: url }] }
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
  summary?: string
  start?: string
  end?: string
  description?: string
  location?: string
  attendees?: string
  calendar?: string
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
        if (['summary', 'start', 'end', 'description', 'location', 'attendees', 'calendar'].includes(key)) {
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

log('starting calendar mcp server')
await mcp.connect(new StdioServerTransport())
log('calendar mcp server connected')
