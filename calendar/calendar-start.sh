#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${CALENDAR_STATE_DIR:-$HOME/.claude/channels/calendar}"
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SERVER_DIR/server.ts"
SECRET_CMD="${CLAUDE_SECRET_CMD:-$SERVER_DIR/../secrets/secret.sh}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }
dim()   { printf '\033[0;90m%s\033[0m\n' "$*" >&2; }

# ── Secret helpers (for configure/check only) ────────────────────────────

secret_get() { "$SECRET_CMD" get calendar "$1" 2>/dev/null || true; }
secret_set() { "$SECRET_CMD" set calendar "$1" "$2"; }
secret_has() { local val; val="$(secret_get "$1")"; [[ -n "$val" ]]; }

# ── Configure mode ───────────────────────────────────────────────────────

configure() {
  mkdir -p "$STATE_DIR"

  echo "Calendar MCP Server Setup"
  echo "========================="
  echo ""
  echo "CalDAV Configuration"
  echo "--------------------"
  echo "Common CalDAV URLs:"
  echo "  Google:    https://apidata.googleusercontent.com/caldav/v2/"
  echo "  Fastmail:  https://caldav.fastmail.com/dav/calendars/user/<email>/"
  echo "  Apple:     https://caldav.icloud.com/"
  echo "  Nextcloud: https://<host>/remote.php/dav/"
  echo ""

  local caldav_url="" caldav_username="" caldav_password=""

  if secret_has caldav-url; then
    local current
    current="$(secret_get caldav-url)"
    echo "CalDAV URL: $current (stored)"
    read -rp "Replace? [y/N] " replace
    if [[ "$replace" =~ ^[Yy] ]]; then
      read -rp "CalDAV URL: " caldav_url
    fi
  else
    read -rp "CalDAV URL: " caldav_url
  fi
  [[ -n "$caldav_url" ]] && secret_set caldav-url "$caldav_url"

  if secret_has caldav-username; then
    local current_user
    current_user="$(secret_get caldav-username)"
    echo "Username: $current_user (stored)"
    read -rp "Replace? [y/N] " replace
    if [[ "$replace" =~ ^[Yy] ]]; then
      read -rp "Username: " caldav_username
    fi
  else
    read -rp "Username: " caldav_username
  fi
  [[ -n "$caldav_username" ]] && secret_set caldav-username "$caldav_username"

  if secret_has caldav-password; then
    echo "Password: ******* (stored)"
    read -rp "Replace? [y/N] " replace
    if [[ "$replace" =~ ^[Yy] ]]; then
      read -rsp "Password (app-specific password): " caldav_password
      echo ""
    fi
  else
    read -rsp "Password (app-specific password): " caldav_password
    echo ""
  fi
  [[ -n "$caldav_password" ]] && secret_set caldav-password "$caldav_password"

  green "CalDAV credentials stored."
  echo ""

  read -rp "Configure Cal.com? (y/N): " configure_calcom
  if [[ "$configure_calcom" =~ ^[Yy] ]]; then
    read -rp "Cal.com API Key: " calcom_key
    read -rp "Cal.com Base URL (default: https://api.cal.com/v1): " calcom_url
    calcom_url="${calcom_url:-https://api.cal.com/v1}"

    secret_set calcom-api-key "$calcom_key"
    secret_set calcom-base-url "$calcom_url"
    green "Cal.com credentials stored."
  fi

  echo ""
  echo "Next steps:"
  echo "  1. Run: $0 --check"
  echo "  2. Register: claude mcp add calendar --scope user -- bash $0"
  echo ""
}

# ── Check mode ───────────────────────────────────────────────────────────

check() {
  local ok=true

  if ! command -v bun &>/dev/null; then red "✗ bun not found"; ok=false; else green "✓ bun $(bun --version)"; fi
  if [ ! -f "$SERVER" ]; then red "✗ server.ts not found"; ok=false; else green "✓ server.ts found"; fi
  if [ ! -f "$SECRET_CMD" ]; then red "✗ secret.sh not found at $SECRET_CMD"; ok=false; else green "✓ secret.sh found"; fi

  if secret_has caldav-url; then green "✓ CalDAV URL stored"; else red "✗ CalDAV URL not found — run: $0 --configure"; ok=false; fi
  if secret_has caldav-username; then green "✓ CalDAV username stored"; else red "✗ CalDAV username not found — run: $0 --configure"; ok=false; fi
  if secret_has caldav-password; then green "✓ CalDAV password stored"; else red "✗ CalDAV password not found — run: $0 --configure"; ok=false; fi
  if secret_has calcom-api-key; then green "✓ Cal.com API key stored"; else dim "○ Cal.com not configured (optional)"; fi

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
    echo "  --configure   Store CalDAV and Cal.com credentials"
    echo "  --check       Validate config and dependencies"
    echo ""
    echo "Secrets managed by: $SECRET_CMD"
    exit 0
    ;;
  *)
    # Verify secrets exist before starting (quick check, no values in env)
    if ! secret_has caldav-url || ! secret_has caldav-username || ! secret_has caldav-password; then
      red "CalDAV credentials not found. Run: $0 --configure"
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
