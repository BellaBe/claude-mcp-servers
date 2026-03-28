#!/usr/bin/env bash
# telegram-start.sh — Launch the Telegram MCP channel server.
#
# Usage:
#   ./telegram-start.sh              # foreground (for MCP stdio)
#   ./telegram-start.sh --check      # validate config without starting
#   ./telegram-start.sh --configure  # interactive first-time setup
#
# Credentials stored in:
#   macOS     → Keychain (security CLI)
#   Linux/WSL → pass (GPG-encrypted ~/.password-store, no daemon needed)
#
# Non-secret config (access mode, etc.) can live in .env — no tokens there.

set -euo pipefail

STATE_DIR="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}"
ENV_FILE="$STATE_DIR/.env"
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SERVER_DIR/server.ts"

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }
dim()   { printf '\033[0;90m%s\033[0m\n' "$*" >&2; }

# ── Keychain helpers ─────────────────────────────────────────────────────

PASS_PREFIX="claude-telegram"

keychain_get() {
  local key="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    security find-generic-password -s "${PASS_PREFIX}-${key}" -w 2>/dev/null || true
  else
    pass show "${PASS_PREFIX}/${key}" 2>/dev/null || true
  fi
}

keychain_set() {
  local key="$1" value="$2"
  if [[ "$(uname)" == "Darwin" ]]; then
    security delete-generic-password -s "${PASS_PREFIX}-${key}" 2>/dev/null || true
    security add-generic-password \
      -a "$PASS_PREFIX" \
      -s "${PASS_PREFIX}-${key}" \
      -l "${PASS_PREFIX} ${key}" \
      -w "$value"
  else
    printf '%s\n' "$value" | pass insert -f -e "${PASS_PREFIX}/${key}" 2>/dev/null
  fi
}

keychain_has() {
  local val
  val="$(keychain_get "$1")"
  [[ -n "$val" ]]
}

# ── Load secrets into env ────────────────────────────────────────────────

load_secrets() {
  export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(keychain_get bot-token)}"
  export TELEGRAM_ADMIN_USER_ID="${TELEGRAM_ADMIN_USER_ID:-$(keychain_get admin-id)}"
}

# ── Load non-secret config from .env ─────────────────────────────────────

load_env_config() {
  if [ -f "$ENV_FILE" ]; then
    while IFS='=' read -r k v; do
      [[ -z "$k" || "$k" =~ ^# ]] && continue
      [[ "$k" == "TELEGRAM_BOT_TOKEN" ]] && continue
      [[ "$k" == "TELEGRAM_ADMIN_USER_ID" ]] && continue
      if [[ -z "${!k:-}" ]]; then
        export "$k=$v"
      fi
    done < "$ENV_FILE"
  fi
}

# ── Check pass is usable (Linux/WSL only) ────────────────────────────────

check_pass() {
  if [[ "$(uname)" == "Darwin" ]]; then
    return 0
  fi

  if ! command -v pass &>/dev/null; then
    red "✗ pass not found"
    red "  Install:  sudo apt install pass gnupg"
    red "  Then:     gpg --gen-key"
    red "            pass init <gpg-key-id>"
    return 1
  fi

  if ! pass ls &>/dev/null 2>&1; then
    red "✗ pass not initialized"
    red "  Run:  gpg --gen-key"
    red "        pass init <gpg-key-id>"
    red "  (use gpg --list-keys to find your key ID)"
    return 1
  fi

  return 0
}

# ── Configure mode ───────────────────────────────────────────────────────

configure() {
  mkdir -p "$STATE_DIR"

  echo "Telegram Channel Setup"
  echo "======================"
  echo ""

  if [[ "$(uname)" != "Darwin" ]]; then
    if ! check_pass; then
      exit 1
    fi
    green "✓ pass initialized"
    echo ""
  fi

  # ── Bot token ──

  local token=""
  if keychain_has bot-token; then
    local current
    current="$(keychain_get bot-token | head -c10)"
    echo "Bot token: ${current}... (stored)"
    read -rp "Replace? [y/N] " replace
    if [[ "$replace" =~ ^[Yy] ]]; then
      read -rp "Bot token from @BotFather: " token
    fi
  else
    read -rp "Bot token from @BotFather: " token
  fi

  if [[ -n "$token" ]]; then
    keychain_set bot-token "$token"
    green "Bot token stored."
  fi

  # ── Admin user ID ──

  local admin_id=""
  if keychain_has admin-id; then
    local current_admin
    current_admin="$(keychain_get admin-id)"
    echo "Admin user ID: $current_admin (stored)"
    read -rp "Replace? [y/N] " replace_admin
    if [[ "$replace_admin" =~ ^[Yy] ]]; then
      read -rp "Your Telegram user ID (get from @userinfobot): " admin_id
    fi
  else
    echo ""
    echo "Get your Telegram user ID by messaging @userinfobot on Telegram."
    read -rp "Your Telegram user ID: " admin_id
  fi

  if [[ -n "$admin_id" ]]; then
    keychain_set admin-id "$admin_id"
    green "Admin user ID stored."
  fi

  # ── Strip secrets from .env if present (migration) ──

  if [ -f "$ENV_FILE" ]; then
    local tmp="$ENV_FILE.tmp"
    grep -v "^TELEGRAM_BOT_TOKEN=\|^TELEGRAM_ADMIN_USER_ID=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    dim "Stripped any leftover secrets from .env"
  fi

  echo ""
  if [[ "$(uname)" == "Darwin" ]]; then
    green "Saved to macOS Keychain."
  else
    green "Saved to pass (GPG-encrypted at ~/.password-store/${PASS_PREFIX}/)."
  fi
  echo ""
  echo "Next steps:"
  echo "  1. Start a Claude Code session"
  echo "  2. DM your bot on Telegram — it replies with a pairing code"
  echo "  3. Use /pair <code> in Telegram (as admin) to approve"
  echo ""
}

# ── Check mode ───────────────────────────────────────────────────────────

check() {
  local ok=true

  # bun
  if ! command -v bun &>/dev/null; then
    red "✗ bun not found — install from https://bun.sh"
    ok=false
  else
    green "✓ bun $(bun --version)"
  fi

  # server.ts
  if [ ! -f "$SERVER" ]; then
    red "✗ server.ts not found at $SERVER"
    ok=false
  else
    green "✓ server.ts found"
  fi

  # secret store
  if [[ "$(uname)" != "Darwin" ]]; then
    if check_pass; then
      green "✓ pass initialized"
    else
      ok=false
    fi
  fi

  # credentials
  if keychain_has bot-token; then
    green "✓ bot token stored"
  else
    red "✗ bot token not found — run: $0 --configure"
    ok=false
  fi

  if keychain_has admin-id; then
    green "✓ admin user ID stored"
  else
    red "✗ admin user ID not found — run: $0 --configure"
    ok=false
  fi

  # warn on stale .env secrets
  if [ -f "$ENV_FILE" ]; then
    if grep -q "^TELEGRAM_BOT_TOKEN=" "$ENV_FILE" 2>/dev/null; then
      red "⚠ .env still has TELEGRAM_BOT_TOKEN — run: $0 --configure to migrate"
    fi
    if grep -q "^TELEGRAM_ADMIN_USER_ID=" "$ENV_FILE" 2>/dev/null; then
      red "⚠ .env still has TELEGRAM_ADMIN_USER_ID — run: $0 --configure to migrate"
    fi
  fi

  # deps
  if [ -f "$SERVER_DIR/node_modules/.package-lock.json" ] || [ -f "$SERVER_DIR/bun.lockb" ]; then
    green "✓ dependencies installed"
  else
    red "✗ dependencies not installed — run: cd $SERVER_DIR && bun install"
    ok=false
  fi

  if $ok; then
    green "\nReady to start."
  else
    red "\nFix issues above, then retry."
    exit 1
  fi
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
    echo "Usage: $0 [--check|--configure|--help]"
    echo ""
    echo "  (no args)     Start the MCP server (stdio transport)"
    echo "  --check       Validate config and dependencies"
    echo "  --configure   Interactive first-time setup"
    echo ""
    echo "Secrets stored in:"
    if [[ "$(uname)" == "Darwin" ]]; then
      echo "  macOS Keychain"
    else
      echo "  pass (~/.password-store/${PASS_PREFIX}/)"
    fi
    exit 0
    ;;
  *)
    # ── Start the server ──

    load_secrets

    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_ADMIN_USER_ID" ]; then
      red "Secrets not found."
      red "Run: $0 --configure"
      red ""
      if [[ "$(uname)" == "Darwin" ]]; then
        red "Or store manually:"
        red "  security add-generic-password -a claude-telegram -s claude-telegram-bot-token -w <token>"
        red "  security add-generic-password -a claude-telegram -s claude-telegram-admin-id -w <user_id>"
      else
        red "Or store manually (requires: sudo apt install pass gnupg && gpg --gen-key && pass init <key-id>):"
        red "  echo <token> | pass insert -f ${PASS_PREFIX}/bot-token"
        red "  echo <user_id> | pass insert -f ${PASS_PREFIX}/admin-id"
      fi
      exit 1
    fi

    load_env_config

    if [ ! -d "$SERVER_DIR/node_modules" ]; then
      dim "Installing dependencies..."
      cd "$SERVER_DIR"
      bun install --silent 2>/dev/null || bun install
    fi

    exec bun run "$SERVER"
    ;;
esac