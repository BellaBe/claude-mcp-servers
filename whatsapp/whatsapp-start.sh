#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${WHATSAPP_STATE_DIR:-$HOME/.claude/channels/whatsapp}"
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SERVER_DIR/server.mjs"

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }

case "${1:-}" in
  --check)
    local_ok=true
    if ! command -v node &>/dev/null; then red "✗ node not found"; local_ok=false; else green "✓ node $(node --version)"; fi
    if [ ! -f "$SERVER" ]; then red "✗ server.mjs not found"; local_ok=false; else green "✓ server.mjs found"; fi
    if [ -d "$SERVER_DIR/node_modules" ]; then green "✓ dependencies installed"; else red "✗ run: cd $SERVER_DIR && npm install"; local_ok=false; fi
    if [ -d "$STATE_DIR/.wwebjs_auth" ]; then green "✓ WhatsApp session exists"; else red "⚠ No session yet — QR scan needed on first start"; fi
    if [ -f "$STATE_DIR/access.json" ]; then
      green "✓ access.json present"
    else
      red "⚠ No access.json — all contacts allowed until you configure"
    fi
    $local_ok && green "\nReady." || { red "\nFix issues above."; exit 1; }
    ;;

  --reset-session)
    red "This will delete the WhatsApp session. You'll need to scan QR again."
    read -rp "Continue? [y/N] " confirm
    if [[ "$confirm" =~ ^[Yy] ]]; then
      rm -rf "$STATE_DIR/.wwebjs_auth"
      green "Session cleared. Restart to scan QR."
    fi
    ;;

  --help|-h)
    echo "Usage: $0 [--check|--reset-session|--help]"
    echo ""
    echo "  (no args)        Start the MCP server (stdio transport)"
    echo "  --check          Validate dependencies and state"
    echo "  --reset-session  Delete WhatsApp session (re-scan QR)"
    ;;

  *)
    mkdir -p "$STATE_DIR"
    if [ ! -d "$SERVER_DIR/node_modules" ]; then
      cd "$SERVER_DIR" && npm install --silent 2>/dev/null || npm install
    fi
    exec node "$SERVER"
    ;;
esac