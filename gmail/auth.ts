#!/usr/bin/env bun
/**
 * One-time OAuth2 authorization for Gmail.
 *
 * Run: gmail-start.sh --auth
 *
 * Expects GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in env
 * (set by startup script from pass).
 *
 * Opens browser for Google sign-in, captures auth code,
 * exchanges for tokens, saves refresh token to pass.
 */

import { google } from 'googleapis'
import { homedir } from 'os'
import { join } from 'path'
import { createServer } from 'http'

const SECRET_CMD = process.env.CLAUDE_SECRET_CMD ?? join(homedir(), 'claude-secrets', 'secret.sh')

const CLIENT_ID = process.env.GMAIL_CLIENT_ID
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET
const PORT = 3000
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in env')
  console.error('Run: gmail-start.sh --configure')
  process.exit(1)
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
]

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
})

console.log('Opening browser for Google sign-in...')
console.log('')
console.log('If it doesn\'t open automatically, visit:')
console.log(authUrl)
console.log('')

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
Bun.spawn([opener, authUrl], { stdout: 'ignore', stderr: 'ignore' }).unref()

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const code = url.searchParams.get('code')

  if (!code) {
    res.writeHead(400)
    res.end('No authorization code received')
    return
  }

  try {
    const { tokens } = await oauth2.getToken(code)
    oauth2.setCredentials(tokens)

    // Save refresh token to pass (encrypted, persistent)
    if (tokens.refresh_token) {
      const proc = Bun.spawn([SECRET_CMD, 'set', 'gmail', 'refresh-token', tokens.refresh_token], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await proc.exited
      console.log('Refresh token saved to pass (claude-gmail/refresh-token)')
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`
      <h1>Gmail authorized!</h1>
      <p>Refresh token saved to pass</p>
      <p>You can close this window.</p>
    `)

    console.log('Authorization successful!')

    setTimeout(() => process.exit(0), 1000)
  } catch (err) {
    res.writeHead(500)
    res.end(`Authorization failed: ${err}`)
    console.error('Authorization failed:', err)
    setTimeout(() => process.exit(1), 1000)
  }
})

server.listen(PORT, () => {
  console.log(`Waiting for OAuth callback on http://localhost:${PORT}...`)
})