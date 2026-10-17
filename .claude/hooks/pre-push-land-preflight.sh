#!/usr/bin/env bash
# pre-push-land-preflight.sh — PreToolUse hook on Bash (BRO-4593).
#
# Blocks `git push … land/<name>` when land.yml would refuse it anyway: the
# land rebase onto origin/main conflicts (a conflict resolved inside a merge
# of main comes back once the rebase drops the merge), or a test file the
# branch added/deleted is not (un)registered in the test manifests. Each such
# refusal costs a ~30-minute land cycle; this check takes about a second.
#
# All logic lives in scripts/lib/land-preflight.mjs (tested by
# tests/unit/land-preflight.test.mjs). This wrapper only feeds it the hook
# JSON. It fails open: any error, a missing node, or the lib missing exits 0.
# Kill switch: LAND_PREFLIGHT_DISABLE=1 in the hook environment (settings env).
# Per-push bypass: `# NO-LAND-PREFLIGHT: <reason, 15+ chars>` in the command.
# Every verdict is appended to <main checkout>/.claude/land-preflight.jsonl.

[ "${LAND_PREFLIGHT_DISABLE:-0}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../../scripts/lib/land-preflight.mjs"
[ -f "$LIB" ] || exit 0

input=$(cat)
# Cheap pre-filter: most Bash calls are not land pushes; skip node entirely.
case "$input" in
  *push*land/*) ;;
  *) exit 0 ;;
esac

# Stock macOS has no `timeout`; fall back to gtimeout, then to no wrapper
# (the settings.json hook timeout of 120s still bounds it).
if command -v timeout >/dev/null 2>&1; then TO=(timeout 90)
elif command -v gtimeout >/dev/null 2>&1; then TO=(gtimeout 90)
else TO=()
fi
err=$(printf '%s' "$input" | "${TO[@]}" node "$LIB" --hook 2>&1 >/dev/null)
rc=$?
if [ "$rc" -eq 2 ]; then
  printf '%s\n' "$err" >&2
  exit 2
fi
exit 0
