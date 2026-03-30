#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${EMAIL_STATE_DIR:-$HOME/.claude/channels/email}"
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SERVER_DIR/server.ts"
SECRET_CMD="${CLAUDE_SECRET_CMD:-$SERVER_DIR/../secrets/secret.sh}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }
dim()   { printf '\033[0;90m%s\033[0m\n' "$*" >&2; }

# ── Secret helpers (for configure/check only) ────────────────────────────

secret_get() { "$SECRET_CMD" get email "$1" 2>/dev/null || true; }
secret_set() { "$SECRET_CMD" set email "$1" "$2"; }
secret_has() { local val; val="$(secret_get "$1")"; [[ -n "$val" ]]; }

# ── Configure mode ───────────────────────────────────────────────────────

configure() {
  mkdir -p "$STATE_DIR"

  echo "Email MCP Server Setup"
  echo "======================"
  echo ""
  echo "IMAP Configuration (required for reading)"
  echo "------------------------------------------"
  echo "Common IMAP hosts:"
  echo "  Fastmail:         imap.fastmail.com:993"
  echo "  Zoho:             imap.zoho.com:993"
  echo "  ProtonMail Bridge: 127.0.0.1:1143"
  echo "  Custom domain:    check your provider"
  echo ""

  local imap_host="" imap_port="" imap_user="" imap_pass=""

  if secret_has imap-host; then
    local current
    current="$(secret_get imap-host)"
    echo "IMAP Host: $current (stored)"
    read -rp "Replace? [y/N] " replace
    if [[ "$replace" =~ ^[Yy] ]]; then
      read -rp "IMAP Host: " imap_host
    fi
  else
    read -rp "IMAP Host: " imap_host
  fi
  [[ -n "$imap_host" ]] && secret_set imap-host "$imap_host"

  if ! secret_has imap-port; then
    read -rp "IMAP Port (default 993): " imap_port
    imap_port="${imap_port:-993}"
    secret_set imap-port "$imap_port"
  else
    dim "IMAP Port: $(secret_get imap-port) (stored)"
  fi

  if secret_has imap-user; then
    local current_user
    current_user="$(secret_get imap-user)"
    echo "IMAP User: $current_user (stored)"
    read -rp "Replace? [y/N] " replace
    if [[ "$replace" =~ ^[Yy] ]]; then
      read -rp "IMAP Username (email): " imap_user
    fi
  else
    read -rp "IMAP Username (email): " imap_user
  fi
  [[ -n "$imap_user" ]] && secret_set imap-user "$imap_user"

  if secret_has imap-pass; then
    echo "IMAP Password: ******* (stored)"
    read -rp "Replace? [y/N] " replace
    if [[ "$replace" =~ ^[Yy] ]]; then
      read -rsp "IMAP Password (app-specific): " imap_pass
      echo ""
    fi
  else
    read -rsp "IMAP Password (app-specific): " imap_pass
    echo ""
  fi
  [[ -n "$imap_pass" ]] && secret_set imap-pass "$imap_pass"

  green "IMAP credentials stored."
  echo ""

  # ── SMTP ──

  echo "SMTP Configuration (required for sending, unless using Resend)"
  echo "---------------------------------------------------------------"
  read -rp "Configure SMTP? (Y/n): " configure_smtp
  if [[ ! "$configure_smtp" =~ ^[Nn] ]]; then
    local smtp_host="" smtp_port="" smtp_user="" smtp_pass="" smtp_from=""

    read -rp "SMTP Host: " smtp_host
    read -rp "SMTP Port (default 587): " smtp_port
    smtp_port="${smtp_port:-587}"

    local effective_imap_user="${imap_user:-$(secret_get imap-user)}"
    local effective_imap_pass="${imap_pass:-$(secret_get imap-pass)}"

    read -rp "SMTP Username (default: same as IMAP): " smtp_user
    smtp_user="${smtp_user:-$effective_imap_user}"
    read -rsp "SMTP Password (default: same as IMAP): " smtp_pass
    smtp_pass="${smtp_pass:-$effective_imap_pass}"
    echo ""
    read -rp "From address (e.g. 'Name <user@domain>'): " smtp_from

    secret_set smtp-host "$smtp_host"
    secret_set smtp-port "$smtp_port"
    secret_set smtp-user "$smtp_user"
    secret_set smtp-pass "$smtp_pass"
    [[ -n "$smtp_from" ]] && secret_set smtp-from "$smtp_from"

    green "SMTP credentials stored."
  fi
  echo ""

  # ── Resend ──

  read -rp "Configure Resend (alternative to SMTP)? (y/N): " configure_resend
  if [[ "$configure_resend" =~ ^[Yy] ]]; then
    local resend_key="" resend_from=""

    read -rp "Resend API Key: " resend_key
    read -rp "Resend From (e.g. 'Name <user@domain>'): " resend_from

    secret_set resend-api-key "$resend_key"
    [[ -n "$resend_from" ]] && secret_set resend-from "$resend_from"
    green "Resend credentials stored."
  fi

  echo ""
  echo "Next steps:"
  echo "  1. Run: $0 --check"
  echo "  2. Register: claude mcp add email --scope user -- bash $0"
  echo ""
}

# ── Check mode ───────────────────────────────────────────────────────────

check() {
  local ok=true

  if ! command -v bun &>/dev/null; then red "✗ bun not found"; ok=false; else green "✓ bun $(bun --version)"; fi
  if [ ! -f "$SERVER" ]; then red "✗ server.ts not found"; ok=false; else green "✓ server.ts found"; fi
  if [ ! -f "$SECRET_CMD" ]; then red "✗ secret.sh not found at $SECRET_CMD"; ok=false; else green "✓ secret.sh found"; fi

  # IMAP (required)
  if secret_has imap-host; then green "✓ IMAP host stored"; else red "✗ IMAP host not found — run: $0 --configure"; ok=false; fi
  if secret_has imap-user; then green "✓ IMAP user stored"; else red "✗ IMAP user not found — run: $0 --configure"; ok=false; fi
  if secret_has imap-pass; then green "✓ IMAP password stored"; else red "✗ IMAP password not found — run: $0 --configure"; ok=false; fi

  # Sending (need one of SMTP or Resend)
  local has_smtp=false has_resend=false
  if secret_has smtp-host; then green "✓ SMTP host stored"; has_smtp=true; else dim "○ SMTP not configured"; fi
  if secret_has resend-api-key; then green "✓ Resend API key stored"; has_resend=true; else dim "○ Resend not configured"; fi
  if ! $has_smtp && ! $has_resend; then red "✗ Neither SMTP nor Resend configured — need at least one for sending"; ok=false; fi

  if [ -d "$SERVER_DIR/node_modules" ]; then green "✓ dependencies installed"; else red "✗ dependencies not installed — run: cd $SERVER_DIR && bun install"; ok=false; fi
  $ok && green "\nReady." || { red "\nFix issues above."; exit 1; }
}

# ── Main ─────────────────────────────────────────────────────────────────

case "${1:-}" in
  --configure)
    configure
    exit 0
    ;;
  --check)
    check
    exit 0
    ;;
  --help|-h)
    echo "Usage: $0 [--configure|--check|--help]"
    echo ""
    echo "  (no args)     Start the MCP server (stdio transport)"
    echo "  --configure   Store IMAP/SMTP/Resend credentials"
    echo "  --check       Validate config and dependencies"
    echo ""
    echo "Secrets managed by: $SECRET_CMD"
    exit 0
    ;;
  *)
    # Verify secrets exist before starting (quick check, no values in env)
    if ! secret_has imap-host || ! secret_has imap-user || ! secret_has imap-pass; then
      red "IMAP credentials not found. Run: $0 --configure"
      exit 1
    fi
    if ! secret_has smtp-host && ! secret_has resend-api-key; then
      red "No send transport configured. Run: $0 --configure"
      exit 1
    fi

    mkdir -p "$STATE_DIR"
    if [ ! -d "$SERVER_DIR/node_modules" ]; then
      dim "Installing dependencies..."
      cd "$SERVER_DIR" && bun install --silent 2>/dev/null || bun install
    fi

    # Only pass SECRET_CMD path — server loads secrets directly via spawnSync
    export SECRET_CMD
    exec bun run "$SERVER"
    ;;
esac
