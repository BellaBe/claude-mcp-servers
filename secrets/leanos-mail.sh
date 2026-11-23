#!/usr/bin/env bash
# Secret command for the email MCP server that reuses the LeanOS Spacemail setup:
# settings from ~/.config/leanos-mail/mail.conf, the password from pass (SMTP_PASS_ENTRY,
# first line). Nothing is stored twice. Read-only: `set` is refused.
#
# usage: leanos-mail.sh get email <key>
#   keys: imap-host imap-port imap-user imap-pass smtp-host smtp-port smtp-user smtp-pass smtp-from
set -uo pipefail

CONF="${MAIL_CONFIG:-$HOME/.config/leanos-mail/mail.conf}"

conf() {  # value of KEY in mail.conf, quotes stripped; empty when absent
  [ -f "$CONF" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONF" | tail -n1 | sed "s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]*$//"
}

password() {
  local entry; entry="$(conf SMTP_PASS_ENTRY)"
  pass show "${entry:-spacemail}" 2>/dev/null | head -n1
}

[ "${1:-}" = get ] && [ "${2:-}" = email ] && [ $# -eq 3 ] || {
  echo "usage: $0 get email <key> (read-only adapter; configure Spacemail in $CONF)" >&2; exit 2; }

user="$(conf SMTP_USER)"
case "$3" in
  imap-host) v="$(conf IMAP_HOST)"; echo "${v:-mail.spacemail.com}" ;;
  imap-port) v="$(conf IMAP_PORT)"; echo "${v:-993}" ;;
  imap-user) v="$(conf IMAP_USER)"; echo "${v:-$user}" ;;
  smtp-host) v="$(conf SMTP_HOST)"; echo "${v:-mail.spacemail.com}" ;;
  smtp-port) v="$(conf SMTP_PORT)"; echo "${v:-465}" ;;
  smtp-user) echo "$user" ;;
  imap-pass|smtp-pass) password ;;
  smtp-from)
    from="$(conf SMTP_FROM)"; name="$(conf SMTP_FROM_NAME)"; from="${from:-$user}"
    if [ -n "$name" ] && [[ "$from" != *"<"* ]]; then echo "$name <$from>"; else echo "$from"; fi ;;
  *) exit 1 ;;  # resend-* and unknown keys: not configured
esac
