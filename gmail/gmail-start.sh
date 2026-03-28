#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${GMAIL_STATE_DIR:-$HOME/.claude/channels/gmail}"
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SERVER_DIR/server.ts"
SECRET_CMD="${CLAUDE_SECRET_CMD:-$HOME/claude-secrets/secret.sh}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }

load_secrets() {
  export GMAIL_CLIENT_ID=$(pass show claude-gmail/client-id 2>/dev/null) || { red "Failed to read claude-gmail/client-id from pass"; exit 1; }
  export GMAIL_CLIENT_SECRET=$(pass show claude-gmail/client-secret 2>/dev/null) || { red "Failed to read claude-gmail/client-secret from pass"; exit 1; }
  # Refresh token is optional — might not exist before first auth
  export GMAIL_REFRESH_TOKEN=$(pass show claude-gmail/refresh-token 2>/dev/null) || true
}

case "${1:-}" in
  --configure)
    echo "Gmail MCP Server Setup"
    echo "======================"
    echo ""
    echo "You need a Google Cloud project with Gmail API enabled."
    echo "Create OAuth2 credentials (Desktop app type) at:"
    echo "  https://console.cloud.google.com/apis/credentials"
    echo ""

    read -rp "Client ID: " client_id
    read -rp "Client Secret: " client_secret

    "$SECRET_CMD" set gmail client-id "$client_id"
    "$SECRET_CMD" set gmail client-secret "$client_secret"

    green "Credentials stored in pass (claude-gmail/)"
    echo ""
    echo "Next: run '$0 --auth' to authorize with Google"
    ;;

  --auth)
    load_secrets
    mkdir -p "$STATE_DIR"
    if [ ! -d "$SERVER_DIR/node_modules" ]; then
      cd "$SERVER_DIR" && bun install --silent 2>/dev/null || bun install
    fi
    exec bun run "$SERVER_DIR/auth.ts"
    ;;

  --check)
    local_ok=true
    if ! command -v bun &>/dev/null; then red "✗ bun not found"; local_ok=false; else green "✓ bun $(bun --version)"; fi
    if ! command -v pass &>/dev/null; then red "✗ pass not found"; local_ok=false; else green "✓ pass installed"; fi
    if [ ! -f "$SERVER" ]; then red "✗ server.ts not found"; local_ok=false; else green "✓ server.ts found"; fi

    if pass show claude-gmail/client-id &>/dev/null; then green "✓ client ID in pass"; else red "✗ claude-gmail/client-id not found — run: $0 --configure"; local_ok=false; fi
    if pass show claude-gmail/client-secret &>/dev/null; then green "✓ client secret in pass"; else red "✗ claude-gmail/client-secret not found — run: $0 --configure"; local_ok=false; fi
    if pass show claude-gmail/refresh-token &>/dev/null; then green "✓ refresh token in pass"; else red "✗ claude-gmail/refresh-token not found — run: $0 --auth"; local_ok=false; fi

    if [ -d "$SERVER_DIR/node_modules" ]; then green "✓ dependencies installed"; else red "✗ dependencies not installed — run: cd $SERVER_DIR && bun install"; local_ok=false; fi
    $local_ok && green "\nReady." || { red "\nFix issues above."; exit 1; }
    ;;

  --help|-h)
    echo "Usage: $0 [--configure|--auth|--check|--help]"
    echo ""
    echo "  (no args)     Start the MCP server (stdio transport)"
    echo "  --configure   Store Google OAuth2 credentials in pass"
    echo "  --auth        Run OAuth2 authorization flow"
    echo "  --check       Validate config and dependencies"
    ;;

  *)
    load_secrets
    if [ -z "$GMAIL_CLIENT_ID" ] || [ -z "$GMAIL_CLIENT_SECRET" ]; then
      red "Credentials not found in pass. Run: $0 --configure"
      exit 1
    fi
    if [ ! -d "$SERVER_DIR/node_modules" ]; then
      cd "$SERVER_DIR" && bun install --silent 2>/dev/null || bun install
    fi
    exec bun run "$SERVER"
    ;;
esac