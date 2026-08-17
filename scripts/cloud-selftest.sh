#!/bin/bash
# Cloud session self-test — run this FIRST in a Claude Code session to verify the
# cloud bootstrap worked. Read-only (never edits/commits). It first tells you
# whether you're actually in a cloud sandbox, because the whole test is only
# meaningful there.
#
#   Real cloud session -> CLAUDE_CODE_REMOTE=true, Linux, running as root.
#   Local / Remote-Control-to-your-Mac -> CLAUDE_CODE_REMOTE empty, Darwin, your user.

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

echo "=== Claude Code cloud self-test ==="
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "✅ CLOUD SESSION — CLAUDE_CODE_REMOTE=true, $(uname -s) as $(whoami)"
  IS_CLOUD=1
else
  echo "⚠️  NOT A CLOUD SESSION — CLAUDE_CODE_REMOTE='${CLAUDE_CODE_REMOTE:-}', $(uname -s) as $(whoami)"
  echo "    This is your local machine (or Remote-Control to it). The checks below"
  echo "    only prove the CLOUD path when run inside a real cloud session"
  echo "    (start a new task at claude.ai/code — not a connection to your Mac)."
  IS_CLOUD=0
fi

echo ""
echo "--- data (did the bootstrap provision it?) ---"
if [ -L data/shows.json ]; then loc="symlink -> $(readlink data/shows.json)"
elif [ -e data/shows.json ]; then loc="regular file"
else loc="MISSING"; fi
echo "data/shows.json: $loc"
node -e "try{const r=require('./data/reviews.json');console.log('reviews.json:', r.reviews.length, r.reviews.length? '=> REAL DATA (clone worked)':'=> STUB (proxy/token clone did not run — set REVIEW_TEXTS_TOKEN)')}catch(e){console.log('reviews.json: MISSING ('+e.code+')')}" 2>&1

echo ""
echo "--- secrets present in this environment ---"
for k in NOTION_API_KEY OPENAI_API_KEY GEMINI_API_KEY REVIEW_TEXTS_TOKEN; do
  if [ -n "$(eval "printf '%s' \"\${$k:-}\"")" ]; then echo "$k: set"; else echo "$k: MISSING"; fi
done

echo ""
echo "--- github auth (does the built-in proxy reach the private data repo WITHOUT a token?) ---"
echo "origin remote:      $(git remote get-url origin 2>/dev/null | sed -E 's#//[^@/]+@#//#' || echo '(none)')"
echo "credential.helper:  $(git config --get-regexp 'credential.*helper' 2>/dev/null | tr '\n' ';' || echo '(none set)')"
echo "url.*.insteadOf:    $(git config --get-regexp 'url.*insteadof' 2>/dev/null | tr '\n' ';' || echo '(none)')"
echo "http.extraheader:   $([ -n "$(git config --get-regexp 'http.*extraheader' 2>/dev/null)" ] && echo 'present (proxy token header)' || echo '(none)')"
rm -rf /tmp/authtest
if GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/thomaspryor/broadway-scorecard-data.git /tmp/authtest >/tmp/authtest.log 2>&1; then
  echo "tokenless clone of private data repo: ✅ WORKS (no token needed — the proxy authenticates it)"
else
  echo "tokenless clone of private data repo: ❌ FAILS ($(tail -1 /tmp/authtest.log)) — a token (GH_TOKEN) is required"
fi
rm -rf /tmp/authtest

echo ""
echo "--- network reachability (the Full-network / allowlist check) ---"
for host in api.openai.com generativelanguage.googleapis.com; do
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "https://$host" 2>/dev/null || echo "000")
  if [ "$code" != "000" ]; then echo "$host: reachable (HTTP $code)"; else echo "$host: UNREACHABLE (blocked by network policy or offline)"; fi
done

echo ""
echo "--- typecheck ---"
if [ -d node_modules/typescript ]; then
  if npx tsc --noEmit >/tmp/selftest-tsc.out 2>&1; then echo "tsc: PASS"; else echo "tsc: FAIL"; tail -8 /tmp/selftest-tsc.out; fi
else
  echo "tsc: SKIPPED (node_modules not installed — run 'npm install' first)"
fi

echo ""
echo "=== self-test done ==="
if [ "$IS_CLOUD" = "1" ]; then
  echo "Interpretation: REAL DATA + tsc PASS + both model hosts reachable = fully working."
else
  echo "Interpretation: re-run inside a real cloud session for a meaningful result."
fi
