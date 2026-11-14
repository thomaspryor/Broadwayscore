#!/usr/bin/env bash
# BRO-92: list alert senders and workflow steps that tell the operator to run a
# command. Advisory audit, always exits 0. Each hit is a candidate for
# automation (self-serve) or a genuine owner decision (owner-judgment).
# Usage: scripts/audit-command-alerts.sh [--help]
set -u
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
cd "$(dirname "$0")/.." || exit 0
PATTERN='(Run|Fix|Then run|To enable|To fix)[: ] *`?(gh (variable|secret|workflow) |node scripts/|npm run )|operator must|one command to'
echo "== Command-instructing alert text (file:line) =="
grep -rnE "$PATTERN" .github/workflows scripts \
  --include=*.yml --include=*.js --include=*.mjs --include=*.sh --include=*.ts \
  --exclude='*.test.*' --exclude=audit-command-alerts.sh 2>/dev/null \
  | grep -E '::(warning|error)::|description|hint|body|Run: *gh |routeAlert|console\.(log|error)' \
  | grep -vE '^[^:]+:[0-9]+: *\*' \
  | cut -c1-200 | while IFS= read -r line; do
    case "$line" in
      *"gh variable set"*|*"gh secret set"*) class="owner-judgment (changes repo config/secret state)";;
      *"gh workflow run"*) class="self-serve candidate (automation can dispatch)";;
      *) class="review (hint only, check whether automation could run it)";;
    esac
    printf '[%s] %s\n' "$class" "$line"
  done
echo "== done (advisory; no failures) =="
exit 0
