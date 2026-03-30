#!/usr/bin/env bash
set -euo pipefail

PREFIX="claude"
CHANNELS_DIR="${CLAUDE_CHANNELS_DIR:-$HOME/.claude/channels}"

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*" >&2; }

usage() {
  echo "Claude Channel Secrets"
  echo ""
  echo "Usage:"
  echo "  $(basename "$0") set <channel> <key> <value>    Store a secret"
  echo "  $(basename "$0") get <channel> <key>            Retrieve a secret"
  echo "  $(basename "$0") list [channel]                 Show stored keys"
  echo "  $(basename "$0") rm  <channel> <key>            Delete a secret"
  echo "  $(basename "$0") migrate <channel> <ENV_KEY> <pass_key>  Move .env value to pass"
  echo ""
  echo "Examples:"
  echo "  $(basename "$0") set telegram bot-token 123456789:AAH..."
  echo "  $(basename "$0") set slack bot-token xoxb-..."
  echo "  $(basename "$0") get telegram bot-token"
  echo "  $(basename "$0") list"
  echo "  $(basename "$0") migrate telegram TELEGRAM_BOT_TOKEN bot-token"
  exit 1
}

check_pass() {
  if ! command -v pass &>/dev/null; then
    red "pass not found. Install:"
    red "  sudo apt install pass gnupg"
    red "  gpg --gen-key"
    red "  pass init <gpg-key-id>"
    exit 1
  fi
  if ! pass ls &>/dev/null 2>&1; then
    red "pass not initialized. Run:"
    red "  gpg --gen-key"
    red "  pass init <gpg-key-id>"
    exit 1
  fi
}

[[ $# -lt 1 ]] && usage
check_pass

case "$1" in
  set)
    [[ $# -lt 4 ]] && { red "Usage: $(basename "$0") set <channel> <key> <value>"; exit 1; }
    if printf '%s\n' "$4" | pass insert -f -e "${PREFIX}-$2/$3"; then
      green "✓ ${PREFIX}-$2/$3"
    else
      red "✗ failed to store ${PREFIX}-$2/$3"
      exit 1
    fi
    ;;

  get)
    [[ $# -lt 3 ]] && { red "Usage: $(basename "$0") get <channel> <key>"; exit 1; }
    pass show "${PREFIX}-$2/$3" 2>/dev/null || red "not found: $2/$3"
    ;;

  list)
    if [[ $# -ge 2 ]]; then
      pass ls "${PREFIX}-$2" 2>/dev/null || red "no secrets for $2"
    else
      pass ls 2>/dev/null | grep -E "${PREFIX}-" || red "no secrets stored"
    fi
    ;;

  rm)
    [[ $# -lt 3 ]] && { red "Usage: $(basename "$0") rm <channel> <key>"; exit 1; }
    pass rm -f "${PREFIX}-$2/$3" 2>/dev/null
    green "✓ deleted ${PREFIX}-$2/$3"
    ;;

  migrate)
    [[ $# -lt 4 ]] && { red "Usage: $(basename "$0") migrate <channel> <ENV_KEY> <pass_key>"; exit 1; }
    channel="$2"
    env_key="$3"
    pass_key="$4"
    env_file="${CHANNELS_DIR}/${channel}/.env"

    if [ ! -f "$env_file" ]; then
      red "No .env at $env_file"
      exit 1
    fi

    value="$(grep "^${env_key}=" "$env_file" | cut -d= -f2- || true)"
    if [ -z "$value" ]; then
      red "${env_key} not found in $env_file"
      exit 1
    fi

    if printf '%s\n' "$value" | pass insert -f -e "${PREFIX}-${channel}/${pass_key}"; then
      green "✓ ${env_key} → ${PREFIX}-${channel}/${pass_key}"
    else
      red "✗ failed to store ${PREFIX}-${channel}/${pass_key}"
      exit 1
    fi

    tmp="${env_file}.tmp"
    grep -v "^${env_key}=" "$env_file" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$env_file"
    chmod 600 "$env_file"
    green "✓ ${env_key} removed from .env"

    if ! grep -qE '^\w+=' "$env_file" 2>/dev/null; then
      rm "$env_file"
      green "✓ .env was empty — deleted"
    fi
    ;;

  *)
    usage
    ;;
esac