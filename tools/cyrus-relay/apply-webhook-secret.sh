#!/usr/bin/env bash
# Point Cyrus and the relay at the real Linear webhook signing secret.
#
#   tools/cyrus-relay/apply-webhook-secret.sh <secret>
#
# The secret is on the Cyrus OAuth application page:
#   Linear -> Settings -> API -> OAuth Applications -> Cyrus -> Webhook signing secret
#
# Does everything in one pass: rewrites ~/.cyrus/.env, pushes the value to the
# Vercel relay, redeploys it, restarts Cyrus, and confirms both ends agree.
set -euo pipefail

SECRET="${1:-}"
if [ -z "$SECRET" ]; then
  echo "usage: apply-webhook-secret.sh <linear-webhook-signing-secret>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVF="$HOME/.cyrus/.env"

echo "1/5 writing LINEAR_WEBHOOK_SECRET to $ENVF"
if grep -q '^LINEAR_WEBHOOK_SECRET=' "$ENVF"; then
  python3 - "$ENVF" "$SECRET" <<'PY'
import sys
path, secret = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines(True)
out = [f"LINEAR_WEBHOOK_SECRET={secret}\n" if l.startswith("LINEAR_WEBHOOK_SECRET=") else l for l in lines]
open(path, "w").writelines(out)
PY
else
  printf 'LINEAR_WEBHOOK_SECRET=%s\n' "$SECRET" >> "$ENVF"
fi

echo "2/5 pushing the secret to the Vercel relay"
"$HERE/sync-webhook-secret.sh"

echo "3/5 redeploying the relay"
"$HERE/deploy.sh" deploy > /dev/null
echo "     deployed"

echo "4/5 restarting Cyrus"
tmux kill-session -t cyrus 2>/dev/null || true
tmux new-session -d -s cyrus "cyrus start > $HOME/.cyrus/cyrus.log 2>&1"
sleep 12
grep -q 'Linear event transport registered (direct mode)' "$HOME/.cyrus/cyrus.log" \
  && echo "     Cyrus up in direct mode" \
  || { echo "     Cyrus did NOT come up in direct mode — check ~/.cyrus/cyrus.log" >&2; exit 1; }

echo "5/5 round-trip check through the public relay"
BODY='{"type":"AgentSessionEvent","action":"created","webhookId":"apply-secret-check"}'
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST \
  https://cyrus-relay.vercel.app/api/linear-webhook \
  -H 'content-type: application/json' -H "linear-signature: $SIG" \
  -H 'linear-event: AgentSessionEvent' -d "$BODY")"
if [ "$CODE" = "200" ]; then
  echo "     relay accepted a payload signed with the new secret"
  echo
  echo "Done. @mention @cyrus1 on a Linear issue and watch:"
  echo "  tail -f ~/.cyrus/cyrus.log"
else
  echo "     relay returned $CODE — the relay and ~/.cyrus/.env disagree" >&2
  exit 1
fi
