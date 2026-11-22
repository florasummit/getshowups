#!/usr/bin/env bash
# One secure provisioning path for every voice provider, the way Retell was set up: the API key lives ONLY in macOS
# Keychain (generic password, account `getshowups`), is checked read-only against the provider, flows by pipe into the
# Cloudflare Pages secret, and is never printed, written to a file, logged or committed. The owner's part is to create
# the account and the key and store it once:
#
#   security add-generic-password -a getshowups -s getshowups-openai-api-key -w        # pastes hidden
#   security add-generic-password -a getshowups -s getshowups-elevenlabs-api-key -w
#
# Usage:  scripts/voice-provision.sh openai|elevenlabs|retell [--apply] [--keychain-service <name>] [--keychain-account <name>]
#                                     [--agent-id <agent_id>]   (elevenlabs: configure an agent published from the dashboard in place)
#   Without --apply: reads the key, checks it against the provider (read-only), shows what would be set. Nothing is
#   written anywhere. With --apply: puts the Pages secret(s) (take effect on the NEXT deployment: merge a PR) and, for
#   ElevenLabs, creates/updates the Voice Lab agent through its API (scripts/elevenlabs-setup.mjs; never starts a
#   conversation, never buys anything).
# Nothing here enables customer-facing voice, phone routing or unattended usage: the keys are used only by the
# admin-only Voice Lab (VOICE_LAB_ENABLED, test businesses, dry run, one call at a time, 15 min, daily minutes).
set -euo pipefail
PROJECT=getshowups
PROVIDER="${1:-}"
shift || true
APPLY=0
SERVICE=""
ACCOUNT=getshowups
AGENT_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --keychain-service) SERVICE="$2"; shift ;;
    --keychain-account) ACCOUNT="$2"; shift ;;
    --agent-id) AGENT_ID="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$PROVIDER" in
  openai|elevenlabs|retell) ;;
  *) echo "usage: scripts/voice-provision.sh openai|elevenlabs|retell [--apply] [--keychain-service <name>] [--keychain-account <name>]" >&2; exit 2 ;;
esac
SERVICE="${SERVICE:-getshowups-${PROVIDER}-api-key}"

# The key goes from Keychain straight into a shell variable of this process; it is never echoed.
if ! KEY="$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null)"; then
  echo "No Keychain item '$SERVICE' (account '$ACCOUNT'). Create it (the value is typed hidden):" >&2
  echo "  security add-generic-password -a $ACCOUNT -s $SERVICE -w" >&2
  exit 3
fi
if [ "${#KEY}" -lt 20 ]; then echo "Keychain item '$SERVICE' looks too short to be an API key." >&2; exit 3; fi
echo "Keychain item '$SERVICE' found (${#KEY} characters; value not shown)."

# Read-only check against the provider. Never prints a response body (it could echo the key on some errors).
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
case "$PROVIDER" in
  openai)
    S=$(status -H "Authorization: Bearer $KEY" https://api.openai.com/v1/models)
    [ "$S" = "200" ] || { echo "OpenAI refused the key (HTTP $S). Check the key and the project's billing." >&2; exit 4; }
    # Realtime access: minting a 10-second client secret creates no session and costs nothing.
    S2=$(status -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"expires_after":{"anchor":"created_at","seconds":10},"session":{"type":"realtime","model":"gpt-realtime"}}' https://api.openai.com/v1/realtime/client_secrets)
    [ "$S2" = "200" ] || { echo "OpenAI accepted the key but refused a Realtime client secret (HTTP $S2): Realtime access or billing is missing on this project." >&2; exit 4; }
    echo "OpenAI: key valid; Realtime client secret minted (HTTP 200). Secret to set: OPENAI_API_KEY."
    ;;
  elevenlabs)
    S=$(status -H "xi-api-key: $KEY" https://api.elevenlabs.io/v1/user)
    [ "$S" = "200" ] || { echo "ElevenLabs refused the key (HTTP $S)." >&2; exit 4; }
    S2=$(status -H "xi-api-key: $KEY" "https://api.elevenlabs.io/v1/convai/agents?page_size=1")
    [ "$S2" = "200" ] || { echo "ElevenLabs key works but the Agents Platform refused (HTTP $S2): the key needs Conversational AI permissions (API key settings → ConvAI read/write)." >&2; exit 4; }
    echo "ElevenLabs: key valid; Agents Platform reachable. Secrets to set: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID (from the agent setup)."
    echo "Agent setup (dry run):"
    printf '%s\n' "$KEY" | node scripts/elevenlabs-setup.mjs ${AGENT_ID:+--agent-id "$AGENT_ID"}
    ;;
  retell)
    S=$(status -H "Authorization: Bearer $KEY" -X POST -H 'Content-Type: application/json' -d '{"limit":1}' https://api.retellai.com/v2/list-agents)
    [ "$S" = "200" ] || { echo "Retell refused the key (HTTP $S)." >&2; exit 4; }
    echo "Retell: key valid. Secret to set: RETELL_API_KEY (the agent itself is managed by scripts/retell-setup.mjs; see docs/RECEPTIONIST.md)."
    ;;
esac

if [ "$APPLY" != "1" ]; then
  echo "Dry run: nothing written. Re-run with --apply to set the Pages secret(s)$( [ "$PROVIDER" = elevenlabs ] && echo ' and create/update the ElevenLabs agent')."
  unset KEY
  exit 0
fi

case "$PROVIDER" in
  openai)
    printf '%s' "$KEY" | npx wrangler pages secret put OPENAI_API_KEY --project-name "$PROJECT" >/dev/null
    echo "Set OPENAI_API_KEY on $PROJECT (applies on the next deployment)."
    ;;
  elevenlabs)
    OUT=$(printf '%s\n' "$KEY" | node scripts/elevenlabs-setup.mjs --apply ${AGENT_ID:+--agent-id "$AGENT_ID"} | tail -1)
    AGENT=$(printf '%s' "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const r=JSON.parse(s);process.stdout.write(r.ok&&r.agentId?r.agentId:'')}catch{}})")
    [ -n "$AGENT" ] || { echo "Agent setup did not return an agent id; nothing set. Output: $OUT" >&2; exit 5; }
    printf '%s' "$KEY" | npx wrangler pages secret put ELEVENLABS_API_KEY --project-name "$PROJECT" >/dev/null
    printf '%s' "$AGENT" | npx wrangler pages secret put ELEVENLABS_AGENT_ID --project-name "$PROJECT" >/dev/null
    echo "Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID=$AGENT on $PROJECT (apply on the next deployment)."
    ;;
  retell)
    printf '%s' "$KEY" | npx wrangler pages secret put RETELL_API_KEY --project-name "$PROJECT" >/dev/null
    echo "Set RETELL_API_KEY on $PROJECT (applies on the next deployment)."
    ;;
esac
unset KEY
